/**
 * CLI 信息的磁盘缓存：自动发现的模型列表 + 本机可用性。
 *
 * 为什么落盘：自动发现要起外部进程（`pi --list-models`、`opencode models`…），
 * 本机 8 家并行一轮要 2～3 秒。早先这份结果只在内存里（30 分钟 TTL），插件一重载、
 * DSH 一重启就全丢，于是**每次打开设置页都重新探测一遍**，页面卡在「加载中」。
 *
 * 现在的契约（页面「刷新」按钮依赖它）：
 * - 命中即用，**不会自动过期**；点刷新（`refreshCli`）才重新探测；
 * - 落盘位置 `$DSH_HOME/model-team/cli-cache.json`，跨插件重载 / DSH 重启保留；
 * - 坏文件、版本不符、结构不对一律按空缓存处理——缓存坏了最多慢一点，不能让设置页打不开；
 * - 写盘原子（tmp → rename），不会留下半个 JSON。
 *
 * 没有 `configureCliCache()` 时退化成纯内存缓存（单测与没配置数据目录的场景）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 缓存结构版本；字段口径变化时递增，旧文件按空缓存处理。 */
export const CLI_CACHE_VERSION = 1;

/** 多次写入合并成一次落盘（一次刷新会给 8 家各写一条）。 */
const SAVE_DELAY_MS = 150;

/** 落盘时保留的模型字段：多余字段（函数、循环引用）一律不写。 */
const MODEL_KEYS = [
  'id', 'name', 'provider', 'modelKey', 'harnessModel',
  'efforts', 'speeds', 'defaultEffort', 'defaultSpeed', 'primary',
];

function emptyState() {
  return { version: CLI_CACHE_VERSION, updatedAt: 0, availability: {}, discovery: {} };
}

let file = '';
let logger = null;
let state = emptyState();
let timer = null;
let warned = false;

const asNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const asString = (value) => (value === undefined || value === null ? '' : String(value));

/** 默认落点：与账本、会话日志同属 `$DSH_HOME/model-team/`。 */
export function defaultCliCachePath(dshHome) {
  return join(dshHome, 'model-team', 'cli-cache.json');
}

/** 当前配置文件路径；空串表示纯内存模式（没调用过 `configureCliCache`）。 */
export function cliCacheFile() {
  return file;
}

/** 把一条模型记录收敛成可安全落盘 / 读回的纯数据。 */
function sanitizeModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = asString(raw.id).trim();
  if (!id) return null;
  const model = { id };
  for (const key of MODEL_KEYS) {
    if (key === 'id') continue;
    if (raw[key] === undefined) continue;
    model[key] = Array.isArray(raw[key]) ? raw[key].map(String) : raw[key];
  }
  return model;
}

