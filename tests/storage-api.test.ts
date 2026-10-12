import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Repository, replaceBlock, structuredBlock, validRoot, documentFor } from '../src/storage/repository';
import { funds } from '../src/core/calculations';
import { newDraft, draftEvents } from '../src/core/drafts';
import { Extractor, apiUrl, parseExtraction } from '../src/api/extractor';
import { emptyState } from '../src/core/types';
import { sha256, blankRow } from '../src/core/primitives';
import { config, tx, MemoryIO, TODAY, apiEntry } from './fixtures';

test('重复保存请求只入账一次；新的相似真实消费仍能保留；重开恢复', async () => {
  const io = new MemoryIO(), repo = new Repository(io, 'LifeLedger', () => TODAY); await repo.load(); await repo.saveConfig(config());
  const t = tx('expense', 800), events = [{ type: 'transaction.put' as const, expected: 0, value: t }];
  const [a, b] = await Promise.all([repo.commit(events, 'r1', '保存'), repo.commit(events, 'r1', '保存')]); assert.equal(a.id, b.id); assert.equal(repo.state.transactions.size, 1);
  await repo.commit([{ type: 'transaction.put', expected: 0, value: tx('expense', 800) }], 'r2', '再次真实消费');
  const reopened = new Repository(io, 'LifeLedger', () => TODAY); await reopened.load(); assert.equal(reopened.state.transactions.size, 2); assert.equal(funds(reopened.state, reopened.config, TODAY).assets, 2798400);
});
test('撤销一批转账恢复两个账户；撤销购买同时移除关联项目', async () => {
  const io = new MemoryIO(), repo = new Repository(io, 'LifeLedger', () => TODAY); await repo.load(); await repo.saveConfig(config());
  const t = tx('transfer', 50000, { accountId: null, categoryId: null, fromAccountId: 'activity', toAccountId: 'reserve' });
  const saved = await repo.commit([{ type: 'transaction.put', expected: 0, value: t }], 'r1', '转账'); await repo.undo(saved.id); assert.equal(repo.state.transactions.size, 0); assert.equal(funds(repo.state, repo.config, TODAY).balances.get('reserve'), 500000);
  const purchase = tx('expense', 800000, { accountId: 'asset' }); const batch = await repo.commit([{ type: 'transaction.put', expected: 0, value: purchase }, { type: 'cost.put', expected: 0, value: { id: 'cost1', version: 1, batchId: 'b', transactionId: purchase.id, name: '电脑', kind: 'device', amountCents: 800000, residualCents: 0, start: TODAY, end: '2030-10-12', stoppedOn: null, autoRenew: false, adjustmentNotes: [] } }], 'r2', '购买');
  await repo.undo(batch.id); assert.equal(repo.state.costs.size, 0); assert.equal(funds(repo.state, repo.config, TODAY).assets, 2800000);
});
test('半份写入与外部损坏保留原文件且不进入统计；后续保存暂停', async () => {
  const io = new MemoryIO(), repo = new Repository(io, 'LifeLedger', () => TODAY); await repo.load(); await repo.saveConfig(config()); io.failPath = '/账本/'; io.partial = true;
  await assert.rejects(repo.commit([{ type: 'transaction.put', expected: 0, value: tx('expense', 800) }], 'r1', '中断'));
  const reopened = new Repository(io, 'LifeLedger', () => TODAY); await reopened.load(); assert.equal(reopened.state.transactions.size, 0); assert.equal(reopened.state.issues.length, 1);
  io.failPath = ''; await assert.rejects(reopened.commit([{ type: 'transaction.put', expected: 0, value: tx('expense', 800) }], 'r2', '再保存'), /未恢复/); assert.ok([...io.files.keys()].some(p => p.includes('/账本/')));
});
test('配置和草稿更新保留数据块之外的个人笔记；外部并行修改不覆盖', async () => {
  const io = new MemoryIO(), repo = new Repository(io, 'LifeLedger', () => TODAY); await repo.load(); await repo.saveConfig(config());
  const path = 'LifeLedger/配置.md'; io.files.set(path, `${io.files.get(path)}\n我的私人笔记\n`); await repo.saveConfig({ ...repo.config, sound: true }); assert.ok(io.files.get(path)?.endsWith('我的私人笔记\n'));
  io.files.set(path, replaceBlock(io.files.get(path)!, { ...repo.config, reservedCents: 100 })); await assert.rejects(repo.saveConfig({ ...repo.config, sound: false }), /外部修改/);
  const draft = newDraft('午饭二十五，不对二十三', TODAY); await repo.saveDraft(draft); const dp = `LifeLedger/草稿/${draft.id}.md`; io.files.set(dp, io.files.get(dp)! + '\n自己的笔记'); draft.error = '断网'; await repo.saveDraft(draft); assert.ok(io.files.get(dp)?.endsWith('自己的笔记'));
});
test('JSON导出恢复到空账本；恢复后重开可再更正；不覆盖已有账本', async () => {
  const io = new MemoryIO(), repo = new Repository(io, 'LifeLedger', () => TODAY); await repo.load(); await repo.saveConfig(config()); const t = tx('expense', 800);
  await repo.commit([{ type: 'transaction.put', expected: 0, value: t }], 'r1', '保存'); await repo.saveDraft(newDraft('待整理', TODAY));
  const backup = JSON.parse(JSON.stringify(repo.exportBackup())); assert.equal(JSON.stringify(backup).includes('secretId'), false);
  const restored = new Repository(io, '恢复账本', () => TODAY); await restored.load(); await restored.restoreBackup(backup); assert.equal(restored.state.transactions.size, 1); assert.equal(restored.drafts.length, 1);
  await restored.commit([{ type: 'transaction.put', expected: 1, value: { ...t, version: 2, amountCents: 900 } }], 'correction', '恢复后更正');
  const reopened = new Repository(io, '恢复账本', () => TODAY); await reopened.load(); assert.equal(reopened.state.transactions.get(t.id)?.amountCents, 900); await assert.rejects(restored.restoreBackup(backup), /为空账本/);
});
test('数据目录阻止路径穿越；替换数据块不接受多个或不完整块', () => {
  for (const root of ['../foo', 'C:/foo', '/root', '.obsidian', '账本/../笔记']) assert.throws(() => validRoot(root)); assert.equal(validRoot('财务/账本'), '财务/账本'); assert.throws(() => structuredBlock('bad'));
});
test('冻结API协议：一次请求整理整段，无密钥进请求体或回复；空/截断不能成草稿', async () => {
  const draft = newDraft('早餐八块', TODAY), settings = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', secretId: 'key' }, reply = { version: 2, entries: [apiEntry()], excluded: [], complete_dates: [] };
  let count = 0;
  const extractor = new Extractor(async (url, body, key) => {
    count++; assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(key, 'fake-key'); assert.equal(JSON.stringify(body).includes('fake-key'), false);
    return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 123, completion_tokens: 456 } } };
  });
  const result = await extractor.extract(settings, 'fake-key', draft, config(), emptyState()); assert.equal(count, 1); assert.equal(result.rows[0].amount, '8.00'); assert.equal(result.rows[0].usedDefault, true); assert.equal(result.rows[0].reviewed, false); assert.equal(result.usage.output, 456);
  const truncated = new Extractor(async () => ({ status: 200, json: { choices: [{ finish_reason: 'length', message: { content: '{' } }] } })); await assert.rejects(truncated.extract(settings, 'fake-key', draft, config(), emptyState()), /未完整/);
  const empty = new Extractor(async () => ({ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: '' } }] } })); await assert.rejects(empty.extract(settings, 'fake-key', draft, config(), emptyState()), /空/);
});
test('缺转出账户不套用默认账户；总额冲突与反向转账提示核对', () => {
  const c = config(); const reply = (entry: Record<string, unknown>) => ({ version: 2, entries: [entry], excluded: [], complete_dates: [] });
  let d = newDraft('今天转了五百到备用钱包', TODAY);
  let result = parseExtraction(reply(apiEntry({ kind: 'transfer', amount: '500.00', account_id: null, to_account_id: 'reserve', category_id: null, source_quote: d.text, amount_quote: '五百' })), d, c);
  assert.equal(result.rows[0].fromAccountId, ''); assert.equal(result.rows[0].accountId, '');
  d = newDraft('从活动钱包转五百到备用钱包', TODAY);
  result = parseExtraction(reply(apiEntry({ kind: 'transfer', amount: '500.00', from_account_id: 'reserve', to_account_id: 'activity', category_id: null, source_quote: d.text, amount_quote: '五百' })), d, c); assert.ok(result.rows[0].issues.some(s => s.includes('方向')));
  d = newDraft('早餐八块午饭二十五，总共三十五', TODAY);
  result = parseExtraction({ version: 2, entries: [apiEntry(), apiEntry({ amount: '25.00', source_quote: '午饭二十五', amount_quote: '二十五' })], excluded: [], complete_dates: [] }, d, c); assert.ok(result.rows.every(r => r.issues.some(s => s.includes('合计'))));
});
test('额外字段、无效版本、跨币种和非字符串金额拒绝；缺字段不得补造', () => {
  const d = newDraft('早餐八块', TODAY), base = { version: 2, entries: [apiEntry()], excluded: [], complete_dates: [] };
  for (const reply of [{ ...base, version: 1 }, { ...base, confidence: 1 }, { ...base, entries: [apiEntry({ currency: 'USD' })] }, { ...base, entries: [apiEntry({ amount: 8 })] }]) assert.throws(() => parseExtraction(reply, d, config()));
  assert.throws(() => apiUrl('http://example.com', 'models')); assert.throws(() => apiUrl('https://user:pass@example.com', 'models'));
});
test('旧设置快照不覆盖另一窗口新配置；坏备份草稿在写入前拒绝', async () => {
  const io = new MemoryIO(), repo = new Repository(io, 'LifeLedger', () => TODAY); await repo.load(); await repo.saveConfig(config());
  const old = structuredClone(repo.config), fingerprint = sha256(JSON.stringify(old));
  await repo.saveConfig({ ...repo.config, reservedCents: 123 });
  await assert.rejects(repo.saveConfig({ ...old, sound: true }, fingerprint), /其他窗口/); assert.equal(repo.config.reservedCents, 123);
  const backup = repo.exportBackup(); backup.drafts = [null as never]; const { checksum, ...body } = backup; backup.checksum = sha256(JSON.stringify(body));
  const restore = new Repository(io, '拒绝坏备份', () => TODAY); await restore.load(); await assert.rejects(restore.restoreBackup(backup), /草稿格式/); assert.equal((await io.list('拒绝坏备份/')).length, 0);
});
test('记完后补一笔收支会回到待核对；转账不撤销当天确认', async () => {
  const io = new MemoryIO(), r = new Repository(io, 'LifeLedger', () => TODAY); await r.load(); await r.saveConfig(config());
  await r.commit([{ type: 'day.set', date: TODAY, complete: true, expected: 0 }], 'day', '核对');
  await r.commit([{ type: 'transaction.put', expected: 0, value: tx('transfer', 100, { accountId: null, categoryId: null, fromAccountId: 'activity', toAccountId: 'reserve' }) }], 'transfer', '转账'); assert.equal(r.state.days.get(TODAY)?.complete, true);
  const b = await r.commit([{ type: 'transaction.put', expected: 0, value: tx('expense', 800) }], 'supplement', '补记'); assert.equal(r.state.days.get(TODAY)?.complete, false);
  await r.undo(b.id); assert.equal(r.state.days.get(TODAY)?.complete, true);
});


