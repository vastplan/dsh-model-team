/**
 * CLI 模型自动发现：每家 CLI 声明一个 `discover`（命令 + 解析器）或
 * `hooks.discover()`（读本机配置文件），目录构建时自动合并。
 *
 * - 先做可用性检查（`harnessAvailable`）：没装的 CLI 不发现。
 * - 结果**落盘缓存**（`cli-cache.js`），不自动过期：进设置页只读缓存，点「刷新」才重探。
 * - 发现命令/解析器改过（签名不同）时旧缓存自动失效，不需要用户手动清缓存。
 * - 按**逻辑模型**去重（`logicalKeyOf`）：同一模型的多个厂商路由只留一条，
 *   优先 `auto/` → `devin/` → `workbuddy/` → `opencode-go/` → `zcode/` → `grok/`，
 *   原生模型 id（无 `/`）优先。
 * - 显式 `cliModels` 仍然优先：同 `harness + modelKey` 的自动条目会被显式条目覆盖。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { harnessAvailable } from './availability.js';
import { clearCachedDiscovery, getCachedDiscovery, setCachedDiscovery } from './cli-cache.js';
import { fill } from './protocol.js?v=0.7.3';

const execFileAsync = promisify(execFile);
const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
      const match = /^\s*[-*]\s+(\S+)/.exec(line);
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

  if (parser === 'tab-name') {
    // `<id>\t<显示名>`（agy `models` 这类）。**必须带 tab**：无 tab 的行是进度噪声
    // （如 `Fetching available models...`），当成模型会把脏数据写进目录。
    for (const line of lines) {
      if (!line.includes('\t')) continue;
      const [idPart, ...rest] = line.split('\t');
      const id = String(idPart ?? '').trim();
      if (!id) continue;
      const name = rest.join(' ').trim() || id;
      out.push({ id, name });
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
 * 发现口径的签名：命令 / 参数 / 解析器 / hook 源码任一变化都视为「缓存过期」。
 *
 * 没有它的话，改完 `discover.argv` 还读旧缓存，用户会以为修复没生效；
 * 有了它，插件升级后旧缓存自动作废，不需要用户先点一次刷新。
 *
 * @param definition - 归一化定义。
 * @returns 16 位十六进制签名。
 */
export function discoverySignature(definition) {
  const discover = definition?.discover ?? {};
  const asText = (value) => (value === undefined || value === null ? '' : String(value));
  const hook = typeof definition?.hooks?.discover === 'function'
    ? definition.hooks.discover.toString()
    : '';
  return createHash('sha1').update(JSON.stringify({
    command: asText(discover.command) || asText(definition?.command),
    argv: Array.isArray(discover.argv) ? discover.argv.map(String) : [],
    parser: asText(discover.parser),
    preserveVariants: discover.preserveVariants === true,
    hook,
  })).digest('hex').slice(0, 16);
}

/**
 * 发现一家 CLI 的模型（带**落盘**缓存，默认不重探）。
 *
 * @param definition - 归一化定义。
 * @param logger - 可选日志器；失败只 warn 一次。
 * @param options.force - `true` = 忽略缓存重新探测（设置页的「刷新」用）。
 * @returns `{ id, name, provider, modelKey, harnessModel }[]`。
 */
export async function discoverHarness(definition, logger, options = {}) {
  if (!harnessAvailable(definition)) return [];
  const signature = discoverySignature(definition);
  if (options.force !== true) {
    const cached = getCachedDiscovery(definition.id, signature);
    if (cached) return cached.models;
  }

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
  // 返回**落盘后的同一形状**：首次发现与后续读缓存拿到的字段要一致（落盘会去掉 undefined）。
  const cached = setCachedDiscovery(definition.id, { at: Date.now(), sig: signature, models });
  return cached?.models ?? models;
}

/**
 * 发现全部 CLI 的模型（并行；只处理有 discover/hook 的定义）。
 *
 * @param options.force - 透传给 {@link discoverHarness}：`true` 时全部重新探测。
 * @returns `{ id, name, provider, modelKey, harnessModel, harness }[]`。
 */
export async function discoverAll(definitions, logger, options = {}) {
  const out = [];
  await Promise.all((definitions ?? []).map(async (definition) => {
    const models = await discoverHarness(definition, logger, options);
    for (const model of models) out.push({ ...model, harness: definition.id });
  }));
  return out;
}

/** 清空发现缓存（刷新入口 / 测试用）。可用性结论不受影响。 */
export function clearDiscoveryCache() {
  clearCachedDiscovery();
  WARNED.clear();
}
