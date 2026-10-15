import { addDays, cents, sha256, validDate, localDate } from './primitives';
import { affects, balances } from './calculations';
import { accountCurrency } from './currency';
import { rowIssues } from './drafts';
import { requireThat } from './ledger';
import type { Config, Draft, DraftRow, LedgerState, ReconciliationCheckpoint, Transaction } from './types';

export interface DifferenceCandidate {
  kind: 'pending' | 'extra' | 'pair' | 'duplicate' | 'scope'; message: string;
  transactionIds: string[]; draftId?: string; rowId?: string; effectCents: number | null;
}
export function reconciliationFingerprint(state: LedgerState, config: Config, accountId: string, date: string): string {
  const account = config.accounts.find(a => a.id === accountId); requireThat(account, '对账账户不存在');
  const rows = [...state.transactions.values()].filter(t => t.date >= account.openingDate && t.date <= date && [t.accountId, t.fromAccountId, t.toAccountId, t.debtAccountId].includes(accountId)).sort((a, b) => a.id.localeCompare(b.id));
  return sha256(JSON.stringify({ id: account.id, openingDate: account.openingDate, openingCents: account.openingCents, currency: accountCurrency(account), date, rows }));
}
export function checkpointValid(record: ReconciliationCheckpoint, state: LedgerState, config: Config): boolean {
  try { return record.fingerprint === reconciliationFingerprint(state, config, record.accountId, record.date) && balances(state, config, record.date).get(record.accountId) === record.actualCents; } catch { return false; }
}
export function reconciliationSummary(state: LedgerState, config: Config, accountId: string, start: string, end: string) {
  requireThat(validDate(start) && validDate(end) && start <= end && end <= localDate(), '请选择已发生且起止正确的核对日期');
  const account = config.accounts.find(a => a.id === accountId && a.kind === 'asset'); requireThat(account, '请选择资产账户');
  const closing = balances(state, config, end).get(accountId) ?? null;
  const opening = start < account.openingDate ? null : start === account.openingDate ? account.openingCents : balances(state, config, addDays(start, -1)).get(accountId) ?? null;
  const entries = [...state.transactions.values()].filter(t => t.date >= start && t.date <= end && [t.accountId, t.fromAccountId, t.toAccountId, t.debtAccountId].includes(accountId)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const incoming = entries.filter(t => t.kind !== 'adjustment' && affects(t, accountId) > 0).reduce((sum, t) => sum + affects(t, accountId), 0);
  const outgoing = entries.filter(t => t.kind !== 'adjustment' && affects(t, accountId) < 0).reduce((sum, t) => sum - affects(t, accountId), 0);
  const adjustments = entries.filter(t => t.kind === 'adjustment').reduce((sum, t) => sum + affects(t, accountId), 0);
  const checkpoint = config.reconciliations?.filter(r => r.accountId === accountId && r.date <= end).sort((a, b) => b.date.localeCompare(a.date))[0];
  return { account, opening, closing, incoming, outgoing, adjustments, entries, checkpoint, checkpointCurrent: checkpoint ? checkpointValid(checkpoint, state, config) : false };
}
export function draftEffect(row: DraftRow, accountId: string, config: Config): number | null {
  try {
    const value = cents(row.amount); if (value <= 0 || row.kind === 'unknown') return null;
    if (row.fromAccountId === accountId) return -value;
    if (row.toAccountId === accountId) {
      const source = config.accounts.find(a => a.id === row.fromAccountId), target = config.accounts.find(a => a.id === row.toAccountId);
      if (!source || !target) return null;
      if (accountCurrency(source) === accountCurrency(target)) return value;
      return row.receivedAmount && cents(row.receivedAmount) > 0 ? cents(row.receivedAmount) : null;
    }
    if (row.accountId !== accountId) return null;
    return ['expense', 'repayment'].includes(row.kind) ? -value : value;
  } catch { return null; }
}
export function pendingRows(drafts: Draft[], accountId: string, start: string, end: string, config: Config) {
  return drafts.filter(d => d.status !== 'saved').flatMap(draft => draft.rows.filter(row => row.date >= start && row.date <= end && (!row.accountId && !row.fromAccountId && !row.toAccountId || [row.accountId, row.fromAccountId, row.toAccountId].includes(accountId))).map(row => ({ draft, row, effect: draftEffect(row, accountId, config) })));
}
export function findDifferenceCandidates(state: LedgerState, config: Config, drafts: Draft[], accountId: string, start: string, end: string, difference: number): DifferenceCandidate[] {
  const report = reconciliationSummary(state, config, accountId, start, end), candidates: DifferenceCandidate[] = [];
  for (const { draft, row, effect } of pendingRows(drafts, accountId, start, end, config)) candidates.push({ kind: 'pending', message: `${row.note || '待处理账目'}：${effect === difference && difference !== 0 ? '未入账金额可解释本次差额' : '仍在草稿，尚未入账'}`, transactionIds: [], draftId: draft.id, rowId: row.id, effectCents: effect });
  const entries = report.entries.filter(t => t.kind !== 'adjustment');
  for (const tx of entries) if (difference !== 0 && -affects(tx, accountId) === difference) candidates.push({ kind: 'extra', message: `${tx.note || '已记账目'}：若重复记入此笔，去除后的余额变化恰好等于差额；请对照原账单`, transactionIds: [tx.id], effectCents: difference });
  const grouped = new Map<string, Transaction[]>();
  for (const tx of entries) { const key = JSON.stringify([tx.date, tx.kind, affects(tx, accountId), tx.note, tx.sourceQuote]); const group = grouped.get(key) ?? []; group.push(tx); grouped.set(key, group); }
  for (const group of grouped.values()) if (group.length > 1) candidates.push({ kind: 'duplicate', message: `${group[0].note || '同类账目'}有${group.length}笔同日、同额、同描述记录；也可能是真实重复交易`, transactionIds: group.map(t => t.id), effectCents: -affects(group[0], accountId) });
  // Bounded pair search is a hint, never an instruction to alter the ledger.
  const bounded = entries.slice(-200); let pairs = 0;
  for (let i = 0; i < bounded.length && pairs < 8; i++) for (let j = i + 1; j < bounded.length && pairs < 8; j++) if (difference !== 0 && -affects(bounded[i], accountId) - affects(bounded[j], accountId) === difference) { candidates.push({ kind: 'pair', message: '这两笔若重复记入，合计可解释差额；仅作核查线索，不代表应删除', transactionIds: [bounded[i].id, bounded[j].id], effectCents: difference }); pairs++; }
  if (difference !== 0) for (const tx of [...state.transactions.values()].filter(t => t.date >= addDays(start, -1) && t.date <= addDays(end, 1) && t.kind !== 'adjustment')) {
    const effect = affects(tx, accountId);
    if ((tx.date < start || tx.date > end) && effect === difference) candidates.push({ kind: 'scope', message: `${tx.note || '账目'}记在${tx.date}，日期在本次核对区间之外，请核对是否日期错位`, transactionIds: [tx.id], effectCents: effect });
    else if (!effect && Math.abs(tx.amountCents) === Math.abs(difference) && tx.accountId && tx.date >= start && tx.date <= end && (tx.valuation?.currency ?? 'CNY') === accountCurrency(report.account)) candidates.push({ kind: 'scope', message: `${tx.note || '同额账目'}登记在其他账户，请核对实际收付款账户`, transactionIds: [tx.id], effectCents: null });
  }
  return candidates.sort((a, b) => Number(b.kind === 'pending' && b.effectCents === difference) - Number(a.kind === 'pending' && a.effectCents === difference)).slice(0, 40);
}
export interface StatementItem { row: DraftRow; effectCents: number }
export function compareStatement(state: LedgerState, config: Config, accountId: string, start: string, end: string, draft: Draft) {
  const summary = reconciliationSummary(state, config, accountId, start, end), remaining = [...summary.entries].filter(t => t.kind !== 'adjustment');
  const matched: { item: StatementItem; transaction: Transaction }[] = [], missing: StatementItem[] = [], changed: { item: StatementItem; transaction: Transaction }[] = [], unresolved: { row: DraftRow; issues: string[] }[] = [];
  const items: StatementItem[] = [];
  const normalize = (text: string) => text.replace(/[\s，。,:：;；]/g, '').toLowerCase();
  for (const row of draft.rows) {
    const effect = draftEffect(row, accountId, config), issues = rowIssues(row, config, state, draft).filter(issue => /金额|原文|日期|币种|账户|正负号|方向|类型/.test(issue));
    if (row.date < start || row.date > end) issues.push('不在本次核对日期范围');
    if (effect === null) issues.push('金额、方向或本次账户尚不明确');
    if (issues.length) { unresolved.push({ row, issues: [...new Set(issues)] }); continue; }
    items.push({ row, effectCents: effect! });
  }
  // Reserve exact matches across the whole statement before suggesting amount changes.
  for (const requireNote of [true, false]) for (let i = 0; i < items.length;) {
    const item = items[i], row = item.row;
    const index = remaining.findIndex(t => t.date === row.date && t.kind === row.kind && affects(t, accountId) === item.effectCents && (!requireNote || normalize(t.note) === normalize(row.note)));
    if (index >= 0) { matched.push({ item, transaction: remaining.splice(index, 1)[0] }); items.splice(i, 1); } else i++;
  }
  for (const item of items) {
    const row = item.row;
    const changes = remaining.filter(t => t.date === row.date && t.kind === row.kind && normalize(row.note) && normalize(t.note) === normalize(row.note));
    if (changes.length === 1) { const transaction = changes[0]; remaining.splice(remaining.indexOf(transaction), 1); changed.push({ item, transaction }); } else missing.push(item);
  }
  return { matched, missing, changed, extra: remaining, unresolved, exact: missing.length === 0 && changed.length === 0 && remaining.length === 0 && unresolved.length === 0, statementCount: draft.rows.length };
}
export function makeCheckpoint(state: LedgerState, config: Config, drafts: Draft[], accountId: string, start: string, date: string, actualCents: number, statement?: Draft): ReconciliationCheckpoint {
  requireThat(state.issues.length === 0, '请先处理账本或草稿读取错误，再确认对账');
  requireThat(Number.isSafeInteger(actualCents) && Math.abs(actualCents) <= 1_000_000_000_000, '实际余额需精确到分');
  const summary = reconciliationSummary(state, config, accountId, start, date);
  requireThat(summary.opening !== null && summary.closing !== null, '期初余额生效日前无法推算或确认余额');
  requireThat(summary.closing === actualCents, '余额尚有差额，请先核对；此操作不会自动补调整');
  requireThat(pendingRows(drafts, accountId, summary.account.openingDate, date, config).length === 0, '该账户或账户待补的草稿尚未处理，不能确认');
  if (statement) requireThat(statement.rows.length > 0 && statement.excluded.length === 0 && compareStatement(state, config, accountId, start, date, statement).exact, '对照账单仍有差异、排除项或缺少有效明细，不能确认');
  return { accountId, start, date, actualCents, fingerprint: reconciliationFingerprint(state, config, accountId, date), checkedAt: new Date().toISOString(), scope: statement ? 'statement' : 'balance' };
}
