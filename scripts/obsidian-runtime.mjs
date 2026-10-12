import { access, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

// Desktop acceptance requires a local Obsidian install, never a user's daily Vault.
export async function obsidianRuntime() {
  const local = process.env.LOCALAPPDATA, roaming = process.env.APPDATA;
  const executable = process.env.OBSIDIAN_EXECUTABLE || (process.platform === 'win32' && local ? join(local, 'Programs/Obsidian/Obsidian.exe') : '');
  let asar = process.env.OBSIDIAN_ASAR;
  if (!asar && process.platform === 'win32' && roaming) {
    const directory = join(roaming, 'obsidian');
    const files = (await readdir(directory)).filter(name => /^obsidian-\d+\.\d+\.\d+\.asar$/.test(name));
    files.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const name = files.find(name => name === 'obsidian-1.14.4.asar') || files[0];
    if (name) asar = join(directory, name);
  }
  if (!executable || !asar) throw new Error('隔离实机检查需要 Obsidian；请设置 OBSIDIAN_EXECUTABLE 和 OBSIDIAN_ASAR，详见 docs/development.md。');
  await access(executable); await access(asar);
  return { executable, asar, asarName: basename(asar) };
}
