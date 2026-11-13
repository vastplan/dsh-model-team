/**
 * 账本类子命令：record-findings / record-outcome / summary / selfcheck /
 * normalize / refresh-usage / backfill / usage / routes。
 *
 * 全部直接读同一本 SQLite（`~/.model-team/ledger/model-audit-reviews.db`），
 * 与插件内的 `runs`/`calls` 和旧 skill 的 `review_session`/`finding` 共存。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveLedgerPath, RETENTION_DAYS } from '../ledger.js';
import { dataRoot } from './config.js';

/** 账本路径解析（--db 覆盖）。 */
export function ledgerPathOf(explicit = '') {
  const raw = String(explicit ?? '').trim();
  if (raw) return raw;
  return resolveLedgerPath({ dshHome: process.env.DSH_HOME || `${process.env.HOME}/.dsh` });
}

/** 打开账本；不存在时报错（避免静默建一个空库让人以为数据丢了）。 */
export function openDb(explicit = '', { readOnly = false } = {}) {
  const path = ledgerPathOf(explicit);
  if (!existsSync(path)) throw new Error(`账本不存在：${path}（先跑一次 run，或用 --db 指定）`);
  return new DatabaseSync(path, { readOnly });
}

/** 三类活动里「正向结论」叫什么。 */
const POSITIVE_BY_KIND = { 事后审计: '缺陷', 设计分叉: '方向', 专责推理: '方案' };

/** 数字列：空 → ''，非法 → 0。 */
const num = (value) => {
  if (value === '' || value === null || value === undefined) return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** 一条 finding 的规范化。 */
function normalizeFinding(item, index) {
  const model = String(item?.model ?? '').trim();
  if (!model) throw new Error(`第 ${index + 1} 条缺少 model`);
  const claimed = String(item?.claimed ?? '').trim();
  let severity = item?.severity ?? '';
  if (['缺陷', '方向', '方案'].includes(claimed)) {
    const value = Number(severity);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error(`第 ${index + 1} 条重要性必须是 1～5（收到 ${JSON.stringify(severity)}）`);
    }
    severity = value;
  }
  return {
    model,
    title: String(item?.title ?? ''),
    claimed,
    severity,
    verdict: String(item?.verdict ?? ''),
    action: String(item?.action ?? ''),
    note: String(item?.note ?? ''),
  };
}

