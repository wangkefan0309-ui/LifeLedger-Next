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
npm run capture:demo
```

脚本在 `validation-vault/` 创建独立 Vault 和应用配置，只使用虚拟金额和本机模拟 API，不打开或改写日常 Vault。证据在 `evidence/`；两目录都被 Git 排除。`open:review` 保留已存在试验库中的操作；第一次运行需要先通过 `verify:ui` 生成样例。

`capture:demo` 单独创建仅含虚拟账户与交易的演示 Vault，不配置 API 或密钥，拍摄浅色、深色首页及“首页与外观”设置。输出在 `evidence/demo-v<版本>/`，人工查看后才复制到 `docs/images/`；README 图源为真实插件界面截图。

当前实机脚本在 Windows 上验证，使用本地 Obsidian 1.14.4。Windows 默认从 `LOCALAPPDATA` 和 `APPDATA` 发现程序及应用包，没有作者电脑的固定路径。自定义安装位置可以设置：

```powershell
$env:OBSIDIAN_EXECUTABLE = 'D:\Apps\Obsidian\Obsidian.exe'
$env:OBSIDIAN_ASAR = 'D:\ObsidianRuntime\obsidian-1.14.4.asar'
npm run verify:ui
```

需要已安装并启动过 Obsidian，拥有可读的 `.asar` 应用包。隔离 UI 启停脚本当前按 Windows 实现；macOS／Linux 的 UI 自动化未验收。不要把测试路径改成日常 Vault。CI 在 Linux 运行核心、构建与打包，不运行桌面实机脚本。

`verify:ui` 在 0.1.7 新增账户排序检查，包含取消、置顶／上下移动、键盘操作、两页同步、旧窗口冲突、改名保留位置、新账户追加、明暗窄窗口及插件重启。核心测试核对排序后的资金、笔记、交易及备份恢复，沿用既有账户数组顺序，无需数据迁移。

0.1.8 在同一脚本新增首页标语和三种外观检查：未保存关闭、纯文字显示、固定主题独立于系统与 Obsidian、系统变化保留弹窗输入、最长标语窄窗格、重启和空白恢复默认。外观测试通过 `emulateMedia` 模拟操作系统深浅偏好，插件使用所属窗口的 `matchMedia`，色板仅作用于插件视图；Canvas 监听视图的实际主题，销毁时释放监听。配置中的 `homeSlogan` 和 `theme` 是可选字段，缺字段的旧账本及备份继续可读，保存和恢复沿用原配置校验及冲突检查。

## 源码与安装包

源码仓库包含 `src/`、`tests/`、`scripts/`、文档和虚拟截图。插件 ZIP 包含运行文件、使用文档、截图、许可证和来源说明，不包含开发依赖、源码测试环境、Vault、设备配置或密钥。直接下载源码 ZIP 后还需要构建；普通用户从 GitHub Releases 下载插件 ZIP。

人工发布前运行全部相应检查，确认 `dist/package-info.json` 的版本和回读结果。GitHub Release 上传 `main.js`、`manifest.json`、`styles.css`、插件 ZIP 与 `SHA256SUMS.txt`，保留未完成的真实链路验收说明。现有0.1.8为GitHub预发布，尚未进入官方社区目录。

作者及维护者为 Silas。Release 标签应指向已提交、已通过检查的源码；上传附件后核对远端大小和 SHA-256。README 提供对应版本的 ZIP 下载链接，预发布不依赖 `/releases/latest` 跳转。旧 Obsidian-LifeLedger 已归档，迁移提示指向本仓库；未单独发布的本地版本在 CHANGELOG 明确标注。

社区候选版的标签须与 `manifest.json` 的版本精确一致，例如版本及标签均为 `0.1.9`，既有 `v0.1.8` 等发布快照保留。候选版建议使用正式Release；预发布标记的处理以当前官方后台核查为准。提交从 [Obsidian Community](https://community.obsidian.md) 连接GitHub后进入 New plugin，详见[官方提交指南](https://docs.obsidian.md/plugins/releasing/submit-plugin)。

社区准备流程已于2026-10-14确认：先官方代码规范检查与已知窗口异常，再双语界面和英文记账核对、双语文档、候选版验收及提交。当前尚未接入官方ESLint、修改卸载行为或完成双语，不由既有核心测试及CI推定通过社区扫描。社区发布不额外加入手机、其他汇总币种或预算模块。

## 移动或改名源码目录

本节讨论开发用的源码工程。用户 Vault 内的 `LifeLedger/` 数据目录按 [账本移动指南](guide.md)处理，`.obsidian/plugins/lifeledger-next/` 安装目录保持插件ID。

源码工程可整体移动或改名，保留内部结构及隐藏的 `.git` 目录后，Git 历史与远端关联仍在。构建和打包从工程的新位置执行，已复制到用户日常 Vault 的插件不会随源码目录移动。

移动前关闭工程内的试验库和占用旧目录的终端，移动后在开发工具里重新打开新位置。Obsidian 注册的试验库路径、已有快捷方式和历史验证记录中的绝对路径仍指向原位置；使用试验库时需在 Obsidian 中重新选择新路径。已有 `validation-vault/review-profile` 保留旧注册路径，`打开试验库.cmd` 不会自动迁移这条记录。已安装插件的目录 ID 仍须为 `.obsidian/plugins/lifeledger-next`。

## 提交前复核

检查 `git status` 和待提交清单，确保只有源码、测试、公开文档及虚拟截图。`node_modules/`、`dist/`、`main.js`、`validation-vault/`、`evidence/`、`.obsidian/`、`data.json` 和环境文件不进入 Git。发布运行文件通过 Release 附件提供。

先阅读 [参与开发](../CONTRIBUTING.md)，保持整数金额、草稿确认和追加保存的约束。

多币种实机脚本默认使用模拟 AI 和模拟参考汇率。单独验证真实公共参考汇率可运行 `$env:LIVE_RATES = '1'; npm run verify:currency`；此查询只用于虚拟 Vault，不使用金融 API 密钥，不表示真实口播已验收。

截图脚本使用 Canvas 生成虚拟账单，模拟视觉服务通过插件真实请求接口返回可核对文字。覆盖选图、粘贴及拖入事件、范围过滤、补充用途、临时图片清除、备份恢复、错误与迟到回复。结果不代表真实 OCR 准确率，也不证明操作系统剪贴板已经验收；请求体不写入证据文件。
