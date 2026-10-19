/**
 * 构建自检：Host 半与 Client 半各自是从哪一版源码加载的。
 *
 * 为什么需要它：DSH 的 HMR **默认只热更 Client 半**（`client.js` 改完刷新即生效），
 * 改完 `index.js`（Host 半）却可能还是旧模块在跑——表现为「前端更新了、后端行为没变」，
 * 排查时极难分辨。这里把「代码是什么时候被求值的」和「文件最后改于何时」摆在一起，
 * 一眼就能看出这一半是不是旧的。
 *
 * **判定基准必须由调用方传入**：ESM 模块实例在整个 Node 进程里只求值一次，
 * 本文件里的 `Date.now()` 会一直停在**首次 import** 的时刻，插件重载后也不会更新
 * （真机踩过：两次重载后 `moduleLoadedAt` 仍是首启时间，自检永远喊「落后」）。
 * 所以时间戳由**每次重载都会重新求值的入口**（`index.js` 的顶层）捕捉后传进来。
 *
 * 只做只读探测（`statSync`），缺失文件不抛错。
 */
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根目录（本文件在 `src/` 下，向上取一层）。 */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 进程启动时刻，仅作参考（它解释不了重载，别拿它当判定基准）。 */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/**
 * 读一个文件的指纹。
 *
 * @param file - 相对包根的路径，例如 `index.js`。
 * @returns `{ file, mtime, size }`；文件不在时给出 `missing: true`。
 */
function fingerprint(file) {
  const path = join(PACKAGE_DIR, file);
  try {
    const stat = statSync(path);
    return { file, mtime: Math.round(stat.mtimeMs), size: stat.size };
  } catch {
    return { file, mtime: 0, size: 0, missing: true };
  }
}

/**
 * Host 半是否落后于磁盘上的源码。
 *
 * @param loadedAt - **入口模块被求值的时刻**（`index.js` 顶层 `Date.now()`）。
 *   必须由调用方传：本文件是共享依赖，进程内只求值一次，自己记的时刻在重载后是旧的。
 * @returns 自检对象，可直接塞进工具返回值。
 */
export function buildInfo(loadedAt) {
  const host = fingerprint('index.js');
  const client = fingerprint('client.js');
  const at = Number(loadedAt) || PROCESS_STARTED_AT;
  // mtime 晚于入口求值时刻 → 这份代码是加载之后才写的，内存里跑的是旧版。
  // 2 秒是文件系统时间戳的最粗分辨率（FAT 按 2 秒存），避免卡在边界上误报。
  const stale = host.mtime > at + 2000;
  return {
    /**
     * `false` = **需要重载插件**：磁盘上的 `index.js` 比当前加载的入口新，
     * 内存里还是旧逻辑（改完之后行为没变，多半就是这个）。
     */
    hostFresh: !stale,
    host,
    client,
    /** 入口模块被求值的时刻（每次重载都会变；不变说明根本没重新 import）。 */
    moduleLoadedAt: at,
    processStartedAt: PROCESS_STARTED_AT,
    /** 人读的一行结论，直接进日志与工具返回。 */
    note: stale
      ? `Host 半落后于磁盘源码（index.js 改于 ${new Date(host.mtime).toISOString()}，`
        + `入口加载于 ${new Date(at).toISOString()}）：请重载 model-team 插件再试`
      : 'Host 半与磁盘源码一致',
  };
}

/** 一行启动日志。 */
export function buildInfoLine(loadedAt) {
  return `model-team: ${buildInfo(loadedAt).note}`;
}
