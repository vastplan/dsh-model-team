/**
 * CLI harness 机制层：**唯一**起进程的地方。
 *
 * 定义层只给 `LaunchPlan`（argv/env/cwd/stdin），这里负责：
 * 起进程、逐行流、总超时、无输出看门狗、取消、解析、结果归一。
 *
 * 优先用 DSH 的 `ctx.subprocess`（与宿主同一执行世界、终止语义统一）；
 * 宿主没有该服务时退回 `node:child_process`，行为一致但绕过宿主的沙箱治理。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseOutput } from './parse.js';
import { createPhaseEmitter } from './phases.js';
import { buildLaunch } from './protocol.js';

/** 与原型 `invoke_exec` 相同的两个“被杀掉”退出码。 */
export const TIMEOUT_EXIT_CODE = 124;
export const SILENCE_EXIT_CODE = 125;

const tail = (text, max = 400) => {
  const flat = String(text ?? '').trim();
  return flat.length > max ? flat.slice(-max) : flat;
};

/** 把 `parse.js` 的 snake_case 用量翻成插件内部的 camelCase；全 0 视为未采集。 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const out = {
    input: num(usage.input ?? usage.inputTokens ?? usage.input_tokens),
    output: num(usage.output ?? usage.outputTokens ?? usage.output_tokens),
    cacheRead: num(usage.cache_read ?? usage.cacheRead),
    cacheWrite: num(usage.cache_write ?? usage.cacheWrite),
    reasoning: num(usage.reasoning ?? usage.reasoningTokens ?? usage.reasoning_tokens),
  };
  return Object.values(out).some((value) => value > 0) ? out : null;
}

/** 起一个 Node 子进程，并包成与 `SubprocessHandle` 同形的句柄。 */
function spawnNode(plan) {
  const child = nodeSpawn(plan.argv[0], plan.argv.slice(1), {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (plan.stdin !== null) {
    try { child.stdin?.end(plan.stdin); } catch { /* 已关闭 */ }
  } else {
    try { child.stdin?.end(); } catch { /* 已关闭 */ }
  }
  const done = new Promise((resolve) => {
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
    child.on('error', (error) => resolve({ exitCode: -1, signal: null, error }));
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    terminate: () => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    },
  };
}

/**
 * 跑一次 CLI harness。
 *
 * @param options.ctx - Cordis 上下文（用 `ctx.get('subprocess')`，没有就退回 Node spawn）。
 * @param options.def - 归一化后的 harness 定义。
 * @param options.entry - 目录条目（`harnessModel` / `harnessProvider` / `reasoningEffort`）。
 * @param options.prompt - 完整提示词。
 * @param options.workspace - 绝对工作目录（CLI 的 cwd）。
 * @param options.tmpDir - 临时目录（file 模式写 prompt 文件）。
 * @param options.signal - 取消信号；abort 时终止子进程。
 * @param options.onPhase - `(name, snippet)` 进度回调。
 * @param options.timeoutMs / silenceMs - 额外的总超时/无输出看门狗（0 = 不启用）。
 * @returns `{ text, reasoning, usage, messages, exitCode, stopNote, unmapped }`。
 * @throws 非零退出、取消、spawn 失败；错误上带 `partialText` / `messages` / `usage` / `exitCode`。
 */
export async function runHarness(options) {
  const {
    ctx, def, entry, prompt, workspace, tmpDir,
    signal, onPhase, timeoutMs = 0, silenceMs = 0,
  } = options;

  const plan = buildLaunch(def, entry, prompt, { workspace, tmpDir });
  if (plan.promptFile && plan.promptFileContent) {
    mkdirSync(dirname(plan.promptFile), { recursive: true });
    writeFileSync(plan.promptFile, plan.promptFileContent, 'utf8');
  }

  const subprocess = ctx?.get?.('subprocess');
  let handle;
  try {
    if (subprocess?.spawn) {
      handle = subprocess.spawn({
        argv: plan.argv,
        cwd: plan.cwd,
        env: plan.env,
        stdio: {
          stdin: plan.stdin === null ? 'ignore' : { data: plan.stdin },
          stdout: 'pipe',
          stderr: 'pipe',
        },
        graceMs: 5000,
        ...(signal ? { signal } : {}),
      });
    } else {
      handle = spawnNode(plan);
    }
  } catch (error) {
    if (signal?.aborted) {
      const aborted = new Error('已取消');
      aborted.name = 'AbortError';
      throw aborted;
    }
    throw error;
  }

  const phases = createPhaseEmitter(onPhase);
  let stdout = '';
  let stderr = '';
  let lastOutputAt = Date.now();

  const feed = (chunk, isError) => {
    const text = String(chunk ?? '');
    if (!text) return;
    lastOutputAt = Date.now();
    if (isError) {
      stderr += text;
      return;
    }
    stdout += text;
    for (const line of text.split('\n')) {
      if (line.trim()) phases.feed(line);
    }
  };
  handle.stdout?.on('data', (chunk) => feed(chunk, false));
  handle.stderr?.on('data', (chunk) => feed(chunk, true));

  let timedOut = false;
  let silenced = false;
  const kill = () => {
    try { handle.terminate?.(); } catch { /* 已退出 */ }
  };
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; kill(); }, Math.max(1000, timeoutMs))
    : null;
  // 看门狗：连接还在、但不再吐字（原型里踩过 pi/xai 通道 5 分钟 0% CPU 无输出）。
  const watchdog = silenceMs > 0
    ? setInterval(() => {
      if (Date.now() - lastOutputAt > silenceMs) {
        silenced = true;
        kill();
      }
    }, 5000)
    : null;
  const onAbort = () => kill();
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });

  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    outcome = { exitCode: -1, signal: null, error };
  } finally {
    if (timer) clearTimeout(timer);
    if (watchdog) clearInterval(watchdog);
    signal?.removeEventListener?.('abort', onAbort);
  }

  const exitCode = silenced
    ? SILENCE_EXIT_CODE
    : timedOut
      ? TIMEOUT_EXIT_CODE
      : Number(outcome?.exitCode ?? -1);
  const stopNote = silenced ? '无输出超时' : timedOut ? '超时' : '';

  // stdout 为空时允许从 stderr 里找事件（少数 CLI 把 stream-json 写 stderr）。
  // `text` 方言不解析 JSON：整段 stdout 就是正文（日志类 CLI）。
  const parsed = def.output.parser === 'text'
    ? { text: stdout, messages: [], usage: {}, cost: {}, unmapped: [] }
    : parseOutput(
      stdout.trim() ? stdout : (stderr.includes('{') ? stderr : stdout),
      def.usage?.aggregate ?? 'auto',
    );
  const usage = normalizeUsage(parsed.usage);
  const text = String(parsed.text ?? '');
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

  if (signal?.aborted) {
    const error = new Error('已取消');
    error.name = 'AbortError';
    error.partialText = text;
    error.messages = messages;
    error.usage = usage;
    error.stopNote = '已取消';
    throw error;
  }

  if (exitCode !== 0) {
    const detail = tail(stderr) || tail(outcome?.error?.message) || `退出码 ${exitCode}`;
    const error = new Error(`${def.label} 调用失败：${detail}`);
    error.partialText = text;
    error.messages = messages;
    error.usage = usage;
    error.exitCode = exitCode;
    error.stopNote = stopNote;
    throw error;
  }

  return {
    text,
    reasoning: phases.thoughts,
    usage,
    messages,
    exitCode,
    stopNote,
    unmapped: Array.isArray(parsed.unmapped) ? parsed.unmapped : [],
  };
}
