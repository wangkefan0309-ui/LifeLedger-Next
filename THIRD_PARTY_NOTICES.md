# 来源与依赖许可

LifeLedger 使用 [MIT 许可证](LICENSE)。

## 人生亮格引擎

`src/ui/vendor/grid.js` 适配自项目维护者提供的本地“财富自由指南灯”代码。维护者于 2026-10-12 确认该代码属于自己，并将本项目中的适配版本一并按 MIT 授权；没有对应的公开源仓库链接。

适配版本保留 Canvas 绘制、追焦、点亮、熄灭和 Web Audio 合成，加入模块导出、可取消等待、嵌入面板格间距和实例配色。插件宿主负责主题切换、ResizeObserver、MutationObserver、RAF、音频及庆祝横幅的生命周期。

## 开发依赖

插件运行时仅由 Obsidian 加载 `main.js`、`manifest.json` 和 `styles.css`，不打包 Obsidian 本体。以下依赖仅用于开发、类型检查、验证或打包，完整版本由 `package-lock.json` 固定。

| 依赖 | 用途 | 许可 |
| --- | --- | --- |
| Obsidian API 类型 | 插件类型定义 | MIT，Obsidian 应用本身另有条款 |
| TypeScript | 类型检查 | Apache-2.0 |
| esbuild | 构建 | MIT |
| tsx | 核心测试执行 | MIT |
| playwright-core | 隔离桌面检查 | Apache-2.0 |
| @types/node | Node.js 类型 | MIT |
| fflate | ZIP 安装包生成与校验 | MIT |

传递依赖遵循各自包内的许可证。发布包不携带开发依赖或 Obsidian 应用。
