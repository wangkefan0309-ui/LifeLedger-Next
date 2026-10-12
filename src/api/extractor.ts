import { blankRow, cents, quotedCents, validDate } from '../core/primitives';
import { requireThat } from '../core/ledger';
import type { Config, Draft, DraftRow, LedgerState } from '../core/types';
import { EXTRACTION_PROMPT, PROMPT_VERSION } from './prompt';
export interface ApiSettings { baseUrl: string; model: string; secretId: string }
export interface Transport { (url: string, body: object | null, apiKey: string): Promise<{ status: number; json: unknown }> }
function object(value: unknown): Record<string, unknown> { requireThat(value && typeof value === 'object' && !Array.isArray(value), 'API 回复中对象格式错误'); return value as Record<string, unknown>; }
function keys(o: Record<string, unknown>, required: string[]): void {
  requireThat(Object.keys(o).length === required.length && required.every(k => Object.hasOwn(o, k)), 'API 回复字段与冻结协议不符');
}
function nullableString(v: unknown): v is string | null { return v === null || typeof v === 'string'; }
export function parseExtraction(value: unknown, draft: Draft, config: Config): Pick<Draft, 'rows' | 'excluded' | 'completeDates'> {
  const data = object(value); keys(data, ['version', 'entries', 'excluded', 'complete_dates']);
  requireThat(data.version === 2 && Array.isArray(data.entries) && data.entries.length <= 300 && Array.isArray(data.excluded) && Array.isArray(data.complete_dates), 'API 回复版本或列表格式错误');
  const rows: DraftRow[] = [];
  for (const entry of data.entries) {
    const e = object(entry);
    keys(e, ['kind', 'date', 'date_range', 'currency', 'amount', 'account_id', 'from_account_id', 'to_account_id', 'debt_account_id', 'category_id', 'related_id', 'income_source', 'note', 'source_quote', 'amount_quote', 'issues', 'cost']);
    requireThat(typeof e.kind === 'string' && ['income', 'expense', 'transfer', 'refund', 'borrow', 'repayment', 'lend', 'collect', 'unknown'].includes(e.kind), 'API 交易类型错误');
    requireThat(['date', 'amount', 'account_id', 'from_account_id', 'to_account_id', 'debt_account_id', 'category_id', 'related_id', 'amount_quote'].every(k => nullableString(e[k])), 'API 字段应为字符串或 null');
    requireThat(e.currency === 'CNY' || e.currency === null, '首版只支持人民币，请手动核对跨币种交易');
    requireThat(typeof e.note === 'string' && typeof e.source_quote === 'string' && Array.isArray(e.issues) && e.issues.every(x => typeof x === 'string') && ['active', 'passive', 'other'].includes(String(e.income_source)), 'API 原文或疑问格式错误');
    const row = blankRow(draft.submittedDate);
    Object.assign(row, { kind: e.kind, date: e.date ?? '', amount: e.amount ?? '', accountId: e.account_id ?? '', fromAccountId: e.from_account_id ?? '', toAccountId: e.to_account_id ?? '', debtAccountId: e.debt_account_id ?? '', categoryId: e.category_id ?? '', relatedId: e.related_id ?? '', incomeSource: e.income_source, note: e.note, sourceQuote: e.source_quote, amountQuote: e.amount_quote ?? '', issues: [...e.issues] });
    if (e.date_range !== null) {
      const r = object(e.date_range); keys(r, ['start', 'end']); requireThat(validDate(r.start) && validDate(r.end) && r.start <= r.end, 'API 日期区间错误');
      row.dateRange = { start: r.start, end: r.end }; row.date = r.end;
    }
    if (e.cost !== null) {
      const c = object(e.cost); keys(c, ['name', 'kind', 'start', 'end', 'residual', 'auto_renew']);
      requireThat(typeof c.name === 'string' && ['device', 'subscription'].includes(String(c.kind)) && nullableString(c.start) && nullableString(c.end) && typeof c.residual === 'string' && typeof c.auto_renew === 'boolean', 'API 成本建议格式错误');
      row.cost = { name: c.name, kind: c.kind as 'device' | 'subscription', start: (c.start as string) ?? '', end: (c.end as string) ?? '', residual: c.residual, autoRenew: c.auto_renew };
    }
    if (!row.accountId && ['income', 'expense', 'refund'].includes(row.kind) && config.defaultAccountId) { row.accountId = config.defaultAccountId; row.usedDefault = true; }
    for (const aid of [row.accountId, row.fromAccountId, row.toAccountId, row.debtAccountId]) if (aid && !config.accounts.some(a => a.id === aid)) row.issues.push(`模型引用了未知账户 ${aid}，请选择真实账户`);
    if (row.kind === 'transfer') {
      const names = config.accounts.flatMap(a => [a.name, ...a.aliases].map(name => ({ name, id: a.id })));
      const from = names.find(a => row.sourceQuote.includes(`从${a.name}`) || row.sourceQuote.includes(`把${a.name}里的`));
      const to = names.find(a => row.sourceQuote.includes(`到${a.name}`) || row.sourceQuote.includes(`转入${a.name}`));
      if ((from && from.id !== row.fromAccountId) || (to && to.id !== row.toAccountId)) row.issues.push('模型方向与明确的原文账户冲突，请修改方向后核对');
    }
    rows.push(row);
  }
  // A stated grand total is a check, never an extra transaction.
  const totalQuote = draft.text.match(/(?:总共|合计|一共)\s*([零〇一二两三四五六七八九十百千万\d.]+(?:块[零〇一二两三四五六七八九\d])?)/)?.[1];
  if (totalQuote && rows.length && rows.every(r => r.kind === 'expense' && r.amount)) {
    try { const stated = quotedCents(totalQuote); const sum = rows.reduce((s, r) => s + cents(r.amount), 0); if (stated !== null && stated !== sum) rows.forEach(r => r.issues.push(`原文合计与分项不一致，请核对总额 ${stated / 100} 和分项 ${sum / 100}`)); } catch { /* per-row monetary validation handles this */ }
  }
  const excluded = data.excluded.map(value => {
    const e = object(value); keys(e, ['source_quote', 'reason']);
    requireThat(typeof e.source_quote === 'string' && draft.text.includes(e.source_quote) && typeof e.reason === 'string', '排除项原文证据错误');
    return { source_quote: e.source_quote, reason: e.reason };
  });
  requireThat(data.complete_dates.every(d => validDate(d) && d <= draft.submittedDate), 'API 完整度建议包含无效或未来日期');
  const completeDates = /就这些|记完|全部记|没有其他收支|没收支/.test(draft.text) ? data.complete_dates as string[] : [];
  return { rows, excluded, completeDates };
}
export function apiUrl(baseUrl: string, route: string): string {
  const url = new URL(baseUrl);
  requireThat(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'API 地址需用 HTTPS，本机接口可用 HTTP');
  requireThat(!url.username && !url.password && !url.search && !url.hash, 'API 地址不能含账号、参数或片段');
  return `${baseUrl.replace(/\/$/, '')}/${route}`;
}
export class Extractor {
  constructor(private transport: Transport) {}
  private async request(settings: ApiSettings, key: string, route: string, body: object | null) {
    requireThat(key.trim(), '请先在插件设置中配置 API 密钥');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.transport(apiUrl(settings.baseUrl, route), body, key),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('请求超过 60 秒；草稿保留，可重试')), 60000); })
      ]);
      requireThat(result.status >= 200 && result.status < 300, `API 返回 HTTP ${result.status}；请核对地址、密钥与额度`);
      return object(result.json);
    } finally { if (timer) clearTimeout(timer); }
  }
  async checkConnection(settings: ApiSettings, key: string): Promise<string> {
    const response = await this.request(settings, key, 'models', null);
    requireThat(Array.isArray(response.data), '模型列表回复格式错误');
    const found = response.data.some(v => object(v).id === settings.model);
    return found ? `连接正常，已找到 ${settings.model}` : `连接正常；模型列表未找到 ${settings.model}，请核对模型 ID`;
  }
  async extract(settings: ApiSettings, key: string, draft: Draft, c: Config, state: LedgerState) {
    const context = { prompt_version: PROMPT_VERSION, today: draft.submittedDate, timezone: draft.timezone, currency: 'CNY', accounts: c.accounts.map(a => ({ id: a.id, name: a.name, aliases: a.aliases, kind: a.kind })), categories: c.categories, related_expenses: [...state.transactions.values()].filter(t => t.kind === 'expense' && draft.text.includes('退')).slice(-10).map(t => ({ id: t.id, date: t.date, amount: (t.amountCents / 100).toFixed(2), note: t.note })) };
    const response = await this.request(settings, key, 'chat/completions', { model: settings.model, response_format: { type: 'json_object' }, max_tokens: 8192, messages: [{ role: 'system', content: EXTRACTION_PROMPT }, { role: 'user', content: JSON.stringify({ context, original_text: draft.text }) }] });
    requireThat(Array.isArray(response.choices) && response.choices.length, 'API 返回空回复；草稿保留');
    const choice = object(response.choices[0]); requireThat(choice.finish_reason === 'stop', 'API 回复未完整结束；草稿保留');
    const content = object(choice.message).content; requireThat(typeof content === 'string' && content.trim() && content.length <= 500000, 'API 返回空或过长内容；草稿保留');
    let parsed: unknown; try { parsed = JSON.parse(content); } catch { throw new Error('API 返回的 JSON 无法解析；原文和修正保留'); }
    const output = parseExtraction(parsed, draft, c);
    const usage = response.usage ? object(response.usage) : undefined;
    return { ...output, usage: { input: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0, output: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0 } };
  }
}
