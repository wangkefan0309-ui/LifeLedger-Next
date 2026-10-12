export type DateISO = string;
export type Kind = 'income' | 'expense' | 'transfer' | 'refund' | 'borrow' | 'repayment' | 'lend' | 'collect' | 'adjustment';
export interface Account {
  id: string; name: string; kind: 'asset' | 'liability'; openingCents: number;
  openingDate: DateISO; freedomBps: number; aliases: string[];
}
export interface Category { id: string; name: string; kind: 'income' | 'expense'; living: boolean }
export interface Config {
  version: 1; accounts: Account[]; categories: Category[]; defaultAccountId: string | null;
  observationStart: DateISO; estimateDailyCents: number | null; reservedCents: number;
  birthDate: DateISO | null; displayEnd: DateISO; showPast: boolean;
  sound: boolean; animation: 'full' | 'short' | 'off';
}
export interface Transaction {
  id: string; version: number; batchId: string; draftId: string | null; rowId: string | null;
  kind: Kind; date: DateISO; dateRange: { start: DateISO; end: DateISO } | null;
  amountCents: number; accountId: string | null; fromAccountId: string | null;
  toAccountId: string | null; debtAccountId: string | null; categoryId: string | null;
  relatedId: string | null; incomeSource: 'active' | 'passive' | 'other';
  note: string; sourceQuote: string; originalText: string; corrections: string[];
}
export interface Cost {
  id: string; version: number; batchId: string; transactionId: string | null;
  name: string; kind: 'device' | 'subscription'; amountCents: number; residualCents: number;
  start: DateISO; end: DateISO | null; stoppedOn: DateISO | null; autoRenew: boolean;
  adjustmentNotes: string[];
}
export type LedgerEvent =
  | { type: 'transaction.put'; expected: number; value: Transaction }
  | { type: 'transaction.delete'; id: string; expected: number }
  | { type: 'cost.put'; expected: number; value: Cost }
  | { type: 'cost.delete'; id: string; expected: number }
  | { type: 'day.set'; date: DateISO; complete: boolean; expected: number };
export interface Batch {
  version: 1; id: string; createdAt: string; requestId: string; reason: string;
  parentId: string | null; events: LedgerEvent[]; checksum: string;
}
export interface LedgerState {
  transactions: Map<string, Transaction>; costs: Map<string, Cost>;
  txVersions: Map<string, number>; costVersions: Map<string, number>;
  days: Map<DateISO, { complete: boolean; version: number }>;
  batches: Batch[]; issues: { path: string; message: string; kind?: 'draft' }[];
}
export interface DraftRow {
  id: string; kind: Kind | 'unknown'; date: string; dateRange: Transaction['dateRange']; amount: string;
  accountId: string; fromAccountId: string; toAccountId: string; debtAccountId: string;
  categoryId: string; relatedId: string; incomeSource: Transaction['incomeSource']; note: string;
  sourceQuote: string; amountQuote: string; issues: string[]; reviewed: boolean; edited: boolean;
  usedDefault: boolean; cost: { name: string; kind: Cost['kind']; start: string; end: string; residual: string; autoRenew: boolean } | null;
}
export interface Draft {
  origin?: 'home' | 'editor';
  version: 1; id: string; revision: number; text: string; textHistory: string[]; submittedDate: string; timezone: string;
  rows: DraftRow[]; excluded: { source_quote: string; reason: string }[];
  completeDates: string[]; status: 'editing' | 'requesting' | 'failed' | 'review' | 'saved';
  error: string; requestId: string; usage: { input: number; output: number } | null;
}
export function emptyState(): LedgerState {
  return { transactions: new Map(), costs: new Map(), txVersions: new Map(), costVersions: new Map(), days: new Map(), batches: [], issues: [] };
}
