import type { CommandEnvironment, CommandExecution, CommandLogPage, CommandRuntime, CommandStartArguments, CommandStopReason, CommandStream, CommandToolArguments } from '../../shared/agent/agent-command';
import type { WorkCycleBaseline } from '../agent-work-cycle/types';
import { WorkCycleError } from '../agent-work-cycle/types';
import type {CommandDiagnosticInput} from '../../shared/agent/command-diagnostics';
export { WorkCycleError as CommandError } from '../agent-work-cycle/types';
export class CommandPreparationError extends WorkCycleError {
  constructor(readonly detailCode:string,readonly proofSha256:string){super('CAPABILITY_DENIED');}
}

export type CommandChunk = Readonly<{ object: string; offset: number; bytes: number; sha256: string; prefixVersion: string }>;
export type CommandIntent = Readonly<{
  nonce: string; args: CommandStartArguments; environment: CommandEnvironment;
  baseline: readonly Readonly<{ fileId: string; relativePath: string; version: string; bytes: number }>[];
}>;
export type CommandRecord = Readonly<{
  schema: 1; intent: CommandIntent; execution: CommandExecution;
  chunks: Readonly<Record<CommandStream, readonly CommandChunk[]>>;
  retainedObjects?:readonly Readonly<{object:string;bytes:number;sha256:string}>[];
}>;
/** Each append is immutable and durable before a record may reference it. Single writer per repository. */
export interface CommandRepository {
  load(): readonly CommandRecord[];
  create(record: CommandRecord): void;
  save(previous: CommandRecord, next: CommandRecord): void;
  recover?(previous: CommandRecord, next: CommandRecord): void;
  writeChunk(executionId: string, bytes: Uint8Array): string;
  readChunk(executionId: string, chunk: CommandChunk): Uint8Array;
  close(): void;
}
export type CommandDriverOutcome = Readonly<{
  exit: NonNullable<CommandExecution['exit']>; job: CommandExecution['job']; cleanup: CommandExecution['cleanup'];
  eof: Readonly<Record<CommandStream, boolean>>;
  /** Digest of all raw bytes drained by the trusted supervisor, when complete. */
  logSha256: Readonly<Record<CommandStream, string | null>>;
  logMetadata?: Readonly<Record<CommandStream, Readonly<{observedBytes:number;persistedBytes:number;coverage:'open'|'complete'|'partial_at_limit'|'incomplete'}>>>;
  error: CommandExecution['error'];
  /** Main-private bytes after independent baseline/work-copy and native cleanup verification. */
  changes?: CommandProducedChanges | null;
  artifactCollection?: CommandExecution['artifactCollection'];
}>;
export type CommandProducedChanges=Readonly<{
  baselineVersion:string;manifestVersion:string;
  files:readonly Readonly<{relativePath:string;beforeVersion:string|null;version:string;bytes:Uint8Array}>[];
  deleted:readonly Readonly<{relativePath:string;beforeVersion:string}>[];
}>;
export interface CommandDriver {
  readonly environment: CommandEnvironment;
  /** Historical admission: only local evidence recovery; never offered for launch. */
  readonly recoveryOnly?: true;
  /** Inspect the exact old terminal receipt from trusted local mirrored evidence only.
   * Never creates, resumes or kills any process. */
  recover?(record:CommandRecord):Promise<Readonly<{outcome:CommandDriverOutcome;logs:Readonly<Record<CommandStream,Uint8Array>>}>|null>;
  /** Resolves after launch/control is available, never after the command finishes.
   * Native intent binds record identity, signature, nonce and exact baseline before process creation. */
  start(record: CommandRecord, baseline: WorkCycleBaseline, callbacks: Readonly<{
    diagnostic?(input:Pick<CommandDiagnosticInput,'component'|'operation'|'kind'|'causeCode'|'nativeCode'>,error?:unknown):void;
    started(time: string, runtime?: CommandRuntime): Promise<void>;
    log(stream: CommandStream, bytes: Uint8Array): Promise<void>;
    shellExit(exit: NonNullable<CommandExecution['exit']>): Promise<void>;
    job(job: CommandExecution['job']): Promise<void>;
  }>): Promise<Readonly<{ stop(reason: CommandStopReason): void; done: Promise<CommandDriverOutcome> }>>;
}
export interface CommandController {
  inspect(): Promise<Readonly<{ environments: readonly CommandEnvironment[]; workspace: Readonly<{workspaceId:string;baselineVersion:string;files:number;bytes:number}> | null }>>;
  list(): readonly CommandExecution[];
  start(args: CommandStartArguments): Promise<CommandExecution>;
  status(args: CommandToolArguments['command_status']): Promise<CommandExecution>;
  log(args: CommandToolArguments['command_log']): CommandLogPage;
  stop(executionId: string, reason?: CommandStopReason): Promise<CommandExecution>;
  /** False includes cleanup uncertainty, even when phase is terminal. */
  idle(): boolean;
  /** Returns whether model final arrived with work outstanding; caller must not label that run successful. */
  close(reason: CommandStopReason): Promise<Readonly<{ hadOutstanding: boolean; cleanupConfirmed: boolean }>>;
}
