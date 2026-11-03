# Windows filesystem native boundary

`aaw.windows-fs-native/v1alpha1` 是 Phase 2 native filesystem helper gate 的项目自有 Node-API/Win32 实现。

状态：`deferred_candidate_not_product_reachable`。用户已将当前 Phase 2 改为只读文档与修改提案审阅，通用客户端保存延期。本包、构建输出和既有证据继续保留，但当前暂停，不再是只读 Phase 2 的退出 blocker。未来只有通过独立 ToolBroker 写入/应用 dependency/security gate 后，才可重新评估接线；当前仍无 preload、Renderer、IPC 或用户文件能力。

当前只提供：

- 固定本地磁盘 root handle 校验；
- 逐级 `FILE_FLAG_OPEN_REPARSE_POINT` 检查；
- volume/file ID、reparse tag、hard-link 与 regular-file 证明；
- 从稳定 handle 读取最多 2 MiB 合成文本 bytes。
- 同目录临时文件写全与 flush、二次内容/identity 冲突检查；
- `ReplaceFileW` 同卷 backup、逐字节 readback 与失败回滚；
- 1175/1176/1177 显式分支和并发外部版本恢复。
- main-owned、严格序列化的合成 save journal；
- 确定性 operation ID 与跨进程 restart reconciliation。
- Windows disk-full/permission 安全错误归约；
- replace/readback 时 DACL 摘要校验，不向 public schema 暴露 ACL；
- fixed-drive 与任意 reparse metadata 的 fail-closed 分类。

当前明确不提供：

- list/delete/copy/move；
- raw handle、通用 Win32/FFI 或动态 DLL 调用；
- preload、Renderer 或 IPC surface；
- 用户文件访问。

源码只允许通过根目录的 `build:native:fs` 具名命令构建。构建需要显式设置 `AAW_NATIVE_PYTHON`，输出复制到 `.local/native-build/windows-fs-native`。没有 install/postinstall lifecycle。

生产 addon 具备 `atomicReplace=true` 的 synthetic-tested primitive 与 main-only `reconcileVerifiedText`；单独的 test addon 才包含 fault injection 入口，production binary 扫描会拒绝入口、fault 名称和测试错误码。两者都只在显式 native build/test 中加载，没有 runtime/IPC 接线。

跨进程测试已覆盖 journal 写入后、replace 前、replace 后、外部并发版本 replace 后及 backup cleanup 后崩溃；恢复进程分别给出 not_committed、rolled_back、conflict_rolled_back 或 committed。Hard-vector 测试另覆盖 disk-full-style、权限、backup cleanup、不可自动恢复 marker、ADS/设备名/尾随语法、Unicode/长路径/大小写、DACL/attributes/named streams/BOM/EOL、drive type 与 mount/symlink/cloud/第三方 reparse metadata。真实 file symlink 因当前主机 EPERM 为 SKIP；真实 mount/cloud-provider object 仍不可用。这些未闭合项不阻塞当前只读产品，但会在任何未来写入 gate 中重新成为硬 blocker；当前子能力 PASS 不等于真实文件保存已获准。
