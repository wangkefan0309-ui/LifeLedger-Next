import { obsidianRuntime } from './obsidian-runtime.mjs';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const runtime = await obsidianRuntime(), version = JSON.parse(await readFile('manifest.json', 'utf8')).version;
const run = Date.now(), vault = resolve(`validation-vault/screenshots-${run}`), profile = resolve(`validation-vault/screenshots-profile-${run}`), appdata = join(profile, 'obsidian'), evidence = `evidence/screenshots-v${version}`;
await mkdir(join(vault, '.obsidian/plugins/lifeledger-next'), { recursive: true }); await mkdir(appdata, { recursive: true }); await mkdir(evidence, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(file, join(vault, '.obsidian/plugins/lifeledger-next', file));
await writeFile(join(vault, '.obsidian/community-plugins.json'), '["lifeledger-next"]'); await writeFile(join(vault, '.obsidian/app.json'), '{"safeMode":false,"trashOption":"local"}');
await writeFile(join(appdata, 'obsidian.json'), JSON.stringify({ vaults: { 'lifeledger-screenshots': { path: vault, open: true, ts: run } } })); await copyFile(runtime.asar, join(appdata, runtime.asarName));
let mode = 'normal', requests = 0; const summaries = [];
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw), content = body.messages[1].content;
  assert.equal(request.url, '/chat/completions'); assert.ok(Array.isArray(content));
  const input = JSON.parse(content[0].text), imageCount = content.filter(part => part.type === 'image_url').length;
  assert.equal(imageCount, input.screenshots.length); assert.ok(content.filter(part => part.type === 'image_url').every(part => part.image_url.url.startsWith('data:image/png;base64,')));
  summaries.push({ imageCount, model: body.model, guidance: input.guidance }); requests++;
  if (mode === 'unsupported') { response.statusCode = 400; response.end('{}'); return; }
  if (mode === 'delayed') await new Promise(resolve => setTimeout(resolve, 350));
  const base = { kind: 'expense', date: null, date_range: null, currency: 'CNY', amount: '20.00', account_id: 'ali', from_account_id: null, to_account_id: null, debt_account_id: null, category_id: null, related_id: null, income_source: 'other', note: '零钱支出', source_quote: '零钱支出 -20.00', amount_quote: '-20.00', issues: ['消费用途待补'], cost: null, received_amount: null, received_amount_quote: null };
  const images = input.screenshots.map(({ image_index }) => {
    const entries = [{ ...base }];
    if (mode === 'mixed') entries.push({ ...base, kind: 'income', date: input.date, source_quote: '收入 +60.00', amount: '60.00', amount_quote: '+60.00' }, { ...base, source_quote: '零钱余额：1000.00', amount: '1000.00', amount_quote: '1000.00' }, { ...base, source_quote: '待支付 -80.00', amount: '80.00', amount_quote: '-80.00' }, { ...base, date: '2026-10-01', source_quote: '历史打车 -30.00', amount: '30.00', amount_quote: '-30.00' });
    return { image_index, text: entries.map(entry => entry.source_quote).join('\n'), entries, excluded: [] };
  });
  const result = mode === 'malformed' ? { version: 1, images, complete_dates: [input.date] } : { version: 1, images };
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser, child, page, stage = '启动'; const checks = [], errors = [];
const record = (name, detail = '符合预期') => { checks.push({ name, detail, passed: true }); console.log(`通过：${name}`); };
try {
  child = spawn(runtime.executable, [`--user-data-dir=${appdata}`, '--remote-debugging-port=9242', '--no-sandbox'], { env: { ...process.env, APPDATA: profile }, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9242', { timeout: 1000 }); break; } catch { await new Promise(resolve => setTimeout(resolve, 300)); } }
  assert.ok(browser); const context = browser.contexts()[0];
  for (let i = 0; i < 40; i++) { page = context.pages().find(page => page.url().startsWith('app://')); if (page) break; await new Promise(resolve => setTimeout(resolve, 200)); }
  assert.ok(page); page.on('pageerror', error => errors.push({ stage, message: error.message, stack: error.stack }));
  await page.waitForFunction(() => globalThis.app?.workspace?.layoutReady, undefined, { timeout: 20000 }); assert.equal(resolve(await page.evaluate(() => app.vault.adapter.getBasePath())), vault);
  const trust = page.getByText('信任仓库作者并启用插件', { exact: true }); if (await trust.isVisible().catch(() => false)) await trust.click();
  await page.evaluate(async ({ baseUrl }) => {
    await app.plugins.enablePlugin('lifeledger-next'); const p = app.plugins.plugins['lifeledger-next'];
    const c = p.repo.config, date = c.observationStart;
    await p.repo.saveConfig({ ...c, animation: 'off', estimateDailyCents: 5000, defaultAccountId: 'wx', accounts: [{ id: 'wx', name: '微信', aliases: ['微信钱包'], kind: 'asset', openingCents: 2000000, openingDate: date, freedomBps: 0 }, { id: 'ali', name: '支付宝', aliases: [], kind: 'asset', openingCents: 1000000, openingDate: date, freedomBps: 0 }] });
    p.deviceSettings.api.baseUrl = baseUrl; p.deviceSettings.api.model = 'synthetic-vision-model'; p.app.secretStorage.setSecret(p.deviceSettings.api.secretId, 'synthetic-key-only'); await p.saveData(p.deviceSettings); await p.open();
  }, { baseUrl }); await page.locator('.lifeledger').waitFor();
  const size = await context.newCDPSession(page); await size.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
  const pngData = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 520; c.height = 500; const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#222222'; g.font = '28px sans-serif'; ['虚拟截图验证', '微信零钱账单', '零钱支出  -20.00', '只用于开发检查'].forEach((line, i) => g.fillText(line, 32, 70 + i * 100)); return c.toDataURL('image/png'); });
  const png = Buffer.from(pngData.split(',')[1], 'base64'), original = join(vault, '虚拟截图.png'); await writeFile(original, png);
  const modal = () => page.locator('dialog');
  const close = async () => { await modal().getByRole('button', { name: '关闭', exact: true }).click(); await modal().waitFor({ state: 'detached' }); };
  const open = async () => { await page.locator('.ll-entry-card').getByRole('button', { name: '截图记账', exact: true }).click(); await modal().waitFor(); };
  const upload = async () => { await page.getByLabel('选择记账截图', { exact: true }).setInputFiles(original); await page.locator('.ll-image-preview').waitFor(); };
  const identify = async () => { await modal().getByRole('button', { name: '识别截图', exact: true }).click(); await page.locator('.ll-draft-row').first().waitFor(); await page.waitForFunction(() => !document.querySelector('.ll-image-preview')); };
  const count = async () => page.evaluate(() => app.plugins.plugins['lifeledger-next'].repo.state.transactions.size);
  const persisted = async () => page.evaluate(() => JSON.stringify(app.plugins.plugins['lifeledger-next'].repo.exportBackup()));

  stage = '选择图片'; await page.getByLabel('记账原文', { exact: true }).fill('未整理的口播保留'); await open(); await upload(); assert.equal(requests, 0); assert.equal(await count(), 0); record('首页独立截图入口，选择文件不发请求且不改账');
  await page.getByLabel('图片 1 所属账户', { exact: true }).selectOption('wx'); await page.getByLabel('截图补充说明（可选）').fill('这20元我想补充用途');
  await page.waitForTimeout(450); assert.ok(!(await persisted()).includes(png.toString('base64'))); assert.ok(!(await persisted()).includes('data:image/')); record('识别前补充说明可保存，图片编码不进入草稿或备份');
  for (const light of [false, true]) { await page.evaluate(light => { document.body.classList.toggle('theme-light', light); document.body.classList.toggle('theme-dark', !light); }, light); await modal().screenshot({ path: `${evidence}/upload-${light ? 'light' : 'dark'}.png` }); }
  record('临时预览和上传表单明暗主题可用');
  stage = '识别修改'; await identify(); assert.equal(requests, 1); assert.equal(await page.getByLabel('账户', { exact: true }).inputValue(), 'wx'); assert.equal(await page.getByLabel('金额（元）', { exact: true }).inputValue(), '20.00'); assert.equal(await page.getByLabel('备注', { exact: true }).inputValue(), '零钱支出'); assert.equal(await page.getByLabel('分类', { exact: true }).inputValue(), ''); assert.equal(await count(), 0); record('识别只生成20元草稿，指定账户优先，未知用途不猜');
  assert.equal(await page.locator('.ll-image-preview').count(), 0); assert.deepEqual(await readFile(original), png); assert.ok((await persisted()).includes('零钱支出 -20.00')); assert.ok(!(await persisted()).includes('data:image/')); record('识别成功释放临时图片，原文件保留，草稿只保留识别文字');
  await page.getByLabel('备注', { exact: true }).fill('打车'); await page.getByLabel('分类', { exact: true }).selectOption('transport'); await page.getByLabel('已核对这笔金额、账户和疑问').check(); await page.getByLabel('备注', { exact: true }).fill('打车去学校'); await page.getByLabel('备注', { exact: true }).blur(); assert.equal(await page.getByLabel('已核对这笔金额、账户和疑问').isChecked(), false); record('识别后补用途和分类，修改会撤销核对');
  assert.ok(!(await modal().innerText()).includes('消费用途待补')); await modal().screenshot({ path: `${evidence}/review-light.png` }); await page.getByLabel('已核对这笔金额、账户和疑问').check(); await page.getByRole('button', { name: '保存 1 笔', exact: true }).click(); await modal().waitFor({ state: 'detached' }); assert.equal(await count(), 1);
  const saved = await page.evaluate(() => { const r = app.plugins.plugins['lifeledger-next'].repo; return { tx: [...r.state.transactions.values()][0], complete: r.state.days.get(r.config.observationStart)?.complete ?? false }; }); assert.equal(saved.tx.amountCents, 2000); assert.equal(saved.tx.note, '打车去学校'); assert.equal(saved.tx.categoryId, 'transport'); assert.equal(saved.complete, false); record('核对后只扣微信20元，截图不自动确认全天记完');
  assert.equal(await page.getByLabel('记账原文', { exact: true }).inputValue(), '未整理的口播保留'); record('截图录入保留首页未整理口播');
  stage = '范围限制'; mode = 'mixed'; await open(); await upload(); await page.getByLabel('图片 1 所属账户').selectOption('ali'); await identify(); assert.equal(await page.locator('.ll-draft-row').count(), 1); assert.equal(await page.getByLabel('账户', { exact: true }).inputValue(), 'ali'); assert.ok((await modal().innerText()).includes('余额、汇总或未完成交易')); assert.ok((await modal().innerText()).includes('不在指定日期')); record('日期与只支出限制由程序执行，余额、未支付和其他日期不记流水');
  await page.getByRole('button', { name: '保存草稿并关闭', exact: true }).click(); await modal().waitFor({ state: 'detached' }); await page.getByRole('button', { name: '继续草稿：截图账目', exact: true }).click(); assert.equal(await page.locator('.ll-image-preview').count(), 0); assert.equal(await page.locator('.ll-draft-row').count(), 1); await close(); record('截图草稿重开只恢复识别文字及可编辑行，不恢复图片');
  stage = '错误恢复'; mode = 'unsupported'; await open(); await upload(); await page.getByLabel('截图补充说明（可选）').fill('接口失败后保留的说明'); await page.getByRole('button', { name: '识别截图', exact: true }).click(); await page.getByText('图片请求被接口拒绝', { exact: false }).waitFor(); assert.equal(await page.locator('.ll-image-preview').count(), 1); assert.equal(await count(), 1); record('模型不支持图片时就地提示，临时图片和说明可重试');
  mode = 'normal'; await identify(); assert.equal(await page.getByLabel('账户', { exact: true }).inputValue(), ''); assert.ok((await modal().innerText()).includes('收支账户待补')); assert.equal(await page.getByRole('button', { name: '保存 0 笔', exact: true }).isDisabled(), true); await close(); record('未指定且截图未明确账户时不套默认微信');
  stage = '无效输入'; await open(); await page.getByLabel('选择记账截图').setInputFiles({ name: '伪图片.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload="alert(1)"/>') }); await page.getByText('请选择 PNG、JPEG 或 WebP', { exact: false }).waitFor(); assert.equal(await page.locator('.ll-image-preview').count(), 0); await close(); record('伪图片和SVG在本地拒绝，不能触发识别');
  stage = '粘贴'; await open(); const beforePaste = requests;
  await page.evaluate(data => { const bytes = Uint8Array.from(atob(data.split(',')[1]), char => char.charCodeAt(0)), transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'paste.png', { type: 'image/png' })); document.querySelector('dialog').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })); }, pngData); await page.locator('.ll-image-preview').waitFor(); assert.equal(requests, beforePaste);
  await size.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 1000, deviceScaleFactor: 1, mobile: false }); assert.ok(await modal().evaluate(node => node.scrollWidth <= node.clientWidth + 1)); await modal().screenshot({ path: `${evidence}/upload-narrow.png` }); await size.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
  await close(); assert.equal(requests, beforePaste); record('粘贴事件可选图，窄窗格无溢出，关闭不上传');
  stage = '拖入重叠'; await open();
  await page.evaluate(data => { const bytes = Uint8Array.from(atob(data.split(',')[1]), char => char.charCodeAt(0)), transfer = new DataTransfer(); for (let i = 0; i < 2; i++) transfer.items.add(new File([bytes], `drop-${i}.png`, { type: 'image/png' })); document.querySelector('dialog').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })); }, pngData); await page.waitForFunction(() => document.querySelectorAll('.ll-image-preview').length === 2); await page.getByLabel('图片 1 所属账户').selectOption('wx'); await page.getByLabel('图片 2 所属账户').selectOption('wx'); await identify(); assert.equal(await page.locator('.ll-draft-row').count(), 2); assert.ok((await modal().innerText()).includes('重叠')); await page.locator('.ll-draft-row').last().getByRole('button', { name: '移除这行' }).click(); assert.equal(await page.locator('.ll-draft-row').count(), 1); await close(); record('拖入多图，重叠提示可手工移除，不自动重复入账');
  stage = '迟到回复'; mode = 'delayed'; await open(); await upload(); await page.getByLabel('截图补充说明（可选）').fill('关闭中的图片识别'); await page.getByRole('button', { name: '识别截图', exact: true }).click(); await page.waitForTimeout(30); await close(); await page.waitForTimeout(500); assert.equal(await count(), 1); assert.equal(await page.locator('dialog').count(), 0); record('请求期间关闭释放图片，迟到回复不入账');
  stage = '禁用恢复'; await page.evaluate(async () => { await app.plugins.disablePlugin('lifeledger-next'); await app.plugins.enablePlugin('lifeledger-next'); await app.plugins.plugins['lifeledger-next'].open(); }); await page.locator('.lifeledger').waitFor(); assert.equal(await count(), 1); assert.ok(!(await persisted()).includes('data:image/')); record('插件重开保存账目和OCR文字，无图片编码');
  const recovery = await page.evaluate(async () => { const p = app.plugins.plugins['lifeledger-next'], backup = p.repo.exportBackup(); await p.changeRoot('截图恢复验证'); await p.repo.restoreBackup(backup); await p.refresh(); return { tx: p.repo.state.transactions.size, screenshotDrafts: p.repo.drafts.filter(d => d.inputMode === 'screenshots').length, issues: p.repo.state.issues.length, encoded: JSON.stringify(p.repo.exportBackup()).includes('data:image/') }; }); assert.equal(recovery.tx, 1); assert.ok(recovery.screenshotDrafts > 0); assert.equal(recovery.issues, 0); assert.equal(recovery.encoded, false); record('备份恢复保留截图文字和更正记录，仍无图片', recovery);
  assert.deepEqual(await readFile(original), png); assert.ok(!(await page.evaluate(() => app.vault.getFiles().map(file => file.path))).some(path => /截图恢复验证\/.*\.(png|jpg|webp)$/i.test(path))); record('账本不创建图片附件，原输入文件未被删除或修改');
  assert.equal(errors.length, 0, JSON.stringify(errors)); record('全流程没有页面脚本错误');
  await writeFile(`${evidence}/screenshots-ui.json`, JSON.stringify({ version, date: new Date().toISOString(), vault, checks, scriptErrors: errors, requests, requestSummaries: summaries, realVisionApi: false, realClipboard: false, realFinancialData: false }, null, 2)); console.log(`完成 ${checks.length} 项截图隔离检查`);
} catch (error) { if (page) await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => {}); await writeFile(`${evidence}/failure.json`, JSON.stringify({ stage, message: error.message, checks, errors }, null, 2)); throw error; }
finally { if (browser) await browser.close().catch(() => {}); if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); server.close(); }
