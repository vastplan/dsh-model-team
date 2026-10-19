/**
 * 从技能侧账本迁移历史数据到插件账本。
 *
 * 源：`~/.model-team/ledger/model-audit-reviews.db`
 *   - `review_session`（宽表：场次/模型/工具/思考强度/时间…）
 *   - `session_metric`（窄表：场次ID+模型 → 指标名 → 值）
 *
 * 目标：插件账本 `$DSH_HOME/model-team/ledger.db`
 *   - `runs`（一场一行）/ `calls`（一场一模型一行）/ `call_metric`（窄表）/ `reports`
 *
 * 口径对齐：
 * - 源 `场次类型` 是中文（事后审计/设计分叉/专责推理）→ 目标 `kind` 用枚举；
 * - 源指标名是中文 → 目标用英文 metric key；
 * - 源没有 `reasoningEffort` 的列名差异（叫「思考强度」）；
 * - **不迁移正文**（源本来也没有），只迁数字与维度。
 *
 * 幂等：以 `runId + callId` 为主键 upsert，重复跑不会产生重复行。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 源库默认位置。 */
export function defaultSourceDb() {
  return join(homedir(), '.model-team', 'ledger', 'model-audit-reviews.db');
}

/** 中文场次类型 → 插件枚举。 */
const KIND_MAP = {
  事后审计: 'audit',
  设计分叉: 'design',
  专责推理: 'reason',
};

/** 中文指标名 → 插件 metric key。 */
const METRIC_MAP = {
  输入token: 'input_tokens',
  输出token: 'output_tokens',
  缓存读token: 'cache_read_tokens',
  缓存写token: 'cache_write_tokens',
  推理token: 'reasoning_tokens',
  耗时秒: 'seconds',
};

/** 解析源里的时间字符串（`2026-09-05 21:41:02+08:00` / 纯日期）为 epoch ms。 */
function parseStamp(value, fallback) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : fallback;
}

/**
 * 迁移。
 *
 * @param ledger - 插件账本句柄（`openLedger` 的返回值）。
 * @param options - `{ sourcePath, dryRun }`。
 * @returns 统计与样例。
 */
export async function migrateLedger(ledger, options = {}) {
  const sourcePath = options.sourcePath || defaultSourceDb();
  if (!existsSync(sourcePath)) {
    throw new Error(`源账本不存在：${sourcePath}`);
  }

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let rows = [];
  let metrics = [];
  let reports = [];
  try {
    rows = source.prepare('SELECT * FROM review_session').all();
    metrics = source.prepare('SELECT * FROM session_metric').all();
    // 源若有周报摘要表也一并取（字段名按实际列）。
    try {
      reports = source.prepare('SELECT * FROM session_summary LIMIT 0').all();
    } catch {
      reports = [];
    }
  } finally {
    source.close();
  }

  // 指标按 (场次ID, 模型) 建索引，供逐行装配。
  const metricIndex = new Map();
  for (const row of metrics) {
    const key = `${row['场次ID']}::${row['模型']}`;
    const bag = metricIndex.get(key) ?? {};
    bag[row.metric] = row.value;
    metricIndex.set(key, bag);
  }

  // 按场次聚合：同一场次的全部模型行归到一个 run。
  const byRun = new Map();
  for (const row of rows) {
    const runId = String(row['场次ID'] ?? '').trim();
    if (!runId) continue;
    const entry = byRun.get(runId) ?? { rows: [], kindRaw: row['场次类型'], date: row['日期'] };
    entry.rows.push(row);
    byRun.set(runId, entry);
  }

  const stats = { runs: 0, calls: 0, metrics: 0, skipped: 0, kinds: {} };

  for (const [runId, entry] of byRun) {
    const kind = KIND_MAP[entry.kindRaw] ?? 'audit';
    stats.kinds[kind] = (stats.kinds[kind] ?? 0) + 1;

    const calls = [];
    for (const row of entry.rows) {
      const model = String(row['模型'] ?? '').trim();
      if (!model) { stats.skipped += 1; continue; }
      const effort = String(row['思考强度'] ?? '').trim();
      const callId = `${model}@${effort || 'default'}`;
      const bag = metricIndex.get(`${runId}::${model}`) ?? {};
      const seconds = Number(bag['耗时秒'] ?? 0) || 0;
      const finishedAt = parseStamp(row['完成时间'], parseStamp(row['日期'], Date.now()));
      calls.push({
        callId,
        model,
        provider: String(row['调用工具'] ?? '').trim() || 'skill',
        name: model,
        effort,
        tool: String(row['调用工具'] ?? '').trim() || 'skill',
        status: Number(row['退出码'] ?? 0) === 0 && bag['输出token'] !== undefined ? 'done'
          : (Number(row['退出码'] ?? 0) === 0 ? 'done' : 'failed'),
        excerpt: '',
        error: '',
        seconds,
        finishedAt,
        usage: {
          input: Number(bag['输入token'] ?? 0) || 0,
          output: Number(bag['输出token'] ?? 0) || 0,
          cacheRead: Number(bag['缓存读token'] ?? 0) || 0,
          cacheWrite: Number(bag['缓存写token'] ?? 0) || 0,
          reasoning: Number(bag['推理token'] ?? 0) || 0,
        },
      });
    }
    if (!calls.length) { stats.skipped += 1; continue; }

    const finishedAt = Math.max(...calls.map((call) => call.finishedAt));
    const answered = calls.filter((call) => call.status === 'done').length;

    if (!options.dryRun) {
      ledger.recordRun(
        {
          runId,
          kind,
          mode: 'llm',
          packetHash: '',
          startedAt: Math.min(...calls.map((call) => call.finishedAt)) - 1000,
          finishedAt,
        },
        calls.map((call) => ({
          model: call.model,
          provider: call.provider,
          name: call.name,
          reasoningEffort: call.effort,
          status: call.status,
          text: '',
          error: '',
          seconds: call.seconds,
          usage: call.usage,
        })),
      );
    }
    stats.runs += 1;
    stats.calls += calls.length;
    stats.metrics += calls.length * Object.keys(METRIC_MAP).length;
    void answered;
  }

  return { source: sourcePath, ...stats };
}
