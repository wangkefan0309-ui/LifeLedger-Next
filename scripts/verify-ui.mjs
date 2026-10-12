import { obsidianRuntime } from './obsidian-runtime.mjs';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const runtime = await obsidianRuntime();
const { version } = JSON.parse(await readFile('manifest.json', 'utf8'));
const evidence = `evidence/ui-v${version}`;
const runId = String(Date.now()); const vault = resolve(`validation-vault/run-${runId}`), profile = resolve(`validation-vault/profile-${runId}`), appdata = join(profile, 'obsidian');
await mkdir(join(vault, '.obsidian/plugins/lifeledger-next'), { recursive: true }); await mkdir(appdata, { recursive: true }); await mkdir(evidence, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(file, join(vault, '.obsidian/plugins/lifeledger-next', file));
await writeFile(join(vault, '.obsidian/community-plugins.json'), '["lifeledger-next"]'); await writeFile(join(vault, '.obsidian/app.json'), '{"safeMode":false}');
await writeFile(join(vault, '测试说明.md'), '# 隔离验证\n只含虚拟数据；本机模拟 API，不使用真实密钥。\n');
await writeFile(join(appdata, 'obsidian.json'), JSON.stringify({ vaults: { 'lifeledger-isolated': { path: vault, open: true, ts: Date.now() } } }));
await copyFile(runtime.asar, join(appdata, runtime.asarName));
let requests = 0, mode = 'daily';
const model = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/models') { res.end(JSON.stringify({ data: [{ id: 'isolated-model' }] })); return; }
  requests++; const body = JSON.parse(text), user = JSON.parse(body.messages[1].content), today = user.context.today;
  const base = { kind: 'expense', date: today, date_range: null, currency: 'CNY', amount: '8.00', account_id: null, from_account_id: null, to_account_id: null, debt_account_id: null, category_id: 'food', related_id: null, income_source: 'active', note: '', source_quote: '', amount_quote: '', issues: [], cost: null };
  let entries = mode === 'daily' ? [
    { ...base, amount: '8.00', note: '早饭', source_quote: '今天早饭八块', amount_quote: '八块' },
    { ...base, amount: '25.00', note: '午饭', source_quote: '午饭二十五块', amount_quote: '二十五块' },
    { ...base, amount: '32.00', note: '晚饭', source_quote: '晚饭三十二', amount_quote: '三十二' },
    { ...base, amount: '6.00', category_id: 'transport', note: '地铁', source_quote: '地铁六块', amount_quote: '六块' },
    { ...base, kind: 'income', amount: '300.00', category_id: 'creation', note: '公众号到账', source_quote: '公众号到账三百', amount_quote: '三百' }
  ] : mode === 'transfer' ? [{ ...base, kind: 'transfer', amount: '500.00', category_id: null, from_account_id: null, to_account_id: 'reserve', note: '转账', source_quote: user.original_text, amount_quote: '五百', issues: ['转出账户待补'] }] : [];
  const content = mode === 'failure' ? '' : JSON.stringify({ version: 2, entries, excluded: [], complete_dates: [] });
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 400 } }));
});
await new Promise(r => model.listen(0, '127.0.0.1', r)); const modelUrl = `http://127.0.0.1:${model.address().port}`;
let browser, child, page; const errors = [], checks = []; let stage = '启动';
const record = (name, detail) => { checks.push({ name, detail, passed: true }); console.log(`通过：${name}`); };
try {
  child = spawn(runtime.executable, [`--user-data-dir=${appdata}`, '--remote-debugging-port=9230', '--no-sandbox'], { env: { ...process.env, APPDATA: profile }, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 30; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9230', { timeout: 1000 }); break; } catch { await new Promise(r => setTimeout(r, 400)); } }
  assert.ok(browser, '隔离调试端口未启动'); const context = browser.contexts()[0];
  for (let i = 0; i < 30; i++) { page = context.pages().find(p => p.url().startsWith('app://')); if (page) break; await new Promise(r => setTimeout(r, 300)); }
  assert.ok(page); page.on('pageerror', e => { errors.push({ message: e.message, stack: e.stack, stage }); console.log('GUI错误', stage, e.stack); });
  await page.waitForFunction(() => globalThis.app?.vault?.adapter?.getBasePath?.(), undefined, { timeout: 20000 });
  const actual = await page.evaluate(() => globalThis.app.vault.adapter.getBasePath()); assert.equal(resolve(actual), vault, '必须是本次隔离库');
  await page.waitForFunction(() => globalThis.app?.workspace?.layoutReady, undefined, { timeout: 20000 });
  const trust = page.getByText('信任仓库作者并启用插件', { exact: true }); if (await trust.isVisible().catch(() => false)) await trust.click();
  await page.evaluate(async () => { await globalThis.app.plugins.enablePlugin('lifeledger-next'); });
  await page.waitForFunction(() => globalThis.app?.plugins?.plugins?.['lifeledger-next']?.repo, undefined, { timeout: 15000 });
  await page.evaluate(async () => { await globalThis.app.plugins.plugins['lifeledger-next'].open(); });
  const size = await context.newCDPSession(page); await size.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(() => { document.body.classList.remove('theme-light'); document.body.classList.add('theme-dark'); });
  await page.locator('.lifeledger h1').waitFor(); assert.equal(await page.locator('.lifeledger h1').textContent(), '赚钱已成定局，余生好好体验');
  assert.equal(await page.locator('.ll-stage-heading h2').textContent(), '财富自由指南灯');
  assert.equal(await page.locator('.ll-freedom-number').textContent(), '—天');
  await page.locator('.lifeledger').screenshot({ path: `${evidence}/home-empty.png` });
  assert.equal(await page.locator('.ll-account-strip button').count(), 0); record('空账本与标题', '正式插件没有预置虚拟余额');
  stage = '账户初设';
  await page.getByRole('button', { name: '添加账户', exact: true }).click();
  await page.getByLabel('账户名称', { exact: true }).fill('活动钱包'); await page.getByLabel('期初余额（元）', { exact: true }).fill('3000'); await page.getByLabel('期初余额（元）', { exact: true }).press('Tab'); await page.getByLabel('设为默认收支账户（仅资产账户）').check(); await page.getByRole('button', { name: '保存账户', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' });
  await page.evaluate(async ({ modelUrl }) => {
    const plugin = globalThis.app.plugins.plugins['lifeledger-next']; const c = plugin.repo.config, today = c.observationStart;
    c.accounts.push({ id: 'reserve', name: '备用钱包', kind: 'asset', openingCents: 500000, openingDate: today, freedomBps: 10000, aliases: [] }, { id: 'asset', name: '资产账户', kind: 'asset', openingCents: 2000000, openingDate: today, freedomBps: 10000, aliases: [] }); c.estimateDailyCents = 5000; c.animation = 'off';
    await plugin.repo.saveConfig(c); plugin.deviceSettings.api.baseUrl = modelUrl; plugin.deviceSettings.api.model = 'isolated-model'; plugin.app.secretStorage.setSecret(plugin.deviceSettings.api.secretId, 'synthetic-key-only'); await plugin.saveData(plugin.deviceSettings); await plugin.refresh();
  }, { modelUrl });
  assert.ok((await page.locator('.ll-stats').first().innerText()).includes('28,000.00')); record('账户初设与资产合计', 'UI建立首个账户，另外两个为隔离测试样本，总资产28000元');
  const layout = await page.evaluate(() => {
    const bounds = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return { x: b.x, y: b.y, bottom: b.bottom, width: b.width }; };
    return { assets: bounds('.ll-asset-cards'), left: bounds('.ll-home-ledger'), right: bounds('.ll-home-stage'), summary: bounds('.ll-home-summary'), guide: bounds('.ll-stage-heading'), header: bounds('.ll-header'), nav: bounds('.ll-nav'), background: getComputedStyle(document.querySelector('.lifeledger')).backgroundColor, income: getComputedStyle(document.querySelector('.ll-income .ll-number')).color, countSize: getComputedStyle(document.querySelector('.ll-freedom-number')).fontSize, typography: { body: getComputedStyle(document.querySelector('.lifeledger')).fontSize, hint: getComputedStyle(document.querySelector('.ll-entry-hint')).fontSize, guideTitle: getComputedStyle(document.querySelector('.ll-stage-heading h2')).fontSize, pageTitle: getComputedStyle(document.querySelector('.lifeledger h1')).fontSize } };
  });
  assert.equal(await page.locator('.ll-asset-account').count(), 3); assert.equal(await page.locator('.ll-home-summary .ll-stat').count(), 4);
  assert.ok(layout.assets.bottom <= layout.left.y && layout.left.x < layout.right.x && layout.summary.bottom <= layout.guide.y && layout.header.bottom <= layout.nav.y);
  assert.equal(layout.background, 'rgb(17, 18, 23)'); assert.equal(layout.income, 'rgb(146, 214, 180)'); assert.equal(layout.countSize, '88px'); record('B版资产、双栏、收支和指南灯顺序', layout);
  stage = '首页直接口播草稿';
  await page.getByLabel('记账原文', { exact: true }).fill('今天早饭八块，午饭二十五块，晚饭三十二，地铁六块，公众号到账三百。'); await page.locator('.ll-entry-card').getByRole('button', { name: '整理成账目', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ll-draft-row').length === 5); assert.equal(requests, 1);
  assert.equal(await page.locator('.ll-draft-row').count(), 5); record('单次请求产生五笔草稿', '真实Obsidian requestUrl请求本机模拟接口，不代表真实模型准确率');
  for (let i = 0; i < 5; i++) await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).nth(i).check();
  await page.getByRole('button', { name: '保存 5 笔', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' });
  const finance = await page.evaluate(() => { const r = globalThis.app.plugins.plugins['lifeledger-next'].repo; return { n: r.state.transactions.size, amount: [...r.state.transactions.values()].reduce((v, t) => v + (t.kind === 'income' ? t.amountCents : -t.amountCents), 0), batches: r.state.batches.length }; });
  assert.equal(finance.n, 5); assert.equal(finance.amount, 22900); assert.ok((await page.locator('.ll-stats').first().innerText()).includes('28,229.00')); record('确认保存与资产同步', finance);
  await page.screenshot({ path: `${evidence}/obsidian-home.png` });
  stage = '日历'; await page.getByRole('button', { name: '账本', exact: true }).click();
  const today = await page.evaluate(() => globalThis.app.plugins.plugins['lifeledger-next'].repo.config.observationStart);
  assert.equal(await page.locator('.ll-today-dot').count(), 1);
  assert.equal(await page.locator('.ll-day[aria-current="date"]').getAttribute('data-date'), today);
  await page.locator(`.ll-day:not([data-date="${today}"])`).first().click();
  assert.notEqual(await page.locator('.ll-day.is-selected').getAttribute('data-date'), today);
  assert.equal(await page.locator('.ll-day.is-today .ll-today-dot').count(), 1);
  await page.getByRole('button', { name: '下个月', exact: true }).click();
  assert.equal(await page.locator('.ll-today-dot').count(), 0);
  await page.getByRole('button', { name: '本月', exact: true }).click();
  assert.equal(await page.locator('.ll-today-dot').count(), 1);
  record('今天标记独立于选中日期和月份', '按本地日期显示金色小点；选择其他日期仍保留，其他月份不误标，返回本月恢复');
  await page.locator(`.ll-day[data-date="${today}"]`).click(); assert.equal(await page.locator('.ll-transaction').count(), 5); await page.screenshot({ path: `${evidence}/obsidian-calendar.png` });
  await page.getByLabel('账户筛选', { exact: true }).selectOption('reserve'); assert.equal(await page.locator('.ll-transaction').count(), 0); await page.getByLabel('账户筛选', { exact: true }).selectOption('');
  record('日历查账与账户筛选', '当天5笔；筛选未用账户时明细与月汇总一同变化，完整度仍为全账户');
  stage = '更正'; await page.getByRole('button', { name: '更正', exact: true }).first().click(); await page.getByLabel('备注', { exact: true }).fill('实机更正备注'); await page.getByLabel('更正说明', { exact: true }).fill('确认保存更正'); await page.getByRole('button', { name: '保存更正', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' });
  assert.ok((await page.locator('.ll-ledger-detail').innerText()).includes('实机更正备注')); record('逐笔更正追加版本', '修改备注后原文和旧版本仍保留');
  stage = '转账待补'; mode = 'transfer'; await page.getByRole('button', { name: '首页', exact: true }).click(); await page.getByRole('button', { name: '口播 / 手动记账', exact: true }).click(); await page.getByLabel('原文', { exact: true }).fill('今天转了五百到备用钱包'); await page.locator('dialog').getByRole('button', { name: '整理成账目', exact: true }).click(); await page.locator('.ll-draft-row').waitFor();
  assert.equal(await page.getByLabel('转出账户', { exact: true }).inputValue(), ''); assert.equal(await page.getByRole('button', { name: '保存 0 笔', exact: true }).isDisabled(), true);
  const activity = await page.evaluate(() => globalThis.app.plugins.plugins['lifeledger-next'].repo.config.defaultAccountId); await page.getByLabel('转出账户', { exact: true }).selectOption(activity); await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).check(); await page.getByRole('button', { name: '保存 1 笔', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' });
  assert.ok((await page.locator('.ll-stats').first().innerText()).includes('28,229.00')); await page.getByRole('button', { name: '撤销最近一批', exact: true }).click(); await page.waitForFunction(() => globalThis.app.plugins.plugins['lifeledger-next'].repo.state.transactions.size === 5); record('转账缺账户、补全、保存与撤销', '无默认转出，两端补齐后同时入账；总资产不变，撤销同时恢复');
  stage = '成本项目'; await page.getByRole('button', { name: '每日成本', exact: true }).click(); await page.getByRole('button', { name: '登记已有物品 / 订阅', exact: true }).click(); await page.getByLabel('名称', { exact: true }).fill('已有电脑'); await page.getByLabel('实付金额（元）', { exact: true }).fill('8000'); await page.getByLabel('实付金额（元）', { exact: true }).press('Tab'); await page.getByLabel('结束日（不包含）', { exact: true }).fill(`${Number(today.slice(0, 4)) + 4}${today.slice(4)}`); await page.getByLabel('结束日（不包含）', { exact: true }).press('Tab'); await page.getByRole('button', { name: '保存项目', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.ll-cost-card').count(), 1); assert.ok((await page.locator('.ll-cost-card').innerText()).includes('5.48')); await page.screenshot({ path: `${evidence}/obsidian-costs.png` }); record('已有项目分摊与不重复扣款', '8000元/四年按真实日历约5.48元每天，登记已有物品未产生新现金流水');
  stage = 'API失败草稿'; mode = 'failure'; await page.getByRole('button', { name: '首页', exact: true }).click(); await page.getByRole('button', { name: '口播 / 手动记账', exact: true }).click(); await page.getByLabel('原文', { exact: true }).fill('这段原文必须保留'); await page.locator('dialog').getByRole('button', { name: '整理成账目', exact: true }).click(); await page.locator('.ll-error').waitFor(); assert.equal(await page.getByLabel('原文', { exact: true }).inputValue(), '这段原文必须保留'); await page.getByRole('button', { name: '保存草稿并关闭', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' }); record('API空回复保留原文', '没有账目入账，草稿可重开');
  stage = '分析和字体'; await page.getByRole('button', { name: '分析', exact: true }).click(); assert.equal(await page.locator('.ll-chart svg').count(), 1); await page.locator('.ll-chart').getByRole('button', { name: '自由', exact: true }).click(); await page.locator('.ll-chart').getByRole('button', { name: '日均', exact: true }).click(); await page.locator('.ll-chart').getByRole('button', { name: '收支', exact: true }).click(); await page.screenshot({ path: `${evidence}/obsidian-analysis.png` }); record('分析切换同源数据', '收支、日均与自由曲线，分类及年度汇总可打开');
  stage = '五页B版样式'; const appearance = [];
  for (const [name, file] of [['首页', 'home-b'], ['账本', 'ledger-b'], ['分析', 'analysis-b'], ['账户', 'accounts-b'], ['每日成本', 'costs-b']]) {
    await page.locator('.ll-nav').getByRole('button', { name, exact: true }).click();
    const style = await page.evaluate(() => { const root = document.querySelector('.lifeledger'); return { background: getComputedStyle(root).backgroundColor, overflow: root.scrollWidth > root.clientWidth + 1, active: document.querySelector('.ll-nav .is-active').textContent }; });
    assert.equal(style.background, 'rgb(17, 18, 23)'); assert.equal(style.overflow, false); assert.equal(style.active, name);
    await page.locator('.lifeledger').screenshot({ path: `${evidence}/${file}.png` }); appearance.push({ name, ...style });
  } record('五个页面统一B版并无横向溢出', appearance);
  await page.locator('.ll-nav').getByRole('button', { name: '首页', exact: true }).click(); await page.locator('.ll-asset-account[data-account-id="reserve"]').click();
  assert.equal(await page.locator('.ll-account-detail h2').textContent(), '备用钱包 · 账户明细'); assert.equal(await page.locator('.ll-account-card').count(), 1); await page.getByRole('button', { name: '查看全部账户', exact: true }).click(); assert.equal(await page.locator('.ll-account-card').count(), 3); record('资产卡进入账户明细', '查看账户、返回全部和原有账户操作保留');
  await size.send('Emulation.setDeviceMetricsOverride', { width: 980, height: 1100, deviceScaleFactor: 1, mobile: false });
  for (const name of ['首页', '账本', '分析', '账户', '每日成本']) {
    await page.locator('.ll-nav').getByRole('button', { name, exact: true }).click(); assert.equal(await page.evaluate(() => { const r = document.querySelector('.lifeledger'); return r.scrollWidth > r.clientWidth + 1; }), false);
  } record('窄Obsidian窗格自适应', '980px窗口中的五页均无横向溢出');
  await size.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
  stage = '图表坐标与查账'; await page.locator('.ll-nav').getByRole('button', { name: '分析', exact: true }).click();
  assert.equal(await page.locator('.ll-chart svg line').count(), 4); const chartPoint = page.locator('.ll-chart svg circle').first(); await chartPoint.focus(); assert.ok((await page.locator('.ll-chart-result').textContent()).includes('收入')); await chartPoint.press('Enter'); assert.equal(await page.locator('.ll-nav .is-active').textContent(), '账本'); assert.ok((await page.locator('.ll-ledger-detail h2').textContent()).includes(today)); record('B版图表坐标、悬停与打开账目', '真实数据坐标轴，键盘聚焦显示中文金额，回车打开对应日期');
  stage = '浅色主题';
  const setTheme = async light => {
    await page.evaluate(light => { document.body.classList.toggle('theme-light', light); document.body.classList.toggle('theme-dark', !light); }, light);
    await page.waitForFunction(light => getComputedStyle(document.querySelector('.lifeledger')).colorScheme === (light ? 'light' : 'dark'), light);
  };
  const beforeTheme = await page.evaluate(() => { const r = app.plugins.plugins['lifeledger-next'].repo; return JSON.stringify({ config: r.config, transactions: [...r.state.transactions], costs: [...r.state.costs], batches: r.state.batches }); });
  await setTheme(true);
  const lightAppearance = [];
  for (const [name, file] of [['首页', 'home'], ['账本', 'ledger'], ['分析', 'analysis'], ['账户', 'accounts'], ['每日成本', 'costs']]) {
    await page.locator('.ll-nav').getByRole('button', { name, exact: true }).click();
    const style = await page.evaluate(() => { const root = document.querySelector('.lifeledger'); return { background: getComputedStyle(root).backgroundColor, overflow: root.scrollWidth > root.clientWidth + 1, active: document.querySelector('.ll-nav .is-active').textContent }; });
    assert.equal(style.background, 'rgb(246, 247, 250)'); assert.equal(style.overflow, false); assert.equal(style.active, name);
    await page.locator('.lifeledger').screenshot({ path: `${evidence}/${file}-light.png` }); lightAppearance.push({ name, ...style });
  }
  record('浅色五页保持布局、导航与无横向溢出', lightAppearance);
  await page.locator('.ll-nav').getByRole('button', { name: '账本', exact: true }).click();
  assert.equal(await page.locator('.ll-today-dot').count(), 1);
  const day = await page.locator('.ll-day.is-selected').evaluate(n => ({ background: getComputedStyle(n).backgroundColor, dot: getComputedStyle(document.querySelector('.ll-today-dot')).backgroundColor }));
  assert.equal(day.background, 'rgb(255, 242, 216)'); assert.equal(day.dot, 'rgb(153, 99, 17)');
  record('浅色日历今天标记与选中日期', day);
  await page.locator('.ll-nav').getByRole('button', { name: '分析', exact: true }).click();
  const chart = await page.evaluate(() => ({ grid: getComputedStyle(document.querySelector('.ll-chart line')).stroke, label: getComputedStyle(document.querySelector('.ll-chart text')).fill, curve: getComputedStyle(document.querySelector('.ll-chart polyline')).stroke }));
  assert.deepEqual(chart, { grid: 'rgb(220, 225, 233)', label: 'rgb(101, 112, 128)', curve: 'rgb(153, 99, 17)' });
  record('浅色SVG坐标与曲线配色', chart);
  await page.locator('.ll-nav').getByRole('button', { name: '首页', exact: true }).click();
  await page.waitForFunction(() => app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage.grid.lightTheme);
  const canvasLight = await page.evaluate(() => { const s = app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage; return { pixel: [...s.grid.ctx.getImageData(0, 0, 1, 1).data], colors: s.grid.colors, count: s.grid.litCount }; });
  assert.deepEqual(canvasLight.pixel, [249, 250, 252, 255]); assert.equal(canvasLight.colors.asset, '#76a7df'); assert.equal(canvasLight.colors.gold, '#d5a245');
  record('浅色Canvas背景、蓝金分段与真实亮格', canvasLight);
  const contrast = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.lifeledger'));
    const luminance = hex => { const rgb = hex.match(/\w\w/g).map(x => parseInt(x, 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
    const results = [];
    for (const ink of ['text', 'muted', 'gold', 'blue', 'green', 'error']) for (const surface of ['bg', 'panel']) {
      const a = luminance(s.getPropertyValue(`--ll-${ink}`).trim().slice(1)), b = luminance(s.getPropertyValue(`--ll-${surface}`).trim().slice(1)); results.push({ ink, surface, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) });
    }
    return results;
  }); assert.ok(contrast.every(x => x.ratio >= 4.5)); record('浅色正文、小字与语义颜色对比度', contrast);
  await page.locator('.ll-nav').getByRole('button', { name: '账户', exact: true }).click(); await page.getByRole('button', { name: '添加账户', exact: true }).click();
  await page.getByRole('button', { name: '保存账户', exact: true }).click(); await page.locator('dialog .ll-error').waitFor();
  const formLight = await page.locator('dialog').evaluate(n => ({ background: getComputedStyle(n).backgroundColor, input: getComputedStyle(n.querySelector('input')).backgroundColor, error: getComputedStyle(n.querySelector('.ll-error')).color }));
  assert.deepEqual(formLight, { background: 'rgb(255, 255, 255)', input: 'rgb(249, 250, 252)', error: 'rgb(163, 61, 57)' });
  await page.locator('dialog').screenshot({ path: `${evidence}/account-dialog-light.png` });
  await page.getByLabel('账户名称', { exact: true }).fill('主题切换中的未保存文字'); await setTheme(false); assert.equal(await page.getByLabel('账户名称', { exact: true }).inputValue(), '主题切换中的未保存文字');
  assert.equal(await page.locator('dialog').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(26, 28, 35)');
  await setTheme(true); assert.equal(await page.getByLabel('账户名称', { exact: true }).inputValue(), '主题切换中的未保存文字'); await page.locator('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  record('浅色账户弹窗、校验错误和主题切换保留输入', formLight);
  await page.locator('.ll-nav').getByRole('button', { name: '每日成本', exact: true }).click(); await page.getByRole('button', { name: '登记已有物品 / 订阅', exact: true }).click();
  assert.equal(await page.locator('dialog').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(255, 255, 255)'); await page.locator('dialog').screenshot({ path: `${evidence}/cost-dialog-light.png` }); await page.locator('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  record('浅色每日成本弹窗', '登记及编辑沿用同一套浅色表单');
  await page.locator('.ll-nav').getByRole('button', { name: '首页', exact: true }).click(); await page.getByRole('button', { name: '口播 / 手动记账', exact: true }).click();
  assert.equal(await page.locator('dialog').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(255, 255, 255)'); await page.getByRole('button', { name: '手动加一笔', exact: true }).click(); await page.locator('dialog').screenshot({ path: `${evidence}/entry-dialog-light.png` });
  await page.getByRole('button', { name: '保存草稿并关闭', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' });
  // The UI-only draft is removed through the repository's normal draft deletion route.
  await page.evaluate(async () => { const r = app.plugins.plugins['lifeledger-next'].repo; const d = r.drafts.find(d => d.status !== 'saved' && !d.text.trim()); if (d) await r.discardDraft(d); });
  record('浅色录入与核对表单', '手动录入沿用原有流程，未保存流水');
  await size.send('Emulation.setDeviceMetricsOverride', { width: 980, height: 1100, deviceScaleFactor: 1, mobile: false });
  for (const name of ['首页', '账本', '分析', '账户', '每日成本']) {
    await page.locator('.ll-nav').getByRole('button', { name, exact: true }).click(); assert.equal(await page.evaluate(() => { const r = document.querySelector('.lifeledger'); return r.scrollWidth > r.clientWidth + 1; }), false);
  }
  record('浅色五页窄窗格', '980px窗口五页均无横向溢出');
  await size.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
  const afterTheme = await page.evaluate(() => { const r = app.plugins.plugins['lifeledger-next'].repo; return JSON.stringify({ config: r.config, transactions: [...r.state.transactions], costs: [...r.state.costs], batches: r.state.batches }); });
  assert.equal(afterTheme, beforeTheme); record('主题切换不改配置、交易、成本和正式批次', '账本与计算结果保持不变');
  await setTheme(false);
  stage = '重载恢复'; await page.evaluate(async () => { const app = globalThis.app; await app.plugins.disablePlugin('lifeledger-next'); await app.plugins.enablePlugin('lifeledger-next'); await app.plugins.plugins['lifeledger-next'].open(); }); await page.locator('.lifeledger h1').waitFor();
  const recovery = await page.evaluate(() => { const p = globalThis.app.plugins.plugins['lifeledger-next']; return { transactions: p.repo.state.transactions.size, costs: p.repo.state.costs.size, pending: p.repo.drafts.filter(d => d.status !== 'saved').length, issues: p.repo.state.issues, assetsText: document.querySelector('.ll-stats').textContent }; });
  assert.equal(recovery.transactions, 5); assert.equal(recovery.costs, 1); assert.equal(recovery.pending, 1); assert.equal(recovery.issues.length, 0); record('禁用重启后恢复', recovery);
  stage = '布局与生命周期'; const overflow = await page.evaluate(() => { const root = document.querySelector('.lifeledger'); return root.scrollWidth > root.clientWidth + 1; }); assert.equal(overflow, false);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  let settingsPage;
  for (let attempt = 0; attempt < 30; attempt++) { for (const candidate of context.pages()) if (await candidate.locator('.lifeledger-settings').count()) settingsPage = candidate; if (settingsPage) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok(settingsPage, '原生设置窗口未打开'); await settingsPage.locator('.lifeledger-settings').waitFor(); assert.equal(await settingsPage.locator('.lifeledger-settings input[type=password]').count(), 1); await settingsPage.screenshot({ path: `${evidence}/obsidian-settings.png` }); await page.evaluate(() => globalThis.app.setting.close()); record('Obsidian设置与密钥入口', 'Obsidian 1.14.4的独立设置窗口可打开；密码输入，使用合成密钥');
  stage = '设置窗口刷新后主题回调';
  for (let iteration = 0; iteration < 8; iteration++) {
    await page.evaluate(() => app.plugins.plugins['lifeledger-next'].openSettings()); let popup;
    for (let attempt = 0; attempt < 30; attempt++) { for (const candidate of context.pages()) if (!candidate.isClosed() && await candidate.locator('.lifeledger-settings').isVisible().catch(() => false)) popup = candidate; if (popup) break; await new Promise(r => setTimeout(r, 100)); }
    assert.ok(popup); await popup.getByRole('button', { name: '保存连接配置', exact: true }).click();
    await popup.waitForFunction(() => document.querySelector('.lifeledger-settings')?.getAttribute('aria-busy') !== 'true');
    await page.evaluate(() => app.setting.close()); await new Promise(r => setTimeout(r, 100));
    await setTheme(true); await page.waitForFunction(() => app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage.grid.lightTheme);
    await setTheme(false); await page.waitForFunction(() => !app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage.grid.lightTheme);
    assert.equal(errors.length, 0);
  }
  record('独立设置窗口刷新后关闭及切换主题无脚本错误', '连续八轮真实保存连接、关闭弹窗、明暗切换；样式读取和主题观察器绑定宿主窗口');
  stage = '完整原版动画';
  await page.evaluate(async () => {
    const p = globalThis.app.plugins.plugins['lifeledger-next']; await p.changeRoot('动画验证'); const c = p.repo.config;
    c.accounts = [{ id: 'animation-account', name: '动画验证账户', kind: 'asset', openingCents: 0, openingDate: c.observationStart, freedomBps: 10000, aliases: [] }]; c.defaultAccountId = 'animation-account'; c.estimateDailyCents = 5000; c.animation = 'full'; c.sound = true;
    const date = new Date(`${c.observationStart}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); c.displayEnd = date.toISOString().slice(0, 10);
    await p.repo.saveConfig(c); await p.refresh();
  });
  await page.getByRole('button', { name: '口播 / 手动记账', exact: true }).click(); await page.getByRole('button', { name: '手动加一笔', exact: true }).click(); await page.getByLabel('类型', { exact: true }).selectOption('income'); await page.getByLabel('金额（元）', { exact: true }).fill('50'); await page.getByLabel('金额（元）', { exact: true }).press('Tab'); await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).check(); await page.getByRole('button', { name: '保存 1 笔', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' });
  await page.waitForFunction(() => { const s = globalThis.app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage; return s.grid.camera.scale > 1.3 && s.grid.rafId !== null && s.audio.ctx?.state === 'running'; });
  const animation = await page.evaluate(() => { const s = globalThis.app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage; return { scale: s.grid.camera.scale, audioState: s.audio.ctx?.state, pending: s.grid.waiters.size }; }); assert.equal(animation.audioState, 'running');
  await setTheme(true); await page.waitForFunction(() => app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage.grid.lightTheme);
  assert.equal(await page.evaluate(() => app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage.grid.colors.surface), '#f9fafc');
  record('动画中切换浅色保留追焦与播放', '只更新实例色板，不取消动画或写账本');
  await page.getByRole('button', { name: '口播 / 手动记账', exact: true }).click(); await page.getByRole('button', { name: '保存草稿并关闭', exact: true }).click();
  await page.locator('.ll-celebration:not([hidden])').waitFor({ timeout: 10000 }); await page.screenshot({ path: `${evidence}/obsidian-celebration.png` }); record('点亮、追焦、音效调用和阶段庆祝', { ...animation, inputDuringAnimation: true, humanListening: false });
  await page.getByRole('button', { name: '跳过动画', exact: true }).click();
  await page.getByRole('button', { name: '回看刚才的变化', exact: true }).click(); await page.waitForFunction(() => globalThis.app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage.grid.waiters.size > 0);
  await page.getByRole('button', { name: '跳过动画', exact: true }).click(); const skipped = await page.evaluate(() => { const s = globalThis.app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage; return { frames: s.grid.rafId, waits: s.grid.waiters.size, animations: s.grid.animations.size }; }); assert.deepEqual(skipped, { frames: null, waits: 0, animations: 0 }); record('跳过取消动画与等待', skipped);
  await page.getByRole('button', { name: '撤销最近一批', exact: true }).click(); await page.waitForFunction(() => { const s = globalThis.app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage; return s.grid.camera.scale > 1.3 && s.audio.ctx?.state === 'running'; });
  await page.screenshot({ path: `${evidence}/obsidian-extinguish.png` }); record('撤销驱动真实熄灭', '保存前1格，撤销后0格，播放原版熄灭与追焦');
  const disposal = await page.evaluate(async () => {
    const a = globalThis.app, view = a.workspace.getLeavesOfType('lifeledger-next-view')[0].view, s = view.ui.stage;
    await a.plugins.disablePlugin('lifeledger-next'); await new Promise(r => setTimeout(r, 50));
    const oldPalette = s.grid.colors.surface; document.body.classList.remove('theme-light'); document.body.classList.add('theme-dark'); await new Promise(r => setTimeout(r, 50));
    return { frames: s.grid.rafId, waits: s.grid.waiters.size, audio: s.audio.ctx.state, disposed: s.disposed, paletteUnchangedAfterDestroy: s.grid.colors.surface === oldPalette };
  }); assert.deepEqual(disposal, { frames: null, waits: 0, audio: 'closed', disposed: true, paletteUnchangedAfterDestroy: true }); record('禁用释放RAF、等待、音频与主题监听', disposal);
  assert.equal(errors.length, 0); record('脚本与桌面布局', { scriptErrors: errors.length, overflow });
  await writeFile(`${evidence}/obsidian-ui.json`, JSON.stringify({ date: new Date().toISOString(), kind: 'Obsidian 1.14.4 isolated desktop + synthetic API', vault, requests, checks, scriptErrors: errors, realApi: false, realTypeless: false }, null, 2));
  console.log(`完成 ${checks.length} 项隔离实机检查`);
} catch (error) {
  if (page) await page.screenshot({ path: `${evidence}/obsidian-failure.png` }).catch(() => {});
  await writeFile(`${evidence}/obsidian-failure.json`, JSON.stringify({ stage, message: error.message, checks, errors }, null, 2)); throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  model.close();
}
