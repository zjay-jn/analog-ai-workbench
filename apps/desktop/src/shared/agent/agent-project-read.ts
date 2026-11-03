import type { WorkCycleChange, WorkCycleContinuationPreview, WorkCycleFile, WorkCycleFileContent, WorkCycleToolArguments, WorkCycleToolValue, WorkCycleWorkspaceRef } from './agent-work-cycle';
import type { AgentSkillDescriptor, AgentSkillSource, AgentSkillToolArguments } from './agent-skills';
import type { CommandToolArguments, CommandToolValue, CommandBridgeRequests, CommandBridgeValues } from './agent-command';
import type { TaskCapacity } from './agent-task-capacity';
import type { ProjectReadModel } from './agent-project-model';
import type { ChatRunOrigin } from './chat-turns';
import type {FileSystemToolArguments,FileSystemSourceRef,FileSystemLocation,FileSystemReadScope,FileSystemNextArguments,FileSystemOsCode} from './agent-filesystem-read';
import type { OaReadToolArguments, OaReadToolValue } from './oa-read';
export type { ProjectReadModel } from './agent-project-model';
import type { WslResultsBinding, WslResultsSelection, WslResultsReadValue, WslResultsToolArguments, WslResultsToolValue } from './wsl-results';
import type { WaveformResultsToolArguments, WaveformResultsToolValue, WaveformReadValue, WaveformMetricsValue } from './waveform-results';
/** C-1 extends the project tool task; startRun remains read-only. */
export const AGENT_PROJECT_READ_VERSION = 'workbench.agent-project-read.v8' as const;
/** Single budget source for validation, main, native configuration and presentation. */
export const PROJECT_READ_LIMITS = Object.freeze({
  requestBytes: 16384, idBytes: 256,
  goalBytes: 4096, constraintBytes: 4096, answerBytes: 4096, queryBytes: 256,
  projectDisplayBytes: 8192, relativePathBytes: 2048,
  candidates: 50000, directories: 4096, depth: 24, indexBytes: 24 * 1024 * 1024, snapshots: 2,
  operationCandidates: 5000, operationBytes: 48 * 1024 * 1024, operationMs: 10000,
  fileBytes: 16 * 1024 * 1024, lines: 500000, textWorkingBytes: 64 * 1024 * 1024, readChunkBytes: 65536,
  listPage: 100, searchMatches: 20, readPageLines: 200, readPageBytes: 6144, toolResultBytes: 12288,
  ruleBytes: 8192, rules: 16, rulesBytes: 16384, ruleChunkBytes: 4096,
  runCandidates: 100000, runReadBytes: 256 * 1024 * 1024, toolCalls: 64, sums: 8, questions: 4,
  requests: 24, steps: 24, nativeSteps: 25, maxOutputTokens: 16384, requestMs: 600000,
  firstByteMs: 120000, idleMs: 60000, wireBytes: 16 * 1024 * 1024, messages: 96,
  contextBytes: 192 * 1024, toolContextBytes: 96 * 1024, outputBytes: 65536, terminalReserveBytes: 16384,
  deadlineMs: 14400000, waitMs: 1800000, nativeCleanupMs: 10000, shutdownMs: 45000,
  eventBytes: 32768, events: 1024, eventPage: 64, eventPageBytes: 256 * 1024,
  runBytes: 2 * 1024 * 1024, runs: 32, diskBytes: 64 * 1024 * 1024, citations: 64,
  continuationDepth: 8, continuationCitations: 8, continuationFactsBytes: 32768, continuationMessageBytes: 8192,
  preflightReadBytes: 128 * 1024 * 1024, inspectionReadBytes: 256 * 1024 * 1024, citationChecks: 64,
  browsePages: 4096, browseReturnBytes: 64 * 1024 * 1024,
});
export type ProjectReadCode = 'INVALID_REQUEST' | 'CAPABILITY_DENIED' | 'NOT_BOUND' | 'CREATION_PENDING'
  | 'CWD_UNAVAILABLE' | 'PATH_POLICY_DENIED' | 'PATH_NOT_FOUND' | 'ACCESS_DENIED' | 'NOT_A_DIRECTORY' | 'NOT_A_FILE'
  | 'ROOT_UNAVAILABLE' | 'ROOT_CHANGED' | 'FILE_UNAVAILABLE' | 'SOURCE_CHANGED' | 'SNAPSHOT_CHANGED'
  | 'CURSOR_STALE' | 'UNSUPPORTED_PATH' | 'UNSUPPORTED_ENCODING' | 'UNSUPPORTED_TEXT' | 'FILE_LIMIT'
  | 'SCOPE_LIMIT' | 'RULES_UNAVAILABLE' | 'RULES_LIMIT' | 'BUDGET_EXCEEDED' | 'CANCELLED' | 'BUSY'
  | 'STORAGE_FAILED' | 'MODEL_UNAVAILABLE' | 'ENGINE_FAILED' | 'CLEANUP_FAILED' | 'IO_ERROR'
  | 'HISTORY_FULL' | 'RUN_NOT_FOUND' | 'RUN_HAS_DEPENDENTS' | 'CONFLICT'
  | 'UNSUPPORTED_FORMAT' | 'UNSUPPORTED_ANALYSIS' | 'UNSUPPORTED_UNIT' | 'UNSUPPORTED_WAVEFORM'
  | 'TRACE_UNAVAILABLE' | 'AXIS_MISMATCH' | 'CONVERTER_UNAVAILABLE' | 'METRIC_INPUT_INVALID'
  | 'OA_UNAVAILABLE' | 'OA_SNAPSHOT_UNPROVEN' | 'OA_OBJECT_NOT_FOUND' | 'OA_UNSUPPORTED';
