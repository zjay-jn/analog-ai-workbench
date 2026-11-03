# Document contract

状态：phase2_readonly_pass_phase3_p3a_identity_pass

统一文档标签、capability、dirty/save/close 生命周期和 Provider 接口。首批 Provider 为 `text` 与 `schematic_reviewed`。

Phase 2 当前已完成只读 synthetic `text` 工作台：

- canonical identity 为 DocumentId + immutable RevisionId + documentKind discriminator；
- 绝对路径不是 identity，Renderer 不获得真实 root/path；
- 通用客户端保存已延期，当前没有文件 IPC、真实持久化或用户文件访问；
- 既有 Provider 保存状态机作为未来写入候选合同保留，但不属于当前可达能力；
- `schematic_reviewed` 的 P3-A identity/registry seam 已通过合同测试；Viewer、IPC、真实 payload 与写入能力仍未授权。

Phase 3 P3-A 在 `src/reviewed-identity.ts` 冻结 reviewed identity seam：

- `ReviewedDocumentRefV1` 精确使用 `documentId + revisionId + documentKind="schematic_reviewed"`；
- `ReviewedArtifactRefV1` 精确使用 `artifactId + revisionId + artifactKind="circuit_ir_reviewed"`；
- canonical equality 分别为 ID + immutable RevisionId，kind 是完整性 discriminator；
- `parseReviewedDocumentRefV1()` 与 `parseReviewedArtifactRefV1()` 是 canonical ref 的唯一 parser：只接受 `Object.prototype` plain object、可枚举 data descriptors 和精确字段；symbol、accessor、non-enumerable、额外或缺失字段全部 fail closed；
- ID 与 revision 只允许 ASCII `[A-Za-z0-9._-]` 合同字符集、首字符必须为字母或数字，且最多 128 UTF-8 bytes；control、slash/backslash、URI/path-like 值与保留字 `latest` 均拒绝，不做 normalization 或别名化；
- `schemas/reviewed-identity.v1.schema.json` 是精确 V1 schema；Document/Artifact kinds 固定为 const，每层 object 都是 `additionalProperties:false`，identity component 的 `pattern`/`maxLength` 与 TypeScript parser 一致；
- `createReviewedIdentityRegistryV1()` 只接受 additional-properties fail-closed 的精确对象，并维护 Document revision 与 Artifact revision 的双向唯一、不可变 binding；同一 `documentId` 最多一个 `freshness="current"` binding；
- 只有 refs 与 main-owned freshness 均相同的 exact binding 才可幂等重放；一对多、多对一、freshness 改写或第二个 current 都保留原 binding、隔离请求及既有 partner identities，并以 `INTERNAL`（`never`/`none`）失败关闭，后续任一方向 resolve 继续返回 `INTERNAL`；
- 已授权边界之后，未知、缺失、删除、不可验证或不可解析的精确 revision 统一为 `REVISION_UNAVAILABLE`（`never`/`none`）；保留且可验证的旧 snapshot 以 `freshness="historical"` 正常解析，不等同 stale；
- registry 不接受 `latest` revision，不按名称、路径或邻近关系回退，也不会静默升级 revision；所有成功返回的 binding 与嵌套 ref 均冻结；
- stable identity 只用于相等性与解析，不是 capability。`freshness` 只能由 main-owned reviewed admission 根据已接纳 snapshot 赋值；renderer、请求或 payload 自报的 freshness 不得进入 registry。调用方授权、workspace ownership 与 IPC sender 校验仍必须在 main 的 typed resolve 边界先完成。

P3-A 仍是 synthetic、read-only contract seam；不授予文件 payload、EDA/OA、网络、保存或真实 adapter/backend 能力。完整 gate 见 `docs/dependency-gate-phase3-reviewed-schematic.md`。
