# Q04/Q05 production native wire

2026-09-14. PRODUCTION_COMPATIBILITY_SCOPED_PASS, NOT_ADMITTED. Root/main agreed the 11 fixed argv fields below. Phase0 scoped compatibility PASS is separate; production build, actual new compatibility, E2/E3 and security admission remain distinct.

## Directory and identity

Main first durably creates CommandRecord, then a new .local/agent-command-runner/executions/cmd-<UUID>. Native also accepts exactly .local/agent-command-runner/native-tests/<UUID>/executions/cmd-<UUID>; it rejects arbitrary paths. UUIDs are lowercase v4. The execution has control/runtime/baseline/work/home/temp and main's baseline-manifest.json.

Native argv, passed discretely with shell=false, is:

1. executionRoot
2. executionId
3. signature
4. UUID nonce
5. environmentRevision
6. commandSha256
7. scriptSha256
8. baselineVersion
9. baselineManifestSha256
10. absoluteDeadlineUnixMs
11. cwdRelativePath
12. Zero to32 sha256:bytes:relativePath entries.

Manifest order is UTF16 relativePath order, properties {relativePath,bytes,sha256}, JSON.stringify without a newline. Native reconstructs the digest. Hash fields are lowercase SHA256. Cwd is an existing ordinary directory within work, empty for root; dot-leading cwd segments are rejected. Ambiguous paths, links/reparse points, hard links and case aliases are rejected. Handles pin root/ancestors; no ancestor/system ACL is modified.

Runtime has exactly node.exe, LICENSE, bootstrap.ps1 and command.ps1. The command is exact BOM+original UTF8; native independently checks plain and BOM hashes. Main's control/intent.json is the sole initial control file; native read-pins it and records its digest in separate control/native-intent.json. Native never overwrites the driver intent.

Every lifecycle record binds executionId/signature/nonce/environmentRevision/commandSha256/scriptSha256/baselineVersion/baselineManifestSha256. Baseline and initial work must exactly match the manifest before write grants. Baseline/runtime remain immutable, child read-only. Work/home/temp receive the execution package SID with inheritance and low label. Root/control stay trusted-main only. Original selected projects get no new grants.

## Frozen interpreter template

System executable: C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe. Argv: -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File <runtime>\bootstrap.ps1. Flags: EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT. RemoteSigned is process-only; no registry, user/machine policy or GPO changes.

The bootstrap registers C: only if missing, AAWWork: at private work, and AAWTools: at private runtime. It sets the provider cwd through AAWWork and compares normalized ProviderPath to real Win32 cwd. Ordinary node alias resolves to AAWTools:\node.exe and is verified. The original command file runs normally in that runspace. Actual nonzero LASTEXITCODE takes precedence; an unsuccessful invocation with no nonzero code returns1. Terminating errors keep normal PowerShell semantics. The trusted profile explicitly sets NODE_OPTIONS=--preserve-symlinks-main --preserve-symlinks. It is never inherited from the host; no native-addon flags are injected. These options avoid module-loader realpath queries of inaccessible volume ancestors. The OS sandbox remains the boundary, and imported links are still rejected.

Child environment is explicit: AAW_BASELINE/CONTROL/RUNTIME/WORK/CWD_RELATIVE, private HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP, fixed NODE_OPTIONS as above, explicit SystemRoot/windir/SystemDrive, PATH runtime+System32, PATHEXT .EXE, empty PSModulePath. No host environment/profile is inherited. Zero network capabilities/no loopback exemption. PATH and node alias are not an executable whitelist: other images permitted by AppContainer OS ACL can run inside the same Job.

## Evidence and control

Native stdin accepts C; EOF means parent_lost, C means requested. Native also reports deadline/log_limit. Main retains its original user/shutdown/storage/model-finished stop reason. Absolute deadline includes preparation, while a monotonic bound prevents extending600seconds with a clock change. Native owns the only kill-on-close Job handle.

Ready is first fully written/flushed/closed as ready-pending.json, then atomically published without replacing an existing ready.json. Ready schema aaw.command.native.ready.v1 contains all identity fields plus seq/startedAt, top-level shell pid/creationTime100ns, appContainer=true/capabilityCount=0/lowIntegrity=true/atomicJob=true and nested process identity. startedAt is the verified suspended-shell time before resume. Native stdout emits only tiny ready/result JSONL notifications, not raw child output.

control/supervisor.json schema aaw.command.native.supervisor.v1 binds identity and native pid/creationTime100ns/image. control/process-N.json (N starts0) contains pid/image/creationTime100ns/appContainer/capabilityCount/lowIntegrity/inJob. These are10ms sampled active identities, not exhaustive short-lived history. Exited handles are released;1024 observations is a bounded fault threshold. Initial shell may appear twice. Job8 means simultaneously active members including shell/conhost.

Status schema aaw.command.native.status.v1 is atomically replaced about every100ms after log flush. Fields: seq; startedAt; shellExit={shellExitCode,shellExited,observedAt,termination}|null; job={activeProcesses,emptyConfirmed,observedAt}; logs={stdout,stderr}, each {observedBytes,persistedBytes,eof,sha256,coverage}; stopReason. Sequence is positive and monotonic. Termination is exited/failed_start/stopped/timed_out/log_limit/fault.

