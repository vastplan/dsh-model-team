/**
 * CLI harness 协议的核心测试（不需要真实 CLI）。
 *
 * 运行：node --test scripts/harness.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildLaunch, clearHarnesses, harnessFor, registerHarness, validateHarness,
} from '../src/harness/protocol.js';
import { registerBuiltinHarnesses, runHarness, cliCatalogEntries } from '../src/harness/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(HERE, 'fake-cli.mjs');

function freshRegistry() {
  clearHarnesses();
  registerBuiltinHarnesses();
}

test('pi 定义能拼出完整 argv', () => {
  freshRegistry();
  const plan = buildLaunch(
    harnessFor('pi'),
    { harnessModel: 'group/auto-kimi-k3', harnessProvider: 'magpie', reasoningEffort: 'max' },
    'PROMPT',
    { workspace: '/tmp/ws', tmpDir: '/tmp/mt' },
  );
  assert.deepEqual(plan.argv, [
    'pi', '--print', '--mode', 'json', '--no-session',
    '--provider', 'magpie',
    '--model', 'group/auto-kimi-k3',
    '--thinking', 'max',
    '--exclude-tools', 'edit,write',
    '--', 'PROMPT',
  ]);
  assert.equal(plan.cwd, '/tmp/ws');
});

test('opencode 把强度拼进 -m 的 #variant', () => {
  freshRegistry();
  const plan = buildLaunch(
    harnessFor('opencode'),
    { harnessModel: 'opencode/space-bunny-free', reasoningEffort: 'high' },
    'PROMPT',
    { workspace: '/tmp/ws', tmpDir: '/tmp/mt' },
  );
  assert.deepEqual(plan.argv, [
    'opencode', 'run', '--format', 'json', '--thinking', '--title', 'vastplan-model-team',
    '-m', 'opencode/space-bunny-free#high',
    'PROMPT',
  ]);
  assert.match(plan.env.OPENCODE_PERMISSION, /"edit":"deny"/);
});

test('定义校验会拒绝坏 id / 未知解析方言', () => {
  assert.throws(() => validateHarness({ id: 'Bad Id', command: 'x' }), /harness id/);
  assert.throws(() => validateHarness({ id: 'ok', command: 'x', output: { parser: 'nope' } }), /解析方言/);
  assert.throws(() => validateHarness({ id: 'ok', command: 'x', model: {} }), /model 需要 flag/);
});

test('runHarness：起进程、逐行进度、解析正文与用量', async () => {
  freshRegistry();
  const definition = validateHarness({
    id: 'fake',
    command: process.execPath,
    args: [FAKE_CLI],
    model: { flag: '--model', format: '{model}' },
    prompt: { via: 'argv' },
    output: { parser: 'auto' },
    usage: { aggregate: 'auto' },
  });
  registerHarness(definition, { replace: true });

  const phases = [];
  const result = await runHarness({
    ctx: { get: () => undefined },
    def: definition,
    entry: { harnessModel: 'fake/model' },
    prompt: 'hi',
    workspace: process.cwd(),
    tmpDir: '/tmp/model-team-test',
    onPhase: (name) => phases.push(name),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.text, /答案/);
  assert.match(result.text, /fake\/model/);
  assert.ok(result.usage.output > 0, 'usage 应被解析出来');
  assert.ok(phases.includes('thinking'));
  assert.ok(phases.includes('answering'));
});

test('runHarness：取消会终止子进程并报 AbortError', async () => {
  freshRegistry();
  const definition = validateHarness({
    id: 'fake-slow',
    command: process.execPath,
    args: [FAKE_CLI, '--sleep', '5000'],
    prompt: { via: 'argv' },
    output: { parser: 'auto' },
  });
  registerHarness(definition, { replace: true });

  const controller = new AbortController();
  const running = runHarness({
    ctx: { get: () => undefined },
    def: definition,
    entry: {},
    prompt: 'hi',
    workspace: process.cwd(),
    tmpDir: '/tmp/model-team-test',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, (error) => error.name === 'AbortError');
});

test('runHarness：非零退出带上 stderr', async () => {
  freshRegistry();
  const definition = validateHarness({
    id: 'fake-fail',
    command: process.execPath,
    args: [FAKE_CLI, '--fail'],
    prompt: { via: 'argv' },
    output: { parser: 'auto' },
  });
  registerHarness(definition, { replace: true });

  await assert.rejects(
    runHarness({
      ctx: { get: () => undefined },
      def: definition,
      entry: {},
      prompt: 'hi',
      workspace: process.cwd(),
      tmpDir: '/tmp/model-team-test',
    }),
    (error) => error.exitCode === 2 && /boom/.test(error.message),
  );
});

test('cliCatalogEntries 生成合成 provider 与 harness 字段', () => {
  freshRegistry();
  const entries = cliCatalogEntries({
    cliModels: [
      { id: 'k3', tool: 'pi', provider: 'magpie', model: 'group/auto-kimi-k3', modelKey: 'kimi-k3' },
      { id: 'missing', tool: 'nope', model: 'x' },
    ],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provider, 'cli-pi');
  assert.equal(entries[0].harnessModel, 'group/auto-kimi-k3');
  assert.equal(entries[0].transport, 'cli');
  assert.equal(entries[0].modelKey, 'kimi-k3');
});

test('runTeam 端到端：CLI 条目走协议、进结果行', async () => {
  freshRegistry();
  const fake = validateHarness({
    id: 'fake',
    command: process.execPath,
    args: [FAKE_CLI],
    model: { flag: '--model', format: '{model}' },
    prompt: { via: 'argv' },
    output: { parser: 'auto' },
    usage: { aggregate: 'auto' },
  });
  registerHarness(fake, { replace: true });

  const { runTeam } = await import('../index.js');
  const config = {
    toolName: 'model_team',
    models: [],
    cliModels: [{ id: 'test', tool: 'fake', model: 'fake/model' }],
  };
  const configStore = {
    table: (name) => ({
      get: () => (name === 'prefs' ? { persistData: false } : undefined),
      entries: () => [],
    }),
  };
  const ctx = {
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    },
    get: () => undefined,
    logger: { warn() {}, info() {} },
    on: () => () => {},
  };
  const control = new AbortController();
  const outcome = await runTeam(
    ctx,
    { append() {}, updateProgress() {} },
    { kind: 'audit', packet: 'hi', models: ['cli-fake/test@@max'], workspace: '/tmp', mode: 'llm' },
    config,
    configStore,
    control.signal,
    undefined,
  );

  assert.equal(outcome.models.length, 1);
  assert.equal(outcome.models[0].status, 'done');
  assert.equal(outcome.models[0].tool, 'fake');
  assert.match(outcome.models[0].text, /答案/);
});

test('runTeam：DSH 路径不受 CLI 重构影响', async () => {
  freshRegistry();
  const { runTeam } = await import('../index.js');
  const config = { toolName: 'model_team', models: ['p/m'], cliModels: [] };
  const configStore = {
    table: (name) => ({
      get: () => (name === 'prefs' ? { persistData: false } : undefined),
      entries: () => [],
    }),
  };
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'm', name: 'M' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [], defaultEffort: '' } }),
      stream: async function* () {
        yield { type: 'text-delta', text: 'dsh-ok' };
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    get: () => undefined,
    logger: { warn() {}, info() {} },
    on: () => () => {},
  };
  const outcome = await runTeam(
    ctx,
    { append() {}, updateProgress() {} },
    { kind: 'audit', packet: 'hi', mode: 'llm', workspace: '/tmp' },
    config,
    configStore,
    new AbortController().signal,
    undefined,
  );

  assert.equal(outcome.models.length, 1);
  assert.equal(outcome.models[0].status, 'done');
  assert.equal(outcome.models[0].tool, 'dsh-llm');
  assert.match(outcome.models[0].text, /dsh-ok/);
});
