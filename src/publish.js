/**
 * 报告上传：**自动识别本地目录的 git 仓库与远端，不需要配置**。
 *
 * 规则（照技能侧 `publish.ts` 的口径，但仓库来自目录本身）：
 * - 报告目录在某个 git 工作树里、且该 worktree 配了远端 → 提交并推送；
 * - 不在 git 里 / 没有远端 → 跳过（只落本地，不报错）；
 * - 推送失败 → 记录真因，**不影响报告已生成**。
 *
 * 凭据交给系统 git（SSH key 或 credential helper），插件不碰 token，也不存仓地址。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

/** 跑一条 git 命令；成功返回 stdout（trim），失败返回 null（不抛）。 */
async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch (error) {
    error.gitFailed = true;
    throw error;
  }
}

async function gitOrNull(cwd, args) {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/** 报告目录的公开访问地址（GitHub Pages），从远端推导；非 GitHub 返回空串。 */
export function pagesOf(remote) {
  const raw = String(remote ?? '').trim();
  if (!raw) return '';
  const match = /github\.com[:/]+([^/]+)\/([^/.]+)/i.exec(raw);
  return match ? `https://${match[1]}.github.io/${match[2]}/` : '';
}

/**
 * 探测报告目录所在仓库的状态。
 *
 * @param dir - 报告目录。
 * @returns `{ inRepo, root, remote, branch }`。
 */
export async function inspectRepo(dir) {
  // 目录可能还没建（首次生成报告前）：git 会向上找仓库，所以这里仍可探测。
  // 只有整个路径都不存在、且 git 也找不到祖先仓库时才算「不在仓库里」。
  if (!existsSync(dir)) {
    // 交回 git 自己判断：目录不存在时 rev-parse 会失败，但我们先尝试父目录。
    const parent = dirname(dir);
    if (!existsSync(parent)) return { inRepo: false, root: '', remote: '', branch: '' };
    return await inspectRepoAt(parent);
  }
  return await inspectRepoAt(dir);
}

/** 在给定目录上跑 git 探测（内部用，目录须存在）。 */
async function inspectRepoAt(dir) {
  const root = await gitOrNull(dir, ['rev-parse', '--show-toplevel']);
  if (!root) return { inRepo: false, root: '', remote: '', branch: '' };
  // 优先 origin；没有就用第一个远端。
  const origin = await gitOrNull(dir, ['remote', 'get-url', 'origin']);
  let remote = origin ?? '';
  if (!remote) {
    const list = await gitOrNull(dir, ['remote']);
    const first = (list ?? '').split('\n').map((line) => line.trim()).filter(Boolean)[0];
    if (first) remote = (await gitOrNull(dir, ['remote', 'get-url', first])) ?? '';
  }
  const branch = (await gitOrNull(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? '';
  return { inRepo: true, root, remote, branch };
}

/**
 * 上传报告。
 *
 * **三个条件同时满足才会推送**：
 * 1. 设置里打开了「生成后自动上传」；
 * 2. 报告目录在某个 git 工作树里；
 * 3. 该仓库配了远端。
 *
 * 任一不满足 → `skipped` 并说明是哪一条，报告本身不受影响。
 *
 * @param target - 报告文件路径或其所在目录。
 * @param message - 提交信息。
 * @param options - `{ enabled }`：自动上传开关。
 * @returns `{ status, note, commit, remote, pages }`；status 取 `uploaded | skipped | failed`。
 */
export async function publishReports(target, message, options = {}) {
  const enabled = options.enabled === true;
  const dir = String(target ?? '').endsWith('.html') ? dirname(String(target)) : String(target ?? '');

  if (!enabled) {
    return {
      status: 'skipped',
      note: '未开启「生成后自动上传」，只落本地',
      commit: null,
      remote: '',
      pages: '',
    };
  }

  const state = await inspectRepo(dir);
  if (!state.inRepo) {
    return {
      status: 'skipped',
      note: `报告目录不在 git 仓库里，只落本地：${dir}`,
      commit: null,
      remote: '',
      pages: '',
    };
  }
  if (!state.remote) {
    return {
      status: 'skipped',
      note: `仓库 ${state.root} 没有配置远端，只提交不推送`,
      commit: null,
      remote: '',
      pages: '',
    };
  }

  try {
    await git(dir, ['add', '-A', '--', '.']);
    const dirty = await gitOrNull(dir, ['status', '--porcelain', '--', '.']);
    if (dirty) {
      await git(dir, ['commit', '-q', '-m', message, '--', '.']);
    }
    const head = await gitOrNull(dir, ['rev-parse', '--short', 'HEAD']);
    // 首次推送需要建立 upstream；已有时这条同样有效。
    const branch = (await gitOrNull(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
    await git(dir, ['push', '-q', '-u', 'origin', branch]);
    return {
      status: 'uploaded',
      note: dirty ? `已提交并推送 ${head} → ${state.remote}` : `无新改动，已与远端同步（${head}）`,
      commit: head,
      remote: state.remote,
      pages: pagesOf(state.remote),
    };
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(-300);
    return {
      status: 'failed',
      note: `上传失败（报告已生成，可稍后重试）：${detail}`,
      commit: null,
      remote: state.remote,
      pages: pagesOf(state.remote),
    };
  }
}
