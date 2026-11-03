# Schematic workbench

状态：`phase3_p3c_typed_resolve_implementation_green`

本包承载 synthetic reviewed Circuit IR 的严格只读合同。P3-A 当前包含：

- `strict-source-frame.ts`：只接受标准、非 SharedArrayBuffer 的 `Uint8Array`；用 typed-array intrinsic 在任何 snapshot 分配前读取可信 byteLength 并执行 8 MiB/调用方 maxBytes cap，之后仅做一次私有 copy，BOM、严格 UTF-8、duplicate-key、Unicode、negative-zero/number、prototype-key、top-level allowlist 与 raw SHA-256 全部只基于该 snapshot；
- `canonical-json.ts`：`aaw-json-c14n/v1` 的 UTF-16 key ordering、完整 canonical bytes 与 SHA-256；
- `reviewed-circuit-ir.ts`：Circuit IR graph/budget/hierarchy/reference 验证、occurrence-scoped net 解析与深冻结 snapshot；net-bearing port/pin/wire 与 net membership 双向唯一，且每个 non-blackbox parent pin terminal 与 child port 必须由唯一、完备、显式 terminal mapping 连接；
- `synthetic-admission.ts`：只接受 build-owned approved manifest raw bytes 创建 registry；manifest raw SHA-256 固定为 `sha256:b446b2063c9c580dd4009f43759f42e02bba851dd8070b94ab76acb1f7282ff4`。admission 外层请求仅为 `{ fixtureId, rawFrame }`，document/artifact refs、receipt、schema/c14n 与 digest 全部由 manifest 派生，并复用 `document-contract` 的 canonical parser/双向 identity registry；exact replay 幂等，证据冲突 quarantine 后 resolve 固定为 `INTERNAL`、`never`、`none` 且零 payload。
- `schemas/reviewed-circuit-ir.v1.schema.json` 与 `schemas/synthetic-fixture-manifest.v1.schema.json`：exact、`additionalProperties:false` 的 P3-A schema；schema `maxLength` 仅表示 code-point 结构上限，UTF-8 byte budget 与 lexical negative zero 由前置 strict codec/main semantic validator执行。Label 是有界 Unicode plain text，类似 markup/URL 的字符没有执行语义；raw HTML/SVG/XML/CSS/URI/command/extension 载体字段由 closed schema 拒绝。`fixtures/approved-synthetic-fixtures.manifest.json` 绑定 8 个手写 synthetic fixture 的 raw/canonical SHA-256、identity、计数、oracle、attestation 与 approvals。

P3-B 在不增加依赖的前提下新增 component-only Viewer seam：

- `viewer/view-state.ts`：绑定 exact `circuit_ir_reviewed` artifact revision 的 immutable occurrence-aware view state，以及 fit/zoom/pan、screen-space hit-test、selection/net highlight、层次 enter/back、overlay admission 与 Esc 清理合同；失败保持原 state；
- `viewer/svg-scene.ts`：只生成 `rect`、`circle`、`polyline`、`text` 的 closed safe-scene DTO；固定 attribute/style/layer allowlist，不产生 raw SVG、DOM、href/src/style/resource 或 untrusted DOM identity；
- `apps/desktop/src/renderer/SchematicViewer.tsx`：component-only React renderer，使用受控 `<g>` matrix 应用已验证 viewport，并提供单 canvas tab stop、roving tree/net list、ARIA live 与 Inspector seam。

P3-C 通过独立 production/development main 构建入口接通 typed resolve：production 固定 empty registry，并在编译期消除 development renderer URL、DevTools、fixture loader 与 raw asset 路径；development/test 只从固定 raw manifest 与 `flat-basic` raw fixture 复用 P3-A admission。Renderer 不导入 fixture/admission，只接收 IPC structured clone，并重新执行 closed envelope、canonical identity 与 Circuit IR validation，再建立 deep-frozen Viewer snapshot。该边界已通过 P3-C 合同、全量回归和独立安全/身份验收。双标签 App 已挂载 host，但生产模式只显示安全 unavailable 状态，不能得到 synthetic 或真实 payload。P3-D Electron 验收仍为 NOT_RUN。所有 Provider 状态固定为 `dirty=false`；没有文件/网络/process、Agent、OA/EDA connector、保存、导出或 writeback。权威 gate 为 `docs/dependency-gate-phase3-reviewed-schematic.md`。
