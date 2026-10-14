import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Repository, documentFor } from '../src/storage/repository';
import { funds } from '../src/core/calculations';
import { sha256 } from '../src/core/primitives';
import { config, tx, MemoryIO, TODAY } from './fixtures';

test('空账本可首次保存外观；写盘失败保留设置且不新增流水', async () => {
  const io = new MemoryIO(), repo = new Repository(io, '空账本', () => TODAY); await repo.load();
  const revision = repo.configRevision; assert.equal(revision, '');
  const c = { ...repo.config, homeSlogan: '从今天开始', theme: 'dark' as const };
  io.failPath = '配置.md'; await assert.rejects(repo.saveConfig(c, revision), /模拟写入中断/);
  assert.equal(repo.config.theme, 'system'); assert.equal(repo.configRevision, revision);
  io.failPath = ''; await repo.saveConfig(c, revision); await repo.load();
  assert.equal(repo.config.homeSlogan, '从今天开始'); assert.equal(repo.config.theme, 'dark');
  assert.equal(repo.state.transactions.size, 0); assert.deepEqual([...io.files.keys()], ['空账本/配置.md']);
});

test('旧配置缺少标语和外观时仍可读取、记账和恢复备份', async () => {
  const io = new MemoryIO(), old = config(); delete old.homeSlogan; delete old.theme;
  io.files.set('旧账本/配置.md', documentFor('旧配置', old));
  const repo = new Repository(io, '旧账本', () => TODAY); await repo.load();
  assert.equal(repo.state.issues.length, 0); assert.deepEqual(repo.config, old);
  await repo.commit([{ type: 'transaction.put', expected: 0, value: tx('expense', 14000) }], 'old-purchase', '购买');
  const restored = new Repository(io, '恢复旧账本', () => TODAY); await restored.load(); await restored.restoreBackup(repo.exportBackup());
  assert.deepEqual(restored.config, old); assert.equal(restored.state.transactions.size, 1);
});

test('外观设置重开与备份恢复保留，资金和交易不变，旧设置窗口拒绝覆盖', async () => {
  const io = new MemoryIO(), repo = new Repository(io, '账本', () => TODAY); await repo.load(); await repo.saveConfig(config());
  await repo.commit([{ type: 'transaction.put', expected: 0, value: tx('expense', 14000) }], 'purchase', '购买');
  const before = funds(repo.state, repo.config, TODAY), batches = structuredClone(repo.state.batches);
  const old = structuredClone(repo.config), fingerprint = sha256(JSON.stringify(old));
  await repo.saveConfig({ ...old, homeSlogan: '每一笔，都为喜欢的生活', theme: 'dark' }, fingerprint); await repo.load();
  assert.equal(repo.config.homeSlogan, '每一笔，都为喜欢的生活'); assert.equal(repo.config.theme, 'dark');
  assert.deepEqual(funds(repo.state, repo.config, TODAY), before); assert.deepEqual(repo.state.batches, batches);
  await assert.rejects(repo.saveConfig({ ...old, homeSlogan: '旧窗口' }, fingerprint), /其他窗口变更/);
  const restored = new Repository(io, '恢复', () => TODAY); await restored.load(); await restored.restoreBackup(repo.exportBackup());
  assert.deepEqual(restored.config, repo.config); assert.deepEqual(funds(restored.state, restored.config, TODAY), before);
});

test('错误外观、非文字标语、超长与控制字符在写盘前拒绝', async () => {
  const io = new MemoryIO(), repo = new Repository(io, '账本', () => TODAY); await repo.load(); await repo.saveConfig(config());
  const before = [...io.files];
  for (const patch of [{ theme: 'invalid' }, { homeSlogan: 123 }, { homeSlogan: '字'.repeat(121) }, { homeSlogan: '两行\n标语' }]) {
    await assert.rejects(repo.saveConfig({ ...repo.config, ...patch } as any), /外观|标语/); assert.deepEqual([...io.files], before);
  }
});
