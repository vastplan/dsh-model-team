/**
 * CLI harness 子系统的对外入口：注册内置/配置定义，导出目录与执行函数。
 *
 * 使用方（`index.js`）只需要：
 *   registerBuiltinHarnesses();
 *   registerConfiguredHarnesses(ctx, config);
 *   listCatalog() 里追加 cliCatalogEntries(config, ctx.logger)；
 *   runCandidate() 里对 `entry.transport === 'cli'` 调 runHarness(...)。
 */
import { BUILTIN_HARNESSES } from './defs.js?v=0.6.5';
import { registerHarness } from './protocol.js?v=0.6.5';

export { cliCatalogEntries } from './catalog.js?v=0.6.5';
export { clearDiscoveryCache } from './discover.js?v=0.6.5';
export { runHarness } from './exec.js';
export {
  buildLaunch, clearHarnesses, fill, harnessFor, listHarnesses, registerHarness,
  resolveThinking, validateHarness,
} from './protocol.js?v=0.6.5';

/** 登记内置定义（pi / opencode）。可重复调用，覆盖同 id 的内置定义。 */
export function registerBuiltinHarnesses() {
  for (const definition of BUILTIN_HARNESSES) {
    registerHarness(definition, { replace: true, source: 'builtin' });
  }
}

/**
 * 登记配置里的 `harnesses`。单份定义坏掉只 warn，不影响插件启动与其它定义。
 *
 * @param ctx - Cordis 上下文（用 logger 报错）。
 * @param config - 插件静态配置。
 */
export function registerConfiguredHarnesses(ctx, config) {
  const list = Array.isArray(config?.harnesses)
    ? config.harnesses
    : (config?.harnesses ? [config.harnesses] : []);
  for (const raw of list) {
    try {
      registerHarness(raw, { replace: true, source: 'config' });
    } catch (error) {
      ctx?.logger?.warn?.(`model-team: harness 定义被忽略：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
