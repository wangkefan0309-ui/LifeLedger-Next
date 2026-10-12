import { obsidianRuntime } from './obsidian-runtime.mjs';
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const runtime = await obsidianRuntime();
const phase = process.env.AUDIT_PHASE || 'fixed'; const evidence = `evidence/adversarial-${phase}`; const runId = String(Date.now()); const vault = resolve(`validation-vault/adversarial-${runId}`), profile = resolve(`validation-vault/profile-${runId}`), appdata = join(profile, 'obsidian');
await mkdir(join(vault, '.obsidian/plugins/lifeledger-next'), { recursive: true }); await mkdir(appdata, { recursive: true }); await mkdir(evidence, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(join(phase.startsWith('baseline') ? 'dist/lifeledger-next' : '.', file), join(vault, '.obsidian/plugins/lifeledger-next', file));
await writeFile(join(vault, '.obsidian/community-plugins.json'), '["lifeledger-next"]'); await writeFile(join(vault, '.obsidian/app.json'), '{"safeMode":false,"trashOption":"local"}');
await writeFile(join(vault, '测试说明.md'), '# 隔离验证\n只含虚拟数据；本机模拟 API，不使用真实密钥。\n');
await writeFile(join(appdata, 'obsidian.json'), JSON.stringify({ vaults: { 'lifeledger-isolated': { path: vault, open: true, ts: Date.now() } } }));
await copyFile(runtime.asar, join(appdata, runtime.asarName));
let requests = 0, mode = 'daily', delayMs = 0;
const model = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/models') { res.end(JSON.stringify({ data: [{ id: 'isolated-model' }] })); return; }
  requests++; if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  if (mode === 'offline') { res.statusCode = 503; res.end(JSON.stringify({error: '模拟服务不可用'})); return; }
  const body = JSON.parse(text), user = JSON.parse(body.messages[1].content), today = user.context.today;
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
  child = spawn(runtime.executable, [`--user-data-dir=${appdata}`, '--remote-debugging-port=9234', '--no-sandbox'], { env: { ...process.env, APPDATA: profile }, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 30; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9234', { timeout: 1000 }); break; } catch { await new Promise(r => setTimeout(r, 400)); } }
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

  const pause = ms => new Promise(r => setTimeout(r, ms));
  const snapshot = () => page.evaluate(() => ({ root: app.plugins.plugins['lifeledger-next'].repo.root, files: app.vault.getAllLoadedFiles().map(f => f.path).sort(), transactions: app.plugins.plugins['lifeledger-next'].repo.state.transactions.size }));
  const test = async (name, fn) => { stage = name; try { const detail = await fn(); record(name, detail ?? '符合预期'); } catch (e) { checks.push({ name, passed: false, message: e.message }); console.log(`失败：${name}：${e.message}`); } };
  const settings = async () => {
    await page.evaluate(() => app.plugins.plugins['lifeledger-next'].openSettings());
    for (let i = 0; i < 40; i++) { const p = context.pages().find(p => !p.isClosed() && p !== page && p.url() === 'about:blank'); if (p && await p.locator('.lifeledger-settings').isVisible().catch(() => false)) return p; await pause(100); }
    throw new Error('设置窗口未打开');
  };
  const closeSettings = async () => {
    for (const popup of context.pages()) if (!popup.isClosed() && await popup.locator('.lifeledger-settings').count()) {
      await popup.waitForFunction(() => document.querySelector('.lifeledger-settings')?.getAttribute('aria-busy') !== 'true');
    }
    await page.evaluate(() => app.setting.close()); await pause(200);
  };
  const settingRow = (p, name) => p.locator('.setting-item').filter({ has: p.locator('.setting-item-name').getByText(name, { exact: true }) });
  await test('首次打开保持空账本，不创建账本目录', async () => { const s = await snapshot(); assert.equal(s.transactions, 0); assert.ok(!s.files.some(p => p.startsWith('LifeLedger'))); });
  await test('目录逐字输入、删除、关闭均无文件副作用', async () => {
    const before = await snapshot(), p = await settings(), field = settingRow(p, '账本目录').locator('input');
    await field.fill('');
    for (const ch of 'Finance/AnnualLedger') { await field.pressSequentially(ch); await pause(25); assert.deepEqual((await snapshot()).files, before.files); }
    for (let i=1; i<='财务记录/年度账本'.length; i++) { await field.fill('财务记录/年度账本'.slice(0,i)); assert.deepEqual((await snapshot()).files,before.files); }
    await field.press('Backspace'); await closeSettings(); assert.equal((await snapshot()).root, before.root); assert.deepEqual((await snapshot()).files, before.files);
  });
  await test('关闭空录入框不会生成空草稿和目录', async () => { const before = await snapshot(); await page.getByRole('button', { name: '口播 / 手动记账', exact: true }).click(); await page.locator('dialog').getByRole('button', { name: '关闭', exact: true }).click(); await pause(550); assert.deepEqual((await snapshot()).files, before.files); });
  await test('未保存连接配置不会改变运行中的 API', async () => { const before = await page.evaluate(() => app.plugins.plugins['lifeledger-next'].deviceSettings.api.baseUrl); const p = await settings(); await settingRow(p, 'API 服务地址').locator('input').fill('https://accidental.invalid'); await closeSettings(); const after = await page.evaluate(() => app.plugins.plugins['lifeledger-next'].deviceSettings.api.baseUrl); assert.equal(after, before); });
  await test('目录遇到同名文件会拒绝，旧目录及设置保留', async () => {
    await page.evaluate(async () => { if (!app.vault.getAbstractFileByPath('目录冲突')) await app.vault.create('目录冲突', '测试文件，不能当目录'); });
    const before = (await snapshot()).root, dataBefore = await page.evaluate(async () => app.plugins.plugins['lifeledger-next'].loadData()), p = await settings(); await settingRow(p, '账本目录').locator('input').fill('目录冲突'); await settingRow(p, '账本目录').locator('button').click(); await pause(400); assert.equal((await snapshot()).root, before); assert.deepEqual(await page.evaluate(async () => app.plugins.plugins['lifeledger-next'].loadData()), dataBefore); await closeSettings();
  });
  // Return to an isolated, clean ledger even when the baseline admitted a conflicting path.
  await closeSettings(); await page.evaluate(async () => { await app.plugins.plugins['lifeledger-next'].changeRoot('用户模拟'); });
  await test('首次配置能通过界面建立默认账户', async () => {
    await page.getByRole('button', { name: '添加账户', exact: true }).click(); await page.getByLabel('账户名称', { exact: true }).fill('日常钱包'); await page.getByLabel('期初余额（元）', { exact: true }).fill('1000'); await page.getByLabel('期初余额（元）', { exact: true }).press('Tab'); await page.getByLabel('设为默认收支账户（仅资产账户）').check(); await page.getByRole('button', { name: '保存账户', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' }); assert.ok((await page.locator('.ll-stats').first().innerText()).includes('1,000.00'));
  });
  await test('首页原文关闭标签重开后可恢复，不自动入账', async () => {
    const raw = '今天午饭二十三块，还没有整理。'; await page.getByLabel('记账原文', { exact: true }).fill(raw); await pause(600);
    await page.evaluate(async () => { await app.workspace.getLeavesOfType('lifeledger-next-view')[0].detach(); await app.plugins.plugins['lifeledger-next'].open(); });
    const home = await page.getByLabel('记账原文', { exact: true }).inputValue(); const drafts = await page.evaluate(() => app.plugins.plugins['lifeledger-next'].repo.drafts.map(d => d.text)); assert.ok(home === raw || drafts.includes(raw), '已输入原文丢失'); assert.equal((await snapshot()).transactions, 0);
  });
  await test('已有账户或草稿的目录不被备份恢复覆盖', async () => {
    const result = await page.evaluate(async () => { const plugin = app.plugins.plugins['lifeledger-next'], r = plugin.repo;
      // Use a genuine export with a distinct config, so checksum remains valid.
      const oldName = r.config.accounts[0].name; const old = structuredClone(r.config); await r.saveConfig({ ...r.config, accounts: r.config.accounts.map(a => ({ ...a, name: '备份里的另一个账户' })) }); const valid = r.exportBackup(); await r.saveConfig(old);
      let rejected = false; try { await r.restoreBackup(valid); } catch { rejected = true; } return { rejected, oldName, name: r.config.accounts[0]?.name };
    }); assert.equal(result.rejected, true, '空流水但已有账户的目录被覆盖'); assert.equal(result.name, result.oldName);
  });

  await test('金额录入后按 Tab 能继续到账户字段', async () => {
    await page.getByLabel('记账原文', { exact: true }).fill(''); await page.getByRole('button', { name: '口播 / 手动记账', exact: true }).click();
    await page.locator('dialog').waitFor({ timeout: 3000 }).catch(async () => { throw new Error((await page.locator('.notice').allTextContents()).join('；') || '录入框没有打开'); });
    await page.getByRole('button', { name: '手动加一笔', exact: true }).click(); await page.getByLabel('金额（元）', { exact: true }).fill('12.34'); await page.getByLabel('金额（元）', { exact: true }).press('Tab'); await pause(50);
    const focus = await page.evaluate(() => document.activeElement?.getAttribute('aria-label')); assert.equal(focus, '账户', '重绘导致键盘焦点丢失');
  });
  if (await page.locator('dialog').count()) await page.locator('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await pause(400);
  await test('损坏草稿结构会隔离并显示恢复提示', async () => {
    await page.evaluate(async () => { const r = app.plugins.plugins['lifeledger-next'].repo; const bad = { version: 1, id: 'malformed-audit', revision: 1, text: '午饭二十三', rows: [{ id: 'missing-fields' }], status: 'review' }; const path = `${r.root}/草稿/malformed-audit.md`; if (!app.vault.getAbstractFileByPath(`${r.root}/草稿`)) await app.vault.createFolder(`${r.root}/草稿`); await app.vault.create(path, '# 损坏草稿测试\n\n```lifeledger-json\n'+JSON.stringify(bad)+'\n```\n'); await r.load(); });
    const result = await page.evaluate(() => { const r = app.plugins.plugins['lifeledger-next'].repo; return { issues: r.state.issues.length, admitted: r.drafts.some(d => d.id === 'malformed-audit') }; }); assert.ok(result.issues > 0); assert.equal(result.admitted, false);
  });

  await test('一份坏草稿不阻止健康账目保存，也不偷偷纳入完整备份',async()=>{await page.evaluate(async()=>app.plugins.plugins['lifeledger-next'].refresh());assert.ok((await page.locator('.ll-errors strong').innerText()).includes('健康账目仍可保存'));await page.getByRole('button',{name:'口播 / 手动记账',exact:true}).click();await page.locator('dialog').waitFor();await page.getByRole('button',{name:'手动加一笔',exact:true}).click();await page.getByLabel('金额（元）',{exact:true}).fill('1');await page.getByLabel('金额（元）',{exact:true}).press('Tab');await page.getByLabel('分类',{exact:true}).selectOption('food');await page.getByLabel('已核对这笔金额、账户和疑问',{exact:true}).check();await page.getByRole('button',{name:'保存 1 笔',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});assert.equal((await snapshot()).transactions,1);const rejected=await page.evaluate(()=>{try{app.plugins.plugins['lifeledger-next'].repo.exportBackup();return false;}catch{return true;}});assert.equal(rejected,true);});
  await page.evaluate(async () => { const p = app.plugins.plugins['lifeledger-next'], f = app.vault.getAbstractFileByPath(`${p.repo.root}/草稿/malformed-audit.md`); if(f) await app.fileManager.trashFile(f); await p.refresh(); });

  await test('危险目录输入拒绝，文件和已保存配置不变', async () => {
    const p = await settings(), before = await snapshot(), saved = await page.evaluate(() => app.plugins.plugins['lifeledger-next'].loadData());
    const cases = ['', '../逃逸', 'C:\\外部目录', '/根目录', '.obsidian/plugins', '账本/../笔记', 'CON', '财务/NUL.txt', '尾部.', '财务//重复', 'a/ b', '财务/隐藏?'];
    for (const value of cases) { await settingRow(p, '账本目录').locator('input').fill(value); await settingRow(p, '账本目录').locator('button').click(); await pause(30); assert.deepEqual(await snapshot(), before, value); }
    assert.deepEqual(await page.evaluate(() => app.plugins.plugins['lifeledger-next'].loadData()), saved); await closeSettings(); return { rejected: cases.length };
  });

  await test('目录错误就地显示在设置窗口，用户能知道如何改正',async()=>{const p=await settings();await settingRow(p,'账本目录').locator('input').fill('../逃逸');await settingRow(p,'账本目录').locator('button').click();await p.locator('.ll-settings-error[role=alert]').waitFor();assert.ok((await p.locator('.ll-settings-error').innerText()).includes('数据目录'));await closeSettings();});
  await test('父目录文件和配置目录冲突均不改变当前账本', async () => {
    await page.evaluate(async () => { await app.vault.create('父路径文件', '试验文件'); await app.vault.createFolder('配置冲突'); await app.vault.createFolder('配置冲突/配置.md'); });
    for (const root of ['父路径文件/子账本', '配置冲突']) { const before = await snapshot(), p = await settings(); await settingRow(p, '账本目录').locator('input').fill(root); await settingRow(p, '账本目录').locator('button').click(); await pause(100); assert.deepEqual(await snapshot(), before); await closeSettings(); }
  });
  await test('切换新目录只读取，首个真实保存才创建规范目录', async () => {
    const p = await settings(); await settingRow(p, '账本目录').locator('input').fill('  新年度\\生活账本/  '); await settingRow(p, '账本目录').locator('button').click(); await pause(200); await closeSettings(); const snap = await snapshot(); assert.equal(snap.root, '新年度/生活账本'); assert.ok(!snap.files.some(p => p.startsWith('新年度'))); assert.equal(snap.transactions, 0);
    await page.getByRole('button', { name: '添加账户', exact: true }).click(); await page.getByLabel('账户名称', { exact: true }).fill('试验日常'); await page.getByLabel('期初余额（元）', { exact: true }).fill('1000'); await page.getByLabel('期初余额（元）', { exact: true }).press('Tab'); await page.getByLabel('设为默认收支账户（仅资产账户）').check(); await page.getByRole('button', { name: '保存账户', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' }); assert.ok((await snapshot()).files.includes('新年度/生活账本/配置.md'));
  });

  await test('打开录入框直接聚焦原文，可立即用键盘或 Typeless 输入', async () => { await page.getByRole('button', {name:'口播 / 手动记账',exact:true}).click(); await page.locator('dialog').waitFor(); await pause(50); const focus = await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')); await page.locator('dialog').getByRole('button',{name:'关闭',exact:true}).click(); assert.equal(focus,'原文'); });
  await test('确认零收支只保存完整度，撤销也不生成交易', async () => { await page.getByRole('button', {name:'口播 / 手动记账',exact:true}).click(); await page.locator('dialog').waitFor(); await page.getByLabel('今天所有账户已记完',{exact:true}).check(); const available = await page.locator('dialog .ll-editor-footer .ll-primary').isEnabled(); assert.equal(available,true); await page.getByRole('button',{name:'确认今天记完（无新增账目）',exact:true}).click(); await page.locator('dialog').waitFor({state:'detached'}); assert.equal((await snapshot()).transactions,0); assert.equal(await page.evaluate(()=>[...app.plugins.plugins['lifeledger-next'].repo.state.days.values()].some(d=>d.complete)),true); await page.getByRole('button',{name:'撤销最近一批',exact:true}).click(); await page.waitForFunction(()=> ![...app.plugins.plugins['lifeledger-next'].repo.state.days.values()].some(d=>d.complete)); });

  await test('表单校验失败在当前窗口说明原因，不让保存无反馈', async () => { await page.getByRole('button',{name:'账户',exact:true}).click(); await page.getByRole('button',{name:'添加账户',exact:true}).click(); await page.getByLabel('账户名称',{exact:true}).fill('错误金额示例'); await page.getByLabel('期初余额（元）',{exact:true}).fill('不是金额'); await page.getByLabel('期初余额（元）',{exact:true}).press('Tab'); await page.getByRole('button',{name:'保存账户',exact:true}).click(); await pause(80); const detail = await page.locator('dialog [role=alert]').allTextContents(); await page.locator('dialog').getByRole('button',{name:'关闭',exact:true}).click(); await page.getByRole('button',{name:'首页',exact:true}).click(); assert.ok(detail.some(s=>s.length>0),'错误只显示在模态窗口背后'); });
  const openManual = async () => { await page.getByRole('button', { name: '首页', exact: true }).click(); await page.getByRole('button', { name: '口播 / 手动记账', exact: true }).click(); await page.locator('dialog').waitFor(); await page.getByRole('button', { name: '手动加一笔', exact: true }).click(); };
  const closeDraft = async () => { if (await page.locator('dialog').count()) await page.locator('dialog').getByRole('button', { name: '保存草稿并关闭', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' }); };
  const fillRow = async (i, amount, note) => { const row = page.locator('.ll-draft-row').nth(i); await row.getByLabel('金额（元）', { exact: true }).fill(amount); await row.getByLabel('金额（元）', { exact: true }).press('Tab'); await row.getByLabel('分类', { exact: true }).selectOption('food'); await row.getByLabel('备注', { exact: true }).fill(note); await row.getByLabel('备注', { exact: true }).press('Tab'); };
  await test('负数和超过分的金额保持待补，不能保存', async () => {
    await openManual(); for (const amount of ['-2', '12.345', 'NaN']) { await page.getByLabel('金额（元）', { exact: true }).fill(amount); await page.getByLabel('金额（元）', { exact: true }).press('Tab'); await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).check(); assert.equal(await page.getByRole('button', { name: '保存 0 笔', exact: true }).isDisabled(), true); } await closeDraft();
  });
  await test('手动记账支持键盘连续输入，双击只保存一笔', async () => { await openManual(); await fillRow(0, '12.34', '午饭'); await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).check(); await page.getByRole('button', { name: '保存 1 笔', exact: true }).dblclick(); await page.locator('dialog').waitFor({ state: 'detached' }); assert.equal((await snapshot()).transactions, 1); assert.ok((await page.locator('.ll-stats').first().innerText()).includes('987.66')); });
  await test('修改已核对金额会撤销核对，阻止静默保存', async () => { await openManual(); await fillRow(0, '10', '晚饭'); await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).check(); await page.getByLabel('金额（元）', { exact: true }).fill('11'); await page.getByLabel('金额（元）', { exact: true }).press('Tab'); assert.equal(await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).isChecked(), false); assert.equal(await page.getByRole('button', { name: '保存 0 笔', exact: true }).isDisabled(), true); await closeDraft(); });
  await test('部分保存不误标记记完，剩余草稿能补全保存', async () => { await openManual(); await fillRow(0, '11', '晚饭'); await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).check(); await page.getByRole('button', { name: '手动加一笔', exact: true }).click(); await page.getByLabel('今天所有账户已记完', { exact: true }).check(); await page.getByRole('button', { name: '保存 1 笔', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.ll-draft-row').length === 1); assert.equal((await snapshot()).transactions, 2); assert.equal(await page.evaluate(() => [...app.plugins.plugins['lifeledger-next'].repo.state.days.values()].some(d => d.complete)), false); await fillRow(0, '5', '地铁'); await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).check(); await page.getByRole('button', { name: '保存 1 笔', exact: true }).click(); await page.locator('dialog').waitFor({ state: 'detached' }); assert.equal((await snapshot()).transactions, 3); });
  await test('录入中切换目录会拦截，避免草稿写错位置', async () => { await openManual(); const before = await snapshot(), p = await settings(); await settingRow(p, '账本目录').locator('input').fill('录入中错误目录'); await settingRow(p, '账本目录').locator('button').click(); await pause(100); assert.equal((await snapshot()).root, before.root); assert.ok(!(await snapshot()).files.some(p => p.startsWith('录入中错误目录'))); await closeSettings(); await closeDraft(); });
  await test('原文中的 HTML 作为文字显示，不产生元素或执行脚本', async () => { await openManual(); const payload = '<img src=x onerror="globalThis.auditInjection=1">'; await page.getByLabel('原文', { exact: true }).fill(payload); await page.getByLabel('备注', { exact: true }).fill(payload); await page.getByLabel('备注', { exact: true }).press('Tab'); assert.equal(await page.locator('.lifeledger img[src=x]').count(), 0); assert.equal(await page.evaluate(() => globalThis.auditInjection), undefined); await closeDraft(); });
  await test('无效 API 配置无法覆盖已保存配置', async () => { const saved = await page.evaluate(() => app.plugins.plugins['lifeledger-next'].loadData()), p = await settings(); await settingRow(p, 'API 服务地址').locator('input').fill('http://example.com'); await p.getByRole('button', { name: '保存连接配置', exact: true }).click(); await pause(100); assert.deepEqual(await page.evaluate(() => app.plugins.plugins['lifeledger-next'].loadData()), saved); await closeSettings(); });
  await test('用户主动保存连接后才生效，密钥不写入账本', async () => { const p = await settings(); await settingRow(p, 'API 服务地址').locator('input').fill(modelUrl); await settingRow(p, '模型 ID').locator('input').fill('isolated-model'); await settingRow(p, 'API 密钥').locator('input').fill('synthetic-key-only'); await p.getByRole('button', { name: '保存密钥', exact: true }).click(); const stagedUrl = await settingRow(p, 'API 服务地址').locator('input').inputValue(); await settingRow(p, 'API 服务地址').locator('input').fill(modelUrl); await settingRow(p, '模型 ID').locator('input').fill('isolated-model'); await p.getByRole('button', { name: '保存连接配置', exact: true }).click(); await pause(100); assert.equal(await page.evaluate(() => app.plugins.plugins['lifeledger-next'].deviceSettings.api.baseUrl), modelUrl); await closeSettings(); const text = await page.evaluate(async () => { const r = app.plugins.plugins['lifeledger-next'].repo; return JSON.stringify(r.exportBackup()); }); assert.ok(!text.includes('synthetic-key-only')); assert.equal(stagedUrl, modelUrl, '保存密钥清空了未保存的连接字段'); });
  const raw = '今天早饭八块，午饭二十五块，晚饭三十二，地铁六块，公众号到账三百。';
  const beginExtract = async () => { await page.getByLabel('记账原文', { exact: true }).fill(raw); await page.locator('.ll-entry-card').getByRole('button', { name: '整理成账目', exact: true }).click(); await page.locator('dialog').waitFor(); };
  await test('模拟服务断开保留原文和草稿，不产生账目', async () => { mode = 'offline'; const n = (await snapshot()).transactions; await beginExtract(); await page.locator('dialog .ll-error').waitFor(); assert.equal(await page.getByLabel('原文', { exact: true }).inputValue(), raw); assert.equal((await snapshot()).transactions, n); await closeDraft(); mode = 'daily'; });
  await test('空回复给出可重试错误，不记成零消费', async () => { mode = 'failure'; const n = (await snapshot()).transactions; await beginExtract(); await page.locator('dialog .ll-error').waitFor(); assert.equal((await snapshot()).transactions, n); assert.equal(await page.locator('.ll-draft-row').count(), 0); await closeDraft(); mode = 'daily'; });
  await test('请求尚未返回就关闭，迟到回复不会自动入账', async () => { delayMs = 700; const n = (await snapshot()).transactions; await beginExtract(); await page.locator('dialog').getByRole('button', { name: '关闭', exact: true }).click(); await pause(900); assert.equal((await snapshot()).transactions, n); assert.ok(await page.evaluate(raw => app.plugins.plugins['lifeledger-next'].repo.drafts.some(d => d.text === raw), raw)); delayMs = 0; });
  await test('整理只产生草稿，勾选核对后才保存并同步资产', async () => { await beginExtract(); await page.waitForFunction(() => document.querySelectorAll('.ll-draft-row').length === 5); assert.equal((await snapshot()).transactions, 3); for (let i=0;i<5;i++) await page.getByLabel('已核对这笔金额、账户和疑问', { exact: true }).nth(i).check(); await page.getByRole('button', { name: '保存 5 笔', exact: true }).click(); await page.locator('dialog').waitFor({ state:'detached' }); assert.equal((await snapshot()).transactions, 8); });
  await test('修改手工行后再整理不会覆盖手工金额', async () => { await openManual(); await fillRow(0, '77', '保留手工项'); await page.getByLabel('原文', { exact: true }).fill(raw); await page.locator('dialog').getByRole('button', { name: '保留手工修改，再整理', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.ll-draft-row').length === 6); assert.equal(await page.getByLabel('金额（元）', { exact: true }).first().inputValue(), '77'); await closeDraft(); });
  await test('五页窄窗格可访问，无横向溢出', async () => { const cdps = await context.newCDPSession(page); await cdps.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 1000, deviceScaleFactor:1, mobile:false }); for (const name of ['首页','账本','分析','账户','每日成本']) { await page.getByRole('button', { name, exact:true }).click(); const bounds = await page.locator('.lifeledger').evaluate(n => ({client:n.clientWidth,scroll:n.scrollWidth})); assert.ok(bounds.scroll <= bounds.client+2, `${name} ${JSON.stringify(bounds)}`); await page.locator('.lifeledger').screenshot({path:`${evidence}/narrow-${name}.png`}); } await cdps.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor:1, mobile:false }); await page.getByRole('button',{name:'首页',exact:true}).click(); });
  await test('关闭再启用插件保留账户与所有已保存账目', async () => { const n = (await snapshot()).transactions; await page.evaluate(async () => { await app.plugins.disablePlugin('lifeledger-next'); await app.plugins.enablePlugin('lifeledger-next'); await app.plugins.plugins['lifeledger-next'].open(); }); await page.locator('.lifeledger').waitFor(); assert.equal((await snapshot()).transactions, n); assert.equal(await page.evaluate(() => app.plugins.plugins['lifeledger-next'].repo.config.accounts[0].name), '试验日常'); });
  await test('备份恢复到新目录后，账目和草稿完整可再编辑', async () => { const old = (await snapshot()).root, result = await page.evaluate(async () => { const p = app.plugins.plugins['lifeledger-next']; await p.repo.load(); const backup = JSON.parse(JSON.stringify(p.repo.exportBackup())), n = p.repo.state.transactions.size, drafts = p.repo.drafts.length; await p.changeRoot('已恢复试验账本'); await p.repo.restoreBackup(backup); await p.refresh(); return {n,drafts,restored:p.repo.state.transactions.size,restoredDrafts:p.repo.drafts.length}; }); assert.equal(result.n,result.restored); assert.equal(result.drafts,result.restoredDrafts); await page.evaluate(async old=> { await app.plugins.plugins['lifeledger-next'].changeRoot(old); },old); });
  await test('回到旧目录不会搬迁或覆盖原账本', async () => { assert.equal((await snapshot()).root, '新年度/生活账本'); assert.equal((await snapshot()).transactions,8); assert.ok((await snapshot()).files.some(p=>p.startsWith('用户模拟/'))); assert.ok((await snapshot()).files.some(p=>p.startsWith('已恢复试验账本/'))); });

  await test('模拟自定义 Obsidian 配置目录时仍阻止账本误存', async () => { const result=await page.evaluate(()=>{const p=app.plugins.plugins['lifeledger-next'],v=app.vault,descriptor=Object.getOwnPropertyDescriptor(v,'configDir');Object.defineProperty(v,'configDir',{value:'UserConfig',configurable:true});try{return ['UserConfig','userconfig/账本'].map(path=>{try{p.checkedRoot(path);return false;}catch{return true;}});}finally{if(descriptor)Object.defineProperty(v,'configDir',descriptor);else delete v.configDir;}});assert.deepEqual(result,[true,true]);return '配置目录名称为测试夹具，不代表实际迁移应用配置'; });
  await test('检查连接不发送记账原文，也不保存未确认修改', async()=>{const before=await page.evaluate(()=>app.plugins.plugins['lifeledger-next'].loadData()),n=requests,p=await settings();await settingRow(p,'模型 ID').locator('input').fill('未保存模型');await p.getByRole('button',{name:'检查连接',exact:true}).click();await pause(150);assert.equal(requests,n);assert.deepEqual(await page.evaluate(()=>app.plugins.plugins['lifeledger-next'].loadData()),before);await closeSettings();});
  await test('同账户转账被拦截，两端补齐后资产守恒，撤销成对恢复', async()=>{
    await page.getByRole('button',{name:'账户',exact:true}).click();await page.getByRole('button',{name:'添加账户',exact:true}).click();await page.getByLabel('账户名称',{exact:true}).fill('备用试验账户');await page.getByLabel('期初余额（元）',{exact:true}).fill('500');await page.getByLabel('期初余额（元）',{exact:true}).press('Tab');await page.getByRole('button',{name:'保存账户',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});
    await openManual();const ids=await page.evaluate(()=>app.plugins.plugins['lifeledger-next'].repo.config.accounts.map(a=>a.id));await page.getByLabel('类型',{exact:true}).selectOption('transfer');await page.getByLabel('金额（元）',{exact:true}).fill('100');await page.getByLabel('金额（元）',{exact:true}).press('Tab');await page.getByLabel('转出账户',{exact:true}).selectOption(ids[0]);await page.getByLabel('转入账户',{exact:true}).selectOption(ids[0]);await page.getByLabel('已核对这笔金额、账户和疑问',{exact:true}).check();assert.equal(await page.getByRole('button',{name:'保存 0 笔',exact:true}).isDisabled(),true);await page.getByLabel('转入账户',{exact:true}).selectOption(ids[1]);await page.getByLabel('已核对这笔金额、账户和疑问',{exact:true}).check();const assets=await page.locator('.ll-asset-total .ll-number').textContent();await page.getByRole('button',{name:'保存 1 笔',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});assert.equal((await snapshot()).transactions,9);assert.equal(await page.locator('.ll-asset-total .ll-number').textContent(),assets);await page.getByRole('button',{name:'撤销最近一批',exact:true}).click();await page.waitForFunction(()=>app.plugins.plugins['lifeledger-next'].repo.state.transactions.size===8);assert.equal(await page.locator('.ll-asset-total .ll-number').textContent(),assets);
  });

  await test('多份待处理草稿收起展示，丢弃按用户偏好进回收站',async()=>{await page.getByRole('button',{name:'首页',exact:true}).click();const drawer=page.locator('.ll-drafts-drawer');assert.ok(await page.evaluate(()=>app.plugins.plugins['lifeledger-next'].repo.drafts.filter(d=>d.status!=='saved'&&(d.text.trim()||d.rows.length)).length)>=3);assert.equal(await drawer.evaluate(n=>n.open),false);await drawer.locator('summary').click();const before=await page.evaluate(()=>{const r=app.plugins.plugins['lifeledger-next'].repo;return {id:r.drafts.find(d=>d.status!=='saved'&&(d.text.trim()||d.rows.length)).id,n:r.drafts.length,transactions:r.state.transactions.size};});await drawer.getByRole('button',{name:'丢弃草稿',exact:true}).first().click();await page.waitForFunction(id=>!app.plugins.plugins['lifeledger-next'].repo.drafts.some(d=>d.id===id),before.id);assert.equal((await snapshot()).transactions,before.transactions);assert.ok((await readFile(join(vault,'.trash',`${before.id}.md`),'utf8')).includes(before.id));});
  await test('通过设置的文件选择器恢复 JSON 备份',async()=>{const old=(await snapshot()).root,backup=await page.evaluate(()=>app.plugins.plugins['lifeledger-next'].repo.exportBackup()),file=resolve(evidence,'restore-fixture.json');await writeFile(file,JSON.stringify(backup));await page.evaluate(async()=>app.plugins.plugins['lifeledger-next'].changeRoot('文件选择恢复'));const p=await settings();const chooserPromise=p.waitForEvent('filechooser',{timeout:5000});await p.getByRole('button',{name:'选择 JSON 备份',exact:true}).click();const chooser=await chooserPromise;await chooser.setFiles(file);await page.waitForFunction(()=>app.plugins.plugins['lifeledger-next'].repo.state.transactions.size===8,{},{timeout:5000});await closeSettings();await page.evaluate(async old=>app.plugins.plugins['lifeledger-next'].changeRoot(old),old);});

  await test('模拟写盘失败时保留输入，阻止清空原文或自动入账',async()=>{const n=(await snapshot()).transactions;await page.evaluate(()=>{const r=app.plugins.plugins['lifeledger-next'].repo;r.io.auditOriginalCreate=r.io.create;r.io.create=async()=>{throw new Error('模拟磁盘写入失败');};});const raw='磁盘失败时仍须保留这段原文';try{await page.getByLabel('记账原文',{exact:true}).fill(raw);await pause(500);await page.locator('.ll-entry-card').getByRole('button',{name:'整理成账目',exact:true}).click();await pause(80);assert.equal(await page.getByLabel('记账原文',{exact:true}).inputValue(),raw);assert.equal(await page.locator('dialog').count(),0);assert.equal((await snapshot()).transactions,n);}finally{await page.evaluate(()=>{const r=app.plugins.plugins['lifeledger-next'].repo;r.io.create=r.io.auditOriginalCreate;delete r.io.auditOriginalCreate;});}await page.getByRole('button',{name:'口播 / 手动记账',exact:true}).click();await page.locator('dialog').waitFor();assert.equal(await page.getByLabel('原文',{exact:true}).inputValue(),raw);await closeDraft();});
  await test('本轮全流程没有页面脚本错误', async () => { assert.equal(errors.length,0,JSON.stringify(errors)); });
  await closeSettings(); await page.getByRole('button',{name:'首页',exact:true}).click(); await page.locator('.lifeledger').screenshot({ path: `${evidence}/home.png` });
  await writeFile(`${evidence}/audit.json`, JSON.stringify({ date: new Date().toISOString(), version: JSON.parse(await readFile('manifest.json','utf8')).version, phase, kind: 'Obsidian 1.14.4 isolated real UI + synthetic data', vault, profile, checks, scriptErrors: errors, realApi: false, realTypeless: false }, null, 2));
  console.log(`审查完成：${checks.filter(c => c.passed).length}/${checks.length}；${vault}`); if (checks.some(c => !c.passed)) process.exitCode = 1;
} catch (error) {
  await writeFile(`${evidence}/failure.json`, JSON.stringify({ stage, message: error.message, checks, errors }, null, 2)); throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  model.close();
}
