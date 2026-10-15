import { blankRow, cents, quotedCents, validDate, localDate } from '../core/primitives';
import { requireThat } from '../core/ledger';
import type { Config, Draft, DraftRow, LedgerState } from '../core/types';
import { EXTRACTION_PROMPT, PROMPT_VERSION } from './prompt';
import { accountCurrency, currenciesInText, isCurrency } from '../core/currency';
import { accountMentions, routeNamedAccount } from '../core/account-routing';
import { imageQuotedCents, safeImageText } from '../core/image-evidence';
import { validateScreenshots, type ScreenshotImage, type ScreenshotOptions } from './screenshot-input';
import { SCREENSHOT_PROMPT, SCREENSHOT_PROMPT_VERSION } from './screenshot-prompt';
import { hasDateExpression } from '../core/drafts';
export interface ApiSettings { baseUrl: string; model: string; secretId: string }
export interface Transport { (url: string, body: object | null, apiKey: string): Promise<{ status: number; json: unknown }> }
function object(value: unknown): Record<string, unknown> { requireThat(value && typeof value === 'object' && !Array.isArray(value), 'API 回复中对象格式错误'); return value as Record<string, unknown>; }
function keys(o: Record<string, unknown>, required: string[]): void {
  requireThat(Object.keys(o).length === required.length && required.every(k => Object.hasOwn(o, k)), 'API 回复字段与冻结协议不符');
}
function nullableString(v: unknown): v is string | null { return v === null || typeof v === 'string'; }
function deepseekStructuredModel(model: string): boolean {
  return ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'].includes(model);
}
function completionOptions(settings: ApiSettings) {
  // Keep the user's thinking mode and leave room for both reasoning and JSON.
  return deepseekStructuredModel(settings.model)
    ? { max_tokens: 65536, thinking: { type: 'enabled' } }
    : { max_tokens: 8192 };
}
function completionUsage(response: Record<string, unknown>): string {
  const usage = response.usage && typeof response.usage === 'object' ? response.usage as Record<string, unknown> : undefined;
  const details = usage?.completion_tokens_details && typeof usage.completion_tokens_details === 'object' ? usage.completion_tokens_details as Record<string, unknown> : undefined;
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  return `${count(usage?.completion_tokens) ? `，输出 ${usage.completion_tokens} tokens` : ''}${count(details?.reasoning_tokens) ? `，其中思考 ${details.reasoning_tokens} tokens` : ''}`;
}
function completedContent(response: Record<string, unknown>, screenshots: boolean): string {
  const label = screenshots ? '图片识别' : 'API';
  const recovery = screenshots ? '临时截图、补充说明及现有草稿保留' : '原文和修正草稿保留';
  requireThat(Array.isArray(response.choices) && response.choices.length, `${label} 返回空回复；${recovery}`);
  const choice = object(response.choices[0]);
  const finish = typeof choice.finish_reason === 'string' && /^[a-z_]{1,48}$/i.test(choice.finish_reason) ? choice.finish_reason : '未提供或无法识别';
  if (choice.finish_reason === 'length') {
    throw new Error(`${label} 回复未完整结束：达到输出上限或上下文限制而被截断（length${completionUsage(response)}）；${recovery}。深度思考保持开启，请减少${screenshots ? '截图或分批识别' : '本次账目后重试'}`);
  }
  requireThat(choice.finish_reason !== 'content_filter', `${label} 回复被服务商内容规则拦截（content_filter）；${recovery}，请核对输入或联系服务商`);
  requireThat(choice.finish_reason !== 'tool_calls' && choice.finish_reason !== 'function_call', `${label} 返回了工具调用，未返回账单 JSON；请使用支持 JSON 输出的模型。${recovery}`);
  requireThat(choice.finish_reason !== 'insufficient_system_resource', `${label} 服务端资源不足，回复未完整结束（insufficient_system_resource）；${recovery}，请稍后重试`);
  requireThat(choice.finish_reason !== 'aborted', `${label} 生成被服务端中断（aborted${completionUsage(response)}）；${recovery}，请稍后重试`);
  requireThat(choice.finish_reason === 'stop', `${label} 回复未完整结束：接口结束标记缺失或不兼容（${finish}${completionUsage(response)}）；${recovery}，请核对兼容 Chat Completions 的接口`);
  const message = object(choice.message), content = message.content;
  requireThat(!((content === null || content === undefined || typeof content === 'string' && !content.trim()) && typeof message.reasoning_content === 'string' && message.reasoning_content.trim()), `${label} 只返回了思考内容，未返回账单 JSON（stop${completionUsage(response)}）；${recovery}，请重试`);
  requireThat(typeof content === 'string' && content.trim() && content.length <= 500_000, `${label} 返回空或过长内容；${recovery}，请重试或减少本次账目`);
  return content as string;
}
export function parseExtraction(value: unknown, draft: Draft, config: Config): Pick<Draft, 'rows' | 'excluded' | 'completeDates'> {
  const data = object(value); keys(data, ['version', 'entries', 'excluded', 'complete_dates']);
  requireThat((data.version === 2 || data.version === 3) && Array.isArray(data.entries) && data.entries.length <= 300 && Array.isArray(data.excluded) && Array.isArray(data.complete_dates), 'API 回复版本或列表格式错误');
  const rows: DraftRow[] = [];
  for (const entry of data.entries) {
    const e = object(entry);
    keys(e, ['kind', 'date', 'date_range', 'currency', 'amount', 'account_id', 'from_account_id', 'to_account_id', 'debt_account_id', 'category_id', 'related_id', 'income_source', 'note', 'source_quote', 'amount_quote', 'issues', 'cost', ...(data.version === 3 ? ['received_amount', 'received_amount_quote'] : [])]);
    requireThat(typeof e.kind === 'string' && ['income', 'expense', 'transfer', 'refund', 'borrow', 'repayment', 'lend', 'collect', 'unknown'].includes(e.kind), 'API 交易类型错误');
    requireThat(['date', 'amount', 'account_id', 'from_account_id', 'to_account_id', 'debt_account_id', 'category_id', 'related_id', 'amount_quote'].every(k => nullableString(e[k])), 'API 字段应为字符串或 null');
    requireThat(e.currency === null || isCurrency(e.currency), '币种仅支持人民币、美元和港币');
    if (data.version === 2) requireThat(e.currency === 'CNY' || e.currency === null, '旧协议只支持人民币，请使用新版多币种协议');
    requireThat(typeof e.note === 'string' && typeof e.source_quote === 'string' && Array.isArray(e.issues) && e.issues.every(x => typeof x === 'string') && ['active', 'passive', 'other'].includes(String(e.income_source)), 'API 原文或疑问格式错误');
    const defaultDate = draft.recordingDate ?? draft.submittedDate, row = blankRow(defaultDate);
    Object.assign(row, { kind: e.kind, date: e.date ?? '', amount: e.amount ?? '', accountId: e.account_id ?? '', fromAccountId: e.from_account_id ?? '', toAccountId: e.to_account_id ?? '', debtAccountId: e.debt_account_id ?? '', categoryId: e.category_id ?? '', relatedId: e.related_id ?? '', incomeSource: e.income_source, note: e.note, sourceQuote: e.source_quote, amountQuote: e.amount_quote ?? '', issues: [...e.issues] });
    if (e.date === null || (draft.recordingDate && draft.recordingDate !== draft.submittedDate && !hasDateExpression(draft.text) && e.date_range === null)) row.date = defaultDate;
    if (data.version === 3) { requireThat(nullableString(e.received_amount) && nullableString(e.received_amount_quote), '换汇到账金额须为字符串或 null'); row.receivedAmount = e.received_amount ?? ''; row.receivedAmountQuote = e.received_amount_quote ?? ''; }
    if (e.date_range !== null) {
      const r = object(e.date_range); keys(r, ['start', 'end']); requireThat(validDate(r.start) && validDate(r.end) && r.start <= r.end, 'API 日期区间错误');
      row.dateRange = { start: r.start, end: r.end }; row.date = r.end;
    }
    if (e.cost !== null) {
      const c = object(e.cost); keys(c, ['name', 'kind', 'start', 'end', 'residual', 'auto_renew']);
      requireThat(typeof c.name === 'string' && ['device', 'subscription'].includes(String(c.kind)) && nullableString(c.start) && nullableString(c.end) && typeof c.residual === 'string' && typeof c.auto_renew === 'boolean', 'API 成本建议格式错误');
      row.cost = { name: c.name, kind: c.kind as 'device' | 'subscription', start: (c.start as string) ?? '', end: (c.end as string) ?? '', residual: c.residual, autoRenew: c.auto_renew };
    }
    const evidence = data.entries.length === 1 ? draft.text : row.sourceQuote;
    const named = row.sourceQuote && draft.text.includes(row.sourceQuote) ? accountMentions(evidence, config.accounts) : [];
    const originalFrom = row.fromAccountId, originalTo = row.toAccountId;
    if (named.length) routeNamedAccount(row, config.accounts, evidence);
    if (row.kind === 'transfer' && ((originalFrom && originalFrom !== row.fromAccountId) || (originalTo && originalTo !== row.toAccountId))) row.issues.push('模型方向与明确的原文账户冲突，已按原文账户标注，请核对');
    const accountEvidenceMissing = !named.length && data.entries.length > 1 && accountMentions(draft.text, config.accounts).some(m => m.account.id !== config.defaultAccountId) && (!row.accountId || row.accountId === config.defaultAccountId);
    if (accountEvidenceMissing && ['income', 'expense', 'refund'].includes(row.kind)) { row.accountId = ''; row.issues.push('原文涉及其他账户，本行缺少账户证据，请补选后核对'); }
    if (!row.accountId && !named.length && !accountEvidenceMissing && ['income', 'expense', 'refund'].includes(row.kind) && config.defaultAccountId) { row.accountId = config.defaultAccountId; row.usedDefault = true; }
    const source = config.accounts.find(a => a.id === (['transfer', 'lend', 'collect'].includes(row.kind) ? row.fromAccountId : row.accountId));
    row.currency = isCurrency(e.currency) ? e.currency : source ? accountCurrency(source) : undefined;
    const explicitCurrencies = currenciesInText(row.amountQuote || row.sourceQuote);
    const sourceCurrencies = currenciesInText(row.sourceQuote);
    const explicit = explicitCurrencies.length === 1 ? explicitCurrencies : !['transfer', 'lend', 'collect'].includes(row.kind) && sourceCurrencies.length === 1 ? sourceCurrencies : [];
    if (explicit.length === 1) { if (row.currency && row.currency !== explicit[0]) row.issues.push('模型币种与明确原文冲突，已按原文标注，请核对账户'); row.currency = explicit[0]; }
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
  if (totalQuote && rows.length && rows.every(r => r.kind === 'expense' && r.amount && r.currency === rows[0].currency)) {
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
export function parseScreenshots(value: unknown, draft: Draft, config: Config, images: ScreenshotImage[], options: ScreenshotOptions): Pick<Draft, 'rows' | 'excluded' | 'completeDates' | 'imageEvidence'> {
  requireThat(validDate(options.date) && options.date <= localDate() && typeof options.onlySelectedDate === 'boolean' && typeof options.onlyExpenses === 'boolean', '请选择已发生的截图日期及识别范围');
  const data = object(value); keys(data, ['version', 'images']);
  requireThat(data.version === 1 && Array.isArray(data.images) && data.images.length === images.length && data.images.length > 0, '截图回复不完整或版本错误，请重新识别');
  requireThat(!/data:image\//i.test(JSON.stringify(data)), '截图回复只能包含识别文字，不能包含图片编码');
  const rows: DraftRow[] = [], excluded: Draft['excluded'] = [], imageEvidence: NonNullable<Draft['imageEvidence']> = [], indices = new Set<number>();
  for (const raw of data.images) {
    const image = object(raw); keys(image, ['image_index', 'text', 'entries', 'excluded']);
    requireThat(typeof image.image_index === 'number' && Number.isInteger(image.image_index) && image.image_index > 0 && image.image_index <= images.length && !indices.has(image.image_index) && safeImageText(image.text) && Array.isArray(image.entries) && Array.isArray(image.excluded), '截图序号、识别文字或列表错误');
    indices.add(image.image_index);
    const selected = images[image.image_index - 1];
    const assigned = config.accounts.find(account => account.id === selected.accountId && account.kind === 'asset');
    requireThat(!selected.accountId || assigned, '截图指定账户已不存在，请重新选择');
    const entries = image.entries.map(rawEntry => {
      const entry = object(rawEntry); requireThat(entry.cost === null && entry.date_range === null, '截图不能自动建立成本或用汇总代替逐笔');
      return { ...entry, date: entry.date === null ? options.date : entry.date };
    });
    const evidenceDraft = { ...draft, text: image.text, recordingDate: undefined, imageEvidence: undefined };
    const parsed = parseExtraction({ version: 3, entries, excluded: image.excluded, complete_dates: [] }, evidenceDraft, { ...config, defaultAccountId: null });
    imageEvidence.push({ id: selected.id, text: image.text });
    excluded.push(...parsed.excluded);
    for (const row of parsed.rows) {
      row.imageId = selected.id; row.usedDefault = false;
      if (assigned && ['income', 'expense', 'refund'].includes(row.kind)) {
        row.accountId = assigned.id;
        if (!row.currency) row.currency = accountCurrency(assigned);
      }
      if (!assigned && ['income', 'expense', 'refund'].includes(row.kind)) {
        const mentions = accountMentions(row.sourceQuote, config.accounts);
        if (!/(?:支付方式|付款方式|付款账户|收款方式|收款账户|从|用|由)/.test(row.sourceQuote) || !mentions.some(mention => mention.account.id === row.accountId)) row.accountId = '';
      }
      if (!row.sourceQuote || !image.text.includes(row.sourceQuote)) row.issues.push('截图文字引用不一致，请对照原图核对并修改');
      if (options.onlySelectedDate && row.date !== options.date) { excluded.push({ source_quote: row.sourceQuote, reason: `不在指定日期 ${options.date}` }); continue; }
      if (/(?:零钱余额|账户余额|可用余额|余额[：:\s]|总资产|总支出|支出合计|月度汇总|本月(?:支出|收入)|收入合计|合计[：:\s]|总计[：:\s]|待支付|交易关闭|支付失败|交易失败|已取消|退款中|待退款)/.test(row.sourceQuote)) { excluded.push({ source_quote: row.sourceQuote, reason: '余额、汇总或未完成交易，未作为流水' }); continue; }
      if (/(?:余额|零钱|账户)充值|充值到账/.test(row.sourceQuote) && ['income', 'expense'].includes(row.kind)) { row.kind = 'unknown'; row.categoryId = ''; row.issues.push('余额充值可能是本人账户间转账，请明确两端账户，不能直接算收入或消费'); }
      if (/退款成功|已退款|退款到账/.test(row.sourceQuote) && row.kind !== 'refund') { row.kind = 'unknown'; row.categoryId = ''; row.issues.push('图片包含已退款信息，请明确退款与原消费，不能直接当普通支出'); }
      if (options.onlyExpenses && row.kind !== 'expense') { excluded.push({ source_quote: row.sourceQuote, reason: '已限定只识别支出，请需要时切换全部收支' }); continue; }
      if ((/^[−－-]/.test(row.amountQuote.trim()) && ['income', 'refund'].includes(row.kind)) || (/^\+/.test(row.amountQuote.trim()) && row.kind === 'expense')) {
        row.kind = 'unknown'; row.issues.push('金额正负号与收支方向冲突，请手工明确类型');
      }
      if (row.amountQuote && imageQuotedCents(row.amountQuote) === null) row.issues.push('截图金额无法精确对应，请核对小数点和单位');
      if (!row.note.trim()) row.note = '截图账目（用途待补）';
      row.reviewed = false; row.edited = false; rows.push(row);
    }
  }
  requireThat(rows.length <= 300 && imageEvidence.reduce((length, image) => length + image.text.length, 0) <= 250_000, '本次截图识别内容过多，请减少图片');
  for (const row of rows) if (rows.some(other => other.id !== row.id && other.imageId !== row.imageId && other.sourceQuote === row.sourceQuote && other.amount === row.amount && other.date === row.date && other.accountId === row.accountId && other.kind === row.kind)) row.issues.push('不同截图包含相同账目，可能重叠，请核对并移除重复行');
  imageEvidence.sort((a, b) => images.findIndex(image => image.id === a.id) - images.findIndex(image => image.id === b.id));
  return { rows, excluded, completeDates: [], imageEvidence };
}
export class Extractor {
  constructor(private transport: Transport) {}
  private async request(settings: ApiSettings, key: string, route: string, body: object | null) {
    requireThat(key.trim(), '请先在插件设置中配置 API 密钥');
    const seconds = body && deepseekStructuredModel(settings.model) ? 300 : 60;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.transport(apiUrl(settings.baseUrl, route), body, key),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`请求超过 ${seconds} 秒仍未收到完整回复；原文和草稿保留，可减少本次账目后重试`)), seconds * 1000); })
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
    const context = { prompt_version: PROMPT_VERSION, today: draft.submittedDate, recording_date: draft.recordingDate ?? draft.submittedDate, timezone: draft.timezone, reporting_currency: 'CNY', accounts: c.accounts.map(a => ({ id: a.id, name: a.name, aliases: a.aliases, kind: a.kind, currency: accountCurrency(a) })), categories: c.categories, related_expenses: [...state.transactions.values()].filter(t => t.kind === 'expense' && draft.text.includes('退')).slice(-10).map(t => ({ id: t.id, date: t.date, amount: (t.amountCents / 100).toFixed(2), currency: t.valuation?.currency ?? 'CNY', note: t.note })) };
    const response = await this.request(settings, key, 'chat/completions', { model: settings.model, response_format: { type: 'json_object' }, ...completionOptions(settings), messages: [{ role: 'system', content: EXTRACTION_PROMPT }, { role: 'user', content: JSON.stringify({ context, original_text: draft.text }) }] });
    const content = completedContent(response, false);
    let parsed: unknown; try { parsed = JSON.parse(content); } catch { throw new Error('API 返回的 JSON 无法解析；原文和修正保留'); }
    const output = parseExtraction(parsed, draft, c);
    const usage = response.usage ? object(response.usage) : undefined;
    return { ...output, usage: { input: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0, output: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0 } };
  }
  async extractScreenshots(settings: ApiSettings, key: string, draft: Draft, c: Config, state: LedgerState, images: ScreenshotImage[], options: ScreenshotOptions) {
    validateScreenshots(images);
    requireThat(validDate(options.date) && options.date <= localDate(), '请选择已发生的截图日期');
    requireThat(images.every(image => !image.accountId || c.accounts.some(account => account.id === image.accountId && account.kind === 'asset')), '请重新选择截图所属账户');
    const context = { prompt_version: SCREENSHOT_PROMPT_VERSION, today: draft.submittedDate, timezone: draft.timezone, reporting_currency: 'CNY', accounts: c.accounts.map(a => ({ id: a.id, name: a.name, aliases: a.aliases, kind: a.kind, currency: accountCurrency(a) })), categories: c.categories, related_expenses: draft.text.includes('退') ? [...state.transactions.values()].filter(t => t.kind === 'expense').slice(-10).map(t => ({ id: t.id, date: t.date, amount: (t.amountCents / 100).toFixed(2), currency: t.valuation?.currency ?? 'CNY', note: t.note })) : [] };
    const content: object[] = [{ type: 'text', text: JSON.stringify({ context, guidance: draft.text, date: options.date, only_selected_date: options.onlySelectedDate, only_expenses: options.onlyExpenses, screenshots: images.map((image, index) => ({ image_index: index + 1, assigned_account_id: image.accountId || null })) }) }];
    images.forEach((image, index) => content.push({ type: 'text', text: `截图 ${index + 1}` }, { type: 'image_url', image_url: { url: image.dataUrl, detail: 'high' } }));
    let response: Record<string, unknown>;
    try { response = await this.request(settings, key, 'chat/completions', { model: settings.model, response_format: { type: 'json_object' }, ...completionOptions(settings), messages: [{ role: 'system', content: SCREENSHOT_PROMPT }, { role: 'user', content }] }); }
    catch (error) { if (/HTTP (400|415|422)/.test((error as Error).message)) throw new Error('图片请求被接口拒绝，请确认当前模型支持图片输入和 JSON 输出。临时截图与补充说明保留，可以修改配置后重试'); throw error; }
    const resultText = completedContent(response, true);
    let parsed: unknown; try { parsed = JSON.parse(resultText); } catch { throw new Error('图片识别未返回有效 JSON，补充说明及现有草稿保留'); }
    const output = parseScreenshots(parsed, draft, c, images, options);
    const usage = response.usage ? object(response.usage) : undefined;
    return { ...output, usage: { input: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0, output: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0 } };
  }
}
