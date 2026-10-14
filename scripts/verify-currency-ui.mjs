import { obsidianRuntime } from './obsidian-runtime.mjs';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const runtime = await obsidianRuntime(), version = JSON.parse(await readFile('manifest.json', 'utf8')).version;
const run = Date.now(), vault = resolve(`validation-vault/currency-${run}`), profile = resolve(`validation-vault/currency-profile-${run}`), appdata = join(profile, 'obsidian'), evidence = `evidence/currency-v${version}`;
await mkdir(join(vault, '.obsidian/plugins/lifeledger-next'), { recursive: true }); await mkdir(appdata, { recursive: true }); await mkdir(evidence, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(file, join(vault, '.obsidian/plugins/lifeledger-next', file));
await writeFile(join(vault, '.obsidian/community-plugins.json'), '[]'); await writeFile(join(vault, '.obsidian/app.json'), '{"safeMode":false,"trashOption":"local"}');
await writeFile(join(vault, '测试说明.md'), '# 多币种隔离验证\n全部余额、账户和口播为虚拟样本。\n');
await writeFile(join(appdata, 'obsidian.json'), JSON.stringify({ vaults: { 'lifeledger-currency': { path: vault, open: true, ts: run } } })); await copyFile(runtime.asar, join(appdata, runtime.asarName));
let mode = 'meal', requests = 0;
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw), user = JSON.parse(body.messages[1].content), accounts = user.context.accounts;
  const aid = name => accounts.find(account => account.name === name)?.id ?? null;
  const entry = { kind: 'expense', date: user.context.today, date_range: null, currency: 'CNY', amount: '15.00', account_id: aid('微信'), from_account_id: null, to_account_id: null, debt_account_id: null, category_id: 'food', related_id: null, income_source: 'active', note: '虚拟食堂消费', source_quote: user.original_text, amount_quote: '15', issues: [], cost: null, received_amount: null, received_amount_quote: null };
  if (mode === 'recharge') Object.assign(entry, { kind: 'income', amount: '50.00', category_id: 'creation', account_id: aid('食堂饭卡'), amount_quote: '50' });
  if (mode === 'wechat') Object.assign(entry, { account_id: aid('食堂饭卡') });
  if (mode === 'foreign') Object.assign(entry, { account_id: aid('众安银行'), currency: 'HKD', amount: '50.00', amount_quote: '50港币', note: '虚拟港币消费' });
  requests++;
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ version: 3, entries: [entry], excluded: [], complete_dates: [] }) } }] }));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve)); const modelUrl = `http://127.0.0.1:${model.address().port}`;
let browser, child, page, stage = '启动'; const errors = [], checks = [];
const record = (name, detail) => { checks.push({ name, passed: true, detail }); console.log(`通过：${name}`); };
try {
  child = spawn(runtime.executable, [`--user-data-dir=${appdata}`, '--remote-debugging-port=9240', '--no-sandbox'], { env: { ...process.env, APPDATA: profile }, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9240', { timeout: 1000 }); break; } catch { await new Promise(resolve => setTimeout(resolve, 300)); } }
  assert.ok(browser); const context = browser.contexts()[0];
  for (let i = 0; i < 40; i++) { page = context.pages().find(page => page.url().startsWith('app://')); if (page) break; await new Promise(resolve => setTimeout(resolve, 200)); }
  assert.ok(page); page.on('pageerror', error => errors.push({ stage, message: error.message, stack: error.stack }));
  await page.waitForFunction(() => globalThis.app?.workspace?.layoutReady, undefined, { timeout: 20000 });
  assert.equal(resolve(await page.evaluate(() => app.vault.adapter.getBasePath())), vault);
  const trust = page.getByText('信任仓库作者并启用插件', { exact: true }); if (await trust.isVisible().catch(() => false)) await trust.click();
  await page.evaluate(async () => { await app.plugins.enablePlugin('lifeledger-next'); await app.plugins.plugins['lifeledger-next'].open(); }); await page.locator('.lifeledger').waitFor();
  const size = await context.newCDPSession(page); await size.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(() => {
    const p = app.plugins.plugins['lifeledger-next']; p.originalReferenceTransport = p.referenceTransport; p.referenceCalls = 0; p.rateMode = 'initial';
    p.referenceTransport = async () => { p.referenceCalls++; if (p.rateMode === 'offline') throw new Error('模拟汇率服务离线'); const date = p.repo.config.observationStart; return [{ date, base: 'CNY', quote: 'USD', rate: p.rateMode === 'changed' ? .1 : .125 }, { date, base: 'CNY', quote: 'HKD', rate: p.rateMode === 'changed' ? 1.11111111 : 1.25 }]; };
  });
  const dialog = () => page.locator('dialog');
  async function addAccount(name, currency, amount, aliases = '', first = false) {
    await page.locator('.ll-nav').getByRole('button', { name: '账户', exact: true }).click(); await page.getByRole('button', { name: '添加账户', exact: true }).click();
    await page.getByLabel('账户名称', { exact: true }).fill(name); await page.getByLabel('账户币种', { exact: true }).selectOption(currency);
    await page.getByLabel(currency === 'CNY' ? '期初余额（元）' : `期初余额（${currency}）`, { exact: true }).fill(amount);
    await page.getByLabel('别名（逗号分隔）', { exact: true }).fill(aliases);
    if (name === '食堂饭卡') await page.getByLabel('自由计算纳入比例（%）', { exact: true }).fill('0');
    if (first) await page.getByLabel('设为默认收支账户（仅资产账户）').check();
    if (currency === 'HKD') { await dialog().getByRole('button', { name: '更新参考汇率', exact: true }).click(); await page.waitForFunction(() => !!app.plugins.plugins['lifeledger-next'].repo.config.exchangeRates); }
    await dialog().getByRole('button', { name: '保存账户', exact: true }).click(); await dialog().waitFor({ state: 'detached' });
  }
  stage = '账户初设'; await addAccount('微信', 'CNY', '20000', '', true); await addAccount('食堂饭卡', 'CNY', '200', '学校食堂，食堂，饭卡'); await addAccount('众安银行', 'HKD', '10000'); await addAccount('汇丰美元', 'USD', '0');
  const ids = await page.evaluate(() => Object.fromEntries(app.plugins.plugins['lifeledger-next'].repo.config.accounts.map(account => [account.name, account.id])));
  await page.locator('.ll-nav').getByRole('button', { name: '首页', exact: true }).click();
  assert.ok((await page.locator('.ll-asset-total').innerText()).includes('28,200.00'));
  const bank = page.locator(`.ll-asset-account[data-account-id="${ids['众安银行']}"]`); assert.ok((await bank.innerText()).includes('HK$10,000.00')); assert.ok((await bank.innerText()).includes('约 ¥8,000.00'));
  record('本币港币卡片与人民币资产合计', '众安港币10000，参考折算8000元，总资产28200元，均为虚拟数据');
  stage = '折算显示'; const batches = await page.evaluate(() => app.plugins.plugins['lifeledger-next'].repo.state.batches.length);
  await page.getByRole('button', { name: '切换众安银行折算币种', exact: true }).click(); await page.waitForFunction(id => document.querySelector(`.ll-asset-account[data-account-id="${id}"]`).textContent.includes('约 US$1,000.00'), ids['众安银行']); assert.ok((await bank.innerText()).includes('HK$10,000.00'));
  assert.equal(await page.evaluate(() => app.plugins.plugins['lifeledger-next'].repo.state.batches.length), batches); record('账户小按钮切换美元显示但不改余额或批次', '港币主金额不变，人民币/美元折算独立显示');
  for (const light of [false, true]) { await page.emulateMedia({ colorScheme: light ? 'light' : 'dark' }); await page.waitForFunction(light => document.querySelector('.lifeledger').dataset.theme === (light ? 'light' : 'dark'), light); await page.locator('.lifeledger').screenshot({ path: `${evidence}/accounts-${light ? 'light' : 'dark'}.png` }); }
  stage = '纯换算'; await page.getByRole('button', { name: '⇄ 换汇', exact: true }).click(); await page.getByLabel('换算金额', { exact: true }).fill('1000'); assert.ok((await page.locator('.ll-fx-preview').textContent()).includes('¥800.00')); assert.equal(await page.evaluate(() => app.plugins.plugins['lifeledger-next'].repo.state.transactions.size), 0); record('三币种换算立即展示，未勾选记账不写流水', '1000港币参考为800人民币');
  await page.getByLabel('折算币种', { exact: true }).selectOption('USD'); assert.ok((await page.locator('.ll-fx-preview').textContent()).includes('US$100.00'));
  await dialog().screenshot({ path: `${evidence}/converter-light.png` });
  stage = '实际换汇'; await page.getByLabel('换算金额', { exact: true }).fill('800'); await page.getByLabel('同时记录一笔已发生的账户换汇').check(); await page.getByLabel('转出账户', { exact: true }).selectOption(ids['众安银行']); await page.getByLabel('转入账户', { exact: true }).selectOption(ids['汇丰美元']); await page.getByLabel('实际到账金额', { exact: true }).fill('79');
  await page.getByRole('button', { name: '保存已核对换汇', exact: true }).click(); assert.equal(await page.evaluate(() => app.plugins.plugins['lifeledger-next'].repo.state.transactions.size), 0);
  await page.getByLabel('已核对银行实际扣款、到账金额和账户').check(); await dialog().screenshot({ path: `${evidence}/exchange-preview.png` }); await page.getByRole('button', { name: '保存已核对换汇', exact: true }).click(); await dialog().waitFor({ state: 'detached' });
  assert.ok((await bank.innerText()).includes('HK$9,200.00')); assert.ok((await page.locator(`.ll-asset-account[data-account-id="${ids['汇丰美元']}"]`).innerText()).includes('US$79.00'));
  const saved = await page.evaluate(() => { const r = app.plugins.plugins['lifeledger-next'].repo; return [...r.state.transactions.values()][0]; }); assert.equal(saved.amountCents, 80000); assert.equal(saved.exchange.receivedCents, 7900);
  record('换汇按实际两端金额保存，不采用参考到账金额', '参考到账80美元，实际填79美元；只保存同一笔关联转账');
  await page.evaluate(async () => { await app.plugins.disablePlugin('lifeledger-next'); await app.plugins.enablePlugin('lifeledger-next'); await app.plugins.plugins['lifeledger-next'].open(); }); await page.locator('.lifeledger').waitFor();
  assert.ok((await page.locator(`.ll-asset-account[data-account-id="${ids['汇丰美元']}"]`).innerText()).includes('US$79.00'));
  await page.getByRole('button', { name: '撤销最近一批', exact: true }).click(); await page.waitForFunction(() => app.plugins.plugins['lifeledger-next'].repo.state.transactions.size === 0); record('换汇重开及整批撤销两端同时恢复', '港币10000、美元0，完整保留原批次');
  await page.evaluate(async ({ modelUrl }) => { const p = app.plugins.plugins['lifeledger-next']; p.deviceSettings.api.baseUrl = modelUrl; p.deviceSettings.api.model = 'synthetic-model'; p.app.secretStorage.setSecret(p.deviceSettings.api.secretId, 'synthetic-key-only'); await p.saveData(p.deviceSettings); }, { modelUrl });
  async function extract(text) { await page.getByLabel('记账原文', { exact: true }).fill(text); await page.locator('.ll-entry-card').getByRole('button', { name: '整理成账目', exact: true }).click(); await page.locator('.ll-draft-row').waitFor(); }
  async function saveDraft() { await page.getByLabel('已核对这笔金额、账户和疑问').check(); await page.getByRole('button', { name: '保存 1 笔', exact: true }).click(); await dialog().waitFor({ state: 'detached' }); }
  stage = '饭卡充值'; mode = 'recharge'; await extract('往食堂饭卡充50'); assert.equal(await page.getByLabel('类型', { exact: true }).inputValue(), 'transfer'); assert.equal(await page.getByLabel('转入账户', { exact: true }).inputValue(), ids['食堂饭卡']); assert.equal(await page.getByLabel('转出账户', { exact: true }).inputValue(), ''); assert.equal(await page.getByRole('button', { name: '保存 0 笔', exact: true }).isDisabled(), true);
  await page.getByLabel('转出账户', { exact: true }).selectOption(ids['微信']); await saveDraft(); record('充值误识别收入时按内部转账核对，缺转出不会套默认', '人工补选微信后微信减50、饭卡加50，不计收支');
  stage = '饭卡消费'; mode = 'meal'; await extract('学校食堂吃饭减15'); assert.equal(await page.getByLabel('账户', { exact: true }).inputValue(), ids['食堂饭卡']); await dialog().screenshot({ path: `${evidence}/meal-account-review.png` }); await saveDraft();
  assert.ok((await page.locator(`.ll-asset-account[data-account-id="${ids['食堂饭卡']}"]`).innerText()).includes('¥235.00')); assert.ok((await page.locator(`.ll-asset-account[data-account-id="${ids['微信']}"]`).innerText()).includes('¥19,950.00')); record('学校食堂别名覆核模型错误，15元只扣饭卡', '饭卡250减15为235，微信仍19950');
  stage = '明确微信付款'; mode = 'wechat'; await extract('用微信在学校食堂吃饭15元'); assert.equal(await page.getByLabel('账户', { exact: true }).inputValue(), ids['微信']); await saveDraft(); record('明确微信在食堂付款仍扣微信', '付款账户优先于地点别名');
  stage = '港币消费'; mode = 'foreign'; await extract('众安银行消费50港币'); assert.equal(await page.getByLabel('币种', { exact: true }).inputValue(), 'HKD'); assert.equal(await page.getByLabel('金额（HKD）', { exact: true }).inputValue(), '50.00'); await saveDraft();
  const foreign = await page.evaluate(() => [...app.plugins.plugins['lifeledger-next'].repo.state.transactions.values()].find(t => t.valuation?.currency === 'HKD')); assert.equal(foreign.valuation.rate, 80000000); record('API v3港币草稿按本币扣款且冻结0.8折算', '50港币统计为40人民币');
  stage = '更新与离线'; await page.evaluate(async () => {
    const p = app.plugins.plugins['lifeledger-next']; p.originalReferenceTransport = p.referenceTransport; p.referenceCalls = 0; p.rateMode = 'changed'; p.referenceTransport = async () => { p.referenceCalls++; if (p.rateMode === 'offline') throw Error('模拟离线'); const date = p.repo.config.observationStart; return [{ date, base: 'CNY', quote: 'USD', rate: .1 }, { date, base: 'CNY', quote: 'HKD', rate: 1.11111111 }]; }; await p.updateExchangeRates();
  });
  const history = await page.evaluate(() => [...app.plugins.plugins['lifeledger-next'].repo.state.transactions.values()].find(t => t.valuation?.currency === 'HKD')); assert.deepEqual(history, foreign);
  const cached = await page.evaluate(() => JSON.stringify(app.plugins.plugins['lifeledger-next'].repo.config.exchangeRates));
  await page.evaluate(async () => { const p = app.plugins.plugins['lifeledger-next']; p.rateMode = 'offline'; await p.updateExchangeRates().catch(() => {}); }); assert.equal(await page.evaluate(() => JSON.stringify(app.plugins.plugins['lifeledger-next'].repo.config.exchangeRates)), cached); assert.ok((await page.locator('.ll-fx-status').textContent()).includes('沿用缓存'));
  record('更新只改当前估值，历史快照冻结；离线保留缓存和日期', '没有重写任何已保存港币流水');
  await page.evaluate(async () => { const p = app.plugins.plugins['lifeledger-next']; const before = p.referenceCalls; await p.open(); await p.open(); p.cacheCheck = p.referenceCalls === before; }); assert.equal(await page.evaluate(() => app.plugins.plugins['lifeledger-next'].cacheCheck), true); record('同日重开不重复请求参考汇率', '缓存获取日期与失败尝试日期分别控制');
  stage = '五页与恢复'; await size.send('Emulation.setDeviceMetricsOverride', { width: 980, height: 1100, deviceScaleFactor: 1, mobile: false });
  for (const name of ['首页', '账本', '分析', '账户', '每日成本']) { await page.locator('.ll-nav').getByRole('button', { name, exact: true }).click(); assert.equal(await page.locator('.lifeledger').evaluate(root => root.scrollWidth > root.clientWidth + 1), false); }
  record('多币种五页窄窗格无横向溢出', '980px窗口'); await size.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
  const recovered = await page.evaluate(async () => { const p = app.plugins.plugins['lifeledger-next'], backup = p.repo.exportBackup(); await p.changeRoot('多币种恢复'); await p.repo.restoreBackup(backup); await p.refresh(); return { currencies: p.repo.config.accounts.map(a => a.currency ?? 'CNY'), rates: p.repo.config.exchangeRates, transactions: p.repo.state.transactions.size, issueCount: p.repo.state.issues.length }; }); assert.equal(recovered.transactions, 4); assert.equal(recovered.issueCount, 0); assert.ok(recovered.currencies.includes('HKD')); assert.ok(recovered.currencies.includes('USD')); record('完整JSON恢复币种、汇率、流水与快照', recovered);
  await page.locator('.ll-nav').getByRole('button', { name: '首页', exact: true }).click(); await page.locator('.lifeledger').screenshot({ path: `${evidence}/final-home.png` });
  let live = { attempted: false, success: false };
  if (process.env.LIVE_RATES === '1') { stage = '真实公共汇率'; live = await page.evaluate(async () => { const p = app.plugins.plugins['lifeledger-next']; p.referenceTransport = p.originalReferenceTransport ?? p.referenceTransport; try { const rates = await p.updateExchangeRates(); return { attempted: true, success: true, rates }; } catch (error) { return { attempted: true, success: false, message: error.message }; } }); console.log(`真实公共汇率：${live.success ? '通过' : '未通过'}`); }
  assert.equal(errors.length, 0, JSON.stringify(errors)); record('全流程无页面脚本错误', { errors: 0 });
  await writeFile(`${evidence}/currency-ui.json`, JSON.stringify({ version, executedAt: new Date().toISOString(), vault, checks, scriptErrors: errors, requests, realFinancialApi: false, realTypeless: false, referenceRates: live }, null, 2)); console.log(`完成 ${checks.length} 项多币种隔离检查`);
} catch (error) { if (page) await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => {}); await writeFile(`${evidence}/failure.json`, JSON.stringify({ stage, message: error.message, checks, errors }, null, 2)); throw error; }
finally { if (browser) await browser.close().catch(() => {}); if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); model.close(); }
