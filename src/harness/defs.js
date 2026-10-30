/**
 * 内置 CLI harness 定义：对齐原型 `runner_interface.ts` 的 8 家。
 *
 * 能纯数据表达的就纯数据（agent / pi / opencode / qoder / devin / cline / grok）；
 * zcode 要写临时 config 并改 HOME，用 `hooks.plan` 表达（代码型，YAML 配置给不了）。
 *
 * `availability` 决定「本机是否装好/配好」：不可用的 CLI 不会出现在模型目录的厂商路由里。
 *
 * 想接新 CLI：优先在 `cordis.patch.yml` 的 `harnesses` 里写定义；确实需要
 * 改配置/环境时再加一个内置定义 + hook。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  discover: { argv: ['--list-models'], parser: 'id-dash-name' },
  availability: { fallbacks: ['~/.local/bin/agent'] },
  probe: { args: ['status'], classify: 'exit0' },
};

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Claude 二进制解析失败时的兜底：当前最新版本（2026-10）。 */
const CLAUDE_FALLBACK_MODELS = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
];

let claudeModelCache = null;

/** 找真实的 Claude 可执行文件（`~/.local/bin/claude` 通常是指向版本目录的软链）。 */
function claudeBinaryPath() {
  const candidates = [
    ...String(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'claude')),
    join(homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try { return realpathSync(candidate); } catch { return candidate; }
  }
  return '';
}

/**
 * Claude CLI 没有模型列表命令，但二进制里带着 `claude-sonnet-5-5` 这类真实模型名。
 *
 * 读一次二进制，按家族取**最高版本**（排除 `20250929` 这种 8 位日期段），
 * 这样目录里显示的是带版本号的 id，而不是 `sonnet` / `opus` 别名。
 * 读不到二进制时回退到内置版本表。
 */
function claudeModels() {
  if (claudeModelCache) return claudeModelCache;
  const bin = claudeBinaryPath();
  if (bin) {
    try {
      const text = readFileSync(bin, 'latin1');
      const pattern = /claude-(sonnet|opus|haiku|fable)-(\d+(?:-\d{1,2})*)/g;
      const best = new Map();
      const compare = (left, right) => {
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
          const a = left[index] ?? 0;
          const b = right[index] ?? 0;
          if (a !== b) return a - b;
        }
        return 0;
      };
      for (const match of text.matchAll(pattern)) {
        const parts = match[2].split('-').map(Number);
        if (parts.some((value) => value > 99)) continue;
        const current = best.get(match[1]);
        if (!current || compare(parts, current.parts) > 0) {
          best.set(match[1], { parts, version: match[2] });
        }
      }
      if (best.size) {
        claudeModelCache = [...best.entries()]
          .map(([family, item]) => ({
            id: `claude-${family}-${item.version}`,
            name: `Claude ${family[0].toUpperCase()}${family.slice(1)} ${item.parts.join('.')}`,
          }))
          .sort((left, right) => left.id.localeCompare(right.id));
        return claudeModelCache;
      }
    } catch { /* 二进制不可读就走兜底 */ }
  }
  claudeModelCache = [...CLAUDE_FALLBACK_MODELS];
  return claudeModelCache;
}

/**
 * Claude Code CLI：`-p` 非交互 + `stream-json`，`--include-partial-messages` 出增量。
 *
 * 只读：`--permission-mode plan`（计划模式）+ `--restricted`（去掉 Bash/PowerShell 等
 * 执行类工具，并把文件工具限制在工作区）+ 再 deny 编辑类工具，三道保险。
 *
 * Claude 没有模型列表命令（`claude models` 会被当成 prompt），发现只返回官方别名
 * （sonnet / opus / haiku / fable）和 `~/.claude/settings.json` 里的当前模型。
 */
