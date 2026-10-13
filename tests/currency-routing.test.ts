import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountCurrency, baseAmount, convertMoney, parseRate, RATE_SCALE, valuationFor } from '../src/core/currency';
import { applyEvents, validateConfig } from '../src/core/ledger';
import { balances, funds, livingCost, totals } from '../src/core/calculations';
import { draftEvents, newDraft, rowIssues } from '../src/core/drafts';
import { emptyState, type Config, type LedgerEvent } from '../src/core/types';
import { parseExtraction } from '../src/api/extractor';
import { parseReferenceRates } from '../src/api/exchange-rates';
import { Repository } from '../src/storage/repository';
import { apiEntry, config, MemoryIO, TODAY, tx } from './fixtures';
const put = (value: ReturnType<typeof tx>): LedgerEvent => ({ type: 'transaction.put', expected: 0, value });
function fxConfig(): Config {
  const c = config(); c.exchangeRates = { asOf: TODAY, fetchedAt: `${TODAY}T08:00:00Z`, source: '虚拟测试汇率', USD: parseRate('7'), HKD: parseRate('0.9') };
  c.accounts.push(
    { id: 'usd', name: '汇丰美元', aliases: [], kind: 'asset', currency: 'USD', displayCurrency: 'CNY', openingCents: 100000, openingDate: TODAY, freedomBps: 10000 },
    { id: 'hkd', name: '众安港币', aliases: [], kind: 'asset', currency: 'HKD', displayCurrency: 'CNY', openingCents: 500000, openingDate: TODAY, freedomBps: 10000 },
    { id: 'meal', name: '食堂饭卡', aliases: ['学校食堂', '食堂', '饭卡'], kind: 'asset', openingCents: 30000, openingDate: TODAY, freedomBps: 0 }
  ); c.accounts[0].aliases = ['微信']; c.accounts[1].aliases = ['支付宝']; return c;
}
const response = (entry: Record<string, unknown>, version = 2) => ({ version, entries: [entry], excluded: [], complete_dates: [] });