export type ProjectReadFailure = Readonly<{ ok: false; error: Readonly<{ code: Exclude<ProjectReadCode, 'RUN_HAS_DEPENDENTS'> }> }>
  | Readonly<{ ok: false; error: Readonly<{ code: 'RUN_HAS_DEPENDENTS'; dependentRunIds: readonly string[] }> }>;
export type ProjectReadResult<T> = Readonly<{ ok: true; value: T }> | ProjectReadFailure;
export type BoundProjectReadRef = Readonly<{
  projectId: string; bindingId: string; name: string;
  directoryName: string; directorySegments: readonly string[]; identity: string;
}>;
export type ProjectReadRef=BoundProjectReadRef|Readonly<{projectId:string;name:string;bindingId:null;identity:null;directoryName:null;directorySegments:readonly []}>;
/** One-based Unicode scalar columns; the end position is exclusive. */
export type ProjectReadPosition = Readonly<{ line: number; column: number }>;
export type ProjectReadRange = Readonly<{ start: ProjectReadPosition; end: ProjectReadPosition }>;
export type ProjectReadRunState = 'preparing' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type ProjectReadCleanupState = 'idle' | 'pending' | 'failed';
export type ProjectReadActiveTask = Readonly<{
  mode: 'calculation' | 'project_read' | 'project_work' | 'conversation'; runId: string; project: ProjectReadRef | null;
  status: ProjectReadRunState; cleanupState: ProjectReadCleanupState;
}>;
export type ProjectReadStatus = Readonly<{
  model: ProjectReadModel | null; project: ProjectReadRef | null;
  availability: 'unchecked' | 'available' | 'not_bound' | 'creation_pending' | 'root_unavailable'
    | 'root_changed' | 'not_configured' | 'unsupported_model' | 'storage_failed' | 'busy' | 'unavailable';
  canStart: boolean; processState: 'idle' | 'starting' | 'ready' | 'failed';
  cleanupState: ProjectReadCleanupState; reason: ProjectReadCode | null; activeTask: ProjectReadActiveTask | null;
}>;
export type ProjectReadScope = Readonly<{
  projectId: string; bindingId: string; identity: string; directoryId: string | null; relativeDirectory: string;
  kind?:never;
}>|FileSystemReadScope;
export type ProjectReadCoverage = Readonly<{
  scope: ProjectReadScope; complete: boolean;
  scannedCandidates: number; scannedFiles: number; scannedBytes: number; returned: number;
  skipped: Readonly<{ policy: number; unsupported: number; fileLimit: number; unavailable: number }>;
  remaining: Readonly<{ directories: number | null; files: number | null; position: ProjectReadPosition | null }>;
  nextCursor: string | null;
  limitReason: 'page' | 'slice' | 'time' | 'scope' | 'bytes' | 'context' | 'rules' | 'citations' | null;
}>;
export type ProjectReadEntry = Readonly<{
  fileId: string | null; directoryId: string | null; parentId: string | null;
  name: string; relativePath: string; kind: 'file' | 'directory'; bytes: number;
  readability: 'readable' | 'unsupported' | 'file_limit' | 'directory'; version: string | null;
}>;
export type ProjectReadRule = Readonly<{
  sourceRef?:FileSystemSourceRef;
  source: string; relativeDirectory: string; state: 'loaded' | 'absent';
  version: string | null; normalizedSha256: string | null; text: string | null;
}>;
export type ProjectReadRuleChunk = Readonly<{
  sourceRef?:FileSystemSourceRef;
  ruleId: string; source: string; relativeDirectory: string; version: string; normalizedSha256: string;
  offsetBytes: number; endBytes: number; totalBytes: number; text: string; complete: boolean;
}>;
export type ProjectReadCitation = Readonly<{
  location?:FileSystemLocation;
  citationId: string; runId: string; project: ProjectReadRef; snapshotId: string;
  fileId: string; fileIdentity: string; relativePath: string;
  version: string; normalizedSha256: string; range: ProjectReadRange;
  excerpt: string; excerptSha256: string; totalLines: number; fileBytes: number;
  source: 'read' | 'search'; createdAt: string; origin: Readonly<{ runId: string; citationId: string }> | null;
}>;
/** Wire/event fragment; full authority stays in the persisted main citation and is resolved on demand. */
export type ProjectReadCitationPreview = Pick<ProjectReadCitation,
  'citationId' | 'fileId' | 'relativePath' | 'version' | 'normalizedSha256' | 'range'
  | 'excerpt' | 'excerptSha256' | 'totalLines' | 'fileBytes' | 'source' | 'location'>;
