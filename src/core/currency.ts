import type { Account, Config, Currency, ExchangeRates, Transaction, Valuation } from './types';
import { money, validDate } from './primitives';

export const RATE_SCALE = 100_000_000;
export const CURRENCIES: [Currency, string][] = [['CNY', '人民币 CNY'], ['USD', '美元 USD'], ['HKD', '港币 HKD']];
export const isCurrency = (value: unknown): value is Currency => ['CNY', 'USD', 'HKD'].includes(String(value));
export const accountCurrency = (account: Account): Currency => account.currency ?? 'CNY';
export const currencySymbol = (currency: Currency) => ({ CNY: '¥', USD: 'US$', HKD: 'HK$' }[currency]);
export const formatCurrency = (amount: number, currency: Currency) => `${currencySymbol(currency)}${money(amount)}`;
export function currenciesInText(text: string): Currency[] {
  return (['CNY', 'USD', 'HKD'] as Currency[]).filter(currency => ({ CNY: /人民币|\bCNY\b|\bRMB\b/i, USD: /美元|美金|\bUSD\b|US\$/i, HKD: /港币|港元|\bHKD\b|HK\$/i }[currency]).test(text));
}
export function parseRate(text: string): number {
  if (!/^\d+(?:\.\d{1,8})?$/.test(text.trim())) throw new Error('汇率请输入正数，最多八位小数');
  const [whole, fraction = ''] = text.trim().split('.');
  const rate = Number(whole) * RATE_SCALE + Number(fraction.padEnd(8, '0'));
  if (!Number.isSafeInteger(rate) || rate <= 0 || rate > 1_000_000_000_000) throw new Error('汇率无效或超出范围');
  return rate;
}
export const rateText = (rate: number) => (rate / RATE_SCALE).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
export function roundedRatio(amount: number, numerator: number, denominator: number): number {
  if (![amount, numerator, denominator].every(Number.isSafeInteger) || numerator <= 0 || denominator <= 0) throw new Error('换算金额或汇率无效');
  const value = BigInt(amount) * BigInt(numerator), divisor = BigInt(denominator), sign = value < 0n ? -1n : 1n;
  const result = Number(sign * ((value * sign + divisor / 2n) / divisor));
  if (!Number.isSafeInteger(result) || Math.abs(result) > 1_000_000_000_000) throw new Error('换算金额超出支持范围');
  return result;
}
export function rateFor(config: Config, currency: Currency): number {
  if (currency === 'CNY') return RATE_SCALE;
  const rate = config.exchangeRates?.[currency];
  if (!rate || !Number.isSafeInteger(rate) || rate <= 0) throw new Error(`${currency} 汇率未设置，请更新或手动填写汇率`);
  return rate;
}
export function convertMoney(amount: number, from: Currency, to: Currency, config: Config): number {
  return from === to ? amount : roundedRatio(amount, rateFor(config, from), rateFor(config, to));
}
export function valuationFor(config: Config, currency: Currency, override?: string, asOf?: string): Valuation | undefined {
  if (currency === 'CNY') return undefined;
  return { currency, rate: override ? parseRate(override) : rateFor(config, currency), asOf: asOf ?? config.exchangeRates!.asOf, source: override ? '用户核对汇率' : config.exchangeRates!.source };
}
export const transactionCurrency = (tx: Transaction): Currency => tx.valuation?.currency ?? 'CNY';
export const baseAmount = (tx: Transaction): number => tx.valuation ? roundedRatio(tx.amountCents, tx.valuation.rate, RATE_SCALE) : tx.amountCents;
export function validateValuation(value: Valuation): boolean {
  return !!value && isCurrency(value.currency) && Number.isSafeInteger(value.rate) && value.rate > 0 && value.rate <= 1_000_000_000_000 && validDate(value.asOf) && typeof value.source === 'string' && !!value.source.trim() && (value.currency !== 'CNY' || value.rate === RATE_SCALE);
}
export function validateRates(value: ExchangeRates): boolean {
  return !!value && validDate(value.asOf) && typeof value.fetchedAt === 'string' && Number.isFinite(Date.parse(value.fetchedAt)) && typeof value.source === 'string' && !!value.source.trim() && [value.USD, value.HKD].every(rate => Number.isSafeInteger(rate) && rate > 0 && rate <= 1_000_000_000_000);
}
