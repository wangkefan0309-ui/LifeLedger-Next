import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Extractor, parseScreenshots } from '../src/api/extractor';
import { inlineScreenshot, validateScreenshots, MAX_IMAGE_BYTES, type ScreenshotOptions } from '../src/api/screenshot-input';
import { imageQuotedCents } from '../src/core/image-evidence';
import { draftEvents, newDraft, rowIssues } from '../src/core/drafts';
import { emptyState } from '../src/core/types';
import { applyEvents } from '../src/core/ledger';
import { balances } from '../src/core/calculations';
import { Repository, validateDraft } from '../src/storage/repository';
import { apiEntry, config, MemoryIO, TODAY } from './fixtures';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=', 'base64');
const images = () => [inlineScreenshot('image-test-1', png, 'activity')];
const options: ScreenshotOptions = { date: TODAY, onlySelectedDate: true, onlyExpenses: true };
function entry(patch: Record<string, unknown> = {}) { return apiEntry({ date: null, amount: '20.00', source_quote: '零钱支出 -20.00', amount_quote: '-20.00', note: '零钱支出', category_id: null, received_amount: null, received_amount_quote: null, ...patch }); }
function response(entries = [entry()], text = '零钱支出 -20.00') { return { version: 1, images: [{ image_index: 1, text, entries, excluded: [] }] }; }
const settings = { baseUrl: 'https://example.test', model: 'synthetic-vision', secretId: 'test' };