/** 该场次参评的模型名（review_session 里有的才算）。 */
export function rosterOf(db, runId) {
  try {
    return db.prepare('SELECT DISTINCT 模型 FROM review_session WHERE 场次ID = ?').all(runId)
      .map((row) => String(row.模型)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `record-findings`。
 *
 * @param options.payload - `[{model,title,claimed,severity,verdict,action,note}]`
 * @param options.write - 不给我时只演练并打印将要写入的行。
 */
export function recordFindings(options) {
  const db = openDb(options.dbPath, { readOnly: options.write !== true });
  try {
    const runId = String(options.runId ?? '').trim();
    if (!runId) throw new Error('缺少 --run-id');
    const payload = Array.isArray(options.payload) ? options.payload : null;
    if (!payload) throw new Error('--json 必须是数组');
    const roster = rosterOf(db, runId);
    const findings = payload.map(normalizeFinding);
    if (roster.length) {
      const names = new Set(roster.map((name) => name.toLowerCase()));
      const bad = findings.filter((item) => !names.has(item.model.toLowerCase()));
      if (bad.length) {
        throw new Error(`第 ${payload.indexOf(bad[0]) + 1} 条 model=${JSON.stringify(bad[0].model)} 不在本场 ${runId} 的参评名单里（${roster.join('、')}）`);
      }
    }
    if (!options.write) {
      return { dryRun: true, runId, count: findings.length, rows: findings };
    }
    db.exec('BEGIN');
    try {
      for (const item of findings) {
        // `finding` 是 WITHOUT ROWID，主键 (场次ID, 模型, 问题标题, dup_seq)：
        // 同标题重复写入走 ON CONFLICT，不靠 rowid。
        db.prepare(`INSERT INTO finding
            (场次ID, 模型, 问题标题, 模型声称, 重要性, 对照代码判定, 是否独有, 处理, 说明, dup_seq, ord)
            VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 1, 0)
            ON CONFLICT(场次ID, 模型, 问题标题, dup_seq) DO UPDATE SET
              模型声称 = excluded.模型声称, 重要性 = excluded.重要性,
              对照代码判定 = excluded.对照代码判定, 处理 = excluded.处理, 说明 = excluded.说明`)
          .run(runId, item.model, item.title, item.claimed, String(item.severity), item.verdict, item.action, item.note);
      }
      db.prepare("UPDATE review_session SET 质量评估 = '已评' WHERE 场次ID = ?").run(runId);
      recomputeSummary(db, runId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { dryRun: false, runId, count: findings.length };
  } finally {
    db.close();
  }
}

/** `record-outcome`：契合分 / 满意度 / 选用匹配。 */
export function recordOutcome(options) {
  const db = openDb(options.dbPath, { readOnly: options.write !== true });
  try {
    const runId = String(options.runId ?? '').trim();
    if (!runId) throw new Error('缺少 --run-id');
    const payload = Array.isArray(options.payload) ? options.payload : null;
    if (!payload) throw new Error('--json 必须是数组');
    const rows = payload.map((item, index) => {
      const model = String(item?.model ?? item?.id ?? '').trim();
      if (!model) throw new Error(`第 ${index + 1} 条缺少 model`);
      return {
        model,
        fit: item?.fit,
        satisfaction: item?.satisfaction,
        match: item?.match,
      };
    });
    if (!options.write) return { dryRun: true, runId, rows };
    db.exec('BEGIN');
    try {
      // 先重算一次生成 summary 行，再写契合分/满意度——反过来的话会被重算覆盖成空。
      recomputeSummary(db, runId);
      for (const item of rows) {
        // 契合分 / 满意度只在 `session_summary` 上（`review_session` 没有这两列，真机踩过）。
        const summarySet = [];
        const summaryValues = [];
        if (item.fit !== undefined) { summarySet.push('契合分 = ?'); summaryValues.push(Number(item.fit)); }
        if (item.satisfaction !== undefined) { summarySet.push('满意度 = ?'); summaryValues.push(Number(item.satisfaction)); }
        if (item.match !== undefined) { summarySet.push('选用匹配 = ?'); summaryValues.push(String(item.match)); }
        if (!summarySet.length) continue;
        summaryValues.push(runId, item.model);
        db.prepare(`UPDATE session_summary SET ${summarySet.join(', ')} WHERE 场次ID = ? AND 模型 = ?`).run(...summaryValues);
        // review_session 只同步「选用匹配」。
        if (item.match !== undefined) {
          db.prepare('UPDATE review_session SET 选用匹配 = ? WHERE 场次ID = ? AND 模型 = ?')
            .run(String(item.match), runId, item.model);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { dryRun: false, runId, count: rows.length };
  } finally {
    db.close();
  }
}

/**
 * 重算某场（或全场）的 `session_summary`。
 *
 * 口径与旧 CLI 一致：声称数/成立数/假阳性/独有/重要性合计/最高分/1~5 分布；
 * 质量分与效率分沿用旧公式的简化版（旧公式在 `scoring_formula` 表里，能读就读）。
 */
export function recomputeSummary(db, runId = null) {
  const runs = runId
    ? db.prepare('SELECT * FROM review_session WHERE 场次ID = ?').all(runId)
    : db.prepare('SELECT * FROM review_session').all();
  if (!runs.length) return 0;
  const findings = db.prepare('SELECT * FROM finding').all();
  const byKey = new Map();
  for (const row of findings) {
    const key = `${row['场次ID']}|${row['模型']}`;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }
  let written = 0;
  for (const rec of runs) {
    const rid = String(rec['场次ID'] ?? '');
    const model = String(rec['模型'] ?? '');
    const kindLabel = String(rec['场次类型'] ?? '事后审计');
    const positive = POSITIVE_BY_KIND[kindLabel] ?? '缺陷';
    const list = byKey.get(`${rid}|${model}`) ?? [];
    let claimed = 0; let confirmed = 0; let falsePos = 0; let unique = 0;
    let confSum = 0; let high = 0;
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of list) {
      const claimedKind = String(row['模型声称'] ?? '');
      const verdict = String(row['对照代码判定'] ?? '');
      const severity = row['重要性'] === '' || row['重要性'] === null ? 0 : Number(row['重要性']) || 0;
      if (claimedKind === positive) {
        claimed += 1;
        if (verdict === '不成立') falsePos += 1;
      }
      if (['拍板', '越界'].includes(claimedKind) && verdict === '成立') falsePos += 1;
      if (verdict === '成立' && claimedKind === positive) {
        confirmed += 1;
        confSum += severity;
        high = Math.max(high, severity);
        if (counts[severity] !== undefined) counts[severity] += 1;
        const title = String(row['问题标题'] ?? '');
        const others = list.filter((other) => other !== row && String(other['问题标题'] ?? '') === title
          && String(other['对照代码判定'] ?? '') === '成立').length;
        if (others === 0) unique += 1;
      }
    }
    const seconds = Number(rec['耗时秒'] ?? 0) || 0;
    const minutes = seconds ? seconds / 60 : 0;
    const evalStatus = list.length || claimed || confirmed ? '已评' : '未评';
    db.prepare("UPDATE review_session SET 质量评估 = ? WHERE 场次ID = ? AND 模型 = ?").run(evalStatus, rid, model);
    // 契合分/满意度/用户选择只存在于 session_summary：重算时若 review_session 没有，就沿用旧值，
    // 否则「先 record-outcome、后 record-findings」会把用户评分清空。
    const previous = db.prepare('SELECT 用户选择, 契合分, 满意度, 选用匹配 FROM session_summary WHERE 场次ID = ? AND 模型 = ?')
      .get(rid, model) ?? {};
    const pick = (column) => (rec[column] !== undefined && rec[column] !== '' ? rec[column] : (previous[column] ?? ''));
    const quality = Math.round((confSum * 2 + unique * 3 - falsePos) * 10) / 10;
    const efficiency = minutes ? Math.round((confSum / minutes) * 100) / 100 : '';
    const values = [
      rid, kindLabel, model, rec['调用工具'] ?? '', rec['思考强度'] ?? '', rec['调用链'] ?? '',
      num(rec['耗时秒']), rec['开始时间'] ?? '', rec['完成时间'] ?? '',
      num(rec['输入token']), num(rec['输出token']), num(rec['缓存读token']), num(rec['缓存写token']), num(rec['推理token']),
      '', '', '', '', '',
      evalStatus, claimed, confirmed, falsePos, unique, confSum, high || '',
      counts[5], counts[4], counts[3], counts[2], counts[1],
      pick('用户选择'), pick('契合分'), pick('满意度'), pick('选用匹配'),
      quality, efficiency,
    ];
    const columns = ['场次ID', '场次类型', '模型', '调用工具', '思考强度', '调用链', '耗时秒', '开始时间', '完成时间',
      '输入token', '输出token', '缓存读token', '缓存写token', '推理token',
      '输入金额USD', '输出金额USD', '缓存读金额USD', '缓存写金额USD', '金额合计USD',
      '质量评估', '声称缺陷', '成立缺陷', '假阳性', '独有成立', '成立缺陷重要性合计', '最高成立分',
      '重要性5', '重要性4', '重要性3', '重要性2', '重要性1',
      '用户选择', '契合分', '满意度', '选用匹配', '质量分', '效率分'];
    // 同样是 WITHOUT ROWID：主键 (场次ID, 模型)，用 ON CONFLICT 覆盖。
    const updateColumns = [...columns.slice(2), 'ord'];
    db.prepare(`INSERT INTO session_summary (${[...columns, 'ord'].join(', ')})
        VALUES (${[...columns, 'ord'].map(() => '?').join(', ')})
        ON CONFLICT(场次ID, 模型) DO UPDATE SET ${updateColumns.map((name) => `${name} = excluded.${name}`).join(', ')}`)
      .run(...values, 0);
    written += 1;
  }
  return written;
}

/** `summary`：按活动类型汇总。 */
export function summaryReport(options = {}) {
  const db = openDb(options.dbPath);
  try {
    const kind = String(options.kind ?? '').trim();
    const rows = kind
      ? db.prepare('SELECT * FROM session_summary WHERE 场次类型 = ?').all(kind)
      : db.prepare('SELECT * FROM session_summary').all();
    const byModel = new Map();
    for (const row of rows) {
      const key = String(row['模型'] ?? '');
      const item = byModel.get(key) ?? { model: key, sessions: 0, claimed: 0, confirmed: 0, falsePos: 0, unique: 0, severity: 0, quality: 0 };
      item.sessions += 1;
      item.claimed += Number(row['声称缺陷'] ?? 0) || 0;
      item.confirmed += Number(row['成立缺陷'] ?? 0) || 0;
      item.falsePos += Number(row['假阳性'] ?? 0) || 0;
      item.unique += Number(row['独有成立'] ?? 0) || 0;
      item.severity += Number(row['成立缺陷重要性合计'] ?? 0) || 0;
      item.quality += Number(row['质量分'] ?? 0) || 0;
      byModel.set(key, item);
    }
    const models = [...byModel.values()]
      .map((item) => ({ ...item, precision: item.claimed ? Math.round((item.confirmed / item.claimed) * 1000) / 10 : null }))
      .sort((left, right) => right.severity - left.severity);
    return { kind: kind || '全部', sessions: rows.length, models };
  } finally {
    db.close();
  }
}

/** `selfcheck`：账本与日志目录的基本一致性。 */
export function selfCheck(options = {}) {
  const db = openDb(options.dbPath);
  const problems = [];
  let runs = 0; let calls = 0; let missingLogs = 0; let orphanFindings = 0;
  try {
    runs = db.prepare('SELECT COUNT(*) n FROM runs').get().n;
    calls = db.prepare('SELECT COUNT(*) n FROM calls').get().n;
    const rows = db.prepare("SELECT log_path FROM calls WHERE log_path <> ''").all();
    for (const row of rows) if (!existsSync(String(row.log_path))) missingLogs += 1;
    const sessionIds = new Set(db.prepare('SELECT DISTINCT 场次ID FROM review_session').all().map((row) => String(row['场次ID'])));
    for (const row of db.prepare('SELECT DISTINCT 场次ID FROM finding').all()) {
      if (!sessionIds.has(String(row['场次ID']))) orphanFindings += 1;
    }
    const runsRoot = join(dataRoot(), 'runs');
    const dirCount = existsSync(runsRoot) ? readdirSync(runsRoot).length : 0;
    if (missingLogs) problems.push(`${missingLogs} 条 calls 的 log_path 指向不存在的文件`);
    if (orphanFindings) problems.push(`${orphanFindings} 个 finding 的场次在 review_session 里不存在`);
    if (calls > 0 && runs === 0) problems.push('有 calls 但没有 runs');
    return { ok: problems.length === 0, runs, calls, runDirs: dirCount, missingLogs, orphanFindings, problems, retentionDays: RETENTION_DAYS };
  } finally {
    db.close();
  }
}

/** `normalize`：把模型名去空格/统一大小写（幂等）。 */
export function normalizeNames(options = {}) {
  const db = openDb(options.dbPath, { readOnly: options.write !== true });
  try {
    const tables = [['review_session', '模型'], ['finding', '模型'], ['session_summary', '模型']];
    const changes = [];
    for (const [table, column] of tables) {
      const rows = db.prepare(`SELECT DISTINCT ${column} AS name FROM ${table}`).all();
      for (const row of rows) {
        const name = String(row.name ?? '');
        const normalized = name.replace(/\s+/g, ' ').trim();
        if (normalized && normalized !== name) changes.push({ table, from: name, to: normalized });
      }
    }
    if (options.write && changes.length) {
      db.exec('BEGIN');
      try {
        for (const change of changes) {
          db.prepare(`UPDATE ${change.table} SET 模型 = ? WHERE 模型 = ?`).run(change.to, change.from);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return { dryRun: options.write !== true, changes: changes.length, details: changes.slice(0, 50) };
  } finally {
    db.close();
  }
}

/** `refresh-usage`：从会话日志回填 calls 的 token 指标。 */
export function refreshUsage(options = {}) {
  const db = openDb(options.dbPath, { readOnly: options.write !== true });
  try {
    const filter = options.runId ? 'AND c.run_id = ?' : '';
    const params = options.runId ? [options.runId] : [];
    const rows = db.prepare(`
      SELECT c.run_id, c.call_id, c.slot, c.log_path,
             (SELECT COALESCE(SUM(value), 0) FROM call_metric m
               WHERE m.run_id = c.run_id AND m.call_id = c.call_id AND m.slot = c.slot) AS total
      FROM calls c
      WHERE c.log_path <> '' ${filter}
    `).all(...params);
    const targets = options.onlyEmpty ? rows.filter((row) => Number(row.total) === 0) : rows;
    const updates = [];
    for (const row of targets) {
      if (!existsSync(String(row.log_path))) continue;
      try {
        const doc = JSON.parse(readFileSync(String(row.log_path), 'utf8'));
        const usage = doc?.usage ?? {};
        const metrics = {
          input_tokens: usage.input ?? 0,
          output_tokens: usage.output ?? 0,
          cache_read_tokens: usage.cache_read ?? 0,
          cache_write_tokens: usage.cache_write ?? 0,
          reasoning_tokens: usage.reasoning ?? 0,
        };
        if (Object.values(metrics).every((value) => !value)) continue;
        updates.push({ ...row, metrics });
      } catch { /* 坏日志跳过 */ }
    }
    if (options.write && updates.length) {
      db.exec('BEGIN');
      try {
        for (const update of updates) {
          for (const [metric, value] of Object.entries(update.metrics)) {
            db.prepare(`INSERT INTO call_metric (run_id, call_id, slot, metric, value) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(run_id, call_id, slot, metric) DO UPDATE SET value = excluded.value`)
              .run(update.run_id, update.call_id, update.slot, metric, value);
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return { dryRun: options.write !== true, scanned: rows.length, updated: updates.length };
  } finally {
    db.close();
  }
}

/** `backfill`：场次里有日志但没有 calls 行时，从日志补一行。 */
export function backfill(options = {}) {
  const db = openDb(options.dbPath, { readOnly: options.write !== true });
  try {
    const runId = String(options.runId ?? '').trim();
    if (!runId) throw new Error('缺少 --run-id');
    const runDir = join(dataRoot(), 'runs', runId);
    if (!existsSync(runDir)) throw new Error(`会话目录不存在：${runDir}`);
    const logs = readdirSync(runDir).filter((name) => name.endsWith('.json'));
    const existing = new Set(db.prepare('SELECT call_id FROM calls WHERE run_id = ?').all(runId).map((row) => String(row.call_id)));
    const pending = [];
    for (const name of logs) {
      let doc;
      try { doc = JSON.parse(readFileSync(join(runDir, name), 'utf8')); } catch { continue; }
      const model = String(doc?.model ?? '');
      if (!model) continue;
      const callId = `${model}@@${doc?.thinking || 'default'}`;
      if (existing.has(callId)) continue;
      pending.push({ name, callId, doc });
    }
    if (options.write && pending.length) {
      db.exec('BEGIN');
      try {
        for (const item of pending) {
          db.prepare(`INSERT OR REPLACE INTO calls (run_id, call_id, slot, model, provider, name, effort, tool, status,
                       excerpt, error, seconds, log_path, finished_at)
                     VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(runId, item.callId, item.doc.model, item.doc.model.split('/')[0] ?? '', item.doc.model,
              item.doc.thinking ?? '', item.doc.tool ?? '', item.doc.answer ? 'done' : 'no-result',
              String(item.doc.answer ?? '').slice(0, 200), String(item.doc.stop_note ?? ''),
              Math.round(Number(item.doc.duration_s) || 0), join(runDir, item.name), Date.now());
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return { dryRun: options.write !== true, runId, logs: logs.length, missing: pending.length, files: pending.map((item) => item.name) };
  } finally {
    db.close();
  }
}

/** `usage`：按维度统计近 N 天用量。 */
export function usageReport(options = {}) {
  const db = openDb(options.dbPath);
  try {
    const dim = String(options.dim ?? 'tool');
    const column = { tool: 'tool', provider: 'provider', model: 'model' }[dim];
    if (!column) throw new Error(`未知维度：${dim}（tool | provider | model）`);
    const since = Date.now() - (Number(options.days) || 7) * 24 * 3600 * 1000;
    const rows = db.prepare(`
      SELECT ${column} AS name, COUNT(*) AS calls,
             SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
             ROUND(AVG(seconds), 1) AS avg_seconds
      FROM calls WHERE finished_at >= ? GROUP BY ${column} ORDER BY calls DESC
    `).all(since);
    const tokens = new Map();
    for (const row of db.prepare(`
      SELECT c.${column} AS name, m.metric, SUM(m.value) AS total
      FROM call_metric m JOIN calls c ON c.run_id = m.run_id AND c.call_id = m.call_id AND c.slot = m.slot
      WHERE c.finished_at >= ? GROUP BY c.${column}, m.metric
    `).all(since)) {
      const item = tokens.get(row.name) ?? {};
      item[row.metric] = Number(row.total) || 0;
      tokens.set(row.name, item);
    }
    return rows.map((row) => ({
      name: row.name,
      calls: Number(row.calls) || 0,
      done: Number(row.done) || 0,
      avg_seconds: Number(row.avg_seconds) || 0,
      input_tokens: tokens.get(row.name)?.input_tokens ?? 0,
      output_tokens: tokens.get(row.name)?.output_tokens ?? 0,
    }));
  } finally {
    db.close();
  }
}
