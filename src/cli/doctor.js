/**
 * `model-team doctor`：本机 harness 就绪探测（只读、不耗 token）。
 *
 * 判据三层：
 * 1. `harnessAvailable()`——命令/文件是否存在（与厂商路由同一口口径）；
 * 2. `probe`（如 `agy --version`）——能不能真的执行；
 * 3. 近 `--range` 天账本里的成功率——装好但一直失败的，标 `degraded`。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { harnessAvailable } from '../harness/availability.js';
import { fill, listHarnesses, registerBuiltinHarnesses, registerConfiguredHarnesses } from '../harness/index.js?v=0.7.3';
import { openLedger, resolveLedgerPath } from '../ledger.js';

const execFileAsync = promisify(execFile);

const STATUS_ORDER = { missing: 0, failed: 1, degraded: 2, installed: 3, ready: 4 };

/** 跑一次 probe；超时/非零一律算 failed。 */
async function probe(def, timeoutS) {
  const args = Array.isArray(def.probe?.args) ? def.probe.args : ['--version'];
  // 定义里的命令可能有占位符（devin 的 `{node}` / zcode 的 `{pkgDir}`），必须按同一口径填。
  const values = { node: process.execPath };
  const command = fill(def.command, values);
  const argv = args.map((arg) => fill(arg, values));
  try {
    const { stdout, stderr } = await execFileAsync(command, argv, {
      timeout: Math.max(1, timeoutS) * 1000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, detail: String(stdout || stderr).trim().split('\n')[0]?.slice(0, 120) ?? '' };
  } catch (error) {
    return { ok: false, detail: String(error instanceof Error ? error.message : error).slice(0, 160) };
  }
}

/** 近 N 天该 harness 的成功率（按 calls.tool 聚合；没有记录返回 null）。 */
export function recentHealth(ledger, rangeMs) {
  if (!ledger) return new Map();
  const since = Date.now() - rangeMs;
  let rows = [];
  try {
    rows = ledger.db.prepare(`
      SELECT tool, status, COUNT(*) n FROM calls WHERE finished_at >= ? GROUP BY tool, status
    `).all(since);
  } catch {
    return new Map();
  }
  const table = new Map();
  for (const row of rows) {
    const item = table.get(row.tool) ?? { total: 0, done: 0, failed: 0 };
    item.total += Number(row.n) || 0;
    if (row.status === 'done') item.done += Number(row.n) || 0;
    if (row.status === 'failed') item.failed += Number(row.n) || 0;
    table.set(row.tool, item);
  }
  return table;
}

/**
 * @param options.rangeMs - 统计窗口。
 * @param options.timeoutS - 单个 probe 超时。
 * @returns `{ generatedAt, commands, targets[] }`
 */
export async function runDoctor(options = {}) {
  // 必须先登记内置定义，否则 listHarnesses() 是空的（真机踩过：doctor 报「0 家 harness」）。
  registerBuiltinHarnesses();
  if (options.config) registerConfiguredHarnesses({ logger: { warn: () => {} } }, options.config);
  const definitions = listHarnesses();
  const timeoutS = Number(options.timeoutS) || 8;
  const rangeMs = Number(options.rangeMs) || 7 * 24 * 3600 * 1000;
  const ledgerPath = resolveLedgerPath({ dshHome: process.env.DSH_HOME || `${process.env.HOME}/.dsh` });
  const ledger = options.ledger === undefined ? await openLedger(ledgerPath) : options.ledger;
  const health = recentHealth(ledger, rangeMs);
  try {
    const targets = await Promise.all(definitions.map(async (def) => {
      const available = harnessAvailable(def);
      const item = { id: def.id, label: def.label, command: def.command, available };
      if (!available) {
        return { ...item, status: 'missing', detail: '命令或配置文件不存在', usage: health.get(def.id) ?? null };
      }
      const probed = await probe(def, timeoutS);
      const usage = health.get(def.id) ?? null;
      let status = probed.ok ? 'ready' : 'failed';
      // 装好、能执行，但近期一直失败 → degraded（比 failed 轻，提示去修而不是去装）。
      if (probed.ok && usage && usage.total >= 3 && usage.done === 0) status = 'degraded';
      return { ...item, status, detail: probed.detail, usage };
    }));
    targets.sort((left, right) => (STATUS_ORDER[left.status] ?? 0) - (STATUS_ORDER[right.status] ?? 0)
      || left.id.localeCompare(right.id));
    return {
      generatedAt: new Date().toISOString(),
      timeoutS,
      commands: definitions.length,
      targets,
    };
  } finally {
    if (options.ledger === undefined) {
      try { ledger?.close?.(); } catch { /* 忽略 */ }
    }
  }
}

/** 人读渲染。 */
export function renderDoctor(report) {
  const lines = [`model-team doctor · ${report.generatedAt} · ${report.commands} 家 harness`];
  for (const target of report.targets) {
    const icon = { ready: '✔', degraded: '▲', failed: '✘', missing: '·' }[target.status] ?? '?';
    const usage = target.usage ? ` · 近7天 ${target.usage.done}/${target.usage.total}` : '';
    lines.push(`${icon} ${target.id.padEnd(9)} ${target.status.padEnd(9)} ${target.detail}${usage}`);
  }
  const unhealthy = report.targets.filter((item) => item.status !== 'ready' && item.status !== 'installed');
  lines.push(unhealthy.length ? `\n${unhealthy.length} 家需要处理` : '\n全部就绪');
  return lines.join('\n');
}
