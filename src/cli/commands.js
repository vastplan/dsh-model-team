/**
 * 其余子命令的分发与实现：评估闭环、账本维护、报告、诊断。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataRoot } from './config.js';
import { listFlag, numberFlag } from './args.js';

/** 读 `--json <file>` 的 payload（`-` = stdin）。 */
function readJsonFile(flag) {
  const raw = String(flag ?? '').trim();
  if (!raw) throw new Error('缺少 --json <file>（`-` 表示从 stdin 读）');
  let text;
  if (raw === '-') text = readFileSync(0, 'utf8');
  else text = readFileSync(raw, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`--json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 周编号 → 起止时间（ISO 周，周一起）。 */
export function weekWindow(label) {
  const now = new Date();
  let year = now.getFullYear();
  let week = 1;
  if (label && label !== 'current') {
    const match = /^(\d{4})-W(\d{1,2})$/.exec(label);
    if (!match) throw new Error(`--week 格式应为 2026-W45 或 current（收到 ${label}）`);
    year = Number(match[1]);
    week = Number(match[2]);
  } else {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const day = (jan4.getUTCDay() + 6) % 7;
    const monday = new Date(jan4.getTime() - day * 86400000);
    const delta = Math.floor((Date.now() - monday.getTime()) / (7 * 86400000));
    week = Math.max(1, delta + 1);
  }
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = (jan4.getUTCDay() + 6) % 7;
  const firstMonday = new Date(jan4.getTime() - day * 86400000);
  const start = new Date(firstMonday.getTime() + (week - 1) * 7 * 86400000);
  const end = new Date(start.getTime() + 7 * 86400000);
  return { label: `${year}-W${String(week).padStart(2, '0')}`, start: start.getTime(), end: end.getTime() };
}

/** `routes`：默认名单 + 每家 harness + 近 7 天用量。 */
export async function routesReport(config, options = {}) {
  const { buildCliCatalog } = await import('./catalog.js');
  const { modelsList } = await import('./models.js');
  const { usageReport } = await import('./ledger-commands.js');
  const { catalog } = await buildCliCatalog(config, { quiet: true });
  const usage = (() => {
    try { return usageReport({ days: 7, dim: 'model' }); } catch { return []; }
  })();
  const usageByName = new Map(usage.map((row) => [row.name, row]));
  const rows = modelsList(catalog, config).map((row) => {
    const recent = usageByName.get(row.model) ?? null;
    return {
      spec: row.spec,
      name: row.name,
      harness: row.harness,
      is_default: row.is_default,
      recent_calls: recent?.calls ?? 0,
      recent_done: recent?.done ?? 0,
    };
  });
  const defaults = rows.filter((row) => row.is_default);
  return {
    kind: options.kind ?? 'audit',
    generatedAt: new Date().toISOString(),
    source: config.exists ? config.path : '(无配置文件，需 --models 显式指定)',
    roster: defaults.map((row) => row.spec),
    models: rows.sort((left, right) => Number(right.is_default) - Number(left.is_default)
      || right.recent_calls - left.recent_calls),
  };
}

/** `weekly` / `report` 共用的聚合：窗口内的 runs/calls。 */
export function aggregateWindow(db, from, to) {
  const runs = db.prepare('SELECT * FROM runs WHERE finished_at >= ? AND finished_at < ? AND kind <> ?').all(from, to, 'test');
  const runIds = runs.map((row) => String(row.run_id));
  if (!runIds.length) return { runs: [], byModel: [], totals: { runs: 0, calls: 0, done: 0, failed: 0, input: 0, output: 0 } };
  const placeholders = runIds.map(() => '?').join(',');
  const calls = db.prepare(`SELECT * FROM calls WHERE run_id IN (${placeholders})`).all(...runIds);
  const metrics = db.prepare(`SELECT * FROM call_metric WHERE run_id IN (${placeholders})`).all(...runIds);
  const metricMap = new Map();
  for (const row of metrics) {
    const key = `${row.run_id}|${row.call_id}|${row.slot}`;
    const item = metricMap.get(key) ?? {};
    item[row.metric] = Number(row.value) || 0;
    metricMap.set(key, item);
  }
  const byModel = new Map();
  let input = 0; let output = 0;
  for (const call of calls) {
    const key = `${call.model}${call.effort ? `@@${call.effort}` : ''}`;
    const item = byModel.get(key) ?? { model: key, calls: 0, done: 0, failed: 0, seconds: 0 };
    item.calls += 1;
    if (call.status === 'done') item.done += 1;
    if (call.status === 'failed') item.failed += 1;
    item.seconds += Number(call.seconds) || 0;
    const metric = metricMap.get(`${call.run_id}|${call.call_id}|${call.slot}`) ?? {};
    input += metric.input_tokens ?? 0;
    output += metric.output_tokens ?? 0;
    byModel.set(key, item);
  }
  return {
    runs: runs.map((row) => ({ run_id: row.run_id, kind: row.kind, mode: row.mode, total: row.total, answered: row.answered, finished_at: row.finished_at })),
    byModel: [...byModel.values()].sort((left, right) => right.calls - left.calls),
    totals: {
      runs: runs.length,
      calls: calls.length,
      done: calls.filter((call) => call.status === 'done').length,
      failed: calls.filter((call) => call.status === 'failed').length,
      input,
      output,
    },
  };
}

/** 渲染周报 markdown。 */
export function renderWeeklyMarkdown(label, aggregate, summary) {
  const lines = [`# 多模型团队周报 · ${label}`, ''];
  lines.push(`- 场次 **${aggregate.totals.runs}** · 调用 **${aggregate.totals.calls}**（成功 ${aggregate.totals.done} / 失败 ${aggregate.totals.failed}）`);
  lines.push(`- Token：输入 ${aggregate.totals.input.toLocaleString()} / 输出 ${aggregate.totals.output.toLocaleString()}`, '');
  lines.push('## 各模型表现', '', '| 模型 | 调用 | 成功 | 失败 | 均耗时 |', '| --- | --- | --- | --- | --- |');
  for (const row of aggregate.byModel) {
    const avg = row.calls ? Math.round(row.seconds / row.calls) : 0;
    lines.push(`| ${row.model} | ${row.calls} | ${row.done} | ${row.failed} | ${avg}s |`);
  }
  if (summary) lines.push('', '## 综述', '', summary);
  return `${lines.join('\n')}\n`;
}

/** `quota`：读余额缓存（旧 CLI 的 `balance/quota-cache.json`），没有就说明怎么生成。 */
export function quotaReport() {
  const path = join(dataRoot(), 'balance', 'quota-cache.json');
  if (!existsSync(path)) {
    return { ok: false, reason: `没有余额缓存：${path}`, accounts: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { ok: true, path, generatedAt: raw.generatedAt ?? null, accounts: raw.accounts ?? [] };
  } catch (error) {
    return { ok: false, reason: `余额缓存读不出来：${error instanceof Error ? error.message : String(error)}`, accounts: [] };
  }
}

/** `index`：重建归档入口页（列出 weekly 目录）。 */
export function rebuildIndex(root = dataRoot()) {
  const weekly = join(root, 'weekly');
  const entries = existsSync(weekly) ? readdirSync(weekly, { withFileTypes: true }).filter((item) => item.isDirectory()) : [];
  const items = entries.sort((left, right) => right.name.localeCompare(left.name))
    .map((item) => `<li><a href="weekly/${item.name}/report.md">${item.name}</a></li>`);
  const html = `<!doctype html><meta charset="utf-8"><title>多模型团队归档</title>
<h1>多模型团队归档</h1><ul>${items.join('') || '<li>（还没有周报）</li>'}</ul>`;
  mkdirSync(root, { recursive: true });
  const target = join(root, 'index.html');
  writeFileSync(target, html, 'utf8');
  return { path: target, weeks: items.length };
}

/**
 * 其余子命令分发。
 *
 * @param command - 子命令名
 * @param parsed - `parseArgs()` 结果
 * @param config - `loadCliConfig()` 结果
 */
export async function dispatchExtra(command, parsed, config) {
  const { hasFlag, flagOf } = await import('./args.js');
  const ledger = await import('./ledger-commands.js');
  const dbPath = flagOf(parsed, '--db', config.ledgerPath);
  const pretty = (value) => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return 0; };

  if (command === 'record-findings') {
    const result = ledger.recordFindings({
      runId: flagOf(parsed, '--run-id'),
      payload: readJsonFile(flagOf(parsed, '--json')),
      write: hasFlag(parsed, '--write'),
      dbPath,
    });
    return pretty(result);
  }
  if (command === 'record-outcome') {
    const result = ledger.recordOutcome({
      runId: flagOf(parsed, '--run-id'),
      payload: readJsonFile(flagOf(parsed, '--json')),
      write: hasFlag(parsed, '--write'),
      dbPath,
    });
    return pretty(result);
  }
  if (command === 'summary') return pretty(ledger.summaryReport({ kind: flagOf(parsed, '--kind'), dbPath }));
  if (command === 'selfcheck') {
    const report = ledger.selfCheck({ dbPath });
    if (hasFlag(parsed, '--json')) return pretty(report);
    process.stdout.write(`${report.ok ? '✔ 一致' : '✘ 有问题'}\n场次 ${report.runs} · 调用 ${report.calls} · 日志目录 ${report.runDirs}\n`);
    for (const problem of report.problems) process.stdout.write(`- ${problem}\n`);
    return report.ok ? 0 : 1;
  }
  if (command === 'normalize') return pretty(ledger.normalizeNames({ write: hasFlag(parsed, '--write'), dbPath }));
  if (command === 'refresh-usage') {
    return pretty(ledger.refreshUsage({
      runId: flagOf(parsed, '--run-id'),
      write: hasFlag(parsed, '--write'),
      onlyEmpty: hasFlag(parsed, '--only-empty'),
      dbPath,
    }));
  }
  if (command === 'backfill') {
    return pretty(ledger.backfill({ runId: flagOf(parsed, '--run-id'), write: hasFlag(parsed, '--write'), dbPath }));
  }
  if (command === 'usage') {
    const rows = ledger.usageReport({
      dim: flagOf(parsed, '--dim', 'tool'),
      days: numberFlag(parsed, '--range-days', 7),
      dbPath,
    });
    if (hasFlag(parsed, '--json')) return pretty(rows);
    process.stdout.write(`用量（近 ${numberFlag(parsed, '--range-days', 7)} 天，按 ${flagOf(parsed, '--dim', 'tool')}）\n`);
    for (const row of rows.slice(0, numberFlag(parsed, '--limit', 20))) {
      process.stdout.write(`${String(row.name).padEnd(34)} ${String(row.calls).padStart(4)} 次 · 成功 ${row.done} · ${row.avg_seconds}s\n`);
    }
    return 0;
  }
  if (command === 'routes') {
    return pretty(await routesReport(config, { kind: flagOf(parsed, '--kind', 'audit') }));
  }
  if (command === 'quota') {
    const report = quotaReport();
    if (hasFlag(parsed, '--json')) return pretty(report);
    if (!report.ok) { process.stdout.write(`${report.reason}\n`); return 1; }
    if (!report.accounts.length) {
      process.stdout.write(`余额缓存存在但没有账户数据：${report.path}（用旧 CLI 的 \`quota --refresh\` 刷新一次缓存）\n`);
      return 0;
    }
    for (const account of report.accounts) process.stdout.write(`${String(account.id).padEnd(16)} ${account.status} ${account.detail ?? ''}\n`);
    return 0;
  }
  if (command === 'index') return pretty(rebuildIndex());

  if (command === 'weekly' || command === 'report' || command === 'post') {
    const { weekWindow, aggregateWindow, renderWeeklyMarkdown } = await import('./commands.js');
    const window = weekWindow(flagOf(parsed, '--week'));
    const db = ledger.openDb(dbPath);
    let aggregate;
    try {
      aggregate = aggregateWindow(db, window.start, window.end);
    } finally {
      db.close();
    }
    if (command === 'report') {
      const out = flagOf(parsed, '--out');
      const payload = { week: window.label, from: window.start, to: window.end, ...aggregate };
      if (out) writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
      return pretty(payload);
    }
    const dir = join(dataRoot(), 'weekly', window.label);
    mkdirSync(dir, { recursive: true });
    let summary = '';
    const modelSpec = listFlag(parsed, '--models')[0] ?? flagOf(parsed, '--model');
    if (modelSpec && command === 'weekly') {
      const { buildCliCatalog } = await import('./catalog.js');
      const { runCliTeam } = await import('./run.js');
      const { catalog } = await buildCliCatalog(config, { quiet: true });
      const outcome = await runCliTeam({
        kind: 'reason',
        packet: `# 周报综述\n\n${JSON.stringify(aggregate, null, 2)}\n`,
        models: [modelSpec],
        catalog,
        workspace: process.cwd(),
        quiet: true,
      });
      summary = outcome.runs.map((row) => row.answer).filter(Boolean).join('\n\n');
    }
    const markdown = renderWeeklyMarkdown(window.label, aggregate, summary);
    writeFileSync(join(dir, 'report.md'), markdown, 'utf8');
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ week: window.label, ...aggregate, summary }, null, 2), 'utf8');
    if (hasFlag(parsed, '--json')) return pretty({ week: window.label, dir, markdown });
    process.stdout.write(`${markdown}\n写入：${dir}\n`);
    return 0;
  }

  throw new Error(`未知子命令：${command}（model-team --help 看全部）`);
}
