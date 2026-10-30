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
  let sawPartial = false;
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

    // Claude Code `stream_event` 把真正的事件再包一层；先解包再按内容块处理。
    const source = event.type === 'stream_event' && event.event && typeof event.event === 'object'
      ? event.event
      : event;
    if (event.type === 'stream_event') sawPartial = true;
    const type = String(source.type ?? source.event ?? '').toLowerCase();
    const delta = source.delta && typeof source.delta === 'object' ? source.delta : null;
    const part = source.part && typeof source.part === 'object' ? source.part : null;
    const thinking = delta?.thinking ?? part?.thinking ?? source.thinking ?? source.reasoning;
    const text = delta?.text || part?.text
      || (typeof source.text === 'string' ? source.text : '')
      || (typeof source.content === 'string' ? source.content : '')
      || (typeof source.data === 'string' ? source.data : '');

    if (type === 'content_block_delta') {
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        thoughts = cap(thoughts + delta.thinking);
        emit('thinking', thoughts);
      } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        body = cap(body + delta.text);
        emit('answering', body);
      }
      return;
    }
    if (type === 'content_block_start' && source.content_block?.type === 'tool_use') {
      emit('tool', String(source.content_block.name ?? 'tool'));
      return;
    }
    // assistant 完整消息：有增量时正文已播过，只补工具；没有增量时补文本/思考。
    if (type === 'assistant' && source.message && Array.isArray(source.message.content)) {
      for (const block of source.message.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use') {
          emit('tool', String(block.name ?? 'tool'));
        } else if (!sawPartial && block.type === 'text' && typeof block.text === 'string') {
          body = cap(body + block.text);
          emit('answering', body);
        } else if (!sawPartial && block.type === 'thinking' && typeof block.thinking === 'string') {
          thoughts = cap(thoughts + block.thinking);
          emit('thinking', thoughts);
        }
      }
      return;
    }

    if (thinking) {
      thoughts = cap(thoughts + String(thinking));
      emit('thinking', thoughts);
      return;
    }
    if (type === 'thought') {
      if (text) {
        thoughts = cap(thoughts + String(text));
        emit('thinking', thoughts);
      }
      return;
    }
    if (type === 'text') {
      if (text) {
        body = cap(body + String(text));
        emit('answering', body);
      }
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
