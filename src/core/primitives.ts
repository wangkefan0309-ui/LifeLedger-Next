import { createHash, randomUUID } from 'node:crypto';
import type { Config, DraftRow } from './types';
export const id = (): string => randomUUID();
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function validDate(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date && date >= '1900-01-01' && date <= '2200-12-31';
}
export const dayNumber = (date: string) => {
  if (!validDate(date)) throw new Error(`无效日期 ${date}`);
  return Date.parse(`${date}T00:00:00Z`) / 86400000;
};
export const daysBetween = (start: string, end: string) => dayNumber(end) - dayNumber(start);
export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * 86400000).toISOString().slice(0, 10);
}
export function cents(text: string, signed = false): number {
  if (!new RegExp(signed ? '^-?\\d+(?:\\.\\d{1,2})?$' : '^\\d+(?:\\.\\d{1,2})?$').test(text.trim())) throw new Error('金额请填写数字，最多两位小数');
  const negative = text.trim().startsWith('-');
  const [whole, fraction = ''] = text.trim().replace('-', '').split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 1_000_000_000_000) throw new Error('金额超出支持范围');
  return negative ? -result : result;
}
export function money(value: number): string {
  return (value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export const decimal = (value: number) => (value / 100).toFixed(2);
export function exactRatio(amount: number, numerator: number, denominator: number): number {
  return Number(BigInt(amount) * BigInt(numerator) / BigInt(denominator));
}
export function defaultConfig(today = localDate()): Config {
  return {
    version: 1, accounts: [], categories: [
      { id: 'food', name: '餐饮', kind: 'expense', living: true },
      { id: 'transport', name: '交通', kind: 'expense', living: true },
      { id: 'housing', name: '居住', kind: 'expense', living: true },
      { id: 'device', name: '电子产品', kind: 'expense', living: true },
      { id: 'subscription', name: '订阅会员', kind: 'expense', living: true },
      { id: 'business', name: '经营成本', kind: 'expense', living: false },
      { id: 'salary', name: '工资', kind: 'income', living: false },
      { id: 'creation', name: '创作收入', kind: 'income', living: false },
      { id: 'interest', name: '利息分红', kind: 'income', living: false }
    ], defaultAccountId: null, observationStart: today, estimateDailyCents: null,
    reservedCents: 0, birthDate: null, displayEnd: `${Number(today.slice(0, 4)) + 50}${today.slice(4)}`,
    showPast: false, sound: false, animation: 'full'
  };
}
export function blankRow(today = localDate()): DraftRow {
  return { id: id(), kind: 'expense', date: today, dateRange: null, amount: '', accountId: '', fromAccountId: '', toAccountId: '', debtAccountId: '', categoryId: '', relatedId: '', incomeSource: 'active', note: '', sourceQuote: '', amountQuote: '', issues: [], reviewed: false, edited: false, usedDefault: false, cost: null };
}
/** Strict conversion only for unambiguous money quotes. Unsupported forms remain reviewable issues. */
export function quotedCents(quote: string): number | null {
  let q = quote.trim().replace(/人民币|美元|美金|港元|港币|USD|HKD|CNY|RMB|US\$|HK\$/gi, '').replace(/[元块钱整]/g, '').trim();
  if (/^(\d+(?:\.\d{1,2})?)$/.test(q)) return cents(q);
  if (/[几多来约上下左右]/.test(q)) return null;
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const integer = (s: string): number | null => {
    if (/^\d+$/.test(s)) return Number(s);
    if (!s || /[^零〇一二两三四五六七八九十百千万]/.test(s)) return null;
    if (!/[十百千万]/.test(s)) return Number([...s].map(x => digits[x]).join(''));
    let total = 0, section = 0, number = 0;
    for (const ch of s) {
      if (ch in digits) number = digits[ch];
      else if (ch === '万') { total += (section + number) * 10000; section = 0; number = 0; }
      else { section += (number || 1) * ({ 十: 10, 百: 100, 千: 1000 }[ch] ?? 1); number = 0; }
    }
    return total + section + number;
  };
  // “三块二” means 3.20; keep the unit position before stripping it.
  const colloquial = quote.match(/^(.+?)[块元]([零〇一二两三四五六七八九\d])(?:毛)?$/);
  if (colloquial) {
    const whole = integer(colloquial[1]); const fraction = integer(colloquial[2]);
    return whole === null || fraction === null ? null : whole * 100 + fraction * 10;
  }
  const split = q.split('点');
  if (split.length === 2 && /^[零〇一二两三四五六七八九\d]{1,2}$/.test(split[1])) {
    const whole = integer(split[0]); const fraction = [...split[1]].map(x => x in digits ? digits[x] : Number(x)).join('').padEnd(2, '0');
    return whole === null ? null : whole * 100 + Number(fraction);
  }
  const whole = integer(q);
  return whole === null ? null : whole * 100;
}
