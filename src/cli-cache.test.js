/**
 * CLI 信息落盘缓存的单测。
 *
 * 语义要点（页面的「刷新」按钮依赖它）：
 * - 缓存**不会自动过期**：进设置页只读缓存，点刷新才重新探测；
 * - 坏文件 / 版本不符按空缓存处理，绝不让设置页打不开；
 * - 写入是原子的（tmp → rename），不会留下半个 JSON。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CLI_CACHE_VERSION,
  cliCacheFile,
  cliCacheUpdatedAt,
  clearCliInfoCache,
  configureCliCache,
  defaultCliCachePath,
  flushCliCache,
  getCachedAvailability,
  getCachedDiscovery,
  resetCliCache,
  setCachedAvailability,
  setCachedDiscovery,
} from './harness/cli-cache.js';

/** 每个用例自己一个临时目录，结束后恢复「纯内存」状态，避免污染其它用例。 */
function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'model-team-cli-cache-'));
  return Promise.resolve(fn(join(dir, 'cli-cache.json')))
    .finally(() => {
      resetCliCache();
      rmSync(dir, { recursive: true, force: true });
    });
}

test('默认落点：$DSH_HOME/model-team/cli-cache.json', () => {
  assert.equal(defaultCliCachePath('/tmp/dsh-home'), '/tmp/dsh-home/model-team/cli-cache.json');
});

test('未配置文件时是纯内存缓存：可读可写，不落盘', () => {
  resetCliCache();
  assert.equal(cliCacheFile(), '');
  setCachedAvailability('demo', true, 111);
  setCachedDiscovery('demo', { at: 111, sig: 's1', models: [{ id: 'm1', name: 'M1' }] });
  assert.deepEqual(getCachedAvailability('demo'), { ok: true, at: 111 });
  assert.equal(getCachedDiscovery('demo').models[0].id, 'm1');
  assert.equal(cliCacheUpdatedAt(), 111);
  assert.doesNotThrow(() => flushCliCache());
});

test('写盘后能重新载入（模拟插件重载/DSH 重启）', async () => {
  await withTemp(async (file) => {
    configureCliCache(file);
    assert.equal(getCachedAvailability('pi'), null, '新文件应为空缓存');
    setCachedAvailability('pi', true, 1000);
    setCachedDiscovery('pi', { at: 1001, sig: 'sig-pi', models: [{ id: 'k3', name: 'Kimi K3' }] });
    flushCliCache();

    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.version, CLI_CACHE_VERSION);
    assert.equal(raw.availability.pi.ok, true);
    assert.equal(raw.discovery.pi.models[0].id, 'k3');

    // 「重启」：忘掉内存，再从同一份文件载入。
    resetCliCache();
    configureCliCache(file);
    assert.deepEqual(getCachedAvailability('pi'), { ok: true, at: 1000 });
    assert.equal(getCachedDiscovery('pi').sig, 'sig-pi');
    assert.equal(cliCacheUpdatedAt(), 1001);
  });
});

test('坏 JSON 按空缓存处理，之后仍能正常写回', async () => {
  await withTemp(async (file) => {
    writeFileSync(file, '{这不是 JSON');
    configureCliCache(file);
    assert.equal(getCachedAvailability('pi'), null);
    setCachedAvailability('pi', false, 2);
    flushCliCache();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.availability.pi.ok, false);
  });
});

test('版本不符按空缓存处理（升级后的旧文件不会读进脏结构）', async () => {
  await withTemp(async (file) => {
    writeFileSync(file, JSON.stringify({
      version: CLI_CACHE_VERSION + 99,
      availability: { pi: { ok: true, at: 1 } },
      discovery: {},
    }));
    configureCliCache(file);
    assert.equal(getCachedAvailability('pi'), null);
  });
});

test('结构不对的发现记录被丢弃（半个数组也不让页面崩）', async () => {
  await withTemp(async (file) => {
    writeFileSync(file, JSON.stringify({
      version: CLI_CACHE_VERSION,
      updatedAt: 5,
      availability: {},
      discovery: {
        ok: { at: 1, sig: 's', models: [{ id: 'm1', name: 'M1' }] },
        broken: { at: 1, sig: 's', models: 'not-an-array' },
        partial: { at: 1, sig: 's', models: [{ name: '没有 id' }, { id: 'm2' }] },
        empty: { at: 1, sig: 's', models: [] },
      },
    }));
    configureCliCache(file);
    assert.equal(getCachedDiscovery('ok').models.length, 1);
    assert.equal(getCachedDiscovery('broken'), null);
    assert.deepEqual(getCachedDiscovery('partial').models.map((item) => item.id), ['m2']);
    // 空结果要保留：「发现失败」也算探测过，否则每次启动都会重跑一遍。
    assert.deepEqual(getCachedDiscovery('empty').models, []);
  });
});

test('清空缓存会同时清掉内存与磁盘；之后读到的是空缓存', async () => {
  await withTemp(async (file) => {
    configureCliCache(file);
    setCachedAvailability('pi', true, 1);
    setCachedDiscovery('pi', { at: 1, sig: 's', models: [{ id: 'k3' }] });
    flushCliCache();

    clearCliInfoCache();
    flushCliCache();
    assert.equal(getCachedAvailability('pi'), null);
    assert.equal(getCachedDiscovery('pi'), null);
    assert.equal(cliCacheUpdatedAt(), 0);

    resetCliCache();
    configureCliCache(file);
    assert.equal(getCachedAvailability('pi'), null);
  });
});

test('写盘是原子的：落盘后不残留 tmp 文件', async () => {
  await withTemp(async (file) => {
    configureCliCache(file);
    setCachedAvailability('pi', true, 3);
    flushCliCache();
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(`${file}.tmp`), false);
  });
});
