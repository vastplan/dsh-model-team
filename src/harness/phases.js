/**
 * 把 CLI 的 JSONL/文本行翻成进度窗认识的三个阶段：thinking / tool / answering。
 *
 * 这里只做**尽力而为**的实时播报；最终正文与用量以 `parse.js` 的整体解析为准。
 * 认不出的行一律当正文喂给 answering，不丢内容。
 */

/** 进度片段最多保留多少字符（进度窗只显示尾部，太长纯属浪费内存）。 */
const MAX_SNIPPET = 4000;

const cap = (text) => (text.length > MAX_SNIPPET ? text.slice(-MAX_SNIPPET) : text);

/**
 * @param onPhase - `(name, snippet) => void`；异常一律吞掉，可观测性不能拖垮执行。
 * @returns `{ feed, body, thoughts }`。
 */
export function createPhaseEmitter(onPhase) {
  let body = '';
  let thoughts = '';
  const emit = (name, snippet) => {
    try { onPhase?.(name, snippet); } catch { /* 忽略 */ }
  };

  const feed = (line) => {
    const raw = String(line ?? '').trim();
    if (!raw) return;

    let event = null;
    try { event = JSON.parse(raw); } catch { event = null; }
    if (!event || typeof event !== 'object') {
      body = cap(body + raw);
      emit('answering', body);
      return;
    }

    const type = String(event.type ?? event.event ?? '').toLowerCase();
    const delta = event.delta && typeof event.delta === 'object' ? event.delta : null;
    const part = event.part && typeof event.part === 'object' ? event.part : null;
    const thinking = delta?.thinking ?? part?.thinking ?? event.thinking ?? event.reasoning;
    const text = delta?.text ?? part?.text
      ?? (typeof event.text === 'string' ? event.text : '')
      ?? (typeof event.content === 'string' ? event.content : '');

    if (thinking) {
      thoughts = cap(thoughts + String(thinking));
      emit('thinking', thoughts);
      return;
    }
    if (type.includes('thinking') || type.includes('reasoning')) {
      if (text) {
        thoughts = cap(thoughts + String(text));
        emit('thinking', thoughts);
      }
      return;
    }
    if (type.includes('tool')) {
      emit('tool', String(event.name ?? part?.tool ?? event.tool ?? event.tool_name ?? ''));
      return;
    }
    if (text) {
      body = cap(body + String(text));
      emit('answering', body);
    }
    // usage / message_end / step_start 之类不播报，交给整体解析。
  };

  return {
    feed,
    get body() { return body; },
    get thoughts() { return thoughts; },
  };
}