export type ProjectReadSearchMatch = Readonly<{
  fileId: string; relativePath: string; version: string;
  match: ProjectReadRange; citation: ProjectReadCitationPreview;
}>;
export type ProjectReadToolArguments = OaReadToolArguments & FileSystemToolArguments & WorkCycleToolArguments & AgentSkillToolArguments & CommandToolArguments & WslResultsToolArguments & WaveformResultsToolArguments & {
  project_list: Readonly<{ directoryId: string | null; cursor: string | null; refresh: boolean }>;
  project_find: Readonly<{ directoryId: string | null; query: string; cursor: string | null; refresh: boolean }>;
  project_search: Readonly<{ directoryId: string | null; query: string; cursor: string | null; refresh: boolean }>;
  project_read: Readonly<{ fileId: string; version: string | null; start: ProjectReadPosition; cursor: string | null }>;
  pilot_sum: Readonly<{ values: readonly number[] }>;
};
export type ProjectReadToolName = keyof ProjectReadToolArguments;
export type ProjectReadToolCall = { [K in ProjectReadToolName]: Readonly<{
  sessionId: string; messageId: string; callId: string; toolName: K; arguments: ProjectReadToolArguments[K];
}> }[ProjectReadToolName];
/** Semantic position only; main creates new IDs/cursors after identity and version revalidation. */
export type ProjectReadResumePoint = Readonly<{
  toolName: 'project_search' | 'project_read'; relativePath: string; version: string;
  next: ProjectReadPosition; query: string | null; relativeDirectory: string;
}>;
type ToolBase = Readonly<{ phase: 'rules' | 'scan' | 'data'; snapshotId: string; coverage: ProjectReadCoverage; rules: readonly ProjectReadRuleChunk[]; resume: ProjectReadResumePoint | null;source?:FileSystemSourceRef;nextArguments?:FileSystemNextArguments|null }>;
export type ProjectReadToolValue =
  | (ToolBase & Readonly<{ kind: 'list' | 'find'; entries: readonly ProjectReadEntry[] }>)
  | (ToolBase & Readonly<{ kind: 'skills'; entries: readonly AgentSkillDescriptor[]; sourceKind: 'selected_project' }>)
  | (ToolBase & Readonly<{ kind: 'search'; matches: readonly ProjectReadSearchMatch[] }>)
  | (ToolBase & Readonly<{ kind: 'read'; citation: ProjectReadCitationPreview | null; empty: boolean; next: ProjectReadPosition | null; skill?: AgentSkillSource }>)
  | Readonly<{ kind: 'sum'; sum: number; count: number; source: 'deterministic-local'; toolVersion: 'pilot.sum.v1' }>
  | WorkCycleToolValue | CommandToolValue | WslResultsToolValue | WaveformResultsToolValue | OaReadToolValue;
