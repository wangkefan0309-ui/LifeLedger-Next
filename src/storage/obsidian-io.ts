import { TFile, TFolder, normalizePath, type Vault, type FileManager } from 'obsidian';
import type { FileIO } from './repository';
export class ObsidianIO implements FileIO {
  constructor(private vault: Vault, private fileManager: FileManager) {}
  async list(prefix: string): Promise<string[]> {
    const folder = this.vault.getAbstractFileByPath(normalizePath(prefix)); if (!(folder instanceof TFolder)) return [];
    const files: TFile[] = [], visit = (node: TFolder) => { for (const child of node.children) { if (child instanceof TFile) files.push(child); else if (child instanceof TFolder) visit(child); } };
    visit(folder); return files.sort((a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path)).map(f => f.path);
  }
  async read(path: string): Promise<string | null> {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!file) return null;
    if (!(file instanceof TFile)) throw new Error(`${path} 不是文件`);
    return this.vault.read(file);
  }
  private async folders(path: string) {
    const parts = normalizePath(path).split('/'); parts.pop(); let parent = '';
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      const existing = this.vault.getAbstractFileByPath(parent);
      if (existing) { if (!(existing instanceof TFolder)) throw new Error(`${parent} 不是目录`); }
      else { try { await this.vault.createFolder(parent); } catch (e) { if (!(this.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw e; } }
    }
  }
  async create(path: string, text: string) { await this.folders(path); await this.vault.create(normalizePath(path), text); }
  async process(path: string, update: (text: string) => string) {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new Error(`找不到 ${path}`);
    await this.vault.process(file, update);
  }
  async trash(path: string) {
    const file = this.vault.getAbstractFileByPath(normalizePath(path)); if (!(file instanceof TFile)) throw new Error('找不到草稿文件');
    await this.fileManager.trashFile(file);
  }
}
