import { obsidianRuntime } from './obsidian-runtime.mjs';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, copyFile, cp, access } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';

const runtime = await obsidianRuntime();
const vault = resolve('validation-vault/LifeLedger-试验仓库');
const profile = resolve('validation-vault/review-profile'), appdata = join(profile, 'obsidian');
const { version } = JSON.parse(await readFile('manifest.json', 'utf8'));
const evidence = resolve(`evidence/ui-v${version}`); await mkdir(evidence, { recursive: true });
const marker = join(vault, '试验库说明.md');
let fresh = false;
try { await access(vault); assert.ok((await readFile(marker, 'utf8')).startsWith('# LifeLedger 独立试验库'), '同名目录已存在且不是本项目的试验库'); }
catch (e) { if (e.code !== 'ENOENT') throw e; try { await access(vault); throw new Error('同名目录已存在且缺少试验标记，请使用其他目录'); } catch (nested) { if (nested.code !== 'ENOENT') throw nested; fresh = true; } }
if (fresh) {
  const sample = JSON.parse(await readFile(join(evidence, 'obsidian-ui.json'), 'utf8'));
  assert.ok(resolve(sample.vault).startsWith(resolve('validation-vault') + sep), '示例必须来自工程内隔离测试库');
  await mkdir(join(vault, 'LifeLedger'), { recursive: true });
  await copyFile(join(sample.vault, 'LifeLedger/配置.md'), join(vault, 'LifeLedger/配置.md'));
  await cp(join(sample.vault, 'LifeLedger/账本'), join(vault, 'LifeLedger/账本'), { recursive: true, force: false, errorOnExist: true });
  await writeFile(marker, '# LifeLedger 独立试验库\n\n这里的账户、余额、流水和电脑成本全部为虚拟示例，没有复制日常 Vault 的数据或密钥。\n\n已预置三个账户、五笔示例流水和一个已有电脑成本项目。可以尝试手动录入、更正、撤销、日历查账、修改账户和调整使用期限；操作只影响这个试验库。\n\nAPI 未配置。真实 API 和 Typeless 仍需自行填写设备密钥、实际输入后验收。默认静音，可以在插件设置中开启音效。\n\n以后双击工程内的「打开试验库.cmd」，会保留在此进行的操作。\n');
}
await mkdir(join(vault, '.obsidian/plugins/lifeledger-next'), { recursive: true }); await mkdir(appdata, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'styles.css']) await copyFile(name, join(vault, '.obsidian/plugins/lifeledger-next', name));
if (fresh) {
  await writeFile(join(vault, '.obsidian/community-plugins.json'), '["lifeledger-next"]');
  await writeFile(join(vault, '.obsidian/app.json'), '{"safeMode":false,"trashOption":"local"}');
  await writeFile(join(appdata, 'obsidian.json'), JSON.stringify({ vaults: { 'lifeledger-review': { path: vault, open: true, ts: Date.now() } } }));
}
try { await access(join(appdata, runtime.asarName)); }
catch { await copyFile(runtime.asar, join(appdata, runtime.asarName)); }
const child = spawn(runtime.executable, [`--user-data-dir=${appdata}`, '--remote-debugging-port=9236', '--no-sandbox'], { env: { ...process.env, APPDATA: profile }, windowsHide: true, detached: true, stdio: 'ignore' }); child.unref();
let browser;
try {
  for (let i=0; i<30; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9236', { timeout: 1000 }); break; } catch { await new Promise(r=>setTimeout(r,250)); } }
  assert.ok(browser, '试验库调试连接未启动'); const context = browser.contexts()[0]; let page;
  for (let i=0; i<30; i++) { page = context.pages().find(p=>p.url().startsWith('app://')); if(page) break; await new Promise(r=>setTimeout(r,200)); }
  assert.ok(page); await page.waitForFunction(()=>globalThis.app?.workspace?.layoutReady, undefined, { timeout:20000 });
  assert.equal(resolve(await page.evaluate(()=>app.vault.adapter.getBasePath())), vault, '只允许打开本项目独立试验库');
  const trust = page.getByText('信任仓库作者并启用插件',{exact:true}); if(await trust.isVisible().catch(()=>false)) await trust.click();
  await page.evaluate(async fresh=>{
    if (app.plugins.plugins['lifeledger-next']) { for (const leaf of app.workspace.getLeavesOfType('lifeledger-next-view')) { await leaf.view.ui?.destroy(); leaf.view.ui = undefined; } await app.plugins.disablePlugin('lifeledger-next'); }
    await app.plugins.loadManifests();
    await app.plugins.enablePlugin('lifeledger-next'); const p=app.plugins.plugins['lifeledger-next']; if(fresh) await p.repo.saveConfig({...p.repo.config,animation:'full',sound:false}); await p.open(); }, fresh);
  await page.locator('.lifeledger').waitFor();
  const result=await page.evaluate(()=>{const p=app.plugins.plugins['lifeledger-next'];return {version:p.manifest.version,transactions:p.repo.state.transactions.size,accounts:p.repo.config.accounts.length,costs:p.repo.state.costs.size,issues:p.repo.state.issues.length,hasKey:!!p.getKey()};});
  if(fresh) { assert.equal(result.transactions,5); assert.equal(result.accounts,3); assert.equal(result.costs,1); assert.equal(result.hasKey,false); } assert.equal(result.issues,0);
  assert.equal(result.version, version, '试验库运行版本必须与本次构建一致');
  await writeFile(join(evidence, 'review-vault.json'),JSON.stringify({vault,profile,pid:child.pid,fresh,...result,syntheticData:true},null,2));
  console.log(`已打开独立试验库：${vault}；版本 ${result.version}；数据均为虚拟示例。`);
} finally { if(browser)await browser.close().catch(()=>{}); }
