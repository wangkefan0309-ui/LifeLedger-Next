import { quotedCents } from './primitives';

/** Screenshot quotes keep their sign/symbol; ledger amounts remain positive cents. */
export function imageQuotedCents(quote: string): number | null {
  if (!quote || quote.length > 64) return null;
  const value = quote.trim().replace(/[−－]/g, '-').replace(/人民币|美元|美金|港元|港币|USD|HKD|CNY|RMB|US\$|HK\$|[¥￥$]/gi, '').trim().replace(/^[+-]\s*/, '').replace(/[元块钱整]/g, '').trim();
  if (value.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(value)) return null;
  try { return quotedCents(value.replace(/,/g, '')); } catch { return null; }
}
export const safeImageText = (value: unknown): value is string => typeof value === 'string' && value.length <= 120_000 && !/data:image\//i.test(value);
export function draftOriginalText(draft: { text: string; imageEvidence?: { id: string; text: string }[] }): string {
  return [draft.text, ...(draft.imageEvidence ?? []).map((image, index) => `截图 ${index + 1} 识别文字（图片未保存）：\n${image.text}`)].filter(Boolean).join('\n\n');
}
