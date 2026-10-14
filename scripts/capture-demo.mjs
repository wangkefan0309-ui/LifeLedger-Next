import { obsidianRuntime } from './obsidian-runtime.mjs';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const runtime = await obsidianRuntime(), { version } = JSON.parse(await readFile('manifest.json', 'utf8'));
const run = Date.now(), vault = resolve(`validation-vault/demo-${run}`), profile = resolve(`validation-vault/demo-profile-${run}`), appdata = join(profile, 'obsidian');
const evidence = `evidence/demo-v${version}`;
await mkdir(join(vault, '.obsidian/plugins/lifeledger-next'), { recursive: true }); await mkdir(appdata, { recursive: true }); await mkdir(evidence, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(file, join(vault, '.obsidian/plugins/lifeledger-next', file));
await writeFile(join(vault, '.obsidian/community-plugins.json'), '[]');
await writeFile(join(vault, '.obsidian/app.json'), '{"safeMode":false}');
await writeFile(join(vault, '演示说明.md'), '# LifeLedger 演示\n所有账户、金额、流水均为虚拟数据。未配置 API 或密钥。\n');
await writeFile(join(appdata, 'obsidian.json'), JSON.stringify({ vaults: { 'lifeledger-demo': { path: vault, open: true, ts: run } } }));
await copyFile(runtime.asar, join(appdata, runtime.asarName));
let child, browser; const errors = [], images = [];
try {
  child = spawn(runtime.executable, [`--user-data-dir=${appdata}`, '--remote-debugging-port=9235', '--no-sandbox'], { env: { ...process.env, APPDATA: profile }, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9235', { timeout: 1000 }); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
  assert.ok(browser); const context = browser.contexts()[0]; let page;
  for (let i = 0; i < 40; i++) { page = context.pages().find(p => p.url().startsWith('app://')); if (page) break; await new Promise(r => setTimeout(r, 200)); }
  assert.ok(page); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => globalThis.app?.workspace?.layoutReady, undefined, { timeout: 20000 });
  assert.equal(resolve(await page.evaluate(() => app.vault.adapter.getBasePath())), vault);
  const trust = page.getByText('信任仓库作者并启用插件', { exact: true }); if (await trust.isVisible().catch(() => false)) await trust.click();
  await page.evaluate(async () => {
    await app.plugins.enablePlugin('lifeledger-next'); const p = app.plugins.plugins['lifeledger-next'], c = p.repo.config, today = c.observationStart;
    const addDays = n => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    await p.repo.saveConfig({ ...c, animation: 'off', estimateDailyCents: 5000, defaultAccountId: 'wx', accounts: [
      { id: 'wx', name: '微信', aliases: [], kind: 'asset', openingCents: 300000, openingDate: today, freedomBps: 10000 },
      { id: 'ali', name: '支付宝', aliases: [], kind: 'asset', openingCents: 500000, openingDate: today, freedomBps: 10000 },
      { id: 'savings', name: '储蓄账户', aliases: [], kind: 'asset', openingCents: 2000000, openingDate: today, freedomBps: 10000 }
    ] });
    const entries = [['早餐', 800, 'food'], ['午饭', 2500, 'food'], ['地铁', 600, 'transport'], ['GPT 月度会员', 14000, 'subscription'], ['创作收入', 30000, 'creation']];
    const events = entries.map(([note, amountCents, categoryId], i) => ({ type: 'transaction.put', expected: 0, value: {
      id: `demo-${i}`, version: 1, batchId: 'demo', draftId: null, rowId: null, kind: i === 4 ? 'income' : 'expense', date: today, dateRange: null,
      amountCents, accountId: 'wx', fromAccountId: null, toAccountId: null, debtAccountId: null, categoryId, relatedId: null, incomeSource: 'active',
      note, sourceQuote: note, originalText: '公开演示虚拟数据', corrections: []
    } }));
    events.push({ type: 'cost.put', expected: 0, value: { id: 'demo-member', version: 1, batchId: 'demo', transactionId: 'demo-3', name: 'GPT 月度会员', kind: 'subscription', amountCents: 14000, residualCents: 0, start: today, end: addDays(30), stoppedOn: null, autoRenew: true, adjustmentNotes: [] } });
    await p.repo.commit(events, 'demo-fixture', '公开演示虚拟账目'); await p.open();
  });
  const size = await context.newCDPSession(page);
  await size.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1700, deviceScaleFactor: 1, mobile: false });
  const overflowHeight = await page.locator('.lifeledger').evaluate(n => Math.max(0, n.scrollHeight - n.clientHeight));
  if (overflowHeight) await size.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1700 + overflowHeight + 20, deviceScaleFactor: 1, mobile: false });
  const before = await page.evaluate(() => JSON.stringify(app.plugins.plugins['lifeledger-next'].repo.exportBackup().config));
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction(theme => document.querySelector('.lifeledger')?.dataset.theme === theme && app.workspace.getLeavesOfType('lifeledger-next-view')[0].view.ui.stage.grid.lightTheme === (theme === 'light'), theme);
    assert.equal(await page.locator('.lifeledger h1').textContent(), '把账记清楚，把日子过明白');
    assert.equal(await page.locator('.lifeledger').evaluate(n => n.scrollWidth > n.clientWidth + 1), false);
    await page.locator('.lifeledger').evaluate(n => { n.scrollTop = 0; });
    const path = `${evidence}/home-${theme}.png`; await page.locator('.lifeledger').screenshot({ path });
    images.push({ file: path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
  assert.equal(await page.evaluate(() => JSON.stringify(app.plugins.plugins['lifeledger-next'].repo.exportBackup().config)), before);
  await page.getByRole('button', { name: '设置', exact: true }).click(); let settings;
  for (let i = 0; i < 40; i++) { for (const p of context.pages()) if (!p.isClosed() && await p.getByLabel('首页标语', { exact: true }).isVisible().catch(() => false)) settings = p; if (settings) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok(settings);
  const rows = settings.locator('.lifeledger-settings .setting-item');
  const start = await rows.filter({ hasText: '首页与外观' }).first().boundingBox(), end = await rows.filter({ has: settings.getByRole('button', { name: '保存首页与外观', exact: true }) }).boundingBox();
  await settings.screenshot({ path: `${evidence}/appearance-settings.png`, clip: { x: start.x, y: start.y, width: start.width, height: end.y + end.height - start.y } });
  await page.evaluate(() => app.setting.close()); assert.equal(errors.length, 0, JSON.stringify(errors));
  await writeFile(`${evidence}/capture.json`, JSON.stringify({ version, date: new Date().toISOString(), vault, slogan: '把账记清楚，把日子过明白', syntheticOnly: true, configuredApi: false, images, scriptErrors: errors }, null, 2));
  console.log(`已拍摄 0.1.8 浅色、深色首页及外观设置；仅含虚拟数据：${evidence}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