test('Windows目录名规范化，并阻止保留设备名、隐藏路径与控制字符', () => {
  assert.equal(validRoot('  财务\\日常账本/  '), '财务/日常账本');
  for (const root of ['CON', 'nul.md', '日常/LPT1.txt', '账本/尾部.', '账本/ 前导', 'a//b', '.hidden', 'a\n目录', '\\\\server\\share', '财务/../资料']) assert.throws(() => validRoot(root), root);
});

test('恢复不会覆盖只有账户、尚无流水的目录', async () => {
  const io = new MemoryIO(), src = new Repository(io, '来源', () => TODAY); await src.load(); await src.saveConfig(config()); const backup = src.exportBackup();
  const dst = new Repository(io, '已有账户', () => TODAY); await dst.load(); await dst.saveConfig({ ...config(), reservedCents: 123 }); const before = io.files.get('已有账户/配置.md');
  await assert.rejects(dst.restoreBackup(backup), /为空账本/); assert.equal(io.files.get('已有账户/配置.md'), before);
});

test('恢复不会覆盖只有草稿或普通笔记的目录', async () => {
  const io = new MemoryIO(), src = new Repository(io, '来源', () => TODAY); await src.load(); await src.saveConfig(config()); const backup = src.exportBackup();
  for (const root of ['已有草稿', '已有笔记']) {
    const dst = new Repository(io, root, () => TODAY); await dst.load();
    if (root === '已有草稿') await dst.saveDraft(newDraft('还未整理的私人原文', TODAY)); else io.files.set(`${root}/个人笔记.md`, '原文保留');
    const before = [...io.files]; await assert.rejects(dst.restoreBackup(backup), /为空账本/); assert.deepEqual([...io.files], before);
  }
});