test('三币种双向换算保留整数分，半分四舍五入且零和负数正确', () => {
  const c = fxConfig();
  assert.equal(convertMoney(10000, 'USD', 'CNY', c), 70000);
  assert.equal(convertMoney(70000, 'CNY', 'USD', c), 10000);
  assert.equal(convertMoney(10000, 'HKD', 'CNY', c), 9000);
  assert.equal(convertMoney(9000, 'CNY', 'HKD', c), 10000);
  assert.equal(convertMoney(90000, 'USD', 'HKD', c), 700000);
  assert.equal(convertMoney(700000, 'HKD', 'USD', c), 90000);
  assert.equal(convertMoney(0, 'HKD', 'USD', c), 0);
  assert.equal(convertMoney(-1, 'USD', 'CNY', c), -7);
  c.exchangeRates!.HKD = parseRate('0.5'); assert.equal(convertMoney(1, 'HKD', 'CNY', c), 1); assert.equal(convertMoney(-1, 'HKD', 'CNY', c), -1);
  for (const rate of ['0', '-1', 'NaN', '1e3', '0.123456789']) assert.throws(() => parseRate(rate));
});
test('参考回复只接受完整三币种日期和正汇率，不替换坏缓存', () => {
  const rows = [{ date: TODAY, base: 'CNY', quote: 'USD', rate: .125 }, { date: TODAY, base: 'CNY', quote: 'HKD', rate: 1.25 }];
  const rates = parseReferenceRates(rows, new Date(`${TODAY}T12:00:00Z`)); assert.equal(rates.USD, parseRate('8')); assert.equal(rates.HKD, parseRate('0.8'));
  assert.throws(() => parseReferenceRates(rows.slice(0, 1)));
  assert.throws(() => parseReferenceRates(rows.map(row => ({ ...row, rate: 0 }))));
  assert.throws(() => parseReferenceRates(rows.map(row => ({ ...row, date: '2199-01-01' }))));
  assert.throws(() => parseReferenceRates([rows[0], { ...rows[1], date: '2026-10-11' }]));
});
test('外币本币余额不混加，资产和纳入比例统一折人民币', () => {
  const c = fxConfig(); const f = funds(emptyState(), c, TODAY);
  assert.equal(f.balances.get('usd'), 100000); assert.equal(f.balances.get('hkd'), 500000);
  assert.equal(f.assets, 2800000 + 700000 + 450000 + 30000); assert.equal(f.available, f.assets - 30000);
  delete c.exchangeRates; assert.throws(() => validateConfig(c), /汇率未设置/);
  assert.equal(accountCurrency(config().accounts[0]), 'CNY');
});
test('普通外币支出冻结历史折算，更新参考汇率只重估当前资产', () => {
  const c = fxConfig(), value = tx('expense', 1000, { accountId: 'usd', valuation: valuationFor(c, 'USD') });
  const s = applyEvents(emptyState(), [put(value)], c, TODAY); assert.equal(balances(s, c, TODAY).get('usd'), 99000); assert.equal(totals([value]).expense, 7000);
  c.exchangeRates!.USD = parseRate('8'); assert.equal(totals([...s.transactions.values()]).expense, 7000); assert.equal(livingCost(s, c, TODAY, TODAY), 7000);
  assert.equal(funds(s, c, TODAY).assets, 2800000 + 792000 + 450000 + 30000);
});
test('换汇实际扣款到账分别更新两端，本金不计收入支出', () => {
  const c = fxConfig(), value = tx('transfer', 10000, { accountId: null, categoryId: null, fromAccountId: 'usd', toAccountId: 'hkd', valuation: valuationFor(c, 'USD'), exchange: { receivedCents: 77500, valuation: valuationFor(c, 'HKD')! } });
  const s = applyEvents(emptyState(), [put(value)], c, TODAY);
  assert.equal(balances(s, c, TODAY).get('usd'), 90000); assert.equal(balances(s, c, TODAY).get('hkd'), 577500);
  assert.equal(totals([...s.transactions.values()]).income, 0); assert.equal(totals([...s.transactions.values()]).expense, 0);
  assert.throws(() => applyEvents(emptyState(), [put({ ...value, exchange: undefined })], c, TODAY), /实际到账/);
  assert.throws(() => applyEvents(emptyState(), [put({ ...value, exchange: { ...value.exchange!, receivedCents: -1 } })], c, TODAY));
  assert.throws(() => applyEvents(emptyState(), [put({ ...value, valuation: undefined })], c, TODAY), /币种/);
});
test('跨币种换汇重开、备份恢复和整批撤销完整保留两端', async () => {
  const c = fxConfig(), io = new MemoryIO(), r = new Repository(io, '多币种', () => TODAY); await r.load(); await r.saveConfig(c);
  const value = tx('transfer', 10000, { accountId: null, categoryId: null, fromAccountId: 'usd', toAccountId: 'hkd', valuation: valuationFor(c, 'USD'), exchange: { receivedCents: 77500, valuation: valuationFor(c, 'HKD')! } });
  const batch = await r.commit([put(value)], 'fx-request', '真实到账换汇'); const reopened = new Repository(io, '多币种', () => TODAY); await reopened.load(); assert.deepEqual(reopened.state.transactions.get(value.id), value);
  const restored = new Repository(io, '多币种恢复', () => TODAY); await restored.load(); await restored.restoreBackup(r.exportBackup()); assert.equal(funds(restored.state, restored.config, TODAY).balances.get('hkd'), 577500);
  await r.undo(batch.id); assert.equal(funds(r.state, r.config, TODAY).balances.get('hkd'), 500000); assert.equal(funds(r.state, r.config, TODAY).balances.get('usd'), 100000);
  await assert.rejects(r.saveConfig({ ...r.config, accounts: r.config.accounts.map(a => a.id === 'usd' ? { ...a, currency: 'HKD' } : a) }), /历史流水/);
});
test('换汇之后不能改账户币种或伪造快照，同币种仍须等额', () => {
  const c = fxConfig(), value = tx('expense', 1000, { accountId: 'usd', valuation: valuationFor(c, 'USD') });
  assert.throws(() => applyEvents(emptyState(), [put({ ...value, valuation: { ...value.valuation!, rate: 0 } })], c, TODAY));
  const transfer = tx('transfer', 100, { accountId: null, categoryId: null, fromAccountId: 'activity', toAccountId: 'reserve', exchange: { receivedCents: 50, valuation: { currency: 'CNY', rate: RATE_SCALE, asOf: TODAY, source: '本币' } } });
  assert.throws(() => applyEvents(emptyState(), [put(transfer)], c, TODAY), /同币种/);
});
test('港币消费关联成本只按保存时人民币金额分摊一次', () => {
  const c = fxConfig(), d = newDraft('', TODAY); const row = { id: 'foreign-cost', kind: 'expense' as const, date: TODAY, dateRange: null, amount: '100', accountId: 'hkd', fromAccountId: '', toAccountId: '', debtAccountId: '', categoryId: 'device', relatedId: '', incomeSource: 'active' as const, note: '设备', sourceQuote: '', amountQuote: '', issues: [], reviewed: true, edited: true, usedDefault: false, currency: 'HKD' as const, cost: { name: '设备', kind: 'device' as const, start: TODAY, end: '2027-10-12', residual: '10', autoRenew: false } };
  d.rows = [row]; const built = draftEvents(d, c, emptyState(), 'cost-batch', TODAY); const s = applyEvents(emptyState(), built.events, c, TODAY);
  assert.equal(s.costs.values().next().value!.amountCents, 9000); assert.equal(s.costs.values().next().value!.residualCents, 900); assert.equal(balances(s, c, TODAY).get('hkd'), 490000);
});
test('外币退款按原消费汇率抵生活成本，避免汇率波动造负成本', () => {
  const c = fxConfig(), original = tx('expense', 1000, { accountId: 'usd', valuation: valuationFor(c, 'USD') });
  c.exchangeRates!.USD = parseRate('8'); const refund = tx('refund', 1000, { accountId: 'usd', relatedId: original.id, valuation: valuationFor(c, 'USD') });
  const s = applyEvents(emptyState(), [put(original), put(refund)], c, TODAY); assert.equal(livingCost(s, c, TODAY, TODAY), 0); assert.equal(balances(s, c, TODAY).get('usd'), 100000);
});
test('学校食堂别名优先于模型错误账户，15元只扣饭卡', () => {
  const c = fxConfig(), d = newDraft('学校食堂吃饭减 15', TODAY);
  const row = parseExtraction(response(apiEntry({ amount: '15.00', account_id: 'activity', source_quote: d.text, amount_quote: '15' })), d, c).rows[0];
  assert.equal(row.accountId, 'meal'); assert.equal(row.usedDefault, false); row.reviewed = true; d.rows = [row];
  const built = draftEvents(d, c, emptyState(), 'meal-batch', TODAY), s = applyEvents(emptyState(), built.events, c, TODAY);
  assert.equal(balances(s, c, TODAY).get('meal'), 28500); assert.equal(balances(s, c, TODAY).get('activity'), 300000);
});
test('饭卡充值误识别成收入时改为转账，缺转出账户不套默认', () => {
  const c = fxConfig();
  for (const text of ['往食堂饭卡账户里充了 50 块钱', '往食堂饭卡充50', '饭卡充 50', '往饭卡充五十块']) {
    const d = newDraft(text, TODAY);
    const row = parseExtraction(response(apiEntry({ kind: 'income', amount: '50.00', account_id: 'meal', source_quote: d.text, amount_quote: text.includes('五十') ? '五十' : '50' })), d, c).rows[0];
    assert.equal(row.kind, 'transfer'); assert.equal(row.toAccountId, 'meal'); assert.equal(row.fromAccountId, ''); assert.ok(rowIssues(row, c, emptyState(), d, TODAY).includes('转出账户待补'));
    row.reviewed = true; d.rows = [row]; assert.throws(() => draftEvents(d, c, emptyState(), 'missing-from', TODAY));
  }
});
test('从微信给饭卡充值只移动50元，支付宝食堂消费仍扣支付宝', () => {
  const c = fxConfig(), d = newDraft('从微信往食堂饭卡充了50块', TODAY);
  const row = parseExtraction(response(apiEntry({ amount: '50.00', source_quote: d.text, amount_quote: '50' })), d, c).rows[0]; row.reviewed = true; d.rows = [row];
  const s = applyEvents(emptyState(), draftEvents(d, c, emptyState(), 'recharge', TODAY).events, c, TODAY); assert.equal(balances(s, c, TODAY).get('activity'), 295000); assert.equal(balances(s, c, TODAY).get('meal'), 35000); assert.equal(totals([...s.transactions.values()]).expense, 0);
  const paid = newDraft('用支付宝在学校食堂吃饭15元', TODAY); const payment = parseExtraction(response(apiEntry({ amount: '15', account_id: 'meal', source_quote: paid.text, amount_quote: '15' })), paid, c).rows[0]; assert.equal(payment.accountId, 'reserve');
});
test('多个账户不明确时留待补，不回落默认账户', () => {
  const c = fxConfig(), d = newDraft('微信或者饭卡扣了15', TODAY); const row = parseExtraction(response(apiEntry({ amount: '15', source_quote: d.text, amount_quote: '15' })), d, c).rows[0]; assert.equal(row.accountId, ''); assert.equal(row.usedDefault, false);
});
test('多笔回复漏掉账户原文时不会用默认钱包替代食堂饭卡', () => {
  const c = fxConfig(), d = newDraft('微信早饭8元，学校食堂午饭15元', TODAY);
  const result = parseExtraction({ version: 2, entries: [apiEntry({ source_quote: '微信早饭8元', amount_quote: '8', account_id: 'activity' }), apiEntry({ amount: '15', source_quote: '午饭15元', amount_quote: '15', account_id: 'activity' })], excluded: [], complete_dates: [] }, d, c);
  assert.equal(result.rows[0].accountId, 'activity'); assert.equal(result.rows[1].accountId, ''); assert.ok(rowIssues(result.rows[1], c, emptyState(), d, TODAY).includes('收支账户待补'));
});
test('v3美元草稿保留美元并冻结人民币折算，币种冲突须修改', () => {
  const c = fxConfig(), d = newDraft('汇丰美元到账50美元', TODAY);
  const row = parseExtraction(response(apiEntry({ kind: 'income', category_id: 'creation', amount: '50', currency: 'USD', account_id: 'usd', source_quote: d.text, amount_quote: '50美元', received_amount: null, received_amount_quote: null }), 3), d, c).rows[0]; row.reviewed = true; d.rows = [row];
  const s = applyEvents(emptyState(), draftEvents(d, c, emptyState(), 'usd-income', TODAY).events, c, TODAY); assert.equal(totals([...s.transactions.values()]).income, 35000); assert.equal(balances(s, c, TODAY).get('usd'), 105000);
  const wrong = newDraft('众安港币消费50美元', TODAY); const mismatch = parseExtraction(response(apiEntry({ amount: '50', currency: 'HKD', account_id: 'hkd', source_quote: wrong.text, amount_quote: '50美元', received_amount: null, received_amount_quote: null }), 3), wrong, c).rows[0]; assert.equal(mismatch.currency, 'USD'); assert.ok(rowIssues(mismatch, c, emptyState(), wrong, TODAY).some(x => x.includes('币种与账户')));
});
