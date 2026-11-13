/**
 * `model-team run`：**独立于 DSH 的**多模型编排（只走 CLI harness）。
 *
 * 与插件内的 `model_team` 工具同一套 harness 层、同一本账、同一套会话日志，
 * 但不需要 `ctx.llm`——这是给「其他 agent 通过命令行调用」准备的入口。
 *
 * 输出与旧 CLI 对齐（snake_case）：`{ run_id, kind, ledger, quality_eval, next, runs[] }`，
 * 每条 run 带 `model/provider/name/thinking/tool/status/duration_s/*_tokens/answer/log`。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { openLedger, packetHash, resolveLedgerPath } from '../ledger.js';
import { dataRoot } from './config.js';
import { localStamp, newRunId, openRunDir, snapshotInput, writeSessionLog } from '../sessionlog.js';
import { resolveTeam, joinEffort } from '../team.js';
import { harnessFor, runHarness } from '../harness/index.js?v=0.7.3';

/** 三类活动的开场提示词（与插件内 `KINDS` 同一口径）。 */
export const CLI_KINDS = {
  audit: {
    label: '事后审计',
    preamble:
      '你就是被询问的模型。直接在本回复找本切片缺陷。不要调用任何工具、不要开并行名单、不要把任务描述再送审一轮。\n',
  },
  design: {
    label: '设计分叉',
    preamble:
      '本场是设计分叉，不是事后审计，也不是专责推理。\n你就是被询问的模型。直接在本回复给出 2～4 个可执行方向。\n'
      + '硬规则：禁止拍板，禁止施工稿/文件清单/编码顺序。每个方向写清：一句话、对使用者意味着什么、取舍、失败时怎样、非目标。可以标一个推荐，推荐不是结论。\n',
  },
  reason: {
    label: '专责推理',
    preamble:
      '本场是专责推理，不是设计分叉，也不是事后审计。\n你就是被询问的模型。直接在本回复给出结构化方案：结论、步骤、风险、非目标。\n'
      + '硬规则：不要改成 2～4 个方向（那是设计分叉）。禁止施工稿/文件清单/编码顺序。可以标推荐，推荐不是用户已选定。\n',
  },
};


/** 场次类型标签（旧表用中文）。 */
const KIND_LABELS = { audit: '事后审计', design: '设计分叉', reason: '专责推理' };

/**
 * 写 `review_session`（旧 skill 的场次表）。字段口径与旧 CLI 对齐：
 * `模型` 用显示名，`条目ID` 用 `cli-<harness>/<id>`，`调用链` 记 harness。
 */
function writeReviewSessions(ledger, { runId, kind, slice, commit, rows }) {
  const db = ledger?.db;
  if (!db) return;
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_session'").get();
  if (!table) return;
  const day = runId.slice(0, 10);
  const insert = db.prepare(`INSERT OR REPLACE INTO review_session
    (场次ID, 日期, 切片, 场次类型, 对照提交, 模型, 条目ID, 调用工具, 模型参数, 思考强度, 调用链,
     开始时间, 完成时间, 金额来源, token采集, 退出码, 质量评估, 用户选择, 选用匹配, ord)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '未评', '', '', ?)`);
  const now = localStamp(new Date());
  rows.forEach((row, index) => {
    insert.run(
      runId, day, slice, KIND_LABELS[kind] ?? kind, commit,
      row.name, `${row.provider}/${row.model}`, row.harness, row.model, row.reasoningEffort,
      row.harness, now, now,
      // token采集：有 token 记「已采集」，否则记原因（旧表口径）。
      (row.usage && (row.usage.input || row.usage.output)) ? '已采集' : '未采集（CLI 无 usage）',
      `${row.status === 'done' ? 0 : 1}`, index,
    );
  });
}

/** 嵌套保护：被调模型再跑本 CLI = 指数级烧 token，直接拒。 */
export const ACTIVE_ENV = 'MODEL_TEAM_ACTIVE';

/** 读 Task Packet：`--packet -` 从 stdin 读，其余按文件读。 */
export function readPacket(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw === '-') {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      return '';
    }
  }
  const path = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(path)) throw new Error(`Task Packet 不存在：${path}`);
  return readFileSync(path, 'utf8');
}

