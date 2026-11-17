/**
 * 审查点（review point）：记住「某个工作空间上一次审到哪个提交」。
 *
 * 动机：每次审计都从头读整个仓库既慢又会重复报同一批结论。审查点把审计变成
 * **增量**的：下一次 audit 只审「上一个审查点之后的新提交」，并把上一轮已经
 * 报过的东西当作已知背景。
 *
 * 存储：`~/.model-team/review-points.json`，按工作空间绝对路径分条。放在家目录
 * 而不是仓库里，是因为它描述的是「审过什么」这件事本身，不该跟着代码一起提交；
 * 一个仓库被多个会话审时也能共用同一条记录。
 *
 * 只在 `kind='audit'` 上生效：design/reason 是一次性推理，没有「上次审到哪」的概念。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SCHEMA_VERSION = 1;

/**
 * 审查点库路径。**按项目存**，不按机器存：
 *
 * - 审查进度是项目状态——同一台机器上不同仓库互不相干，放家目录会挤在一个
 *   文件里，换机器或重新克隆就丢；
 * - 但它是**游标**（审到哪了），不是结论。结论落在项目自己的文档里（例如本仓
 *   的 `docs/progress.md` 缺口台账），所以这个文件应当被 `.gitignore` 忽略，
 *   和 `.vastplan/`、`.superpowers/` 同类——在项目目录里，但不进版本历史。
 *
 * 解析顺序：显式 `MODEL_TEAM_REVIEW_POINTS` → `<workspace>/.model-team/` →
 * 家目录（只在没有 workspace 时兜底，例如 CLI 直接调用）。
 */
export function resolveReviewPointPath(workspace, env = process.env) {
  const explicit = String(env.MODEL_TEAM_REVIEW_POINTS ?? '').trim();
  if (explicit) return resolve(explicit);
  const key = reviewPointKey(workspace);
  if (key) return join(key, '.model-team', 'review-points.json');
  const home = String(env.MODEL_TEAM_HOME ?? '').trim() || join(homedir(), '.model-team');
  return join(home, 'review-points.json');
}

/** 同一仓库的不同写法（相对/绝对/带尾斜杠）必须落到同一条记录。 */
export function reviewPointKey(workspace) {
  const text = String(workspace ?? '').trim();
  if (!text) return '';
  return resolve(text);
}

/** 读整个库；文件缺失或损坏都退回空库，不让审查点本身成为失败点。 */
export function readReviewPoints(file) {
  if (!file || !existsSync(file)) return { version: SCHEMA_VERSION, workspaces: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.workspaces && typeof parsed.workspaces === 'object') {
      return { version: parsed.version ?? SCHEMA_VERSION, workspaces: parsed.workspaces };
    }
  } catch { /* 损坏的库按空库处理，下一次写入会覆盖 */ }
  return { version: SCHEMA_VERSION, workspaces: {} };
}

export function getReviewPoint(file, workspace) {
  const key = reviewPointKey(workspace);
  if (!key) return null;
  const point = readReviewPoints(file).workspaces[key];
  return point && typeof point === 'object' ? point : null;
}

export function setReviewPoint(file, workspace, point) {
  const key = reviewPointKey(workspace);
  if (!key) throw new Error('review point 需要一个 workspace 路径');
  const store = readReviewPoints(file);
  store.workspaces[key] = point;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
  return point;
}

export function clearReviewPoint(file, workspace) {
  const key = reviewPointKey(workspace);
  if (!key) return false;
  const store = readReviewPoints(file);
  if (!(key in store.workspaces)) return false;
  delete store.workspaces[key];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
  return true;
}

