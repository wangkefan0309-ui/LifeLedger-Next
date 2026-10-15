import type { Account, Draft, DraftRow, Transaction } from '../core/types';
import { accountCurrency, formatCurrency } from '../core/currency';
import { affects } from '../core/calculations';
import { addDays, cents, id, localDate } from '../core/primitives';
import { newDraft } from '../core/drafts';
import { checkpointValid, compareStatement, findDifferenceCandidates, makeCheckpoint, pendingRows, reconciliationSummary } from '../core/reconciliation';
import { requireThat } from '../core/ledger';
import { DraftEditor, type EditorHost } from './editor';
import { button, captureViewPosition, check, dialog, el, input } from './dom';

interface Actions { openDraft: (draftId: string) => void | Promise<void>; editTransaction: (tx: Transaction) => void; refreshed: () => void }
export class ReconciliationDialog {
  private node: HTMLDialogElement; private closeDialog: () => void; private body: HTMLElement; private error: HTMLElement;
  private start: HTMLInputElement; private end: HTMLInputElement; private actual: HTMLInputElement;
  private statement?: Draft; private importEditor?: DraftEditor; private closed = false; private busy = false;
  constructor(private parent: HTMLElement, private host: EditorHost, private account: Account, date: string, private actions: Actions) {
    const d = dialog(parent, `${account.name} · 按日查差额`, () => { this.closed = true; this.statement = undefined; void this.importEditor?.destroy(); }); this.node = d.node; this.node.classList.add('ll-reconciliation-dialog'); this.closeDialog = d.close;
    el('p', 'll-muted', '核对同一账户本币余额，截止日按日终计算。查差额和账单比对只提供线索，不自动记账、删除或补调整。', this.node);
    const form = el('div', 'll-form-grid', '', this.node), receipts = host.repo.config.reconciliations?.filter(r => r.accountId === account.id && r.date < date && checkpointValid(r, host.repo.state, host.repo.config)).sort((a, b) => b.date.localeCompare(a.date));
    const previous = receipts?.[0], sameDay = host.repo.config.reconciliations?.find(r => r.accountId === account.id && r.date === date);
    const changed = () => { this.statement = undefined; this.render(); };
    this.start = input(form, '核对起始日期', sameDay?.start ?? (previous ? addDays(previous.date, 1) : date), 'date', changed);
    this.end = input(form, '截止日期（日终）', date, 'date', changed); this.start.max = this.end.max = localDate();
    this.actual = input(form, `实际日终余额（${accountCurrency(account)}）`, sameDay ? (sameDay.actualCents / 100).toFixed(2) : '', 'text', () => this.render());
    const tools = el('div', 'll-toolbar', '', this.node);
    button(tools, '查差额', () => this.run(async () => { await host.repo.load(); this.render(); }), 'll-primary');
    button(tools, '粘贴对照账单', () => this.openStatement(false)); button(tools, '截图对照账单', () => this.openStatement(true));
    el('small', 'll-muted', '只有余额时只能筛选候选；提供期间完整明细后可逐笔比对。相同金额会按笔数匹配，金额日期相符仍需核对原账单。', this.node);
    this.error = el('p', 'll-error', '', this.node); this.error.setAttribute('role', 'alert'); this.body = el('div', 'll-reconciliation-results', '', this.node); this.render();
  }
  private async run(action: () => Promise<void>) {
    if (this.busy || this.closed) return; this.busy = true; this.error.textContent = '';
    try { await action(); } catch (error) { if (!this.closed) this.error.textContent = (error as Error).message; }
    finally { this.busy = false; }
  }
  private amount(value: number): string { return formatCurrency(value, accountCurrency(this.account)); }
  private render() {
    if (this.closed) return; const restore = captureViewPosition(this.node); this.body.replaceChildren(); this.error.textContent = '';
    try {
      const { state, config, drafts } = this.host.repo, start = this.start.value, end = this.end.value;
      const summary = reconciliationSummary(state, config, this.account.id, start, end);
      const closing = el('section', 'll-panel ll-reconciliation-summary', '', this.body);
      el('h3', '', `${this.account.name} · 截至 ${end} 日终`, closing);
      if (summary.opening === null || summary.closing === null) { el('p', 'll-error', `账户余额自${this.account.openingDate}生效，此前无法推算。请核对起始日期，不将未知余额当成零。`, closing); return; }
      el('p', '', `账本起始余额 ${this.amount(summary.opening)} ＋ 转入及入账 ${this.amount(summary.incoming)} － 转出及扣款 ${this.amount(summary.outgoing)} ＋ 对账调整 ${this.amount(summary.adjustments)}`, closing);
      el('strong', 'll-number ll-reconciliation-book-balance', `账本日终余额 ${this.amount(summary.closing)}`, closing);
      if (summary.checkpoint) el('p', 'll-muted ll-checkpoint-status', `${summary.checkpoint.date} ${summary.checkpoint.scope === 'statement' ? '明细及余额' : '余额'}核对记录：${summary.checkpointCurrent ? '仍有效' : '相关流水已改变，需要重新核对'}`, closing);
      if (!this.actual.value.trim()) { el('p', 'll-muted', '填写这个账户在截止日结束时的实际余额，再查差额。', closing); this.renderStatement(); return; }
      const actual = cents(this.actual.value, true), difference = actual - summary.closing;
      el('p', difference === 0 ? 'll-reconciliation-difference' : 'll-issue ll-reconciliation-difference', `差额（实际－账本）${this.amount(difference)}${difference === 0 ? ' · 余额相符' : difference < 0 ? ' · 实际比账本少' : ' · 实际比账本多'}`, closing);
      const candidates = findDifferenceCandidates(state, config, drafts, this.account.id, start, end, difference);
      const list = el('section', 'll-reconciliation-candidates', '', this.body); el('h3', '', '需要优先核查的项目', list);
      if (!candidates.length) el('p', 'll-muted', difference ? '本地未找到能直接解释差额的候选，请提供同期完整账单；不会用猜测补齐差额。' : '当前区间未发现未入账行或重复线索。余额相符不代表所有流水均正确。', list);
      for (const candidate of candidates) {
        const card = el('article', 'll-panel ll-reconciliation-candidate', '', list); card.dataset.kind = candidate.kind; el('p', '', candidate.message, card);
        if (candidate.effectCents !== null) el('small', 'll-muted', `候选对余额的影响 ${this.amount(candidate.effectCents)}`, card);
        if (candidate.draftId) button(card, '继续处理草稿', () => { this.closeDialog(); void this.actions.openDraft(candidate.draftId!); });
        for (const transactionId of candidate.transactionIds) { const tx = state.transactions.get(transactionId); if (tx) { el('p', 'll-muted', `${tx.date} · ${tx.note || '已记账目'} · ${this.amount(affects(tx, this.account.id))}`, card); button(card, '查看并更正这笔', () => { this.closeDialog(); this.actions.editTransaction(tx); }); } }
      }
      if (candidates.length >= 40 || summary.entries.length > 200) el('p', 'll-muted', '候选最多显示40项，双笔组合只检查最近200条；请用完整账单继续比对。', list);
      const comparison = this.renderStatement();
      const confirmation = el('section', 'll-panel', '', this.body); let acknowledged = false;
      const save = button(confirmation, '确认这个账户已核对', () => this.run(async () => {
        requireThat(acknowledged, '请先确认核对范围和实际余额');
        const requestedStart = this.start.value, requestedEnd = this.end.value, requestedActual = cents(this.actual.value, true), statement = this.statement ? structuredClone(this.statement) : undefined;
        await this.host.repo.load(); if (this.closed) return;
        requireThat(this.start.value === requestedStart && this.end.value === requestedEnd && cents(this.actual.value, true) === requestedActual, '输入已变化，请重新查差额并确认');
        const record = makeCheckpoint(this.host.repo.state, this.host.repo.config, this.host.repo.drafts, this.account.id, requestedStart, requestedEnd, requestedActual, statement);
        const c = this.host.repo.config;
        await this.host.repo.saveConfig({ ...c, reconciliations: [...(c.reconciliations ?? []).filter(r => r.accountId !== record.accountId || r.date !== record.date), record] }, this.host.repo.configRevision);
        await this.host.repo.load(); this.actions.refreshed(); this.render(); this.host.notice('已保存该账户的对账记录；没有新增收支或确认其他账户');
      }), 'll-primary');
      const pending = pendingRows(drafts, this.account.id, summary.account.openingDate, end, config).length > 0;
      const allowed = difference === 0 && !pending && (!comparison || comparison.exact);
      save.disabled = true;
      check(confirmation, this.statement ? '我已核对同一账户完整明细及日终余额' : '我已核对该账户日终余额（不代表逐笔核对）', false, checked => { acknowledged = checked; save.disabled = !checked || !allowed; });
      if (!allowed) el('p', 'll-muted', '余额有差额、存在未处理草稿或明细差异时，请先处理再确认。本操作不会自动校准余额。', confirmation);
      el('small', 'll-muted', '对账记录只针对该账户。改动截止日前相关流水后记录会失效；不会自动标记全天所有账户已记完。', confirmation);
    } catch (error) { this.error.textContent = (error as Error).message; }
    finally { restore(); }
  }
  private renderStatement() {
    if (!this.statement) return undefined;
    const { state, config } = this.host.repo, comparison = compareStatement(state, config, this.account.id, this.start.value, this.end.value, this.statement);
    const panel = el('section', 'll-panel ll-statement-comparison', '', this.body); el('h3', '', '原账单与已记账目比对', panel);
    el('p', 'll-statement-counts', `金额日期对应 ${comparison.matched.length} 笔 · 账单有、账本未找到 ${comparison.missing.length} 笔 · 金额不同 ${comparison.changed.length} 笔 · 账本有、账单未找到 ${comparison.extra.length} 笔 · 信息待补 ${comparison.unresolved.length} 笔`, panel);
    el('small', 'll-muted', '对应仅表示日期、方向和金额匹配，不保证识别文字正确或账单完整。相同金额按次数逐条配对。', panel);
    if (this.statement.excluded.length) el('p', 'll-issue', `对照材料有${this.statement.excluded.length}条被识别为排除项，请核对是否漏掉交易；需完整有效明细后再确认。`, panel);
    for (const item of comparison.missing) { const card = el('article', 'll-reconciliation-missing', '', panel); el('p', '', `疑似漏记：${item.row.date} ${item.row.note} · ${this.amount(item.effectCents)}`, card); button(card, '生成这一笔核对草稿', () => this.makeDraft([item.row])); }
    if (comparison.missing.length > 1) button(panel, '将疑似漏记项生成一份核对草稿', () => this.makeDraft(comparison.missing.map(item => item.row)));
    for (const item of comparison.changed) { const card = el('article', 'll-reconciliation-changed', '', panel); el('p', '', `${item.item.row.note} · 原账单 ${this.amount(item.item.effectCents)} / 账本 ${this.amount(affects(item.transaction, this.account.id))}`, card); button(card, '查看并更正这笔', () => { this.closeDialog(); this.actions.editTransaction(item.transaction); }); }
    for (const tx of comparison.extra) { const card = el('article', 'll-reconciliation-extra', '', panel); el('p', '', `账单未找到对应项：${tx.date} ${tx.note} · ${this.amount(affects(tx, this.account.id))}。账单可能不完整，请勿直接当作重复。`, card); button(card, '查看并更正这笔', () => { this.closeDialog(); this.actions.editTransaction(tx); }); }
    for (const item of comparison.unresolved) el('p', 'll-issue', `${item.row.note || '对照条目'}：${item.issues.join('；')}`, panel);
    button(panel, '移除本次对照材料', () => { this.statement = undefined; this.render(); }, 'll-ghost');
    return { ...comparison, exact: comparison.exact && this.statement.excluded.length === 0 };
  }
  private async openStatement(screenshots: boolean) {
    await this.run(async () => {
      reconciliationSummary(this.host.repo.state, this.host.repo.config, this.account.id, this.start.value, this.end.value);
      await this.importEditor?.destroy();
      this.importEditor = new DraftEditor(this.parent, this.host, undefined, '', screenshots, { date: this.end.value, accountId: this.account.id, onStatement: draft => { if (this.closed) return; this.statement = draft; this.render(); } });
    });
  }
  private async makeDraft(rows: DraftRow[]) {
    await this.run(async () => {
      requireThat(this.statement && rows.length > 0, '没有待补账单条目');
      const draft = newDraft(this.statement.text, localDate(), this.end.value); draft.origin = 'editor'; draft.inputMode = this.statement.inputMode; draft.imageEvidence = structuredClone(this.statement.imageEvidence);
      draft.rows = rows.map(row => ({ ...structuredClone(row), id: id(), reviewed: false })); draft.status = 'review';
      await this.host.repo.saveDraft(draft); this.closeDialog(); await this.actions.openDraft(draft.id);
    });
  }
  async destroy() { if (!this.closed) this.closeDialog(); await this.importEditor?.destroy(); }
}
