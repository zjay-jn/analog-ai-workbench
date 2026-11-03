import type { WorkCycleFile } from './agent-work-cycle';
/** Q04/Q05 command profile. Registration requires separate environment/native admission. */
export const COMMAND_LIMITS = Object.freeze({
  active: 1, processes: 8, executions: 8, commandBytes: 8192, defaultTimeoutMs: 120000, maxTimeoutMs: 600000,
  logBytes: 16 * 1024 * 1024, logChunkBytes: 65536, logPageBytes: 16384,
  toolResultBytes: 24576, eventBytes: 49152, statusWaitMs: 25000, cleanupMs: 10000,
  idBytes: 256, environmentBytes: 8192, recordBytes: 512 * 1024, logRecords: 1024,
});
export const COMMAND_TOOL_NAMES = Object.freeze(['command_environment','command_start','command_status','command_log','command_stop'] as const);
export type CommandToolName = typeof COMMAND_TOOL_NAMES[number];
export type WindowsCommandEnvironment = Readonly<{
  environmentId: string; revision: string; displayName: string; platform: 'windows';
  shell: Readonly<{ kind: 'powershell'; version: string; sha256: string; scriptEncoding: 'utf8_bom'; interactive: false }>;
  tools: readonly Readonly<{ name: string; version: string; sha256: string }>[];
  isolation: 'windows-appcontainer-job'; profileRevision: string;
  availability: 'ready' | 'unavailable'; reason: string | null;
  projectAccess: 'none'; baselineAccess: 'read_only'; workAccess: 'execution_copy';
  network: 'denied'; hostEnvironment: 'not_inherited'; packageInstallation: 'unsupported';
  executableScope: 'appcontainer_os_acl'; survivesAppClose: false;
  limits: Readonly<{ processes: number; logBytes: number; defaultTimeoutMs: number; maxTimeoutMs: number }>;
}>;
export type WslCommandSourceRoot = Readonly<{
  path: string; access: 'read_only' | 'read_write'; enforcement: 'authorization_only' | 'os_read_only';
}>;
export type WslCommandEnvironment = Readonly<{
  environmentId: string; revision: string; displayName: string; platform: 'wsl';
  shell: Readonly<{ kind: 'bash'; version: string; sha256: string; scriptEncoding: 'utf8'; interactive: false }>;
  tools: WindowsCommandEnvironment['tools'];
  isolation: 'wsl-user-process-supervisor' | 'wsl-namespace-supervisor' | 'wsl-bubblewrap'; profileRevision: string;
  availability: 'ready' | 'unavailable'; reason: string | null;
  projectAccess: 'declared_roots'; baselineAccess: 'verified_copy'; workAccess: 'execution_copy';
  network: 'inherited'; hostEnvironment: 'controlled'; packageInstallation: 'not_provided';
  executableScope: 'wsl_user_permissions'; survivesAppClose: false;
  /** Null observes process ownership/counts without a process-count termination threshold.
   * Numeric values retain the admitted legacy threshold; timeout/stop/log limits still apply. */
  limits: Readonly<{ processes: number | null; logBytes: number; defaultTimeoutMs: number; maxTimeoutMs: number }>;
  wsl: Readonly<{ distribution: string; user: string; homeDirectory: string; shellPath: string; executionRoot: string;
    sourceRoots: readonly WslCommandSourceRoot[] }>;
}>;
export type CommandEnvironment = WindowsCommandEnvironment | WslCommandEnvironment;
/** Observed by the driver after launch, not inferred from a requested host path. */
export type CommandRuntime = Readonly<{
  platform: 'wsl'; distribution: string; user: string; cwd: string; workDirectory: string; baselineDirectory: string | null;
}>;
export type CommandArtifactCollection = Readonly<{
  /** Only supported ordinary text exports, not a full external result tree. */
  scope: 'bounded_text_exports'; skippedEntries: number;
}>;
export type CommandWorkspaceRef = Readonly<{ workspaceId: string; baselineVersion: string; files: number; bytes: number }>;
export type CommandStartArguments = Readonly<{
  requestId: string; environmentId: string; environmentRevision: string; workspaceId: string; baselineVersion: string;
  cwdRelativePath: string; commandText: string; timeoutMs: number;
}>;
export type CommandStream = 'stdout' | 'stderr';
export type CommandStopReason = 'user' | 'deadline' | 'log_limit' | 'shutdown' | 'model_finished' | 'storage_failure' | 'engine_failure';
export type CommandLogSummary = Readonly<{
  stream: CommandStream; persistedBytes: number; observedBytes: number; prefixVersion: string;
  closed: boolean; coverage: 'open' | 'complete' | 'partial_at_limit' | 'incomplete'; sha256: string | null;
}>;
export type CommandExecution = Readonly<{
  executionId: string; runId: string; workspaceId: string; requestId: string; signature: string;
  environment: Readonly<{ environmentId: string; revision: string; displayName: string }>;
  /** Absent in legacy Windows records. Null means no Linux start observation yet. */
  runtime?: CommandRuntime | null;
  artifactCollection?: CommandArtifactCollection;
  baselineVersion: string; cwdRelativePath: string; commandText: string; commandSha256: string; scriptSha256: string;
  revision: number; phase: 'intent' | 'starting' | 'running' | 'settling' | 'terminal' | 'reconciliation_required';
  createdAt: string; deadlineAt: string; startedAt: string | null; completedAt: string | null;
  stopRequested: Readonly<{ reason: CommandStopReason; requestedAt: string }> | null;
  exit: Readonly<{ shellExitCode: number | null; shellExited: boolean; observedAt: string;
    termination: 'exited' | 'failed_start' | 'stopped' | 'timed_out' | 'log_limit' | 'fault' }> | null;
  job: Readonly<{ activeProcesses: number | null; emptyConfirmed: boolean; observedAt: string | null }>;
  cleanup: Readonly<{ state: 'pending' | 'confirmed' | 'failed'; observedAt: string | null; proofSha256: string | null }>;
  logs: Readonly<{ stdout: CommandLogSummary; stderr: CommandLogSummary }>;
  artifacts: readonly Pick<WorkCycleFile,'fileId'|'version'>[];
  changes: Readonly<{ state: 'pending' | 'verified' | 'unavailable'; manifestVersion: string | null; count: number | null;
    acceptance: 'not_requested' | 'pending' | 'confirmed' | 'conflict' }>;
  error: Readonly<{ code: string; stage: 'prepare' | 'start' | 'run' | 'log' | 'cleanup' | 'recovery'; nativeCode: number | null }> | null;
}>;
export type CommandLogPage = Readonly<{
  executionId: string; stream: CommandStream; prefixVersion: string; offset: number; endOffset: number;
  snapshotBytes: number; availableBytes: number; format: 'utf8' | 'base64'; data: string; bytesSha256: string;
  nextCursor: Readonly<{ offset: number; prefixVersion: string }> | null;
  streamClosed: boolean; coverage: CommandLogSummary['coverage']; hasNewerBytes: boolean;
}>;
export type CommandToolArguments = {
  command_environment: Readonly<Record<string, never>>;
  command_start: CommandStartArguments;
  command_status: Readonly<{ executionId: string; afterRevision: number | null; waitMs: number }>;
  command_log: Readonly<{ executionId: string; stream: CommandStream; offset: number; maxBytes: number; expectedPrefixVersion: string | null }>;
  command_stop: Readonly<{ executionId: string }>;
};
/** Read-only evidence from a prior command_start in the same chat and project binding. */
export type CommandObservation = Readonly<{ runId: string; startSequence: number }>;
export type CommandToolValue =
  | Readonly<{ kind: 'command_environment'; environments: readonly CommandEnvironment[]; workspace: CommandWorkspaceRef | null }>
  | Readonly<{ kind: 'command_start' | 'command_stop'; execution: CommandExecution }>
  | Readonly<{ kind: 'command_status'; execution: CommandExecution; observation?: CommandObservation }>
  | Readonly<{ kind: 'command_log'; page: CommandLogPage; observation?: CommandObservation }>;

export type CommandBridgeRequests = {
  inspectCommandEnvironment: Readonly<{runId:string}>;
  listCommandExecutions: Readonly<{runId:string}>;
  readCommandExecution: Readonly<{runId:string}> & CommandToolArguments['command_status'];
  readCommandDiagnostics: Readonly<{runId:string;executionId:string}>;
  openCommandDiagnostics: Readonly<{runId:string;executionId:string}>;
  readCommandLog: Readonly<{runId:string}> & CommandToolArguments['command_log'];
  stopCommandExecution: Readonly<{runId:string;executionId:string}>;
};
export type CommandBridgeValues = {
  inspectCommandEnvironment: Readonly<{environments:readonly CommandEnvironment[];workspace:CommandWorkspaceRef|null}>;
  listCommandExecutions: Readonly<{executions:readonly CommandExecution[]}>;
  readCommandExecution: Readonly<{execution:CommandExecution}>;
  readCommandDiagnostics: Readonly<{diagnostics:import('./command-diagnostics').CommandDiagnosticReadResult}>;
  openCommandDiagnostics: Readonly<{opened:boolean}>;
  readCommandLog: Readonly<{page:CommandLogPage}>;
  stopCommandExecution: Readonly<{execution:CommandExecution}>;
};
