# 一壤 · Yirang

一壤是把**桌面文件与 Codex 对话**放在同一个工作区里的 Windows 应用。把材料拖上画布，选中文件问 Codex，再回到原文件查看修改或在画布上打开新产出。

## 桌面文件

- 在画布上整理文档、表格、图片和代码，支持多桌面、区域、缩放和文件预览。
- 保留导入文件的原始格式。可以打开历史版本，也可以通过系统默认应用打开落盘文件。
- 使用文件同步查看桌面版本与本地文件之间的差异，遇到冲突时选择要保留的版本。

## Codex 协作

- 在右侧对话中引用当前选中的材料，也可以用「截图问 AI」圈出要讨论的内容。
- Codex 可读取引用文件的工作副本。写回成功后，修改进入原桌面对象的版本历史。
- 新产出可返回任务所在的画布，从对话中的文件卡片定位。对话、命令执行状态和文件结果可以在同一处查看。

## 安装与使用

1. 从 [Releases](https://github.com/wyy-debug/Yirang/releases) 下载 Windows x64 安装包并运行。
2. 打开一壤，拖入文件或文件夹。选择材料后点击「问 AI」。
3. 在设置中连接本机的 Codex CLI，并按提示登录。桌面数据保存在本机，模型请求由配置的 CLI 和服务处理。

Office 排版预览可配置本机 LibreOffice。图片文字识别使用 Windows OCR，需要相应的系统语言组件。

## 从源码运行

在 Windows x64 上安装 Node.js 24.12.x，在仓库根目录执行。

```powershell
npm ci
npm run dev
```

`npm run check` 依次运行类型检查、构建和测试。安装 Inno Setup 6 后，执行以下命令生成安装器和更新 ZIP，输出位于 `release/installers`。

```powershell
npm run package:electron -- --update-zip
```

桌面窗口及 CLI 连接在 [apps/electron](apps/electron)，画布在 [apps/panel](apps/panel)，本地数据和文件操作在 [packages/local-runtime](packages/local-runtime)，桌面工具协议在 [packages/mcp-adapter](packages/mcp-adapter)。

## 致谢

感谢这些项目的作者、维护者和贡献者。一壤的桌面运行时、画布、文件处理与 AI 连接都受益于他们的工作。

| 用途 | 项目 |
| --- | --- |
| 桌面运行时 | [Electron](https://github.com/electron/electron)、[Chromium](https://www.chromium.org/)、[Node.js](https://github.com/nodejs/node) |
| 界面与画布 | [React / React DOM](https://github.com/react/react)、[React Flow（xyflow）](https://github.com/xyflow/xyflow) |
| AI 与浏览器连接 | [OpenAI Codex](https://github.com/openai/codex)、[OpenAI MCP Extensions](https://github.com/openai/mcp-extensions)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[MCP Apps](https://github.com/modelcontextprotocol/ext-apps)、[Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) |
| 预览与文件处理 | [Mozilla PDF.js](https://github.com/mozilla/pdf.js)、[ExcelJS](https://github.com/exceljs/exceljs)、[fast-formula-parser](https://github.com/LesterLyu/fast-formula-parser)、[SheetJS SSF](https://github.com/SheetJS/ssf)、[PptxGenJS](https://github.com/gitbrent/PptxGenJS)、[JSZip](https://github.com/Stuk/jszip)、[PNGJS](https://github.com/pngjs/pngjs)、[Saxes](https://github.com/lddubeau/saxes) |
| 本地存储与数据校验 | [SQLite](https://www.sqlite.org/)、[sqlite-vec](https://github.com/asg017/sqlite-vec)、[Ajv](https://github.com/ajv-validator/ajv)、[Zod](https://github.com/colinhacks/zod) |
| 构建、测试与安装 | [TypeScript](https://github.com/microsoft/TypeScript)、[esbuild](https://github.com/evanw/esbuild)、[Playwright](https://github.com/microsoft/playwright)、[Electron Packager](https://github.com/electron/packager)、[Inno Setup](https://jrsoftware.org/inno-setup) |

Bot 编排设计也参考了 Fei2411 和贡献者的 [DS-Bot](https://github.com/Fei2411/DS-Bot)。

直接依赖和锁定版本见 [package.json](package.json) 与 [package-lock.json](package-lock.json)。各项目的许可和声明见上游仓库。
