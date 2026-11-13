/**
 * CLI 侧单测：参数解析、提示词拼装、周窗口、名单校验、findings/outcome 往返。
 *
 * 运行：node --test src/cli.test.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { flagOf, hasFlag, listFlag, parseArgs } from './cli/args.js';
import { buildCliPrompt, readPacket } from './cli/run.js';
import { modelsCheck } from './cli/models.js';
import { weekWindow } from './cli/commands.js';
import { recordFindings, recordOutcome, recomputeSummary, summaryReport } from './cli/ledger-commands.js';

/** 旧 skill 的三张表（字段与真实库一致，便于离线验证）。 */
const DDL = [
  `CREATE TABLE review_session (
     场次ID TEXT NOT NULL, 日期 TEXT, 切片 TEXT, 场次类型 TEXT, 对照提交 TEXT, 模型 TEXT NOT NULL,
     条目ID TEXT, 调用工具 TEXT, 模型参数 TEXT, 思考强度 TEXT, 调用链 TEXT, 开始时间 TEXT, 完成时间 TEXT,
     金额来源 TEXT, token采集 TEXT, 退出码 TEXT, 质量评估 TEXT, 用户选择 TEXT, 选用匹配 TEXT,
     ord INTEGER NOT NULL, PRIMARY KEY (场次ID, 模型)) WITHOUT ROWID`,
  `CREATE TABLE finding (
     场次ID TEXT NOT NULL, 模型 TEXT NOT NULL, 问题标题 TEXT NOT NULL, 模型声称 TEXT, 重要性 TEXT,
     对照代码判定 TEXT, 是否独有 TEXT, 处理 TEXT, 说明 TEXT, dup_seq INTEGER NOT NULL,
     ord INTEGER NOT NULL, PRIMARY KEY (场次ID, 模型, 问题标题, dup_seq)) WITHOUT ROWID`,
  `CREATE TABLE session_summary (
     场次ID TEXT NOT NULL, 场次类型 TEXT, 模型 TEXT NOT NULL, 调用工具 TEXT, 思考强度 TEXT, 调用链 TEXT,
     耗时秒 REAL, 开始时间 TEXT, 完成时间 TEXT, 输入token REAL, 输出token REAL, 缓存读token REAL,
     缓存写token REAL, 推理token REAL, 输入金额USD REAL, 输出金额USD REAL, 缓存读金额USD REAL,
     缓存写金额USD REAL, 金额合计USD REAL, 质量评估 TEXT, 声称缺陷 REAL, 成立缺陷 REAL, 假阳性 REAL,
     独有成立 REAL, 成立缺陷重要性合计 REAL, 最高成立分 REAL, 重要性5 REAL, 重要性4 REAL,
     重要性3 REAL, 重要性2 REAL, 重要性1 REAL, 用户选择 TEXT, 契合分 REAL, 满意度 REAL,
     选用匹配 TEXT, 质量分 REAL, 效率分 REAL, ord INTEGER NOT NULL,
     PRIMARY KEY (场次ID, 模型)) WITHOUT ROWID`,
];

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-cli-'));
  const path = join(dir, 'ledger.db');
  const db = new DatabaseSync(path);
  for (const sql of DDL) db.exec(sql);
  db.exec(`INSERT INTO review_session (场次ID, 日期, 切片, 场次类型, 模型, 条目ID, 调用工具, 思考强度, ord)
           VALUES ('run-1', '2026-11-13', 'slice-a', '事后审计', 'Claude Sonnet 5.5', 'cli-claude/claude-sonnet-5-5', 'claude', 'high', 0)`);
  db.close();
  return Promise.resolve(fn(path)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('parseArgs：--key value / --key=value / 布尔 / 重复', () => {
  const parsed = parseArgs(['run', '--kind', 'audit', '--packet=/tmp/p.md', '--quiet', '--models', 'a,b', '--models', 'c']);
  assert.equal(parsed.command, 'run');
  assert.equal(flagOf(parsed, '--kind'), 'audit');
  assert.equal(flagOf(parsed, '--packet'), '/tmp/p.md');
  assert.equal(hasFlag(parsed, '--quiet'), true);
  assert.deepEqual(listFlag(parsed, '--models'), ['a', 'b', 'c']);
});

test('buildCliPrompt：开场白 + 包体 + 文件清单', () => {
  const text = buildCliPrompt('design', 'PACKET', ['a.js', 'b.js']);
  assert.match(text, /设计分叉/);
  assert.match(text, /PACKET/);
  assert.match(text, /- a\.js/);
});

test('readPacket：文件与不存在路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-packet-'));
  try {
    const file = join(dir, 'p.md');
    writeFileSync(file, 'HELLO', 'utf8');
    assert.equal(readPacket(file), 'HELLO');
    assert.throws(() => readPacket(join(dir, 'nope.md')), /不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('weekWindow：2026-W46 是周一到下周一', () => {
  const start = new Date(weekWindow('2026-W46').start);
  const end = new Date(weekWindow('2026-W46').end);
  assert.equal(start.getDay(), 1, '应从周一开始');
  assert.equal(Math.round((end - start) / 86400000), 7);
});

test('modelsCheck：缺的会列出来', () => {
  const rows = modelsCheck(
    [{ provider: 'cli-x', id: 'ok' }],
    ['cli-x/ok', 'cli-x/missing'],
  );
  assert.deepEqual(rows.map((row) => row.ok), [true, false]);
});

test('recordFindings → recomputeSummary：声称/成立/假阳性/独有', async () => {
  await withDb(async (dbPath) => {
    const result = recordFindings({
      runId: 'run-1',
      dbPath,
      write: true,
      payload: [
        { model: 'Claude Sonnet 5.5', title: 'A', claimed: '缺陷', severity: 4, verdict: '成立' },
        { model: 'Claude Sonnet 5.5', title: 'B', claimed: '缺陷', severity: 2, verdict: '不成立' },
      ],
    });
    assert.equal(result.count, 2);
    const db = new DatabaseSync(dbPath);
    const summary = db.prepare('SELECT * FROM session_summary WHERE 场次ID = ?').get('run-1');
    assert.equal(summary['声称缺陷'], 2);
    assert.equal(summary['成立缺陷'], 1);
    assert.equal(summary['假阳性'], 1);
    assert.equal(summary['独有成立'], 1);
    assert.equal(summary['最高成立分'], 4);
    assert.equal(summary['质量评估'], '已评');
    db.close();
  });
});

test('recordFindings：model 不在本场名单里要报错', async () => {
  await withDb(async (dbPath) => {
    assert.throws(() => recordFindings({
      runId: 'run-1',
      dbPath,
      write: false,
      payload: [{ model: '别的模型', title: 'A', claimed: '缺陷', severity: 3, verdict: '成立' }],
    }), /不在本场/);
  });
});

test('recordOutcome：写出契合分并重算', async () => {
  await withDb(async (dbPath) => {
    const result = recordOutcome({
      runId: 'run-1',
      dbPath,
      write: true,
      payload: [{ model: 'Claude Sonnet 5.5', fit: 4, satisfaction: 5, match: '是' }],
    });
    assert.equal(result.count, 1);
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT 契合分, 满意度, 选用匹配 FROM session_summary WHERE 场次ID = ?').get('run-1');
    assert.deepEqual({ ...row }, { 契合分: 4, 满意度: 5, 选用匹配: '是' });
    db.close();
  });
});

test('summaryReport：按模型汇总', async () => {
  await withDb(async (dbPath) => {
    recordFindings({
      runId: 'run-1',
      dbPath,
      write: true,
      payload: [{ model: 'Claude Sonnet 5.5', title: 'A', claimed: '缺陷', severity: 5, verdict: '成立' }],
    });
    const report = summaryReport({ dbPath, kind: '事后审计' });
    assert.equal(report.sessions, 1);
    assert.equal(report.models[0].model, 'Claude Sonnet 5.5');
    assert.equal(report.models[0].confirmed, 1);
    assert.equal(report.models[0].severity, 5);
  });
});

test('planFromDsh：按绑定取组，保持组内候选顺序', async () => {
  const { planFromDsh } = await import('./cli/dsh-config.js');
  const config = {
    groups: [
      { groupId: 'g1', name: 'A', enabled: true, order: 1, candidates: [
        { model: 'cli-claude/claude-opus-5-5', reasoningEffort: 'xhigh' },
        { model: 'cli-devin/claude-opus-5-5', reasoningEffort: 'xhigh' },
      ] },
      { groupId: 'g2', name: 'B', enabled: true, order: 0, candidates: [
        { model: 'magpie-anthropic/zcode/GLM-5.3-Flash', reasoningEffort: 'max' },
        { model: 'cli-devin/swe-2', reasoningEffort: 'max' },
      ] },
      { groupId: 'g3', name: 'C', enabled: false, order: 2, candidates: [{ model: 'cli-grok/grok-4-7' }] },
    ],
    bindings: { audit: ['g1', 'g2'] },
    prefs: {},
  };
  const catalog = [
    { provider: 'cli-claude', id: 'claude-opus-5-5' },
    { provider: 'cli-devin', id: 'claude-opus-5-5' },
    { provider: 'cli-devin', id: 'swe-2' },
    { provider: 'cli-grok', id: 'grok-4-7' },
  ];
  const { groups, skipped } = planFromDsh(config, 'audit', catalog);
  assert.deepEqual(groups.map((group) => group.groupId), ['g1', 'g2'], '按绑定顺序，且跳过停用组');
  assert.deepEqual(groups[0].candidates, ['cli-claude/claude-opus-5-5@@xhigh', 'cli-devin/claude-opus-5-5@@xhigh']);
  assert.deepEqual(groups[1].candidates, ['cli-devin/swe-2@@max'], 'DSH 原生路由要被跳过');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /CLI 目录/);
});

test('planFromDsh：没有绑定时退回全部启用组', async () => {
  const { planFromDsh } = await import('./cli/dsh-config.js');
  const config = {
    groups: [
      { groupId: 'g1', name: 'A', enabled: true, order: 0, candidates: [{ model: 'cli-grok/grok-4-7' }] },
      { groupId: 'g3', name: 'C', enabled: false, order: 2, candidates: [{ model: 'cli-claude/claude-sonnet-5-5' }] },
    ],
    bindings: {},
    prefs: {},
  };
  const catalog = [{ provider: 'cli-grok', id: 'grok-4-7' }, { provider: 'cli-claude', id: 'claude-sonnet-5-5' }];
  const { groups } = planFromDsh(config, 'design', catalog);
  assert.deepEqual(groups.map((group) => group.groupId), ['g1']);
});
