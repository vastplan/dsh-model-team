/**
 * CLI 可用性判断：只做**本机是否装好/配好**的静态检查，不跑业务提示词。
 *
 * - 主命令：绝对路径 / PATH / `availability.fallbacks`（如 `~/.local/bin/pi`）。
 * - 额外命令：`availability.commands`（devin 的 `devin`；支持 `<ENV>` 覆盖，如 `DEVIN_BIN`）。
 * - 额外文件：`availability.files`（zcode 的 `~/.zcode/cli/config.json`、devin 的随包脚本）。
 *
 * 结果缓存 {@link AVAILABILITY_TTL_MS}，避免每次打开设置页都 stat 一遍；
 * **不判断登录态**——未登录的 CLI 仍会列出，调用时由 stderr 暴露。
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fill } from './protocol.js';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 可用性缓存 TTL：装完 CLI 后最多等这么久（或重载插件）就会出现。 */
export const AVAILABILITY_TTL_MS = 30_000;

const CACHE = new Map();

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
 * @param definition - 归一化定义。
 * @param entry - 目录条目（当前未使用，留给按条目覆盖）。
 * @param env - 环境变量（默认 `process.env`）。
 * @param now - 当前时间（测试注入）。
 * @returns 可用为 true。
 */
export function harnessAvailable(definition, entry, env = process.env, now = Date.now()) {
  void entry;
  const key = definition.id;
  const hit = CACHE.get(key);
  if (hit && now - hit.at < AVAILABILITY_TTL_MS) return hit.ok;
  const ok = checkAvailability(definition, env);
  CACHE.set(key, { ok, at: now });
  return ok;
}

/** 清空可用性缓存（测试用）。 */
export function clearAvailabilityCache() {
  CACHE.clear();
}
