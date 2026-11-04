# Analog AI Workbench

面向模拟电路工程的 Windows 桌面工作台。项目复用 OpenCode 的原生 Agent 会话、工具循环与上下文压缩，重点建设聊天与原理图之间的查询、引用和双向定位。

当前版本：`0.1.0-alpha.0`。本分支包含 Windows 普通安装包的构建流程；安装包为未签名 alpha。本文不提供尚未发布的下载链接，也不把构建完成视为安装验证通过。

## 当前能力

- 项目与聊天管理、置顶、模型设置、增量显示回复。
- 文件上下文、工具执行摘要、命令状态与本地诊断记录。
- 只读原理图显示、对象引用及答案与画布的定位。
- DeepSeek、Kimi 接入；用户自行配置服务凭据，调用费用由对应服务收取。

真实 OA 查询已在一个历史电路副本上验证，但此私人电路及运行环境不随软件或公开源码分发。公开样例与真实工程的验证范围分别记录；目前不承诺任意 Virtuoso 工程、实时 GUI 同步或原理图修改。

## 安装与启动

普通用户使用经核对的 `AnalogAIWorkbench-<版本>-windows-x64-setup.exe`。安装包离线包含 Electron `43.4.0`、Node.js `24.20.0`、OpenCode `1.18.17` 和预编译原生组件，不需要用户安装 Node、npm、Python、Visual Studio 或 Windows SDK。支持 Windows x64 的本地固定磁盘。

安装位置固定为当前用户的 `%LOCALAPPDATA%\Programs\AnalogAIWorkbench`。安装后从开始菜单或桌面快捷方式打开。首次运行会核对组件并完成本机运行环境自检；模型密钥在界面中配置。合成原理图不需要模型密钥、WSL 或 Cadence。

聊天、设置、日志和工作区保存在 `%APPDATA%\AnalogAIWorkbench\.local`。升级前关闭工作台；卸载保留用户数据，并保留安装目录内不属于安装清单的文件。源码版默认使用同一数据位置，开发时可另选数据根。

源码安装仍保留，适用于需要修改或构建项目的开发者：

```powershell
npm ci
npm run setup:desktop
npm start
```

源码安装需要 Node.js `24.20.0`、npm `11.19.0`、Python 3.10+、Visual Studio 2022 C++ Build Tools 及 Windows SDK。详见 [安装说明](docs/INSTALLATION.md)；制作安装包见 [开发说明](docs/DEVELOPMENT.md)。

## 源码验证

Windows x64，Node.js `24.20.0`、npm `11.19.0`。版本以 `package.json` 和 `package-lock.json` 为准。

```powershell
npm ci
npm run typecheck
npm run test:public
npm run test:security
npm run licenses:check
npm run release:audit
npm run check:public-source
```

`.npmrc` 刻意关闭依赖安装脚本；上述源码检查不需要 Electron 二进制、模型密钥、WSL 或 Cadence。`check:public-source` 只向 `.local/public-source-check` 构建，不替换现有桌面程序。

源码检查、安装包构建、真实安装与真实模型连接是不同的验证范围。源码启动前应完成 `setup:desktop`；`doctor` 只检查源码安装的运行就绪和构建前置条件。源码安装位置或数据根变化后，重新运行安装验证。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `apps/desktop` | Electron 主进程、窄 preload 接口与 React 界面 |
| `packages` | 文档/原理图合同、适配器与原生文件能力源码 |
| `tools` | 构建、测试、运行器、安装包与公开源码检查 |
| `tests` | 合成测试及显式的环境集成测试 |
| `docs` | 公开架构、安装、开发、路线与发布说明 |

[架构](docs/ARCHITECTURE.md) · [路线](docs/ROADMAP.md) · [贡献](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [第三方来源](THIRD_PARTY_NOTICES.md)

## 协议与资料

项目代码使用 [MIT](LICENSE)。第三方组件保留各自许可证；安装包保留相应许可与通知。真实电路、OA、PDK、模型、仿真结果、个人会话、密钥及本机日志不属于分发内容。发布前还须通过 [发布清单](docs/RELEASE_CHECKLIST.md) 中的来源与独立副本检查。
