# Desktop application

这里将承载正式 Electron + React + TypeScript 桌面应用。

计划边界：

```text
src/
  main/       Electron main process
  preload/    typed narrow context bridge
  renderer/   React UI
```

Phase 1 dependency gate 已于 2026-08-31 获批。当前入口位于项目根 `package.json`，使用 `tools/workbench.ps1` 调用项目内 portable Node。

P3-C public preload 只有两个冻结方法：`workbench.app.getInfo.v1` 与 `workbench.schematic.resolveReviewedArtifact.v1`。后者只接受 exact document/artifact revision 与 `intent="render"`；生产 main 入口静态绑定 empty registry，并由编译期 profile 消除 development renderer URL、DevTools、fixture loader 与 raw asset 路径。开发/测试 main 入口才可从固定、hash-pinned raw assets 构建单一 `flat-basic` synthetic registry。运行时 env、argv、renderer 请求或配置不能切换 profile。P3-C 已通过合同、全量回归、构建与独立安全验收；文件、路径、shell、进程、真实 backend、OA/EDA 和写回能力仍不存在，P3-D Electron 仍为 NOT_RUN。
