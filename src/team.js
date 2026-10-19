/**
 * 模型名单：支持同一 model 以不同思考强度多次参与。
 *
 * 条目形态：
 *   - `"provider/model"`              → 用 provider 默认思考强度
 *   - `"provider/model@@high"`        → 指定思考强度（**双 @**）
 *   - `{ model, reasoningEffort }`    → 同上，对象写法（页面表单用这个）
 *
 * 「同一个 model 两条不同强度」是合法的两条名单项，调用时会各跑一次、
 * 账本里按 `model@@effort` 区分。
 *
 * **为什么是双 `@@`**：模型 id 本身可能带 `@`（例如 `grok/grok-4.7@500k` 的 500k 是
 * 上下文窗口标注，不是思考强度）。早先用 `lastIndexOf('@')` 切分，这类 id 会被劈成
 * 「model=grok/grok-4.7 + effort=500k」，整场报「不在已注册路由里」。`@@` 在模型 id
 * 里不会出现，所以它没有歧义。
 *
 * 旧写法（单个 `@`）保留**读兼容**，但只在「整串本身解析不到、且切开后的左半边
 * 确实是一个已注册模型」时才回退——这样 id 自带 `@` 的条目仍整串命中，不会被误切。
 */

/** 双 `@` 是规范分隔符。 */
export const EFFORT_SEPARATOR = '@@';

/**
 * 按双 `@@` 切开 `provider/model@@effort`。
 *
 * @param text - 名单项原文。
 * @param known - 「这一串是不是已注册模型」的谓词；给了才启用旧写法回退。
 * @returns `{ head, effort }`；没有分隔符时 effort 为空串。
 */
export function splitEffort(text, known) {
  const raw = String(text ?? '').trim();
  const doubled = raw.lastIndexOf(EFFORT_SEPARATOR);
  if (doubled > 0) {
    return { head: raw.slice(0, doubled), effort: raw.slice(doubled + EFFORT_SEPARATOR.length) };
  }
  // 旧写法兼容：只在「整串认不出、切完左半边认得出」时才把单个 `@` 当分隔符。
  if (typeof known === 'function' && !known(raw)) {
    const single = raw.lastIndexOf('@');
    if (single > 0) {
      const head = raw.slice(0, single);
      if (known(head)) return { head, effort: raw.slice(single + 1) };
    }
  }
  return { head: raw, effort: '' };
}

/** 拼回规范写法：有强度用 `@@`，没有就原样。 */
export function joinEffort(head, effort) {
  const spec = String(head ?? '').trim();
  const level = String(effort ?? '').trim();
  return level ? `${spec}${EFFORT_SEPARATOR}${level}` : spec;
}

/**
 * 把一条字符串名单项解析成 `{ provider, model, reasoningEffort }`。
 *
 * @param text - `provider/model` 或 `provider/model@@effort`。
 * @param known - 目录谓词，用于旧单 `@` 写法的消歧（可选）。
 */
export function parseSpec(text, known) {
  const { head, effort } = splitEffort(text, known);
  const [provider, model] = splitProvider(head);
  return { provider, model, reasoningEffort: effort };
}

/** 把一条名单项解析成 `{ provider, model, reasoningEffort }`。 */
export function parseEntry(entry, known) {
  if (entry && typeof entry === 'object') {
    const spec = String(entry.model ?? '').trim();
    if (!spec) throw new Error('名单项缺少 model');
    // 对象写法的 `model` 字段也可能混进 `@@effort`（页面早期版本存过），一并切掉；
    // 显式给了 `reasoningEffort` 就以它为准。
    const { head, effort } = splitEffort(spec, known);
    const [provider, model] = splitProvider(head);
    const declared = String(entry.reasoningEffort ?? '').trim();
    return { provider, model, reasoningEffort: declared || effort };
  }
  const text = String(entry ?? '').trim();
  if (!text) throw new Error('名单项为空');
  return parseSpec(text, known);
}

/**
 * 切出 provider 与 model。
 *
 * **模型 id 自己可能带 `/`**（例如 magpie 的 `group/auto-kimi-k3`），所以不能简单按第一个
 * `/` 切。这里只做保守切分（第一段当 provider），真正的判断交给 `resolveTeam` 的目录匹配：
 * 匹配时会再用整串命中一次，所以「其实没有 provider 前缀」的写法也能成立。
 */
function splitProvider(spec) {
  const slash = spec.indexOf('/');
  if (slash <= 0) return [undefined, spec];
  return [spec.slice(0, slash), spec.slice(slash + 1)];
}

/** 名单项的稳定 id：`provider/model@@effort`，用于去重与错误提示。 */
export function entryId(entry) {
  const spec = entry.provider ? `${entry.provider}/${entry.model}` : entry.model;
  return joinEffort(spec, entry.reasoningEffort);
}

/** 「这一串是不是已注册模型」的谓词（provider 前缀可写可不写）。 */
function catalogKnows(catalog) {
  return (spec) => catalog.some(
    (entry) => entry.id === spec || `${entry.provider}/${entry.id}` === spec,
  );
}

/**
 * 把配置名单解析成可调用清单。
 *
 * 未点名时用 `config.models`（缺省 = 所有已注册 provider 的全部模型，每家用默认强度）。
 * 点名的必须在已注册路由里找得到，否则响亮报错并列出可用项——不静默跳过。
 *
 * **匹配顺序**（模型 id 可能自带 `/`）：
 * 1. 整串当作 model id，在任一 provider 下找；
 * 2. 找得到就再要求 provider 前缀一致（写了前缀就必须对得上）；
 * 3. 都不中才算未知。
 */
export function resolveTeam(selection, catalog, fallback = []) {
  const raw = Array.isArray(selection) && selection.length ? selection : fallback;
  if (!raw.length) {
    return catalog.map((entry) => ({ ...entry, reasoningEffort: '' }));
  }
  const known = catalogKnows(catalog);
  const team = [];
  const unknown = [];
  const seen = new Set();
  for (const item of raw) {
    const spec = parseEntry(item, known);
    const resolved = matchEntry(spec, catalog);
    if (!resolved) {
      unknown.push(entryId(spec));
      continue;
    }
    const id = entryId(resolved);
    if (seen.has(id)) continue;
    seen.add(id);
    team.push(resolved);
  }
  if (unknown.length) {
    const available = catalog.map((entry) => `${entry.provider}/${entry.id}`).join(', ') || '（无已注册模型）';
    throw new Error(`名单里有模型不在 DSH 已注册路由里：${unknown.join(', ')}；可用：${available}`);
  }
  return team;
}

/** 在目录里定位一条名单项；`provider` 写了就必须一致。 */
function matchEntry(spec, catalog) {
  const full = spec.provider ? `${spec.provider}/${spec.model}` : spec.model;
  // ① 整串命中（模型 id 自带 `/` 时走这条）
  const byFull = catalog.find((entry) => entry.id === full);
  if (byFull) return { provider: byFull.provider, model: byFull.id, name: byFull.name, reasoningEffort: spec.reasoningEffort };
  // ② 按 provider + model 命中
  if (spec.provider) {
    const byPair = catalog.find((entry) => entry.provider === spec.provider && entry.id === spec.model);
    if (byPair) return { provider: byPair.provider, model: byPair.id, name: byPair.name, reasoningEffort: spec.reasoningEffort };
    return null;
  }
  // ③ 裸 model id
  const byModel = catalog.find((entry) => entry.id === spec.model);
  if (byModel) return { provider: byModel.provider, model: byModel.id, name: byModel.name, reasoningEffort: spec.reasoningEffort };
  return null;
}