/** 组提示词：开场白 + 包体（+ 可选改动文件清单）。 */
export function buildCliPrompt(kind, packet, files = []) {
  const meta = CLI_KINDS[kind] ?? CLI_KINDS.audit;
  const list = Array.isArray(files) && files.length
    ? `\n## 本次涉及的文件\n${files.map((file) => `- ${file}`).join('\n')}\n`
    : '';
  return `${meta.preamble}${packet}${list}`;
}

/**
 * 跑一场。
 *
 * @param options.kind - audit/design/reason。
 * @param options.packet - 包体正文。
 * @param options.slice - 切片名（进账本备注，用不上就传 runId）。
 * @param options.models - 名单（`cli-x/y@@effort`）；空则用 `fallback`。
 * @param options.catalog - `buildCliCatalog()` 的目录。
 * @param options.workspace - 绝对路径（CLI 的 cwd）。
 * @param options.timeoutSec - 单模型超时秒；0 = 不限。
 * @param options.logDir / runsRoot - 会话日志根。
 * @param options.ledgerPath - 账本路径。
 * @param options.onProgress - `(event) => void`。
 * @returns 与旧 CLI 兼容的 outcome。
 */
export async function runCliTeam(options) {
  if (String(process.env[ACTIVE_ENV] ?? '').trim()) {
    throw new Error(`${ACTIVE_ENV} 已设置：当前已在 model-team 场次内，禁止嵌套调用。`);
  }
  const kind = String(options.kind ?? 'audit').trim() || 'audit';
  if (!CLI_KINDS[kind]) throw new Error(`未知 --kind：${kind}（可用 audit | design | reason）`);
  const models = Array.isArray(options.models) ? options.models : [];
  const fallback = Array.isArray(options.fallback) ? options.fallback : [];
  if (!models.length && !fallback.length) {
    throw new Error('没有指定模型：请用 --models a,b，或在配置文件里写 defaultModels');
  }
  const team = resolveTeam(models, options.catalog ?? [], fallback);
  if (!team.length) throw new Error('名单解析后没有可跑的模型');

  const workspace = String(options.workspace ?? '').trim();
  if (!workspace || !isAbsolute(workspace)) {
    throw new Error(`CLI 条目需要绝对 --workspace（作为 cwd）：${workspace || '(未给)'}`);
  }
  const prompt = buildCliPrompt(kind, String(options.packet ?? ''), options.files);
  const runId = String(options.runId ?? '').trim() || newRunId();
  // 会话日志落旧 skill 的数据根（`~/.model-team/runs`），backfill/refresh 才找得到。
  const runsRoot = String(options.runsRoot ?? '').trim() || join(dataRoot(), 'runs');
  const runDir = openRunDir(runsRoot, runId);
  snapshotInput(runDir, 'packet.txt', String(options.packet ?? ''));
  snapshotInput(runDir, 'prompt.md', prompt);

  const ledgerPath = String(options.ledgerPath ?? '').trim()
    || resolveLedgerPath({ dshHome: process.env.DSH_HOME || `${process.env.HOME}/.dsh` });
  const ledger = await openLedger(ledgerPath);
  const startedAt = Date.now();
  const started = localStamp(new Date(startedAt));
  const timeoutMs = Math.max(0, Number(options.timeoutSec) || 0) * 1000;
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const emit = (event) => { try { progress(event); } catch { /* 进度不能带崩执行 */ } };

  const rows = await Promise.all(team.map(async (entry) => {
    const label = joinEffort(`${entry.provider}/${entry.model}`, entry.reasoningEffort);
    emit({ type: 'start', model: label, tool: entry.harness ?? 'cli' });
    const t0 = Date.now();
    let result = null;
    let error = '';
    // 每家一个临时目录，用完**只删这一家**（不要碰 tmpdir 根）。
    const tmpDir = mkdtempSync(join(tmpdir(), 'model-team-'));
    try {
      const def = harnessFor(entry.harness);
      result = await runHarness({
        def,
        entry: {
          harnessModel: entry.harnessModel ?? entry.model,
          harnessProvider: entry.harnessProvider,
          reasoningEffort: entry.reasoningEffort,
        },
        prompt,
        workspace,
        tmpDir,
        timeoutMs,
        onPhase: (phase) => emit({ type: 'phase', model: label, ...phase }),
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    const finishedAt = Date.now();
    const text = String(result?.text ?? '');
    const status = error ? 'failed' : (text.trim() ? 'done' : 'no-result');
    let logPath = '';
    if (result) {
      try {
        logPath = writeSessionLog(runDir, {
          // 用完整 spec（provider/id）：账本 calls.model 也是这个口径，backfill 才对得上。
          model: `${entry.provider}/${entry.model}`,
          provider: entry.provider,
          reasoningEffort: entry.reasoningEffort,
          tool: entry.harness ?? 'cli',
          hop: entry.harness ?? 'cli',
          status,
          exitCode: result.exitCode,
          stopNote: result.stopNote,
          error,
          text,
          messages: result.messages ?? [],
          usage: result.usage ?? {},
          started,
          finished: localStamp(new Date(finishedAt)),
          durationS: seconds,
        });
      } catch (caught) {
        // 日志写失败不推翻结果，但必须留痕——早先静默吞掉，backfill 面对空目录查不出原因。
        process.stderr.write(`会话日志写入失败：${caught instanceof Error ? caught.message : String(caught)}\n`);
      }
    }
    emit({ type: 'done', model: label, status, seconds });
    return {
      model: entry.model,
      provider: entry.provider,
      name: entry.name,
      reasoningEffort: entry.reasoningEffort,
      harness: entry.harness,
      status,
      error,
      text,
      seconds,
      usage: result?.usage ?? {},
      logPath,
    };
  }));

  const finishedAt = Date.now();
  try {
    ledger?.recordRun({
      runId,
      kind,
      mode: 'cli',
      packetHash: packetHash(String(options.packet ?? '')),
      startedAt,
      finishedAt,
    }, rows.map((row) => ({
      model: `${row.provider}/${row.model}`,
      provider: row.provider,
      name: row.name,
      reasoningEffort: row.reasoningEffort,
      status: row.status,
      text: row.text,
      error: row.error,
      seconds: row.seconds,
      usage: row.usage,
      messages: [],
      logPath: row.logPath,
      tool: row.harness,
    })));
  } catch (caught) {
    process.stderr.write(`账本写入失败（结果仍有效）：${caught instanceof Error ? caught.message : String(caught)}\n`);
  }
  // 同时写旧技能的 `review_session`：record-findings / summary 都按这张表取名单。
  // 表不存在（新机器没跑过旧 skill）就静默跳过——不是所有部署都有旧表。
  try {
    writeReviewSessions(ledger, {
      runId, kind, slice: String(options.slice ?? ''), commit: String(options.commit ?? ''), rows,
    });
  } catch (caught) {
    process.stderr.write(`review_session 写入失败（不影响 runs/calls）：${caught instanceof Error ? caught.message : String(caught)}\n`);
  } finally {
    try { ledger?.close?.(); } catch { /* 忽略 */ }
  }

  return {
    run_id: runId,
    kind,
    slice: String(options.slice ?? ''),
    ledger: ledgerPath,
    log_dir: runDir,
    quality_eval: '未评',
    next: `model-team record-findings --run-id ${runId} --json /tmp/findings.json --write`,
    runs: rows.map((row) => ({
      model: `${row.provider}/${row.model}`,
      provider: row.provider,
      name: row.name,
      thinking: row.reasoningEffort,
      tool: row.harness,
      status: row.status,
      exit_code: row.status === 'done' ? 0 : 1,
      stop_note: row.status === 'done' ? '' : row.error,
      duration_s: row.seconds,
      input_tokens: row.usage?.input ?? 0,
      output_tokens: row.usage?.output ?? 0,
      cache_read_tokens: row.usage?.cacheRead ?? 0,
      cache_write_tokens: row.usage?.cacheWrite ?? 0,
      reasoning_tokens: row.usage?.reasoning ?? 0,
      answer: row.text,
      text: row.text,
      error: row.error,
      log: row.logPath,
    })),
  };
}
