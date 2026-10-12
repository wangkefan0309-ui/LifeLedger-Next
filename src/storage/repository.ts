import { applyEvents, checkBatch, replay, requireThat, sealBatch, undoEvents, validateConfig, validateTransaction, validateCost } from '../core/ledger';
import { defaultConfig, localDate, sha256 } from '../core/primitives';
import { emptyState, type Batch, type Config, type Draft, type LedgerEvent, type LedgerState } from '../core/types';

export interface FileIO {
  list(prefix: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  create(path: string, text: string): Promise<void>;
  process(path: string, update: (text: string) => string): Promise<void>;
  trash?(path: string): Promise<void>;
}
const blockPattern = /```lifeledger-json\r?\n([\s\S]*?)\r?\n```/g;
export function structuredBlock(text: string): unknown {
  const blocks = [...text.matchAll(blockPattern)];
  requireThat(blocks.length === 1, '文件必须包含唯一且完整的 lifeledger-json 数据块');
  return JSON.parse(blocks[0][1]);
}
export function documentFor(title: string, body: unknown, summary = ''): string {
  return `# ${title}\n\n${summary}\n\n结构化数据由 LifeLedger 维护；个人笔记可写在数据块之外。\n\n\`\`\`lifeledger-json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}
export function replaceBlock(text: string, value: unknown): string {
  structuredBlock(text);
  return text.replace(blockPattern, () => `\`\`\`lifeledger-json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
}
export function validRoot(root: string): string {
  requireThat(typeof root === 'string', '数据目录请使用 Vault 内普通文件夹路径');
  const path = root.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  requireThat(path && !/^[\/]|[:*?"<>|\x00-\x1f]/.test(path) && !path.split('/').some(s =>
    !s || s.startsWith('.') || /[. ]$/.test(s) || s !== s.trim() || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)),
  '数据目录须为 Vault 内普通文件夹，不能包含隐藏目录、路径跳转或系统保留名称');
  return path;
}
export interface Backup { version: 1; exportedAt: string; config: Config; batches: Batch[]; drafts: Draft[]; checksum: string }
export function validateDraft(value: unknown): asserts value is Draft {
  const d = value as Draft;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
  requireThat(d && typeof d === 'object' && d.version === 1 && typeof d.id === 'string' && /^[\w-]+$/.test(d.id) && Number.isInteger(d.revision) && d.revision >= 0 &&
    typeof d.text === 'string' && (d.textHistory === undefined || strings(d.textHistory)) && typeof d.submittedDate === 'string' && typeof d.timezone === 'string' &&
    typeof d.error === 'string' && typeof d.requestId === 'string' && ['editing', 'requesting', 'failed', 'review', 'saved'].includes(d.status) &&
    (d.origin === undefined || ['home', 'editor'].includes(d.origin)) && strings(d.completeDates) && Array.isArray(d.excluded) &&
    d.excluded.every(e => e && typeof e.source_quote === 'string' && typeof e.reason === 'string') && Array.isArray(d.rows) &&
    d.rows.every(r => r && typeof r.id === 'string' && ['income', 'expense', 'transfer', 'refund', 'borrow', 'repayment', 'lend', 'collect', 'adjustment', 'unknown'].includes(r.kind) &&
      ['date', 'amount', 'accountId', 'fromAccountId', 'toAccountId', 'debtAccountId', 'categoryId', 'relatedId', 'note', 'sourceQuote', 'amountQuote'].every(k => typeof r[k as keyof typeof r] === 'string') &&
      ['active', 'passive', 'other'].includes(r.incomeSource) && strings(r.issues) && ['reviewed', 'edited', 'usedDefault'].every(k => typeof r[k as keyof typeof r] === 'boolean') &&
      (r.dateRange === null || (r.dateRange && typeof r.dateRange.start === 'string' && typeof r.dateRange.end === 'string')) &&
      (r.cost === null || (r.cost && typeof r.cost.name === 'string' && ['device', 'subscription'].includes(r.cost.kind) && typeof r.cost.start === 'string' && typeof r.cost.end === 'string' && typeof r.cost.residual === 'string' && typeof r.cost.autoRenew === 'boolean'))) &&
    (d.usage === null || (d.usage && Number.isInteger(d.usage.input) && d.usage.input >= 0 && Number.isInteger(d.usage.output) && d.usage.output >= 0)), '草稿格式错误');
  d.textHistory ??= [];
}
export class Repository {
  config: Config = defaultConfig(); state: LedgerState = emptyState(); drafts: Draft[] = [];
  private configFingerprint = ''; private queue: Promise<unknown> = Promise.resolve();
  readonly root: string;
  constructor(private io: FileIO, root: string, private today = () => localDate()) { this.root = validRoot(root); }
  async settled() { await this.queue; }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn); this.queue = run.catch(() => undefined); return run;
  }
  async load(): Promise<void> {
    const configText = await this.io.read(`${this.root}/配置.md`);
    const issues: LedgerState['issues'] = [];
    if (configText !== null) {
      try { const c = structuredBlock(configText) as Config; validateConfig(c); this.config = c; this.configFingerprint = sha256(JSON.stringify(c)); }
      catch (error) { issues.push({ path: `${this.root}/配置.md`, message: (error as Error).message }); }
    } else { this.config = defaultConfig(this.today()); this.configFingerprint = ''; }
    const files: { path: string; batch: Batch }[] = [];
    for (const path of (await this.io.list(`${this.root}/账本/`)).filter(p => p.endsWith('.md'))) {
      try { files.push({ path, batch: structuredBlock((await this.io.read(path)) ?? '') as Batch }); }
      catch (error) { issues.push({ path, message: (error as Error).message }); }
    }
    if (files.length && !configText) issues.push({ path: `${this.root}/配置.md`, message: '账本存在但配置缺失，请恢复配置文件' });
    this.state = replay(files, this.config, this.today()); this.state.issues.push(...issues);
    this.drafts = [];
    for (const path of (await this.io.list(`${this.root}/草稿/`)).filter(p => p.endsWith('.md'))) {
      try {
        const d = structuredBlock((await this.io.read(path)) ?? '') as Draft;
        validateDraft(d);
        const savedRows = new Set([...this.state.transactions.values()].filter(t => t.draftId === d.id).map(t => t.rowId));
        d.rows = d.rows.filter(r => !savedRows.has(r.id));
        if (savedRows.size && d.rows.length === 0) d.status = 'saved';
        this.drafts.push(d);
      } catch (error) { this.state.issues.push({ path, kind: 'draft', message: `草稿保留待恢复：${(error as Error).message}` }); }
    }
  }
  async saveConfig(config: Config, expectedFingerprint?: string): Promise<void> {
    return this.locked(async () => {
      if (expectedFingerprint !== undefined) requireThat(this.configFingerprint === expectedFingerprint, '配置已在其他窗口变更，请重开设置后再保存');
      validateConfig(config);
      for (const tx of this.state.transactions.values()) validateTransaction(tx, config, this.state, this.today());
      for (const cost of this.state.costs.values()) validateCost(cost, config, this.state);
      const expected = this.configFingerprint;
      const path = `${this.root}/配置.md`, existing = await this.io.read(path);
      if (existing !== null) {
        await this.io.process(path, text => {
          requireThat(sha256(JSON.stringify(structuredBlock(text))) === expected, '配置被外部修改，请重新打开后修改');
          return replaceBlock(text, config);
        });
      } else { requireThat(expected === '', '配置文件被删除，请先恢复'); await this.io.create(path, documentFor('LifeLedger 配置', config)); }
      this.config = config; this.configFingerprint = sha256(JSON.stringify(config));
    });
  }
  async saveDraft(draft: Draft): Promise<void> {
    return this.locked(async () => {
      validateDraft(draft);
      const path = `${this.root}/草稿/${draft.id}.md`;
      const value = { ...draft, revision: draft.revision + 1 };
      const current = await this.io.read(path);
      if (current === null) await this.io.create(path, documentFor('待核对草稿', value, '原文和手工修正都保留在结构化块中。'));
      else await this.io.process(path, text => {
        const old = structuredBlock(text) as Draft;
        requireThat(old.id === draft.id && old.revision === draft.revision, '草稿被另一处修改，请先恢复最新草稿');
        return replaceBlock(text, value);
      });
      draft.revision = value.revision;
      this.drafts = [draft, ...this.drafts.filter(x => x.id !== draft.id)];
    });
  }
  async discardDraft(draft: Draft) {
    return this.locked(async () => {
      validateDraft(draft); requireThat(this.io.trash, '当前存储不支持回收站');
      const path = `${this.root}/草稿/${draft.id}.md`, text = await this.io.read(path);
      requireThat(text !== null, '草稿已经移走，请重新读取'); const current = structuredBlock(text); validateDraft(current);
      requireThat(current.id === draft.id && current.revision === draft.revision, '草稿被另一处修改，请先打开最新草稿');
      await this.io.trash(path); this.drafts = this.drafts.filter(d => d.id !== draft.id);
    });
  }
  async commit(events: LedgerEvent[], requestId: string, reason: string, batchId?: string): Promise<Batch> {
    return this.locked(async () => {
      await this.load();
      const already = this.state.batches.find(b => b.requestId === requestId); if (already) return already;
      requireThat(this.state.issues.every(issue => issue.kind === 'draft'), '有未恢复的账本文件或冲突，请先处理提示；账本未改动');
      const touchedDays = new Set<string>();
      for (const event of events) {
        if (event.type === 'transaction.put' || event.type === 'transaction.delete') {
          const old = this.state.transactions.get(event.type === 'transaction.put' ? event.value.id : event.id);
          if (old && ['income', 'expense', 'refund'].includes(old.kind)) touchedDays.add(old.date);
          if (event.type === 'transaction.put' && ['income', 'expense', 'refund'].includes(event.value.kind)) touchedDays.add(event.value.date);
        }
      }
      const explicit = new Set(events.filter((e): e is Extract<LedgerEvent, { type: 'day.set' }> => e.type === 'day.set').map(e => e.date));
      events = [...events];
      for (const date of touchedDays) if (this.state.days.get(date)?.complete && !explicit.has(date)) events.push({ type: 'day.set', date, complete: false, expected: this.state.days.get(date)!.version });
      const next = applyEvents(this.state, events, this.config, this.today());
      const batch = sealBatch(events, requestId, reason, this.state.batches.at(-1)?.id ?? null, batchId);
      const path = `${this.root}/账本/${this.today().slice(0, 7)}/${batch.id}.md`;
      if (!this.configFingerprint) {
        await this.io.create(`${this.root}/配置.md`, documentFor('LifeLedger 配置', this.config));
        this.configFingerprint = sha256(JSON.stringify(this.config));
      }
      const summary = `${batch.createdAt} · ${reason}\n\n${events.map(e => e.type === 'transaction.put' ? `- ${e.value.date} ${e.value.kind} ${(e.value.amountCents / 100).toFixed(2)} 元 ${e.value.note.replace(/[\r\n]/g, ' ')}` : `- ${e.type}`).join('\n')}`;
      try { await this.io.create(path, documentFor(`记账批次 ${batch.id}`, batch, summary)); }
      catch (error) {
        const existing = await this.io.read(path);
        if (!existing || JSON.stringify(structuredBlock(existing)) !== JSON.stringify(batch)) throw error;
      }
      // Read back before exposing the state; interrupted or corrupt writes stay out of statistics.
      const readBack = structuredBlock((await this.io.read(path)) ?? '') as Batch; checkBatch(readBack);
      requireThat(readBack.checksum === batch.checksum, '保存校验失败，批次未进入统计');
      next.batches.push(batch); this.state = next; return batch;
    });
  }
  async undo(batchId: string): Promise<Batch> {
    await this.load(); const batch = this.state.batches.find(b => b.id === batchId); requireThat(batch, '找不到批次');
    return this.commit(undoEvents(batch, this.state, this.config), `undo-${batchId}`, `撤销 ${batchId}`);
  }
  exportBackup(): Backup {
    requireThat(this.state.issues.length === 0, '请先处理账本错误，再导出完整备份');
    const body = { version: 1 as const, exportedAt: new Date().toISOString(), config: this.config, batches: this.state.batches, drafts: this.drafts };
    return { ...body, checksum: sha256(JSON.stringify(body)) };
  }
  async restoreBackup(value: unknown): Promise<void> {
    const backup = value as Backup; const { checksum, ...body } = backup;
    requireThat(backup.version === 1 && sha256(JSON.stringify(body)) === checksum && Array.isArray(backup.batches) && Array.isArray(backup.drafts), '备份格式或校验错误');
    validateConfig(backup.config);
    try { backup.drafts.forEach(validateDraft); } catch { throw new Error('备份内草稿格式错误，未恢复'); }
    const restored = replay(backup.batches.map(batch => ({ path: batch.id, batch })), backup.config, this.today());
    requireThat(restored.issues.length === 0, '备份内账本无效，未恢复');
    await this.load(); requireThat(this.state.batches.length === 0 && this.state.issues.length === 0 && !this.configFingerprint && this.drafts.length === 0 && (await this.io.list(`${this.root}/`)).length === 0, '恢复目标必须为空账本目录（没有配置、账户、草稿或其他文件）；请先在设置中换一个空数据目录');
    // One self-contained recovery batch prevents a half-imported ledger from entering statistics.
    await this.saveConfig(backup.config);
    if (backup.batches.length) await this.commit(backup.batches.flatMap(b => b.events), `restore-${checksum}`, '从已校验备份恢复');
    for (const draft of backup.drafts) {
      requireThat(draft && typeof draft.id === 'string' && /^[\w-]+$/.test(draft.id), '备份草稿 ID 错误');
      const copy = { ...draft, revision: 0 }; await this.saveDraft(copy);
    }
    await this.load();
  }
}
