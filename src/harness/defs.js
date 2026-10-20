/**
 * 内置 CLI harness 定义：对齐原型 `runner_interface.ts` 的 8 家。
 *
 * 能纯数据表达的就纯数据（agent / pi / opencode / qoder / devin / cline / grok）；
 * zcode 要写临时 config 并改 HOME，用 `hooks.plan` 表达（代码型，YAML 配置给不了）。
 *
 * 想接新 CLI：优先在 `cordis.patch.yml` 的 `harnesses` 里写定义；确实需要
 * 改配置/环境时再加一个内置定义 + hook。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Cursor agent CLI：思考强度写在模型 slug 里；只读档 `--mode ask`。 */
export const AGENT_HARNESS = {
  id: 'agent',
  label: 'agent',
  command: 'agent',
  args: ['--print', '--output-format', 'stream-json', '--mode', 'ask', '--trust', '--workspace', '{workspace}'],
  model: { flag: '--model', format: '{model}' },
  prompt: { via: 'argv' },
  output: { parser: 'auto' },
  usage: { source: 'stream', aggregate: 'take-last' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true },
  probe: { args: ['status'], classify: 'exit0' },
};

/** pi：`--print --mode json` 出 JSON 事件流；`--` 之后是提示词；默认排除改文件工具。 */
export const PI_HARNESS = {
  id: 'pi',
  label: 'pi',
  command: 'pi',
  args: ['--print', '--mode', 'json', '--no-session'],
  provider: { flag: '--provider' },
  model: { flag: '--model', format: '{model}' },
  thinking: {
    flag: '--thinking',
    default: 'high',
    values: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  tools: { exclude: { flag: '--exclude-tools', default: ['edit', 'write'] } },
  prompt: { via: 'argv', separator: '--' },
  output: { parser: 'pi' },
  usage: { source: 'stream', aggregate: 'sum-turns' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true },
  probe: { args: ['--version'], classify: 'exit0' },
  env: { unset: ['FORCE_COLOR'] },
};

/** zcode 的 CLI 入口（应用内脚本）；配置源是用户自己的 `~/.zcode/cli/config.json`。 */
const ZCODE_JS = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
let zcodeSeq = 0;

/**
 * zcode：强度走临时 config 的 `defaultVariant`；HOME 指到临时目录隔离本机配置。
 * 这一步纯数据表达不了（要读改写 config），所以用 hook。
 */
export const ZCODE_HARNESS = {
  id: 'zcode',
  label: 'zcode',
  command: ZCODE_JS,
  args: [],
  prompt: { via: 'none' },
  output: { parser: 'auto' },
  usage: { source: 'stream', aggregate: 'auto' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true },
  env: { inherit: false },
  hooks: {
    plan(entry, prompt, context) {
      if (!existsSync(ZCODE_JS)) throw new Error(`找不到 zcode CLI：${ZCODE_JS}`);
      const source = join(homedir(), '.zcode', 'cli', 'config.json');
      if (!existsSync(source)) throw new Error(`缺少 zcode 配置：${source}`);
      const model = String(entry?.harnessModel ?? entry?.model ?? 'GLM-5.3-Flash');
      const variant = String(entry?.reasoningEffort || 'max');
      const config = JSON.parse(readFileSync(source, 'utf8'));
      config.model = config.model ?? {};
      config.model.main = `builtin:bigmodel-coding-plan/${model}`;
      const models = config.provider?.['builtin:bigmodel-coding-plan']?.models ?? {};
      if (models[model] && typeof models[model] === 'object') {
        models[model].reasoning = models[model].reasoning ?? {};
        models[model].reasoning.enabled = true;
        models[model].reasoning.defaultVariant = variant;
      }

      zcodeSeq += 1;
      const fakeHome = join(context.tmpDir, `zcode-home-${process.pid}-${zcodeSeq}`);
      const configPath = join(fakeHome, '.zcode', 'cli', 'config.json');
      const prepare = () => {
        mkdirSync(join(fakeHome, '.zcode', 'cli'), { recursive: true });
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      };

      const env = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('ANTHROPIC_') || key.startsWith('OPENAI_') || key === 'FORCE_COLOR') continue;
        if (value !== undefined) env[key] = value;
      }
      env.HOME = fakeHome;

      return {
        argv: [
          process.execPath, ZCODE_JS, '--prompt', prompt, '--cwd', context.workspace,
          '--mode', 'plan', '--disallowed-tools', 'Bash Edit Write',
        ],
        env,
        prepare,
      };
    },
  },
};

