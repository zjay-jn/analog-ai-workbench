# Tests

Phase 1 与改版后的 Phase 2 只读审阅当前覆盖：

- Renderer 无 Node 权限与 BrowserWindow 安全属性；
- typed preload 精确为两个冻结方法（`getInfo` 与 reviewed artifact resolve），无 generic invoke/send/on；
- `workbench.app.getInfo.v1` request/result schema；
- IPC sender、top frame 和获准页面正负例；
- 构建期 privileged import / raw IPC surface 扫描；
- Phase 2 运行模式文案、只读文档、保存延期与离散 gate 状态；
- 四个 CodeMirror 直接依赖的精确版本/integrity，以及新增传递集的 MIT/无安装脚本边界；
- DocumentProvider clean/dirty/checking/saving/conflict/error/close 核心转换与非法转换，作为未来写入候选合同保留；
- CodeMirror 只读合成 fixture、CSP nonce、EditorView 生命周期与文件能力关闭状态；
- 合成 Agent 修改提案的 diff、同意/拒绝状态，以及“未应用、未保存”的明确 oracle；
- 真实 Windows Electron 启动、Renderer→Preload→Main 握手、外部 CSS、1366×768 三栏布局、退出和安全全局检查。

P2-FS-SAFETY 与 native helper 的路径、junction、hard link、TOCTOU、严格文本、revision、冲突、replace/restart 和 hard-vector 测试结果作为历史 checkpoint 保留。真实 symlink/mount/cloud-provider 与独立评审未闭合，因此它们不能支持任何写入能力；但通用保存已经延期，不再阻塞当前只读 Phase 2。

文件 IPC、真实打开/保存、自动应用提案与快速打开均保持 NOT_AVAILABLE。当前 production ToolBroker registry 为空，测试不调用真实 Agent、模型、网络或用户数据。

Phase 3 当前增加三层零依赖测试：

- P3-A 覆盖 strict raw bytes、canonical JSON、reviewed identity、Circuit IR graph/budget、hash-pinned synthetic manifest/admission、quarantine、immutable hash 与 8 个手写 synthetic fixtures；
- P3-B 覆盖 exact artifact revision 绑定、occurrence-aware immutable view state、fit/zoom/pan、6 CSS px hit-test、selection/net/hierarchy/overlay、closed SVG scene、恶意 label 的 escaped text、视口矩阵、键盘/roving focus/ARIA，以及 Viewer 不绕过 typed host；
- P3-C 覆盖 exact request/result、production empty/development raw-only registry、CallerContext 与 pre-delivery lifecycle fence、structured clone/deep-freeze、late result 丢弃、双标签 host，以及 production/development main 构建图隔离。

P3-C 当前 18/18 定向合同、91/91 全量回归、typecheck、security 和 production/development build 已进入 current GREEN；production bundle oracle 同时证明 development renderer URL、loopback、DevTools、fixture loader/raw asset 与文件读取入口不可达。P3-D Windows Electron 与视觉验收已由独立 exit bundle 固定为历史 PASS。

Phase 4 当前增加四层 Agent-first、无模型/无工具/无真实 RAG 的合成验收：

- P4-A 冻结并执行 strict byte codec、schema/canonicalization、public surface、N01–N30 traceability 与 synthetic fixture manifest；
- P4-B 执行 deterministic reducer、restartable ledger、cancel/replay/quarantine 与注入时钟/故障点；
- P4-C 覆盖 exact 七方法 preload、五个 Agent IPC channel、CallerContext、delivery fence、production empty/development synthetic build separation，以及 Renderer streaming/cancel/recovery/citation/ARIA；
- P4-D 使用隔离 Windows Electron harness 覆盖 1366×768 下 125%、150% 与应用内部 200%，三种 Agent 视觉状态、六种 lifecycle revocation 竞态和 production empty boundary。生产 preload 必须是单文件 sandbox-compatible bundle，不能含本地相对 `require`。

P4-D matrix 的每个 PASS 都要求真实 Electron、sandbox/context isolation/no Node/no webview、精确七方法 API、无横向溢出、键盘/ARIA、artifact digest 不变、撤销后零 delivery、无 orphan，以及 file/native-save/OA-EDA/network/process/registry mutation 计数全为 0。截图仅辅助，机器可读 DOM/state/security/process oracle 与 raw log 才是主证据。
