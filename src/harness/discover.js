/**
 * CLI 模型自动发现：每家 CLI 声明一个 `discover`（命令 + 解析器）或
 * `hooks.discover()`（读本机配置文件），目录构建时自动合并。
 *
 * - 先做可用性检查（`harnessAvailable`）：没装的 CLI 不发现。
 * - 结果缓存 5 分钟；装好 CLI/新增模型后最多等 5 分钟或重载插件。
 * - 按**逻辑模型**去重（`logicalKeyOf`）：同一模型的多个厂商路由只留一条，
 *   优先 `auto/` → `devin/` → `workbuddy/` → `opencode-go/` → `zcode/` → `grok/`，
 *   原生模型 id（无 `/`）优先。
 * - 显式 `cliModels` 仍然优先：同 `harness + modelKey` 的自动条目会被显式条目覆盖。
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { harnessAvailable } from './availability.js';
import { fill } from './protocol.js?v=0.6.9';

const execFileAsync = promisify(execFile);
const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 自动发现缓存 TTL：模型列表不会秒级变化。 */
export const DISCOVERY_TTL_MS = 30 * 60_000;

const CACHE = new Map();
const WARNED = new Set();

/** 去掉终端颜色码（cline/qoder 之类可能带 ANSI）。 */
const stripAnsi = (text) => String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '');

/**
 * 逻辑模型键：取最后一段路由，去掉 `auto-` 前缀，再把 `[-_.]` 归一成 `-`。
 *
 * 例：`magpie/auto/GLM-5.3` → `glm-5-3`；`grok/grok-4.7@500k` → `grok-4-7@500k`；
 * `group/auto-kimi-k3` → `kimi-k3`；`claude-opus-5-5-high` 原样。
 */
