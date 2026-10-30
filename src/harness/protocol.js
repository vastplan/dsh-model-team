/**
 * CLI Harness 协议（v1）：各家 CLI 用**一份定义**接入，而不是往执行层里写 if。
 *
 * 分层（与原型 `harness_protocol` / `runner_interface` / `invoke_exec` 同构）：
 * - **协议层**（本文件）：`HarnessDefinition` 的形状、校验、注册表、`buildLaunch()`。
 *   不认识任何具体 CLI，也不起进程。
 * - **定义层**（`defs.js` / 配置里的 `harnesses`）：每家 CLI 一份纯数据定义，
 *   声明命令、参数、模型/强度占位符、只读纪律、解析方言、用量口径与就绪探测。
 * - **机制层**（`exec.js`）：起进程、逐行流、超时/看门狗/取消、解析、结果归一。
 *
 * 定义只描述差异，不写代码；需要特殊 argv 的 CLI 也先试图用占位符表达。
 */

export const PROTOCOL_VERSION = 1;

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根（`src/harness/` 往上两层）：定义里用 `{pkgDir}` 引用随包脚本。 */
const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 解析方言。`auto` = 按事件形状识别（`parse.js` 的能力），`text` = 纯文本。 */
const PARSERS = new Set(['auto', 'jsonl', 'text', 'pi', 'opencode']);

/** 自动发现模型列表的解析器。 */
const DISCOVER_PARSERS = new Set(['lines', 'opencode', 'id-dash-name', 'bullet', 'devin-table', 'devin-json', 'qoder-table']);

/** 通用思考档；具体 CLI 可用 `thinking.values` 收窄。 */
const DEFAULT_THINKING_VALUES = ['', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];

const asArray = (value) => (Array.isArray(value) ? value.map((item) => String(item)) : []);
const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const asString = (value, fallback = '') => (value === undefined || value === null ? fallback : String(value));

/** 把 `{model}` / `{thinking}` 这类占位符替换掉（不用正则，值里有 `$` 也安全）。 */
export function fill(template, values) {
  let out = asString(template);
  for (const [key, value] of Object.entries(values ?? {})) {
    out = out.split(`{${key}}`).join(asString(value));
  }
  return out;
}

/**
 * 校验并归一化一份 harness 定义。
 *
 * @param raw - 配置里/内置的定义。
 * @param options.source - 报错时的来源（`builtin` / `config`）。
 * @returns 归一化后的定义（缺省值补齐）。
 * @throws 必填项缺失、id 非法、解析方言未知、模式字段不完整。
 */
