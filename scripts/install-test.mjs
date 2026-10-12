import { mkdir, copyFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const vault = resolve('validation-vault'); const config = join(vault, '.obsidian'); const plugin = join(config, 'plugins/lifeledger-next');
await mkdir(plugin, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) { await access(file); await copyFile(file, join(plugin, file)); }
await writeFile(join(config, 'community-plugins.json'), JSON.stringify(['lifeledger-next']));
await writeFile(join(config, 'app.json'), JSON.stringify({ safeMode: false }));
await writeFile(join(vault, '测试库说明.md'), '# LifeLedger 隔离验收库\n\n只使用虚拟账户、虚拟流水及本机模拟 API。用户日常 Vault 没有安装或改写。\n');
console.log(`已安装到隔离测试库 ${vault}`);
