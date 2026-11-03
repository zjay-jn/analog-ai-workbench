# Agent adapters

这里保存 Phase 4 的模型中立 Agent 合同。当前实现严格限定为
`SYNTHETIC AGENT · NO MODEL · NO TOOLS`：没有真实模型、RAG corpus、网络、凭据、
ToolBroker、文件、Python、进程或 OA/EDA 能力。

## P4-A public surface

- `src/agent-contract.ts`：`aaw.agent/v1alpha1` 常量、唯一错误/警告与
  retry/recovery pair、closed SourceEvent、CitationSource/CitationLocator、
  canonical decimal string 和 runtime hardening。
- `src/strict-agent-frame.ts`：唯一 raw ingress。只接受标准、非共享
  `Uint8Array`，在私有 copy 前执行 1 MiB cap，然后复用
  `aaw-json-c14n/v1` strict decoder并重算完整 payload SHA-256。
- `src/conformance.ts`：`aaw.agent.conformance/v1alpha1` closed harness union、
  hash-pinned seed binding/ledger、逐 vector result receipt、N01–N30 traceability、
  P4-A/P4-B/P4-C/P4-D 阶段纪律。Later-stage vector 在 P4-A 只冻结接口和
  machine oracle，执行状态为 `NOT_RUN`。
- `src/public-contract.ts`：canonical `DocumentRefV1`、`ArtifactRefV1`、
  `CitationRefV1`，closed resolve request/result、code/message 精确配对的 result
  runtime parser、preview 预算，以及纯 Tool 状态机。
- `src/canonical-contract.ts`：canonical event/source mapping 类型与 main-owned
  closed runtime parsers、六规则 retry/recovery reducer；P4-A 只冻结并验证合同，
  不启动 ledger/runtime。`ArtifactKindV1` 当前 closed 为
  `circuit_ir_reviewed|generic`，kind 只作完整性 discriminator。
- `CanonicalEventV1.warningCodes` 是唯一 Renderer 可见 warning carrier；当前只允许
  单项 `SOURCE_TIME_INVALID`。显示文案固定为
  `Source timestamp was invalid and was ignored.`，不回显原始 source time。
  Warning 与同一 committed `eventId`/`hostSequence` 一起 replay，Renderer 必须按
  event identity 去重显示与 ARIA announcement，不得因 replay 重复播报。

JSON Schema 位于 `schemas/`：

- `agent-source-event.v1alpha1.schema.json`；
- `citation-source.v1alpha1.schema.json`；
- `citation-locator.v1alpha1.schema.json`；
- `agent-conformance.v1alpha1.schema.json`；
- `agent-conformance-traceability.v1alpha1.schema.json`；
- `agent-conformance-results.v1alpha1.schema.json`；
- `agent-public-resolve.v1alpha1.schema.json`；
- `agent-canonical-contract.v1alpha1.schema.json`；
- `synthetic-agent-fixture-manifest.v1alpha1.schema.json`。

`fixtures/n01-n30.traceability.json` 为所有 state vector 提供 closed、可解析的
binding/run/mapping/ledger seed；`fixtures/p4a-conformance-results.json` 必须对每个
vector 恰好给出一个结果。当前 P4-A required vector 为 `PASS`，P4-B/C/D vector
必须显式为 `NOT_RUN`，不得通过遗漏结果获得阶段 PASS。

P4-A conformance v1alpha1 addendum 仅冻结 P4-B deterministic synthetic core 的
可执行合同：N18/N19/N20/N21/N28 新增 20 个 cancel、checkpoint/ack、真实不一致
corruption seed 与 host replay/snapshot-tail 子场景。step 使用 closed
action-specific 字段；run/checkpoint/ack 状态同样采用 closed rows，不使用自由文本
corruption flag。既有 P4-A `PASS` receipt 保持不变，新增 20 个 P4-B receipt 全部为
`NOT_RUN`，P4-C/P4-D 不变；本增量不实现 P4-B core、IPC、capability、真实模型/RAG、
网络、ToolBroker 或文件/OA/EDA 副作用。superseded P4-A PASS baseline、planned-set 和
RED report anchors 依次为 SHA-256=`2bc681ad7b0870af8924c381883bdbd33b8976f8aef76d3acdf56710a2453272`、
`bf6cbf7f5e5d6713034e62284b072a454d447e024fc479d6e999a797d488061b`、
`d998cdde411c1232b9bed407b5704f14526e5d766e1acc3e5908cadfa4a88775`。