export function validateHarness(raw, { source = 'config' } = {}) {
  const input = asObject(raw);
  if (!input) throw new Error(`${source}: harness 定义必须是对象`);

  const id = asString(input.id).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`${source}: harness id 只能是小写字母/数字/连字符：${id || '(空)'}`);
  }
  const command = asString(input.command).trim();
  if (!command) throw new Error(`${source}: harness「${id}」缺少 command`);

  const parser = asString(input.output?.parser ?? input.parser, 'auto');
  if (!PARSERS.has(parser)) {
    throw new Error(`${source}: harness「${id}」的解析方言「${parser}」不支持；可用：${[...PARSERS].join(', ')}`);
  }

  const promptVia = asString(input.prompt?.via, 'argv');
  if (!['argv', 'stdin', 'file', 'none'].includes(promptVia)) {
    throw new Error(`${source}: harness「${id}」的 prompt.via 只能是 argv / stdin / file / none`);
  }

  const modelInput = asObject(input.model);
  if (modelInput && !asString(modelInput.flag).trim()) {
    throw new Error(`${source}: harness「${id}」的 model 需要 flag（例如 --model / -m）`);
  }

  const excludeInput = asObject(input.tools?.exclude);
  const thinkingInput = asObject(input.thinking);
  const thinkingMap = {};
  for (const [key, value] of Object.entries(asObject(thinkingInput?.map) ?? {})) {
    thinkingMap[key] = asString(value);
  }
  const thinkingValues = asArray(thinkingInput?.values);
  const modelFormat = asString(modelInput?.format, '{model}');
  const viaModelFormat = thinkingInput?.viaModelFormat === true
    // 没有独立 flag、但 model 格式里用了 {thinking}：强度必须拼进模型参数。
    || (!asString(thinkingInput?.flag).trim() && modelFormat.includes('{thinking}'));

  const envSet = {};
  for (const [key, value] of Object.entries(asObject(input.env?.set) ?? {})) {
    envSet[key] = asString(value);
  }

  const probeInput = asObject(input.probe);
  const availabilityInput = asObject(input.availability);
  const discoverInput = asObject(input.discover);
  if (discoverInput) {
    const parser = asString(discoverInput.parser, 'lines');
    if (!DISCOVER_PARSERS.has(parser)) {
      throw new Error(`${source}: harness「${id}」的 discover.parser「${parser}」不支持；可用：${[...DISCOVER_PARSERS].join(', ')}`);
    }
  }

  return Object.freeze({
    protocol: PROTOCOL_VERSION,
    id,
    label: asString(input.label, id),
    command,
    args: asArray(input.args),
    model: modelInput
      ? {
        flag: asString(modelInput.flag).trim(),
        format: modelFormat,
        prefix: asString(modelInput.prefix),
      }
      : null,
    provider: asObject(input.provider)
      ? {
        flag: asString(input.provider.flag).trim(),
        format: asString(input.provider.format, '{provider}'),
      }
      : null,
    thinking: thinkingInput
      ? {
        flag: asString(thinkingInput.flag).trim(),
        format: asString(thinkingInput.format, '{thinking}'),
        default: asString(thinkingInput.default),
        values: thinkingValues.length ? thinkingValues : DEFAULT_THINKING_VALUES,
        map: thinkingMap,
        viaModelFormat,
      }
      : null,
    tools: excludeInput
      ? {
        exclude: {
          flag: asString(excludeInput.flag).trim(),
          join: asString(excludeInput.join, ','),
          default: asArray(excludeInput.default),
        },
      }
      : null,
    prompt: {
      via: promptVia,
      separator: asString(input.prompt?.separator),
      template: asString(input.prompt?.template),
    },
    // 代码型钩子（配置 YAML 给不了函数）：`plan(entry, prompt, context)` 返回
    // `{ argv, env?, cwd?, stdin?, prepare? }`，用于 zcode 这种要改临时配置的 CLI。
    hooks: {
      plan: typeof input.hooks?.plan === 'function' ? input.hooks.plan : null,
      discover: typeof input.hooks?.discover === 'function' ? input.hooks.discover : null,
    },
    env: {
      inherit: input.env?.inherit !== false,
      set: envSet,
      unset: asArray(input.env?.unset),
    },
    output: {
      parser,
      args: asArray(input.output?.args),
    },
    usage: {
      source: asString(input.usage?.source, 'stream'),
      aggregate: asString(input.usage?.aggregate, 'auto'),
    },
    capabilities: {
      readOnlyByDefault: input.capabilities?.readOnlyByDefault !== false,
      streamsUsage: input.capabilities?.streamsUsage === true,
      backgroundAgents: input.capabilities?.backgroundAgents === true,
    },
    probe: probeInput
      ? { args: asArray(probeInput.args), classify: asString(probeInput.classify, 'exit0') }
      : null,
    // 自动发现模型：命令 + 解析器（zcode/pi/cline 用 hooks.discover 读配置文件）。
    discover: discoverInput && (asArray(discoverInput.argv).length || asString(discoverInput.command).trim())
      ? {
        command: asString(discoverInput.command),
        argv: asArray(discoverInput.argv),
        parser: asString(discoverInput.parser, 'lines'),
        preserveVariants: discoverInput.preserveVariants === true,
      }
      : null,
    // 目录构建时的可用性检查：主命令 fallbacks / 额外命令 / 额外文件。
    availability: {
      fallbacks: asArray(availabilityInput?.fallbacks),
      commands: (Array.isArray(availabilityInput?.commands) ? availabilityInput.commands : [])
        .map((item) => asObject(item))
        .filter(Boolean)
        .map((item) => ({
          command: asString(item.command),
          fallbacks: asArray(item.fallbacks),
          env: asString(item.env),
        }))
        .filter((item) => item.command),
      files: asArray(availabilityInput?.files),
    },
    timeoutMs: Number(input.timeoutMs ?? 0) || 0,
    silenceMs: Number(input.silenceMs ?? 0) || 0,
    cwd: asString(input.cwd, 'workspace'),
  });
}

const REGISTRY = new Map();

/**
 * 注册一份 harness 定义。
 *
 * @param raw - 原始定义。
 * @param options.replace - 同 id 已存在时是否覆盖（配置覆盖内置要用 true）。
 * @param options.source - `builtin` / `config`，只用于报错。
 * @returns 归一化后的定义。
 */
export function registerHarness(raw, { replace = false, source = 'config' } = {}) {
  const definition = validateHarness(raw, { source });
  if (REGISTRY.has(definition.id) && !replace) {
    throw new Error(`${source}: harness「${definition.id}」已注册；要覆盖请显式 replace`);
  }
  REGISTRY.set(definition.id, definition);
  return definition;
}

/** 按 id 取定义；未知时列出已登记的，便于排错。 */
export function harnessFor(id) {
  const key = asString(id).trim();
  const found = REGISTRY.get(key);
  if (!found) {
    const known = [...REGISTRY.keys()].sort().join(', ') || '（无）';
    throw new Error(`未知 CLI harness：${key || '(空)'}；已登记：${known}`);
  }
  return found;
}