Entry shell exit and Job0 differ. Normal shell exit still closes remaining descendants. Repeated close preserves prior Job0 confirmation. Raw control/stdout.bin and stderr.bin are append-only and flushed before advertised offsets. Combined persisted capacity16MiB. Bounded drain keeps cancellation responsive. Coverage is open/complete/partial_at_limit/incomplete. Only real EOF+all observed bytes persisted+actual hash qualifies as complete. Early stream EOF gets its hash first. Unsaved observed tail is explicit; never invent bytes not drained from a killed pipe. Streams do not claim one absolute event order.

Result schema aaw.command.native.result.v1 adds cleanup={state,observedAt,proofSha256:null}, jobClosed/profileDeleted/aclRestored/baselineUnchanged, error={code,stage,nativeCode}|null, diagnostic={stage,path,message,requestedAccess}, workManifest/workManifestSha256 and observation count/mode. Main hashes actual result bytes for proof identity. Error.code=NATIVE_FAILURE; detail stays local diagnostic. Unverifiable final work snapshot has null manifest SHA and must not be adopted as an empty directory. Last status precedes final result so result.seq cannot regress.

Native retains work/runtime/baseline/control/logs. Main independently verifies baseline/work/manifest after Job0 and uses versioned adoption. Only main's exact four-runtime-file disposal removes runtime; native never recursively deletes executions or old evidence.

## Budgets and recovery

Hard Job limits:8 active processes,512MiB/process,1GiB/Job,kill-on-close,no breakaway. Only child stdin/stdout/stderr handles are inherited; no Job/control/log/path pins. Work adoption:32 files,64KiB/file,1MiB total,depth4,relativePath240 UTF8 bytes. Each scratch tree:64 files,256KiB/file,4MiB,depth4,max128entries. Disk budgets use about1000ms observations plus final adoption, not hard volume quotas. Violations close the Job and prevent adoption.

Driver owns stdin/events/done before any callback. If started/log/shellExit/job persistence throws even before controller receives the handle, driver requests stop and retains evidence until real closure/unconfirmed outcome. It must not reject and lose control. Main reads only flushed prefixes, checks identity/final hashes, coalesces64KiB or about2seconds to fit1024 log records across600seconds. InvalidUTF8 stays available as base64.

Cold reopen reads original records and reconciles precise receipts; it never relaunches argv or infers current death from savedPID. survivesAppClose=false. E3 planned acceptance ends the exact isolated QA Electron main, naturally closing native stdin. Missing closure/evidence stays unconfirmed.

## Build/admission

tools/agent-command-runner-build.mjs native-build-NN creates a fresh batch directory and aaw.command.native-build.v1 receipt: sources/generated headers, immutable environment-profile.json, profileRevision and actual executable FileRef. Profile pins PowerShell exe/config/SMA engine/CLR and bootstrap/Node/LICENSE. This is a specific entry/engine/CLR/config set, not a full transitive loaded-module inventory; remaining OS-accessible modules stay under AppContainer OS ACL scope.

Precompile profile cannot include resulting binary hash. A separate later candidate/admission must bind base profileRevision+actual native FileRef+real build/compatibility/security evidence. Never rewrite compiled input/header to create a circular hash. Main registration stays unavailable until root supplies production admission; command-probe.exe and legacy JavaScript proof cannot substitute.

Root actual build03: native SHA c3ce59f90d8239c9fe20610af0b5ae99741b594d4172611896443b16cdaa8e53; environmentRevision 8a7028eeb41260a87a2fa4b479cbe3edcb839e58b9c06615767d31275047905f. The one corrected production compatibility run passed normal script/relative require/sum42/shell23/raw9551+9 bytes/EOF/Job0/ACL/profile checks. Its prior ordinary-Node realpath failure is retained. Native/tools inputs are frozen; no E2/E3 outcome is inferred. Exact history/receipts are in docs/agent-command-native-contract.md.

## Status publication correction after first E1 (2026-09-14)

Status snapshots now use unique status-pending-<seq>.json names. Failed temporary files are retained and never reused. Atomic rename retries are bounded to250ms/26 attempts, with at most10ms between attempts:32/33 for publication;5 only for replacement of the fixed trusted status.json. Path/ACL admission failures are not retried. Final status failure cannot block result-pending.json being flushed/closed and independently atomically renamed without replacing an existing result.json. Final result remains authoritative and has a higher sequence than earlier snapshots; readers must not require a final status file.

Optional private diagnostic.publication is null or {firstCode,lastCode,attempts} for the retained publication failure. Optional private diagnostic.statusPublication is {attempts,failures,published,recovered,firstCode,lastCode,firstFailureAt,lastFailureAt}; it supports the one short-contention validation without expanding public status/result fields. Actual cleanup/EOF evidence and first error remain independent of publication recovery. SOURCE_PREPARED only until root's new build and actual evidence.
