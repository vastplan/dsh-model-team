/**
 * 把 `cliModels` 配置翻成插件目录里的条目。
 *
 * 条目用合成 provider（`cli-<harness>`）与 DSH 模型并存：
 *   `cli-pi/k3@@max`  →  { provider: 'cli-pi', id: 'k3', transport: 'cli', harness: 'pi',
 *                          harnessModel: 'auto/kimi-k3', harnessProvider: 'magpie' }
 *
 * `modelKey` 决定页面把哪些路由聚成同一个执行组；要和 DSH 路由合组时，
 * 把它写成 DSH 那边的归一化 key（例如 `kimi-k3`）。
 *
 * **可用性过滤**：CLI 没装/没配（`availability` 检查失败）时，条目**不进入目录**，
 * 于是执行组的「厂商路由」下拉里不会出现它；装好后最多等缓存 TTL（30s）或重载插件。
 *
 * **范围过滤**：`options.enabled`（Set/数组）里的 harness 才会被加载；不在范围的 CLI
 * 既不发现模型、也不生成条目，调用侧也会拒绝（见 `runCandidate`）。
 */
import { harnessAvailable } from './availability.js';
import { discoverAll } from './discover.js?v=0.7.1';
import { listHarnesses } from './protocol.js?v=0.7.1';

const asString = (value, fallback = '') => (value === undefined || value === null ? fallback : String(value));

/** 不可用的 CLI 只提示一次，避免每次打开设置页都刷一行日志。 */
const HIDDEN_LOGGED = new Set();

/**
 * @param config - 插件静态配置（读 `cliModels`）。
 * @param logger - 可选日志器；未知 harness / 空 id 只 warn 跳过，不让插件起不来。
 * @param options.available - 可用性判定，默认 {@link harnessAvailable}（测试可注入）。
 * @param options.enabled - 可用 harness id 集合；缺省 = 全部。
 * @returns 目录条目数组（只含本机可用且在范围内的 CLI）。
 */
export async function cliCatalogEntries(config, logger, options = {}) {
  const definitions = listHarnesses();
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const available = typeof options.available === 'function' ? options.available : harnessAvailable;
  const enabled = options.enabled
    ? new Set(Array.from(options.enabled, (item) => String(item)))
    : null;
  const inScope = (id) => !enabled || enabled.has(id);
  const entries = [];

  for (const raw of Array.isArray(config?.cliModels) ? config.cliModels : []) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = asString(raw.tool).trim();
    if (!inScope(tool)) continue;
    const definition = byId.get(tool);
    if (!definition) {
      logger?.warn?.(`model-team: cliModels 里的 tool「${tool || '(空)'}」没有对应的 harness 定义，已跳过`);
      continue;
    }
    const id = asString(raw.id).trim();
    if (!id) {
      logger?.warn?.(`model-team: cliModels 条目缺少 id（tool=${tool}），已跳过`);
      continue;
    }

    // **不支持就不列**：没装/没配置的 CLI 不进入厂商路由。
    let usable = false;
    try { usable = available(definition, raw) === true; } catch { usable = false; }
    if (!usable) {
      const key = `${definition.id}:${id}`;
      if (!HIDDEN_LOGGED.has(key)) {
        HIDDEN_LOGGED.add(key);
        logger?.info?.(`model-team: CLI「${definition.id}」不可用，已从厂商列表隐藏（${id}）`);
      }
      continue;
    }

    const name = asString(raw.name).trim() || id;
    const efforts = Array.isArray(raw.efforts) && raw.efforts.length
      ? raw.efforts.map((item) => String(item))
      : (definition.thinking?.values ?? ['']);
    entries.push({
      // 合成 provider：不占用 DSH 的真实 provider 名字空间，也不会被 resolveModelInfo 误查。
      provider: `cli-${definition.id}`,
      id,
      name: `${name} · ${definition.label}`,
      efforts,
      defaultEffort: asString(raw.defaultEffort, definition.thinking?.default ?? ''),
      speeds: Array.isArray(raw.speeds) && raw.speeds.length ? raw.speeds.map((item) => String(item)) : [''],
      defaultSpeed: asString(raw.defaultSpeed),
      modelKey: asString(raw.modelKey).trim() || id,
      transport: 'cli',
      harness: definition.id,
      harnessModel: asString(raw.model, id),
      harnessProvider: asString(raw.provider),
      readOnly: definition.capabilities.readOnlyByDefault !== false,
    });
  }

  // 自动发现：每家 CLI 的 discover/hook；不可用的 CLI 已在 discoverHarness 里跳过。
  // 显式 cliModels 优先：同 harness + modelKey 的自动条目不再重复。
  const scopedDefinitions = enabled
    ? definitions.filter((definition) => enabled.has(definition.id))
    : definitions;
  const discovered = options.discovered
    ?? (options.discover === false ? [] : await discoverAll(scopedDefinitions, logger));
  const explicitByKey = new Map(entries.map((entry) => [`${entry.harness}:${entry.modelKey}`, entry]));
  for (const item of discovered) {
    const definition = byId.get(item.harness);
    if (!definition) continue;
    const explicit = explicitByKey.get(`${item.harness}:${item.modelKey}`);
    if (explicit) {
      // 显式条目可以覆盖模型名/路由，但 Devin 的 effort/speed 维度要补进来，
      // 否则手写的 `swe-2` 会把自动发现的 efforts/speeds 丢掉。
      if (Array.isArray(item.efforts) && item.efforts.length
        && (!Array.isArray(explicit.efforts) || explicit.efforts.length <= 1)) {
        explicit.efforts = item.efforts;
        explicit.defaultEffort = item.defaultEffort ?? explicit.defaultEffort;
      }
      if (Array.isArray(item.speeds) && item.speeds.length
        && (!Array.isArray(explicit.speeds) || explicit.speeds.length <= 1)) {
        explicit.speeds = item.speeds;
        explicit.defaultSpeed = item.defaultSpeed ?? explicit.defaultSpeed;
      }
      // 普通 harness：同 modelKey 的显式条目覆盖自动条目。
      // preserveVariants（Devin）：只跳过同一 harnessModel，保留同族其它变体。
      if (definition.discover?.preserveVariants !== true) continue;
      if (explicit.harnessModel === item.harnessModel) continue;
    }
    entries.push({
      provider: `cli-${definition.id}`,
      id: item.id,
      name: `${item.name} · ${definition.label}`,
      efforts: Array.isArray(item.efforts) && item.efforts.length ? item.efforts : (definition.thinking?.values ?? ['']),
      defaultEffort: item.defaultEffort ?? definition.thinking?.default ?? '',
      speeds: Array.isArray(item.speeds) && item.speeds.length ? item.speeds : [''],
      defaultSpeed: item.defaultSpeed ?? '',
      modelKey: item.modelKey,
      transport: 'cli',
      harness: definition.id,
      harnessModel: item.harnessModel,
      harnessProvider: item.provider,
      readOnly: definition.capabilities.readOnlyByDefault !== false,
    });
  }

  return entries;
}
