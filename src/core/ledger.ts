import { daysBetween, id, localDate, sha256, validDate } from './primitives';
import { emptyState, type Batch, type Config, type Cost, type LedgerEvent, type LedgerState, type Transaction } from './types';
import { accountCurrency, baseAmount, convertMoney, isCurrency, transactionCurrency, validateRates, validateValuation } from './currency';

export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const safeMoney = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && Math.abs(n) <= 1_000_000_000_000;
export function validateConfig(c: Config): void {
  requireThat(c && c.version === 1 && Array.isArray(c.accounts) && Array.isArray(c.categories), '配置格式或版本错误');
  const ids = new Set<string>(); const names = new Set<string>();
  requireThat(c.exchangeRates === undefined || validateRates(c.exchangeRates), '汇率缓存格式、日期或数值错误');
  requireThat(c.homeSlogan === undefined || (typeof c.homeSlogan === 'string' && c.homeSlogan.length <= 120 && !/[\u0000-\u001f\u007f]/.test(c.homeSlogan)), '首页标语最多 120 字，且不能包含换行或控制字符');
  requireThat(c.theme === undefined || ['system', 'light', 'dark'].includes(c.theme), '页面外观须为跟随系统、浅色或深色');
  for (const a of c.accounts) {
    requireThat(a && typeof a.id === 'string' && a.id.length > 0 && !ids.has(a.id), '账户 ID 重复或缺失'); ids.add(a.id);
    requireThat(typeof a.name === 'string' && a.name.trim() && ['asset', 'liability'].includes(a.kind), '账户名称或类型错误');
    requireThat(safeMoney(a.openingCents) && validDate(a.openingDate), '账户期初余额或生效日期错误');
    requireThat(a.currency === undefined || isCurrency(a.currency), '账户币种仅支持人民币、美元和港币');
    requireThat(a.displayCurrency === undefined || a.displayCurrency === null || isCurrency(a.displayCurrency), '账户折算币种错误');
    convertMoney(a.openingCents, accountCurrency(a), 'CNY', c);
    requireThat(a.kind !== 'liability' || a.openingCents >= 0, '期初负债不能为负');
    requireThat(Number.isInteger(a.freedomBps) && a.freedomBps >= 0 && a.freedomBps <= 10000, '可用比例必须在 0 到 100%');
    requireThat(Array.isArray(a.aliases) && a.aliases.every(x => typeof x === 'string' && x.trim()), '账户别名错误');
    for (const name of [a.name, ...a.aliases]) { requireThat(!names.has(name.trim()), `账户名称或别名重复：${name}`); names.add(name.trim()); }
  }
  if (c.reconciliations !== undefined) {
    requireThat(Array.isArray(c.reconciliations) && c.reconciliations.length <= 10000, '对账记录格式错误');
    const receipts = new Set<string>();
    for (const r of c.reconciliations) {
      const account = c.accounts.find(a => a.id === r?.accountId && a.kind === 'asset'), key = `${r?.accountId}/${r?.date}`;
      requireThat(r && account && !receipts.has(key) && validDate(r.start) && validDate(r.date) && r.start >= account.openingDate && r.start <= r.date && r.date <= localDate() && safeMoney(r.actualCents) && /^[a-f0-9]{64}$/.test(r.fingerprint) && ['balance', 'statement'].includes(r.scope) && typeof r.checkedAt === 'string' && Number.isFinite(Date.parse(r.checkedAt)), '对账记录账户、日期或校验值错误');
      receipts.add(key);
    }
  }
  ids.clear();
  for (const c2 of c.categories) {
    requireThat(c2 && typeof c2.id === 'string' && c2.id && !ids.has(c2.id), '分类 ID 重复或缺失'); ids.add(c2.id);
    requireThat(typeof c2.name === 'string' && c2.name.trim() && ['income', 'expense'].includes(c2.kind) && typeof c2.living === 'boolean', '分类格式错误');
  }
  requireThat(c.defaultAccountId === null || c.accounts.some(a => a.id === c.defaultAccountId && a.kind === 'asset'), '默认账户不存在或不是资产账户');
  requireThat(validDate(c.observationStart) && validDate(c.displayEnd) && (c.birthDate === null || validDate(c.birthDate)), '观察起点或展示日期错误');
  requireThat(c.estimateDailyCents === null || (safeMoney(c.estimateDailyCents) && c.estimateDailyCents > 0), '暂估日均必须大于零');
  requireThat(safeMoney(c.reservedCents) && c.reservedCents >= 0, '预留金额错误');
  requireThat(['full', 'short', 'off'].includes(c.animation) && typeof c.sound === 'boolean' && typeof c.showPast === 'boolean', '展示设置错误');
}
export function validateTransaction(t: Transaction, config: Config, state: LedgerState, today = localDate()): void {
  requireThat(t && typeof t.id === 'string' && t.id && Number.isInteger(t.version) && t.version > 0, '交易 ID 或版本错误');
  requireThat(typeof t.batchId === 'string' && t.batchId && (t.draftId === null || typeof t.draftId === 'string') && (t.rowId === null || typeof t.rowId === 'string'), '交易来源 ID 错误');
  requireThat(['income', 'expense', 'transfer', 'refund', 'borrow', 'repayment', 'lend', 'collect', 'adjustment'].includes(t.kind), '交易类型错误');
  requireThat(validDate(t.date) && t.date <= today, '实际账目日期无效或在未来');
  requireThat(t.dateRange === null || (validDate(t.dateRange.start) && validDate(t.dateRange.end) && t.dateRange.start <= t.dateRange.end && t.dateRange.end === t.date), '日期区间错误');
  requireThat(t.dateRange === null || ['income', 'expense'].includes(t.kind), '该交易类型不支持区间汇总');
  requireThat(safeMoney(t.amountCents) && (t.kind === 'adjustment' ? t.amountCents !== 0 : t.amountCents > 0), '金额必须为整数分且大于零；对账调整可为负');
  requireThat(typeof t.note === 'string' && typeof t.sourceQuote === 'string' && typeof t.originalText === 'string' && Array.isArray(t.corrections) && t.corrections.every(x => typeof x === 'string'), '交易备注或原文格式错误');
  requireThat(['active', 'passive', 'other'].includes(t.incomeSource), '收入来源错误');
  requireThat(t.valuation === undefined || validateValuation(t.valuation), '交易汇率快照错误');
  baseAmount(t);
  const account = (aid: string | null, kind: 'asset' | 'liability') => {
    const a = config.accounts.find(x => x.id === aid); requireThat(a && a.kind === kind, `请明确${kind === 'asset' ? '资产' : '负债'}账户`); return a;
  };
  if (['transfer', 'lend', 'collect'].includes(t.kind)) {
    const from = account(t.fromAccountId, 'asset'), to = account(t.toAccountId, 'asset');
    requireThat(transactionCurrency(t) === accountCurrency(from), '转出金额币种与账户不一致');
    if (accountCurrency(from) !== accountCurrency(to)) {
      requireThat(t.kind === 'transfer' && t.exchange && safeMoney(t.exchange.receivedCents) && t.exchange.receivedCents > 0 && validateValuation(t.exchange.valuation) && t.exchange.valuation.currency === accountCurrency(to), '跨币种转账须核对实际到账金额及币种；借出和收回本金暂须同币种');
      baseAmount({ ...t, amountCents: t.exchange.receivedCents, valuation: t.exchange.valuation });
    } else requireThat(t.exchange === undefined, '同币种转账不能带第二笔不同到账金额');
    requireThat(t.fromAccountId !== t.toAccountId, '转入和转出不能是同一账户');
    requireThat(t.accountId === null && t.debtAccountId === null && t.categoryId === null && t.relatedId === null, '转账不能同时指定收支账户、分类或退款关联');
  } else {
    const asset = account(t.accountId, 'asset');
    requireThat(transactionCurrency(t) === accountCurrency(asset), '交易金额币种与账户不一致');
    requireThat(t.exchange === undefined, '普通收支不能带换汇到账金额');
    requireThat(t.fromAccountId === null && t.toAccountId === null, '普通账目不能带转账两端');
    if (t.kind === 'borrow' || t.kind === 'repayment') requireThat(accountCurrency(account(t.debtAccountId, 'liability')) === accountCurrency(asset), '借还本金的资产与负债账户须使用相同币种');
    else requireThat(t.debtAccountId === null, '普通账目不能带负债账户');
    if (t.categoryId !== null) {
      const category = config.categories.find(c => c.id === t.categoryId);
      requireThat(category && category.kind === (t.kind === 'income' ? 'income' : 'expense'), '分类不存在或收支类型不匹配');
      requireThat(['income', 'expense', 'refund'].includes(t.kind), '借还本金及对账调整不能归入收入支出分类');
    }
    if (t.kind === 'refund' && t.relatedId !== null) {
      const original = state.transactions.get(t.relatedId);
      requireThat(original && original.kind === 'expense' && original.date <= t.date, '退款关联必须是已发生的支出');
      requireThat(transactionCurrency(original) === transactionCurrency(t), '关联退款币种须与原消费相同');
      requireThat(original.categoryId === t.categoryId, '退款分类必须与原消费一致');
      const already = [...state.transactions.values()].filter(x => x.id !== t.id && x.kind === 'refund' && x.relatedId === t.relatedId).reduce((s, x) => s + x.amountCents, 0);
      requireThat(already + t.amountCents <= original.amountCents, '累计退款超过原消费金额');
    } else requireThat(t.relatedId === null, '只有退款可关联原消费');
  }
  if (t.draftId && t.rowId) requireThat(![...state.transactions.values()].some(x => x.id !== t.id && x.draftId === t.draftId && x.rowId === t.rowId), '这条草稿已经保存过');
}
export function validateCost(c: Cost, config: Config, state: LedgerState): void {
  requireThat(c && typeof c.id === 'string' && c.id && typeof c.name === 'string' && c.name.trim() && Number.isInteger(c.version) && c.version > 0 && typeof c.batchId === 'string', '成本项目格式错误');
  requireThat(['device', 'subscription'].includes(c.kind) && safeMoney(c.amountCents) && c.amountCents > 0 && safeMoney(c.residualCents) && c.residualCents >= 0 && c.residualCents <= c.amountCents, '成本金额或残值错误');
  requireThat(validDate(c.start) && (c.end === null || (validDate(c.end) && c.end > c.start && daysBetween(c.start, c.end) <= 73050)), '使用期限错误');
  requireThat(c.stoppedOn === null || (validDate(c.stoppedOn) && c.stoppedOn >= c.start), '停用日期错误');
  requireThat(typeof c.autoRenew === 'boolean' && Array.isArray(c.adjustmentNotes) && c.adjustmentNotes.every(x => typeof x === 'string'), '成本历史格式错误');
  if (c.transactionId !== null) {
    const tx = state.transactions.get(c.transactionId);
    requireThat(tx && tx.kind === 'expense' && baseAmount(tx) === c.amountCents, '关联购买不存在，或人民币成本金额与购买款折算不同');
    requireThat(![...state.costs.values()].some(x => x.id !== c.id && x.transactionId === c.transactionId), '这笔购买已经有成本项目');
  }
  if (c.kind === 'subscription' && c.end && !c.stoppedOn) requireThat(![...state.costs.values()].some(x => x.id !== c.id && x.kind === 'subscription' && x.name === c.name && x.end && !x.stoppedOn && x.start < c.end! && x.end > c.start), '同名订阅服务期重叠，请核对续费开始日');
}
function copyState(s: LedgerState): LedgerState {
  return { transactions: new Map(s.transactions), costs: new Map(s.costs), txVersions: new Map(s.txVersions), costVersions: new Map(s.costVersions), days: new Map(s.days), batches: [...s.batches], issues: [...s.issues] };
}
export function applyEvents(state: LedgerState, events: LedgerEvent[], config: Config, today = localDate()): LedgerState {
  requireThat(Array.isArray(events) && events.length > 0 && events.length <= 100000, '批次事件为空或数量超限');
  const next = copyState(state);
  for (const e of events) {
    requireThat(e && typeof e.type === 'string' && Number.isInteger(e.expected) && e.expected >= 0, '事件格式错误');
    if (e.type === 'transaction.put') {
      requireThat((next.txVersions.get(e.value.id) ?? 0) === e.expected && e.value.version === e.expected + 1, `交易 ${e.value.id} 存在并行更正或版本冲突`);
      validateTransaction(e.value, config, next, today); next.transactions.set(e.value.id, e.value); next.txVersions.set(e.value.id, e.value.version);
    } else if (e.type === 'transaction.delete') {
      requireThat(next.transactions.has(e.id) && next.txVersions.get(e.id) === e.expected, '删除交易版本冲突');
      next.transactions.delete(e.id); next.txVersions.set(e.id, e.expected + 1);
    } else if (e.type === 'cost.put') {
      requireThat((next.costVersions.get(e.value.id) ?? 0) === e.expected && e.value.version === e.expected + 1, '成本项目存在并行更正或版本冲突');
      next.costs.set(e.value.id, e.value); next.costVersions.set(e.value.id, e.value.version);
    } else if (e.type === 'cost.delete') {
      requireThat(next.costs.has(e.id) && next.costVersions.get(e.id) === e.expected, '删除成本项目版本冲突');
      next.costs.delete(e.id); next.costVersions.set(e.id, e.expected + 1);
    } else if (e.type === 'day.set') {
      requireThat(validDate(e.date) && e.date <= today && typeof e.complete === 'boolean', '实际完整度不能确认未来日期');
      requireThat((next.days.get(e.date)?.version ?? 0) === e.expected, '当天核对状态存在并行修改');
      if (e.complete) requireThat(![...next.transactions.values()].some(t => t.dateRange && t.dateRange.start <= e.date && t.dateRange.end >= e.date), '区间汇总无法证明逐日完整，需先补齐逐日明细');
      next.days.set(e.date, { complete: e.complete, version: e.expected + 1 });
    } else throw new Error('未知事件类型');
  }
  // Check final state so a transaction and its related project can be corrected atomically.
  for (const tx of next.transactions.values()) validateTransaction(tx, config, next, today);
  requireThat(Number.isSafeInteger([...next.transactions.values()].reduce((sum, t) => sum + Math.abs(t.amountCents) + (t.exchange?.receivedCents ?? 0), config.accounts.reduce((sum, a) => sum + Math.abs(a.openingCents), 0))), '累计金额超出安全整数范围，批次未保存');
  for (const cost of next.costs.values()) validateCost(cost, config, next);
  for (const a of config.accounts.filter(x => x.kind === 'liability')) {
    let amount = a.openingCents;
    for (const t of [...next.transactions.values()].filter(x => x.debtAccountId === a.id && x.date >= a.openingDate).sort((x, y) => x.date.localeCompare(y.date))) {
      amount += t.kind === 'borrow' ? t.amountCents : -t.amountCents;
      requireThat(amount >= 0, `${a.name} 归还本金超过未偿还负债`);
    }
  }
  return next;
}
export function sealBatch(events: LedgerEvent[], requestId: string, reason: string, parentId: string | null, batchId = id()): Batch {
  const body = { version: 1 as const, id: batchId, createdAt: new Date().toISOString(), requestId, reason, parentId, events };
  return { ...body, checksum: sha256(JSON.stringify(body)) };
}
export function checkBatch(batch: Batch): void {
  requireThat(batch && batch.version === 1 && typeof batch.id === 'string' && /^[\w-]+$/.test(batch.id), '批次 ID 或版本错误');
  requireThat(typeof batch.requestId === 'string' && batch.requestId && typeof batch.reason === 'string' && typeof batch.createdAt === 'string' && Number.isFinite(Date.parse(batch.createdAt)), '批次元数据错误');
  requireThat(batch.parentId === null || typeof batch.parentId === 'string', '批次父引用错误');
  const { checksum, ...body } = batch;
  requireThat(typeof checksum === 'string' && sha256(JSON.stringify(body)) === checksum, '数据块校验不符；文件保留，未计入统计');
}
export function replay(files: { path: string; batch: Batch }[], config: Config, today = localDate()): LedgerState {
  let state = emptyState();
  const validFiles = files.filter(file => { try { checkBatch(file.batch); return true; } catch (e) { state.issues.push({ path: file.path, message: (e as Error).message }); return false; } });
  const pending = validFiles.sort((a, b) => a.batch.createdAt.localeCompare(b.batch.createdAt) || a.batch.id.localeCompare(b.batch.id));
  const accepted = new Map<string, string>(); const requests = new Set<string>();
  while (pending.length) {
    let progressed = false;
    for (let i = 0; i < pending.length;) {
      const file = pending[i];
      if (file.batch.parentId && !accepted.has(file.batch.parentId)) { i++; continue; }
      pending.splice(i, 1); progressed = true;
      try {
        checkBatch(file.batch);
        if (accepted.has(file.batch.id)) { requireThat(accepted.get(file.batch.id) === file.batch.checksum, '同一批次 ID 存在不同内容'); continue; }
        requireThat(!requests.has(file.batch.requestId), '保存请求 ID 重复且内容不同');
        const next = applyEvents(state, file.batch.events, config, today);
        next.batches.push(file.batch); state = next; accepted.set(file.batch.id, file.batch.checksum); requests.add(file.batch.requestId);
      } catch (error) { state.issues.push({ path: file.path, message: String((error as Error).message) }); }
    }
    if (!progressed) { for (const f of pending) state.issues.push({ path: f.path, message: '父批次缺失、无效或引用成环，暂未计入' }); break; }
  }
  return state;
}
export function undoEvents(batch: Batch, state: LedgerState, config: Config): LedgerEvent[] {
  const index = state.batches.findIndex(b => b.id === batch.id); requireThat(index >= 0, '批次不存在');
  const before = replay(state.batches.slice(0, index).map(b => ({ path: b.id, batch: b })), config);
  const inverse: LedgerEvent[] = [];
  for (const e of [...batch.events].reverse()) {
    if (e.type === 'transaction.put' || e.type === 'transaction.delete') {
      const tid = e.type === 'transaction.put' ? e.value.id : e.id;
      const written = e.type === 'transaction.put' ? e.value.version : e.expected + 1;
      requireThat(state.txVersions.get(tid) === written, '该批交易后来已有更正，请在账本逐笔处理');
      const previous = before.transactions.get(tid);
      inverse.push(previous ? { type: 'transaction.put', expected: written, value: { ...previous, version: written + 1, corrections: [...previous.corrections, `撤销 ${batch.id}`] } } : { type: 'transaction.delete', expected: written, id: tid });
    } else if (e.type === 'cost.put' || e.type === 'cost.delete') {
      const cid = e.type === 'cost.put' ? e.value.id : e.id; const written = e.type === 'cost.put' ? e.value.version : e.expected + 1;
      requireThat(state.costVersions.get(cid) === written, '该成本项目后来已有更正，请单独处理');
      const previous = before.costs.get(cid);
      inverse.push(previous ? { type: 'cost.put', expected: written, value: { ...previous, version: written + 1 } } : { type: 'cost.delete', expected: written, id: cid });
    } else {
      const written = e.expected + 1;
      // Independently confirming a day after a save is preserved when undoing that save.
      if (state.days.get(e.date)?.version === written) inverse.push({ type: 'day.set', date: e.date, complete: before.days.get(e.date)?.complete ?? false, expected: written });
    }
  }
  return inverse;
}