/** 全部已登记定义（按 id 排序）。 */
export function listHarnesses() {
  return [...REGISTRY.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** 清空注册表（测试用；运行时不要调）。 */
export function clearHarnesses() {
  REGISTRY.clear();
}

/** 计算实际传给 CLI 的思考档：空值用默认，`map` 负责把内部档位翻成 CLI 方言。 */
export function resolveThinking(definition, effort) {
  const raw = asString(effort).trim() || asString(definition.thinking?.default).trim();
  if (!raw) return '';
  return definition.thinking?.map?.[raw] ?? raw;
}

/**
 * 把「定义 + 一条模型条目」翻成一次启动计划。
 *
 * 占位符：`{model}` `{provider}` `{thinking}` `{workspace}` `{tmp}` `{prompt}` `{promptFile}`。
 * 参数顺序固定为：基础 args → provider → model → thinking → 工具排除 → 输出格式 → prompt。
 *
 * @param definition - 归一化定义。
 * @param entry - 目录条目（`harnessModel` / `harnessProvider` / `reasoningEffort` / `excludeTools`）。
 * @param prompt - 完整提示词。
 * @param context - `{ workspace, tmpDir }`。
 * @returns `{ argv, env, cwd, stdin, promptFile, promptFileContent }`。
 */
export function buildLaunch(definition, entry, prompt, context) {
  const workspace = asString(context?.workspace);
  const tmp = asString(context?.tmpDir);

  // 代码型钩子：完全接管 argv/env（zcode 要写临时 config 并改 HOME）。
  if (typeof definition.hooks?.plan === 'function') {
    const custom = definition.hooks.plan(entry, prompt, { workspace, tmpDir: tmp, definition });
    if (!custom || !Array.isArray(custom.argv) || !custom.argv.length) {
      throw new Error(`harness「${definition.id}」的 hooks.plan 没有返回 argv`);
    }
    const env = {};
    if (definition.env.inherit) Object.assign(env, process.env);
    Object.assign(env, custom.env ?? {});
    for (const key of definition.env.unset) delete env[key];
    return {
      argv: custom.argv.map((item) => String(item)),
      env,
      cwd: custom.cwd ?? workspace,
      stdin: custom.stdin ?? null,
      prepare: custom.prepare ?? null,
      promptFile: '',
      promptFileContent: '',
    };
  }

  const thinking = resolveThinking(definition, entry?.reasoningEffort);
  const model = asString(entry?.harnessModel ?? entry?.model);
  const provider = asString(entry?.harnessProvider);
  const promptFile = definition.prompt.via === 'file'
    ? fill(definition.prompt.template || `${tmp}/prompt.md`, { tmp, workspace })
    : '';
  const values = {
    model, provider, thinking, workspace, tmp, prompt, promptFile,
    // 随包脚本用 `{pkgDir}`；devin 的 ACP 客户端用 `{node}` 起。
    pkgDir: PKG_DIR,
    node: process.execPath,
  };

  const argv = [fill(definition.command, values), ...definition.args.map((arg) => fill(arg, values))];

  if (definition.provider?.flag && provider) {
    argv.push(definition.provider.flag, fill(definition.provider.format, values));
  }

  if (definition.model?.flag && model) {
    const prefixed = definition.model.prefix && !model.startsWith(definition.model.prefix)
      ? `${definition.model.prefix}${model}`
      : model;
    argv.push(
      definition.model.flag,
      fill(definition.model.format, { ...values, model: prefixed }),
    );
  }

  if (definition.thinking?.flag && thinking && !definition.thinking.viaModelFormat) {
    argv.push(definition.thinking.flag, fill(definition.thinking.format, values));
  }

  const exclude = Array.isArray(entry?.excludeTools)
    ? entry.excludeTools.map(String)
    : (definition.tools?.exclude?.default ?? []);
  if (definition.tools?.exclude?.flag && exclude.length) {
    argv.push(definition.tools.exclude.flag, exclude.join(definition.tools.exclude.join || ','));
  }

  if (definition.output.args.length) {
    argv.push(...definition.output.args.map((arg) => fill(arg, values)));
  }

  let stdin = null;
  if (definition.prompt.via === 'none') {
    // 提示词已经由 args 里的 {prompt} 带到指定位置，不再追加。
  } else if (definition.prompt.via === 'stdin') {
    stdin = prompt;
  } else if (definition.prompt.via === 'file') {
    // 参数里已经写了 {promptFile} 就不重复追加；否则按 separator 把文件路径补在末尾。
    if (!argv.some((arg) => arg === promptFile)) {
      if (definition.prompt.separator) argv.push(definition.prompt.separator);
      argv.push(promptFile);
    }
  } else {
    if (definition.prompt.separator) argv.push(definition.prompt.separator);
    argv.push(fill(definition.prompt.template || '{prompt}', values));
  }

  const env = {};
  if (definition.env.inherit) Object.assign(env, process.env);
  for (const [key, value] of Object.entries(definition.env.set)) {
    env[key] = fill(value, values);
  }
  for (const key of definition.env.unset) delete env[key];

  return {
    argv,
    env,
    cwd: definition.cwd === 'workspace' ? workspace : definition.cwd,
    stdin,
    prepare: null,
    promptFile,
    promptFileContent: promptFile ? prompt : '',
  };
}
