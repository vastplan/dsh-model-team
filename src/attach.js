/**
 * 把仓库文件拼进 llm 模式的 prompt。
 *
 * **为什么需要它**：`mode=llm` 的唯一输入是 Task Packet 字符串，被调模型看不到仓库；
 * 而事后审计往往必须对着代码判断。没有这个能力时只能改用 `mode=subagent`，
 * 但子代理拿不到逐 token 的流式事件，进度窗只剩一句「子代理执行中」。
 * 两者都不理想——这里用「调用模型 + 附带文件」取中间的平衡：
 * 仍然是直接调 `ctx.llm.stream`（所以有思考/回答/工具阶段与输出片段），
 * 但把指定文件的内容放进 prompt，让模型看得到代码。
 *
 * **能力边界要写清**：它只能附上**调用方点名的文件**，模型不能自主探索
 * （不能 grep、不能顺着 import 往下追）。所以默认只附有限的几份、且带行号，
 * 由调用方决定给什么。
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** 一次能附带的文件总量上限（字符）。超出就报错而不是悄悄截断。 */
export const MAX_ATTACH_CHARS = 240_000;

/** 单份文件上限（字符）。超过的只给头部并明确标注截断。 */
export const MAX_FILE_CHARS = 80_000;

/**
 * 把文件内容渲染成带行号的块。
 *
 * 带行号是刻意的：审计结论必须能落到 `file:line`，没有行号模型只能猜。
 *
 * @param relPath - 展示用的相对路径。
 * @param text - 文件全文。
 * @returns Markdown 代码块。
 */
function renderFile(relPath, text) {
  const truncated = text.length > MAX_FILE_CHARS;
  const body = truncated ? text.slice(0, MAX_FILE_CHARS) : text;
  // 带行号：审计结论必须落到 `file:line`，没有行号模型只能猜位置。
  // 行号右对齐、宽度按总行数定，窄文件不会撑出一堆空格。
  const lines = body.replace(/\n$/, '').split('\n');
  const width = String(lines.length).length;
  const numbered = lines
    .map((line, index) => `${String(index + 1).padStart(width, ' ')}│ ${line}`)
    .join('\n');
  return [
    `### ${relPath}${truncated ? `（仅前 ${MAX_FILE_CHARS} 字符，已截断）` : ''}`,
    '```',
    numbered,
    '```',
    '',
  ].join('\n');
}

/**
 * 读若干文件并拼成 prompt 附录。
 *
 * **相对路径必须有可靠的 `cwd`**：Host 进程的工作目录不是用户的项目目录
 * （真机实测是 `/private/tmp`），拿 `process.cwd()` 兜底会把所有相对路径解析成
 * 「文件不存在」并静默跳过——附件看起来「传了但没生效」。所以这里对相对路径
 * 采取 fail-loud：缺 `cwd` 就抛错，让调用方显式传 `workspace`。
 *
 * @param specs - 文件路径列表（相对 `cwd` 或绝对路径）。
 * @param cwd - 解析相对路径的基准目录；有相对路径时必填。
 * @returns `{ appendix, files, missing }`：`appendix` 是要拼进 prompt 的文本，
 *   `files` 是实际附上的相对路径，`missing` 是读不到的路径（不抛错，交给调用方提示）。
 * @throws 有相对路径却没给 `cwd`；或总量超过 {@link MAX_ATTACH_CHARS}。
 */
export function readAttachments(specs, cwd) {
  if (!Array.isArray(specs) || !specs.length) return { appendix: '', files: [], missing: [] };
  const hasRelative = specs.some((spec) => {
    const wanted = String(spec ?? '').trim();
    return wanted && !isAbsolute(wanted);
  });
  if (hasRelative && !cwd) {
    throw new Error('files 里有相对路径，但没给 workspace：Host 的工作目录不是你的项目目录，'
      + `请传 workspace=<项目绝对路径>（当前进程 cwd 是 ${process.cwd()}）`);
  }
  const base = cwd || process.cwd();
  const blocks = [];
  const files = [];
  const missing = [];
  let total = 0;
  for (const spec of specs) {
    const wanted = String(spec ?? '').trim();
    if (!wanted) continue;
    const abs = isAbsolute(wanted) ? wanted : resolve(base, wanted);
    let text;
    try {
      // 目录直接跳过：让它落到 missing，调用方会提示「这不是文件」。
      if (!statSync(abs).isFile()) { missing.push(wanted); continue; }
      text = readFileSync(abs, 'utf8');
    } catch {
      missing.push(wanted);
      continue;
    }
    total += text.length;
    if (total > MAX_ATTACH_CHARS) {
      throw new Error(
        `附加文件总量超过 ${MAX_ATTACH_CHARS} 字符（${files.length + 1} 份已达 ${total}）：
请减少 files 数量，或先用 grep 定位到具体片段再附。`,
      );
    }
    // 展示路径优先用相对 base 的写法，读起来短；越界（../）就退回绝对路径。
    const shown = isAbsolute(wanted) ? (relative(base, abs) || abs) : wanted;
    blocks.push(renderFile(shown.startsWith('..') ? abs : shown, text));
    files.push(shown.startsWith('..') ? abs : shown);
  }
  if (!blocks.length) return { appendix: '', files, missing };
  const appendix = [
    '',
    '## attached files（只读快照，供你判断；不要假设你看不到的部分）',
    '',
    ...blocks,
  ].join('\n');
  return { appendix, files, missing };
}

/**
 * 把文件清单渲染成 prompt 里的「请读这些文件」区块（**不含正文**）。
 *
 * 给 `mode=subagent` 用：子代理有 read / grep / glob，能自己打开文件，
 * 附正文只会重复占 token（而且它看到的是调用时刻的快照，反而可能与磁盘不一致）。
 * 但**必须告诉它读哪些**——否则它不知道这次审计的范围，会乱翻或只读 packet。
 *
 * @param specs - 调用方点名的文件/目录路径。
 * @param cwd - 解析相对路径的基准；有相对路径时必填（与 {@link readAttachments} 同口径）。
 * @returns `{ appendix, files, missing }`；`files` 是解析后的展示路径。
 */
export function listAttachments(specs, cwd) {
  if (!Array.isArray(specs) || !specs.length) return { appendix: '', files: [], missing: [] };
  const hasRelative = specs.some((spec) => {
    const wanted = String(spec ?? '').trim();
    return wanted && !isAbsolute(wanted);
  });
  if (hasRelative && !cwd) {
    throw new Error('files 里有相对路径，但没给 workspace：Host 的工作目录不是你的项目目录，'
      + `请传 workspace=<项目绝对路径>（当前进程 cwd 是 ${process.cwd()}）`);
  }
  const base = cwd || process.cwd();
  const files = [];
  const missing = [];
  for (const spec of specs) {
    const wanted = String(spec ?? '').trim();
    if (!wanted) continue;
    const abs = isAbsolute(wanted) ? wanted : resolve(base, wanted);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      missing.push(wanted);
      continue;
    }
    const shown = isAbsolute(wanted) ? (relative(base, abs) || abs) : wanted;
    const label = shown.startsWith('..') ? abs : shown;
    files.push(stat.isDirectory() ? `${label}/` : label);
  }
  if (!files.length) return { appendix: '', files, missing };
  const appendix = [
    '',
    '## 本次审计涉及的文件',
    '',
    '请**先自己打开这些文件再下结论**（read / grep / glob 都可用）；',
    '下面只是范围清单，正文由你自己读——不要凭文件名猜内容。',
    '',
    ...files.map((file) => `- \`${file}\``),
  ].join('\n');
  return { appendix, files, missing };
}
