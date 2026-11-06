/**
 * 一键测试的数据校验单测。
 *
 * 运行：node --test src/selftest.test.js
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openLedger } from './ledger.js';
import { localStamp, openRunDir, snapshotInput, writeSessionLog } from './sessionlog.js';
import { validateTestRun } from './selftest.js';

const GROUP = { groupId: 'g-test', name: 'Test Group', mode: 'llm' };
const CANDIDATE = { model: 'magpie/group/auto-kimi-k3', provider: 'magpie', reasoningEffort: 'high' };

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-selftest-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function openTempLedger(dir) {
  const ledger = await openLedger(join(dir, 'ledger.db'));
  assert.ok(ledger, '账本应能打开');
  return ledger;
}

/** 造一场「按正式链路落盘」的测试记录。 */
function recordRun(ledger, dir, {
  runId = 'selftest-0001', group = GROUP, candidate = CANDIDATE, mode = 'llm',
  status = 'done', text = 'OK-SELFTEST', writeLog = true,
} = {}) {
  const runDir = openRunDir(join(dir, 'runs'), runId);
  snapshotInput(runDir, 'packet.txt', 'SELFTEST');
  snapshotInput(runDir, 'prompt.md', 'prompt');
  const startedAt = Date.now() - 1000;
  const finishedAt = Date.now();
  const row = {
    model: candidate.model,
    provider: candidate.provider,
    name: 'Kimi K3',
    reasoningEffort: candidate.reasoningEffort,
    groupId: group.groupId,
    status,
    text,
    error: '',
    seconds: 1,
    usage: { input: 3, output: 4 },
    messages: [],
  };
  row.logPath = writeSessionLog(runDir, {
    model: row.model,
    provider: row.provider,
    reasoningEffort: row.reasoningEffort,
    tool: 'dsh-llm',
    status: row.status,
    error: '',
    text: row.text,
    messages: [],
    usage: row.usage,
    started: localStamp(new Date(startedAt)),
    finished: localStamp(new Date(finishedAt)),
    durationS: 1,
    groupId: row.groupId,
  });
  ledger.recordRun({
    runId, kind: 'test', mode, packetHash: 'abcd1234', startedAt, finishedAt,
  }, [row]);
  if (!writeLog) unlinkSync(row.logPath);
  return row;
}

test('validateTestRun：正式链路的落盘数据全部通过', async () => {
  await withTemp(async (dir) => {
    const ledger = await openTempLedger(dir);
    try {
      const runId = 'selftest-ok';
      recordRun(ledger, dir, { runId });
      const result = validateTestRun({ ledger, runId, group: GROUP, candidate: CANDIDATE, mode: 'llm' });
      assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok), null, 2));
      assert.ok(result.checks.every((c) => c.ok));
      assert.ok(result.checks.some((c) => c.id === 'log-fields'));
      assert.ok(result.checks.some((c) => c.id === 'metric-keys'));
    } finally {
      ledger.close();
    }
  });
});

test('validateTestRun：会话日志缺失会报失败并指出具体检查项', async () => {
  await withTemp(async (dir) => {
    const ledger = await openTempLedger(dir);
    try {
      const runId = 'selftest-missing-log';
      recordRun(ledger, dir, { runId, writeLog: false });
      const result = validateTestRun({ ledger, runId, group: GROUP, candidate: CANDIDATE, mode: 'llm' });
      assert.equal(result.ok, false);
      assert.equal(result.checks.find((c) => c.id === 'call-log-exists')?.ok, false);
    } finally {
      ledger.close();
    }
  });
});

test('validateTestRun：状态不是 done 时拒绝', async () => {
  await withTemp(async (dir) => {
    const ledger = await openTempLedger(dir);
    try {
      const runId = 'selftest-failed';
      recordRun(ledger, dir, { runId, status: 'failed', text: '' });
      const result = validateTestRun({ ledger, runId, group: GROUP, candidate: CANDIDATE, mode: 'llm' });
      assert.equal(result.ok, false);
      assert.equal(result.checks.find((c) => c.id === 'call-status')?.ok, false);
    } finally {
      ledger.close();
    }
  });
});

test('Ledger.aggregate：周报统计排除 kind=test 的测试场次', async () => {
  await withTemp(async (dir) => {
    const ledger = await openTempLedger(dir);
    try {
      recordRun(ledger, dir, { runId: 'selftest-aggregate' });
      // 再造一场正式审计；model 不同，便于确认只统计它。
      recordRun(ledger, dir, {
        runId: 'audit-aggregate',
        candidate: { model: 'magpie/group/auto-glm', provider: 'magpie', reasoningEffort: '' },
      });
      // recordRun 固定写 kind=test，这里手工改掉第二场，模拟真实审计行。
      ledger.db.prepare("UPDATE runs SET kind = 'audit' WHERE run_id = ?").run('audit-aggregate');
      const facts = ledger.aggregate(0, Date.now() + 1000);
      assert.equal(facts.runs, 1, '只应统计审计场次');
      assert.equal(facts.calls, 1, '测试场次的调用不应进入聚合');
      assert.equal(facts.kinds.test, undefined);
    } finally {
      ledger.close();
    }
  });
});

test('validateTestRun：缺少指标行会被发现', async () => {
  await withTemp(async (dir) => {
    const ledger = await openTempLedger(dir);
    try {
      const runId = 'selftest-no-metric';
      const row = recordRun(ledger, dir, { runId });
      ledger.db.prepare('DELETE FROM call_metric WHERE run_id = ? AND call_id = ? AND slot = ?')
        .run(runId, `magpie/group/auto-kimi-k3@@high`, GROUP.groupId);
      const result = validateTestRun({ ledger, runId, group: GROUP, candidate: CANDIDATE, mode: 'llm' });
      assert.equal(result.ok, false);
      assert.equal(result.checks.find((c) => c.id === 'metric-keys')?.ok, false);
      assert.ok(existsSync(row.logPath));
    } finally {
      ledger.close();
    }
  });
});
