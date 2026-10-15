import { obsidianRuntime } from './obsidian-runtime.mjs';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const runtimeSource = resolve(process.env.LIFELEDGER_TEST_RUNTIME ?? '.'), runtime = await obsidianRuntime(), version = JSON.parse(await readFile(join(runtimeSource, 'manifest.json'), 'utf8')).version;
const run = Date.now(), vault = resolve(`validation-vault/reconciliation-${run}`), profile = resolve(`validation-vault/reconciliation-profile-${run}`), appdata = join(profile, 'obsidian');
const evidence = `evidence/reconciliation-v${version}${process.env.BUGS_ONLY === '1' ? '-baseline' : ''}`;
await mkdir(join(vault, '.obsidian/plugins/lifeledger-next'), { recursive: true }); await mkdir(appdata, { recursive: true }); await mkdir(evidence, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(join(runtimeSource, file), join(vault, '.obsidian/plugins/lifeledger-next', file));
await writeFile(join(vault, '.obsidian/community-plugins.json'), '[]'); await writeFile(join(vault, '.obsidian/app.json'), '{"safeMode":false}');
await writeFile(join(appdata, 'obsidian.json'), JSON.stringify({ vaults: { reconciliation: { path: vault, open: true, ts: run } } })); await copyFile(runtime.asar, join(appdata, runtime.asarName));
let browser, child, page, statementMode = 'normal', requests = 0; const checks = [], errors = [];
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  try {
    const body = JSON.parse(raw); assert.equal(body.model, 'deepseek-flash'); assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.max_tokens, 65536); requests++;
    const content = body.messages[1].content, screenshots = Array.isArray(content), input = JSON.parse(screenshots ? content[0].text : content);
    const base = { date: screenshots ? null : input.context.today, date_range: null, currency: 'CNY', account_id: null, from_account_id: null, to_account_id: null, debt_account_id: null, related_id: null, income_source: 'other', issues: [], cost: null, received_amount: null, received_amount_quote: null };
    const entries = [{ ...base, kind: 'income', amount: '100.00', category_id: null, note: '闲鱼入账', source_quote: '闲鱼入账100元', amount_quote: '100元' }, { ...base, kind: 'expense', amount: '2.00', category_id: 'business', note: '服务费', source_quote: '服务费-2元', amount_quote: '-2元' }];
    if (statementMode === 'missing') entries.push({ ...base, kind: 'expense', amount: '2.00', category_id: 'business', note: '额外费用', source_quote: '额外费用-2元', amount_quote: '-2元' });
    const result = screenshots ? { version: 1, images: [{ image_index: 1, text: '闲鱼入账100元\n服务费-2元', entries, excluded: [] }] } : { version: 3, entries, excluded: [], complete_dates: [] };
    if (statementMode === 'delayed') await new Promise(resolve => setTimeout(resolve, 700));
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result), reasoning_content: 'synthetic reasoning not persisted' } }], usage: { prompt_tokens: 100, completion_tokens: 200 } }));
  } catch (error) { response.statusCode = 500; response.end('{}'); errors.push(`synthetic server: ${error.message}`); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const baseUrl = `http://127.0.0.1:${server.address().port}`;
async function test(name, fn) { try { const detail = await fn(); checks.push({ name, passed: true, detail }); console.log(`通过：${name}${detail ? ' ' + JSON.stringify(detail) : ''}`); } catch (error) { checks.push({ name, passed: false, error: error.message }); console.log(`失败：${name} ${error.message}`); } }
try {
  child = spawn(runtime.executable, [`--user-data-dir=${appdata}`, '--remote-debugging-port=9244', '--no-sandbox'], { env: { ...process.env, APPDATA: profile }, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9244', { timeout: 1000 }); break; } catch { await new Promise(resolve => setTimeout(resolve, 300)); } }
  assert.ok(browser); const context = browser.contexts()[0];
  for (let i = 0; i < 40; i++) { page = context.pages().find(p => p.url().startsWith('app://')); if (page) break; await new Promise(resolve => setTimeout(resolve, 200)); }
  assert.ok(page); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => globalThis.app?.workspace?.layoutReady, undefined, { timeout: 20000 });
  assert.equal(resolve(await page.evaluate(() => app.vault.adapter.getBasePath())), vault);
  const trust = page.getByText('信任仓库作者并启用插件', { exact: true }); if (await trust.isVisible().catch(() => false)) await trust.click();
  const dates = await page.evaluate(async ({ baseUrl }) => {
    await app.plugins.enablePlugin('lifeledger-next'); const p = app.plugins.plugins['lifeledger-next']; await p.open();
    const today = p.repo.config.observationStart, before = new Date(`${today}T00:00:00Z`); before.setUTCDate(before.getUTCDate() - 1); const yesterday = before.toISOString().slice(0, 10);
    await p.repo.saveConfig({ ...p.repo.config, observationStart: yesterday, animation: 'off', accounts: [{ id: 'wallet', name: '支付宝余额', kind: 'asset', openingCents: 100000, openingDate: yesterday, freedomBps: 0, aliases: ['支付宝'] }, { id: 'bank', name: '测试银行卡', kind: 'asset', openingCents: 0, openingDate: yesterday, freedomBps: 10000, aliases: [] }], defaultAccountId: 'wallet' });
    p.deviceSettings.api.baseUrl = baseUrl; p.deviceSettings.api.model = 'deepseek-flash'; p.app.secretStorage.setSecret(p.deviceSettings.api.secretId, 'synthetic-key-only'); await p.saveData(p.deviceSettings);
    await p.refresh(); return { today, yesterday, sameInstance: app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.plugin === p };
  }, { baseUrl }); assert.equal(dates.sameInstance, true);
  const metrics = await context.newCDPSession(page); await metrics.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  const close = async () => { await page.locator('dialog').last().getByRole('button', { name: '关闭', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('dialog')); };
  await page.getByRole('button', { name: '账本', exact: true }).click(); await page.locator(`.ll-day[data-date="${dates.yesterday}"]`).click(); await page.getByRole('button', { name: '补记账目', exact: true }).click();
  await page.getByRole('button', { name: '手动加一笔', exact: true }).click();
  await test('日历补账新行默认选中日期', async () => { const actual = await page.getByLabel('日期', { exact: true }).inputValue(); assert.equal(actual, dates.yesterday); return { actual }; });
  if (process.env.BUGS_ONLY !== '1') await test('切换本次日期后可批改未核对行，已核对行保持原日期', async () => {
    await page.getByLabel('已核对这笔金额、账户和疑问').check();
    await page.getByRole('button', { name: '手动加一笔', exact: true }).click();
    await page.getByLabel('本次记账日期', { exact: true }).fill(dates.today); await page.getByLabel('本次记账日期', { exact: true }).press('Tab');
    await page.getByRole('button', { name: '未核对行统一为本次日期', exact: true }).click();
    assert.equal(await page.getByLabel('日期', { exact: true }).nth(0).inputValue(), dates.yesterday);
    assert.equal(await page.getByLabel('日期', { exact: true }).nth(1).inputValue(), dates.today);
  });
  await close();
  await page.evaluate(async ({ today }) => {
    const p = app.plugins.plugins['lifeledger-next'], rows = Array.from({ length: 35 }, (_, i) => ({ id: `scroll-${i}`, kind: 'expense', date: today, dateRange: null, amount: '2.00', accountId: 'wallet', fromAccountId: '', toAccountId: '', debtAccountId: '', categoryId: 'business', relatedId: '', incomeSource: 'other', note: `虚拟服务费${i}`, sourceQuote: '', amountQuote: '', issues: [], reviewed: false, edited: true, usedDefault: false, cost: null }));
    const draft = { version: 1, id: 'scroll-draft', revision: 0, origin: 'editor', text: '', textHistory: [], submittedDate: today, timezone: 'Asia/Shanghai', rows, excluded: [], completeDates: [], status: 'review', error: '', requestId: 'scroll-request', usage: null };
    await p.repo.saveDraft(draft); await app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.openDraft(draft.id);
  }, dates);
  async function position(index) { return page.evaluate(index => {
    const row = document.querySelectorAll('.ll-draft-row')[index], modal = document.querySelector('dialog'); modal.scrollTop += row.getBoundingClientRect().top - modal.getBoundingClientRect().top - 160; row.querySelector('input[type=checkbox][aria-label="已核对这笔金额、账户和疑问"]').focus({ preventScroll: true });
  }, index); }
  async function snapshot(index) { return page.evaluate(index => ({ top: document.querySelector('dialog').scrollTop, rowTop: document.querySelectorAll('.ll-draft-row')[index].getBoundingClientRect().top }), index); }
  await test('核对按钮点击不使长草稿上滑', async () => { await position(15); await page.waitForTimeout(80); const before = await snapshot(15); await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).nth(15).check({ force: true }); await page.waitForTimeout(120); const after = await snapshot(15); assert.ok(Math.abs(before.top - after.top) <= 1, JSON.stringify({ before, after })); return { before, after }; });
  await test('连续核对与切换类型保持当前行位置', async () => { await position(22); const before = await snapshot(22); await page.getByLabel('类型', { exact: true }).nth(22).selectOption('income'); await page.waitForTimeout(120); const after = await snapshot(22); assert.ok(Math.abs(before.top - after.top) <= 1, JSON.stringify({ before, after })); return { before, after }; });
  if (process.env.BUGS_ONLY !== '1') await test('修改备注刷新汇总后保持滚动和键盘焦点', async () => {
    await position(30); const note = page.getByLabel('备注', { exact: true }).nth(30); await note.focus(); const before = await snapshot(30);
    await note.fill('键盘修改服务费'); await note.press('Tab'); await page.waitForTimeout(120); const after = await snapshot(30);
    assert.ok(Math.abs(before.top - after.top) <= 1, JSON.stringify({ before, after }));
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '同时加入每日成本');
  });
  await close();
  if (process.env.BUGS_ONLY !== '1') {
    await page.evaluate(async ({ today, yesterday }) => {
      const p = app.plugins.plugins['lifeledger-next']; for (const d of [...p.repo.drafts]) await p.repo.discardDraft(d);
      const tx = (name, kind, amount, date) => ({ id: name, version: 1, batchId: 'fixture-batch', draftId: null, rowId: null, kind, date, dateRange: null, amountCents: amount, accountId: 'wallet', fromAccountId: null, toAccountId: null, debtAccountId: null, categoryId: kind === 'expense' ? 'business' : null, relatedId: null, incomeSource: 'other', note: kind === 'income' ? '闲鱼入账' : '今天的费用', sourceQuote: '', originalText: '虚拟验证', corrections: [] });
      await p.repo.commit([{ type: 'transaction.put', expected: 0, value: tx('sale', 'income', 10000, yesterday) }, { type: 'transaction.put', expected: 0, value: tx('future-expense', 'expense', 500, today) }], 'fixtures', '虚拟账目', 'fixture-batch');
      const draft = { version: 1, id: 'pending-fee', revision: 0, origin: 'editor', text: '服务费-2元', textHistory: [], submittedDate: today, recordingDate: yesterday, timezone: 'Asia/Shanghai', rows: [{ id: 'pending-row', kind: 'expense', date: yesterday, dateRange: null, amount: '2.00', accountId: 'wallet', fromAccountId: '', toAccountId: '', debtAccountId: '', categoryId: 'business', relatedId: '', incomeSource: 'other', note: '服务费', sourceQuote: '服务费-2元', amountQuote: '-2元', issues: [], reviewed: false, edited: false, usedDefault: false, cost: null }], excluded: [], completeDates: [], status: 'review', error: '', requestId: 'fee-request', usage: null };
      await p.repo.saveDraft(draft); await p.refresh(); const ui = app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui; ui.page = '账本'; ui.selectedDay = yesterday; ui.accountFilter = 'wallet'; ui.render();
    }, dates);
    const modal = () => page.locator('.ll-reconciliation-dialog');
    const open = async actual => { await page.getByRole('button', { name: '按日查差额', exact: true }).click(); await modal().waitFor(); await modal().getByLabel('实际日终余额（CNY）', { exact: true }).fill(actual); await modal().getByRole('button', { name: '查差额', exact: true }).click(); await page.waitForTimeout(100); };
    const count = () => page.evaluate(() => app.plugins.plugins['lifeledger-next'].repo.state.transactions.size);
    await test('选定账户昨日余额排除今天流水，列出未入账服务费，查找本身不改账', async () => {
      await open('1098'); assert.ok((await modal().locator('.ll-reconciliation-book-balance').innerText()).includes('1,100.00')); assert.ok((await modal().locator('.ll-reconciliation-difference').innerText()).includes('-2.00'));
      assert.ok((await modal().locator('[data-kind="pending"]').innerText()).includes('服务费')); assert.equal(await count(), 2); assert.equal(requests, 0);
    });
    await test('差额候选直接继续草稿，负号服务费经核对后仅保存一次', async () => {
      await modal().getByRole('button', { name: '继续处理草稿', exact: true }).click(); await page.getByLabel('金额（元）', { exact: true }).waitFor(); assert.equal(await page.getByLabel('日期', { exact: true }).inputValue(), dates.yesterday);
      assert.equal(await page.getByLabel('金额（元）', { exact: true }).inputValue(), '2.00'); assert.equal(await page.getByLabel('已核对这笔金额、账户和疑问').isChecked(), false);
      await page.getByLabel('已核对这笔金额、账户和疑问').check(); await page.getByRole('button', { name: '保存 1 笔', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('dialog')); assert.equal(await count(), 3);
    });
    const originalStatement = '闲鱼入账100元\n服务费-2元';
    const compareText = async text => { await modal().getByRole('button', { name: '粘贴对照账单', exact: true }).click(); const editor = page.locator('dialog').last(); await editor.getByLabel('原文', { exact: true }).fill(text); await editor.getByRole('button', { name: '整理成账目', exact: true }).click(); await editor.locator('.ll-draft-row').first().waitFor(); await editor.getByRole('button', { name: '用于账单比对', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('dialog').length === 1); };
    await test('原账单只作对照，选中补账日传入API且相同金额按笔数匹配', async () => {
      await open('1098'); await compareText(originalStatement); assert.ok((await modal().locator('.ll-statement-counts').innerText()).includes('金额日期对应 2 笔')); assert.equal(await count(), 3); assert.equal(await page.evaluate(() => app.plugins.plugins['lifeledger-next'].repo.drafts.filter(d => d.status !== 'saved').length), 0);
      await modal().screenshot({ path: `${evidence}/statement-comparison.png` });
    });
    await test('余额和明细相符后单独保存账户核对记录，不新增收支或确认全日', async () => {
      await modal().getByLabel('我已核对同一账户完整明细及日终余额', { exact: true }).check(); await modal().getByRole('button', { name: '确认这个账户已核对', exact: true }).click();
      await page.waitForFunction(() => app.plugins.plugins['lifeledger-next'].repo.config.reconciliations?.length === 1); assert.equal(await count(), 3);
      assert.equal(await page.evaluate(() => app.plugins.plugins['lifeledger-next'].repo.state.days.size), 0); assert.ok((await modal().locator('.ll-checkpoint-status').innerText()).includes('仍有效')); await close();
    });
    await test('修改截止日前流水后，对账记录自动提示失效', async () => {
      await page.evaluate(async ({ yesterday }) => { const p = app.plugins.plugins['lifeledger-next'], value = [...p.repo.state.transactions.values()].find(t => t.kind === 'expense' && t.date === yesterday); await p.repo.commit([{ type: 'transaction.put', expected: value.version, value: { ...value, version: value.version + 1, amountCents: 300 } }], 'fee-correction', '虚拟更正服务费'); await p.refresh(); }, dates);
      await open('1096'); assert.ok((await modal().locator('.ll-checkpoint-status').innerText()).includes('需要重新核对'));
    });
    await test('明细金额不同与漏记分别显示，只生成用户选择的未核对草稿', async () => {
      statementMode = 'missing'; await compareText(originalStatement + '\n额外费用-2元'); assert.equal(await modal().locator('.ll-reconciliation-changed').count(), 1); assert.equal(await modal().locator('.ll-reconciliation-missing').count(), 1);
      assert.equal(await modal().getByRole('button', { name: '确认这个账户已核对', exact: true }).isDisabled(), true); assert.equal(await count(), 3);
      await modal().getByRole('button', { name: '生成这一笔核对草稿', exact: true }).click(); await page.getByLabel('金额（元）', { exact: true }).waitFor(); assert.equal(await page.locator('.ll-draft-row').count(), 1); assert.equal(await page.getByLabel('已核对这笔金额、账户和疑问').isChecked(), false); assert.equal(await count(), 3); await close(); statementMode = 'normal';
    });
    await test('截图对照沿用选中日期和账户，成功即清除图片且不直接入账', async () => {
      await open('1097'); await modal().getByRole('button', { name: '截图对照账单', exact: true }).click(); const editor = page.locator('dialog').last();
      const image = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300; const g = canvas.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0, 0, 400, 300); g.fillStyle = 'black'; g.font = '24px sans-serif'; g.fillText('虚拟闲鱼入账100元 服务费-2元', 10, 100); return canvas.toDataURL('image/png'); });
      await editor.getByLabel('选择记账截图', { exact: true }).setInputFiles({ name: 'synthetic-bill.png', mimeType: 'image/png', buffer: Buffer.from(image.split(',')[1], 'base64') }); await editor.locator('.ll-image-preview').waitFor();
      assert.equal(await editor.getByLabel('截图日期（缺日期时使用）').inputValue(), dates.yesterday); assert.equal(await editor.getByLabel('图片 1 所属账户').inputValue(), 'wallet'); assert.equal(await editor.getByLabel('只识别支出').isChecked(), false);
      await editor.getByRole('button', { name: '识别截图', exact: true }).click(); await editor.locator('.ll-draft-row').first().waitFor(); assert.equal(await editor.locator('.ll-image-preview').count(), 0); await editor.getByRole('button', { name: '用于账单比对', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('dialog').length === 1);
      assert.equal(await count(), 3); assert.equal((await page.evaluate(() => JSON.stringify(app.plugins.plugins['lifeledger-next'].repo.exportBackup()))).includes('data:image/'), false); await close();
    });
    await test('识别未结束时取消对照材料，迟到回复不保存账目或临时草稿', async () => {
      await open('1097'); const payload = () => page.evaluate(() => { const { exportedAt, checksum, ...data } = app.plugins.plugins['lifeledger-next'].repo.exportBackup(); return JSON.stringify(data); }); const before = await payload();
      await modal().getByRole('button', { name: '粘贴对照账单', exact: true }).click(); const editor = page.locator('dialog').last();
      await editor.getByLabel('原文', { exact: true }).fill(originalStatement); statementMode = 'delayed'; const previousRequests = requests;
      await editor.getByRole('button', { name: '整理成账目', exact: true }).click();
      for (let i = 0; i < 30 && requests === previousRequests; i++) await page.waitForTimeout(20);
      assert.equal(await editor.getByRole('button', { name: '用于账单比对', exact: true }).isDisabled(), true);
      await editor.getByRole('button', { name: '关闭', exact: true }).click(); await page.waitForTimeout(900); statementMode = 'normal';
      assert.equal(await page.locator('dialog').count(), 1); assert.equal(await modal().locator('.ll-statement-counts').count(), 0);
      assert.equal(await payload(), before); await close();
    });
    await test('明暗窄窗格查差额无横向溢出，期初日前不以零确认', async () => {
      await metrics.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false }); await open('1097');
      for (const light of [true, false]) { await page.emulateMedia({ colorScheme: light ? 'light' : 'dark' }); assert.equal(await modal().evaluate(node => node.scrollWidth > node.clientWidth + 1), false); await modal().screenshot({ path: `${evidence}/difference-${light ? 'light' : 'dark'}-narrow.png` }); }
      await modal().getByLabel('核对起始日期').fill('2020-01-01'); await modal().getByRole('button', { name: '查差额', exact: true }).click(); assert.ok((await modal().innerText()).includes('此前无法推算')); assert.equal(await modal().getByRole('button', { name: '确认这个账户已核对', exact: true }).count(), 0); await close();
    });
    await test('插件重启保留对账状态和草稿，恢复备份仍可识别失效记录', async () => {
      const result = await page.evaluate(async () => { await app.plugins.disablePlugin('lifeledger-next'); await app.plugins.enablePlugin('lifeledger-next'); const p = app.plugins.plugins['lifeledger-next']; await p.open(); const backup = p.repo.exportBackup(); await p.changeRoot('对账备份恢复'); await p.repo.restoreBackup(backup); await p.refresh(); return { checkpoints: p.repo.config.reconciliations.length, transactions: p.repo.state.transactions.size, pending: p.repo.drafts.filter(d => d.status !== 'saved').length }; });
      assert.equal(result.checkpoints, 1); assert.equal(result.transactions, 3); assert.ok(result.pending >= 1);
    });
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  await writeFile(`${evidence}/reconciliation-ui.json`, JSON.stringify({ version, date: new Date().toISOString(), vault, checks, scriptErrors: errors, realApi: false, realFinancialData: false }, null, 2));
  if (checks.some(check => !check.passed)) process.exitCode = 1;
} catch (error) { if (page) await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => {}); await writeFile(`${evidence}/failure.json`, JSON.stringify({ error: error.message, checks, errors }, null, 2)); throw error;
} finally { if (browser) await browser.close().catch(() => {}); if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); server.close(); }