export const CLAUDE_HARNESS = {
  id: 'claude',
  label: 'claude',
  command: 'claude',
  args: [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--no-session-persistence',
    '--permission-mode', 'plan', '--restricted', '--permission-prompts', 'none',
  ],
  model: { flag: '--model', format: '{model}' },
  thinking: { flag: '--effort', default: 'high', values: ['', 'low', 'medium', 'high', 'xhigh', 'max'] },
  tools: { exclude: { flag: '--disallowedTools', default: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] } },
  prompt: { via: 'argv', separator: '--' },
  output: { parser: 'auto' },
  usage: { source: 'stream', aggregate: 'take-last' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true },
  availability: { fallbacks: ['~/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'] },
  probe: { args: ['--version'], classify: 'exit0' },
  hooks: {
    discover: () => claudeModels(),
  },
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
  availability: { fallbacks: ['~/.local/bin/pi'] },
  probe: { args: ['--version'], classify: 'exit0' },
  env: { unset: ['FORCE_COLOR'] },
  hooks: {
    discover() {
      const candidates = [
        join(homedir(), '.pi', 'agent', 'models.json'),
        join(homedir(), '.pi', 'agent', 'models-store.json'),
      ];
      const file = candidates.find((path) => existsSync(path));
      if (!file) return [];
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const providers = data.providers && typeof data.providers === 'object' ? data.providers : data;
      const out = [];
      for (const [providerId, provider] of Object.entries(providers)) {
        if (!provider || typeof provider !== 'object' || !Array.isArray(provider.models)) continue;
        for (const model of provider.models) {
          const id = String(model?.id ?? '').trim();
          if (id) out.push({ id, name: String(model?.name ?? id), provider: providerId });
        }
      }
      return out;
    },
  },
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
  // 没有配置文件的 zcode 等于没装好：直接隐藏。
  availability: { files: ['~/.zcode/cli/config.json'] },
  env: { inherit: false },
  hooks: {
    discover() {
      const file = join(homedir(), '.zcode', 'cli', 'config.json');
      if (!existsSync(file)) return [];
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const provider = 'builtin:bigmodel-coding-plan';
      const models = data.provider?.[provider]?.models;
      const ids = Array.isArray(models)
        ? models.map((model) => String(model?.id ?? model)).filter(Boolean)
        : Object.keys(models ?? {});
      const out = ids.map((id) => ({ id, name: id }));
      const main = String(data.model?.main ?? '');
      const prefix = `${provider}/`;
      if (!out.length && main.startsWith(prefix)) {
        const id = main.slice(prefix.length);
        out.push({ id, name: id });
      }
      return out;
    },
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
  discover: { argv: ['models'], parser: 'opencode' },
  availability: { fallbacks: ['~/.opencode/bin/opencode'] },
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
  discover: { argv: ['--list-models'], parser: 'qoder-table' },
  availability: { fallbacks: ['~/.local/bin/qoderclicn', '~/.qoder-cn/entry/qodercn'] },
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
  discover: { command: 'devin', argv: ['models', 'list', '--format', 'json'], parser: 'devin-json' },
  // 思考强度和速度是独立维度：基础 family + `-effort` + `-speed` 拼成 Devin 的 model_uid。
  hooks: {
    plan(entry, prompt) {
      const base = String(entry?.harnessModel ?? entry?.model ?? '').trim();
      const effort = String(entry?.reasoningEffort ?? '').trim();
      const speed = String(entry?.speed ?? '').trim();
      const model = `${base}${effort ? `-${effort}` : ''}${speed ? `-${speed}` : ''}`;
      return {
        argv: [
          process.execPath, join(PKG_DIR, 'scripts/devin_acp.mjs'),
          '--model', model, '--mode', 'ask', '--', prompt,
        ],
      };
    },
  },
  // 主命令是 node（恒在），真正的 CLI 是 devin；ACP 客户端必须随包存在。
  availability: {
    commands: [{ command: 'devin', fallbacks: ['~/.local/bin/devin'], env: 'DEVIN_BIN' }],
    files: ['{pkgDir}/scripts/devin_acp.mjs'],
  },
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
  availability: { fallbacks: ['~/.local/bin/cline'] },
  hooks: {
    discover() {
      const file = join(homedir(), '.cline', 'data', 'settings', 'providers.json');
      if (!existsSync(file)) return [];
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const out = [];
      for (const [providerId, provider] of Object.entries(data.providers ?? {})) {
        const model = provider?.settings?.model;
        if (typeof model === 'string' && model.trim()) {
          out.push({ id: model.trim(), name: `${model.trim()} (${providerId})`, provider: providerId });
        }
      }
      return out;
    },
  },
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
  discover: { argv: ['models'], parser: 'bullet' },
  availability: { fallbacks: ['~/.local/bin/grok'] },
  probe: { args: ['--version'], classify: 'exit0' },
};

export const BUILTIN_HARNESSES = [
  AGENT_HARNESS,
  CLAUDE_HARNESS,
  PI_HARNESS,
  ZCODE_HARNESS,
  OPENCODE_HARNESS,
  QODER_HARNESS,
  DEVIN_HARNESS,
  CLINE_HARNESS,
  GROK_HARNESS,
];
