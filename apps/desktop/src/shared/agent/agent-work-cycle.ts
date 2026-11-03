/** C-1 task-owned work files and isolated program execution. Main owns all locators. */
const WORK_FILE_BYTES = 65536;
export const WORK_CYCLE_LIMITS = Object.freeze({
  files: 32, fileBytes: WORK_FILE_BYTES, writeBytes: 8192, editBytes: 8192, workspaceBytes: 1024 * 1024,
  revisions: 96, changes: 64, executions: 8, artifactsPerExecution: 8,
  relativePathBytes: 240, pathDepth: 4, readPageBytes: 6144,
  logBytes: 2048, outputBytes: 256 * 1024,
  executionMs: 10000, cleanupMs: 5000, nativeCallMs: 30000,
  // The isolated Node process belongs to this Job; the trusted launcher does not.
  processes: 1, processMemoryBytes: 256 * 1024 * 1024, jobMemoryBytes: 512 * 1024 * 1024,
  // readWorkChange only: two ordinary UTF-8 texts, at most 2x JSON escaping each,
  // plus 8 KiB for the separately bounded file/source identities and envelope.
  inspectorBytes: 4 * WORK_FILE_BYTES + 8192, toolResultBytes: 24576, eventBytes: 49152,
});

export type WorkCycleImportSource = Readonly<{
  projectId: string; bindingId: string; identity: string;
  fileId: string; relativePath: string; version: string; bytes: number;
}>;
export type WorkCycleFile = Readonly<{
  fileId: string; relativePath: string; version: string; bytes: number;
  confirmation: 'confirmed' | 'unconfirmed';
  origin: Readonly<{ kind: 'write'; changeId: string }> | Readonly<{ kind: 'execution'; executionId: string }>
    | Readonly<{ kind: 'command'; executionId: string; manifestVersion: string; sourceRelativePath: string }>
    | Readonly<{ kind: 'import'; changeId: string; source: WorkCycleImportSource }>
    | Readonly<{ kind: 'continuation'; source: Readonly<{ runId: string; workspaceId: string; fileId: string; version: string; baselineVersion: string }> }>;
}>; 
export type WorkCycleRecoveryCommand = Readonly<{
  executionId: string; requestId: string; signature: string; revision: number;
  recordVersion: string; cleanupProofSha256: string;
  termination: 'exited' | 'failed_start' | 'stopped' | 'timed_out' | 'log_limit' | 'fault'; shellExitCode: number | null;
}>;
/** Main-issued evidence for a new work branch; it never changes the interrupted parent's result. */
export type WorkCycleControllerRef = Readonly<{ guardianId: string; guardianPid: number; enginePid: number; intentVersion: string; readyVersion: string }>;
export type WorkCycleRecovery = Readonly<{ version: string; parentEventsSha256: string; controller: WorkCycleControllerRef & Readonly<{ resultVersion: string }>; commands: readonly WorkCycleRecoveryCommand[] }>;
export type WorkCycleContinuationRef = Readonly<{ runId: string; workspaceId: string; eventCount: number; baselineVersion: string; recovery?: WorkCycleRecovery }>;
export type WorkCycleContinuationPreview = Readonly<{ baseline: WorkCycleContinuationRef; fileCount: number; bytes: number }>;
export type WorkCycleWorkspaceRef = Readonly<{ workspaceId: string; continuation?: WorkCycleContinuationRef }>;
export type WorkCycleChange = Readonly<{
  changeId: string; file: WorkCycleFile; previousVersion: string | null;
  before: string | null; after: string; changed: boolean;
}>;
export type WorkCycleFileContent = Readonly<{ file: WorkCycleFile; text: string; verified: true }>;
export type WorkCycleExecution = Readonly<{
  executionId: string; language: 'javascript';
  isolation: 'windows-appcontainer';
  script: Readonly<{ fileId: string; version: string }>;
  inputs: readonly Readonly<{ fileId: string; relativePath: string; version: string; bytes: number }>[];
  termination: 'exited' | 'timed_out' | 'cancelled' | 'limit' | 'isolation_failed';
  exitCode: number | null; signal: string | null; durationMs: number;
  stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean;
  artifacts: readonly WorkCycleFile[];
  verified: boolean; cleanupConfirmed: boolean;
}>;
export type WorkCycleToolArguments = {
  work_list: Readonly<Record<string, never>>;
  work_read: Readonly<{ fileId: string; version: string; offset: number }>;
  work_write: Readonly<{ relativePath: string; expectedVersion: string | null; text: string }>;
  /** Replace exactly one nonempty literal match at the current version; raw UTF-8 old/new bytes share editBytes. */
  work_edit: Readonly<{ fileId: string; expectedVersion: string; oldText: string; newText: string }>;
  work_import: Readonly<{ fileId: string; version: string; relativePath: string; expectedVersion: string | null }>;
  work_run: Readonly<{ fileId: string; version: string }>;
};
export type WorkCycleToolName = keyof WorkCycleToolArguments;
export const WORK_CYCLE_TOOL_NAMES = Object.freeze(['work_list', 'work_read', 'work_write', 'work_edit', 'work_import', 'work_run'] as const);
export type WorkCycleToolValue =
  | Readonly<{ kind: 'work_list'; files: readonly WorkCycleFile[] }>
  | Readonly<{ kind: 'work_read'; file: WorkCycleFile; text: string; offset: number; nextOffset: number | null }>
  | Readonly<{ kind: 'work_write'; file: WorkCycleFile; previousVersion: string | null; changeId: string; changed: boolean }>
  | Readonly<{ kind: 'work_edit'; file: WorkCycleFile; previousVersion: string; changeId: string; changed: boolean }>
  | Readonly<{ kind: 'work_import'; file: WorkCycleFile; previousVersion: string | null; changeId: string; changed: boolean }>
  | Readonly<{ kind: 'work_run'; execution: WorkCycleExecution }>;

/** New work paths are ordinary relative names, never host locators or authority tokens. */
export function isWorkCycleRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > WORK_CYCLE_LIMITS.relativePathBytes
      || /[\\:\x00-\x1f\x7f\p{Surrogate}]/u.test(value)) return false;
  const parts = value.split('/');
  return parts.length <= WORK_CYCLE_LIMITS.pathDepth && parts.every(part =>
    !!part && part !== '.' && part !== '..' && !/[. ]$/u.test(part)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part)
    && !/[<>"|?*]/u.test(part));
}