/** 跑一条 git 命令；非 git 目录或不存在的 ref 一律返回 undefined 而不是抛。 */
function git(workspace, args) {
  try {
    return execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * 算出「上一个审查点 → HEAD」之间新增了什么。
 *
 * `comparable=false` 时调用方必须退回全量审查，并把 `reason` 告诉模型——绝不能
 * 假装增量成功，否则模型会以为「没提到的问题都不存在」。
 */
export function computeReviewDelta(workspace, sinceCommit) {
  const key = reviewPointKey(workspace);
  const head = key ? git(key, ['rev-parse', 'HEAD']) : undefined;
  if (!head) {
    return { workspace: key, comparable: false, reason: 'not-a-git-worktree', head: '', since: sinceCommit ?? '', commits: [], files: [], stat: '' };
  }
  if (!sinceCommit) {
    return { workspace: key, comparable: false, reason: 'no-review-point', head, since: '', commits: [], files: [], stat: '' };
  }
  const isAncestor = (() => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sinceCommit, 'HEAD'], { cwd: key, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  if (!isAncestor) {
    return { workspace: key, comparable: false, reason: 'history-rewritten', head, since: sinceCommit, commits: [], files: [], stat: '' };
  }
  if (head === sinceCommit) {
    return { workspace: key, comparable: true, reason: 'no-new-commits', head, since: sinceCommit, commits: [], files: [], stat: '' };
  }
  const log = git(key, ['log', '--reverse', '--format=%h %s', `${sinceCommit}..HEAD`]) ?? '';
  const commits = log.split('\n').filter(Boolean).map((line) => {
    const space = line.indexOf(' ');
    return { sha: line.slice(0, space), subject: line.slice(space + 1) };
  });
  const names = git(key, ['diff', '--name-status', `${sinceCommit}..HEAD`]) ?? '';
  const files = names.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status, path: rest.join('\t') };
  });
  const stat = git(key, ['diff', '--shortstat', `${sinceCommit}..HEAD`]) ?? '';
  return { workspace: key, comparable: true, reason: 'delta', head, since: sinceCommit, commits, files, stat };
}

const REASON_TEXT = {
  'not-a-git-worktree': 'the workspace is not a git worktree, so no delta could be computed',
  'no-review-point': 'no review point has been recorded for this workspace yet',
  'history-rewritten': 'the recorded review point is no longer an ancestor of HEAD (the history was rewritten)',
  'no-new-commits': 'HEAD is exactly the recorded review point',
};

/** 增量审查范围段：作为 packet 的追加段落交给模型（llm 模式看不到仓库，只能靠这段）。 */
export function buildReviewScope(delta, point) {
  const lines = ['', '## REVIEW SCOPE (review point mechanism)', ''];
  if (!delta.comparable) {
    lines.push(
      `This is a **full review**: ${REASON_TEXT[delta.reason] ?? delta.reason}.`,
      `Current HEAD: ${delta.head || '(unknown)'}.`,
      '',
      'Review the whole change surface described above.',
    );
    return lines.join('\n');
  }
  if (delta.reason === 'no-new-commits') {
    lines.push(
      `**Nothing to review incrementally**: HEAD (${delta.head}) is exactly the last review point.`,
      point?.reviewedAt ? `That point was recorded by run ${point.runId ?? '(unknown)'} at ${point.reviewedAt}.` : '',
      '',
      'Either state plainly that there are no new changes, or review the current tree again if the caller asked for it.',
    );
    return lines.filter((line) => line !== '').join('\n');
  }
  const reviewed = point?.reviewedAt ? ` on ${point.reviewedAt}` : '';
  const by = point?.runId ? ` by run ${point.runId}` : '';
  lines.push(
    `Previous review point: commit ${delta.since}${reviewed}${by}.`,
    `This run covers the ${delta.commits.length} commit(s) and ${delta.files.length} file(s) added since then${delta.stat ? ` (${delta.stat})` : ''}.`,
    '',
    'Commits under review:',
    ...delta.commits.map((commit) => `- ${commit.sha} ${commit.subject}`),
    '',
    'Files touched:',
    ...delta.files.slice(0, 200).map((file) => `- ${file.status} ${file.path}`),
    ...(delta.files.length > 200 ? [`- … and ${delta.files.length - 200} more`] : []),
    '',
    'Focus on the changes above. You may still report a cross-cutting risk that this delta exposes in untouched code, but say explicitly which file you had to look at and why. Do not re-report findings already fixed in the reviewed commits unless the fix is wrong.',
  );
  return lines.join('\n');
}

/** 一次审计跑完之后，把审查点推进到被审的那个提交。 */
export function advanceReviewPoint({ file, workspace, delta, runId, kind = 'audit', commit, subject, reviewedAt }) {
  const point = {
    commit: commit ?? delta?.head ?? '',
    subject: subject ?? '',
    reviewedAt: reviewedAt ?? new Date().toISOString(),
    runId: runId ?? '',
    kind,
    commits: delta?.commits?.length ?? 0,
    files: delta?.files?.length ?? 0,
  };
  return setReviewPoint(file, workspace, point);
}
