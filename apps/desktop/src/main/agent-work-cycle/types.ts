import type { WorkCycleChange, WorkCycleContinuationRef, WorkCycleExecution, WorkCycleFile, WorkCycleFileContent, WorkCycleImportSource, WorkCycleToolArguments, WorkCycleWorkspaceRef } from '../../shared/agent/agent-work-cycle';
import type { ProjectReadCode } from '../../shared/agent/agent-project-read';

export class WorkCycleError extends Error {
  constructor(readonly code: ProjectReadCode) { super('Work cycle: ' + code); }
}
/** Main-private bounded material; no host path or old call/execution authority crosses this interface. */
export type WorkCycleBaseline = Readonly<{
  runId: string; workspaceId: string; version: string;
  files: readonly Readonly<{ file: WorkCycleFile; bytes: Uint8Array }>[];
}>;
export type WorkCycleSeed = Readonly<{ source: WorkCycleContinuationRef; files: WorkCycleBaseline['files'] }>;
export type WorkCycleSnapshot = Readonly<{
  executionId: string; inputDirectory: string; outputDirectory: string;
  scriptRelativePath: string;
  script: Readonly<{ fileId: string; version: string }>;
  inputs: WorkCycleExecution['inputs'];
}>;
export type WorkCycleRunnerResult = Omit<WorkCycleExecution, 'script' | 'inputs' | 'artifacts' | 'verified'>;
export interface WorkCycleRunner {
  available(): Readonly<{ available: boolean; language: WorkCycleExecution['language']; isolation: WorkCycleExecution['isolation'] }>;
  run(snapshot: WorkCycleSnapshot, signal: AbortSignal): Promise<WorkCycleRunnerResult>;
  close(): Promise<void>;
}
/** A workspace must be reopened read-only for history. Opening it must never replay a write/program. */
export interface WorkCycleWorkspace {
  readonly ref: WorkCycleWorkspaceRef;
  /** Read-only export checks every historical receipt and seed readiness, not just latest files. */
  exportConfirmedBase(): Promise<WorkCycleBaseline>;
  /** Only after matching run.accepted is durable; pending/failed seed never executes or auto-resumes. */
  confirmSeed(): Promise<void>;
  list(): readonly WorkCycleFile[];
  read(fileId: string, version: string): WorkCycleFileContent;
  change(changeId: string): WorkCycleChange;
  /** Durable operation receipt precedes the response. Same call + args is idempotent; changed args conflict. */
  write(callId: string, args: WorkCycleToolArguments['work_write']): Promise<Extract<import('../../shared/agent/agent-work-cycle').WorkCycleToolValue, {kind:'work_write'}>>;
  /** Exact unique byte replacement in an existing editable file. Replay receipt/signature before current-version CAS. */
  edit(callId: string, args: WorkCycleToolArguments['work_edit']): Promise<Extract<import('../../shared/agent/agent-work-cycle').WorkCycleToolValue, {kind:'work_edit'}>>;
  /** Main supplies exact verified UTF-8 bytes from the currently signed project source, never model-retyped data. */
  importFile(callId: string, args: WorkCycleToolArguments['work_import'], source: WorkCycleImportSource, bytes: Uint8Array): Promise<Extract<import('../../shared/agent/agent-work-cycle').WorkCycleToolValue, {kind:'work_import'}>>;
  snapshot(callId: string, args: WorkCycleToolArguments['work_run']): Promise<WorkCycleSnapshot>;
  /** Bound, inspect ordinary output files without following links and preserve exact input/output provenance. */
  acceptExecution(snapshot: WorkCycleSnapshot, result: WorkCycleRunnerResult): Promise<WorkCycleExecution>;
  /** Verified command outputs are new readonly files; existing logical files are never implicitly replaced. */
  publishCommandArtifacts(executionId:string,changes:import('../agent-command/types').CommandProducedChanges):Promise<readonly WorkCycleFile[]>;
  /** Only after a matching execution record containing the produced file IDs is durable. */
  confirmCommandArtifacts(executionId:string,manifestVersion:string):Promise<readonly WorkCycleFile[]>;
  /** Called only after the corresponding tool.completed is in the application ledger. */
  confirm(callId: string): Promise<void>;
  close(): Promise<void>;
}
export type WorkCycleWorkspaceFactory = (options: Readonly<{
  directory: string; runId: string; workspaceId: string; readOnly: boolean; requireStoppedWriter?: boolean;
  signal: AbortSignal;
  /** First manifest must bind this source in a non-executable preparation state. */
  seed?: WorkCycleSeed;
}>) => Promise<WorkCycleWorkspace>;
