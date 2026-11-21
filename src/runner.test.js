/**
 * 共用执行核心的测试：组内回落语义 + workspace 校验。
 *
 * 这两个口径一旦两边不一致，就会出现「插件里跑了两跳、CLI 里跑了一跳」这种
 * 账本对不上的问题，所以用测试钉死。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { callHarnessEntry, runGroupChain } from './runner.js';

test('runGroupChain：主力成功就不再启用备选', async () => {
  const calls = [];
  const result = await runGroupChain(['a', 'b'], async (entry) => {
    calls.push(entry);
    return { model: entry, status: 'done' };
  });
  assert.deepEqual(calls, ['a']);
  assert.equal(result.winner.model, 'a');
  assert.equal(result.recorded.model, 'a');
  assert.equal(result.tried.length, 1);
});

test('runGroupChain：主力失败才回落，成功即停', async () => {
  const calls = [];
  const before = [];
  const result = await runGroupChain(['a', 'b', 'c'], async (entry) => {
    calls.push(entry);
    return { model: entry, status: entry === 'b' ? 'done' : 'failed' };
  }, { onBeforeFallback: (entry, index) => before.push([entry, index]) });
  assert.deepEqual(calls, ['a', 'b'], 'b 成功后不再跑 c');
  assert.deepEqual(before, [['b', 1]], '只在启用备选前播报一次');
  assert.equal(result.winner.model, 'b');
  assert.equal(result.recorded.model, 'b');
  assert.deepEqual(result.tried.map((row) => row.status), ['failed', 'done']);
});

test('runGroupChain：全组失败时记最后一条', async () => {
  const result = await runGroupChain(['a', 'b'], async (entry) => ({ model: entry, status: 'failed' }));
  assert.equal(result.winner, null);
  assert.equal(result.recorded.model, 'b');
  assert.equal(result.tried.length, 2);
});

test('runGroupChain：shouldStop 命中后不再继续', async () => {
  const calls = [];
  await runGroupChain(['a', 'b', 'c'], async (entry) => {
    calls.push(entry);
    return { model: entry, status: 'failed' };
  }, { shouldStop: () => calls.length >= 1 });
  assert.deepEqual(calls, ['a']);
});

test('runGroupChain：空名单不炸', async () => {
  const result = await runGroupChain([], async () => ({ status: 'done' }));
  assert.deepEqual(result.tried, []);
  assert.equal(result.winner, null);
  assert.equal(result.recorded, null);
});

test('callHarnessEntry：相对 workspace 直接报错，不启动进程', async () => {
  await assert.rejects(
    callHarnessEntry({
      entry: { harness: 'fake', model: 'fake/model', name: 'Fake' },
      prompt: 'P',
      workspace: './relative',
      tmpDir: '/tmp/x',
    }),
    /需要绝对 workspace/,
  );
});

test('callHarnessEntry：跑通一个真 harness（假 CLI）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-runner-'));
  try {
    const script = join(dir, 'fake.mjs');
    writeFileSync(script, `
process.stdout.write(JSON.stringify({ type: 'result', result: 'HELLO', usage: { inputTokens: 3, outputTokens: 2 } }) + '\\n');
`, 'utf8');
    const { registerBuiltinHarnesses, registerHarness } = await import('./harness/index.js');
    registerBuiltinHarnesses();
    registerHarness({
      id: 'fake-runner',
      command: process.execPath,
      args: [script],
      prompt: { via: 'argv', separator: '--' },
      output: { parser: 'auto' },
      usage: { source: 'stream' },
    }, { replace: true });
    const out = await callHarnessEntry({
      entry: { harness: 'fake-runner', model: 'fake/x', name: 'Fake X' },
      prompt: 'P',
      workspace: dir,
      tmpDir: dir,
    });
    assert.equal(out.text, 'HELLO');
    assert.equal(out.usage.input, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
