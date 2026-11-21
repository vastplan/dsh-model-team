/**
 * 插件模式与 CLI 模式共用的执行核心。
 *
 * 两边的差异只在**外层**（插件要往 job 输出环播进度、要能单家取消；CLI 只往 stderr 打），
 * 「怎么调一次 harness」「组内怎么按主备回落」必须是同一份实现，否则
 * devin 续问、超时映射、状态口径会各漂各的。
 *
 * 这里只做纯逻辑，不碰 UI、不写日志、不落账本。
 */
import { isAbsolute } from 'node:path';

import { harnessFor, runHarness } from './harness/index.js?v=0.7.3';

/**
 * 调一次 CLI harness。
 *
 * @param options.entry - 目录条目（含 `harness` / `harnessModel` / `harnessProvider` / `reasoningEffort`）。
 * @param options.prompt - 完整提示词。
 * @param options.workspace - **必须是绝对路径**（CLI 的 cwd；Host 进程的 cwd 不是项目目录）。
 * @param options.tmpDir - 临时目录（file 模式写 prompt 文件）。
 * @param options.signal - 取消信号（插件里是「单家停止」的 AbortController）。
 * @param options.onPhase - `(name, snippet)` 进度回调。
 * @param options.ctx - 可选 Cordis 上下文（用它的 subprocess 服务；CLI 模式没有）。
 * @param options.label - 错误信息里的模型名（缺省用 provider/model）。
 * @throws 非绝对 workspace、非零退出、取消、超时——错误对象带 partialText/messages/usage/exitCode。
 * @returns `{ text, reasoning, usage, messages, exitCode, stopNote, unmapped }`
 */
export async function callHarnessEntry(options) {
  const entry = options.entry ?? {};
  const workspace = String(options.workspace ?? '').trim();
  if (!workspace || !isAbsolute(workspace)) {
    const label = String(options.label ?? entry.name ?? `${entry.provider ?? ''}/${entry.model ?? ''}`);
    throw new Error(
      `CLI 条目「${label}」需要绝对 workspace（作为 CLI 的 cwd）：${workspace || '(未给)'}；`
      + '请传 workspace=<项目绝对路径>',
    );
  }
  const definition = harnessFor(entry.harness);
  return await runHarness({
    ctx: options.ctx,
    def: definition,
    entry,
    prompt: options.prompt,
    workspace,
    tmpDir: options.tmpDir,
    signal: options.signal,
    onPhase: options.onPhase,
    timeoutMs: options.timeoutMs,
    silenceMs: options.silenceMs,
  });
}

/**
 * 执行组内按主备顺序回落：**第一个 `done` 即停**，后面的不再调用。
 *
 * 两侧共用，保证「组里到底跑了几跳、哪一跳被记账」口径一致。
 *
 * @param entries - 候选条目（顺序即回落顺序）。
 * @param callOne - `async (entry, index) => row`；row 至少有 `status`。
 * @param options.onBeforeFallback - `(entry, index)`：只在**真的要启用备选前**调用
 *   （插件用它播「上一跳失败，准备回落」；CLI 不用）。
 * @param options.shouldStop - 返回 true 时提前收手（插件用它响应整场取消）。
 * @returns `{ tried, winner, recorded }`：`winner` 是成功那跳，`recorded` 是落账本的那条
 *   （成功优先，否则最后一条）。
 */
export async function runGroupChain(entries, callOne, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const tried = [];
  for (const [index, entry] of list.entries()) {
    if (index > 0) {
      try { options.onBeforeFallback?.(entry, index); } catch { /* 播报失败不影响执行 */ }
    }
    const row = await callOne(entry, index);
    tried.push(row);
    if (row?.status === 'done') break;
    if (options.shouldStop?.() === true) break;
  }
  const winner = tried.find((row) => row?.status === 'done') ?? null;
  return { tried, winner, recorded: winner ?? tried[tried.length - 1] ?? null };
}
