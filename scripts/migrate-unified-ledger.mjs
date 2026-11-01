#!/usr/bin/env node
/**
 * 把旧版 DSH 插件账本（~/.dsh/model-team/ledger.db）合并到技能账本
 * （~/.model-team/ledger/model-audit-reviews.db），让两种入口共用一个 SQLite 文件。
 *
 * 设计约束：
 * - 默认 dry-run，只有 `--write` 才落盘；
 * - 写入前用 SQLite `.backup` 备份源库和目标库，并保留时间戳；
 * - 只复制插件表（runs/calls/call_metric/reports），不碰技能表；
 * - INSERT OR IGNORE：重复执行幂等，不覆盖目标已有行；
 * - 源库/目标库都通过 SQLite backup 快照读取，避免 WAL 下直接 cp 丢数据。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { openLedger } from '../src/ledger.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--write') args.set('write', '1');
  else if (arg.startsWith('--')) args.set(arg.slice(2), process.argv[++i] ?? '');
}
const write = args.has('write');
const home = homedir();
const source = args.get('source') || join(home, '.dsh', 'model-team', 'ledger.db');
const target = args.get('target') || join(home, '.model-team', 'ledger', 'model-audit-reviews.db');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const work = mkdtempSync(join(tmpdir(), 'model-team-ledger-migrate-'));

const TABLES = {
  runs: ['run_id', 'kind', 'mode', 'packet_hash', 'started_at', 'finished_at', 'total', 'answered'],
  calls: ['run_id', 'call_id', 'slot', 'model', 'provider', 'name', 'effort', 'tool', 'status', 'excerpt', 'error', 'seconds', 'log_path', 'finished_at'],
  call_metric: ['run_id', 'call_id', 'slot', 'metric', 'value'],
  reports: ['report_id', 'from_ts', 'to_ts', 'summary_model', 'summary', 'facts', 'created_at'],
};

function backup(dbPath, label) {
  const out = join(work, `${label}-${basename(dbPath)}-${stamp}.db`);
  execFileSync('sqlite3', [dbPath, `.backup '${out.replace(/'/g, "''")}'`], { stdio: 'pipe' });
  return out;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function counts(db, tables) {
  const out = {};
  for (const table of tables) {
    out[table] = tableExists(db, table)
      ? Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n)
      : 0;
  }
  return out;
}

function copyRows(sourceDb, targetDb, table) {
  if (!tableExists(sourceDb, table)) return 0;
  if (!tableExists(targetDb, table)) throw new Error(`目标库缺少表 ${table}`);
  const columns = TABLES[table];
  const rows = sourceDb.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).all();
  const insert = targetDb.prepare(
    `INSERT OR IGNORE INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) ` +
    `VALUES (${columns.map(() => '?').join(', ')})`,
  );
  let copied = 0;
  for (const row of rows) {
    const info = insert.run(...columns.map((column) => row[column]));
    copied += Number(info.changes) || 0;
  }
  return copied;
}

if (!existsSync(source)) {
  console.error(`源插件账本不存在：${source}`);
  process.exit(1);
}
if (!existsSync(target)) {
  console.error(`技能账本不存在：${target}（保持回退模式，不改动旧插件账本）`);
  process.exit(2);
}

mkdirSync(work, { recursive: true });
try {
  const sourceSnapshot = backup(source, 'source');
  const targetSnapshot = backup(target, 'target');
  const sourceDb = new DatabaseSync(sourceSnapshot, { readOnly: true });
  const targetDb = new DatabaseSync(targetSnapshot, { readOnly: true });
  const before = {
    source: counts(sourceDb, Object.keys(TABLES)),
    target: counts(targetDb, Object.keys(TABLES)),
    targetUserVersion: Number(targetDb.prepare('PRAGMA user_version').get().user_version),
  };
  sourceDb.close();
  targetDb.close();
  console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', source, target, before }, null, 2));
  if (!write) {
    console.log('dry-run：未修改任何文件；加 --write 执行迁移。');
    process.exit(0);
  }

  const sourceBak = join(dirname(source), `${basename(source)}.bak-${stamp}`);
  const targetBak = join(dirname(target), `${basename(target)}.bak-${stamp}`);
  execFileSync('sqlite3', [source, `.backup '${sourceBak.replace(/'/g, "''")}'`], { stdio: 'pipe' });
  execFileSync('sqlite3', [target, `.backup '${targetBak.replace(/'/g, "''")}'`], { stdio: 'pipe' });
  console.log(`已备份源库：${sourceBak}`);
  console.log(`已备份目标库：${targetBak}`);

  // 先在目标库上创建插件表（openLedger 是幂等的），再复制数据。
  const handle = await openLedger(target, console);
  if (handle === null) throw new Error(`无法打开目标账本：${target}`);
  handle.close();
  const writable = new DatabaseSync(target);
  const sourceRead = new DatabaseSync(sourceBak, { readOnly: true });
  const copied = {};
  try {
    writable.exec('BEGIN IMMEDIATE');
    for (const table of Object.keys(TABLES)) copied[table] = copyRows(sourceRead, writable, table);
    writable.exec('COMMIT');
    const integrity = writable.prepare('PRAGMA integrity_check').get();
    const after = counts(writable, Object.keys(TABLES));
    console.log(JSON.stringify({ copied, after, integrity: integrity.integrity_check }, null, 2));
    if (integrity.integrity_check !== 'ok') throw new Error(`目标库 integrity_check 失败：${integrity.integrity_check}`);
  } catch (error) {
    try { writable.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  } finally {
    sourceRead.close();
    writable.close();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
