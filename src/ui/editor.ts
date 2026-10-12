import type { Repository } from '../storage/repository';
import type { Config, Draft, DraftRow, Transaction } from '../core/types';
import { blankRow, cents, decimal, id, localDate, money } from '../core/primitives';
import { draftEvents, newDraft, rowIssues } from '../core/drafts';
import { freedom } from '../core/calculations';
import type { ApiSettings, Extractor } from '../api/extractor';
import { button, check, dialog, el, input, select } from './dom';

export const KIND_NAMES: Record<string, string> = { income: '收入', expense: '支出', transfer: '内部转账', refund: '退款', borrow: '借入本金', repayment: '归还本金', lend: '借出本金', collect: '收回本金', adjustment: '对账调整', unknown: '用途待补' };
export interface EditorHost {
  repo: Repository; extractor: Extractor; api: ApiSettings; key: () => string;
  notice: (message: string) => void; changed: (before: ReturnType<typeof freedom>, batchId: string) => void;
  draftChanged?: () => void;
}
export class DraftEditor {
  private draft: Draft; private content: HTMLElement; private node: HTMLDialogElement;
  private timeout?: ReturnType<typeof setTimeout>; private writing: Promise<void> = Promise.resolve();
  private closed = false; private extracting = false; private saving = false;
  private closeDialog: () => void;
  constructor(parent: HTMLElement, private host: EditorHost, existing?: Draft, initialText = '') {
    this.draft = existing ? structuredClone(existing) : newDraft(initialText);
    this.draft.origin = 'editor';
    this.draft.textHistory ??= [];
    if (this.draft.status === 'requesting') { this.draft.status = 'failed'; this.draft.error = '上次整理被中断，原文和草稿保留'; }
    const d = dialog(parent, '记一段生活', () => { this.closed = true; if (this.timeout) clearTimeout(this.timeout); if (this.draft.status !== 'saved') void this.flush().catch(e => host.notice(`草稿保存失败：${(e as Error).message}`)); });
    this.node = d.node; this.closeDialog = d.close; this.content = el('div', 'll-editor', '', this.node); this.render();
    this.content.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }
  private autosave() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => { this.timeout = undefined; void this.flush().catch(e => this.host.notice((e as Error).message)); }, 350);
  }
  private flush(): Promise<void> {
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = undefined; }
    this.writing = this.writing.catch(() => undefined).then(async () => {
      if (!this.draft.revision && !this.draft.text.trim() && !this.draft.rows.length && !this.draft.completeDates.length) return;
      await this.host.repo.saveDraft(this.draft); this.host.draftChanged?.();
    }); return this.writing;
  }
  private edited(row: DraftRow) { row.edited = true; row.reviewed = false; this.autosave(); }
  private render() {
    const focused = this.content.contains(document.activeElement) ? document.activeElement as HTMLInputElement : null;
    const focusLabel = focused?.getAttribute('aria-label'), focusRow = focused?.closest<HTMLElement>('.ll-draft-row')?.dataset.rowId;
    this.content.replaceChildren();
    el('p', 'll-muted', '在这里用 Typeless 口播、打字或粘贴。整理后统一核对，再保存。', this.content);
    const text = el('textarea', 'll-text-input', '', this.content); text.placeholder = '今天早饭八块，午饭二十五，晚饭三十二，地铁六块，公众号到账三百。今天就这些。'; text.value = this.draft.text; text.setAttribute('aria-label', '原文');
    const previousText = this.draft.text;
    text.addEventListener('change', () => { if (previousText.trim() && previousText !== text.value) this.draft.textHistory.push(previousText); this.autosave(); });
    text.addEventListener('input', () => { this.draft.text = text.value; this.draft.status = 'editing'; this.draft.rows.forEach(r => { r.reviewed = false; if (!r.issues.includes('原文有修改，请重新核对')) r.issues.push('原文有修改，请重新核对'); }); this.autosave(); });
    const tools = el('div', 'll-toolbar', '', this.content);
    const arrange = button(tools, this.extracting ? '正在整理…' : this.draft.rows.some(r => r.edited) ? '保留手工修改，再整理' : '整理成账目', () => this.extract(), 'll-primary'); arrange.disabled = this.extracting;
    button(tools, '手动加一笔', () => { const row = blankRow(); row.accountId = this.host.repo.config.defaultAccountId ?? ''; row.usedDefault = !!row.accountId; row.edited = true; this.draft.rows.push(row); this.autosave(); this.render(); });
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
  }
  private renderFooter() {
    this.content.querySelector('.ll-editor-footer')?.remove();
    const footer = el('div', 'll-editor-footer', '', this.content);
    check(footer, '今天所有账户已记完', this.draft.completeDates.includes(localDate()), complete => { this.draft.completeDates = complete ? [...new Set([...this.draft.completeDates, localDate()])] : this.draft.completeDates.filter(d => d !== localDate()); this.autosave(); this.renderFooter(); this.content.querySelector<HTMLInputElement>('[aria-label="今天所有账户已记完"]')?.focus({ preventScroll: true }); });
    const ready = this.draft.rows.filter(r => r.reviewed && rowIssues(r, this.host.repo.config, this.host.repo.state, this.draft).length === 0);
    let income = 0, expense = 0, refund = 0;
    for (const r of ready) { const n = cents(r.amount, r.kind === 'adjustment'); if (r.kind === 'income') income += n; if (r.kind === 'expense') expense += n; if (r.kind === 'refund') refund += n; }
    el('p', '', `已核对 ${ready.length} 笔 · 收入 ¥${money(income)} · 净支出 ¥${money(expense - refund)} · 结余 ¥${money(income - expense + refund)}`, footer);
    const completeOnly = !this.draft.rows.length && this.draft.completeDates.length > 0;
    const save = button(footer, this.saving ? '保存中…' : completeOnly ? '确认今天记完（无新增账目）' : `保存 ${ready.length} 笔`, () => this.save(), 'll-primary'); save.disabled = this.saving || (ready.length === 0 && !completeOnly);
    if (ready.length < this.draft.rows.length) el('p', 'll-muted', '未核对或信息不足的记录保留在草稿中。本次部分保存不会确认今天已记完。', footer);
    button(footer, '保存草稿并关闭', async () => { try { await this.flush(); this.closeDialog(); } catch (e) { this.host.notice((e as Error).message); } });
  }
  private renderRow(parent: HTMLElement, row: DraftRow) {
    const c = this.host.repo.config, state = this.host.repo.state;
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
      if (v !== 'expense') row.cost = null;
    }));
    input(fields, '日期', row.date, 'date', v => update(() => { row.date = v; if (row.dateRange) row.dateRange.end = v; }, false));
    input(fields, '金额（元）', row.amount, 'text', v => update(() => { row.amount = v; }, false));
    const assetOptions: [string, string][] = [['', '请选择账户'], ...c.accounts.filter(a => a.kind === 'asset').map(a => [a.id, a.name] as [string, string])];
    if (['transfer', 'lend', 'collect'].includes(row.kind)) {
      select(fields, '转出账户', row.fromAccountId, assetOptions, v => update(() => { row.fromAccountId = v; }));
      select(fields, '转入账户', row.toAccountId, assetOptions, v => update(() => { row.toAccountId = v; }));
      el('p', 'll-direction', `${c.accounts.find(a => a.id === row.fromAccountId)?.name ?? '转出待补'} → ${c.accounts.find(a => a.id === row.toAccountId)?.name ?? '转入待补'} · ${row.amount || '金额待补'} 元；本金不计收入支出`, card);
    } else {
      select(fields, '账户', row.accountId, assetOptions, v => update(() => { row.accountId = v; row.usedDefault = false; }));
      if (row.usedDefault) el('p', 'll-muted', '使用你设置的默认账户', card);
      if (['income', 'expense', 'refund'].includes(row.kind)) select(fields, '分类', row.categoryId, [['', '待分类'], ...c.categories.filter(x => x.kind === (row.kind === 'income' ? 'income' : 'expense')).map(x => [x.id, x.name] as [string, string])], v => update(() => { row.categoryId = v; }));
      if (['borrow', 'repayment'].includes(row.kind)) select(fields, '负债账户', row.debtAccountId, [['', '请选择负债账户'], ...c.accounts.filter(a => a.kind === 'liability').map(a => [a.id, a.name] as [string, string])], v => update(() => { row.debtAccountId = v; }));
      if (row.kind === 'income') select(fields, '收入来源', row.incomeSource, [['active', '主动收入'], ['passive', '被动收入'], ['other', '其他收入']], v => update(() => { row.incomeSource = v as Transaction['incomeSource']; }));
      if (row.kind === 'refund') select(fields, '原消费', row.relatedId, [['', '暂不关联，确认分类'], ...[...state.transactions.values()].filter(t => t.kind === 'expense').sort((a, b) => b.date.localeCompare(a.date)).map(t => [t.id, `${t.date} ${t.note || '支出'} ¥${money(t.amountCents)}`] as [string, string])], v => update(() => { row.relatedId = v; row.categoryId = state.transactions.get(v)?.categoryId ?? ''; }));
    }
    input(fields, '备注', row.note, 'text', v => update(() => { row.note = v; }, false));
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
    this.renderIssues(el('div', 'll-row-issues', '', card), row);
    check(card, '已核对这笔金额、账户和疑问', row.reviewed, v => { row.reviewed = v; this.autosave(); this.render(); });
    button(card, '移除这行', () => { this.draft.rows = this.draft.rows.filter(r => r.id !== row.id); this.autosave(); this.render(); });
  }
  private renderIssues(target: HTMLElement, row: DraftRow) {
    target.replaceChildren();
    for (const issue of [...row.issues, ...rowIssues(row, this.host.repo.config, this.host.repo.state, this.draft)]) el('p', 'll-issue', issue, target);
    const duplicate = [...this.host.repo.state.transactions.values()].some(t => t.date === row.date && decimal(t.amountCents) === row.amount && t.kind === row.kind && t.accountId === row.accountId);
    if (duplicate) el('p', 'll-issue', '已有同日、同额、同账户记录。若确实又发生一次，可以核对后保留。', target);
  }
  async extract() {
    if (this.extracting || !this.draft.text.trim()) return;
    this.extracting = true; this.draft.error = ''; this.draft.status = 'requesting'; this.render();
    try {
      await this.flush(); const submitted = structuredClone(this.draft);
      const result = await this.host.extractor.extract(this.host.api, this.host.key(), submitted, this.host.repo.config, this.host.repo.state);
      if (this.closed) return;
      if (submitted.text !== this.draft.text) throw new Error('整理期间原文已修改，已保留现有草稿，请重新整理');
      const protectedRows = this.draft.rows.filter(r => r.edited);
      const savedQuotes = [...this.host.repo.state.transactions.values()].filter(t => t.draftId === this.draft.id).map(t => t.sourceQuote);
      this.draft.rows = [...protectedRows, ...result.rows.filter(r => !protectedRows.some(p => p.sourceQuote && p.sourceQuote === r.sourceQuote) && !savedQuotes.includes(r.sourceQuote))];
      this.draft.excluded = result.excluded; this.draft.completeDates = result.completeDates; this.draft.usage = result.usage; this.draft.status = 'review';
      await this.flush();
    } catch (e) { this.draft.status = 'failed'; this.draft.error = (e as Error).message; await this.flush().catch(() => undefined); }
    finally { this.extracting = false; if (!this.closed) this.render(); }
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
    this.node.remove(); if (this.closed) { await this.writing; return; }
    this.closed = true; if (this.timeout) clearTimeout(this.timeout);
    try { await this.flush(); } catch (e) { this.host.notice(`草稿保存失败：${(e as Error).message}`); throw e; }
  }
}
