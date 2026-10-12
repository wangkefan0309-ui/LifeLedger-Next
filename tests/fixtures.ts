import { defaultConfig } from '../src/core/primitives';
import type { Config, DraftRow, Transaction } from '../src/core/types';
import type { FileIO } from '../src/storage/repository';
export const TODAY = '2026-10-12';
export function config(): Config {
  return { ...defaultConfig(TODAY), estimateDailyCents: 5000, accounts: [
    { id: 'activity', name: '活动钱包', kind: 'asset', openingCents: 300000, openingDate: TODAY, freedomBps: 10000, aliases: [] },
    { id: 'reserve', name: '备用钱包', kind: 'asset', openingCents: 500000, openingDate: TODAY, freedomBps: 10000, aliases: [] },
    { id: 'asset', name: '资产账户', kind: 'asset', openingCents: 2000000, openingDate: TODAY, freedomBps: 10000, aliases: [] },
    { id: 'debt', name: '借款', kind: 'liability', openingCents: 0, openingDate: TODAY, freedomBps: 0, aliases: [] }
  ], defaultAccountId: 'activity' };
}
let counter = 0;
export function tx(kind: Transaction['kind'], amountCents: number, patch: Partial<Transaction> = {}): Transaction {
  return { id: `t-${++counter}`, version: 1, batchId: 'batch-test', draftId: null, rowId: null, kind, date: TODAY, dateRange: null, amountCents, accountId: 'activity', fromAccountId: null, toAccountId: null, debtAccountId: null, categoryId: kind === 'income' ? 'creation' : ['expense', 'refund'].includes(kind) ? 'food' : null, relatedId: null, incomeSource: 'active', note: '', sourceQuote: '', originalText: '', corrections: [], ...patch };
}
export class MemoryIO implements FileIO {
  trashed = new Map<string, string>();
  async trash(path: string) { const text = this.files.get(path); if (text === undefined) throw new Error('不存在'); this.trashed.set(path, text); this.files.delete(path); }
  files = new Map<string, string>(); failPath = ''; partial = false;
  async list(prefix: string) { return [...this.files.keys()].filter(p => p.startsWith(prefix)); }
  async read(path: string) { return this.files.get(path) ?? null; }
  async create(path: string, text: string) {
    if (path.includes(this.failPath) && this.failPath) { if (this.partial) this.files.set(path, text.slice(0, 50)); throw new Error('模拟写入中断'); }
    if (this.files.has(path)) throw new Error('已存在'); this.files.set(path, text);
  }
  async process(path: string, update: (text: string) => string) { const old = this.files.get(path); if (old === undefined) throw new Error('文件不存在'); this.files.set(path, update(old)); }
}
export function apiEntry(patch: Record<string, unknown> = {}) {
  return { kind: 'expense', date: TODAY, date_range: null, currency: 'CNY', amount: '8.00', account_id: null, from_account_id: null, to_account_id: null, debt_account_id: null, category_id: 'food', related_id: null, income_source: 'active', note: '早餐', source_quote: '早餐八块', amount_quote: '八块', issues: [], cost: null, ...patch };
}