export function logicalKeyOf(id) {
  const raw = String(id ?? '').trim();
  if (!raw) return '';
  const last = raw.split('/').filter(Boolean).pop() ?? raw;
  return last
    .replace(/^auto-/, '')
    .toLowerCase()
    .replace(/[-_.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** 路由优先级：越小越优先（同逻辑模型只留一条）。 */
function routeRank(id) {
  if (!id.includes('/')) return 0;
  if (/(^|\/)(auto\/|group\/auto-)/.test(id)) return 1;
  if (/(^|\/)devin\//.test(id)) return 2;
  if (/(^|\/)workbuddy\//.test(id)) return 3;
  if (/(^|\/)opencode-go\//.test(id)) return 4;
  if (/(^|\/)zcode\//.test(id)) return 5;
  if (/(^|\/)grok\//.test(id)) return 6;
  return 7;
}

/**
 * 解析模型列表命令的输出。
 *
 * @param parser - `lines` / `opencode` / `id-dash-name` / `bullet` / `devin-table` / `qoder-table`。
 * @param text - stdout。
 * @returns `{ id, name }[]`。
 */
export function parseDiscovery(parser, text) {
  const clean = stripAnsi(text);
  const lines = clean.split('\n');
  const out = [];
  const push = (id, name) => {
    const value = String(id ?? '').trim();
    if (value) out.push({ id: value, name: String(name ?? value).trim() || value });
  };

  if (parser === 'id-dash-name') {
    for (const line of lines) {
      const match = /^\s*(\S+)\s+-\s+(.+?)\s*$/.exec(line);
      if (match) push(match[1], match[2]);
    }
    return out;
  }

  if (parser === 'bullet') {
    for (const line of lines) {
      const match = /^\s*-\s+(\S+)\s*$/.exec(line);
      if (match) push(match[1], match[1]);
    }
    return out;
  }

  if (parser === 'devin-json') {
    // devin models list --format json：families[].variants[]。
    // 一个 family 是一条模型；variant 的 model_uid 后缀拆成 effort/speed 两个维度，
    // 不再把 claude-opus-5-5-high-fast 当成独立模型或路由。
    let data;
    try { data = JSON.parse(clean); } catch { return []; }
    const effortTokens = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'none', 'minimal']);
    const speedTokens = new Set(['fast', 'lightning', 'priority', 'slow']);
    const effortOrder = ['', 'low', 'medium', 'high', 'xhigh', 'max', 'none', 'minimal'];
    const speedOrder = ['', 'fast', 'lightning', 'priority', 'slow'];
    const families = Array.isArray(data?.families) ? data.families : [];
    for (const family of families) {
      const familyUid = String(family?.family_uid ?? '').trim();
      const slug = String(family?.slug ?? '').trim();
      const rawBase = /^[a-z0-9][a-z0-9-]*$/.test(familyUid) ? familyUid : slug;
      const base = rawBase.toLowerCase().replace(/[._]/g, '-');
      const modelKey = logicalKeyOf(base);
      if (!modelKey) continue;
      const familyLabel = String(family?.family_label ?? base).trim() || base;
      const variants = (Array.isArray(family?.variants) ? family.variants : [])
        .map((variant) => String(variant?.model_uid ?? '').trim())
        .filter(Boolean);
      if (!variants.length) continue;
      const efforts = new Set(['']);
      const speeds = new Set(['']);
      for (const variant of variants) {
        const normalized = logicalKeyOf(variant);
        const suffix = normalized.startsWith(`${base}-`) ? normalized.slice(base.length + 1) : '';
        const tokens = suffix.split('-').filter(Boolean);
        const effort = tokens.find((token) => effortTokens.has(token));
        const speed = tokens.find((token) => speedTokens.has(token));
        if (effort) efforts.add(effort);
        if (speed) speeds.add(speed);
      }
      const effortList = effortOrder.filter((token) => efforts.has(token));
      const speedList = speedOrder.filter((token) => speeds.has(token));
      out.push({
        id: modelKey,
        name: familyLabel,
        modelKey,
        harnessModel: base,
        efforts: effortList,
        speeds: speedList,
        defaultEffort: effortList.includes('max') ? 'max' : effortList.includes('high') ? 'high' : '',
        defaultSpeed: speedList.includes('') ? '' : speedList[0],
        primary: true,
      });
    }
    return out;
  }

  if (parser === 'devin-table') {
    for (const line of lines) {
      // 形如：`  swe-2-high   SWE-2 High  [262K context, Free]`
      const match = /^\s{2,}([a-z0-9][a-z0-9._-]*)\s{2,}(.+?)(?:\s{2,}\[|$)/.exec(line);
      if (match) push(match[1], match[2]);
    }
    return out;
  }

  if (parser === 'qoder-table') {
    let started = false;
    for (const line of lines) {
      if (!started) {
        if (/^\s*MODEL\s*$/.test(line)) started = true;
        continue;
      }
      const value = line.trim();
      if (value) push(value, value);
    }
    return out;
  }

  // lines / opencode：一行一个 id（opencode 是 `provider/model`）
  for (const line of lines) {
    const value = line.trim();
    if (value) push(value, value);
  }
  return out;
}

/**
 * 归一化 + 按逻辑模型去重。
 *
 * @param items - `{ id, name?, provider? }[]`。
 * @returns `{ id, name, provider, modelKey, harnessModel }[]`。
 */
export function normalizeModels(items, options = {}) {
  const list = items ?? [];

  // 保留同族变体（Devin）：一个 family 一条主条目，其余 variants 作为同 modelKey 的路由。
  if (options.preserveVariants) {
    const groups = new Map();
    for (const item of list) {
      const raw = String(item?.harnessModel ?? item?.id ?? '').trim();
      if (!raw) continue;
      const modelKey = String(item?.modelKey ?? logicalKeyOf(raw)).trim();
      if (!modelKey) continue;
      const candidate = {
        id: String(item?.id ?? logicalKeyOf(raw)).trim(),
        name: String(item?.name ?? raw).trim() || raw,
        provider: String(item?.provider ?? '').trim(),
        modelKey,
        harnessModel: raw,
        primary: item?.primary === true,
        efforts: Array.isArray(item?.efforts) ? item.efforts.map(String) : undefined,
        speeds: Array.isArray(item?.speeds) ? item.speeds.map(String) : undefined,
        defaultEffort: item?.defaultEffort,
        defaultSpeed: item?.defaultSpeed,
      };
      const group = groups.get(modelKey) ?? [];
      if (!group.some((entry) => entry.harnessModel === raw)) group.push(candidate);
      groups.set(modelKey, group);
    }
    const out = [];
    for (const group of groups.values()) {
      group.sort((left, right) => (Number(right.primary) - Number(left.primary))
        || left.id.localeCompare(right.id));
      out.push(...group);
    }
    return out.sort((left, right) => left.modelKey.localeCompare(right.modelKey)
      || (Number(right.primary) - Number(left.primary))
      || left.id.localeCompare(right.id));
  }

  const best = new Map();
  for (const item of list) {
    const raw = String(item?.id ?? '').trim();
    if (!raw) continue;
    const modelKey = logicalKeyOf(raw);
    if (!modelKey) continue;
    const candidate = {
      id: modelKey,
      name: String(item?.name ?? raw).trim() || raw,
      provider: String(item?.provider ?? '').trim(),
      modelKey,
      harnessModel: raw,
      efforts: Array.isArray(item?.efforts) ? item.efforts.map(String) : undefined,
      speeds: Array.isArray(item?.speeds) ? item.speeds.map(String) : undefined,
      defaultEffort: item?.defaultEffort,
      defaultSpeed: item?.defaultSpeed,
    };
    const current = best.get(modelKey);
    const better = !current
      || routeRank(raw) < routeRank(current.harnessModel)
      || (routeRank(raw) === routeRank(current.harnessModel)
        && raw.length < current.harnessModel.length);
    if (better) best.set(modelKey, candidate);
  }
  return [...best.values()].sort((left, right) => left.modelKey.localeCompare(right.modelKey));
}

async function runDiscoverCommand(definition) {
  const command = fill(definition.discover.command || definition.command, {
    node: process.execPath,
    pkgDir: PKG_DIR,
  });
  const argv = (definition.discover.argv ?? []).map((arg) => fill(arg, {
    node: process.execPath,
    pkgDir: PKG_DIR,
  }));
  const { stdout } = await execFileAsync(command, argv, {
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
    env: process.env,
    cwd: process.cwd(),
  });
  return parseDiscovery(definition.discover.parser, stdout);
}

/**
 * 发现一家 CLI 的模型（带缓存）。
 *
 * @param definition - 归一化定义。
 * @param logger - 可选日志器；失败只 warn 一次。
 * @returns `{ id, name, provider, modelKey, harnessModel }[]`。
 */
export async function discoverHarness(definition, logger) {
  if (!harnessAvailable(definition)) return [];
  const cached = CACHE.get(definition.id);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.models;

  let items = [];
  try {
    if (typeof definition.hooks?.discover === 'function') {
      items = await definition.hooks.discover();
    } else if (definition.discover?.argv?.length) {
      items = await runDiscoverCommand(definition);
    }
  } catch (error) {
    if (!WARNED.has(definition.id)) {
      WARNED.add(definition.id);
      logger?.warn?.(
        `model-team: CLI「${definition.id}」自动发现失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    items = [];
  }

  const models = normalizeModels(items, { preserveVariants: definition.discover?.preserveVariants === true });
  CACHE.set(definition.id, { at: Date.now(), models });
  return models;
}

/**
 * 发现全部 CLI 的模型（并行；只处理有 discover/hook 的定义）。
 *
 * @returns `{ id, name, provider, modelKey, harnessModel, harness }[]`。
 */
export async function discoverAll(definitions, logger) {
  const out = [];
  await Promise.all((definitions ?? []).map(async (definition) => {
    const models = await discoverHarness(definition, logger);
    for (const model of models) out.push({ ...model, harness: definition.id });
  }));
  return out;
}

/** 清空发现缓存（测试用）。 */
export function clearDiscoveryCache() {
  CACHE.clear();
  WARNED.clear();
}
