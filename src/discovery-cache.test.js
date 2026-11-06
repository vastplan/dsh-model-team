/**
 * CLI 自动发现 / 可用性「只探测一次，之后读缓存」的单测。
 *
 * 这是设置页「刷新」按钮的契约：进页面不再启动外部进程；
 * 只有显式 `force`（或缓存被清空）才会重新探测。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { clearAvailabilityCache, harnessAvailable } from './harness/availability.js';
import { configureCliCache, flushCliCache, resetCliCache } from './harness/cli-cache.js';
import { clearDiscoveryCache, discoverHarness } from './harness/discover.js';

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-discovery-cache-'));
  return Promise.resolve(fn(join(dir, 'cli-cache.json')))
    .finally(() => {
      clearDiscoveryCache();
      clearAvailabilityCache();
      resetCliCache();
      rmSync(dir, { recursive: true, force: true });
    });
}

/** 用 hooks 的假 harness：计调用次数，不真的起进程。 */
function hookHarness(id, models) {
  const state = { calls: 0 };
  const definition = {
    id,
    label: id,
    command: process.execPath,
    capabilities: { readOnlyByDefault: true },
    hooks: {
      discover: async () => {
        state.calls += 1;
        return models;
      },
    },
  };
  return { definition, state };
}

/** 用 node -e 打一行模型的假 harness：用来验证「签名变化 → 自动重新发现」。 */
function execHarness(id, line) {
  return {
    id,
    label: id,
    command: process.execPath,
    capabilities: { readOnlyByDefault: true },
    discover: { argv: ['-e', `console.log(${JSON.stringify(line)})`], parser: 'lines' },
  };
}

test('发现结果命中缓存：第二次不再跑发现', async () => {
  const { definition, state } = hookHarness('cache-probe-a', [{ id: 'm-one', name: 'M One' }]);
  const first = await discoverHarness(definition, null);
  const second = await discoverHarness(definition, null);
  assert.equal(state.calls, 1);
  // 落盘往返会丢掉值为 undefined 的字段，比较身份字段即可。
  assert.deepEqual(second.map((item) => [item.id, item.name]), first.map((item) => [item.id, item.name]));
  assert.equal(first[0].id, 'm-one');
});

test('force 绕过缓存，重新跑一次发现', async () => {
  const { definition, state } = hookHarness('cache-probe-b', [{ id: 'm-two', name: 'M Two' }]);
  await discoverHarness(definition, null);
  await discoverHarness(definition, null, { force: true });
  assert.equal(state.calls, 2);
});

test('落盘后模拟重启：仍然命中缓存，不再跑发现', async () => {
  await withTemp(async (file) => {
    const { definition, state } = hookHarness('cache-probe-c', [{ id: 'm-three', name: 'M Three' }]);
    configureCliCache(file);
    const first = await discoverHarness(definition, null);
    flushCliCache();
    assert.equal(state.calls, 1);

    // 「重启」：内存全丢，只从磁盘读回来。
    resetCliCache();
    configureCliCache(file);
    const again = await discoverHarness(definition, null);
    assert.equal(state.calls, 1, '重启后不该再起外部进程');
    assert.deepEqual(again.map((item) => [item.id, item.name]), first.map((item) => [item.id, item.name]));
  });
});

test('发现命令变了（签名不同）自动重新发现', async () => {
  const id = 'cache-probe-sig';
  const first = await discoverHarness(execHarness(id, 'model-alpha'), null);
  assert.equal(first[0].id, 'model-alpha');
  const second = await discoverHarness(execHarness(id, 'model-beta'), null);
  assert.equal(second[0].id, 'model-beta', '命令变了还读旧缓存会把用户锁死在旧模型上');
});

test('发现失败（空结果）也落盘：重启后不再反复重跑失败的 CLI', async () => {
  await withTemp(async (file) => {
    let calls = 0;
    const definition = {
      id: 'cache-probe-empty',
      label: 'cache-probe-empty',
      command: process.execPath,
      capabilities: { readOnlyByDefault: true },
      hooks: {
        discover: async () => {
          calls += 1;
          throw new Error('CLI 暂时不可用');
        },
      },
    };
    configureCliCache(file);
    assert.deepEqual(await discoverHarness(definition, null), []);
    flushCliCache();

    resetCliCache();
    configureCliCache(file);
    assert.deepEqual(await discoverHarness(definition, null), []);
    assert.equal(calls, 1, '空结果也算「探测过」；不缓存的话每次重启都会重跑失败的命令');
  });
});

test('可用性结论落盘：重启后沿用旧结论，清缓存后才重新探测', async () => {
  await withTemp(async (file) => {
    configureCliCache(file);
    const missing = { id: 'avail-probe', command: 'definitely-not-a-real-cli-xyz' };
    assert.equal(harnessAvailable(missing), false);
    flushCliCache();

    resetCliCache();
    configureCliCache(file);
    // 同一 id 换成一个真实可用的命令：缓存命中时仍返回旧结论（这就是「点刷新才刷新」）。
    const installed = { id: 'avail-probe', command: process.execPath };
    assert.equal(harnessAvailable(installed), false);

    // 刷新路径：清缓存后重新探测，就能看到新装的 CLI。
    clearAvailabilityCache();
    assert.equal(harnessAvailable(installed), true);
  });
});
