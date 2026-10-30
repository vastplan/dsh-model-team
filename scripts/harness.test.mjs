/**
 * CLI harness 协议的核心测试（不需要真实 CLI）。
 *
 * 运行：node --test scripts/harness.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';


import {
  buildLaunch, clearHarnesses, cliCatalogEntries, harnessFor, listHarnesses,
  registerBuiltinHarnesses, registerHarness, runHarness, validateHarness,
} from '../src/harness/index.js';
import { clearAvailabilityCache, harnessAvailable } from '../src/harness/availability.js';
import { discoverHarness, logicalKeyOf, normalizeModels, parseDiscovery } from '../src/harness/discover.js';
import { parseOutput } from '../src/harness/parse.js';
import { DEFAULT_PREFS, readPrefs } from '../src/groups.js';

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

test('cliCatalogEntries 生成合成 provider 与 harness 字段', async () => {
  freshRegistry();
  const entries = await cliCatalogEntries({
    cliModels: [
      { id: 'k3', tool: 'pi', provider: 'magpie', model: 'group/auto-kimi-k3', modelKey: 'kimi-k3' },
      { id: 'missing', tool: 'nope', model: 'x' },
    ],
  }, undefined, { available: () => true, discover: false });
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
    discoverCli: false,
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
  const config = { toolName: 'model_team', models: ['p/m'], cliModels: [], discoverCli: false };
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

test('runTeam：可用范围关掉 dsh 后，点名 DSH 模型直接拒绝', async () => {
  freshRegistry();
  const { runTeam } = await import('../index.js');
  const config = { toolName: 'model_team', models: ['p/m'], cliModels: [], discoverCli: false };
  const configStore = {
    table: (name) => ({
      // 只开 grok：dsh 与其它 CLI 都在范围外。
      get: () => (name === 'prefs' ? { persistData: false, enabledHarnesses: ['grok'] } : undefined),
      entries: () => [],
    }),
  };
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'm', name: 'M' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [], defaultEffort: '' } }),
      stream: async function* () { yield { type: 'text-delta', text: 'should-not-run' }; },
    },
    get: () => undefined,
    logger: { warn() {}, info() {} },
    on: () => () => {},
  };
  await assert.rejects(
    () => runTeam(
      ctx,
      { append() {}, updateProgress() {} },
      { kind: 'reason', packet: 'hi', mode: 'llm', workspace: '/tmp', models: ['p/m'] },
      config,
      configStore,
      new AbortController().signal,
      undefined,
    ),
    /可用 CLI 范围里没有可调用的模型/,
  );
});

test('内置 9 家 harness 全部注册', () => {
  freshRegistry();
  assert.deepEqual(
    listHarnesses().map((item) => item.id),
    ['agent', 'claude', 'cline', 'devin', 'grok', 'opencode', 'pi', 'qoder', 'zcode'],
  );
});

test('agent / cline / grok / qoder / devin 的 argv 对齐原型', () => {
  freshRegistry();
  const argvOf = (id, entry) => buildLaunch(
    harnessFor(id), entry, 'PROMPT', { workspace: '/ws', tmpDir: '/tmp/mt' },
  ).argv;

  assert.deepEqual(argvOf('agent', { harnessModel: 'gemini-3.8-flash-high' }), [
    'agent', '--print', '--output-format', 'stream-json', '--mode', 'ask', '--trust',
    '--workspace', '/ws', '--model', 'gemini-3.8-flash-high', 'PROMPT',
  ]);

  assert.deepEqual(argvOf('cline', { harnessModel: 'cline-free/muse', harnessProvider: 'cline' }), [
    'cline', '--json', '-c', '/ws', '-p', '-P', 'cline', '-m', 'cline-free/muse',
    '--thinking', 'xhigh', 'PROMPT',
  ]);

  assert.deepEqual(argvOf('grok', { harnessModel: 'grok-4.7', reasoningEffort: 'xhigh' }), [
    'grok', '-p', 'PROMPT', '--output-format', 'streaming-json',
    '--model', 'grok-4.7', '--reasoning-effort', 'xhigh',
    '--disallowed-tools', 'write,search_replace',
  ]);

  assert.deepEqual(argvOf('qoder', { harnessModel: 'Qwen3.8-Flash' }), [
    'qoderclicn', '-p', '--output-format', 'stream-json', '--no-session-persistence',
    '-m', 'Qwen3.8-Flash', '--reasoning-effort', 'max',
    '--disallowed-tools', 'Write,Edit', '--', 'PROMPT',
  ]);

  const devin = argvOf('devin', { harnessModel: 'swe-2' });
  assert.equal(devin[0], process.execPath);
  assert.match(devin[1], /scripts\/devin_acp\.mjs$/);
  assert.deepEqual(devin.slice(2), ['--model', 'swe-2', '--mode', 'ask', '--', 'PROMPT']);

  const tuned = argvOf('devin', { harnessModel: 'claude-opus-5-5', reasoningEffort: 'high', speed: 'fast' });
  assert.deepEqual(tuned.slice(2), ['--model', 'claude-opus-5-5-high-fast', '--mode', 'ask', '--', 'PROMPT']);
});

test('zcode hook：写临时 config 并改 HOME', (t) => {
  freshRegistry();
  const definition = harnessFor('zcode');
  if (!existsSync(definition.command)) {
    t.skip(`本机没有 ${definition.command}`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), 'mt-zcode-home-'));
  const tmp = mkdtempSync(join(tmpdir(), 'mt-zcode-tmp-'));
  const configDir = join(home, '.zcode', 'cli');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    model: {},
    provider: { 'builtin:bigmodel-coding-plan': { models: { 'GLM-5.3': { reasoning: {} } } } },
  }));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const plan = buildLaunch(
      definition,
      { harnessModel: 'GLM-5.3', reasoningEffort: 'max' },
      'PROMPT',
      { workspace: '/ws', tmpDir: tmp },
    );
    assert.equal(plan.argv[0], process.execPath);
    assert.equal(plan.argv[1], definition.command);
    assert.deepEqual(plan.argv.slice(2), [
      '--prompt', 'PROMPT', '--cwd', '/ws', '--mode', 'plan',
      '--disallowed-tools', 'Bash Edit Write',
    ]);
    assert.match(plan.env.HOME, /zcode-home-/);
    assert.equal(typeof plan.prepare, 'function');
    plan.prepare();
    const written = JSON.parse(readFileSync(join(plan.env.HOME, '.zcode', 'cli', 'config.json'), 'utf8'));
    assert.equal(written.model.main, 'builtin:bigmodel-coding-plan/GLM-5.3');
    assert.equal(
      written.provider['builtin:bigmodel-coding-plan'].models['GLM-5.3'].reasoning.defaultVariant,
      'max',
    );
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('harnessAvailable：缺 CLI 判为不可用，node 判为可用', () => {
  clearAvailabilityCache();
  const missing = validateHarness({ id: 'missing-xyz', command: 'definitely-not-a-real-cli-xyz' });
  assert.equal(harnessAvailable(missing), false);
  const node = validateHarness({ id: 'node-ok', command: process.execPath });
  assert.equal(harnessAvailable(node), true);
});

test('cliCatalogEntries：不可用的 CLI 不进入厂商目录', async () => {
  freshRegistry();
  const config = { cliModels: [{ id: 'k3', tool: 'pi', model: 'auto/kimi-k3' }] };
  assert.equal((await cliCatalogEntries(config, null, { available: () => false, discover: false })).length, 0);
  assert.equal((await cliCatalogEntries(config, null, { available: () => true, discover: false })).length, 1);
});

test('claude argv：-p + stream-json + plan/restricted 只读', () => {
  freshRegistry();
  const argv = buildLaunch(
    harnessFor('claude'),
    { harnessModel: 'sonnet', reasoningEffort: 'high' },
    'PROMPT',
    { workspace: '/ws', tmpDir: '/tmp' },
  ).argv;
  assert.deepEqual(argv, [
    'claude', '-p', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--no-session-persistence',
    '--permission-mode', 'plan', '--restricted', '--permission-prompts', 'none',
    '--model', 'sonnet', '--effort', 'high',
    '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit', '--', 'PROMPT',
  ]);
});

test('Claude stream-json：assistant/result 正文与用量', () => {
  const raw = [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Hello',
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  ].join('\n');
  const out = parseOutput(raw, 'take-last');
  assert.equal(out.text, 'Hello');
  assert.equal(out.usage.input, 10);
  assert.equal(out.usage.output, 2);
});

test('Claude 模型发现：带版本号的最新模型', async (t) => {
  freshRegistry();
  if (!harnessAvailable(harnessFor('claude'))) {
    t.skip('本机没有 claude');
    return;
  }
  const models = await discoverHarness(harnessFor('claude'));
  const sonnet = models.find((item) => item.modelKey === 'claude-sonnet-5-5');
  assert.ok(sonnet);
  assert.match(sonnet.name, /5\.5/);
  assert.ok(models.some((item) => item.modelKey === 'claude-opus-5-5'));
});

test('逻辑模型键与路由去重', () => {
  assert.equal(logicalKeyOf('magpie/auto/GLM-5.3'), 'glm-5-3');
  assert.equal(logicalKeyOf('group/auto-kimi-k3'), 'kimi-k3');
  assert.equal(logicalKeyOf('grok/grok-4.7@500k'), 'grok-4-7@500k');
  const models = normalizeModels([
    { id: 'devin/glm-5-3', name: 'GLM Devin' },
    { id: 'auto/GLM-5.3', name: 'GLM Auto' },
    { id: 'zcode/GLM-5.3', name: 'GLM ZCode' },
  ]);
  assert.equal(models.length, 1);
  assert.equal(models[0].harnessModel, 'auto/GLM-5.3');
});

test('discover 解析器', () => {
  assert.deepEqual(
    parseDiscovery('id-dash-name', 'auto - Auto (default)\nclaude-opus-5-5-high - Claude Opus 5.5 High').map((item) => item.id),
    ['auto', 'claude-opus-5-5-high'],
  );
  assert.deepEqual(
    parseDiscovery('bullet', '  - grok-4.7\n  - grok-4.6').map((item) => item.id),
    ['grok-4.7', 'grok-4.6'],
  );
  assert.deepEqual(
    parseDiscovery('devin-table', '  swe-2-high   SWE-2 High  [262K context, Free]\n  aliases: swe\n').map((item) => item.id),
    ['swe-2-high'],
  );
  assert.deepEqual(
    parseDiscovery('qoder-table', 'MODEL\nAuto\nQwen3.8-Max').map((item) => item.id),
    ['Auto', 'Qwen3.8-Max'],
  );
});

test('Devin JSON：family 与 thinking/speed 分开', () => {
  const raw = JSON.stringify({
    families: [{
      family_label: 'SWE-2',
      slug: 'swe-2',
      family_uid: 'swe-2',
      variants: [
        { model_uid: 'swe-2-high', label: 'SWE-2 High' },
        { model_uid: 'swe-2-max', label: 'SWE-2 Max' },
        { model_uid: 'swe-2-max-lightning', label: 'SWE-2 Max Lightning' },
      ],
    }],
  });
  const parsed = parseDiscovery('devin-json', raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].modelKey, 'swe-2');
  assert.equal(parsed[0].harnessModel, 'swe-2');
  assert.deepEqual(parsed[0].efforts, ['', 'high', 'max']);
  assert.deepEqual(parsed[0].speeds, ['', 'lightning']);

  const opus = parseDiscovery('devin-json', JSON.stringify({
    families: [{
      family_label: 'Claude Opus 5.5',
      slug: 'claude-opus-5.5',
      family_uid: 'claude-opus-5-5',
      variants: [{ model_uid: 'claude-opus-5-5-high-fast', label: 'Claude Opus 5.5 High Fast' }],
    }],
  }))[0];
  assert.equal(opus.modelKey, 'claude-opus-5-5');
  assert.equal(opus.harnessModel, 'claude-opus-5-5');
  assert.deepEqual(opus.efforts, ['', 'high']);
  assert.deepEqual(opus.speeds, ['', 'fast']);
  assert.equal(opus.name, 'Claude Opus 5.5');
});

test('cliCatalogEntries：Devin family 条目带 efforts/speeds', async () => {
  freshRegistry();
  const entries = await cliCatalogEntries({ cliModels: [] }, undefined, {
    available: () => true,
    discover: false,
    discovered: [{
      harness: 'devin', id: 'swe-2', name: 'SWE-2', modelKey: 'swe-2', harnessModel: 'swe-2',
      efforts: ['', 'high', 'max'], speeds: ['', 'lightning'], defaultEffort: 'max', defaultSpeed: '',
    }],
  });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].efforts, ['', 'high', 'max']);
  assert.deepEqual(entries[0].speeds, ['', 'lightning']);
  assert.equal(entries[0].defaultEffort, 'max');
});

test('cliCatalogEntries：自动发现条目 + 显式覆盖', async () => {
  freshRegistry();
  const auto = await cliCatalogEntries({ cliModels: [] }, undefined, {
    available: () => true,
    discover: false,
    discovered: [{ harness: 'pi', id: 'glm-5-3', name: 'GLM-5.3', provider: 'magpie', modelKey: 'glm-5-3', harnessModel: 'auto/GLM-5.3' }],
  });
  assert.equal(auto.length, 1);
  assert.equal(auto[0].provider, 'cli-pi');
  assert.equal(auto[0].harnessModel, 'auto/GLM-5.3');

  const overridden = await cliCatalogEntries({
    cliModels: [{ id: 'k3', tool: 'pi', model: 'auto/kimi-k3', modelKey: 'kimi-k3' }],
  }, undefined, {
    available: () => true,
    discover: false,
    discovered: [{ harness: 'pi', id: 'kimi-k3', name: 'Kimi K3', provider: 'magpie', modelKey: 'kimi-k3', harnessModel: 'auto/kimi-k3' }],
  });
  assert.equal(overridden.length, 1);
  assert.equal(overridden[0].id, 'k3');
});

test('prefs.enabledHarnesses：null/缺失 = 全开，数组 = 显式范围', () => {
  assert.equal(DEFAULT_PREFS.enabledHarnesses, null);
  assert.equal(readPrefs({ table: () => ({ get: () => ({}) }) }).enabledHarnesses, null);
  assert.deepEqual(
    readPrefs({ table: () => ({ get: () => ({ enabledHarnesses: ['dsh', 'pi', 'pi', ' '] }) }) }).enabledHarnesses,
    ['dsh', 'pi'],
  );
  assert.equal(readPrefs({ table: () => ({ get: () => ({ enabledHarnesses: null }) }) }).enabledHarnesses, null);
});

test('cliCatalogEntries：范围外 CLI 不发现、不生成条目', async () => {
  freshRegistry();
  const config = { cliModels: [{ id: 'k3', tool: 'pi', model: 'auto/kimi-k3', modelKey: 'kimi-k3' }] };
  const outside = await cliCatalogEntries(config, null, {
    available: () => true,
    discover: false,
    enabled: new Set(['grok']),
  });
  assert.equal(outside.length, 0);
  const inside = await cliCatalogEntries(config, null, {
    available: () => true,
    discover: false,
    enabled: new Set(['pi']),
  });
  assert.equal(inside.length, 1);
  assert.equal(inside[0].harness, 'pi');
});
