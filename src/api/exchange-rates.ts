import { parseRate, RATE_SCALE, roundedRatio } from '../core/currency';
import { validDate } from '../core/primitives';
import type { ExchangeRates } from '../core/types';

export const RATES_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rates?base=CNY&quotes=USD,HKD';
export function parseReferenceRates(json: unknown, now = new Date()): ExchangeRates {
  if (!Array.isArray(json) || json.length !== 2) throw new Error('参考汇率回复不完整，原汇率保留');
  const rows = json as { date: string; base: string; quote: string; rate: number }[];
  const get = (currency: 'USD' | 'HKD') => {
    const matches = rows.filter(row => row.base?.toUpperCase() === 'CNY' && row.quote?.toUpperCase() === currency);
    if (matches.length !== 1 || !validDate(matches[0].date) || typeof matches[0].rate !== 'number' || !Number.isFinite(matches[0].rate)) throw new Error('参考汇率币种、日期或数值错误，原汇率保留');
    const precision = matches[0].rate.toFixed(8);
    return { asOf: matches[0].date, rate: roundedRatio(RATE_SCALE, RATE_SCALE, parseRate(precision)) };
  };
  const usd = get('USD'), hkd = get('HKD');
  if (usd.asOf !== hkd.asOf || usd.asOf > now.toISOString().slice(0, 10)) throw new Error('参考汇率日期不一致或在未来，原汇率保留');
  return { asOf: usd.asOf, fetchedAt: now.toISOString(), source: 'Frankfurter / ECB', USD: usd.rate, HKD: hkd.rate };
}
