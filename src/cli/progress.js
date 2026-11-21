/**
 * CLI 进度输出：把 run 的进度事件渲染成 **stderr 上的实时流**（stdout 只留 JSON）。
 *
 * 与插件页的进度窗同一份信息（`start` / `phase` / `done`），但更克制：
 * - `phase` 只在**阶段切换**或距上次输出超过 `intervalMs` 时打一行，避免刷屏；
 * - 片段按单行截断到 `snippetChars`，尾部保留（模型最近说的话才有信息量）；
 * - `--quiet` 全关，`--no-stream` 只保留起止行。
 *
 * 为什么不用「原地重绘一行」：调用方常常是别的 agent 的管道/日志，`\r` 覆盖会变成乱码。
 */

/** 把片段压成单行并截尾。 */
export function clipSnippet(text, max = 70) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > max ? `…${flat.slice(-max)}` : flat;
}

/**
 * @param options.write - 输出函数（默认 stderr）。
 * @param options.quiet - 全关。
 * @param options.stream - false 时只打 start / done（默认 true）。
 * @param options.intervalMs - 同一阶段的保底刷新间隔（默认 3000ms）。
 * @param options.snippetChars - 片段长度上限（默认 70）。
 * @param options.now - 时间源（测试注入）。
 * @returns `(event) => void`
 */
export function createProgressPrinter(options = {}) {
  const write = typeof options.write === 'function'
    ? options.write
    : (line) => process.stderr.write(`${line}\n`);
  const quiet = options.quiet === true;
  const stream = options.stream !== false;
  const intervalMs = Number(options.intervalMs) || 3000;
  const snippetChars = Number(options.snippetChars) || 70;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const last = new Map();

  return (event) => {
    if (quiet || !event) return;
    if (event.type === 'start') {
      write(`▶ ${event.model}${event.tool ? ` · ${event.tool}` : ''}`);
      return;
    }
    if (event.type === 'phase') {
      if (!stream) return;
      const key = String(event.model ?? '');
      const phase = String(event.phase ?? '');
      const at = now();
      const previous = last.get(key) ?? { phase: '', at: 0 };
      // 阶段切换必打；同阶段按 interval 限流。
      if (phase === previous.phase && at - previous.at < intervalMs) return;
      last.set(key, { phase, at });
      const snippet = clipSnippet(event.snippet, snippetChars);
      write(`  · ${key} [${phase || '?'}]${snippet ? ` ${snippet}` : ''}`);
      return;
    }
    if (event.type === 'done') {
      const ok = event.status === 'done';
      const mark = ok ? '✔' : event.status === 'no-result' ? '○' : '✘';
      write(`  ${mark} ${event.model} ${event.seconds ?? '?'}s${ok ? '' : ` (${event.status})`}`);
    }
  };
}