/**
 * opencode：`run --format json`；思考档拼进 `-m provider/model#variant`；
 * 只读权限走 `OPENCODE_PERMISSION` 环境变量（edit/write/bash/task 全 deny）。
 * 注意 `harnessModel` 要写带通道前缀的完整模型（如 `opencode/space-bunny-free`）。
 */
export const OPENCODE_HARNESS = {
  id: 'opencode',
  label: 'opencode',
  command: 'opencode',
  args: ['run', '--format', 'json', '--thinking', '--title', 'vastplan-model-team'],
  model: { flag: '-m', format: '{model}#{thinking}' },
  thinking: {
    default: 'max',
    values: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
    viaModelFormat: true,
  },
  prompt: { via: 'argv' },
  env: {
    set: {
      OPENCODE_PERMISSION: JSON.stringify({
        edit: 'deny',
        write: 'deny',
        bash: { '*': 'deny' },
        task: 'deny',
      }),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
    },
    unset: ['FORCE_COLOR'],
  },
  output: { parser: 'opencode' },
  usage: { source: 'stream', aggregate: 'auto' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true, backgroundAgents: true },
  probe: { args: ['auth', 'list'], classify: 'exit0' },
};

/** qoderclicn：无头 `-p` 出 stream-json；强度 `--reasoning-effort`；排除写工具。 */
export const QODER_HARNESS = {
  id: 'qoder',
  label: 'qoder',
  command: 'qoderclicn',
  args: ['-p', '--output-format', 'stream-json', '--no-session-persistence'],
  model: { flag: '-m', format: '{model}' },
  thinking: { flag: '--reasoning-effort', default: 'max' },
  tools: { exclude: { flag: '--disallowed-tools', default: ['Write', 'Edit'] } },
  prompt: { via: 'argv', separator: '--' },
  output: { parser: 'auto' },
  usage: { source: 'stream', aggregate: 'auto' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true },
  probe: { args: ['--version'], classify: 'exit0' },
};

/** devin：`devin acp` 由随包的 `scripts/devin_acp.mjs` 驱动；固定只读档。 */
export const DEVIN_HARNESS = {
  id: 'devin',
  label: 'devin',
  command: '{node}',
  args: ['{pkgDir}/scripts/devin_acp.mjs', '--model', '{model}', '--mode', 'ask'],
  prompt: { via: 'argv', separator: '--' },
  output: { parser: 'auto' },
  usage: { source: 'stream', aggregate: 'auto' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true },
};

/** cline：`--json` 出 NDJSON；默认 `-p` plan 档只读；强度 `--thinking`（max→xhigh）。 */
export const CLINE_HARNESS = {
  id: 'cline',
  label: 'cline',
  command: 'cline',
  args: ['--json', '-c', '{workspace}', '-p'],
  thinking: {
    flag: '--thinking',
    default: 'xhigh',
    map: { max: 'xhigh' },
    values: ['', 'none', 'low', 'medium', 'high', 'xhigh'],
  },
  model: { flag: '-m', format: '{model}' },
  provider: { flag: '-P', format: '{provider}' },
  prompt: { via: 'argv' },
  output: { parser: 'auto' },
  usage: { source: 'stream', aggregate: 'sum-turns' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true },
  probe: { args: ['--version'], classify: 'exit0' },
};

/**
 * grok：`grok -p <prompt>` 必须让提示词紧跟 `-p`，所以用 `prompt.via: none`
 * 把 `{prompt}` 放进 args；事件流 `streaming-json`，默认排除写工具。
 */
export const GROK_HARNESS = {
  id: 'grok',
  label: 'grok',
  command: 'grok',
  args: [
    '-p', '{prompt}', '--output-format', 'streaming-json',
    '--model', '{model}', '--reasoning-effort', '{thinking}',
    '--disallowed-tools', 'write,search_replace',
  ],
  prompt: { via: 'none' },
  thinking: { default: 'high', values: ['', 'low', 'medium', 'high', 'xhigh', 'max'] },
  output: { parser: 'auto' },
  usage: { source: 'stream', aggregate: 'take-last' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true, backgroundAgents: true },
  probe: { args: ['--version'], classify: 'exit0' },
};

export const BUILTIN_HARNESSES = [
  AGENT_HARNESS,
  PI_HARNESS,
  ZCODE_HARNESS,
  OPENCODE_HARNESS,
  QODER_HARNESS,
  DEVIN_HARNESS,
  CLINE_HARNESS,
  GROK_HARNESS,
];
