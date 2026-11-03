# Tools

仅放项目内可审核的构建、验证和发布工具。生成物、依赖、密钥和本机配置不进入 Git。

- `workbench.ps1`：只调用项目内 Node 24.20.0/npm 11.19.0，并固定 Electron cache。
- `dev-desktop.mjs`：只启动固定 Vite renderer 与 Electron 项目入口，退出时回收子进程；--smoke 会隐藏窗口并验证开发样式链路。
- `smoke-electron.mjs`：在 1366×768 验收窗口下运行隐藏 Windows Electron 生命周期、IPC、外部样式和三栏布局 smoke。
- `verify-security.mjs`：扫描公开 preload、IPC 和 renderer source surface。
