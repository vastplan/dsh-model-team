/**
 * 一键测试的全流程集成测试：runTeam → 会话日志 → 账本 → 数据校验。
 *
 * 用假 DSH provider，不需要真实模型。
 * 运行：node --test src/selftest.integration.test.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openLedger } from './ledger.js';
import { runGroupSelfTest, runTeam } from '../index.js';

function fakeContext({
  models = [{ id: 'group/auto-kimi-k3', name: 'Kimi K3' }],
  calls = [],
} = {}) {
  return {
    llm: {
      listProviders: () => [{ id: 'magpie', name: 'Magpie' }],
      listModels: async () => models,
      resolveModelInfo: async () => ({ reasoning: { efforts: ['high'], defaultEffort: 'high' } }),
      stream: async function* ({ model }) {
        calls.push(model);
        yield { type: 'thinking-delta', text: '' };
        yield { type: 'text-delta', text: 'OK-SELFTEST' };
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    get: () => undefined,
    on: () => () => {},
    logger: { warn() {}, info() {} },
  };
}

function fakeStore(groups, prefs = { persistData: true }) {
  return {
    table(name) {
      return {
        get: (key) => {
          if (name === 'prefs') return prefs;
          if (name === 'groups') return groups.find((group) => group.groupId === key);
          return undefined;
        },
        entries: () => {
          if (name === 'groups') return groups.map((group) => [group.groupId, group]);
          return [];
        },
      };
    },
  };
}

test('runGroupSelfTest：假 provider 走完整链路并全部校验通过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-integration-'));
  const ledger = await openLedger(join(dir, 'ledger.db'));
  try {
    assert.ok(ledger);
    const group = {
      groupId: 'g-kimi',
      name: 'Kimi K3',
      candidates: [{ model: 'magpie/group/auto-kimi-k3', reasoningEffort: 'high' }],
      enabled: true,
      order: 0,
      mode: 'llm',
    };
    const config = {
      toolName: 'model_team',
      models: [],
      cliModels: [],
      discoverCli: false,
      runsRoot: join(dir, 'runs'),
    };
    const result = await runGroupSelfTest(fakeContext(), ledger, fakeStore([group]), config, group);

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.mode, 'llm');
    assert.equal(result.results.length, 1);
    const first = result.results[0];
    assert.equal(first.status, 'done');
    assert.ok(first.checks.length >= 15, `校验项太少：${first.checks.length}`);
    assert.deepEqual(first.checks.filter((check) => !check.ok), []);

    // 账本里必须留下 kind=test 的场次，且周报统计排除它。
    const run = ledger.runById(first.runId);
    assert.equal(run.kind, 'test');
    assert.equal(run.total, 1);
    assert.equal(run.answered, 1);
    const facts = ledger.aggregate(0, Date.now() + 1000);
    assert.equal(facts.runs, 0, '测试场次不应进入周报统计');
    assert.equal(facts.calls, 0, '测试调用不应进入周报统计');
  } finally {
    ledger?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTeam：组级 mode=llm 覆盖全局 mode=subagent，且不要求 subagents 服务', async () => {
  const group = {
    groupId: 'g-override-2',
    name: 'Override llm',
    candidates: [{ model: 'magpie/group/auto-kimi-k3', reasoningEffort: '' }],
    enabled: true,
    order: 0,
    mode: 'llm',
  };
  const config = { toolName: 'model_team', models: [], cliModels: [], runsRoot: '' };
  const outcome = await runTeam(
    fakeContext(),
    { append() {}, updateProgress() {} },
    { kind: 'audit', packet: 'hi', mode: 'subagent', workspace: '/tmp' },
    config,
    fakeStore([group], { persistData: false }),
    new AbortController().signal,
    undefined,
  );
  assert.equal(outcome.mode, 'llm');
  assert.equal(outcome.models[0].status, 'done');
  assert.equal(outcome.models[0].tool, 'dsh-llm');
});

test('runTeam：正常执行只跑主力，主力成功时备选不启动', async () => {
  const calls = [];
  const group = {
    groupId: 'g-fallback',
    name: 'Fallback group',
    candidates: [
      { model: 'magpie/m1', reasoningEffort: '' },
      { model: 'magpie/m2', reasoningEffort: '' },
    ],
    enabled: true,
    order: 0,
    mode: 'llm',
  };
  const config = { toolName: 'model_team', models: [], cliModels: [], runsRoot: '' };
  const outcome = await runTeam(
    fakeContext({ models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }], calls }),
    { append() {}, updateProgress() {} },
    { kind: 'audit', packet: 'hi', mode: 'llm', workspace: '/tmp' },
    config,
    fakeStore([group], { persistData: false }),
    new AbortController().signal,
    undefined,
  );
  assert.deepEqual(calls, ['m1'], '主力成功后不应调用备选');
  assert.equal(outcome.models.length, 1);
  assert.deepEqual(outcome.models[0].tried, ['m1@@default:done']);
});

test('runGroupSelfTest：一键测试逐条调用组内所有候选', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-integration-all-'));
  const ledger = await openLedger(join(dir, 'ledger.db'));
  try {
    const calls = [];
    const group = {
      groupId: 'g-all-candidates',
      name: 'All candidates',
      candidates: [
        { model: 'magpie/m1', reasoningEffort: '' },
        { model: 'magpie/m2', reasoningEffort: '' },
      ],
      enabled: true,
      order: 0,
      mode: 'llm',
    };
    const config = { models: [], cliModels: [], runsRoot: join(dir, 'runs') };
    const result = await runGroupSelfTest(
      fakeContext({ models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }], calls }),
      ledger,
      fakeStore([group]),
      config,
      group,
    );
    assert.deepEqual(calls, ['m1', 'm2'], '一键测试必须逐条覆盖所有候选');
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.results.length, 2);
  } finally {
    ledger?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTeam：组级 mode=subagent 且宿主没有 subagents 服务时响亮报错', async () => {
  const group = {
    groupId: 'g-sub',
    name: 'Sub group',
    candidates: [{ model: 'magpie/group/auto-kimi-k3', reasoningEffort: '' }],
    enabled: true,
    order: 0,
    mode: 'subagent',
  };
  const config = { toolName: 'model_team', models: [], cliModels: [], runsRoot: '' };
  await assert.rejects(
    () => runTeam(
      fakeContext(),
      { append() {}, updateProgress() {} },
      { kind: 'audit', packet: 'hi', mode: 'llm', workspace: '/tmp' },
      config,
      fakeStore([group], { persistData: false }),
      new AbortController().signal,
      undefined,
    ),
    /subagents 服务/,
  );
});

