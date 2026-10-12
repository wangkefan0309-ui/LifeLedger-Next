import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, blankRow, cents, daysBetween, quotedCents } from '../src/core/primitives';
import { applyEvents, replay, sealBatch } from '../src/core/ledger';
import { emptyState, type Cost, type LedgerEvent } from '../src/core/types';
import { baseline, costOn, dayStatus, freedom, funds, series, totals } from '../src/core/calculations';
import { draftEvents, newDraft, rowIssues } from '../src/core/drafts';
import { config, TODAY, tx } from './fixtures';
const put = (value: ReturnType<typeof tx>): LedgerEvent => ({ type: 'transaction.put', expected: 0, value });

test('金额严格为整数分，口播中明确的中文金额可交叉核对', () => {
  assert.equal(cents('3.20'), 320); assert.equal(cents('-0.01', true), -1);
  for (const bad of ['1.001', '1e3', 'NaN', 'Infinity', '¥1', '1,000']) assert.throws(() => cents(bad));
  assert.equal(quotedCents('三块二'), 320); assert.equal(quotedCents('八千'), 800000); assert.equal(quotedCents('五十'), 5000); assert.equal(quotedCents('几十块'), null);
});
test('日常五笔：收入300、支出71、余额28229，并可分账户入账', () => {
  const c = config(), values = [tx('expense', 800), tx('expense', 2500), tx('expense', 3200), tx('expense', 600, { categoryId: 'transport' }), tx('income', 30000, { accountId: 'reserve' })];
  const s = applyEvents(emptyState(), values.map(put), c, TODAY); assert.equal(funds(s, c, TODAY).assets, 2822900);
  assert.deepEqual(totals(values), { income: 30000, expense: 7100, refund: 0, netExpense: 7100, surplus: 22900, passive: 0 });
  assert.equal(funds(s, c, TODAY).balances.get('activity'), 292900); assert.equal(funds(s, c, TODAY).balances.get('reserve'), 530000);
});
test('不足一日的零头保留，5元加45元点亮一格', () => {
  const c = config(), first = applyEvents(emptyState(), [put(tx('income', 500))], c, TODAY);
  assert.equal(freedom(first, c, TODAY).count, 560);
  const second = applyEvents(first, [put(tx('income', 4500))], c, TODAY); assert.equal(freedom(second, c, TODAY).count, 561);
});
test('内部转账两端同步；无收入支出；折价账户仅改变可用范围', () => {
  const c = config(), transfer = tx('transfer', 100000, { accountId: null, categoryId: null, fromAccountId: 'activity', toAccountId: 'reserve' });
  const s = applyEvents(emptyState(), [put(transfer)], c, TODAY); assert.equal(funds(s, c, TODAY).assets, 2800000); assert.equal(freedom(s, c, TODAY).count, 560); assert.equal(totals([transfer]).surplus, 0);
  assert.equal(funds(s, c, TODAY).balances.get('activity'), 200000); assert.equal(funds(s, c, TODAY).balances.get('reserve'), 600000);
  const weighted = { ...c, accounts: c.accounts.map(a => a.id === 'reserve' ? { ...a, freedomBps: 0 } : a) };
  assert.equal(funds(s, weighted, TODAY).available - funds(emptyState(), weighted, TODAY).available, -100000);
  assert.throws(() => applyEvents(emptyState(), [put({ ...transfer, toAccountId: 'activity' })], c, TODAY));
});
test('借款现金和负债一起增加；还本金不算支出，利息单列', () => {
  const c = config(), borrow = tx('borrow', 100000, { debtAccountId: 'debt', categoryId: null });
  let s = applyEvents(emptyState(), [put(borrow)], c, TODAY); assert.equal(funds(s, c, TODAY).assets, 2900000); assert.equal(funds(s, c, TODAY).liabilities, 100000); assert.equal(freedom(s, c, TODAY).count, 560);
  const repay = tx('repayment', 50000, { debtAccountId: 'debt', categoryId: null }); s = applyEvents(s, [put(repay), put(tx('expense', 200))], c, TODAY);
  assert.equal(funds(s, c, TODAY).liabilities, 50000); assert.equal(funds(s, c, TODAY).available, 2799800);
  assert.throws(() => applyEvents(s, [put(tx('repayment', 60000, { debtAccountId: 'debt', categoryId: null }))], c, TODAY), /超过/);
});
test('历史账目分析不再次累加到今天的余额锚点；预留只扣一次', () => {
  const c = { ...config(), reservedCents: 100000 };
  const s = applyEvents(emptyState(), [put(tx('expense', 800000, { date: '2026-10-01' }))], c, TODAY);
  assert.equal(funds(s, c, TODAY).available, 2700000); assert.equal(funds(s, c, '2026-10-01').balances.get('activity'), null);
});
test('用完期初资产后不保留虚假的自由格；蓝金分段不二次取整', () => {
  const c = config(); const s = applyEvents(emptyState(), [put(tx('expense', 3000000))], c, TODAY);
  assert.equal(freedom(s, c, TODAY).count, 0); assert.equal(freedom(s, c, TODAY).blue, 0);
  const grown = applyEvents(emptyState(), [put(tx('income', 5500))], c, TODAY); const f = freedom(grown, c, TODAY); assert.equal(f.blue + f.gold, f.count);
});
test('完整基线停在缺失日；零日确认不制造交易；未来不能确认', () => {
  const c = { ...config(), observationStart: '2026-10-01' }, s = applyEvents(emptyState(), [put(tx('expense', 10000, { date: '2026-10-01' })), { type: 'day.set', date: '2026-10-01', complete: true, expected: 0 }, put(tx('expense', 100000, { date: '2026-10-03' }))], c, TODAY);
  assert.equal(baseline(s, c, TODAY).daily, 10000); assert.equal(baseline(s, c, TODAY).end, '2026-10-01');
  const complete = applyEvents(s, [{ type: 'day.set', date: '2026-10-02', complete: true, expected: 0 }], c, TODAY);
  assert.equal(complete.transactions.size, 2); assert.equal(baseline(complete, c, TODAY).daily, 5000); assert.equal(dayStatus(complete, '2026-10-02', TODAY), '零收支');
  assert.throws(() => applyEvents(s, [{ type: 'day.set', date: '2026-10-13', complete: true, expected: 0 }], c, TODAY));
  assert.equal(series(s, c, '2026-10-01', '2026-10-03')[1].expense, null);
});
test('同一天多次保存与一次保存的日终成本和亮格一致', () => {
  const c = config(), entries = [tx('income', 30000), tx('expense', 7100)], day: LedgerEvent = { type: 'day.set', date: TODAY, complete: true, expected: 0 };
  const a = applyEvents(emptyState(), [...entries.map(put), day], c, TODAY); let b = emptyState(); for (const t of entries) b = applyEvents(b, [put(t)], c, TODAY); b = applyEvents(b, [day], c, TODAY);
  assert.deepEqual(freedom(a, c, TODAY), freedom(b, c, TODAY));
});
test('退款影响到账现金与净支出；区间之前的消费不冲减区间生活成本', () => {
  const c = config(), original = tx('expense', 10000, { date: '2026-10-01' }), refund = tx('refund', 8000, { relatedId: original.id });
  const s = applyEvents(emptyState(), [put(original), put(refund), put(tx('expense', 5000)), { type: 'day.set', date: TODAY, complete: true, expected: 0 }], c, TODAY);
  assert.equal(funds(s, c, TODAY).assets, 2803000); assert.equal(totals([...s.transactions.values()]).netExpense, 7000); assert.equal(baseline(s, c, TODAY).daily, 5000);
  const unlinked = applyEvents(emptyState(), [put(tx('refund', 8000)), put(tx('expense', 5000)), { type: 'day.set', date: TODAY, complete: true, expected: 0 }], c, TODAY); assert.equal(baseline(unlinked, c, TODAY).daily, 5000);
  assert.throws(() => applyEvents(s, [put(tx('refund', 3000, { relatedId: original.id }))], c, TODAY), /超过/);
});
test('净生活支出为零时显示样本不足，不计算无限自由天数', () => {
  const c = config(), s = applyEvents(emptyState(), [{ type: 'day.set', date: TODAY, complete: true, expected: 0 }], c, TODAY); assert.equal(freedom(s, c, TODAY).count, null);
});
test('成本按闰年分摊，最后累计准确；日成本不再次扣账户', () => {
  const c = config(), purchase = tx('expense', 800000, { accountId: 'asset', categoryId: 'device' });
  const cost: Cost = { id: 'computer', version: 1, batchId: 'batch-test', transactionId: purchase.id, name: '电脑', kind: 'device', amountCents: 800000, residualCents: 0, start: '2026-10-11', end: '2030-10-11', stoppedOn: null, autoRenew: false, adjustmentNotes: [] };
  const s = applyEvents(emptyState(), [put(purchase), { type: 'cost.put', expected: 0, value: cost }], c, TODAY);
  assert.equal(daysBetween(cost.start, cost.end!), 1461); assert.equal(costOn(cost, cost.end!).allocated, 800000);
  let exact = 0; for (let d = cost.start; d < cost.end!; d = addDays(d, 1)) exact += costOn(cost, d).exactToday; assert.equal(exact, 800000);
  assert.equal(funds(s, c, TODAY).assets, 2000000); assert.equal(funds(s, c, addDays(TODAY, 1)).assets, 2000000);
  assert.equal(costOn({ ...cost, end: null }, TODAY).status, '待设置期限');
  assert.equal(costOn({ ...cost, stoppedOn: TODAY }, TODAY).daily, 0);
});
test('关联购买唯一，重复成本和重叠订阅无法保存', () => {
  const c = config(), purchase = tx('expense', 24000), cost: Cost = { id: 'm1', version: 1, batchId: 'b', transactionId: purchase.id, name: '会员', kind: 'subscription', amountCents: 24000, residualCents: 0, start: TODAY, end: '2027-10-12', stoppedOn: null, autoRenew: true, adjustmentNotes: [] };
  const s = applyEvents(emptyState(), [put(purchase), { type: 'cost.put', expected: 0, value: cost }], c, TODAY);
  assert.throws(() => applyEvents(s, [{ type: 'cost.put', expected: 0, value: { ...cost, id: 'm2' } }], c, TODAY));
  assert.throws(() => applyEvents(s, [{ type: 'cost.put', expected: 0, value: { ...cost, id: 'm3', transactionId: null } }], c, TODAY), /重叠/);
});
test('区间汇总进入流量统计，但不伪造逐日曲线或完整度', () => {
  const c = { ...config(), observationStart: '2026-10-01' }, summary = tx('expense', 30000, { date: '2026-10-07', dateRange: { start: '2026-10-01', end: '2026-10-07' } });
  const s = applyEvents(emptyState(), [put(summary)], c, TODAY); assert.equal(totals([summary]).expense, 30000); assert.equal(series(s, c, '2026-10-07', '2026-10-07')[0].expense, null);
  assert.throws(() => applyEvents(s, [{ type: 'day.set', date: '2026-10-03', complete: true, expected: 0 }], c, TODAY), /逐日完整/);
});
test('草稿缺任一端不能绕过UI；部分保存保留疑问且不确认日终', () => {
  const c = config(), draft = newDraft('', TODAY), row = { ...blankRow(TODAY), kind: 'transfer' as const, amount: '500', fromAccountId: '', toAccountId: 'reserve', reviewed: true, edited: true }; draft.rows = [row];
  assert.ok(rowIssues(row, c, emptyState(), draft, TODAY).includes('转出账户待补')); assert.throws(() => draftEvents(draft, c, emptyState(), 'b', TODAY));
  draft.rows.push({ ...blankRow(TODAY), amount: '8', accountId: 'activity', reviewed: true, edited: true }); draft.completeDates = [TODAY];
  const built = draftEvents(draft, c, emptyState(), 'b', TODAY); assert.equal(built.savedIds.length, 1); assert.equal(built.events.some(e => e.type === 'day.set'), false);
});
test('并行更正保留冲突文件，不按时间静默覆盖；坏JSON或坏校验不入账', () => {
  const c = config(), t = tx('expense', 800), first = sealBatch([put(t)], 'r1', 'first', null, 'b1');
  const change = (amountCents: number, bid: string) => sealBatch([{ type: 'transaction.put', expected: 1, value: { ...t, amountCents, version: 2 } }], bid, '更正', 'b1', bid);
  const state = replay([{ path: 'a', batch: first }, { path: 'b', batch: change(900, 'b2') }, { path: 'c', batch: change(1000, 'b3') }], c, TODAY);
  assert.equal(state.issues.length, 1); assert.equal(state.transactions.size, 1);
  const bad = replay([{ path: 'null', batch: null as never }, { path: 'bad', batch: { ...first, checksum: 'bad' } }], c, TODAY); assert.equal(bad.transactions.size, 0); assert.equal(bad.issues.length, 2);
});
test('日期有效性、观察起点与区间外暂估边界', () => {
  const c = config(); assert.throws(() => applyEvents(emptyState(), [put(tx('expense', 100, { date: '2026-02-29' }))], c, TODAY));
  assert.equal(baseline(emptyState(), c, '2026-10-11').daily, null);
});