export type ProjectReadToolResult = Readonly<{ ok: true; value: ProjectReadToolValue }>
  | Readonly<{ ok: false; error: Readonly<{ code: ProjectReadCode;osCode?:FileSystemOsCode }>; coverage: ProjectReadCoverage | null }>;
export type ProjectReadUsage = Readonly<{ inputTokens: number; outputTokens: number }> | null;
export type ProjectReadAccounting = Readonly<{
  providerAttempts: number; httpDispatches: number; toolAttempts: number;
  physicalReadBytes: number; visitedCandidates: number; contextBytes: number | null;
}>;
export type ProjectReadBudget = Readonly<{
  /** Null is an explicit, main-owned conversation policy, never an inferred legacy default. */
  providerAttempts: number | null; httpDispatches: number | null; toolAttempts: number | null; physicalReadBytes: number;
  visitedCandidates: number; contextBytes: number; outputBytes: number; maxOutputTokens: number;
  deadlineMs: number; waitMs: number;
}>;
export type ProjectReadEventData = {
  'work.prepared':Readonly<{workCycle:WorkCycleWorkspaceRef;continuedFrom:string|null}>;
  'run.accepted': Readonly<{ project: ProjectReadRef; model: ProjectReadModel; continuedFrom: string | null; budget: ProjectReadBudget; workCycle?: WorkCycleWorkspaceRef; wslResultsBinding?: WslResultsBinding; origin?:ChatRunOrigin }>;
  'run.started': Readonly<{ sessionId: string; engine: 'opencode'; version: '1.18.17'; controller?: import('./agent-work-cycle').WorkCycleControllerRef }>;
  'model.step': Readonly<{ step: number }>;
  'model.response': Readonly<{ request: number; responseModel: string | null; usage: ProjectReadUsage }>;
  'message.delta': Readonly<{ messageId: string; step: number; text: string }>;
  'project.rules': Readonly<{ rules: readonly ProjectReadRule[] }>;
  'tool.started': ProjectReadToolCall;
  'tool.completed': ProjectReadToolCall & Readonly<{ result: ProjectReadToolResult }>;
  'question.asked': Readonly<{ questionId: string; prompt: string }>;
  'question.answered': Readonly<{ questionId: string; answer: string }>;
  'question.delivered': Readonly<{ questionId: string }>;
  'budget.updated': ProjectReadAccounting;
  'cleanup.started': Readonly<{ reason: 'completed' | 'failed' | 'stop' | 'close' }>;
  'cleanup.completed': Readonly<{ outcome: 'confirmed' | 'failed' }>;
  'run.completed': Readonly<{ citations: readonly string[] }>;
  'run.failed': Readonly<{ code: ProjectReadCode; stage: 'accept' | 'model' | 'tool' | 'context' | 'storage' | 'cleanup' }>;
  'run.stopped': Readonly<{ reason: 'user' }>;
  'run.interrupted': Readonly<{ reason: 'window_closed' | 'restart' | 'question_timeout' }>;
};
export type ProjectReadEvent = { [K in keyof ProjectReadEventData]: Readonly<{
  runId: string; sequence: number; time: string; type: K; data: ProjectReadEventData[K];
}> }[keyof ProjectReadEventData];
export type ProjectReadSummary = Readonly<{
  origin?:ChatRunOrigin;
  workCycle?: WorkCycleWorkspaceRef;
  wslResultsBinding?: WslResultsBinding;
  runId: string; clientRequestId: string; project: ProjectReadRef; model: ProjectReadModel;
  goal: string; constraint: string; continuedFrom: string | null; status: ProjectReadRunState;
  cleanupState: ProjectReadCleanupState; createdAt: string; updatedAt: string;
  accounting: ProjectReadAccounting; eventCount: number;
  continuation: Readonly<{ fromRunId: string; evidenceCount: number; confirmedQuestions: number; resumedFilePositions: number; restartedQueries: number }> | null;
}>;
export type ProjectReadRun = ProjectReadSummary & Readonly<{ events: readonly ProjectReadEvent[] }>;
type Version = Readonly<{ contractVersion: typeof AGENT_PROJECT_READ_VERSION }>;
export type ProjectReadRequests = { [K in keyof CommandBridgeRequests]: Version & CommandBridgeRequests[K] } & {
  getStatus: Version & Readonly<{ projectId: string }>;
  selectModel: Version & Readonly<{ model: ProjectReadModel }>;
  revalidateProject: Version & Readonly<{ projectId: string; bindingId: string }>;
  startRun: Version & Readonly<{
    clientRequestId: string; projectId: string; bindingId: string; model: ProjectReadModel;
    goal: string; constraint: string; continuedFrom: string | null;
  }>;
  startWorkRun: Version & Readonly<{
    clientRequestId: string; projectId: string; bindingId: string; model: ProjectReadModel;
    goal: string; constraint: string;
  }> & (Readonly<{ continuedFrom: null }> | Readonly<{ continuedFrom: string; expectedEventCount: number; baselineVersion: string; recoveryVersion?: string }>);
  prepareWorkContinuation: Version & Readonly<{ runId: string; projectId: string; bindingId: string; expectedEventCount: number }>;
  listWorkFiles: Version & Readonly<{ runId: string }>;
  readWorkFile: Version & Readonly<{ runId: string; fileId: string; version: string }>;
  readWorkChange: Version & Readonly<{ runId: string; changeId: string }>;
  listRuns: Version & Readonly<{ projectId: string | null; before: string | null }>;
  readRun: Version & Readonly<{ runId: string; after: number }>;
  answerQuestion: Version & Readonly<{ runId: string; questionId: string; answer: string }>;
  stopRun: Version & Readonly<{ runId: string }>;
  resolveCitation: Version & Readonly<{ runId: string; citationId: string }>;
  checkCitation: Version & Readonly<{ runId: string; citationId: string }>;
  browseProject: Version & Readonly<{ projectId: string; bindingId: string; directoryId: string | null; cursor: string | null; refresh: boolean }>;
  cancelInspection: Version & Readonly<{ projectId: string }>;
  getTaskCapacity: Version & Readonly<{ projectId: string | null }>;
  getWslResultsBinding: Version & Readonly<{ projectId: string }>;
  selectWslResultsBinding: Version & Readonly<{ projectId: string; selection: WslResultsSelection }>;
  clearWslResultsBinding: Version & Readonly<{ projectId: string; expectedBindingId: string }>;
  resolveWslResultsCitation: Version & Readonly<{ runId: string; citationId: string }>;
  checkWslResultsCitation: Version & Readonly<{ runId: string; citationId: string }>;
  resolveWaveformCitation: Version & Readonly<{ runId: string; citationId: string }>;
  checkWaveformCitation: Version & Readonly<{ runId: string; citationId: string }>;
  deleteRun: Version & Readonly<{ runId: string; expectedEventCount: number; expectedCapacityVersion?: string }>;
};
export type ProjectReadValues = CommandBridgeValues & {
  getStatus: ProjectReadStatus;
  selectModel: Readonly<{ model: ProjectReadModel }>;
  revalidateProject: ProjectReadStatus;
  startRun: Readonly<{ runId: string }>;
  startWorkRun: Readonly<{ runId: string }>;
  prepareWorkContinuation: WorkCycleContinuationPreview;
  listWorkFiles: Readonly<{ files: readonly WorkCycleFile[] }>;
  readWorkFile: WorkCycleFileContent;
  readWorkChange: WorkCycleChange;
  listRuns: Readonly<{ runs: readonly ProjectReadSummary[]; nextBefore: string | null }>;
  readRun: Readonly<{ run: ProjectReadSummary; events: readonly ProjectReadEvent[]; nextAfter: number; hasMore: boolean;workPreparation?:Extract<ProjectReadEvent,{type:'work.prepared'}> }>;
  answerQuestion: Readonly<{ accepted: true }>;
  stopRun: Readonly<{ accepted: true }>;
  resolveCitation: ProjectReadCitation;
  checkCitation: Readonly<{ citationId: string; state: 'current' | 'changed' | 'unavailable'; reason: ProjectReadCode | null }>;
  browseProject: Readonly<{ snapshotId: string; coverage: ProjectReadCoverage; entries: readonly ProjectReadEntry[] }>;
  cancelInspection: Readonly<{ accepted: true }>;
  getTaskCapacity: TaskCapacity;
  getWslResultsBinding: Readonly<{ binding: WslResultsBinding | null }>;
  selectWslResultsBinding: Readonly<{ binding: WslResultsBinding }>;
  clearWslResultsBinding: Readonly<{ binding: null }>;
  resolveWslResultsCitation: WslResultsReadValue;
  checkWslResultsCitation: Readonly<{ citationId: string; state: 'current' | 'changed' | 'unavailable'; reason: ProjectReadCode | null }>;
  resolveWaveformCitation: WaveformReadValue | WaveformMetricsValue;
  checkWaveformCitation: Readonly<{ citationId: string; state: 'current' | 'changed' | 'unavailable'; reason: ProjectReadCode | null }>;
  deleteRun: Readonly<{ deleted: true }>;
};
export const PROJECT_READ_METHODS = ['getStatus', 'selectModel', 'revalidateProject', 'startRun', 'listRuns', 'readRun', 'answerQuestion', 'stopRun', 'resolveCitation', 'checkCitation', 'browseProject', 'cancelInspection', 'deleteRun', 'getTaskCapacity', 'getWslResultsBinding', 'selectWslResultsBinding', 'clearWslResultsBinding', 'resolveWslResultsCitation', 'checkWslResultsCitation', 'resolveWaveformCitation', 'checkWaveformCitation', 'startWorkRun', 'listWorkFiles', 'readWorkFile', 'readWorkChange', 'prepareWorkContinuation', 'inspectCommandEnvironment', 'listCommandExecutions', 'readCommandExecution', 'readCommandDiagnostics', 'openCommandDiagnostics', 'readCommandLog', 'stopCommandExecution'] as const;
export type ProjectReadMethod = typeof PROJECT_READ_METHODS[number];
export type WorkbenchAgentProjectReadApi = { readonly [K in ProjectReadMethod]: (request: ProjectReadRequests[K]) => Promise<ProjectReadResult<ProjectReadValues[K]>> };
