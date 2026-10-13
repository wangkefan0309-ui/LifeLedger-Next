import { cents, id, localDate, quotedCents, validDate } from './primitives';
import { applyEvents, requireThat } from './ledger';
import type { Config, Cost, Draft, DraftRow, LedgerEvent, LedgerState, Transaction } from './types';
import { accountCurrency, baseAmount, isCurrency, parseRate, RATE_SCALE, rateFor, rateText, roundedRatio, valuationFor } from './currency';
import { draftOriginalText, imageQuotedCents } from './image-evidence';
export function newDraft(text = '', today = localDate()): Draft {
  return { version: 1, id: id(), revision: 0, text, textHistory: [], submittedDate: today, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, rows: [], excluded: [], completeDates: [], status: 'editing', error: '', requestId: id(), usage: null };
}
export function rowIssues(row: DraftRow, config: Config, state: LedgerState, draft: Draft, today = localDate()): string[] {
  const errors: string[] = [];
  if (row.kind === 'unknown') errors.push('请明确这笔钱的用途和类型');
  if (!validDate(row.date) || row.date > today) errors.push('请填写已发生的有效日期');
  if (!row.amount) errors.push('金额待补');
  else { try { const value = cents(row.amount, row.kind === 'adjustment'); if (row.kind === 'adjustment' ? value === 0 : value <= 0) errors.push('金额需大于零'); } catch (e) { errors.push((e as Error).message); } }
  const evidence = row.imageId ? draft.imageEvidence?.find(image => image.id === row.imageId)?.text ?? '' : draft.text;
  if (!row.edited && (evidence || row.imageId)) {
    if (!row.sourceQuote || !evidence.includes(row.sourceQuote)) errors.push('原文引用不一致，需手工核对并修改');
    if (!row.amountQuote || !row.sourceQuote.includes(row.amountQuote)) errors.push('缺少原文金额证据，需手工核对并修改');
    else { try { const exact = row.imageId ? imageQuotedCents(row.amountQuote) : quotedCents(row.amountQuote); if (exact === null || exact !== cents(row.amount)) errors.push('金额与原文无法自动对应，请核对并修改'); } catch { /* invalid amount already reported */ } }
    if (/明天|准备|计划|打算|将要/.test(row.sourceQuote)) errors.push('原文包含未来计划，请核对实际发生日期与用途');
  }
  const transfers = ['transfer', 'lend', 'collect'].includes(row.kind);
  const source = config.accounts.find(a => a.id === (transfers ? row.fromAccountId : row.accountId));
  const target = config.accounts.find(a => a.id === row.toAccountId);
  if (row.currency !== undefined && !isCurrency(row.currency)) errors.push('币种无效');
  if (source && row.currency && row.currency !== accountCurrency(source)) errors.push('原文金额币种与账户不一致，请核对后修改');
  if (source && accountCurrency(source) !== 'CNY') { try { row.rateCny ? parseRate(row.rateCny) : rateFor(config, accountCurrency(source)); } catch (e) { errors.push((e as Error).message); } }
  if (transfers && source && target && accountCurrency(source) !== accountCurrency(target)) {
    if (row.kind !== 'transfer') errors.push('借出与收回本金暂须同币种账户');
    try { if (!row.receivedAmount || cents(row.receivedAmount) <= 0) errors.push('换汇实际到账金额待补'); } catch { errors.push('换汇到账金额需为正数，最多两位小数'); }
    if (!row.edited && row.receivedAmount) { try { if (!row.receivedAmountQuote || !row.sourceQuote.includes(row.receivedAmountQuote) || (row.imageId ? imageQuotedCents(row.receivedAmountQuote) : quotedCents(row.receivedAmountQuote)) !== cents(row.receivedAmount)) errors.push('实际到账金额缺少原文证据，请手工核对并修改'); } catch { /* invalid received amount already reported */ } }
  }
  const isAsset = (aid: string) => config.accounts.some(a => a.id === aid && a.kind === 'asset');
  if (transfers) {
    if (!isAsset(row.fromAccountId)) errors.push('转出账户待补');
    if (!isAsset(row.toAccountId)) errors.push('转入账户待补');
    if (row.fromAccountId && row.fromAccountId === row.toAccountId) errors.push('两端不能是同一账户');
  } else if (!isAsset(row.accountId)) errors.push('收支账户待补');
  if (['borrow', 'repayment'].includes(row.kind) && !config.accounts.some(a => a.id === row.debtAccountId && a.kind === 'liability')) errors.push('请明确对应的负债账户');
  const debt = config.accounts.find(a => a.id === row.debtAccountId);
  if (['borrow', 'repayment'].includes(row.kind) && source && debt && accountCurrency(source) !== accountCurrency(debt)) errors.push('借还本金的两端账户须同币种');
  const related = state.transactions.get(row.relatedId);
  if (row.kind === 'refund' && related && source && (related.valuation?.currency ?? 'CNY') !== accountCurrency(source)) errors.push('关联退款币种须与原消费一致');
  if (row.kind === 'refund' && !row.relatedId && !row.categoryId) errors.push('请关联原消费或明确退款分类');
  if (row.categoryId && !config.categories.some(c => c.id === row.categoryId && c.kind === (row.kind === 'income' ? 'income' : 'expense'))) errors.push('分类不存在或类型不符，请重新选择');
  if (row.cost) {
    if (row.kind !== 'expense') errors.push('成本项目需关联一笔支出');
    if (!row.cost.name.trim() || !validDate(row.cost.start)) errors.push('成本项目名称或开始日期待补');
    if (row.cost.end && (!validDate(row.cost.end) || row.cost.end <= row.cost.start)) errors.push('成本结束日须晚于开始日');
  }
  return [...new Set(errors)];
}
export function draftEvents(draft: Draft, config: Config, state: LedgerState, batchId: string, today = localDate()): { events: LedgerEvent[]; savedIds: string[] } {
  const events: LedgerEvent[] = [], savedIds: string[] = [];
  const already = new Set([...state.transactions.values()].filter(t => t.draftId === draft.id).map(t => t.rowId));
  for (const row of draft.rows) {
    if (already.has(row.id)) continue;
    if (!row.reviewed || rowIssues(row, config, state, draft, today).length) continue;
    const transfers = ['transfer', 'lend', 'collect'].includes(row.kind);
    const source = config.accounts.find(a => a.id === (transfers ? row.fromAccountId : row.accountId))!;
    const currency = accountCurrency(source);
    const override = row.rateCny && currency !== 'CNY' && row.rateCny !== rateText(rateFor(config, currency)) ? row.rateCny : undefined;
    const value: Transaction = {
      id: `tx-${draft.id}-${row.id}`, version: 1, batchId, draftId: draft.id, rowId: row.id,
      kind: row.kind as Transaction['kind'], date: row.date, dateRange: row.dateRange, amountCents: cents(row.amount, row.kind === 'adjustment'),
      accountId: transfers ? null : row.accountId || null, fromAccountId: transfers ? row.fromAccountId : null,
      toAccountId: transfers ? row.toAccountId : null, debtAccountId: ['borrow', 'repayment'].includes(row.kind) ? row.debtAccountId : null,
      categoryId: ['income', 'expense', 'refund'].includes(row.kind) ? row.categoryId || null : null,
      relatedId: row.kind === 'refund' ? row.relatedId || null : null, incomeSource: row.incomeSource,
      note: row.note, sourceQuote: row.sourceQuote, originalText: draftOriginalText(draft),
      corrections: [...(row.edited ? [`用户核对并修正草稿：${JSON.stringify(row)}`] : []), ...(draft.textHistory?.length ? [`输入原文修订记录：${JSON.stringify(draft.textHistory)}`] : [])]
    };
    const valuation = valuationFor(config, currency, override, override ? row.date : undefined);
    if (valuation) value.valuation = valuation;
    const target = config.accounts.find(a => a.id === row.toAccountId);
    if (transfers && target && accountCurrency(target) !== currency) value.exchange = { receivedCents: cents(row.receivedAmount!), valuation: valuationFor(config, accountCurrency(target)) ?? { currency: 'CNY', rate: RATE_SCALE, asOf: row.date, source: '人民币本币' } };
    events.push({ type: 'transaction.put', expected: 0, value }); savedIds.push(row.id);
    if (row.cost) {
      const residual = cents(row.cost.residual || '0');
      const cost: Cost = { id: `cost-${value.id}`, version: 1, batchId, transactionId: value.id, name: row.cost.name, kind: row.cost.kind, amountCents: baseAmount(value), residualCents: valuation ? roundedRatio(residual, valuation.rate, RATE_SCALE) : residual, start: row.cost.start, end: row.cost.end || null, stoppedOn: null, autoRenew: row.cost.autoRenew, adjustmentNotes: [] };
      events.push({ type: 'cost.put', expected: 0, value: cost });
    }
  }
  requireThat(savedIds.length > 0 || (draft.rows.length === 0 && draft.completeDates.length > 0), '请补齐必要信息并勾选已核对的账目');
  if (savedIds.length === draft.rows.filter(r => !already.has(r.id)).length) {
    for (const date of [...new Set(draft.completeDates)]) events.push({ type: 'day.set', date, complete: true, expected: state.days.get(date)?.version ?? 0 });
  }
  applyEvents(state, events, config, today);
  return { events, savedIds };
}
