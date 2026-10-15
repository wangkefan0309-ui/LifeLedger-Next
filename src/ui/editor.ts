import type { Repository } from '../storage/repository';
import type { Config, Draft, DraftRow, Transaction } from '../core/types';
import { blankRow, cents, decimal, id, localDate, money, validDate } from '../core/primitives';
import { draftEvents, newDraft, rowIssues } from '../core/drafts';
import { freedom } from '../core/calculations';
import type { ApiSettings, Extractor } from '../api/extractor';
import { button, captureViewPosition, check, dialog, el, input, select } from './dom';
import { accountCurrency, CURRENCIES, formatCurrency, parseRate, RATE_SCALE, rateFor, rateText, roundedRatio, transactionCurrency } from '../core/currency';
import { requireThat } from '../core/ledger';
import { inlineScreenshot, validateScreenshots, MAX_IMAGES, MAX_TOTAL_IMAGE_BYTES, type ScreenshotImage, type ScreenshotOptions } from '../api/screenshot-input';

export const KIND_NAMES: Record<string, string> = { income: '收入', expense: '支出', transfer: '内部转账', refund: '退款', borrow: '借入本金', repayment: '归还本金', lend: '借出本金', collect: '收回本金', adjustment: '对账调整', unknown: '用途待补' };
export interface EditorHost {
  repo: Repository; extractor: Extractor; api: ApiSettings; key: () => string;
  notice: (message: string) => void; changed: (before: ReturnType<typeof freedom>, batchId: string) => void;
  draftChanged?: () => void;
}
export interface EditorOptions { date?: string; accountId?: string; onStatement?: (draft: Draft) => void | Promise<void> }
export class DraftEditor {
  private draft: Draft; private content: HTMLElement; private node: HTMLDialogElement;
  private timeout?: ReturnType<typeof setTimeout>; private writing: Promise<void> = Promise.resolve();
  private closed = false; private extracting = false; private saving = false;
  private images: ScreenshotImage[] = []; private readingImages = false;
  private imageOptions: ScreenshotOptions = { date: localDate(), onlySelectedDate: true, onlyExpenses: true };
  private closeDialog: () => void;
  constructor(parent: HTMLElement, private host: EditorHost, existing?: Draft, initialText = '', screenshots = false, private options: EditorOptions = {}) {
    this.draft = existing ? structuredClone(existing) : newDraft(initialText, localDate(), options.date ?? localDate());
    this.imageOptions.date = this.draft.recordingDate ?? this.draft.submittedDate;
    if (options.onStatement) { this.imageOptions.onlyExpenses = false; this.imageOptions.onlySelectedDate = false; }
    if (screenshots) this.draft.inputMode = 'screenshots';
    this.draft.origin = 'editor';
    this.draft.textHistory ??= [];
    if (this.draft.status === 'requesting') { this.draft.status = 'failed'; this.draft.error = '上次整理被中断，原文和草稿保留'; }
    const d = dialog(parent, options.onStatement ? '整理对照账单（不直接入账）' : this.draft.inputMode === 'screenshots' ? '截图记账' : '记一段生活', () => { this.closed = true; this.clearImages(); if (this.timeout) clearTimeout(this.timeout); if (this.draft.status !== 'saved') void this.flush().catch(e => host.notice(`草稿保存失败：${(e as Error).message}`)); });
    this.node = d.node; this.closeDialog = d.close; this.content = el('div', 'll-editor', '', this.node); this.render();
    this.node.addEventListener('paste', event => {
      const files = Array.from(event.clipboardData?.items ?? []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file);
      if (files.length) { event.preventDefault(); event.stopPropagation(); void this.addImages(files); }
    });
    this.node.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault(); });
    this.node.addEventListener('drop', event => { if (event.dataTransfer?.files.length) { event.preventDefault(); event.stopPropagation(); void this.addImages(Array.from(event.dataTransfer.files)); } });
    this.content.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }
  private autosave() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => { this.timeout = undefined; void this.flush().catch(e => this.host.notice((e as Error).message)); }, 350);
  }
  private flush(): Promise<void> {
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = undefined; }
    if (this.options.onStatement) return Promise.resolve();
    this.writing = this.writing.catch(() => undefined).then(async () => {
      if (!this.draft.revision && !this.draft.text.trim() && !this.draft.rows.length && !this.draft.completeDates.length) return;
      await this.host.repo.saveDraft(this.draft); this.host.draftChanged?.();
    }); return this.writing;
  }
  private edited(row: DraftRow) { row.edited = true; row.reviewed = false; this.autosave(); }
  private clearImages() { for (const image of this.images) image.dataUrl = ''; this.images = []; }
  private async addImages(files: File[]) {
    if (this.closed || this.extracting || this.readingImages) return;
    this.readingImages = true; this.draft.error = ''; this.draft.inputMode = 'screenshots'; this.node.querySelector('h2')!.textContent = this.options.onStatement ? '整理对照账单（不直接入账）' : '截图记账'; this.render();
    const candidates: ScreenshotImage[] = [];
    try {
      requireThat(this.images.length + files.length <= MAX_IMAGES, '一次最多选择 5 张截图');
      requireThat(this.images.reduce((total, image) => total + image.bytes, 0) + files.reduce((total, file) => total + file.size, 0) <= MAX_TOTAL_IMAGE_BYTES, '截图总大小请控制在 20 MB 以内');
      for (const file of files) {
        const image = inlineScreenshot(id(), new Uint8Array(await file.arrayBuffer()), this.options.accountId ?? '');
        const probe = this.node.ownerDocument.createElement('img'); probe.src = image.dataUrl;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([probe.decode(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('图片读取超时，请重新选择')), 5000); })]);
          requireThat(probe.naturalWidth > 0 && probe.naturalHeight > 0 && Math.max(probe.naturalWidth, probe.naturalHeight) <= 8192 && probe.naturalWidth * probe.naturalHeight <= 24_000_000, '截图尺寸过大，请截取账单区域后再选择');
        } finally { if (timer) clearTimeout(timer); probe.removeAttribute('src'); }
        candidates.push(image);
      }
      if (this.closed) return;
      validateScreenshots([...this.images, ...candidates]); this.images.push(...candidates); this.draft.status = 'editing';
    } catch (error) { this.draft.error = (error as Error).message; candidates.forEach(image => { image.dataUrl = ''; }); }
    finally { this.readingImages = false; if (this.closed) candidates.forEach(image => { image.dataUrl = ''; }); else this.render(); }
  }
  private renderImages(parent: HTMLElement) {
    const panel = el('details', 'll-image-input', '', parent); panel.setAttribute('aria-label', '临时截图'); panel.open = !!this.images.length || this.readingImages || !this.draft.imageEvidence?.length;
    el('summary', '', this.images.length ? `临时截图（${this.images.length}）` : this.draft.imageEvidence?.length ? '图片已移除 · 点击重新选图' : '选择截图与识别范围', panel);
    const toolbar = el('div', 'll-toolbar', '', panel);
    const picker = el('input', '', '', panel); picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/webp'; picker.multiple = true; picker.hidden = true; picker.setAttribute('aria-label', '选择记账截图');
    picker.addEventListener('change', () => { const files = Array.from(picker.files ?? []); picker.value = ''; if (files.length) void this.addImages(files); });
    const choose = button(toolbar, this.readingImages ? '读取截图…' : '选择截图', () => picker.click(), 'll-ghost'); choose.disabled = this.readingImages || this.extracting;
    el('span', 'll-muted', '也可 Ctrl+V 粘贴或拖入图片', toolbar);
    el('p', 'll-muted', '图片临时发送给当前配置的 API；识别成功或关闭窗口后移除，不写入 Vault 或备份。原图片文件保留。支持 PNG / JPEG / WebP，每张 8 MB，最多 5 张。', panel);
    const fields = el('div', 'll-form-grid', '', panel);
    const date = input(fields, '截图日期（缺日期时使用）', this.imageOptions.date, 'date', value => { this.imageOptions.date = value; }); date.disabled = this.extracting;
    const day = check(panel, '只识别指定日期', this.imageOptions.onlySelectedDate, value => { this.imageOptions.onlySelectedDate = value; }); day.disabled = this.extracting;
    const scope = check(panel, '只识别支出', this.imageOptions.onlyExpenses, value => { this.imageOptions.onlyExpenses = value; }); scope.disabled = this.extracting || !!this.options.onStatement;
    if (this.options.onStatement) el('small', 'll-muted', '对照余额需要全部收支，已保留收入、退款和转账；具体核对范围由对账窗口筛选。', panel);
    this.images.forEach((image, index) => {
      const card = el('div', 'll-image-card', '', panel), preview = el('img', 'll-image-preview', '', card); preview.src = image.dataUrl; preview.alt = `临时截图 ${index + 1}`;
      const info = el('div', 'll-image-info', '', card); el('strong', '', `图片 ${index + 1}`, info);
      const account = select(info, `图片 ${index + 1} 所属账户`, image.accountId, [['', '不确定，识别后补选'], ...this.host.repo.config.accounts.filter(account => account.kind === 'asset').map(account => [account.id, account.name] as [string, string])], value => { image.accountId = value; }); account.disabled = this.extracting;
      const remove = button(info, `移除图片 ${index + 1}`, () => { image.dataUrl = ''; this.images = this.images.filter(item => item.id !== image.id); this.render(); }, 'll-ghost'); remove.disabled = this.extracting;
    });
    if (!this.images.length) el('p', 'll-muted', this.draft.imageEvidence?.length ? '临时图片已移除，识别文字和草稿保留。继续修改即可；再次识别请重新选图。' : '截图尚未选择，选择图片后点击识别。', panel);
    el('p', 'll-muted', `当前模型：${this.host.api.model}。需要支持图片输入及 JSON 输出；接口不支持时可改为手动录入。`, panel);
  }
  private render() {
    const restorePosition = captureViewPosition(this.node);
    const focused = this.content.contains(this.content.ownerDocument.activeElement) ? this.content.ownerDocument.activeElement as HTMLInputElement : null;
    const focusLabel = focused?.getAttribute('aria-label'), focusRow = focused?.closest<HTMLElement>('.ll-draft-row')?.dataset.rowId;
    this.content.replaceChildren();
    const screenshots = this.draft.inputMode === 'screenshots';
    const date = input(this.content, '本次记账日期', this.draft.recordingDate ?? this.draft.submittedDate, 'date', value => {
      if (!validDate(value) || value > localDate()) { this.draft.error = '请选择已发生的有效日期'; this.render(); return; }
      this.draft.recordingDate = value; this.imageOptions.date = value; this.draft.completeDates = []; this.draft.error = ''; this.autosave(); this.render();
    }); date.max = localDate(); date.disabled = this.extracting;
    el('small', 'll-muted', '新行和未注明日期的文字沿用本次日期；原文明说的日期保留。', this.content);
    el('p', 'll-muted', screenshots ? '先选择截图，可补充用途或限定范围。识别只生成草稿，修改并核对后再保存。' : '在这里用 Typeless 口播、打字或粘贴。整理后统一核对，再保存。', this.content);
    if (screenshots) this.renderImages(this.content);
    const text = el('textarea', 'll-text-input', '', this.content); text.placeholder = screenshots ? '可留空。例如：这笔20元是打车；只记录实际支付，忽略充值。用途也能在识别后逐笔补充。' : '今天早饭八块，午饭二十五，晚饭三十二，地铁六块，公众号到账三百。今天就这些。'; text.value = this.draft.text; text.setAttribute('aria-label', screenshots ? '截图补充说明（可选）' : '原文');
    const previousText = this.draft.text;
    text.addEventListener('change', () => { if (previousText.trim() && previousText !== text.value) this.draft.textHistory.push(previousText); this.autosave(); });
    text.addEventListener('input', () => { this.draft.text = text.value; this.draft.status = 'editing'; this.draft.rows.forEach(r => { r.reviewed = false; if (!r.issues.includes('原文有修改，请重新核对')) r.issues.push('原文有修改，请重新核对'); }); this.autosave(); });
    const tools = el('div', 'll-toolbar', '', this.content);
    const arrange = button(tools, this.extracting ? '正在整理…' : screenshots ? '识别截图' : this.draft.rows.some(r => r.edited) ? '保留手工修改，再整理' : '整理成账目', () => this.extract(), 'll-primary'); arrange.disabled = this.extracting || this.readingImages || screenshots && !this.images.length;
    if (!screenshots) button(tools, '添加截图', () => { this.draft.inputMode = 'screenshots'; this.node.querySelector('h2')!.textContent = this.options.onStatement ? '整理对照账单（不直接入账）' : '截图记账'; this.render(); }, 'll-ghost');
    button(tools, '手动加一笔', () => { const row = blankRow(this.draft.recordingDate ?? this.draft.submittedDate); row.accountId = this.options.accountId ?? this.host.repo.config.defaultAccountId ?? ''; row.usedDefault = !!row.accountId; row.edited = true; this.draft.rows.push(row); this.autosave(); this.render(); });
    if (this.draft.rows.length) button(tools, '未核对行统一为本次日期', () => { this.draft.completeDates = []; for (const row of this.draft.rows.filter(row => !row.reviewed)) { row.date = this.draft.recordingDate ?? this.draft.submittedDate; if (row.dateRange) row.dateRange.end = row.date; if (row.cost) row.cost.start = row.date; this.edited(row); } this.render(); }, 'll-ghost');
    if (this.draft.error) el('p', 'll-error', this.draft.error, this.content);
    if (this.draft.usage) el('p', 'll-muted', `本次请求用量：输入 ${this.draft.usage.input} / 输出 ${this.draft.usage.output} tokens`, this.content);
    const rows = el('div', 'll-draft-list', '', this.content);
    this.draft.rows.forEach(row => this.renderRow(rows, row));
    for (const e of this.draft.excluded) el('p', 'll-muted', `未入账：${e.source_quote}（${e.reason}）`, this.content);
    this.renderFooter();
    if (focusLabel) {
      const scope = focusRow ? this.content.querySelector(`[data-row-id="${CSS.escape(focusRow)}"]`) : this.content;
      scope?.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focusLabel)}"]`)?.focus({ preventScroll: true });
    }
    restorePosition();
  }
  private renderFooter() {
    const restorePosition = captureViewPosition(this.node);
    this.content.querySelector('.ll-editor-footer')?.remove();
    const footer = el('div', 'll-editor-footer', '', this.content);
    if (this.options.onStatement) {
      el('p', 'll-muted', '这里只整理对照材料，不保存流水、不确认全天记完。识别结果仍需对照原账单。', footer);
      const use = button(footer, '用于账单比对', async () => { try { await this.options.onStatement!(structuredClone(this.draft)); this.closeDialog(); } catch (error) { this.draft.error = (error as Error).message; this.render(); } }, 'll-primary'); use.disabled = this.extracting || this.readingImages || this.images.length > 0 || !this.draft.rows.length;
      restorePosition(); return;
    }
    const date = this.draft.recordingDate ?? this.draft.submittedDate, label = date === localDate() ? '今天所有账户已记完' : `${date} 所有账户已记完`;
    check(footer, label, this.draft.completeDates.includes(date), complete => { this.draft.completeDates = complete ? [...new Set([...this.draft.completeDates, date])] : this.draft.completeDates.filter(d => d !== date); this.autosave(); this.renderFooter(); this.content.querySelector<HTMLInputElement>(`[aria-label="${CSS.escape(label)}"]`)?.focus({ preventScroll: true }); });
    const ready = this.draft.rows.filter(r => r.reviewed && rowIssues(r, this.host.repo.config, this.host.repo.state, this.draft).length === 0);
    let income = 0, expense = 0, refund = 0;
    for (const r of ready) { let n = cents(r.amount, r.kind === 'adjustment'); if (r.currency && r.currency !== 'CNY') n = roundedRatio(n, r.rateCny ? parseRate(r.rateCny) : rateFor(this.host.repo.config, r.currency), RATE_SCALE); if (r.kind === 'income') income += n; if (r.kind === 'expense') expense += n; if (r.kind === 'refund') refund += n; }
    el('p', '', `已核对 ${ready.length} 笔 · 收入 ¥${money(income)} · 净支出 ¥${money(expense - refund)} · 结余 ¥${money(income - expense + refund)}`, footer);
    const completeOnly = !this.draft.rows.length && this.draft.completeDates.length > 0;
    const save = button(footer, this.saving ? '保存中…' : completeOnly ? date === localDate() ? '确认今天记完（无新增账目）' : `确认${date}记完（无新增账目）` : `保存 ${ready.length} 笔`, () => this.save(), 'll-primary'); save.disabled = this.saving || (ready.length === 0 && !completeOnly);
    if (ready.length < this.draft.rows.length) el('p', 'll-muted', '未核对或信息不足的记录保留在草稿中。本次部分保存不会确认今天已记完。', footer);
    button(footer, '保存草稿并关闭', async () => { try { await this.flush(); this.closeDialog(); } catch (e) { this.host.notice((e as Error).message); } });
    restorePosition();
  }
  private renderRow(parent: HTMLElement, row: DraftRow) {
    const c = this.host.repo.config, state = this.host.repo.state;
    const source = c.accounts.find(a => a.id === (['transfer', 'lend', 'collect'].includes(row.kind) ? row.fromAccountId : row.accountId));
    const target = c.accounts.find(a => a.id === row.toAccountId);
    row.currency ??= source ? accountCurrency(source) : 'CNY';
    const card = el('article', 'll-draft-row', '', parent); card.dataset.rowId = row.id;
    const fields = el('div', 'll-form-grid', '', card);
    const update = (fn: () => void, rebuild = true) => {
      fn(); this.edited(row);
      if (rebuild) this.render(); else {
        card.querySelector<HTMLInputElement>('[aria-label="已核对这笔金额、账户和疑问"]')!.checked = false;
        this.renderIssues(card.querySelector<HTMLElement>('.ll-row-issues')!, row); this.renderFooter();
      }
    };
    select(fields, '类型', row.kind, Object.entries(KIND_NAMES).filter(([key]) => key !== 'adjustment'), v => update(() => {
      row.kind = v as DraftRow['kind']; row.categoryId = ''; row.relatedId = ''; row.debtAccountId = '';
      row.fromAccountId = ''; row.toAccountId = ''; row.accountId = ['transfer', 'lend', 'collect'].includes(v) ? '' : c.defaultAccountId ?? '';
      row.currency = c.accounts.find(a => a.id === row.accountId)?.currency ?? 'CNY'; row.rateCny = undefined; row.receivedAmount = '';
      if (v !== 'expense') row.cost = null;
    }));
    input(fields, '日期', row.date, 'date', v => update(() => { row.date = v; if (row.dateRange) row.dateRange.end = v; }, false));
    input(fields, row.currency === 'CNY' ? '金额（元）' : `金额（${row.currency}）`, row.amount, 'text', v => update(() => { row.amount = v; }, false));
    const assetOptions: [string, string][] = [['', '请选择账户'], ...c.accounts.filter(a => a.kind === 'asset').map(a => [a.id, a.name] as [string, string])];
    if (['transfer', 'lend', 'collect'].includes(row.kind)) {
      select(fields, '转出账户', row.fromAccountId, assetOptions, v => update(() => { row.fromAccountId = v; row.currency = c.accounts.find(a => a.id === v)?.currency ?? 'CNY'; row.rateCny = undefined; }));
      select(fields, '转入账户', row.toAccountId, assetOptions, v => update(() => { row.toAccountId = v; }));
      if (source && target && accountCurrency(source) !== accountCurrency(target)) input(fields, `实际到账（${accountCurrency(target)}）`, row.receivedAmount ?? '', 'text', v => update(() => { row.receivedAmount = v; }, false));
      el('p', 'll-direction', `${c.accounts.find(a => a.id === row.fromAccountId)?.name ?? '转出待补'} → ${c.accounts.find(a => a.id === row.toAccountId)?.name ?? '转入待补'} · ${row.amount || '金额待补'} ${row.currency}${row.receivedAmount && target ? ` → ${row.receivedAmount} ${accountCurrency(target)}` : ''}；本金不计收入支出`, card);
    } else {
      select(fields, '账户', row.accountId, assetOptions, v => update(() => { row.accountId = v; row.usedDefault = false; row.currency = c.accounts.find(a => a.id === v)?.currency ?? 'CNY'; row.rateCny = undefined; }));
      if (row.usedDefault) el('p', 'll-muted', '使用你设置的默认账户', card);
      if (['income', 'expense', 'refund'].includes(row.kind)) select(fields, '分类', row.categoryId, [['', '待分类'], ...c.categories.filter(x => x.kind === (row.kind === 'income' ? 'income' : 'expense')).map(x => [x.id, x.name] as [string, string])], v => update(() => { row.categoryId = v; }));
      if (['borrow', 'repayment'].includes(row.kind)) select(fields, '负债账户', row.debtAccountId, [['', '请选择负债账户'], ...c.accounts.filter(a => a.kind === 'liability').map(a => [a.id, a.name] as [string, string])], v => update(() => { row.debtAccountId = v; }));
      if (row.kind === 'income') select(fields, '收入来源', row.incomeSource, [['active', '主动收入'], ['passive', '被动收入'], ['other', '其他收入']], v => update(() => { row.incomeSource = v as Transaction['incomeSource']; }));
      if (row.kind === 'refund') select(fields, '原消费', row.relatedId, [['', '暂不关联，确认分类'], ...[...state.transactions.values()].filter(t => t.kind === 'expense').sort((a, b) => b.date.localeCompare(a.date)).map(t => [t.id, `${t.date} ${t.note || '支出'} ${formatCurrency(t.amountCents, transactionCurrency(t))}`] as [string, string])], v => update(() => { row.relatedId = v; row.categoryId = state.transactions.get(v)?.categoryId ?? ''; }));
    }
    select(fields, '币种', row.currency, CURRENCIES, v => update(() => { row.currency = v as DraftRow['currency']; row.rateCny = undefined; }));
    if (row.currency !== 'CNY') {
      let cachedRate = row.rateCny ?? ''; try { cachedRate ||= rateText(rateFor(c, row.currency)); } catch { /* review can supply a missing rate */ }
      input(fields, `1 ${row.currency}折合人民币`, cachedRate, 'text', v => update(() => { row.rateCny = v; }, false));
      el('p', 'll-muted', `人民币统计采用核对后的汇率，保存后冻结；参考日期 ${c.exchangeRates?.asOf ?? '待设置'}。历史账目请核对当时汇率。`, card);
    }
    input(fields, '备注', row.note, 'text', v => update(() => { row.note = v; if (row.imageId && v.trim()) row.issues = row.issues.filter(issue => !/^(?:消费)?用途待补$/.test(issue)); }, false));
    if (row.dateRange) el('p', 'll-muted', `区间汇总 ${row.dateRange.start} 至 ${row.dateRange.end}，不当作逐日明细，也不确认每日完整度。`, card);
    if (row.kind === 'expense') check(card, '同时加入每日成本', !!row.cost, v => update(() => { row.cost = v ? { name: row.note, kind: 'device', start: row.date, end: '', residual: '0.00', autoRenew: false } : null; }));
    if (row.cost) {
      const cost = row.cost, box = el('div', 'll-form-grid ll-cost-fields', '', card);
      input(box, '项目名称', cost.name, 'text', v => update(() => { cost.name = v; }, false));
      select(box, '项目类型', cost.kind, [['device', '物品'], ['subscription', '订阅']], v => update(() => { cost.kind = v as 'device' | 'subscription'; }));
      input(box, '开始日', cost.start, 'date', v => update(() => { cost.start = v; }, false));
      input(box, '结束日（不包含）', cost.end, 'date', v => update(() => { cost.end = v; }, false));
      input(box, '预计残值（元）', cost.residual, 'text', v => update(() => { cost.residual = v; }, false));
      check(box, '未来计划自动续费', cost.autoRenew, v => update(() => { cost.autoRenew = v; }));
      if (!cost.end) el('p', 'll-muted', '期限待设置，暂不计每日成本；购买款正常入账一次。', card);
    }
    if (row.sourceQuote) el('blockquote', '', row.sourceQuote, card);
    if (row.imageId) el('p', 'll-muted', '来源：截图识别文字；请核对金额、小数点、日期和付款账户。', card);
    this.renderIssues(el('div', 'll-row-issues', '', card), row);
    check(card, '已核对这笔金额、账户和疑问', row.reviewed, v => { row.reviewed = v; this.autosave(); this.render(); });
    button(card, '移除这行', () => { this.draft.rows = this.draft.rows.filter(r => r.id !== row.id); this.autosave(); this.render(); });
  }
  private renderIssues(target: HTMLElement, row: DraftRow) {
    target.replaceChildren();
    for (const issue of [...row.issues, ...rowIssues(row, this.host.repo.config, this.host.repo.state, this.draft)]) el('p', 'll-issue', issue, target);
    const duplicate = [...this.host.repo.state.transactions.values()].some(t => t.date === row.date && decimal(t.amountCents) === row.amount && t.kind === row.kind && t.accountId === row.accountId);
    if (duplicate) el('p', 'll-issue', '已有同日、同额、同账户记录。若确实又发生一次，可以核对后保留。', target);
    if (row.imageId && this.draft.rows.some(other => other.id !== row.id && other.imageId && other.imageId !== row.imageId && other.sourceQuote === row.sourceQuote && other.date === row.date && other.amount === row.amount && other.accountId === row.accountId)) el('p', 'll-issue', '截图可能有重叠，请核对是否重复记账，需要时移除这行。', target);
  }
  async extract() {
    const screenshots = this.draft.inputMode === 'screenshots';
    if (this.extracting || this.readingImages || (screenshots ? !this.images.length : !this.draft.text.trim())) return;
    const selectedImages = this.images.map(image => ({ ...image })), options = { ...this.imageOptions };
    this.extracting = true; this.draft.error = ''; this.draft.status = 'requesting'; this.render();
    try {
      await this.flush(); const submitted = structuredClone(this.draft);
      const config = this.options.accountId ? { ...this.host.repo.config, defaultAccountId: this.options.accountId } : this.host.repo.config;
      const result = screenshots ? await this.host.extractor.extractScreenshots(this.host.api, this.host.key(), submitted, config, this.host.repo.state, selectedImages, options) : { ...await this.host.extractor.extract(this.host.api, this.host.key(), submitted, config, this.host.repo.state), imageEvidence: undefined };
      if (this.closed) return;
      if (submitted.text !== this.draft.text) throw new Error('整理期间原文已修改，已保留现有草稿，请重新整理');
      const protectedRows = this.draft.rows.filter(r => r.edited);
      const savedQuotes = [...this.host.repo.state.transactions.values()].filter(t => t.draftId === this.draft.id).map(t => t.sourceQuote);
      if (screenshots) {
        this.draft.rows.push(...result.rows.filter(row => !this.draft.rows.some(previous => previous.imageId === row.imageId && previous.sourceQuote === row.sourceQuote)));
        this.draft.imageEvidence = [...(this.draft.imageEvidence ?? []).filter(image => !result.imageEvidence?.some(added => added.id === image.id)), ...(result.imageEvidence ?? [])];
      } else this.draft.rows = [...protectedRows, ...result.rows.filter(r => !protectedRows.some(p => p.sourceQuote && p.sourceQuote === r.sourceQuote) && !savedQuotes.includes(r.sourceQuote))];
      this.draft.excluded = result.excluded; this.draft.completeDates = result.completeDates; this.draft.usage = result.usage; this.draft.status = 'review';
      await this.flush(); if (screenshots) this.clearImages();
    } catch (e) { this.draft.status = 'failed'; this.draft.error = (e as Error).message; await this.flush().catch(() => undefined); }
    finally { selectedImages.forEach(image => { image.dataUrl = ''; }); this.extracting = false; if (!this.closed) this.render(); }
  }
  private async save() {
    if (this.saving) return; this.saving = true; this.draft.error = ''; this.render();
    try {
      await this.flush(); await this.host.repo.load();
      const batchId = id(); const built = draftEvents(this.draft, this.host.repo.config, this.host.repo.state, batchId);
      const before = freedom(this.host.repo.state, this.host.repo.config, localDate());
      const batch = await this.host.repo.commit(built.events, this.draft.requestId, '保存已核对草稿', batchId);
      this.draft.rows = this.draft.rows.filter(r => !built.savedIds.includes(r.id));
      this.draft.status = this.draft.rows.length ? 'review' : 'saved'; this.draft.requestId = id(); this.draft.completeDates = [];
      try { await this.flush(); } catch (e) { this.host.notice(`账目已保存，草稿状态待恢复：${(e as Error).message}`); }
      this.host.changed(before, batch.id);
      if (!this.draft.rows.length) this.closeDialog(); else this.render();
    } catch (e) { this.draft.error = (e as Error).message; }
    finally { this.saving = false; if (!this.closed) this.render(); }
  }
  async destroy() {
    this.clearImages(); this.node.remove(); if (this.closed) { await this.writing; return; }
    this.closed = true; if (this.timeout) clearTimeout(this.timeout);
    try { await this.flush(); } catch (e) { this.host.notice(`草稿保存失败：${(e as Error).message}`); throw e; }
  }
}
