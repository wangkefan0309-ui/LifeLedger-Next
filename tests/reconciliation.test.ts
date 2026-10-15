import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareStatement, reconciliationSummary, findDifferenceCandidates, makeCheckpoint, checkpointValid, draftEffect } from '../src/core/reconciliation';
import { newDraft, rowIssues } from '../src/core/drafts';
import { parseExtraction } from '../src/api/extractor';
import { blankRow, addDays } from '../src/core/primitives';
import { emptyState } from '../src/core/types';
import { validateConfig } from '../src/core/ledger';
import { Repository } from '../src/storage/repository';
import { config, tx, TODAY, MemoryIO, apiEntry } from './fixtures';

const NEXT = addDays(TODAY, 1);
function statement(values: { amount: string; kind?: 'income' | 'expense'; note?: string; date?: string }[]) {
  const draft = newDraft('', TODAY); draft.rows = values.map((value, index) => ({ ...blankRow(value.date ?? TODAY), kind: value.kind ?? 'expense', amount: value.amount, accountId: 'activity', note: value.note ?? '服务费', edited: true, id: `statement-${index}` })); return draft;
}
test('按日余额与区间解释不混入截止日之后流水或其他账户，包含内部转账', () => {
  const c = config(), state = emptyState();
  for (const value of [tx('income', 10000), tx('expense', 200), tx('transfer', 3000, { accountId: null, categoryId: null, fromAccountId: 'activity', toAccountId: 'reserve' }), tx('expense', 900, { date: NEXT }), tx('expense', 700, { accountId: 'reserve' })]) state.transactions.set(value.id, value);
  const result = reconciliationSummary(state, c, 'activity', TODAY, TODAY);
  assert.equal(result.opening, 300000); assert.equal(result.closing, 306800); assert.equal(result.incoming, 10000); assert.equal(result.outgoing, 3200); assert.equal(result.entries.length, 3);
  assert.equal(result.opening! + result.incoming - result.outgoing + result.adjustments, result.closing);
});
test('期初生效日前的余额是未知，不允许当零确认对账', () => {
  const c = config(), state = emptyState(), before = addDays(TODAY, -1);
  assert.equal(reconciliationSummary(state, c, 'activity', before, before).closing, null);
  assert.throws(() => makeCheckpoint(state, c, [], 'activity', before, before, 0), /生效日/);
});
test('服务费未保存可解释几元差额，查找不会修改草稿或资金', () => {
  const c = config(), state = emptyState(), draft = statement([{ amount: '2.00' }]), before = JSON.stringify(draft);
  const candidates = findDifferenceCandidates(state, c, [draft], 'activity', TODAY, TODAY, -200);
  assert.equal(candidates[0].kind, 'pending'); assert.equal(candidates[0].effectCents, -200); assert.equal(candidates[0].draftId, draft.id);
  assert.equal(JSON.stringify(draft), before); assert.equal(state.transactions.size, 0);
});
test('相同金额四笔逐条匹配，不能去重；多出或少一笔均可识别', () => {
  const c = config(), state = emptyState(); for (let i = 0; i < 4; i++) { const value = tx('expense', 200, { note: '服务费' }); state.transactions.set(value.id, value); }
  const equal = compareStatement(state, c, 'activity', TODAY, TODAY, statement(Array.from({ length: 4 }, () => ({ amount: '2.00' })))); assert.equal(equal.matched.length, 4); assert.equal(equal.exact, true);
  assert.equal(compareStatement(state, c, 'activity', TODAY, TODAY, statement([{ amount: '2.00' }])).extra.length, 3);
  const extra = compareStatement(state, c, 'activity', TODAY, TODAY, statement(Array.from({ length: 5 }, () => ({ amount: '2.00' })))); assert.equal(extra.missing.length, 1); assert.equal(state.transactions.size, 4);
});
test('同日同描述金额不同作为差异，不自动改账；方向不同不能配对', () => {
  const c = config(), state = emptyState(), value = tx('expense', 100, { note: '服务费' }); state.transactions.set(value.id, value);
  const changed = compareStatement(state, c, 'activity', TODAY, TODAY, statement([{ amount: '2.00' }])); assert.equal(changed.changed.length, 1); assert.equal(changed.changed[0].transaction.amountCents, 100);
  const direction = compareStatement(state, c, 'activity', TODAY, TODAY, statement([{ amount: '1.00', kind: 'income' }])); assert.equal(direction.missing.length, 1); assert.equal(direction.extra.length, 1);
});
test('先保留整份账单的精确匹配，前面的漏记项不抢占后面的正确记录', () => {
  const c = config(), state = emptyState(), value = tx('expense', 300, { note: '服务费' }); state.transactions.set(value.id, value);
  const result = compareStatement(state, c, 'activity', TODAY, TODAY, statement([{ amount: '2.00' }, { amount: '3.00' }]));
  assert.equal(result.matched.length, 1); assert.equal(result.matched[0].item.row.amount, '3.00');
  assert.equal(result.missing.length, 1); assert.equal(result.missing[0].row.amount, '2.00'); assert.equal(result.changed.length, 0);
});
test('错日期和错账户仅列线索，缺金额与来源证据留待核对', () => {
  const c = config(), state = emptyState(); for (const value of [tx('expense', 200, { date: NEXT }), tx('expense', 200, { accountId: 'reserve' })]) state.transactions.set(value.id, value);
  assert.ok(findDifferenceCandidates(state, c, [], 'activity', TODAY, TODAY, -200).some(item => item.kind === 'scope'));
  const draft = statement([{ amount: '' }]); assert.equal(compareStatement(state, c, 'activity', TODAY, TODAY, draft).unresolved.length, 1);
});
test('对账记录只保存证据，不产生收支或确认全天；后续改历史自动失效', () => {
  const c = config(), state = emptyState(), value = tx('expense', 200); state.transactions.set(value.id, value);
  const record = makeCheckpoint(state, c, [], 'activity', TODAY, TODAY, 299800); assert.equal(record.scope, 'balance'); assert.equal(checkpointValid(record, state, c), true); assert.equal(state.days.size, 0);
  const other = tx('income', 100, { accountId: 'reserve' }); state.transactions.set(other.id, other); assert.equal(checkpointValid(record, state, c), true);
  const future = tx('expense', 100, { date: NEXT }); state.transactions.set(future.id, future); assert.equal(checkpointValid(record, state, c), true);
  state.transactions.set(value.id, { ...value, version: 2, amountCents: 300 }); assert.equal(checkpointValid(record, state, c), false);
});
test('余额差额、未处理草稿、排除项和不完整账单不能确认已对上', () => {
  const c = config(), state = emptyState(); assert.throws(() => makeCheckpoint(state, c, [], 'activity', TODAY, TODAY, 299800), /差额/);
  assert.throws(() => makeCheckpoint(state, c, [statement([{ amount: '2.00' }])], 'activity', TODAY, TODAY, 300000), /草稿/);
  assert.throws(() => makeCheckpoint(state, c, [], 'activity', TODAY, TODAY, 300000, statement([{ amount: '2.00' }])), /差异/);
  const excluded = statement([]); excluded.excluded.push({ source_quote: '', reason: '汇总' }); assert.throws(() => makeCheckpoint(state, c, [], 'activity', TODAY, TODAY, 300000, excluded), /排除项/);
});
test('账户对账记录随配置和备份恢复，旧配置仍兼容；坏记录写入前拒绝', async () => {
  const repo = new Repository(new MemoryIO(), '账本', () => TODAY); await repo.load(); await repo.saveConfig(config());
  const record = makeCheckpoint(repo.state, repo.config, [], 'activity', TODAY, TODAY, 300000); await repo.saveConfig({ ...repo.config, reconciliations: [record] });
  const copy = new Repository(new MemoryIO(), '恢复', () => TODAY); await copy.load(); await copy.restoreBackup(repo.exportBackup()); assert.deepEqual(copy.config.reconciliations, [record]);
  validateConfig(config()); assert.throws(() => validateConfig({ ...config(), reconciliations: [{ ...record, accountId: 'missing' }] }), /对账记录/);
  assert.throws(() => validateConfig({ ...config(), reconciliations: [record, record] }), /对账记录/);
});
test('日历录入日期参与解析，明确说出的今天或昨天仍优先', () => {
  const c = config(), before = addDays(TODAY, -1), reply = (date: string | null) => ({ version: 2, entries: [apiEntry({ date })], excluded: [], complete_dates: [] });
  const undated = newDraft('早餐八块', TODAY, before); assert.equal(parseExtraction(reply(TODAY), undated, c).rows[0].date, before);
  assert.equal(parseExtraction(reply(null), undated, c).rows[0].date, before);
  assert.equal(parseExtraction(reply(TODAY), newDraft('今天早餐八块', TODAY, before), c).rows[0].date, TODAY);
  assert.equal(parseExtraction(reply(before), newDraft('昨天早餐八块', TODAY, before), c).rows[0].date, before);
});
test('文字负号服务费可核对保存，正负号与收入支出冲突仍阻止', () => {
  const c = config(), state = emptyState();
  for (const [kind, quote, allowed] of [['expense', '-2元', true], ['income', '-2元', false], ['expense', '+2元', false]] as const) {
    const draft = newDraft(`活动钱包服务费${quote}`, TODAY), rows = parseExtraction({ version: 2, entries: [apiEntry({ kind, amount: '2.00', category_id: null, source_quote: draft.text, amount_quote: quote })], excluded: [], complete_dates: [] }, draft, c).rows;
    const issues = rowIssues(rows[0], c, state, draft, TODAY); assert.equal(issues.length === 0, allowed);
  }
});
test('补账日期跨草稿重开与备份恢复保留，非法日期在写盘前拒绝', async () => {
  const repo = new Repository(new MemoryIO(), '账本', () => TODAY); await repo.load(); await repo.saveConfig(config()); const draft = newDraft('早餐八块', TODAY, addDays(TODAY, -1)); await repo.saveDraft(draft);
  const copy = new Repository(new MemoryIO(), '恢复', () => TODAY); await copy.load(); await copy.restoreBackup(repo.exportBackup()); assert.equal(copy.drafts[0].recordingDate, addDays(TODAY, -1));
  await assert.rejects(repo.saveDraft({ ...draft, recordingDate: '2026-02-30' }), /草稿格式/);
});
test('外币对账采用本币实际到账，缺换汇到账金额时不拿转出数字当到账', () => {
  const c = config(), state = emptyState(); c.accounts[1].currency = 'USD'; c.accounts[1].openingCents = 0;
  const value = tx('transfer', 10000, { accountId: null, categoryId: null, fromAccountId: 'activity', toAccountId: 'reserve', exchange: { receivedCents: 1500, valuation: { currency: 'USD', rate: 700000000, asOf: TODAY, source: '虚拟' } } }); state.transactions.set(value.id, value);
  assert.equal(reconciliationSummary(state, c, 'reserve', TODAY, TODAY).closing, 1500);
  const row = { ...blankRow(TODAY), kind: 'transfer' as const, amount: '100.00', fromAccountId: 'activity', toAccountId: 'reserve' };
  assert.equal(draftEffect(row, 'reserve', c), null); assert.equal(draftEffect({ ...row, receivedAmount: '15.00' }, 'reserve', c), 1500);
});