test('残缺草稿字段被隔离，原件保持不变且不进入可编辑列表', async () => {
  const io = new MemoryIO(), repo = new Repository(io, 'LifeLedger', () => TODAY); await repo.load();
  const bad = { ...newDraft('损坏样本', TODAY), rows: [{ id: 'missing-fields' }] }; const path = 'LifeLedger/草稿/损坏.md', text = documentFor('测试', bad); io.files.set(path, text);
  await repo.load(); assert.equal(repo.drafts.length, 0); assert.equal(repo.state.issues.length, 1); assert.equal(io.files.get(path), text);
});

test('坏备份草稿在任何配置或批次写入之前拒绝', async () => {
  const io = new MemoryIO(), src = new Repository(io, '来源', () => TODAY); await src.load(); await src.saveConfig(config());
  const backup = JSON.parse(JSON.stringify(src.exportBackup())); backup.drafts = [{ ...newDraft('坏草稿', TODAY), rows: [{ id: 'missing-fields' }] }]; const { checksum, ...body } = backup; backup.checksum = sha256(JSON.stringify(body));
  const dst = new Repository(io, '全新', () => TODAY); await dst.load(); await assert.rejects(dst.restoreBackup(backup), /草稿格式/); assert.equal((await io.list('全新/')).length, 0);
});

