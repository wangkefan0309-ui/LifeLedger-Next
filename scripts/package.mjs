import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import assert from 'node:assert/strict';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(pkg.version, manifest.version, '包版本须与插件清单一致');
const destination = resolve(`dist/package-v${manifest.version}/${manifest.id}`);
const runtimeFiles = ['main.js', 'manifest.json', 'styles.css'];
const files = [...runtimeFiles, 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
async function addDocs(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${item.name}`;
    if (item.isDirectory()) await addDocs(path);
    else if (item.isFile() && /\.(md|png)$/.test(item.name)) files.push(path);
  }
}
await addDocs('docs');
const archive = {}, checksums = {};
for (const file of files) {
  const data = await readFile(file); archive[`${manifest.id}/${file}`] = new Uint8Array(data);
  checksums[file] = createHash('sha256').update(data).digest('hex');
  await mkdir(dirname(`${destination}/${file}`), { recursive: true }); await copyFile(file, `${destination}/${file}`);
}
const zip = zipSync(archive, { level: 6 });
const unpacked = unzipSync(zip);
assert.deepEqual(Object.keys(unpacked).sort(), Object.keys(archive).sort(), 'ZIP只能包含发布清单');
for (const path of Object.keys(archive)) assert.deepEqual(unpacked[path], archive[path], `ZIP内容校验失败：${path}`);
const zipName = `LifeLedger-${manifest.version}.zip`;
await mkdir('dist', { recursive: true }); await writeFile(`dist/${zipName}`, zip);
for (const file of runtimeFiles) await copyFile(file, `dist/${file}`);
const zipHash = createHash('sha256').update(zip).digest('hex');
const sums = [...runtimeFiles.map(file => `${checksums[file]}  ${file}`), `${zipHash}  ${zipName}`].join('\n') + '\n';
await writeFile('dist/SHA256SUMS.txt', sums);
await writeFile('dist/package-info.json', JSON.stringify({ id: manifest.id, version: manifest.version, builtAt: new Date().toISOString(), files, sha256: checksums, archive: { name: zipName, bytes: zip.length, sha256: zipHash }, archiveVerified: true }, null, 2) + '\n');
console.log(`安装包 dist/${zipName}；${files.length} 个文件逐字节回读校验通过`);
