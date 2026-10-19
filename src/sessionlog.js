/**
 * 会话落盘：**与 model-team 技能同一套规则**（`runs/<场次ID>/`）。
 *
 * 技能侧规定（SKILL.md「单场会话日志落在数据根的 runs/<场次ID>/」）：
 * - 开场先快照 Task Packet 原稿（`packet.txt`）与实际提示词（`prompt.md`）；
 * - 每家模型每一跳一个会话日志 `<模型>.<跳标签>.0.json`；
 * - 调度留痕 `<模型>.balance.json`；
 * - **同一场次重复跑不覆盖快照**（内容变了带时间戳另存），并发场次各写各的目录。
 *
 * 单份会话日志的形状（与技能侧 `InvokeResult` 落盘一致，备查时两边能对着看）：
 * `{ started, finished, duration_s, duration_min, tool, model, thinking, exit_code,
 *    stop_note, usage, cost, answer, messages, unmapped, markers }`
 *
 * 这里少一样东西：退出码。DSH 里我们直接拿 chunk 流，没有子进程退出码，
 * 所以 `exit_code` 按"成功 0 / 失败 1"落，真因写在 `stop_note`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 本地时间戳，与技能侧 `localStamp()` 同格式（`YYYY-MM-DD HH:mm:ss+08:00`）。 */
export function localStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${hours}:${minutes}`;
}

/** 场次 id：`日期-时分秒-随机后缀`（与技能侧同一形状，便于两边目录并排看）。 */
export function newRunId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const suffix = Math.random().toString(16).slice(2, 8);
  return `${stamp}-${suffix}`;
}

/** 文件名里不能出现的字符换成 `-`（模型 id 带 `/`）。 */
function safeName(text) {
  return String(text ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * 取一个还没被占用的路径：同名文件已存在时在扩展名前递增序号。
 *
 * 会话日志是**逐次调用**的证据，不是可覆盖的快照：同名就换名，不能静默盖掉。
 * 正常文件名里已经带了模型、路由、强度与槽位，走到这里只可能是同一槽位在同一场
 * 里真的被调了两次（重试/并发），此时 `n` 会给出 `.1.json`、`.2.json`。
 */
function uniquePath(dir, name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = join(dir, name);
  for (let index = 1; index <= 999 && existsSync(candidate); index += 1) {
    candidate = join(dir, `${stem}.${index}${ext}`);
  }
  return candidate;
}

/**
 * 一场的会话目录：`<runsRoot>/<场次ID>/`。
 * @param runsRoot - 数据根下的 `runs/` 目录。
 * @param runId - 场次 id。
 */
export function openRunDir(runsRoot, runId) {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 快照一次输入，**同场次不覆盖**：同名文件已存在且内容不同时带时间戳另存。
 * @returns 实际写入的文件名。
 */
export function snapshotInput(dir, name, content) {
  const target = join(dir, name);
  if (!existsSync(target)) {
    writeFileSync(target, content, 'utf8');
    return name;
  }
  if (readFileSync(target, 'utf8') === content) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const stamped = `${stem}.${newRunId().split('-').slice(-1)[0]}${ext}`;
  writeFileSync(join(dir, stamped), content, 'utf8');
  return stamped;
}

/**
 * 落一份模型会话日志。
 *
 * 文件名：`<模型>.<路由>-<工具>.<强度>.<槽位>.0.json`。强度与槽位不可省：
 * 同场同模型可能以两个强度各跑一次，也可能被列表项与执行组胜出各调一次。
 * 真的撞名时 {@link uniquePath} 会加序号另存，**不覆盖**。
 *
 * @param dir - 场次目录。
 * @param call - 一次调用的记录。
 * @returns 落盘路径。
 */
export function writeSessionLog(dir, call) {
  const modelId = safeName(call.model);
  const hopLabel = safeName(call.hop ?? 'dsh');
  // 强度与槽位必须进文件名：同一个模型可以在同一场里以两个强度各跑一次
  // （`src/team.js` 明确允许），也可以被列表项与执行组胜出各调一次（账本为此
  // 加了 `slot` 主键）。早先文件名只有模型 + hop，后写的会覆盖先写的。
  const effort = safeName(call.reasoningEffort ?? '') || 'default';
  const slot = safeName(call.groupId ?? '') || 'list';
  const path = uniquePath(dir, `${modelId}.${hopLabel}.${effort}.${slot}.0.json`);
  const minutes = call.durationS > 0 ? Math.round((call.durationS / 60) * 10) / 10 : 0;
  const document = {
    started: call.started,
    finished: call.finished,
    duration_s: call.durationS,
    duration_min: minutes,
    tool: call.tool ?? 'dsh',
    model: call.model,
    thinking: call.reasoningEffort ?? '',
    exit_code: call.status === 'failed' ? 1 : 0,
    stop_note: call.status === 'failed' ? (call.error ?? '') : '',
    usage: {
      input: call.usage?.input ?? 0,
      output: call.usage?.output ?? 0,
      cache_write: call.usage?.cacheWrite ?? 0,
      cache_read: call.usage?.cacheRead ?? 0,
      reasoning: call.usage?.reasoning ?? 0,
    },
    cost: null,
    answer: call.text ?? '',
    messages: call.messages ?? [],
    unmapped: [],
    markers: { provider: call.provider, reasoning_effort: call.reasoningEffort ?? '', status: call.status },
  };
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * 落一份调度留痕（`<模型>.<路由>.<强度>.<槽位>.balance.json`）。
 *
 * 技能侧记的是均衡调度的策略快照与执行序；DSH 里没有那套调度，
 * 但"这一跳为什么被选中/跳过"同样要有据可查，所以记名单与路由的来源。
 * 文件名同样带路由/强度/槽位：同一模型在不同厂商、不同强度、不同组里各跑一次时，
 * 早先只按模型命名，后写覆盖先写，留痕会凭空消失。
 */
export function writeBalanceLog(dir, call) {
  const modelId = safeName(call.model);
  const provider = safeName(call.provider ?? '') || 'provider';
  const effort = safeName(call.reasoningEffort ?? '') || 'default';
  const slot = safeName(call.groupId ?? '') || 'list';
  const path = uniquePath(dir, `${modelId}.${provider}.${effort}.${slot}.balance.json`);
  const document = {
    policy: {
      at: new Date().toISOString(),
      source: 'dsh-ctx-llm',
      provider: call.provider,
      reasoning_effort: call.reasoningEffort ?? '',
      note: 'DSH 侧没有均衡调度；此文件记录本次调用的路由来源，便于与技能侧账本对账。',
    },
    order: [
      {
        order: 1,
        attempt: `${call.provider}/${call.model}`,
        tool: call.tool ?? 'dsh',
        provider: call.provider,
        note: call.reasoningEffort ? `effort=${call.reasoningEffort}` : 'provider 默认强度',
      },
    ],
  };
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}