test('截图编码按实际格式识别，限制数量和大小，不接受SVG或伪MIME', () => {
  assert.equal(images()[0].dataUrl.startsWith('data:image/png;base64,'), true); validateScreenshots(images());
  assert.throws(() => inlineScreenshot('x', new TextEncoder().encode('<svg/>')));
  assert.throws(() => inlineScreenshot('x', new Uint8Array(MAX_IMAGE_BYTES + 1)));
  assert.throws(() => validateScreenshots([]));
  assert.throws(() => validateScreenshots(Array.from({ length: 6 }, (_, i) => inlineScreenshot(`img-${i}`, png))));
  assert.throws(() => validateScreenshots([{ ...images()[0], dataUrl: images()[0].dataUrl.replace('image/png', 'image/jpeg') }]));
  assert.throws(() => validateScreenshots([...images(), ...images()]));
});
test('截图金额正负符号及合法千分位可核对，歧义和小数点不猜', () => {
  for (const quote of ['-20.00', '−￥20.00', '+20元', 'HK$20.00']) assert.equal(imageQuotedCents(quote), 2000);
  assert.equal(imageQuotedCents('-1,234.56'), 123456);
  for (const quote of ['20,00', '20..00', '约20元', '20.001', '二十多']) assert.equal(imageQuotedCents(quote), null);
});
test('零钱支出20只生成未核对草稿，指定账户覆盖模型猜测，人工可补打车', () => {
  const c = config(), d = newDraft('', TODAY); d.inputMode = 'screenshots';
  Object.assign(d, parseScreenshots(response([entry({ account_id: 'reserve' })]), d, c, images(), options));
  const row = d.rows[0]; assert.equal(row.reviewed, false); assert.equal(row.accountId, 'activity'); assert.equal(row.date, TODAY); assert.equal(row.note, '零钱支出'); assert.equal(rowIssues(row, c, emptyState(), d, TODAY).length, 0);
  assert.throws(() => draftEvents(d, c, emptyState(), 'not-reviewed', TODAY));
  row.note = '打车'; row.categoryId = 'transport'; row.edited = true; row.reviewed = true;
  const built = draftEvents(d, c, emptyState(), 'image-save', TODAY), tx = built.events.find(event => event.type === 'transaction.put')!;
  assert.equal(tx.type === 'transaction.put' && tx.value.note, '打车'); assert.equal(tx.type === 'transaction.put' && tx.value.amountCents, 2000);
  assert.ok(tx.type === 'transaction.put' && tx.value.originalText.includes('零钱支出 -20.00'));
  assert.equal(balances(applyEvents(emptyState(), built.events, c, TODAY), c, TODAY).get('activity'), 298000);
});
test('截图没有明确付款账户时不套默认，也不把平台标题当账户', () => {
  const c = config(); c.accounts[0].name = '微信';
  const d = newDraft('', TODAY), selected = images(); selected[0].accountId = '';
  const parsed = parseScreenshots(response([entry({ account_id: 'activity' })], '微信\n零钱支出 -20.00'), d, c, selected, options);
  assert.equal(parsed.rows[0].accountId, ''); assert.equal(parsed.rows[0].usedDefault, false);
  Object.assign(d, parsed); assert.ok(rowIssues(d.rows[0], c, emptyState(), d, TODAY).includes('收支账户待补'));
});
test('日期和只支出限制本地生效，余额汇总与未完成交易不变流水', () => {
  const d = newDraft('', TODAY), c = config();
  const entries = [entry(), entry({ date: '2026-10-11', source_quote: '昨日打车 -20.00' }), entry({ kind: 'income', source_quote: '工资 +20.00', amount_quote: '+20.00' }), entry({ source_quote: '零钱余额：20.00', amount_quote: '20.00' }), entry({ source_quote: '本月支出 20.00', amount_quote: '20.00' }), entry({ source_quote: '待支付 -20.00' })];
  const parsed = parseScreenshots(response(entries, entries.map(e => e.source_quote).join('\n')), d, c, images(), options);
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.excluded.length, 5); assert.deepEqual(parsed.completeDates, []);
  assert.throws(() => parseScreenshots({ ...response(), complete_dates: [TODAY] }, d, c, images(), options));
});
test('截图金额与引用不符不能只勾选核对保存，人工改正后保留证据', () => {
  const c = config(), d = newDraft('', TODAY); Object.assign(d, parseScreenshots(response([entry({ amount: '200.00' })]), d, c, images(), options));
  d.rows[0].reviewed = true; assert.ok(rowIssues(d.rows[0], c, emptyState(), d, TODAY).some(issue => issue.includes('金额与原文'))); assert.throws(() => draftEvents(d, c, emptyState(), 'wrong-amount', TODAY));
  d.rows[0].amount = '20.00'; d.rows[0].edited = true; assert.equal(rowIssues(d.rows[0], c, emptyState(), d, TODAY).length, 0);
});
test('截图正负号与类型冲突以及缺转账另一端继续待补', () => {
  const c = config(), d = newDraft('', TODAY);
  const parsed = parseScreenshots(response([entry({ kind: 'income' })]), d, c, images(), { ...options, onlyExpenses: false }); assert.equal(parsed.rows[0].kind, 'unknown');
  const deposit = parseScreenshots(response([entry({ kind: 'income', source_quote: '零钱充值 +20.00', amount_quote: '+20.00' })], '零钱充值 +20.00'), d, c, images(), { ...options, onlyExpenses: false }); assert.equal(deposit.rows[0].kind, 'unknown');
  const refund = parseScreenshots(response([entry({ source_quote: '已退款 -20.00' })], '已退款 -20.00'), d, c, images(), { ...options, onlyExpenses: false }); assert.equal(refund.rows[0].kind, 'unknown');
  const recharge = parseScreenshots(response([entry({ kind: 'transfer', source_quote: '往备用钱包充20.00', amount_quote: '20.00', to_account_id: 'reserve' })], '往备用钱包充20.00'), d, c, images(), { ...options, onlyExpenses: false });
  Object.assign(d, recharge); assert.ok(rowIssues(d.rows[0], c, emptyState(), d, TODAY).includes('转出账户待补'));
});
test('重叠截图提示重复，不静默删除可能真实重复的消费', () => {
  const c = config(), d = newDraft('', TODAY), selected = [...images(), inlineScreenshot('image-test-2', png, 'activity')];
  const r = response(); r.images.push({ ...r.images[0], image_index: 2 });
  const parsed = parseScreenshots(r, d, c, selected, options); assert.equal(parsed.rows.length, 2); assert.ok(parsed.rows.every(row => row.issues.some(issue => issue.includes('重叠'))));
});
test('图片只存在请求体，草稿、账本、重开和备份恢复只保留文字', async () => {
  const io = new MemoryIO(), repo = new Repository(io, '截图测试', () => TODAY); await repo.load(); await repo.saveConfig(config());
  const d = newDraft('这20是打车', TODAY); d.inputMode = 'screenshots'; Object.assign(d, parseScreenshots(response(), d, repo.config, images(), options)); await repo.saveDraft(d);
  d.rows[0].reviewed = true; await repo.commit(draftEvents(d, repo.config, repo.state, 'image-test-batch', TODAY).events, d.requestId, '截图核对', 'image-test-batch');
  const backup = repo.exportBackup(); assert.ok(!JSON.stringify(backup).includes('data:image/')); assert.ok(![...io.files.values()].join('').includes(png.toString('base64')));
  const reopened = new Repository(io, '截图测试', () => TODAY); await reopened.load(); assert.equal(reopened.drafts[0].inputMode, 'screenshots'); assert.equal(reopened.state.transactions.size, 1);
  const restored = new Repository(io, '截图恢复', () => TODAY); await restored.load(); await restored.restoreBackup(backup); assert.equal(restored.state.transactions.size, 1); assert.equal(restored.drafts[0].imageEvidence?.length, 1);
  assert.throws(() => validateDraft({ ...d, imageEvidence: [{ id: 'image-test-1', text: images()[0].dataUrl }] }));
});
test('图片接口沿用用户连接，内联图片与说明一起请求且不触发文件上传', async () => {
  const calls: { url: string; body: any }[] = [];
  const extractor = new Extractor(async (url, body) => { calls.push({ url, body }); return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response()) } }], usage: { prompt_tokens: 12, completion_tokens: 34 } } }; });
  const d = newDraft('这20是打车', TODAY); const result = await extractor.extractScreenshots(settings, 'synthetic-key-only', d, config(), emptyState(), images(), options);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://example.test/chat/completions'); assert.equal(calls[0].body.model, settings.model);
  assert.ok(calls[0].body.messages[1].content.some((block: any) => block.type === 'image_url' && block.image_url.url === images()[0].dataUrl));
  assert.ok(calls[0].body.messages[1].content[0].text.includes('这20是打车')); assert.equal(result.usage.input, 12); assert.deepEqual(result.completeDates, []);
});
test('图片不支持、截断与恶意额外键均拒绝，原草稿不被修改', async () => {
  const d = newDraft('补充说明', TODAY), before = structuredClone(d);
  const unsupported = new Extractor(async () => ({ status: 400, json: {} }));
  await assert.rejects(unsupported.extractScreenshots(settings, 'test-key', d, config(), emptyState(), images(), options), /支持图片/);
  const truncated = new Extractor(async () => ({ status: 200, json: { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(response()) } }] } }));
  await assert.rejects(truncated.extractScreenshots(settings, 'test-key', d, config(), emptyState(), images(), options), /完整结束/);
  assert.throws(() => parseScreenshots({ ...response(), code: 'save()' }, d, config(), images(), options));
  assert.throws(() => parseScreenshots(response([], images()[0].dataUrl), d, config(), images(), options));
  assert.deepEqual(d, before);
});