test('草稿保存校验ID，旧窗口修订冲突不覆盖新原文', async () => {
  const io = new MemoryIO(), repo = new Repository(io, 'LifeLedger', () => TODAY); await repo.load();
  const draft = newDraft('午饭二十三', TODAY); await repo.saveDraft(draft); const old = structuredClone(draft); draft.text = '午饭二十四'; await repo.saveDraft(draft);
  old.text = '午饭二十五'; await assert.rejects(repo.saveDraft(old), /另一处修改/); const content = structuredBlock(io.files.get(`LifeLedger/草稿/${draft.id}.md`)!) as typeof draft; assert.equal(content.text, '午饭二十四');
  await assert.rejects(repo.saveDraft({ ...draft, id: '../../escape' }), /格式/); assert.ok(![...io.files.keys()].some(p => p.includes('escape')));
});

test('没有新增收支时，人工确认记完可只保存完整度事件', () => {
  const draft = newDraft('今天没有收支', TODAY); draft.completeDates = [TODAY]; const result = draftEvents(draft, config(), emptyState(), 'zero', TODAY);
  assert.equal(result.savedIds.length, 0); assert.equal(result.events.length, 1); assert.equal(result.events[0].type, 'day.set');
  draft.rows = [blankRow(TODAY)]; assert.throws(() => draftEvents(draft, config(), emptyState(), 'incomplete', TODAY), /必要信息/);
});


test('丢弃草稿进入回收站，已保存流水不变；旧修订不能丢弃新原文', async () => {
  const io = new MemoryIO(), repo = new Repository(io, 'LifeLedger', () => TODAY); await repo.load(); await repo.saveConfig(config()); await repo.commit([{ type: 'transaction.put', expected: 0, value: tx('expense', 800) }], 'saved', '保存');
  const draft = newDraft('未整理的原文', TODAY); await repo.saveDraft(draft); const old = structuredClone(draft); draft.text = '新修正原文'; await repo.saveDraft(draft); await assert.rejects(repo.discardDraft(old), /另一处修改/);
  const path = `LifeLedger/草稿/${draft.id}.md`; await repo.discardDraft(draft); assert.ok(!io.files.has(path)); assert.ok(io.trashed.get(path)?.includes('新修正原文')); await repo.load(); assert.equal(repo.state.transactions.size, 1); assert.equal(repo.drafts.length, 0);
});


test('损坏草稿保留并提示，健康账本仍可记录；完整备份须先处理该草稿', async () => {
  const io = new MemoryIO(), repo = new Repository(io, 'LifeLedger', () => TODAY); await repo.load(); await repo.saveConfig(config()); const path = 'LifeLedger/草稿/损坏.md', text = documentFor('损坏', { ...newDraft('保留原件', TODAY), rows: [{ id: 'missing' }] }); io.files.set(path,text); await repo.load();
  await repo.commit([{ type:'transaction.put',expected:0,value:tx('expense',800) }],'healthy','保存健康账目'); assert.equal(repo.state.transactions.size,1); assert.equal(io.files.get(path),text); await assert.rejects(async()=>repo.exportBackup(),/错误/);
});
