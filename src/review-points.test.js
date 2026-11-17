import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  advanceReviewPoint,
  buildReviewScope,
  clearReviewPoint,
  computeReviewDelta,
  getReviewPoint,
  readReviewPoints,
  resolveReviewPointPath,
  setReviewPoint,
} from './review-points.js';

/** 造一个真实的临时 git 仓库：审查点必须靠 git 才能算增量。 */
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-rp-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  run('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  run('add', '.');
  run('commit', '-q', '-m', 'first commit');
  return dir;
}

const commit = (dir, name, body, message) => {
  writeFileSync(join(dir, name), body);
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
};

test('审查点按项目存：显式环境变量 > 项目内 > 家目录', () => {
  const repo = mkdtempSync(join(tmpdir(), 'model-team-rp-path-'));
  try {
    assert.equal(
      resolveReviewPointPath(repo, { MODEL_TEAM_REVIEW_POINTS: '/tmp/explicit.json' }),
      '/tmp/explicit.json',
    );
    assert.equal(
      resolveReviewPointPath(repo, {}),
      join(repo, '.model-team', 'review-points.json'),
    );
    assert.match(resolveReviewPointPath('', { MODEL_TEAM_HOME: '/tmp/home' }), /\/tmp\/home\/review-points\.json$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('审查点读写：同一仓库的相对与绝对写法落到同一条记录', () => {
  const repo = mkdtempSync(join(tmpdir(), 'model-team-rp-store-'));
  const file = join(repo, '.model-team', 'review-points.json');
  try {
    setReviewPoint(file, repo, { commit: 'abc', reviewedAt: '2026-01-01T00:00:00.000Z', runId: 'r1' });
    assert.equal(getReviewPoint(file, `${repo}/`).commit, 'abc');
    assert.equal(getReviewPoint(file, repo).runId, 'r1');
    assert.deepEqual(readReviewPoints(file).workspaces[repo].commit, 'abc');
    assert.equal(clearReviewPoint(file, repo), true);
    assert.equal(getReviewPoint(file, repo), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('审查点库损坏时退回空库，不让它成为失败点', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-rp-bad-'));
  const file = join(dir, 'review-points.json');
  try {
    writeFileSync(file, '{ not json');
    assert.deepEqual(readReviewPoints(file).workspaces, {});
    mkdirSync(join(dir, 'sub'), { recursive: true });
    assert.equal(getReviewPoint(file, join(dir, 'sub')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('增量计算：没有审查点时退回全量，并说明原因', () => {
  const repo = tempRepo();
  try {
    const delta = computeReviewDelta(repo, undefined);
    assert.equal(delta.comparable, false);
    assert.equal(delta.reason, 'no-review-point');
    assert.match(buildReviewScope(delta, null), /full review/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('增量计算：只列审查点之后的新提交与改动文件', () => {
  const repo = tempRepo();
  try {
    const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    commit(repo, 'b.txt', 'two\n', 'second commit');
    commit(repo, 'a.txt', 'one changed\n', 'third commit');

    const delta = computeReviewDelta(repo, first);
    assert.equal(delta.comparable, true);
    assert.deepEqual(delta.commits.map((item) => item.subject), ['second commit', 'third commit']);
    assert.deepEqual(delta.files.map((item) => item.path).sort(), ['a.txt', 'b.txt']);
    assert.match(delta.stat, /2 files changed/);

    const scope = buildReviewScope(delta, { reviewedAt: '2026-01-01T00:00:00.000Z', runId: 'r0' });
    assert.match(scope, /Previous review point: commit/);
    assert.match(scope, /second commit/);
    assert.match(scope, /a\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('增量计算：HEAD 就是审查点时明确说没有新变更', () => {
  const repo = tempRepo();
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const delta = computeReviewDelta(repo, head);
    assert.equal(delta.comparable, true);
    assert.equal(delta.reason, 'no-new-commits');
    assert.match(buildReviewScope(delta, { runId: 'r0' }), /Nothing to review incrementally/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('增量计算：历史被改写时退回全量而不是假装增量', () => {
  const repo = tempRepo();
  try {
    const delta = computeReviewDelta(repo, '0'.repeat(40));
    assert.equal(delta.comparable, false);
    assert.equal(delta.reason, 'history-rewritten');
    assert.match(buildReviewScope(delta, null), /history was rewritten/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('增量计算：非 git 目录不抛异常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-rp-nogit-'));
  try {
    const delta = computeReviewDelta(dir, 'abc123');
    assert.equal(delta.comparable, false);
    assert.equal(delta.reason, 'not-a-git-worktree');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('推进审查点：记录被审提交、场次与统计', () => {
  const repo = tempRepo();
  const file = join(repo, '.model-team', 'review-points.json');
  try {
    const head = commit(repo, 'c.txt', 'three\n', 'new work');
    const delta = computeReviewDelta(repo, execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repo, encoding: 'utf8' }).trim());
    advanceReviewPoint({ file, workspace: repo, delta, runId: 'run-9', commit: head, subject: 'new work' });
    const point = getReviewPoint(file, repo);
    assert.equal(point.commit, head);
    assert.equal(point.runId, 'run-9');
    assert.equal(point.kind, 'audit');
    assert.equal(point.commits, 1);
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).workspaces[repo]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