Conformance review consolidation进一步冻结 action-family 精确字段表：replay cursor省略
等价于 `afterHostSequence=0`，cancel/clock action只接受 main monotonic safe integer，
source identity必须按 action 成对出现且 resolve严格绑定 `api+request`。Expected oracle按
replay、cancel、ledger-recovery/cancel-ack family关闭，并可携带 exact mapping、checkpoint、
ack rows与 post-run lifecycle。N18 live-tail和N28 cancel acknowledgement固定完整 canonical
event/row identity；N20固定 cancel command/checkpoint restart状态。N21使用共同连续 valid base，
四个 corruption seed各只改变 mapping、ledger、checkpoint或ack中的一个关系；runtime双向
重算一致性，拒绝只有 `ledgerIntegrity="corrupt"` 而没有真实不一致的 flag-only fixture。

所有完整 canonical event/ledger oracle 都会解码 `canonicalUtf8Hex`、先调用 closed
canonical-event runtime parser，再重做 canonicalization 与 payload SHA-256并逐字段核对
event metadata。`acceptedAt` 的 runtime 与三个 schema 共享同一严格 Gregorian UTC
pattern。39 个 budget vector 同时冻结 `limit`、实际 `observed` 数值及 queued
resumability facts，并对完整 error/retry/quarantine/isolation/truncation/zero-delta
oracle 深比较，不能只声明 limit 或只比较 error code。

## Synthetic fixtures

`fixtures/approved-synthetic-agent-fixtures.manifest.json` 只引用手写 raw JSON
bytes，并固定 byte length、raw SHA-256、完整 canonical event SHA-256、payload
SHA-256、stable source identity、oracle IDs、provenance、license、classification
和 Phase 4 gate approval hash。它覆盖：

1. accepted → text delta → completed；
2. synthetic text citation；
3. synthetic reviewed-schematic citation；
4. `SYNTHETIC RAG SOURCE`/rag chunk；
5. structurally safe但语义无效的 source time warning path；
6. cancel acknowledgement evidence；
7. exact replay/resume；
8. explicit failure→main-owned recovery reduction。

这些 fixture 不是 production registry、真实来源或授权证据。`sourcePayloadDigest`、
receipt-like metadata、stable identity 和 host/source run ID 都不是 capability。

## Frozen boundaries

- public/internal source ingress 不存在 `acceptSourceEvent(object)`；
- SourceEvent taxonomy 与每类 payload 均为 closed discriminated union；不得在任何
  嵌套层提交 hostSequence/eventId/acceptedAt/canonical digest、caller scope、
  retryability/recoveryAction、resolver token、path/URI、registry handle 或 grant；
- citation resolution始终绑定 exact revision，不做 name/path/latest/coordinate
  fallback；
- P4-A 不修改 desktop main/preload/Renderer，不启动产品进程；
- production AgentAdapter、RAG、ToolBroker 和 fixture registries 继续为空；
- P4-B reducer/ledger、P4-C desktop host、P4-D Electron 均未由 P4-A 的 PASS
  自动授权。

## P4-B deterministic synthetic core

P4-B 只新增 test-only、capability-free 的确定性 synthetic reducer 与可重启内存
ledger。`deterministic-synthetic-adapter.ts` 的唯一 source ingress 是 raw
`Uint8Array`，并复用 P4-A strict frame decoder；它没有 production registry、网络、
模型、RAG、ToolBroker、文件或进程入口。`synthetic-agent-core.ts` 执行冻结的 reducer
语义，canonical emission 必须从 ledger UTF-8 bytes 经 closed parser round-trip；
`agent-ledger-contract.ts` 独立重算 mapping/event/checkpoint/ack 一致性，并提供
mapping + event + checkpoint 原子提交、commit 后独立 ack、restart snapshot 与
ack-before-commit fail-closed 约束。

`fixtures/p4b-conformance-results.json` 是完整 120-row receipt：73 个既有 P4-A 与
40 个 P4-B vector 为 `PASS`，P4-C 的 6 个与 P4-D 的 1 个仍为 `NOT_RUN`。P4-B
不授权或实现 desktop IPC/Renderer、真实 adapter/model/RAG/network/tool/file/OA/EDA
能力，也不改变 P4-A schema、traceability 或既有 receipt。
