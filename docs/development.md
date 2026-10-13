# 开发、检查与发布

## 环境与构建

需要 Node.js 22 或更高版本及 npm。在源码仓库根目录运行：

```powershell
npm ci
npm run verify
npm run package
```

`verify` 执行核心测试和 TypeScript／esbuild 构建。`package` 重新构建，生成 `dist/LifeLedger-<版本>.zip`、三个独立运行文件、`SHA256SUMS.txt` 及包内文件清单；使用同一份 ZIP 数据回读并逐字节校验，避免分发旧构建或夹带账本。ZIP 打包本身可在 Windows、macOS 和 Linux 的 Node.js 环境运行。

更新版本时同步 `package.json`、`package-lock.json`、`manifest.json`、`versions.json` 及变更记录。插件 ID 保持 `lifeledger-next`，以免让已有账本变成另一份插件配置。`private: true` 只阻止误发布到 npm，不影响 GitHub 开源。

## 隔离 Obsidian 实机

```powershell
npm run verify:ui
npm run verify:adversarial
npm run verify:currency
npm run verify:screenshots
npm run open:review
```

脚本在 `validation-vault/` 创建独立 Vault 和应用配置，只使用虚拟金额和本机模拟 API，不打开或改写日常 Vault。证据在 `evidence/`；两目录都被 Git 排除。`open:review` 保留已存在试验库中的操作；第一次运行需要先通过 `verify:ui` 生成样例。

当前实机脚本在 Windows 上验证，使用本地 Obsidian 1.14.4。Windows 默认从 `LOCALAPPDATA` 和 `APPDATA` 发现程序及应用包，没有作者电脑的固定路径。自定义安装位置可以设置：

```powershell
$env:OBSIDIAN_EXECUTABLE = 'D:\Apps\Obsidian\Obsidian.exe'
$env:OBSIDIAN_ASAR = 'D:\ObsidianRuntime\obsidian-1.14.4.asar'
npm run verify:ui
```

需要已安装并启动过 Obsidian，拥有可读的 `.asar` 应用包。隔离 UI 启停脚本当前按 Windows 实现；macOS／Linux 的 UI 自动化未验收。不要把测试路径改成日常 Vault。CI 在 Linux 运行核心、构建与打包，不运行桌面实机脚本。

## 源码与安装包

源码仓库包含 `src/`、`tests/`、`scripts/`、文档和虚拟截图。插件 ZIP 包含运行文件、使用文档、截图、许可证和来源说明，不包含开发依赖、源码测试环境、Vault、设备配置或密钥。直接下载源码 ZIP 后还需要构建；普通用户从 GitHub Releases 下载插件 ZIP。

人工发布前运行全部相应检查，确认 `dist/package-info.json` 的版本和回读结果。GitHub Release 上传 `main.js`、`manifest.json`、`styles.css`、插件 ZIP 与 `SHA256SUMS.txt`，使用预发布标记，保留未完成的真实链路验收说明。

作者及维护者为 Silas。Release 标签应指向已提交、已通过检查的源码；上传附件后核对远端大小和 SHA-256。README 提供对应版本的 ZIP 下载链接，预发布不依赖 `/releases/latest` 跳转。旧 Obsidian-LifeLedger 已归档，迁移提示指向本仓库；未单独发布的本地版本在 CHANGELOG 明确标注。

## 提交前复核

检查 `git status` 和待提交清单，确保只有源码、测试、公开文档及虚拟截图。`node_modules/`、`dist/`、`main.js`、`validation-vault/`、`evidence/`、`.obsidian/`、`data.json` 和环境文件不进入 Git。发布运行文件通过 Release 附件提供。

先阅读 [参与开发](../CONTRIBUTING.md)，保持整数金额、草稿确认和追加保存的约束。

多币种实机脚本默认使用模拟 AI 和模拟参考汇率。单独验证真实公共参考汇率可运行 `$env:LIVE_RATES = '1'; npm run verify:currency`；此查询只用于虚拟 Vault，不使用金融 API 密钥，不表示真实口播已验收。

截图脚本使用 Canvas 生成虚拟账单，模拟视觉服务通过插件真实请求接口返回可核对文字。覆盖选图、粘贴及拖入事件、范围过滤、补充用途、临时图片清除、备份恢复、错误与迟到回复。结果不代表真实 OCR 准确率，也不证明操作系统剪贴板已经验收；请求体不写入证据文件。
