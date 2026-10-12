import { affects, baseline, costOn, dayStatus, filterTransactions, freedom, series, totals } from '../core/calculations';
import { addDays, cents, daysBetween, decimal, id, localDate, money, validDate } from '../core/primitives';
import { applyEvents, requireThat } from '../core/ledger';
import { newDraft } from '../core/drafts';
import type { Account, Config, Cost, Draft, LedgerEvent, Transaction } from '../core/types';
import { DraftEditor, KIND_NAMES, type EditorHost } from './editor';
import { button, check, dialog, download, el, input, select } from './dom';
import { Stage } from './stage';

export interface AppHost extends EditorHost { openSettings: () => void; openFile: (path: string) => void }
type Page = '首页' | '账本' | '分析' | '账户' | '每日成本';
export class LedgerUI {
  page: Page = '首页'; month = localDate().slice(0, 7); selectedDay = ''; accountFilter = ''; categoryFilter = '';
  private shell: HTMLElement; private overlays: HTMLElement; private stage?: Stage;
  private editor?: DraftEditor; private lastBatch = ''; private lastChange?: { before: ReturnType<typeof freedom>; after: ReturnType<typeof freedom> };
  private noticeArea?: HTMLElement; private busy = false;
  private renderedSignature = ''; private homeText = ''; private selectedAccount = '';
  private homeDraft?: Draft; private captureTimer?: ReturnType<typeof setTimeout>;
  private captureWriting: Promise<void> = Promise.resolve(); private captureStatus = '';
  private openingDraft = false;
  constructor(private root: HTMLElement, readonly host: AppHost) {
    root.classList.add('lifeledger'); this.shell = el('div', 'll-shell', '', root); this.overlays = el('div', 'll-overlays', '', root);
    const capture = host.repo.drafts.find(d => d.origin === 'home' && d.status === 'editing' && !d.rows.length && d.text.trim());
    if (capture) { this.homeDraft = structuredClone(capture); this.homeText = capture.text; this.captureStatus = '已恢复上次未整理的原文'; }
    const latest = host.repo.state.batches.at(-1);
    if (latest && !latest.reason.startsWith('撤销 ') && !latest.reason.includes('备份恢复')) this.lastBatch = latest.id;
    this.render();
  }
  private config() { return this.host.repo.config; }
  private state() { return this.host.repo.state; }
  private async action(fn: () => Promise<void>) {
    if (this.busy) return; this.busy = true;
    try { await fn(); } catch (e) {
      const message = (e as Error).message; this.host.notice(message); if (this.noticeArea) this.noticeArea.textContent = message;
      const active = this.overlays.querySelector<HTMLDialogElement>('dialog[open]');
      if (active) {
        let error = active.querySelector<HTMLElement>('.ll-form-error');
        if (!error) { error = el('p', 'll-error ll-form-error', '', active); error.setAttribute('role', 'alert'); active.querySelector('.ll-dialog-header')?.after(error); }
        error.textContent = message;
      }
    }
    finally { this.busy = false; }
  }
  changed(before: ReturnType<typeof freedom>, batchId: string) {
    this.lastBatch = batchId;
    this.lastChange = { before, after: freedom(this.state(), this.config(), localDate()) };
    this.render(); if (this.stage) void this.stage.play(before, this.lastChange.after);
  }
  async openDraft(draftId?: string, initialText = '', arrange = false) {
    if (this.openingDraft) return; this.openingDraft = true;
    const field = this.shell.querySelector<HTMLTextAreaElement>('.ll-home-input'); if (field) field.readOnly = true;
    try {
    await this.flushPending(); await this.editor?.destroy();
    if ((!draftId && this.homeText.trim()) || (this.homeDraft && draftId === this.homeDraft.id)) {
      draftId = this.homeDraft?.id; initialText = this.homeText;
      this.homeText = ''; this.homeDraft = undefined; this.captureStatus = '';
      const text = this.shell.querySelector<HTMLTextAreaElement>('.ll-home-input'); if (text) text.value = '';
    }
    this.editor = new DraftEditor(this.overlays, { ...this.host, changed: (before, batchId) => this.changed(before, batchId), draftChanged: () => this.renderPending() }, this.host.repo.drafts.find(d => d.id === draftId), initialText);
    if (arrange) void this.editor.extract();
    } catch (e) { this.host.notice(`原文保留，请重试：${(e as Error).message}`); }
    finally { this.openingDraft = false; if (field) field.readOnly = false; }
  }
  private capture(text: string) {
    this.homeText = text;
    if (!this.homeDraft && text.trim()) { this.homeDraft = newDraft(text); this.homeDraft.origin = 'home'; }
    if (!this.homeDraft) return;
    this.homeDraft.text = text; this.captureStatus = '正在保存原文草稿…'; this.showCaptureStatus();
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => { void this.flushPending().catch(e => { this.captureStatus = `原文草稿保存失败：${(e as Error).message}`; this.showCaptureStatus(); this.host.notice(this.captureStatus); }); }, 350);
  }
  private showCaptureStatus() { const status = this.shell.querySelector('.ll-capture-status'); if (status) status.textContent = this.captureStatus; }
  async flushPending() {
    if (this.captureTimer) { clearTimeout(this.captureTimer); this.captureTimer = undefined; }
    const draft = this.homeDraft; if (!draft) { await this.captureWriting; return; }
    this.captureWriting = this.captureWriting.catch(() => undefined).then(async () => {
      await this.host.repo.saveDraft(draft); this.captureStatus = '原文已自动保存为草稿，尚未入账'; this.showCaptureStatus();
    }); await this.captureWriting;
  }
  render() {
    this.renderedSignature = this.signature();
    this.stage?.destroy(); this.stage = undefined; this.shell.replaceChildren();
    const header = el('header', 'll-header', '', this.shell); const brand = el('div', '', '', header);
    el('div', 'll-eyebrow', 'LifeLedger / My life, my ledger', brand); el('h1', '', '赚钱已成定局，余生好好体验', brand);
    el('span', 'll-tag', localDate().replaceAll('-', '.'), header);
    const nav = el('nav', 'll-nav', '', this.shell); nav.setAttribute('aria-label', 'LifeLedger 页面');
    for (const page of ['首页', '账本', '分析', '账户', '每日成本'] as Page[]) button(nav, page, () => { this.page = page; this.render(); }, this.page === page ? 'is-active' : '');
    button(nav, '设置', this.host.openSettings);
    this.noticeArea = el('div', 'll-notice', '', this.shell); this.noticeArea.setAttribute('role', 'status');
    if (this.state().issues.length) {
      const errors = el('aside', 'll-errors', '', this.shell);
      el('strong', '', this.state().issues.some(issue => issue.kind !== 'draft') ? '有账本文件需要恢复；相关批次未进入统计，暂停保存新账。' : '有草稿需要恢复，原文件保留；健康账目仍可保存。完整备份前请处理这些草稿。', errors);
      for (const issue of this.state().issues) button(errors, `${issue.path}：${issue.message}`, () => this.host.openFile(issue.path));
      button(errors, '重新读取', () => this.action(async () => { await this.host.repo.load(); this.render(); }));
    }
    const main = el('main', 'll-main', '', this.shell);
    if (this.page === '首页') this.home(main);
    if (this.page === '账本') this.ledger(main);
    if (this.page === '分析') this.analysis(main);
    if (this.page === '账户') this.accounts(main);
    if (this.page === '每日成本') this.costs(main);
  }
  private stat(parent: HTMLElement, label: string, value: string, detail = '') {
    const card = el('div', 'll-stat', '', parent); el('span', 'll-muted', label, card); el('strong', 'll-number', value, card); if (detail) el('small', 'll-muted', detail, card); return card;
  }
  private accountName(aid: string | null) { return this.config().accounts.find(a => a.id === aid)?.name ?? '未配置'; }
  private assetOverview(parent: HTMLElement) {
    const c = this.config(), today = localDate(), f = freedom(this.state(), c, today);
    const overview = el('section', 'll-asset-overview', '', parent); overview.setAttribute('aria-label', '当前资产与账户余额');
    const top = el('div', 'll-section-heading', '', overview); el('h2', '', '我的资产', top); el('span', 'll-muted', `截至 ${today.replaceAll('-', '.')}`, top);
    const summary = el('div', `ll-stats ll-asset-cards${c.accounts.some(a => a.kind === 'asset') ? '' : ' is-empty'}`, '', overview);
    const total = this.stat(summary, '总资产 · 所有资产账户合计', `¥${money(f.assets)}`, `负债 ¥${money(f.liabilities)} · 净资产 ¥${money(f.net)}`); total.classList.add('ll-asset-total');
    const accounts = el('div', 'll-account-strip', '', summary);
    for (const a of c.accounts.filter(a => a.kind === 'asset')) {
      const card = button(accounts, '', () => { this.page = '账户'; this.selectedAccount = a.id; this.render(); }, `ll-asset-account${this.page === '账户' && this.selectedAccount === a.id ? ' is-selected' : ''}`);
      card.dataset.accountId = a.id;
      el('span', 'll-muted', a.name, card); el('strong', 'll-number', `¥${money(f.balances.get(a.id) ?? 0)}`, card);
      const description = a.id === c.defaultAccountId ? '默认日常收支账户' : `自由计算纳入 ${a.freedomBps / 100}%`;
      const foot = el('small', 'll-muted', description, card); el('span', 'll-account-arrow', '↗', foot).setAttribute('aria-hidden', 'true');
    }
    return f;
  }
  private recordRow(parent: HTMLElement, t: Transaction) {
    const transfer = ['transfer', 'lend', 'collect'].includes(t.kind);
    const row = button(parent, '', () => { this.page = '账本'; this.month = t.date.slice(0, 7); this.selectedDay = t.date; this.accountFilter = ''; this.categoryFilter = ''; this.render(); }, 'll-record-row');
    el('span', 'll-record-icon', transfer ? '⇄' : t.kind === 'expense' ? '↘' : t.kind === 'refund' ? '↶' : '↗', row);
    const description = el('span', 'll-record-description', '', row); el('span', 'll-record-title', t.note || KIND_NAMES[t.kind], description);
    const direction = t.fromAccountId ? `${this.accountName(t.fromAccountId)} → ${this.accountName(t.toAccountId)}` : this.accountName(t.accountId);
    el('small', 'll-muted', `${t.date.slice(5).replace('-', '.')} · ${KIND_NAMES[t.kind]} · ${direction}`, description);
    el('span', `ll-record-amount${t.kind === 'income' ? ' ll-green' : transfer ? ' ll-blue' : t.kind === 'refund' ? ' ll-gold' : ''}`, `${t.kind === 'expense' ? '−' : ['income', 'refund'].includes(t.kind) ? '+' : ''}¥${money(t.amountCents)}`, row);
  }
  private home(parent: HTMLElement) {
    const c = this.config(), s = this.state(), today = localDate(), f = freedom(s, c, today);
    parent.classList.add('ll-home'); this.assetOverview(parent);
    if (!c.accounts.length) {
      const onboarding = el('div', 'll-empty', '', parent); el('p', '', '先添加一个自己的账户和期初余额，就可以开始记账。', onboarding);
      button(onboarding, '添加账户', () => this.accountForm(), 'll-primary');
    }
    const body = el('div', 'll-home-layout', '', parent), left = el('div', 'll-home-ledger', '', body), right = el('div', 'll-home-stage', '', body);
    const quick = el('section', 'll-entry-card', '', left);
    const entryHead = el('div', 'll-section-heading', '', quick); const entryTitle = el('div', '', '', entryHead);
    el('h2', '', '今天的钱，直接说', entryTitle); el('small', 'll-muted', '把一整天说完，省下逐笔填表', entryTitle); el('span', 'll-tag', 'Typeless 输入框', entryHead);
    const label = el('label', 'll-entry-label', '用 Typeless 说完，文字直接填到这里', quick);
    const text = el('textarea', 'll-text-input ll-home-input', '', label); text.setAttribute('aria-label', '记账原文'); text.value = this.homeText;
    text.placeholder = '今天早饭八块，午饭二十五，晚饭三十二，地铁六块，公众号到账三百。今天就这些。';
    const actions = el('div', 'll-entry-actions', '', quick);
    const takeText = async (arrange: boolean) => { await this.openDraft(undefined, this.homeText, arrange); parse.disabled = !this.homeText.trim(); };
    const parse = button(actions, '整理成账目', () => takeText(true), 'll-primary'); parse.disabled = !this.homeText.trim();
    text.addEventListener('input', () => { this.capture(text.value); parse.disabled = !text.value.trim(); });
    button(actions, '口播 / 手动记账', () => takeText(false), 'll-ghost');
    el('p', 'll-muted ll-entry-hint', `整理后核对金额与账户，再保存。${c.defaultAccountId ? `普通收支默认使用「${this.accountName(c.defaultAccountId)}」。` : '可在账户页设置默认收支账户。'}转账需明确两端账户。`, quick);
    el('div', 'll-pending-drafts', '', quick); this.renderPending();
    el('p', 'll-muted ll-capture-status', this.captureStatus, quick).setAttribute('role', 'status');
    const recent = el('section', 'll-recent', '', left), transactions = filterTransactions(s, today, today);
    const recentHead = el('div', 'll-section-heading', '', recent); el('h2', '', '今日账目', recentHead); el('small', 'll-muted', `${transactions.length} 笔 · ${dayStatus(s, today, today)}`, recentHead);
    if (!transactions.length) el('p', 'll-empty', '今天还没有保存账目。记下一段生活，账户与总资产会一起更新。', recent);
    for (const t of [...transactions].reverse().slice(0, 7)) this.recordRow(recent, t);
    if (this.lastBatch) button(recent, '撤销最近一批', () => this.action(async () => { const before = freedom(this.state(), this.config(), today); const batch = await this.host.repo.undo(this.lastBatch); this.lastBatch = ''; this.lastChange = { before, after: freedom(this.state(), this.config(), today) }; this.render(); if (this.stage) void this.stage.play(before, this.lastChange.after); this.host.notice(`已追加撤销批次 ${batch.id}`); }), 'll-ghost');
    this.costSummary(left);
    const current = totals(filterTransactions(s, `${today.slice(0, 7)}-01`, today));
    const flows = el('div', 'll-stats ll-home-summary', '', right);
    this.stat(flows, '本月已记录收入', `¥${money(current.income)}`).classList.add('ll-income');
    this.stat(flows, '本月已记录净支出', `¥${money(current.netExpense)}`, current.refund ? `支出 ${money(current.expense)} / 退款 ${money(current.refund)}` : '');
    this.stat(flows, '本月已记录结余', `¥${money(current.surplus)}`);
    this.stat(flows, '长期日均生活成本', f.baseline.daily === null ? '—' : `¥${money(f.baseline.daily)}`, f.baseline.estimated ? '暂估日均 · 尚无完整基线' : `完整基线 ${f.baseline.days} 天${f.baseline.missing && f.baseline.missing <= today ? ` · 待补 ${f.baseline.missing.slice(5)}` : ''}`).classList.add('ll-baseline');
    const stageCard = el('section', 'll-stage-card', '', right);
    const heading = el('div', 'll-section-heading ll-stage-heading', '', stageCard); el('h2', '', '财富自由指南灯', heading); el('small', 'll-muted', '每格一天', heading);
    const number = el('div', 'll-freedom-number', f.count === null ? '—' : f.count.toLocaleString('zh-CN'), stageCard); el('span', 'll-freedom-unit', '天', number);
    el('p', 'll-freedom-sub', `¥${money(f.available)} 可用资金 / ${f.baseline.daily === null ? '日均生活成本待建立' : `¥${money(f.baseline.daily)} 日均生活成本`}`, stageCard);
    el('p', 'll-freedom-sub', f.count === null ? '等待成本基线：记完第一个完整日，或在设置中填写暂估日均。' : `${f.baseline.estimated ? '按暂估日均' : '按当前完整基线'}，可支撑约 ${(f.count / 365).toFixed(1)} 年`, stageCard);
    const math = el('details', 'll-math', '', stageCard); el('summary', '', f.count === null ? '这些格怎么算的？' : `这 ${f.count.toLocaleString('zh-CN')} 格怎么算的？`, math);
    el('p', '', `可用资金 ¥${money(f.available)} = 各资产余额 × 纳入比例 − 负债 − 单独预留 ¥${money(c.reservedCents)}`, math);
    el('p', '', `长期日均 ${f.baseline.daily === null ? '尚无可用样本' : `¥${money(f.baseline.daily)}`}；每格代表一个完整生活日。蓝色 ${f.blue} 格，金色 ${f.gold} 格。`, math);
    if (f.baseline.daily && f.count !== null) el('p', '', `日均不变时，下一格还需净增加 ¥${money(Math.max(0, (f.count + 1) * f.baseline.daily - Math.max(0, f.available)))}`, math);
    const future = Math.max(0, daysBetween(today, c.displayEnd)); if ((f.count ?? 0) > future) el('p', '', `超出展示区间 ${f.count! - future} 天`, math);
    if (f.baseline.missing && f.baseline.missing <= today) el('p', '', `完整基线等待 ${f.baseline.missing} 核对；后续资金仍正常入账。`, math);
    const canvasHost = el('div', 'll-stage', '', stageCard); this.stage = new Stage(canvasHost, c, f);
    const legend = el('div', 'll-legend', '', stageCard);
    el('span', 'll-blue', `■ 起始积累 ${f.blue} 天`, legend); el('span', 'll-gold', `■ 后来增加 ${f.gold} 天`, legend); el('span', 'll-muted', '■ 待覆盖', legend);
    const stageTools = el('div', 'll-stage-tools', '', stageCard);
    button(stageTools, '跳过动画', () => this.stage?.skip());
    button(stageTools, c.sound ? '静音' : '开启声音', () => this.action(async () => { await this.host.repo.saveConfig({ ...c, sound: !c.sound }); this.render(); }));
    if (this.lastChange) button(stageTools, '回看刚才的变化', () => { if (this.lastChange) void this.stage?.play(this.lastChange.before, this.lastChange.after); });
    this.trendChart(right, true);
  }
  private costSummary(parent: HTMLElement) {
    const s = this.state(), today = localDate(), f = freedom(s, this.config(), today);
    const passive = el('section', 'll-cost-summary', '', parent);
    const costTotal = [...s.costs.values()].reduce((sum, cost) => sum + costOn(cost, today).daily, 0);
    el('h2', '', '每日被动流血', passive); el('small', 'll-muted', '今天已登记的固定负担', passive); el('strong', 'll-number ll-gold', `¥${money(costTotal)} / 天`, passive);
    const recent = totals(filterTransactions(s, addDays(today, -29), today));
    el('p', 'll-muted', `近 30 天已记录被动收入 ¥${money(recent.passive)}`, passive);
    el('p', 'll-muted', f.baseline.coverage === null ? '完整区间尚无可用的成本覆盖率' : `完整区间被动收入覆盖率 ${(f.baseline.coverage * 100).toFixed(1)}%`, passive);
    const detail = el('details', '', '', passive); el('summary', '', '查看持续成本', detail); for (const cost of s.costs.values()) el('p', '', `${cost.name} · ${costOn(cost, today).status} · ¥${money(costOn(cost, today).daily)}/天`, detail);
    button(passive, '管理每日成本', () => { this.page = '每日成本'; this.render(); });
  }
  private monthBounds(selectedMonth = this.month) {
    const start = `${selectedMonth}-01`, year = Number(selectedMonth.slice(0, 4)), month = Number(selectedMonth.slice(5));
    const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    return { start, end: addDays(next, -1) };
  }
  private ledger(parent: HTMLElement) {
    const today = localDate(), { start, end } = this.monthBounds(), state = this.state();
    const pageHead = el('div', 'll-page-heading', '', parent), title = el('div', '', '', pageHead);
    el('h2', '', '账本日历', title); el('p', 'll-muted', '按月看收支，点日期查明细。', title);
    const toolbar = el('div', 'll-toolbar ll-month-controls', '', pageHead);
    const shift = (n: number) => { const d = new Date(`${start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); this.month = d.toISOString().slice(0, 7); this.selectedDay = ''; this.render(); };
    button(toolbar, '上个月', () => shift(-1)); input(toolbar, '月份', this.month, 'month', v => { if (/^\d{4}-\d{2}$/.test(v) && validDate(`${v}-01`)) { this.month = v; this.selectedDay = ''; this.render(); } }); button(toolbar, '下个月', () => shift(1));
    button(toolbar, '本月', () => { this.month = today.slice(0, 7); this.selectedDay = ''; this.render(); }); button(toolbar, '查看整月', () => { this.selectedDay = ''; this.render(); });
    select(toolbar, '账户筛选', this.accountFilter, [['', '所有账户'], ...this.config().accounts.map(a => [a.id, a.name] as [string, string])], v => { this.accountFilter = v; this.render(); });
    select(toolbar, '分类筛选', this.categoryFilter, [['', '所有分类'], ['$uncategorized', '待分类'], ...this.config().categories.map(a => [a.id, a.name] as [string, string])], v => { this.categoryFilter = v; this.render(); });
    const ts = filterTransactions(state, start, end, this.accountFilter, this.categoryFilter), total = totals(ts);
    const sums = el('div', 'll-stats ll-month-summary', '', parent); this.stat(sums, '月已记录收入', `¥${money(total.income)}`).classList.add('ll-income'); this.stat(sums, '月净支出', `¥${money(total.netExpense)}`, total.refund ? `支出 ${money(total.expense)} / 退款 ${money(total.refund)}` : ''); this.stat(sums, '月结余', `¥${money(total.surplus)}`).classList.add('ll-baseline');
    const elapsed = Math.max(0, daysBetween(start, end > today ? (today < start ? start : today) : end) + (today < start ? 0 : 1));
    let confirmed = 0; for (let d = start; d <= end && d <= today; d = addDays(d, 1)) if (state.days.get(d)?.complete) confirmed++;
    this.stat(sums, '记录完整度', elapsed ? `${confirmed} / ${elapsed} 天` : '未来月份');
    const layout = el('div', 'll-calendar-layout', '', parent), calendarPanel = el('section', 'll-panel ll-calendar-panel', '', layout);
    el('h3', '', `${start.slice(0, 4)} 年 ${Number(start.slice(5, 7))} 月`, calendarPanel);
    const calendar = el('div', 'll-calendar', '', calendarPanel);
    for (const day of ['一', '二', '三', '四', '五', '六', '日']) el('div', 'll-weekday', day, calendar);
    const offset = (new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7;
    for (let i = 0; i < offset; i++) el('div', '', '', calendar);
    for (let date = start; date <= end; date = addDays(date, 1)) {
      const status = dayStatus(state, date, today), sums = totals(ts.filter(t => t.date === date && !t.dateRange));
      const isToday = date === today;
      const cell = button(calendar, '', () => { this.selectedDay = date; this.render(); }, `ll-day ${date === this.selectedDay ? 'is-selected' : ''} ${isToday ? 'is-today' : ''} ${status === '已记完' || status === '零收支' ? 'is-complete' : ''}`);
      cell.dataset.date = date; cell.setAttribute('aria-label', `${date}${isToday ? ' 今天' : ''} ${status}`);
      const dayHeading = el('span', 'll-day-heading', '', cell); el('strong', '', String(Number(date.slice(-2))), dayHeading);
      if (isToday) { cell.setAttribute('aria-current', 'date'); el('span', 'll-today-dot', '', dayHeading).setAttribute('aria-hidden', 'true'); }
      el('small', 'll-day-status', status, cell);
      if (status !== '未记录' && status !== '未来') { el('small', '', `入 ${money(sums.income)}`, cell); el('small', '', `出 ${money(sums.netExpense)}`, cell); }
    }
    el('p', 'll-muted ll-calendar-legend', '金色小点：今天 · 零收支：已确认当天无收支 · 未记录：尚未确认 · 记录中：有账目，尚未记完', calendarPanel);
    el('small', 'll-muted', '筛选改变金额和明细；记完状态指当天所有账户。区间汇总按结束日进入月汇总。', calendarPanel);
    const detail = el('section', 'll-panel ll-ledger-detail', '', layout); el('h2', '', this.selectedDay ? `${this.selectedDay} · 明细` : `${this.month} · 整月明细`, detail);
    if (this.selectedDay && this.selectedDay <= today) {
      if (!state.days.get(this.selectedDay)?.complete) button(detail, '核对所有账户后，确认当天记完', () => this.action(async () => {
        const before = freedom(state, this.config(), today); const date = this.selectedDay;
        const batch = await this.host.repo.commit([{ type: 'day.set', date, complete: true, expected: state.days.get(date)?.version ?? 0 }], id(), '用户核对全天完整度'); this.changed(before, batch.id);
      }), 'll-primary');
      else button(detail, '改为待核对', () => this.action(async () => { const date = this.selectedDay; const before = freedom(state, this.config(), today); const batch = await this.host.repo.commit([{ type: 'day.set', date, complete: false, expected: state.days.get(date)?.version ?? 0 }], id(), '重新核对当天'); this.changed(before, batch.id); }));
    }
    const displayed = this.selectedDay ? ts.filter(t => t.date === this.selectedDay) : ts;
    if (!displayed.length) el('p', 'll-empty', '此范围没有已记录账目', detail);
    for (const t of [...displayed].reverse()) this.transactionCard(detail, t);
    button(detail, '补记账目', () => this.openDraft());
  }
  private transactionCard(parent: HTMLElement, t: Transaction) {
    const card = el('article', 'll-transaction', '', parent); card.dataset.transactionId = t.id;
    el('strong', '', `${KIND_NAMES[t.kind]} · ¥${money(t.amountCents)}`, card);
    const account = t.fromAccountId ? `${this.accountName(t.fromAccountId)} → ${this.accountName(t.toAccountId)}` : `${this.accountName(t.accountId)}${t.debtAccountId ? ` / ${this.accountName(t.debtAccountId)}` : ''}`;
    el('p', '', `${t.date} · ${account} · ${this.config().categories.find(c => c.id === t.categoryId)?.name ?? '未分类'} · ${t.note}`, card);
    if (t.dateRange) el('p', 'll-muted', `区间汇总 ${t.dateRange.start} 至 ${t.dateRange.end}`, card);
    const evidence = el('details', '', '', card); el('summary', '', '原文与更正记录', evidence); el('p', '', t.originalText || '手动录入', evidence); el('p', 'll-muted', `批次 ${t.batchId} · 版本 ${t.version}`, evidence); for (const correction of t.corrections) el('p', '', correction, evidence);
    const tools = el('div', 'll-toolbar', '', card); button(tools, '更正', () => this.transactionForm(t));
    button(tools, '删除', () => { const d = dialog(this.overlays, '删除这笔账'); el('p', '', '将追加删除记录，并移除关联成本项目。原始文件保留。', d.node); button(d.node, '确认删除', () => this.action(async () => {
      const before = freedom(this.state(), this.config(), localDate()), events: LedgerEvent[] = [];
      for (const cost of this.state().costs.values()) if (cost.transactionId === t.id) events.push({ type: 'cost.delete', id: cost.id, expected: cost.version });
      events.push({ type: 'transaction.delete', id: t.id, expected: t.version });
      const batch = await this.host.repo.commit(events, id(), '删除交易及关联成本'); d.close(); this.changed(before, batch.id);
    }), 'll-primary'); });
  }
  private transactionForm(original: Transaction) {
    const d = dialog(this.overlays, '更正已保存账目'), value = structuredClone(original), form = el('div', 'll-form-grid', '', d.node);
    input(form, '日期', value.date, 'date', v => { value.date = v; }); input(form, '金额（元）', decimal(value.amountCents), 'text', v => { try { value.amountCents = cents(v, value.kind === 'adjustment'); } catch { value.amountCents = NaN; } }); input(form, '备注', value.note, 'text', v => { value.note = v; });
    const asset: [string, string][] = this.config().accounts.filter(a => a.kind === 'asset').map(a => [a.id, a.name]);
    if (value.fromAccountId) { select(form, '转出账户', value.fromAccountId, asset, v => { value.fromAccountId = v; }); select(form, '转入账户', value.toAccountId!, asset, v => { value.toAccountId = v; }); }
    else select(form, '账户', value.accountId!, asset, v => { value.accountId = v; });
    if (['income', 'expense'].includes(value.kind)) select(form, '分类', value.categoryId ?? '', [['', '待分类'], ...this.config().categories.filter(c => c.kind === value.kind).map(c => [c.id, c.name] as [string, string])], v => { value.categoryId = v || null; });
    if (value.kind === 'income') select(form, '收入来源', value.incomeSource, [['active', '主动'], ['passive', '被动'], ['other', '其他']], v => { value.incomeSource = v as Transaction['incomeSource']; });
    if (value.debtAccountId) select(form, '负债账户', value.debtAccountId, this.config().accounts.filter(a => a.kind === 'liability').map(a => [a.id, a.name]), v => { value.debtAccountId = v; });
    if (value.kind === 'refund') select(form, '关联原消费', value.relatedId ?? '', [['', '暂不关联'], ...[...this.state().transactions.values()].filter(t => t.kind === 'expense').map(t => [t.id, `${t.date} ${t.note} ${money(t.amountCents)}`] as [string, string])], v => { value.relatedId = v || null; value.categoryId = this.state().transactions.get(v)?.categoryId ?? value.categoryId; });
    const linked = [...this.state().costs.values()].find(c => c.transactionId === value.id);
    if (linked) el('p', 'll-muted', `金额变化会同时更新成本项目“${linked.name}”，并保留调整记录。`, d.node);
    const reason = input(d.node, '更正说明', '', 'text');
    button(d.node, '保存更正', () => this.action(async () => {
      requireThat(reason.value.trim(), '请填写更正说明'); const before = freedom(this.state(), this.config(), localDate());
      value.version = original.version + 1; value.corrections = [...original.corrections, `${new Date().toISOString()} ${reason.value}`];
      const events: LedgerEvent[] = [{ type: 'transaction.put', expected: original.version, value }];
      if (linked && linked.amountCents !== value.amountCents) events.push({ type: 'cost.put', expected: linked.version, value: { ...linked, amountCents: value.amountCents, version: linked.version + 1, adjustmentNotes: [...linked.adjustmentNotes, reason.value] } });
      const batch = await this.host.repo.commit(events, id(), '用户更正交易'); d.close(); this.changed(before, batch.id);
    }), 'll-primary');
  }
  private trendChart(parent: HTMLElement, compact = false) {
    const today = localDate();
    let metric: 'flows' | 'daily' | 'freedom' = 'flows';
    const chart = el('section', `ll-panel ll-chart${compact ? ' ll-chart-compact' : ''}`, '', parent); chart.setAttribute('aria-label', '趋势图');
    const heading = el('div', 'll-section-heading', '', chart); el('h2', '', '看见变化', heading);
    const choices = el('div', 'll-chart-choices', '', heading), drawing = el('div', 'll-chart-drawing', '', chart);
    const { start, end } = this.monthBounds(compact ? today.slice(0, 7) : this.month), cutoff = end > today ? today : end;
    const points = cutoff < start ? [] : series(this.state(), this.config(), start, cutoff);
    const plot = () => {
      drawing.replaceChildren(); const title = { flows: '每日已记录收入与净支出', daily: '长期完整日均', freedom: '自由天数' }[metric];
      for (const choice of Array.from(choices.querySelectorAll<HTMLButtonElement>('button'))) { const active = choice.dataset.metric === metric; choice.classList.toggle('is-active', active); choice.setAttribute('aria-pressed', String(active)); }
      const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 800 230'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', title); drawing.append(svg);
      const keyList: ('income' | 'expense' | 'daily' | 'freedom')[] = metric === 'flows' ? ['income', 'expense'] : [metric];
      const values = points.flatMap(p => keyList.map(k => p[k])).filter((n): n is number => n !== null);
      const min = Math.min(0, ...values), max = Math.max(1, ...values) * 1.06, range = max - min;
      const coord = (n: number, i: number) => `${60 + i / Math.max(1, points.length - 1) * 710},${190 - (n - min) / range * 155}`;
      for (let tick = 0; tick < 4; tick++) {
        const y = 35 + tick * 155 / 3, value = max - range * tick / 3;
        const line = document.createElementNS(ns, 'line'); line.setAttribute('x1', '55'); line.setAttribute('x2', '770'); line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y)); line.setAttribute('stroke', 'var(--ll-chart-grid)'); line.setAttribute('stroke-dasharray', '3 5'); svg.append(line);
        if (values.length) { const label = document.createElementNS(ns, 'text'); label.setAttribute('x', '48'); label.setAttribute('y', String(y + 4)); label.setAttribute('fill', 'var(--ll-chart-label)'); label.setAttribute('font-size', '11'); label.setAttribute('text-anchor', 'end'); label.textContent = (metric === 'freedom' ? value : value / 100).toLocaleString('zh-CN', { maximumFractionDigits: metric === 'freedom' ? 0 : 2 }); svg.append(label); }
      }
      const ticks = new Set([0, Math.max(0, points.length - 1)]); for (let i = 0; i < points.length; i += Math.max(1, Math.ceil(points.length / 6))) ticks.add(i);
      for (const i of ticks) { if (!points[i]) continue; const label = document.createElementNS(ns, 'text'); label.setAttribute('x', coord(0, i).split(',')[0]); label.setAttribute('y', '218'); label.setAttribute('fill', 'var(--ll-chart-label)'); label.setAttribute('font-size', '11'); label.setAttribute('text-anchor', 'middle'); label.textContent = points[i].date.slice(5).replace('-', '.'); svg.append(label); }
      const result = el('p', 'll-chart-result', '悬停查看金额，点击圆点打开当天账目', drawing);
      keyList.forEach((key, ki) => {
        let segment: string[] = []; const flush = () => { if (!segment.length) return; const line = document.createElementNS(ns, 'polyline'); line.setAttribute('points', segment.join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('stroke', ki ? 'var(--ll-blue)' : 'var(--ll-gold)'); line.setAttribute('stroke-width', '2'); svg.append(line); segment = []; };
        points.forEach((p, i) => { const value = p[key]; if (value === null) { flush(); return; } segment.push(coord(value, i)); }); flush();
        points.forEach((p, i) => {
          const value = p[key]; if (value === null) return;
          const [x, y] = coord(value, i).split(','); const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', '4'); dot.setAttribute('fill', ki ? 'var(--ll-blue)' : 'var(--ll-gold)'); dot.setAttribute('tabindex', '0'); dot.setAttribute('role', 'button'); dot.setAttribute('aria-label', `${p.date} ${{ income: '收入', expense: '净支出', daily: '长期日均', freedom: '自由天数' }[key]} ${metric === 'freedom' ? `${value} 天` : `¥${money(value)}`}${p.complete ? '' : ' 记录中'}`);
          const tip = document.createElementNS(ns, 'title'); tip.textContent = dot.getAttribute('aria-label'); dot.append(tip);
          const show = () => { result.textContent = dot.getAttribute('aria-label'); }; dot.addEventListener('mouseenter', show); dot.addEventListener('focus', show);
          const open = () => { this.selectedDay = p.date; this.month = p.date.slice(0, 7); this.accountFilter = ''; this.categoryFilter = ''; this.page = '账本'; this.render(); }; dot.addEventListener('click', open); dot.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }); svg.append(dot);
        });
      });
      if (!values.length) el('p', 'll-chart-empty ll-muted', '这个范围还没有可展示的数据。保存账目后，变化会出现在这里。', drawing);
      const legend = el('div', 'll-legend', '', drawing); el('span', 'll-gold', metric === 'flows' ? '● 收入' : metric === 'daily' ? '● 日均生活成本（元）' : '● 自由天数', legend); if (metric === 'flows') el('span', 'll-blue', '● 净支出', legend);
      el('p', 'll-muted', `${start} 至 ${cutoff < start ? end : cutoff} · ${metric === 'flows' ? '缺失日保留断点，点日期查账。' : metric === 'daily' ? '缺日时沿用最近完整基线。' : '按当前配置回算，期初余额生效前保留空白。'}`, drawing);
    };
    for (const [value, title] of [['flows', '收支'], ['daily', '日均'], ['freedom', '自由']] as const) { const choice = button(choices, title, () => { metric = value; plot(); }); choice.dataset.metric = value; } plot();
  }
  private analysis(parent: HTMLElement) {
    const today = localDate(), pageHead = el('div', 'll-page-heading', '', parent), title = el('div', '', '', pageHead);
    el('h2', '', '让日常有迹可循', title); el('p', 'll-muted', '切换曲线、点按数据点。新增账目会更新当天的数据。', title);
    const tools = el('div', 'll-toolbar', '', pageHead); input(tools, '分析月份', this.month, 'month', v => { if (validDate(`${v}-01`)) { this.month = v; this.render(); } });
    this.trendChart(parent);
    const { start, end } = this.monthBounds();
    const recent = el('div', 'll-stats ll-two-stats', '', parent);
    for (const count of [30, 90]) {
      const from = addDays(today, 1 - count); let complete = 0; for (let date = from; date <= today; date = addDays(date, 1)) if (this.state().days.get(date)?.complete) complete++;
      const living = baseline(this.state(), { ...this.config(), observationStart: from, estimateDailyCents: null }, today);
      const passive = totals(filterTransactions(this.state(), from, today)).passive;
      this.stat(recent, `近 ${count} 天`, `被动收入 ¥${money(passive)}`, `已核对 ${complete}/${count} 天；${complete === count && living.daily !== null ? `生活日均 ¥${money(living.daily)} / 被动日均 ¥${money(passive / count)}` : '区间不完整，暂不推算完整日均'}`);
    }
    const annual = totals(filterTransactions(this.state(), `${this.month.slice(0, 4)}-01-01`, `${this.month.slice(0, 4)}-12-31`));
    el('p', '', `${this.month.slice(0, 4)} 年已记录：收入 ¥${money(annual.income)}，净支出 ¥${money(annual.netExpense)}，结余 ¥${money(annual.surplus)}`, parent);
    const categories = el('section', 'll-panel ll-category-panel', '', parent); el('h2', '', '本月分类净支出', categories);
    const ts = filterTransactions(this.state(), start, end), amounts = new Map<string, number>();
    for (const t of ts) if (t.kind === 'expense' || t.kind === 'refund') amounts.set(t.categoryId ?? '', (amounts.get(t.categoryId ?? '') ?? 0) + (t.kind === 'refund' ? -t.amountCents : t.amountCents));
    const maximum = Math.max(1, ...[...amounts.values()].map(Math.abs));
    for (const [categoryId, amount] of [...amounts].sort((a, b) => b[1] - a[1])) {
      const row = button(categories, '', () => { this.categoryFilter = categoryId || '$uncategorized'; this.accountFilter = ''; this.page = '账本'; this.selectedDay = ''; this.render(); }, 'll-category-row');
      el('span', '', this.config().categories.find(c => c.id === categoryId)?.name ?? '待分类', row); const track = el('span', 'll-category-track', '', row); const fill = el('span', '', '', track); fill.style.width = `${Math.abs(amount) / maximum * 100}%`; el('span', 'll-record-amount', `¥${money(amount)}`, row);
    }
    if (!amounts.size) el('p', 'll-empty', '本月暂无支出', categories);
  }
  private accounts(parent: HTMLElement) {
    this.assetOverview(parent);
    const panel = el('section', 'll-panel ll-account-detail', '', parent), heading = el('div', 'll-section-heading', '', panel);
    const selected = this.config().accounts.find(a => a.id === this.selectedAccount);
    el('h2', '', selected ? `${selected.name} · 账户明细` : '全部账户明细', heading);
    const tools = el('div', 'll-toolbar', '', heading); if (selected) button(tools, '查看全部账户', () => { this.selectedAccount = ''; this.render(); }, 'll-ghost'); button(tools, '添加账户', () => this.accountForm(), 'll-primary');
    el('p', 'll-muted', '账户余额来自期初余额与已登记账目；转账改变分布，借款同步记录负债。', panel);
    const f = freedom(this.state(), this.config(), localDate());
    for (const account of this.config().accounts.filter(a => !selected || a.id === selected.id)) {
      const card = el('article', 'll-account-card', '', panel), accountHead = el('div', 'll-section-heading', '', card); el('h3', '', `${account.name} · ${account.kind === 'asset' ? '资产' : '负债'}`, accountHead);
      el('strong', 'll-number', `¥${money(f.balances.get(account.id) ?? 0)}`, accountHead);
      el('p', 'll-muted', `期初 ${account.openingDate} / ¥${money(account.openingCents)} · 自由计算纳入 ${account.freedomBps / 100}%${account.id === this.config().defaultAccountId ? ' · 默认收支账户' : ''}`, card);
      const adjustments = [...this.state().transactions.values()].filter(t => t.kind === 'adjustment' && t.accountId === account.id).sort((a, b) => b.date.localeCompare(a.date));
      if (adjustments.length) el('p', 'll-muted', `最近对账 ${adjustments[0].date}`, card);
      button(card, '看流水', () => { this.page = '账本'; this.accountFilter = account.id; this.categoryFilter = ''; this.selectedDay = ''; this.render(); });
      button(card, '修改账户', () => this.accountForm(account));
      if (account.kind === 'asset') button(card, '对账校准', () => this.reconcile(account));
    }
    el('p', 'll-muted', '借入与归还本金选择对应负债账户；利息单独记为支出。借出本金可转到自己建立的应收款资产账户。', panel);
    const history = el('section', 'll-panel ll-account-history', '', parent); el('h2', '', selected ? `${selected.name} · 流水` : '全部账户流水', history);
    const rows = filterTransactions(this.state(), '0001-01-01', localDate(), selected?.id);
    for (const t of [...rows].reverse().slice(0, 20)) this.recordRow(history, t);
    if (!rows.length) el('p', 'll-empty', '这个范围还没有已记录账目。', history);
    if (rows.length > 20) button(history, '按月查看历史流水', () => { this.page = '账本'; this.accountFilter = selected?.id ?? ''; this.categoryFilter = ''; this.selectedDay = ''; this.render(); }, 'll-ghost');
  }
  private accountForm(existing?: Account) {
    const d = dialog(this.overlays, existing ? '修改账户' : '添加账户');
    const account: Account = existing ? structuredClone(existing) : { id: id(), name: '', kind: 'asset', openingCents: 0, openingDate: localDate(), freedomBps: 10000, aliases: [] };
    const form = el('div', 'll-form-grid', '', d.node);
    input(form, '账户名称', account.name, 'text', v => { account.name = v; });
    const type = select(form, '账户类型', account.kind, [['asset', '资产账户'], ['liability', '负债账户']], v => { account.kind = v as 'asset' | 'liability'; });
    const amount = input(form, '期初余额（元）', decimal(account.openingCents), 'text', v => { try { account.openingCents = cents(v, true); } catch { account.openingCents = NaN; } });
    const date = input(form, '余额生效日', account.openingDate, 'date', v => { account.openingDate = v; });
    const hasTransactions = existing && [...this.state().transactions.values()].some(t => [t.accountId, t.fromAccountId, t.toAccountId, t.debtAccountId].includes(existing.id));
    if (hasTransactions) { type.disabled = true; amount.disabled = true; date.disabled = true; el('p', 'll-muted', '已有流水时保留期初锚点；余额变化请使用对账校准。', d.node); }
    input(form, '自由计算纳入比例（%）', String(account.freedomBps / 100), 'text', v => { try { account.freedomBps = cents(v); } catch { account.freedomBps = NaN; } });
    input(form, '别名（逗号分隔）', account.aliases.join('，'), 'text', v => { account.aliases = v.split(/[,，]/).map(x => x.trim()).filter(Boolean); });
    let defaultAccount = existing?.id === this.config().defaultAccountId;
    check(d.node, '设为默认收支账户（仅资产账户）', defaultAccount, v => { defaultAccount = v; });
    button(d.node, '保存账户', () => this.action(async () => {
      requireThat(account.openingDate <= localDate(), '期初余额不能设在未来');
      const c: Config = { ...this.config(), accounts: [...this.config().accounts.filter(a => a.id !== account.id), account], defaultAccountId: defaultAccount ? account.id : this.config().defaultAccountId === account.id ? null : this.config().defaultAccountId };
      await this.host.repo.saveConfig(c); d.close(); this.render();
    }), 'll-primary');
  }
  private reconcile(account: Account) {
    const d = dialog(this.overlays, `核对 ${account.name}`); const current = freedom(this.state(), this.config(), localDate()).balances.get(account.id) ?? 0;
    el('p', '', `账本余额 ¥${money(current)}。填入实际余额，差额单列为对账调整。`, d.node);
    const actual = input(d.node, '实际余额（元）', decimal(current), 'text'); const reason = input(d.node, '对账说明', '', 'text');
    button(d.node, '确认校准', () => this.action(async () => {
      const amount = cents(actual.value, true) - current; requireThat(amount !== 0, '实际余额与账本相同，无需调整'); requireThat(reason.value.trim(), '请填写差额说明');
      const batchId = id(), tx: Transaction = { id: id(), version: 1, batchId, draftId: null, rowId: null, kind: 'adjustment', date: localDate(), dateRange: null, amountCents: amount, accountId: account.id, fromAccountId: null, toAccountId: null, debtAccountId: null, categoryId: null, relatedId: null, incomeSource: 'other', note: reason.value, originalText: `实际余额 ${actual.value}`, sourceQuote: '', corrections: [] };
      const before = freedom(this.state(), this.config(), localDate()); const batch = await this.host.repo.commit([{ type: 'transaction.put', expected: 0, value: tx }], id(), '对账校准', batchId); d.close(); this.changed(before, batch.id);
    }), 'll-primary');
  }
  private costs(parent: HTMLElement) {
    const today = localDate(), pageHead = el('div', 'll-page-heading', '', parent), title = el('div', '', '', pageHead);
    el('h2', '', '每日被动流血', title); el('p', 'll-muted', '物品与服务的日成本，看看自己已经承担的持续负担。', title);
    button(pageHead, '登记已有物品 / 订阅', () => this.costForm(), 'll-primary');
    const panel = el('section', 'll-panel ll-cost-page', '', parent), summary = el('div', 'll-stats ll-two-stats', '', panel);
    const costs = [...this.state().costs.values()], daily = costs.reduce((sum, cost) => sum + costOn(cost, today).daily, 0), passive = totals(filterTransactions(this.state(), addDays(today, -29), today)).passive;
    this.stat(summary, '今天已登记的固定负担', `¥${money(daily)} / 天`).classList.add('ll-baseline'); this.stat(summary, '近 30 天已到账被动收入', `¥${money(passive)}`).classList.add('ll-income');
    for (const cost of this.state().costs.values()) {
      const on = costOn(cost, today), card = el('article', 'll-cost-card', '', panel), heading = el('div', 'll-section-heading', '', card); el('h3', '', cost.name, heading);
      el('strong', 'll-number', `¥${money(on.daily)} / 天`, heading); el('p', 'll-muted', `${cost.kind === 'device' ? '物品' : '订阅'} · ${on.status} · ${cost.start} 至 ${cost.end ?? '期限待设置'}`, card);
      el('p', 'll-muted', `已分摊 ¥${money(on.allocated)} · 未分摊 ¥${money(on.remaining)} · ${on.daysLeft === null ? '期限待设置' : `剩余 ${on.daysLeft} 天`}`, card);
      if (cost.end && on.daysLeft !== null && on.daysLeft <= 7 && on.status === '使用中') el('p', 'll-issue', '将在一周内到期，实际续费后再记新支出。', card);
      if (cost.kind === 'subscription') el('p', 'll-muted', `${cost.autoRenew ? '未来计划自动续费' : '未计划自动续费'}；不会提前入账。`, card);
      button(card, '调整期限 / 残值 / 停用', () => this.costForm(cost));
      if (cost.kind === 'subscription') button(card, '记续费支出', () => this.openDraft());
      if (cost.transactionId) button(card, '看购买记录', () => { const tx = this.state().transactions.get(cost.transactionId!); if (tx) { this.page = '账本'; this.month = tx.date.slice(0, 7); this.selectedDay = tx.date; this.accountFilter = ''; this.categoryFilter = ''; this.render(); } });
      const notes = el('details', '', '', card); el('summary', '', '调整记录', notes); for (const note of cost.adjustmentNotes) el('p', '', note, notes);
    }
    if (!this.state().costs.size) el('p', 'll-empty', '记购买款时可以一起建立成本项目，也可以登记已有物品，不重记购买支出。', panel);
    el('p', 'll-muted', '购买款只扣一次，分摊不会再扣账户现金。结束日不包含在服务期内。', panel);
  }
  private costForm(existing?: Cost) {
    const d = dialog(this.overlays, existing ? '调整成本项目' : '登记已有成本项目');
    const cost: Cost = existing ? structuredClone(existing) : { id: id(), version: 0, batchId: '', transactionId: null, name: '', kind: 'device', amountCents: 0, residualCents: 0, start: localDate(), end: null, stoppedOn: null, autoRenew: false, adjustmentNotes: [] };
    const form = el('div', 'll-form-grid', '', d.node); input(form, '名称', cost.name, 'text', v => { cost.name = v; });
    select(form, '类型', cost.kind, [['device', '物品'], ['subscription', '订阅']], v => { cost.kind = v as 'device' | 'subscription'; });
    const purchase = input(form, '实付金额（元）', decimal(cost.amountCents), 'text', v => { try { cost.amountCents = cents(v); } catch { cost.amountCents = NaN; } }); if (cost.transactionId) purchase.disabled = true;
    input(form, '预计残值（元）', decimal(cost.residualCents), 'text', v => { try { cost.residualCents = cents(v); } catch { cost.residualCents = NaN; } });
    input(form, '开始日', cost.start, 'date', v => { cost.start = v; }); input(form, '结束日（不包含）', cost.end ?? '', 'date', v => { cost.end = v || null; }); input(form, '停用日（不包含）', cost.stoppedOn ?? '', 'date', v => { cost.stoppedOn = v || null; });
    check(d.node, '未来计划自动续费', cost.autoRenew, v => { cost.autoRenew = v; });
    if (!existing) select(d.node, '关联已有购买（可不选）', cost.transactionId ?? '', [['', '仅登记成本，不新增现金交易'], ...[...this.state().transactions.values()].filter(t => t.kind === 'expense' && ![...this.state().costs.values()].some(c => c.transactionId === t.id)).map(t => [t.id, `${t.date} ${t.note} ${money(t.amountCents)}`] as [string, string])], v => { cost.transactionId = v || null; if (v) { cost.amountCents = this.state().transactions.get(v)!.amountCents; purchase.value = decimal(cost.amountCents); purchase.disabled = true; } else purchase.disabled = false; });
    const explanation = input(d.node, '调整说明', '', 'text');
    button(d.node, '保存项目', () => this.action(async () => {
      if (existing) requireThat(explanation.value.trim(), '请填写调整说明，保留历史');
      const batchId = id(); cost.version = (existing?.version ?? 0) + 1; cost.batchId = batchId;
      cost.adjustmentNotes = [...(existing?.adjustmentNotes ?? []), `${new Date().toISOString()} ${explanation.value || '登记已有项目'}；${JSON.stringify(existing ?? {})} → ${JSON.stringify({ start: cost.start, end: cost.end, stoppedOn: cost.stoppedOn, residualCents: cost.residualCents })}`];
      await this.host.repo.commit([{ type: 'cost.put', expected: existing?.version ?? 0, value: cost }], id(), existing ? '调整成本项目' : '登记已有物品成本', batchId); d.close(); this.render();
    }), 'll-primary');
  }
  export() { this.action(async () => { await this.host.repo.load(); download(`LifeLedger-${localDate()}.json`, JSON.stringify(this.host.repo.exportBackup(), null, 2), 'application/json'); }); }
  private renderPending() {
    const target = this.shell.querySelector<HTMLElement>('.ll-pending-drafts'); if (!target) return;
    const wasOpen = target.querySelector('details')?.open; target.replaceChildren();
    const pending = this.host.repo.drafts.filter(d => d.id !== this.homeDraft?.id && d.status !== 'saved' && (d.text.trim() || d.rows.length));
    if (pending.length) {
      const details = el('details', 'll-drafts-drawer', '', target); details.open = wasOpen ?? pending.length <= 2;
      el('summary', '', `待处理草稿（${pending.length}）`, details);
      for (const draft of pending) {
        const row = el('div', 'll-pending-row', '', details);
        button(row, `继续草稿：${draft.text.slice(0, 28) || '手动记录'}`, () => this.openDraft(draft.id));
        button(row, '丢弃草稿', () => this.action(async () => { await this.host.repo.discardDraft(draft); this.renderPending(); this.host.notice('草稿已按 Obsidian 的删除偏好移入回收站，已保存账目保留'); }), 'll-ghost');
      }
    }
  }
  private signature() { return JSON.stringify({ config: this.config(), batches: this.state().batches.map(b => b.checksum), issues: this.state().issues }); }
  async reload(onlyIfChanged = false) { await this.host.repo.load(); if (!onlyIfChanged || this.signature() !== this.renderedSignature) this.render(); else this.renderPending(); }
  async destroy() { this.stage?.destroy(); this.root.replaceChildren(); await this.flushPending(); await this.editor?.destroy(); }
}
