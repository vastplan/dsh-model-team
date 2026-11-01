/**
 * 账本：多模型团队的场次与逐模型调用记录，存 SQLite（甲方案）。
 *
 * 为什么不用 `ctx.storageDomain`：那套接口的 `open()` 会把整个 unit 全量读进内存，
 * 换任何后端都一样；账本会长期增长，这条路径会拖慢 DSH 启动。这里直接用
 * `node:sqlite`（Node 24 内建），打开只碰文件、不做全量读取。
 *
 * 三条设计约束（与"不是核心功能"的定位一致）：
 * 1. **不存完整正文**——只留前 200 字摘要，正文留在 session 日志里；
 * 2. **按时间查询要能走索引**——`calls(finished_at)` 有索引，周报不做全表扫描；
 * 3. **保留 90 天**——超期记录由周报任务顺手清理，库不会无限长大。
 *
 * 账本失败一律不致命：打不开就返回 null，工具照常能跑，只是不记账。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 账本 schema 版本；表结构或主键口径变更时递增并写迁移。 */
export const SCHEMA_VERSION = 3;

/**
 * 调用行的主键口径：`model@@effort`（双 `@`）+ 槽位（`slot`）。
 *
 * 主键里**不能**用单 `@`：模型 id 自己可能带 `@`（`grok/grok-4.7@500k`），
 * 拼出来的 `grok/grok-4.7@500k@high` 无法无歧义地还原。
 * v1 的 `calls` 用的是单 `@`，v2 打开库时按 `model` + `effort` 两列重算后迁过来。
 *
 * **为什么还要 slot**：同一场里同一个 `model@@effort` 可能真的被调用两次——
 * 列表项与执行组胜出撞车，或两个执行组共用同一个主力。早先只按
 * `(run_id, call_id)` 做键，后写的那行会静默覆盖先写（真机：一场 10 次调用只落 7 行）。
 * 槽位取 `groupId`（列表项为空串），同键不同槽位各占一行。
 */
export function callKeyOf(model, effort) {
  return `${model}@@${effort || 'default'}`;
}

/** 调用正文只留这么多字，避免库随正文无限增长。 */
export const TEXT_EXCERPT_CHARS = 200;

/** 保留天数：超期记录在被清理时删除。 */
export const RETENTION_DAYS = 90;

/** 账本默认落点：DSH 数据根下的独立目录，与 storages/ 平级（兼容旧版本）。 */
export function defaultLedgerPath(dshHome) {
  return join(dshHome, 'model-team', 'ledger.db');
}

/** 技能侧账本（统一账本模式下的首选落点）。 */
export function skillLedgerPath(home = homedir()) {
  return join(home, '.model-team', 'ledger', 'model-audit-reviews.db');
}

/**
 * 解析插件账本路径：
 * 1. 显式配置优先；
 * 2. 本机存在技能账本时，默认使用技能账本（统一库，兼容技能侧历史与报告）；
 * 3. 否则回退到旧版插件账本，保证未安装技能账本的机器行为不变。
 */
