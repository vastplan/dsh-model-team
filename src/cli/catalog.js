/**
 * CLI 侧的模型目录：只用 **CLI harness**（不依赖 DSH 的 `ctx.llm`）。
 *
 * 与插件页面同一套发现逻辑（`cliCatalogEntries`），因此：
 * - 显式 `cliModels` 优先；
 * - 各 CLI 的 `discover` 自动发现，落盘缓存（进 CLI 不重复起进程）；
 * - 不可用（没装/没配）的 CLI 不出现在目录里。
 */
import {
  cliCatalogEntries, configureCliCache, defaultCliCachePath, flushCliCache,
  registerBuiltinHarnesses, registerConfiguredHarnesses,
} from '../harness/index.js?v=0.7.3';

/** 安静日志器：CLI 的进度信息走 stderr，不污染 JSON 输出。 */
export function cliLogger(quiet = false) {
  return {
    info: (...args) => { if (!quiet) process.stderr.write(`${args.join(' ')}\n`); },
    warn: (...args) => { if (!quiet) process.stderr.write(`${args.join(' ')}\n`); },
  };
}

/**
 * 建目录。
 *
 * @param config - `loadCliConfig()` 的返回值。
 * @param options.quiet - 关掉 stderr 进度。
 * @returns `{ catalog, definitions }`
 */
export async function buildCliCatalog(config, options = {}) {
  const logger = cliLogger(options.quiet === true);
  registerBuiltinHarnesses();
  registerConfiguredHarnesses({ logger }, config);
  configureCliCache(`${defaultCliCachePath(process.env.DSH_HOME || `${process.env.HOME}/.dsh`)}`, { logger });
  const catalog = await cliCatalogEntries(
    { cliModels: config.cliModels, discoverCli: config.discoverCli !== false },
    logger,
    { discover: config.discoverCli !== false },
  );
  flushCliCache();
  return { catalog };
}

/** 目录条目 → `cli-<harness>/<id>` 规范写法。 */
export function specOf(entry) {
  return `${entry.provider}/${entry.id}`;
}
