/**
 * CLI 可用性判断：只做**本机是否装好/配好**的静态检查，不跑业务提示词。
 *
 * - 主命令：绝对路径 / PATH / `availability.fallbacks`（如 `~/.local/bin/pi`）。
 * - 额外命令：`availability.commands`（devin 的 `devin`；支持 `<ENV>` 覆盖，如 `DEVIN_BIN`）。
 * - 额外文件：`availability.files`（zcode 的 `~/.zcode/cli/config.json`、devin 的随包脚本）。
 *
 * 结论**落盘缓存**（见 `cli-cache.js`）：判定一次就一直沿用，装/卸 CLI 后点设置页的
 * 「刷新」或调用 `clearAvailabilityCache()` 才重新 stat。这样进设置页不会反复探测。
 * **不判断登录态**——未登录的 CLI 仍会列出，调用时由 stderr 暴露。
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearCachedAvailability, getCachedAvailability, setCachedAvailability } from './cli-cache.js';
import { fill } from './protocol.js';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const expandHome = (value) => {
  const text = String(value ?? '');
  return text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
};

const isExecutable = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const fillPath = (value) => expandHome(fill(value, { node: process.execPath, pkgDir: PKG_DIR }));

/** 解析一个命令：绝对路径 → PATH → fallbacks；找不到返回空串。 */
function resolveCommand(command, fallbacks, env) {
  const wanted = fillPath(command);
  if (!wanted) return '';
  if (wanted.includes('/')) return isExecutable(wanted) ? wanted : '';
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, wanted);
    if (isExecutable(candidate)) return candidate;
  }
  for (const fallback of fallbacks ?? []) {
    const candidate = fillPath(fallback);
    if (isExecutable(candidate)) return candidate;
  }
  return '';
}

function checkAvailability(definition, env) {
  const availability = definition.availability ?? {};
  if (!resolveCommand(definition.command, availability.fallbacks, env)) return false;

  for (const command of availability.commands ?? []) {
    const override = command.env ? env[command.env] : '';
    if (!resolveCommand(override || command.command, command.fallbacks, env)) return false;
  }

  for (const file of availability.files ?? []) {
    if (!existsSync(fillPath(file))) return false;
  }

  return true;
}

/**
 * 判断一个 harness 在本机是否可用。
 *
 * 结论进 `cli-cache`：命中就返回，**不设置过期时间**；要重新探测（装好 CLI 之后）
 * 调 {@link clearAvailabilityCache} 或整份刷新（Host 的 `refreshCli`）。
 *
 * @param definition - 归一化定义。
 * @param entry - 目录条目（当前未使用，留给按条目覆盖）。
 * @param env - 环境变量（默认 `process.env`）。
 * @param now - 写入缓存时的时间戳（测试注入）。
 * @returns 可用为 true。
 */
export function harnessAvailable(definition, entry, env = process.env, now = Date.now()) {
  void entry;
  const key = definition.id;
  const hit = getCachedAvailability(key);
  if (hit) return hit.ok;
  const ok = checkAvailability(definition, env);
  setCachedAvailability(key, ok, now);
  return ok;
}

/** 清空可用性缓存（刷新入口 / 测试用）；之后第一次判定会重新 stat。 */
export function clearAvailabilityCache() {
  clearCachedAvailability();
}
