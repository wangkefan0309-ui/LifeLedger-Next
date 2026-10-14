import { ItemView, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, WorkspaceLeaf, requestUrl, normalizePath } from 'obsidian';
import { Extractor, apiUrl, type ApiSettings } from './api/extractor';
import { cents, decimal, DEFAULT_SLOGAN, localDate, sha256 } from './core/primitives';
import { requireThat } from './core/ledger';
import type { Config, ExchangeRates } from './core/types';
import { parseReferenceRates, RATES_URL } from './api/exchange-rates';
import { ObsidianIO } from './storage/obsidian-io';
import { Repository, validRoot } from './storage/repository';
import { LedgerUI } from './ui/app';
const VIEW = 'lifeledger-next-view';
interface DeviceSettings { root: string; api: ApiSettings }
export default class LifeLedgerPlugin extends Plugin {
  repo!: Repository; deviceSettings!: DeviceSettings; extractor!: Extractor;
  private switchingRoot = false;
  private ratesPromise?: Promise<ExchangeRates>;
  private ratesAttemptDay = '';
  ratesError = '';
  referenceTransport = async () => {
    const response = await requestUrl({ url: RATES_URL, method: 'GET', throw: false });
    requireThat(response.status >= 200 && response.status < 300, `参考汇率服务返回 HTTP ${response.status}`);
    return response.json as unknown;
  };
  async onload() {
    const data = await this.loadData();
    this.deviceSettings = { root: typeof data?.root === 'string' ? data.root : 'LifeLedger', api: { baseUrl: typeof data?.api?.baseUrl === 'string' ? data.api.baseUrl : 'https://api.deepseek.com', model: typeof data?.api?.model === 'string' ? data.api.model : 'deepseek-flash', secretId: `lifeledger-next-${sha256(this.app.vault.getName()).slice(0, 16)}` } };
    try { this.deviceSettings.root = this.checkedRoot(this.deviceSettings.root); }
    catch {
      let suffix = 0;
      while (true) { const candidate = suffix === 0 ? 'LifeLedger' : `LifeLedger-账本-${suffix}`; try { this.deviceSettings.root = this.checkedRoot(candidate); break; } catch { suffix++; } }
      new Notice(`保存的账本目录无效，暂使用 ${this.deviceSettings.root}；请在设置中重新选择。原文件保留。`);
    }
    this.repo = new Repository(new ObsidianIO(this.app.vault, this.app.fileManager), this.deviceSettings.root); await this.repo.load();
    this.extractor = new Extractor(async (url, body, key) => {
      try {
        const response = await requestUrl({ url, method: body === null ? 'GET' : 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body === null ? {} : { body: JSON.stringify(body) }), throw: false });
        return { status: response.status, json: response.json };
      } catch { throw new Error('无法连接 API；请检查网络、地址和系统代理，草稿已保留'); }
    });
    this.registerView(VIEW, leaf => new LedgerView(leaf, this));
    this.addRibbonIcon('wallet', '打开 LifeLedger', () => { void this.open(); });
    this.addCommand({ id: 'open-lifeledger', name: '打开首页', callback: () => { void this.open(); } });
    this.addCommand({ id: 'record-lifeledger', name: '口播 / 手动记账', callback: () => { void this.open().then(view => view.ui?.openDraft()); } });
    this.addCommand({ id: 'export-lifeledger', name: '导出完整数据备份', callback: () => { void this.open().then(view => view.ui?.export()); } });
    this.addSettingTab(new LedgerSettings(this));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = (file: { path: string }) => {
      if (!file.path.startsWith(`${this.repo.root}/`)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
          const view = leaf.view as LedgerView;
          // Preserve an open editor and the user's focus; commit always rereads external changes.
          if (view.ui && !view.contentEl.querySelector('dialog[open]')) void view.ui.reload(true).catch(() => new Notice('重新读取账本失败，请检查文件'));
        }
      }, 250);
    };
    this.registerEvent(this.app.vault.on('create', reload)); this.registerEvent(this.app.vault.on('modify', reload)); this.registerEvent(this.app.vault.on('delete', reload)); this.registerEvent(this.app.vault.on('rename', (file, old) => { reload(file); reload({ path: old }); }));
    this.register(() => { if (timer) clearTimeout(timer); });
  }
  getKey() { return this.app.secretStorage.getSecret(this.deviceSettings.api.secretId) ?? ''; }
  async open(): Promise<LedgerView> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
    const c = this.repo.config, needed = c.accounts.some(a => (a.currency ?? 'CNY') !== 'CNY' || (a.displayCurrency && a.displayCurrency !== 'CNY'));
    if (needed && this.ratesAttemptDay !== localDate() && (!c.exchangeRates || localDate(new Date(c.exchangeRates.fetchedAt)) !== localDate())) void this.updateExchangeRates().catch(() => undefined);
    return leaf.view as LedgerView;
  }
  async updateExchangeRates(): Promise<ExchangeRates> {
    if (this.ratesPromise) return this.ratesPromise;
    const repository = this.repo; this.ratesAttemptDay = localDate(); this.ratesError = '';
    this.ratesPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const json = await Promise.race([this.referenceTransport(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('参考汇率更新超时，沿用已有缓存')), 15000); })]);
        const rates = parseReferenceRates(json);
        requireThat(this.repo === repository, '账本目录已切换，本次汇率未写入新目录');
        await repository.saveConfig({ ...repository.config, exchangeRates: rates }); await this.refresh(); return rates;
      } catch (error) { this.ratesError = `${(error as Error).message}；可使用缓存或手动汇率`; await this.refresh(); throw error; }
      finally { if (timer) clearTimeout(timer); this.ratesPromise = undefined; }
    })();
    return this.ratesPromise;
  }
  openSettings() {
    // Obsidian's settings window is not part of its public typings.
    const app = this.app as unknown as { setting: { open(): void; openTabById(id: string): void } };
    app.setting.open(); app.setting.openTabById(this.manifest.id);
  }
  private checkedRoot(root: string) {
    const path = normalizePath(validRoot(root)), configDir = normalizePath(this.app.vault.configDir);
    requireThat(path.toLowerCase() !== configDir.toLowerCase() && !path.toLowerCase().startsWith(`${configDir.toLowerCase()}/`), '账本不能保存在 Obsidian 配置目录中');
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i).join('/'), file = this.app.vault.getAbstractFileByPath(parent);
      requireThat(!file || file instanceof TFolder, `${parent} 已有同名文件，请选择文件夹路径`);
    }
    for (const name of ['账本', '草稿']) {
      const file = this.app.vault.getAbstractFileByPath(`${path}/${name}`);
      requireThat(!file || file instanceof TFolder, `${path}/${name} 已有同名文件`);
    }
    const config = this.app.vault.getAbstractFileByPath(`${path}/配置.md`);
    requireThat(!config || config instanceof TFile, `${path}/配置.md 是文件夹，无法作为账本配置文件`);
    return path;
  }
  async changeRoot(root: string) {
    requireThat(!this.switchingRoot, '正在切换账本目录，请稍候'); this.switchingRoot = true;
    try {
      const path = this.checkedRoot(root);
      const leaves = this.app.workspace.getLeavesOfType(VIEW);
      requireThat(!leaves.some(leaf => (leaf.view as LedgerView).contentEl.querySelector('dialog[open]')), '请先保存草稿并关闭录入窗口，再切换账本目录');
      for (const leaf of leaves) await (leaf.view as LedgerView).ui?.flushPending();
      const candidate = new Repository(new ObsidianIO(this.app.vault, this.app.fileManager), path); await candidate.load();
      const next = { ...this.deviceSettings, root: path }; await this.saveData(next);
      this.deviceSettings.root = path; this.repo = candidate;
      for (const leaf of leaves) await (leaf.view as LedgerView).reopen();
    } finally { this.switchingRoot = false; }
  }
  async refresh() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) await (leaf.view as LedgerView).ui?.reload(); }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW); }
}
class LedgerView extends ItemView {
  ui?: LedgerUI;
  constructor(leaf: WorkspaceLeaf, private plugin: LifeLedgerPlugin) { super(leaf); }
  getViewType() { return VIEW; } getDisplayText() { return 'LifeLedger'; } getIcon() { return 'wallet'; }
  async onOpen() { await this.reopen(); }
  async reopen() {
    await this.ui?.destroy(); this.contentEl.empty(); await this.plugin.repo.settled(); await this.plugin.repo.load();
    this.ui = new LedgerUI(this.contentEl, { repo: this.plugin.repo, extractor: this.plugin.extractor, api: this.plugin.deviceSettings.api, key: () => this.plugin.getKey(), notice: message => new Notice(message), changed: () => undefined, refreshRates: () => this.plugin.updateExchangeRates(), ratesError: () => this.plugin.ratesError, openSettings: () => this.plugin.openSettings(), openFile: path => { const file = this.app.vault.getAbstractFileByPath(path); if (file instanceof TFile) void this.app.workspace.getLeaf('tab').openFile(file); } });
  }
  async onClose() { await this.ui?.destroy(); this.ui = undefined; }
}
class LedgerSettings extends PluginSettingTab {
  private pendingTasks = 0;
  constructor(private plugin: LifeLedgerPlugin) { super(plugin.app, plugin); }
  private async run(fn: () => Promise<void>) {
    this.pendingTasks++; this.containerEl.setAttribute('aria-busy', 'true');
    const row = this.containerEl.ownerDocument.activeElement?.closest('.setting-item');
    this.containerEl.querySelectorAll('.ll-settings-error').forEach(node => node.remove());
    try { await fn(); } catch (e) {
      const target = row?.isConnected ? row.querySelector<HTMLElement>('.setting-item-info') ?? this.containerEl : this.containerEl;
      const error = target.createEl('p', { cls: 'll-settings-error', text: (e as Error).message }); error.setAttribute('role', 'alert'); error.scrollIntoView({ block: 'nearest' });
      new Notice((e as Error).message);
    }
    finally {
      this.pendingTasks--;
      if (!this.containerEl.ownerDocument.defaultView?.closed) this.containerEl.setAttribute('aria-busy', this.pendingTasks ? 'true' : 'false');
    }
  }
  display() {
    const { containerEl } = this; containerEl.empty(); containerEl.addClass('lifeledger-settings');
    new Setting(containerEl).setName('首页与外观').setHeading();
    const appearanceConfig = structuredClone(this.plugin.repo.config);
    const appearanceFingerprint = this.plugin.repo.configRevision;
    let homeSlogan = appearanceConfig.homeSlogan ?? DEFAULT_SLOGAN;
    let theme: NonNullable<Config['theme']> = appearanceConfig.theme ?? 'system';
    new Setting(containerEl).setName('首页标语').setDesc('写一句喜欢的标语或格言，最多 120 字；留空使用默认标语。保存后生效。').addText(t => {
      t.inputEl.maxLength = 120; t.inputEl.setAttribute('aria-label', '首页标语');
      t.setValue(homeSlogan).setPlaceholder(DEFAULT_SLOGAN).onChange(v => { homeSlogan = v; });
    });
    new Setting(containerEl).setName('页面外观').setDesc('只影响 LifeLedger 页面及记账弹窗；跟随系统会随电脑的深浅模式自动切换。').addDropdown(d => {
      d.selectEl.setAttribute('aria-label', '页面外观');
      d.addOptions({ system: '跟随系统', light: '浅色', dark: '深色' }).setValue(theme).onChange(v => { theme = v as NonNullable<Config['theme']>; });
    });
    new Setting(containerEl).setName('保存首页与外观').addButton(b => b.setButtonText('保存首页与外观').setCta().onClick(() => { void this.run(async () => {
      await this.plugin.repo.saveConfig({ ...appearanceConfig, homeSlogan: homeSlogan.trim() || DEFAULT_SLOGAN, theme }, appearanceFingerprint);
      await this.plugin.refresh(); this.display(); new Notice('首页与外观已保存');
    }); }));
    new Setting(containerEl).setName('文件存储').setHeading();
    new Setting(containerEl).setName('账本目录').setDesc('Vault 内的普通文件夹。输入不会建目录；点击后才切换，第一次保存时才创建。原账本保留，不自动搬迁。').addText(t => t.setValue(this.plugin.deviceSettings.root).onChange(v => { root = v; })).addButton(b => b.setButtonText('打开此目录').onClick(() => { void this.run(async () => { await this.plugin.changeRoot(root); this.display(); new Notice(`当前账本目录：${this.plugin.repo.root}。原目录文件保留。`); }); }));
    let root = this.plugin.deviceSettings.root;
    new Setting(containerEl).setName('口播整理连接').setHeading();
    const api = { ...this.plugin.deviceSettings.api };
    const saveApi = async () => {
      apiUrl(api.baseUrl, 'models'); requireThat(api.model.trim(), '请填写模型 ID');
      await this.plugin.saveData({ ...this.plugin.deviceSettings, api }); Object.assign(this.plugin.deviceSettings.api, api);
    };
    new Setting(containerEl).setName('API 服务地址').addText(t => t.setValue(api.baseUrl).onChange(v => { api.baseUrl = v.trim(); }));
    new Setting(containerEl).setName('模型 ID').setDesc('截图记账沿用同一连接，模型需支持图片输入及 JSON 输出。').addText(t => t.setValue(api.model).onChange(v => { api.model = v.trim(); }));
    let pendingKey = '', keyInput: HTMLInputElement;
    const keySetting = new Setting(containerEl).setName('API 密钥').setDesc(this.plugin.getKey() ? '已有设备密钥，保存在 Obsidian SecretStorage；不进入账本与导出。' : '在这里填写自己的密钥，保存到设备密钥库。').addText(t => { keyInput = t.inputEl; t.inputEl.type = 'password'; t.setPlaceholder('填写新密钥').onChange(v => { pendingKey = v.trim(); }); }).addButton(b => b.setButtonText('保存密钥').onClick(() => { if (pendingKey) { this.plugin.app.secretStorage.setSecret(api.secretId, pendingKey); pendingKey = ''; keyInput.value = ''; keySetting.setDesc('已有设备密钥，保存在 Obsidian SecretStorage；不进入账本与导出。'); new Notice('密钥已保存'); } }));
    new Setting(containerEl).setName('API 连接').setDesc('修改后点击保存才生效；检查连接只请求模型列表，不证明图片识别能力。整理发送本次原文及必要账户分类；点击识别截图会临时发送所选图片。').addButton(b => b.setButtonText('保存连接配置').onClick(() => { void this.run(async () => { await saveApi(); new Notice('配置已保存'); }); })).addButton(b => b.setButtonText('检查连接').onClick(() => { void this.run(async () => { new Notice(await this.plugin.extractor.checkConnection(api, this.plugin.getKey())); }); }));
    new Setting(containerEl).setName('成本与人生亮格').setHeading();
    const c: Config = structuredClone(this.plugin.repo.config);
    const configFingerprint = this.plugin.repo.configRevision;
    new Setting(containerEl).setName('成本观察起点').setDesc('从这里到最近连续记完日作为完整基线，原账目保留。').addText(t => { t.inputEl.type = 'date'; t.setValue(c.observationStart).onChange(v => { c.observationStart = v; }); });
    new Setting(containerEl).setName('暂估日均生活成本（元）').setDesc('仅在尚无完整观察区间时使用；可留空。').addText(t => t.setValue(c.estimateDailyCents === null ? '' : decimal(c.estimateDailyCents)).onChange(v => { try { c.estimateDailyCents = v.trim() ? cents(v) : null; } catch { c.estimateDailyCents = NaN; } }));
    new Setting(containerEl).setName('单独预留资金（元）').setDesc('仅填写尚未在余额或可用比例中排除的金额，统一扣一次。').addText(t => t.setValue(decimal(c.reservedCents)).onChange(v => { try { c.reservedCents = cents(v); } catch { c.reservedCents = NaN; } }));
    new Setting(containerEl).setName('生日（可留空）').addText(t => { t.inputEl.type = 'date'; t.setValue(c.birthDate ?? '').onChange(v => { c.birthDate = v || null; }); });
    new Setting(containerEl).setName('展示终点（不包含）').addText(t => { t.inputEl.type = 'date'; t.setValue(c.displayEnd).onChange(v => { c.displayEnd = v; }); });
    new Setting(containerEl).setName('显示已度过的日子').addToggle(t => t.setValue(c.showPast).onChange(v => { c.showPast = v; }));
    new Setting(containerEl).setName('动画').addDropdown(d => d.addOptions({ full: '完整原版仪式', short: '短动画', off: '关闭' }).setValue(c.animation).onChange(v => { c.animation = v as Config['animation']; }));
    new Setting(containerEl).setName('音效').addToggle(t => t.setValue(c.sound).onChange(v => { c.sound = v; }));
    new Setting(containerEl).setName('保存亮格设置').addButton(b => b.setButtonText('保存').setCta().onClick(() => { void this.run(async () => { requireThat(c.observationStart <= localDate() && c.displayEnd > localDate(), '观察起点不能在未来，展示终点须晚于今天'); await this.plugin.repo.saveConfig(c, configFingerprint); await this.plugin.refresh(); this.display(); new Notice('已保存'); }); }));
    new Setting(containerEl).setName('收支分类').setHeading();
    for (const category of this.plugin.repo.config.categories) {
      let name = category.name, living = category.living;
      const setting = new Setting(containerEl).setName(category.kind === 'income' ? '收入分类' : '支出分类').addText(t => t.setValue(name).onChange(v => { name = v; }));
      if (category.kind === 'expense') setting.setDesc('开关表示纳入生活成本；关闭仍计现金支出。').addToggle(t => t.setValue(living).onChange(v => { living = v; }));
      setting.addButton(b => b.setButtonText('保存').onClick(() => { void this.run(async () => { const config = this.plugin.repo.config; await this.plugin.repo.saveConfig({ ...config, categories: config.categories.map(x => x.id === category.id ? { ...x, name, living } : x) }); await this.plugin.refresh(); new Notice('分类已保存，历史 ID 保留'); }); }));
    }
    let categoryName = '', categoryKind: 'income' | 'expense' = 'expense';
    new Setting(containerEl).setName('添加分类').addText(t => t.setPlaceholder('分类名称').onChange(v => { categoryName = v; })).addDropdown(d => d.addOptions({ expense: '支出', income: '收入' }).onChange(v => { categoryKind = v as 'income' | 'expense'; })).addButton(b => b.setButtonText('添加').onClick(() => { void this.run(async () => { const config = this.plugin.repo.config; await this.plugin.repo.saveConfig({ ...config, categories: [...config.categories, { id: crypto.randomUUID(), name: categoryName, kind: categoryKind, living: categoryKind === 'expense' }] }); this.display(); await this.plugin.refresh(); }); }));
    new Setting(containerEl).setName('备份与恢复').setHeading();
    new Setting(containerEl).setName('完整 JSON 备份').setDesc('包括配置、追加批次和草稿，不包含 API 密钥。').addButton(b => b.setButtonText('导出备份').onClick(() => { void this.plugin.open().then(view => view.ui?.export()); }));
    new Setting(containerEl).setName('恢复备份').setDesc('仅恢复到没有配置、账户、草稿或其他文件的空目录。已有数据时先切换到新目录，原文件保留。').addButton(b => b.setButtonText('选择 JSON 备份').onClick(() => {
      const file = containerEl.ownerDocument.createElement('input'); file.type = 'file'; file.accept = '.json,application/json';
      file.addEventListener('change', () => { void this.run(async () => { const selected = file.files?.[0]; if (!selected) return; requireThat(selected.size < 100_000_000, '备份文件过大'); await this.plugin.repo.restoreBackup(JSON.parse(await selected.text())); await this.plugin.refresh(); this.display(); new Notice('备份恢复完成'); }); }); file.click();
    }));
  }
}
