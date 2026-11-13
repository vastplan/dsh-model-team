/**
 * CLI 参数解析：只做「够用且可预期」的那一套。
 *
 * 形态：
 *   `--key value` / `--key=value` / `--flag`（布尔）/ 重复 `--with a --with b`。
 * 值以 `-` 开头的会当成下一个 flag（`--packet -` 用 `--packet=-` 或 stdin 约定）。
 *
 * 为什么不用现成库：插件没有 CLI 依赖，而这里只需要几十行；少一个依赖就少一处
 * 「装到别的项目里跑不起来」。
 */

/**
 * @param argv - `process.argv.slice(2)`。
 * @returns `{ command, flags: Map<string,string>, repeated: Map<string,string[]>, positionals: string[] }`
 */
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const flags = new Map();
  const repeated = new Map();
  const positionals = [];
  let command = '';

  const pushRepeated = (key, value) => {
    const bucket = repeated.get(key) ?? [];
    bucket.push(value);
    repeated.set(key, bucket);
  };

  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (!token.startsWith('-') || token === '-') {
      if (!command) command = token;
      else positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      flags.set(key, value);
      pushRepeated(key, value);
      continue;
    }
    const next = list[index + 1];
    if (next !== undefined && (!next.startsWith('-') || next === '-')) {
      flags.set(token, next);
      pushRepeated(token, next);
      index += 1;
    } else {
      flags.set(token, '1');
      pushRepeated(token, '1');
    }
  }

  return { command, flags, repeated, positionals };
}

/** 取 flag 原值；没给返回空串。 */
export function flagOf(parsed, name, fallback = '') {
  return parsed.flags.get(name) ?? fallback;
}

/** 布尔 flag。`--no-xxx` 由调用方自己判。 */
export function hasFlag(parsed, name) {
  return parsed.flags.has(name);
}

/** 取数字 flag；非法值回落默认。 */
export function numberFlag(parsed, name, fallback = 0) {
  const raw = parsed.flags.get(name);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** 逗号分隔列表 flag；`--models a,b --models c` 也支持。 */
export function listFlag(parsed, name) {
  const values = parsed.repeated.get(name) ?? [];
  return values
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}