export function resolveLedgerPath({ dshHome, home = homedir(), configured = '' } = {}) {
  const override = String(configured ?? '').trim();
  if (override) return override;
  const unified = skillLedgerPath(home);
  if (existsSync(unified)) return unified;
  return defaultLedgerPath(dshHome);
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS runs (
     run_id       TEXT PRIMARY KEY,
     kind         TEXT NOT NULL,
     mode         TEXT NOT NULL,
     packet_hash  TEXT NOT NULL,
     started_at   INTEGER NOT NULL,
     finished_at  INTEGER NOT NULL,
     total        INTEGER NOT NULL,
     answered     INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS runs_finished_at ON runs (finished_at)`,
  `CREATE TABLE IF NOT EXISTS calls (
     run_id         TEXT NOT NULL,
     call_id        TEXT NOT NULL,
     slot           TEXT NOT NULL DEFAULT '',
     model          TEXT NOT NULL,
     provider       TEXT NOT NULL,
     name           TEXT NOT NULL,
     effort         TEXT NOT NULL,
     tool           TEXT NOT NULL,
     status         TEXT NOT NULL,
     excerpt        TEXT NOT NULL,
     error          TEXT NOT NULL,
     seconds        INTEGER NOT NULL,
     log_path       TEXT NOT NULL,
     finished_at    INTEGER NOT NULL,
     PRIMARY KEY (run_id, call_id, slot)
   )`,
  `CREATE TABLE IF NOT EXISTS call_metric (
     run_id   TEXT NOT NULL,
     call_id  TEXT NOT NULL,
     slot     TEXT NOT NULL DEFAULT '',
     metric   TEXT NOT NULL,
     value    REAL,
     PRIMARY KEY (run_id, call_id, slot, metric)
   )`,
  `CREATE INDEX IF NOT EXISTS calls_finished_at ON calls (finished_at)`,
  `CREATE INDEX IF NOT EXISTS calls_call_id ON calls (call_id)`,
  `CREATE INDEX IF NOT EXISTS call_metric_metric ON call_metric (metric)`,
  `CREATE TABLE IF NOT EXISTS reports (
     report_id      TEXT PRIMARY KEY,
     from_ts        INTEGER NOT NULL,
     to_ts          INTEGER NOT NULL,
     summary_model  TEXT NOT NULL,
     summary        TEXT NOT NULL,
     facts          TEXT NOT NULL,
     created_at     INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS reports_created_at ON reports (created_at)`,
];

/**
 * 打开账本并建表。
 *
 * @param path - 数据库文件绝对路径；目录不存在会创建。
 * @returns 账本句柄；打不开时返回 null（调用方按"无账本"继续）。
 */
export async function openLedger(path, logger) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    // WAL 让读写不互相阻塞；`synchronous=NORMAL` 在 WAL 下已足够安全且快得多。
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    for (const statement of DDL) db.exec(statement);
    const stored = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version')?.value;
    const from = Number(stored ?? 0) || 0;
    if (from > SCHEMA_VERSION) {
      logger?.warn?.(`model-team: 账本 schema 版本 ${from} 高于本插件认识的 ${SCHEMA_VERSION}，本次不记账（${path}）`);
      db.close();
      return null;
    }
    if (from < 2) migrateCallKeyToDoubleAt(db, logger);
    if (from < 3) migrateAddSlotKey(db, logger);
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('version', String(SCHEMA_VERSION));
    return new Ledger(db, path);
  } catch (error) {
    logger?.warn?.(`model-team: 账本打开失败，本次不记账（${path}）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * v1 → v2：把 `calls` / `call_metric` 的主键从 `model@effort` 改成 `model@@effort`。
 *
 * **不解析旧字符串**（单 `@` 无法无歧义还原），而是用现成的 `model` + `effort` 两列重算，
 * 所以 `grok/grok-4.7@500k` 这类自带 `@` 的 id 不会被打错。
 *
 * 迁移可能撞键（同一场里两个旧 id 归一成同一个新 id），这种行按「后写覆盖先写」合并：
 * 指标取两者之和会让数字虚高，所以保留先到的那行，冲突行连同它的指标一起删掉，
 * 并记一条 warn 说清丢了几行——宁可少一行可解释的记录，也不要编一条假数据。
 */
function migrateCallKeyToDoubleAt(db, logger) {
  const rows = db.prepare('SELECT run_id, call_id, model, effort FROM calls').all();
  const next = rows.map((row) => ({ ...row, next: callKeyOf(row.model, row.effort) }));
  const todo = next.filter((row) => row.next !== row.call_id);
  if (!todo.length) return;
  db.exec('BEGIN');
  let folded = 0;
  try {
    // 只把**已经在目标键上**的行算作占用：待迁移行自己的新键此时还不存在，
    // 否则每一个待迁移行都会被自己挡住（曾把整库删空）。
    const occupied = new Set(
      next.filter((row) => row.next === row.call_id).map((row) => `${row.run_id}\u0000${row.next}`),
    );
    const dropCall = db.prepare('DELETE FROM calls WHERE run_id = ? AND call_id = ?');
    const dropMetric = db.prepare('DELETE FROM call_metric WHERE run_id = ? AND call_id = ?');
    const moveCall = db.prepare('UPDATE calls SET call_id = ? WHERE run_id = ? AND call_id = ?');
    const moveMetric = db.prepare('UPDATE call_metric SET call_id = ? WHERE run_id = ? AND call_id = ?');
    for (const row of todo) {
      const key = `${row.run_id}\u0000${row.next}`;
      if (occupied.has(key)) {
        // 目标键已被另一行占住：丢弃当前这行（含指标），不叠加、不覆盖。
        dropMetric.run(row.run_id, row.call_id);
        dropCall.run(row.run_id, row.call_id);
        folded += 1;
        continue;
      }
      // 先把旧指标挪到新键，再改 calls 主键；顺序反了会让指标短暂悬空。
      moveMetric.run(row.next, row.run_id, row.call_id);
      moveCall.run(row.next, row.run_id, row.call_id);
      occupied.add(key);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  logger?.info?.(
    `model-team: 账本主键已迁到双 @@（改了 ${todo.length - folded} 行`
    + `${folded ? `，${folded} 行因归一后撞键被合并` : ''}）`,
  );
}

/**
 * v2 → v3：给 `calls` / `call_metric` 加上 `slot` 维度并重建主键。
 *
 * SQLite 不能原地改主键，所以走「建新表 → 拷贝 → 换名」。历史行一律填 `slot = ''`：
 * 旧库在撞键时已经把重复行覆盖掉了，无法还原，只能保证**今后**不再丢。
 *
 * 迁移全程在一个事务里，失败整体回滚，不会留下半张表。
 */
function migrateAddSlotKey(db, logger) {
  // 判据只看主键列数：DDL 的 `CREATE TABLE IF NOT EXISTS` 不会给已有表补列，
  // 所以旧库这里要么没有 slot 列，要么有列但主键仍是 2 列。两种都要重建。
  const pkCols = db.prepare("SELECT name FROM pragma_table_info('calls') WHERE pk > 0 ORDER BY pk").all()
    .map((row) => row.name);
  if (pkCols.length === 3 && pkCols.includes('slot')) return;
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE calls_v3 (
        run_id TEXT NOT NULL, call_id TEXT NOT NULL, slot TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL, effort TEXT NOT NULL,
        tool TEXT NOT NULL, status TEXT NOT NULL, excerpt TEXT NOT NULL, error TEXT NOT NULL,
        seconds INTEGER NOT NULL, log_path TEXT NOT NULL, finished_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, call_id, slot)
      );
      CREATE TABLE call_metric_v3 (
        run_id TEXT NOT NULL, call_id TEXT NOT NULL, slot TEXT NOT NULL DEFAULT '',
        metric TEXT NOT NULL, value REAL,
        PRIMARY KEY (run_id, call_id, slot, metric)
      );`);
    db.exec(`
      INSERT OR IGNORE INTO calls_v3
        (run_id, call_id, slot, model, provider, name, effort, tool, status, excerpt, error,
         seconds, log_path, finished_at)
      SELECT run_id, call_id, '', model, provider, name, effort, tool, status, excerpt, error,
             seconds, log_path, finished_at FROM calls;
      INSERT OR IGNORE INTO call_metric_v3 (run_id, call_id, slot, metric, value)
      SELECT run_id, call_id, '', metric, value FROM call_metric;`);
    const movedCalls = db.prepare('SELECT COUNT(*) AS c FROM calls_v3').get().c;
    const movedMetrics = db.prepare('SELECT COUNT(*) AS c FROM call_metric_v3').get().c;
    db.exec(`
      DROP TABLE calls;
      DROP TABLE call_metric;
      ALTER TABLE calls_v3 RENAME TO calls;
      ALTER TABLE call_metric_v3 RENAME TO call_metric;
      CREATE INDEX IF NOT EXISTS calls_finished_at ON calls (finished_at);
      CREATE INDEX IF NOT EXISTS calls_call_id ON calls (call_id);
      CREATE INDEX IF NOT EXISTS call_metric_metric ON call_metric (metric);`);
    db.exec('COMMIT');
    logger?.info?.(`model-team: 账本已加 slot 维度（${movedCalls} 行调用、${movedMetrics} 条指标）`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 指标名白名单：进窄表，加指标不改表结构（与技能侧 `METRIC_NAMES` 同口径）。 */export const METRIC_NAMES = [
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
];

/** 把一行的用量摊成「指标 → 值」。 */
function metricsOf(row) {
  const usage = row.usage ?? {};
  return [
    ['input_tokens', usage.input ?? 0],
    ['output_tokens', usage.output ?? 0],
    ['cache_read_tokens', usage.cacheRead ?? 0],
    ['cache_write_tokens', usage.cacheWrite ?? 0],
    ['reasoning_tokens', usage.reasoning ?? 0],
  ];
}

/** 账本句柄：只暴露写入、查询与清理三个面。 */
export class Ledger {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  /** 写入一场与它的逐模型行；同一 runId 重写会覆盖（幂等）。 */
  recordRun(run, rows) {
    const answered = rows.filter((row) => row.status === 'done').length;
    const insertRun = this.db.prepare(`
      INSERT INTO runs (run_id, kind, mode, packet_hash, started_at, finished_at, total, answered)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        kind = excluded.kind, mode = excluded.mode, packet_hash = excluded.packet_hash,
        started_at = excluded.started_at, finished_at = excluded.finished_at,
        total = excluded.total, answered = excluded.answered`);
    const insertCall = this.db.prepare(`
      INSERT INTO calls (run_id, call_id, slot, model, provider, name, effort, tool, status, excerpt, error,
                         seconds, log_path, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      -- 冲突时**所有非主键列都要刷新**：早先只更新 6 列，model/provider/name/effort/tool
      -- 会停在第一次写入的值上。同一 runId 幂等重放（或组名、模型 id 改过之后再跑）时，
      -- 就会出现「A 厂商的名字 + B 厂商的耗时」这种张冠李戴的单行记录。
      ON CONFLICT(run_id, call_id, slot) DO UPDATE SET
        model = excluded.model, provider = excluded.provider, name = excluded.name,
        effort = excluded.effort, tool = excluded.tool,
        status = excluded.status, excerpt = excluded.excerpt, error = excluded.error,
        seconds = excluded.seconds, log_path = excluded.log_path,
        finished_at = excluded.finished_at`);
    const upsertMetric = this.db.prepare(`
      INSERT INTO call_metric (run_id, call_id, slot, metric, value) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, call_id, slot, metric) DO UPDATE SET value = excluded.value`);
    const clearMetrics = this.db.prepare(
      'DELETE FROM call_metric WHERE run_id = ? AND call_id = ? AND slot = ?');

    this.db.exec('BEGIN');
    try {
      insertRun.run(run.runId, run.kind, run.mode, run.packetHash, run.startedAt, run.finishedAt,
        rows.length, answered);
      for (const row of rows) {
        const callId = callKeyOf(row.model, row.reasoningEffort);
        // 槽位 = 执行组 id（列表项为空串）。同一场里同一个 model@@effort 被调用两次
        // （列表项与组胜出撞车、或两组共用主力）时，靠它各占一行，不再互相覆盖。
        const slot = row.groupId ?? '';
        // `queued`/`running` 落到这里说明它没结算（进程被打断），记 failed；
        // `stopped` 是用户主动停的，**原样记**，不算失败（周报别把它算成模型不可用）。
        const status = row.status === 'queued' || row.status === 'running' ? 'failed' : row.status;
        insertCall.run(run.runId, callId, slot, row.model, row.provider, row.name,
          row.reasoningEffort ?? '', row.tool ?? 'dsh', status, excerpt(row.text), row.error ?? '',
          row.seconds ?? 0, row.logPath ?? '', run.finishedAt);
        // 指标进窄表：新增指标不改表结构（与原技能 session_metric 同构）。
        clearMetrics.run(run.runId, callId, slot);
        for (const [metric, value] of metricsOf(row)) {
          upsertMetric.run(run.runId, callId, slot, metric, value);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 写入一份周报。 */
  recordReport(report) {
    this.db.prepare(`
      INSERT OR REPLACE INTO reports (report_id, from_ts, to_ts, summary_model, summary, facts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(report.reportId, report.from, report.to, report.summaryModel,
        report.summary, report.facts, report.createdAt);
  }

  /** 最近 N 场（页面用）。 */
  recentRuns(limit = 20) {
    const take = Math.max(1, Math.min(200, Number(limit) || 20));
    return this.db.prepare(
      'SELECT * FROM runs ORDER BY finished_at DESC LIMIT ?').all(take)
      .map((row) => ({
        runId: row.run_id, kind: row.kind, mode: row.mode, packetHash: row.packet_hash,
        startedAt: row.started_at, finishedAt: row.finished_at,
        total: row.total, answered: row.answered,
      }));
  }

  /** 某些场次的逐模型行（页面用）。 */
  callsOf(runIds) {
    if (!runIds.length) return [];
    const placeholders = runIds.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM calls WHERE run_id IN (${placeholders}) ORDER BY run_id, call_id, slot`).all(...runIds)
      .map((row) => {
        const metrics = this.metricsFor(row.run_id, row.call_id, row.slot);
        return {
          runId: row.run_id, callId: row.call_id, slot: row.slot,
          model: row.model, provider: row.provider,
          name: row.name, reasoningEffort: row.effort, tool: row.tool, status: row.status,
          excerpt: row.excerpt, error: row.error, seconds: row.seconds, logPath: row.log_path,
          inputTokens: metrics.input_tokens ?? 0, outputTokens: metrics.output_tokens ?? 0,
          cacheReadTokens: metrics.cache_read_tokens ?? 0,
          cacheWriteTokens: metrics.cache_write_tokens ?? 0,
          reasoningTokens: metrics.reasoning_tokens ?? 0,
          finishedAt: row.finished_at,
        };
      });
  }

  /** 一条调用的指标字典（窄表读出）。 */
  metricsFor(runId, callId, slot = '') {
    const rows = this.db.prepare(
      'SELECT metric, value FROM call_metric WHERE run_id = ? AND call_id = ? AND slot = ?')
      .all(runId, callId, slot);
    const out = {};
    for (const row of rows) out[row.metric] = row.value;
    return out;
  }

  /** 最近几份周报。 */
  recentReports(limit = 5) {
    const take = Math.max(1, Math.min(50, Number(limit) || 5));
    return this.db.prepare(
      'SELECT * FROM reports ORDER BY created_at DESC LIMIT ?').all(take)
      .map((row) => ({
        reportId: row.report_id, from: row.from_ts, to: row.to_ts,
        summaryModel: row.summary_model, summary: row.summary,
        facts: row.facts, createdAt: row.created_at,
      }));
  }

  /** 一段时间窗口的聚合（周报用；走 `calls_finished_at` 索引）。 */
  aggregate(from, to) {
    const runs = this.db.prepare(
      'SELECT kind, COUNT(*) AS count FROM runs WHERE finished_at >= ? AND finished_at < ? GROUP BY kind')
      .all(from, to);
    const kinds = {};
    let runCount = 0;
    for (const row of runs) {
      kinds[row.kind] = row.count;
      runCount += row.count;
    }
    const totalOf = (metric) => this.db.prepare(`
      SELECT COALESCE(SUM(m.value), 0) AS total
      FROM call_metric m JOIN calls c
        ON c.run_id = m.run_id AND c.call_id = m.call_id AND c.slot = m.slot
      WHERE m.metric = ? AND c.finished_at >= ? AND c.finished_at < ?`).get(metric, from, to).total;
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS calls, COALESCE(SUM(seconds), 0) AS seconds
      FROM calls WHERE finished_at >= ? AND finished_at < ?`).get(from, to);
    totals.input = totalOf('input_tokens');
    totals.output = totalOf('output_tokens');
    // 先在 calls 上聚合（每条调用恰好一行），指标走子查询取——
    // 直接 LEFT JOIN call_metric 会按指标行把每条调用放大 N 倍（踩过：runs=5 而实际 1 次）。
    // 子查询同样要带 slot：同一个 call_id 可能有多个槽位的指标行。
    const metricSum = `COALESCE((SELECT SUM(m.value) FROM call_metric m
       WHERE m.run_id = c.run_id AND m.call_id = c.call_id AND m.slot = c.slot AND m.metric = ?), 0)`;
    const byModel = this.db.prepare(`
      SELECT c.call_id, c.model, c.provider, c.name, c.effort,
             COUNT(*) AS calls,
             SUM(CASE WHEN c.status = 'done' THEN 1 ELSE 0 END) AS answered,
             SUM(CASE WHEN c.status = 'failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN c.status = 'no-result' THEN 1 ELSE 0 END) AS no_result,
             SUM(CASE WHEN c.status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
             COALESCE(SUM(c.seconds), 0) AS seconds,
             COALESCE(SUM(${metricSum}), 0) AS input,
             COALESCE(SUM(${metricSum}), 0) AS output,
             COALESCE(SUM(${metricSum}), 0) AS cache_read
      FROM calls c
      WHERE c.finished_at >= ? AND c.finished_at < ?
      -- 分组要带 provider/name：call_id 只是「model@@effort」，同一个 model id
      -- 若挂在两个 provider 下（或两家的显示名不同），裸列取哪一行由 SQLite 任意决定，
      -- 周报/报告就会出现「A 厂商的名字 + B 厂商的数据」。按 provider 拆开更诚实。
      GROUP BY c.call_id, c.provider, c.name
      ORDER BY calls DESC, c.call_id ASC, c.provider ASC`)
      .all('input_tokens', 'output_tokens', 'cache_read_tokens', from, to);

    return {
      from,
      to,
      runs: runCount,
      calls: totals.calls,
      kinds,
      totals: { seconds: totals.seconds, inputTokens: totals.input, outputTokens: totals.output },
      models: byModel.map((row) => ({
        callId: row.call_id, model: row.model, provider: row.provider, name: row.name,
        reasoningEffort: row.effort, runs: row.calls, answered: row.answered,
        failed: row.failed, noResult: row.no_result, stopped: row.stopped, seconds: row.seconds,
        inputTokens: row.input, outputTokens: row.output, cacheReadTokens: row.cache_read,
      })),
    };
  }

  /**
   * 删除超过保留期的记录；返回删掉的调用行数。
   *
   * **`call_metric` 必须跟着删**：它没有外键约束，只删 `calls` 会让每条过期调用
   * 在指标表里永久残留 5 行。实测一次 prune 删掉 2745 行 calls、留下 13725 条孤儿，
   * 库体积只增不减，与文件头「保留 90 天、库不会无限长大」的承诺相反。
   */
  prune(now, days = RETENTION_DAYS) {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    this.db.exec('BEGIN');
    try {
      const calls = this.db.prepare('DELETE FROM calls WHERE finished_at < ?').run(cutoff);
      // 指标以 `calls` 的存在为准：先删 calls，再把没有归属的指标清掉。
      // 用 `EXISTS` 而不是 `run_id NOT IN (...)`：同一场里可能只过期了部分调用行，
      // 按 run_id 判会把还在保留期内的指标一起删掉。
      const metrics = this.db.prepare(`
        DELETE FROM call_metric
        WHERE NOT EXISTS (
          SELECT 1 FROM calls c
          WHERE c.run_id = call_metric.run_id
            AND c.call_id = call_metric.call_id
            AND c.slot = call_metric.slot
        )`).run();
      const reports = this.db.prepare('DELETE FROM reports WHERE created_at < ?').run(cutoff);
      const runs = this.db.prepare(
        'DELETE FROM runs WHERE finished_at < ? AND run_id NOT IN (SELECT DISTINCT run_id FROM calls)').run(cutoff);
      this.db.exec('COMMIT');
      return {
        calls: Number(calls.changes ?? 0),
        metrics: Number(metrics.changes ?? 0),
        runs: Number(runs.changes ?? 0),
        // 周报也会无限累积：每次 `model_team_weekly` 都插一行，早先 prune 完全没管它。
        reports: Number(reports.changes ?? 0),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 正文摘要：去掉多余空白并截断，账本里不留完整正文。 */
export function excerpt(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_EXCERPT_CHARS ? `${flat.slice(0, TEXT_EXCERPT_CHARS)}…` : flat;
}

/** 短的确定性哈希，用于标记"同一份 packet"而不把正文写进账本。 */
export function packetHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
