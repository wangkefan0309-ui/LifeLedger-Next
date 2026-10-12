import { addDays, daysBetween, exactRatio } from './primitives';
import type { Config, Cost, LedgerState, Transaction } from './types';

export function affects(t: Transaction, accountId: string): number {
  if (t.fromAccountId === accountId) return -t.amountCents;
  if (t.toAccountId === accountId) return t.amountCents;
  if (t.debtAccountId === accountId) return t.kind === 'borrow' ? t.amountCents : -t.amountCents;
  if (t.accountId !== accountId) return 0;
  return ['expense', 'repayment'].includes(t.kind) ? -t.amountCents : t.amountCents;
}
export function balances(state: LedgerState, c: Config, until: string): Map<string, number | null> {
  return new Map(c.accounts.map(a => [a.id, until < a.openingDate ? null : [...state.transactions.values()].filter(t => t.date >= a.openingDate && t.date <= until).reduce((n, t) => n + affects(t, a.id), a.openingCents)]));
}
export function funds(state: LedgerState, c: Config, until: string) {
  const bs = balances(state, c, until); let assets = 0, liabilities = 0, available = 0, openingAvailable = 0;
  for (const a of c.accounts) {
    const n = bs.get(a.id); if (n === null || n === undefined) continue;
    if (a.kind === 'asset') { assets += n; available += exactRatio(n, a.freedomBps, 10000); openingAvailable += exactRatio(a.openingCents, a.freedomBps, 10000); }
    else { liabilities += n; openingAvailable -= a.openingCents; }
  }
  return { assets, liabilities, net: assets - liabilities, available: available - liabilities - c.reservedCents, openingAvailable: openingAvailable - c.reservedCents, balances: bs };
}
export function totals(ts: Transaction[]) {
  let income = 0, expense = 0, refund = 0, passive = 0;
  for (const t of ts) {
    if (t.kind === 'income') { income += t.amountCents; if (t.incomeSource === 'passive') passive += t.amountCents; }
    if (t.kind === 'expense') expense += t.amountCents;
    if (t.kind === 'refund') refund += t.amountCents;
  }
  return { income, expense, refund, netExpense: expense - refund, surplus: income - expense + refund, passive };
}
export function filterTransactions(state: LedgerState, start: string, end: string, accountId = '', categoryId = ''): Transaction[] {
  return [...state.transactions.values()].filter(t => t.date >= start && t.date <= end && (!accountId || [t.accountId, t.fromAccountId, t.toAccountId, t.debtAccountId].includes(accountId)) && (!categoryId || (categoryId === '$uncategorized' ? t.categoryId === null : t.categoryId === categoryId))).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
export function livingCost(state: LedgerState, c: Config, start: string, end: string): number {
  const living = (t: Transaction) => t.categoryId === null || c.categories.find(x => x.id === t.categoryId)?.living !== false;
  let net = 0;
  for (const t of filterTransactions(state, start, end)) {
    if (t.dateRange) continue;
    if (t.kind === 'expense' && living(t)) net += t.amountCents;
    if (t.kind === 'refund' && t.relatedId) {
      const original = state.transactions.get(t.relatedId);
      if (original && original.date >= start && original.date <= end && !original.dateRange && living(original)) net -= t.amountCents;
    }
  }
  return net;
}
export function baseline(state: LedgerState, c: Config, until: string) {
  let end: string | null = null;
  for (let d = c.observationStart; d <= until; d = addDays(d, 1)) {
    if (!state.days.get(d)?.complete || [...state.transactions.values()].some(t => t.dateRange && t.dateRange.start <= d && t.dateRange.end >= d)) break;
    end = d;
  }
  const days = end ? daysBetween(c.observationStart, end) + 1 : 0;
  const netCost = end ? livingCost(state, c, c.observationStart, end) : 0;
  const daily = until < c.observationStart ? null : days ? (netCost > 0 ? netCost / days : null) : c.estimateDailyCents;
  const passive = end ? totals(filterTransactions(state, c.observationStart, end)).passive : 0;
  return { start: c.observationStart, end, days, netCost, daily, estimated: days === 0 && daily !== null, missing: end ? (end < until ? addDays(end, 1) : null) : c.observationStart, coverage: netCost > 0 ? passive / netCost : null };
}
export function freedom(state: LedgerState, c: Config, until: string) {
  const f = funds(state, c, until), b = baseline(state, c, until);
  const ratioDays = b.days || 1, denominator = b.days ? b.netCost : c.estimateDailyCents;
  const count = b.daily && b.daily > 0 && denominator ? exactRatio(Math.max(0, f.available), ratioDays, denominator) : null;
  const blue = count === null ? 0 : Math.min(count, exactRatio(Math.min(Math.max(0, f.openingAvailable), Math.max(0, f.available)), ratioDays, denominator!));
  return { ...f, baseline: b, count, blue, gold: (count ?? 0) - blue };
}
export function costOn(c: Cost, date: string) {
  if (!c.end) return { status: '待设置期限', daily: 0, exactToday: 0, allocated: 0, remaining: c.amountCents - c.residualCents, daysLeft: null };
  const duration = daysBetween(c.start, c.end), amount = c.amountCents - c.residualCents;
  const effectiveEnd = c.stoppedOn && c.stoppedOn < c.end ? c.stoppedOn : c.end;
  const covered = Math.max(0, Math.min(duration, daysBetween(c.start, date < effectiveEnd ? date : effectiveEnd)));
  const allocated = exactRatio(amount, covered, duration);
  const active = date >= c.start && date < effectiveEnd;
  return { status: c.stoppedOn && date >= c.stoppedOn ? '已停用' : date < c.start ? '尚未开始' : date >= c.end ? (c.kind === 'device' ? '已摊完、继续使用' : c.autoRenew ? '已到期、待续费' : '已到期') : '使用中', daily: active ? amount / duration : 0, exactToday: active ? exactRatio(amount, covered + 1, duration) - allocated : 0, allocated, remaining: amount - allocated, daysLeft: Math.max(0, daysBetween(date, effectiveEnd)) };
}
export function dayStatus(state: LedgerState, date: string, today: string): string {
  if (date > today) return '未来';
  const ts = filterTransactions(state, date, date);
  return state.days.get(date)?.complete ? (ts.length ? '已记完' : '零收支') : ts.length ? '记录中' : '未记录';
}
export function series(state: LedgerState, c: Config, start: string, end: string, accountId = '') {
  const points = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const ts = filterTransactions(state, d, d, accountId).filter(t => !t.dateRange);
    const complete = state.days.get(d)?.complete ?? false, total = totals(ts);
    const f = freedom(state, c, d);
    const known = complete || ts.length > 0;
    points.push({ date: d, income: known ? total.income : null, expense: known ? total.netExpense : null, daily: f.baseline.daily, freedom: c.accounts.some(a => a.openingDate > d) ? null : f.count, complete });
  }
  return points;
}
