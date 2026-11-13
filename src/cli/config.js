/**
 * CLI 配置：harness 定义、显式 cliModels、默认名单、账本/日志落点。
 *
 * 落点优先级（与旧 CLI 的「数据根」口径一致）：
 *   `--config <path>` → `$MODEL_TEAM_CLI_CONFIG` → `~/.model-team/cli.json` → 空配置。
 *
 * **默认名单兜底**：旧 CLI 靠 `models.json` 的 `default_models`；这里同样要求
 * 显式名单——没有就报错并给出示例，绝不「默认跑全目录」（那是几十家、真金白银）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 机器级数据根（与旧 CLI 的 `MODEL_TEAM_HOME` 同一约定）。 */
export function dataRoot() {
  const fromEnv = String(process.env.MODEL_TEAM_HOME ?? '').trim();
  return fromEnv || join(homedir(), '.model-team');
}

/** 默认配置文件路径。 */
export function defaultConfigPath() {
  return join(dataRoot(), 'cli.json');
}

/**
 * 读配置。文件不存在返回空配置；JSON 坏了直接报错（静默吞掉会让「名单没生效」查不出来）。
 *
 * @param explicitPath - `--config` 的值；空串走 env / 默认。
 * @returns 归一化后的配置对象。
 */
export function loadCliConfig(explicitPath = '') {
  const fromFlag = String(explicitPath ?? '').trim();
  const fromEnv = String(process.env.MODEL_TEAM_CLI_CONFIG ?? '').trim();
  const path = fromFlag || fromEnv || defaultConfigPath();
  const required = Boolean(fromFlag || fromEnv);
  if (!existsSync(path)) {
    if (required) throw new Error(`配置文件不存在：${path}`);
    return { path, exists: false, harnesses: [], cliModels: [], discoverCli: true, defaultModels: [] };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${path}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`配置文件顶层必须是对象：${path}`);
  }
  return {
    path,
    exists: true,
    harnesses: Array.isArray(raw.harnesses) ? raw.harnesses : [],
    cliModels: Array.isArray(raw.cliModels) ? raw.cliModels : [],
    discoverCli: raw.discoverCli !== false,
    defaultModels: Array.isArray(raw.defaultModels) ? raw.defaultModels.map(String) : [],
    ledgerPath: String(raw.ledgerPath ?? ''),
    runsRoot: String(raw.runsRoot ?? ''),
  };
}

/** 示例配置文件内容（错误提示里直接给，用户照抄即可）。 */
export const CONFIG_EXAMPLE = JSON.stringify({
  defaultModels: ['cli-claude/claude-sonnet-5-5-high', 'cli-agy/claude-opus-5-5-high'],
  cliModels: [],
  discoverCli: true,
}, null, 2);
