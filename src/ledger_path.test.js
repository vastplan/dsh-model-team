import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultLedgerPath, resolveLedgerPath, skillLedgerPath } from './ledger.js';

test('默认账本：技能账本存在时优先使用统一库', () => {
  const home = mkdtempSync(join(tmpdir(), 'model-team-home-'));
  const dshHome = mkdtempSync(join(tmpdir(), 'model-team-dsh-'));
  try {
    mkdirSync(join(home, '.model-team', 'ledger'), { recursive: true });
    writeFileSync(skillLedgerPath(home), '');
    assert.equal(
      resolveLedgerPath({ dshHome, home }),
      skillLedgerPath(home),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('默认账本：没有技能账本时回退旧版插件账本', () => {
  const home = mkdtempSync(join(tmpdir(), 'model-team-home-'));
  const dshHome = mkdtempSync(join(tmpdir(), 'model-team-dsh-'));
  try {
    assert.equal(
      resolveLedgerPath({ dshHome, home }),
      defaultLedgerPath(dshHome),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('默认账本：显式配置优先于两种默认路径', () => {
  const home = mkdtempSync(join(tmpdir(), 'model-team-home-'));
  const dshHome = mkdtempSync(join(tmpdir(), 'model-team-dsh-'));
  try {
    mkdirSync(join(home, '.model-team', 'ledger'), { recursive: true });
    writeFileSync(skillLedgerPath(home), '');
    assert.equal(
      resolveLedgerPath({ dshHome, home, configured: '/tmp/custom-ledger.db' }),
      '/tmp/custom-ledger.db',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dshHome, { recursive: true, force: true });
  }
});