/** 读盘 → 归一化；任何异常都回落成空缓存（并只 warn 一次）。 */
function readState(target) {
  if (!target || !existsSync(target)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(target, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyState();
    if (asNumber(raw.version) !== CLI_CACHE_VERSION) return emptyState();

    const availability = {};
    if (raw.availability && typeof raw.availability === 'object' && !Array.isArray(raw.availability)) {
      for (const [id, value] of Object.entries(raw.availability)) {
        if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') continue;
        availability[id] = { ok: value.ok, at: asNumber(value.at) };
      }
    }

    const discovery = {};
    if (raw.discovery && typeof raw.discovery === 'object' && !Array.isArray(raw.discovery)) {
      for (const [id, value] of Object.entries(raw.discovery)) {
        if (!value || typeof value !== 'object' || !Array.isArray(value.models)) continue;
        // **空数组也要保留**：某家 CLI 发现失败（或确实没有模型）时，记下「探测过」，
        // 否则每次进程启动都会把它重新跑一遍——那正是「进页面总在刷新」的来源。
        const models = value.models.map(sanitizeModel).filter(Boolean);
        discovery[id] = { at: asNumber(value.at), sig: asString(value.sig), models };
      }
    }

    return {
      version: CLI_CACHE_VERSION,
      updatedAt: asNumber(raw.updatedAt),
      availability,
      discovery,
    };
  } catch (error) {
    warnOnce(`CLI 缓存读取失败，按空缓存处理：${error instanceof Error ? error.message : String(error)}`);
    return emptyState();
  }
}

function warnOnce(message) {
  if (warned) return;
  warned = true;
  try { logger?.warn?.(`model-team: ${message}`); } catch { /* 日志器自己坏了也不影响缓存 */ }
}

function writeNow() {
  if (!file) return false;
  const target = file;
  const temp = `${target}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temp, JSON.stringify(state));
    renameSync(temp, target);
    return true;
  } catch (error) {
    warnOnce(`CLI 缓存写入失败（下次照旧重新探测）：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function scheduleSave() {
  if (!file || timer) return;
  timer = setTimeout(() => {
    timer = null;
    writeNow();
  }, SAVE_DELAY_MS);
  // 不因为一个待落盘的缓存把进程吊住（测试 / CLI 直接 import 时尤其明显）。
  timer.unref?.();
}

/** 立即把内存里的缓存写盘（刷新完 / 测试里用）。 */
export function flushCliCache() {
  if (timer) clearTimeout(timer);
  timer = null;
  return writeNow();
}

/**
 * 配置文件路径并载入现有缓存。
 *
 * @param target - JSON 文件绝对路径；空串 = 纯内存。
 * @param options.logger - 读盘/写盘出问题时用；只报一次。
 * @returns 载入后的缓存状态（调用方可据此打启动日志）。
 */
export function configureCliCache(target, options = {}) {
  if (timer) clearTimeout(timer);
  timer = null;
  warned = false;
  file = asString(target).trim();
  logger = options.logger ?? null;
  state = readState(file);
  return state;
}

/** 回到「纯内存、空缓存」状态（测试与热重载用）。 */
export function resetCliCache() {
  if (timer) clearTimeout(timer);
  timer = null;
  file = '';
  logger = null;
  warned = false;
  state = emptyState();
}

/** 上一次成功刷新的时间（毫秒）；0 = 还没探测过。 */
export function cliCacheUpdatedAt() {
  return asNumber(state.updatedAt);
}

/** 启动日志用的一句话概览。 */
export function cliCacheSummary() {
  const availability = Object.values(state.availability);
  const discovered = Object.values(state.discovery);
  return {
    file,
    updatedAt: cliCacheUpdatedAt(),
    checked: availability.length,
    available: availability.filter((item) => item.ok).length,
    discoveredHarnesses: discovered.length,
    models: discovered.reduce((total, item) => total + item.models.length, 0),
  };
}

/** 命中的可用性结论；没有缓存返回 null。 */
export function getCachedAvailability(id) {
  const key = asString(id);
  const hit = state.availability[key];
  return hit ? { ok: hit.ok === true, at: asNumber(hit.at) } : null;
}

/** 记下可用性结论（落盘由 `flushCliCache` 或 150ms 合并写完成）。 */
export function setCachedAvailability(id, ok, at = Date.now()) {
  const key = asString(id);
  if (!key) return null;
  const entry = { ok: ok === true, at: asNumber(at) || Date.now() };
  state.availability[key] = entry;
  state.updatedAt = Math.max(cliCacheUpdatedAt(), entry.at);
  scheduleSave();
  return entry;
}

/** 清掉可用性缓存（刷新时会先清再探测）。 */
export function clearCachedAvailability() {
  state.availability = {};
  scheduleSave();
}

/** 命中的发现结果；要求签名一致（命令/解析器改过就视为未命中）。 */
export function getCachedDiscovery(id, signature) {
  const key = asString(id);
  const hit = state.discovery[key];
  if (!hit) return null;
  if (signature !== undefined && hit.sig !== asString(signature)) return null;
  return { at: asNumber(hit.at), sig: hit.sig, models: hit.models };
}

/** 记下一家 CLI 的发现结果。 */
export function setCachedDiscovery(id, entry) {
  const key = asString(id);
  if (!key || !entry) return null;
  const models = (Array.isArray(entry.models) ? entry.models : []).map(sanitizeModel).filter(Boolean);
  const value = { at: asNumber(entry.at) || Date.now(), sig: asString(entry.sig), models };
  state.discovery[key] = value;
  state.updatedAt = Math.max(cliCacheUpdatedAt(), value.at);
  scheduleSave();
  return value;
}

/** 清掉全部发现结果（可用性结论保留）。 */
export function clearCachedDiscovery() {
  state.discovery = {};
  scheduleSave();
}

/** 清掉整份 CLI 信息（可用性 + 发现）。刷新入口先调它。 */
export function clearCliInfoCache() {
  state = emptyState();
  scheduleSave();
}

/** 记一次「已刷新」时间：即便这台机器一家 CLI 都没装，页面也该显示刷新过。 */
export function touchCliCache(at = Date.now()) {
  state.updatedAt = asNumber(at) || Date.now();
  scheduleSave();
  return state.updatedAt;
}
