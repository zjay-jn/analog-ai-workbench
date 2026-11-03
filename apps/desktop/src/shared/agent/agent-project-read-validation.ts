import { AGENT_PROJECT_READ_VERSION, PROJECT_READ_METHODS, PROJECT_READ_LIMITS } from './agent-project-read';
import { parseProjectReadModel } from './agent-project-model';
import {FILESYSTEM_TOOL_NAMES,FILESYSTEM_OS_CODES,isFileSystemToolName,parseFileSystemToolArguments,fileSystemPathText,type FileSystemSourceRef,type FileSystemLocation,type FileSystemNextArguments} from './agent-filesystem-read';
import { parseChatRunOrigin } from './chat-turns';
import {isCommandDiagnosticReadResult} from './command-diagnostics';
import type * as C from './agent-project-read';
import { COMMAND_LIMITS as CMD, COMMAND_TOOL_NAMES, type CommandToolValue } from './agent-command';
import { isCommandToolName, isCommandEnvironment, isCommandExecution, isCommandLogPage, parseCommandArguments } from './agent-command-validation';
import { AGENT_SKILL_LIMITS as S, AGENT_SKILL_TOOL_NAMES, isSkillEntry, isSkillResource } from './agent-skills';
import { WORK_CYCLE_LIMITS as W, WORK_CYCLE_TOOL_NAMES, isWorkCycleRelativePath, type WorkCycleFile, type WorkCycleExecution, type WorkCycleToolValue } from './agent-work-cycle';
import { isWslResultsToolName, parseWslResultsToolArguments, parseWslResultsToolValue, parseWslResultsBinding, parseWslResultsSelection } from './wsl-results';
import { isWaveformResultsToolName, parseWaveformResultsToolArguments, parseWaveformResultsToolValue } from './waveform-results';
import { OA_READ_TOOL_NAMES } from './oa-read';
import { isOaReadToolName, parseOaReadToolArguments, parseOaReadToolValue } from './oa-read-validation';

export { PROJECT_READ_LIMITS } from './agent-project-read';

type Parse<T> = (value: unknown) => T;
type Fields = Readonly<Record<string, Parse<unknown>>>;
type Parsed<S extends Fields> = { readonly [K in keyof S]: ReturnType<S[K]> };
const utf8 = new TextEncoder();
function bad(): never { throw new TypeError('Invalid project read contract'); }
const scalarText = (s: string): boolean => !/\p{Surrogate}/u.test(s);
const rawBytes = (s: string): number => utf8.encode(s).length;
const integer = (min: number, max: number): Parse<number> => value => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) bad();
  return value;
};
const count = integer(0, Number.MAX_SAFE_INTEGER);
const bool: Parse<boolean> = value => typeof value === 'boolean' ? value : bad();
const literal = <T extends string | boolean>(expected: T): Parse<T> => value => value === expected ? expected : bad();
const choices = <T extends string>(...values: readonly T[]): Parse<T> => value =>
  typeof value === 'string' && values.includes(value as T) ? value as T : bad();
const nullable = <T>(parse: Parse<T>): Parse<T | null> => value => value === null ? null : parse(value);
const text = (max: number, nonblank = true): Parse<string> => value => {
  if (typeof value !== 'string' || value.length > max || !scalarText(value) || rawBytes(value) > max || (nonblank && !value.trim())) bad();
  return value;
};
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) bad();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) bad();
    out[key] = descriptor.value;
  }
  return out;
}
function object<S extends Fields>(fields: S): Parse<Parsed<S>> {
  const keys = Object.keys(fields);
  return value => {
    const source = exact(value, keys), out: Record<string, unknown> = {};
    for (const key of keys) out[key] = fields[key]!(source[key]);
    return Object.freeze(out) as Parsed<S>;
  };
}
function withOptional<S extends Fields, O extends Fields>(fields: S, optional: O): Parse<Parsed<S> & Partial<Parsed<O>>> {
  return value => {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) bad();
    const active: Record<string, Parse<unknown>> = { ...fields };
    for (const key of Object.keys(optional)) if (Object.hasOwn(value, key)) active[key] = optional[key]!;
    return object(active)(value) as Parsed<S> & Partial<Parsed<O>>;
  };
}
function array<T>(parse: Parse<T>, max: number, min = 0): Parse<readonly T[]> {
  return value => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) bad();
    return Object.freeze(Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !('value' in d) || !d.enumerable) bad();
      return parse(d.value);
    }));
  };
}
function refine<T>(parse: Parse<T>, valid: (value: T) => boolean): Parse<T> {
  return value => { const parsed = parse(value); return valid(parsed) ? parsed : bad(); };
}
const unique = <T>(items: readonly T[], key: (value: T) => string): boolean => new Set(items.map(key)).size === items.length;

/** Exact UTF-8 JSON cost without invoking getters, toJSON, or input serialization hooks. */
function jsonBytesWithin(value: unknown, maxBytes: number): number | null {
  try {
    const active = new Set<object>(); let nodes = 0;
    const visit = (input: unknown, depth: number): number => {
      if (++nodes > 1000000 || depth > 64) bad();
      if (input === null) return 4;
      if (typeof input === 'boolean') return input ? 4 : 5;
      if (typeof input === 'number') {
        if (!Number.isFinite(input) || Object.is(input, -0)) bad();
        return JSON.stringify(input).length;
      }
      if (typeof input === 'string') {
        if (input.length > maxBytes || !scalarText(input)) bad();
        return rawBytes(JSON.stringify(input));
      }
      if (typeof input !== 'object' || active.has(input)) bad();
      active.add(input);
      const isArray = Array.isArray(input), proto = Object.getPrototypeOf(input);
      if (proto !== (isArray ? Array.prototype : Object.prototype)) bad();
      const keys = Reflect.ownKeys(input);
      if (keys.length > 100000) bad();
      let bytes = 2;
      if (isArray) {
        const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 100000 || keys.length !== length + 1) bad();
        for (let i = 0; i < length; i++) {
          const d = Object.getOwnPropertyDescriptor(input, String(i));
          if (!d || !('value' in d) || !d.enumerable) bad();
          bytes += (i ? 1 : 0) + visit(d.value, depth + 1);
          if (bytes > maxBytes) bad();
        }
      } else {
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (typeof key !== 'string' || key.length > maxBytes || !scalarText(key)) bad();
          const d = Object.getOwnPropertyDescriptor(input, key);
          if (!d || !('value' in d) || !d.enumerable) bad();
          bytes += (i ? 1 : 0) + rawBytes(JSON.stringify(key)) + 1 + visit(d.value, depth + 1);
          if (bytes > maxBytes) bad();
        }
      }
      active.delete(input); return bytes;
    };
    const bytes = visit(value, 0);
    return bytes <= maxBytes ? bytes : null;
  } catch { return null; }
}
export function projectReadJsonBytes(value: unknown): number | null { return jsonBytesWithin(value, PROJECT_READ_LIMITS.diskBytes); }
export function projectReadFitsJsonBudget(value: unknown, maxBytes: number): boolean {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PROJECT_READ_LIMITS.diskBytes) return false;
  return jsonBytesWithin(value, maxBytes) !== null;
}
const budgeted = <T>(parse: Parse<T>, max: number): Parse<T> => value => {
  if (!projectReadFitsJsonBudget(value, max)) bad();
  const parsed = parse(value);
  if (!projectReadFitsJsonBudget(parsed, max)) bad();
  return parsed;
};
const safe = <T>(parse: Parse<T>, value: unknown): T | null => { try { return parse(value); } catch { return null; } };
const ownTag = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) bad();
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d || !('value' in d) || !d.enumerable) bad();
  return d.value;
};

const id: Parse<string> = refine(text(PROJECT_READ_LIMITS.idBytes), v => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(v));
const digest: Parse<string> = refine(text(64), v => /^[0-9a-f]{64}$/u.test(v));
const timestamp: Parse<string> = refine(text(24), v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const name = refine(text(1020), v => v.length <= 255 && v !== '.' && v !== '..' && !/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u.test(v) && !/[. ]$/u.test(v));
const relative = (allowRoot: boolean): Parse<string> => refine(text(PROJECT_READ_LIMITS.relativePathBytes, false), v => {
  if (!v) return allowRoot;
  if (v.includes('\\') || v.split('/').length > PROJECT_READ_LIMITS.depth + 1) return false;
  return v.split('/').every(part => safe(name, part) !== null);
});
const relativePath = relative(false), relativeDirectory = relative(true);
const workPath = refine(text(W.relativePathBytes), isWorkCycleRelativePath);
const recoveryCommand = object({ executionId: id, requestId: id, signature: digest, revision: integer(1, Number.MAX_SAFE_INTEGER), recordVersion: digest, cleanupProofSha256: digest,
  termination: choices('exited','failed_start','stopped','timed_out','log_limit','fault'), shellExitCode: nullable(integer(-4294967295,4294967295)) });
const guardianId = refine(id, v => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v));
const controllerFields = { guardianId, guardianPid: integer(1,4294967295), enginePid: integer(1,4294967295), intentVersion:digest, readyVersion:digest };
const controllerRef = refine(object(controllerFields), v=>v.guardianPid!==v.enginePid);
const workRecovery = refine(object({ version: digest, parentEventsSha256: digest, controller: refine(object({...controllerFields,resultVersion:digest}),v=>v.guardianPid!==v.enginePid), commands: array(recoveryCommand, CMD.executions) }), v =>
  new Set(v.commands.map(c=>c.executionId)).size===v.commands.length && new Set(v.commands.map(c=>c.requestId)).size===v.commands.length && v.commands.every((c,i)=>i===0||v.commands[i-1]!.executionId<c.executionId));
const workContinuationRef = withOptional({ runId: id, workspaceId: id, eventCount: integer(1, PROJECT_READ_LIMITS.events), baselineVersion: digest }, { recovery: workRecovery });
export function parseWorkCycleContinuationRef(value: unknown): import('./agent-work-cycle').WorkCycleContinuationRef | null { try { return workContinuationRef(value); } catch { return null; } }
const workRef = refine(withOptional({ workspaceId: id }, { continuation: workContinuationRef }), v => !v.continuation || v.workspaceId !== v.continuation.workspaceId);
const workSource = object({ projectId: id, bindingId: id, identity: digest, fileId: id, relativePath, version: digest, bytes: integer(0, W.fileBytes) });
const workFile: Parse<WorkCycleFile> = refine(object({
  fileId: id, relativePath: workPath, version: digest, bytes: integer(0, W.fileBytes), confirmation: choices('confirmed','unconfirmed'),
  origin: input => {
    const kind = ownTag(input, 'kind');
    return kind === 'write' ? object({ kind: literal('write'), changeId: id })(input)
      : kind === 'import' ? object({ kind: literal('import'), changeId: id, source: workSource })(input)
      : kind === 'continuation' ? object({ kind: literal('continuation'), source: object({ runId: id, workspaceId: id, fileId: id, version: digest, baselineVersion: digest }) })(input)
      : kind === 'command' ? object({kind:literal('command'),executionId:id,manifestVersion:digest,sourceRelativePath:workPath})(input)
      : object({ kind: literal('execution'), executionId: id })(input);
  },
}), v => v.origin.kind !== 'continuation' || (v.origin.source.version === v.version && v.origin.source.fileId !== v.fileId));
const workFiles = refine(array(workFile, W.files), files => unique(files, f => f.fileId) && unique(files, f => f.relativePath.toLowerCase()));
const workContent = refine(object({ file: workFile, text: text(W.fileBytes, false), verified: literal(true) }), v => rawBytes(v.text) === v.file.bytes);
const workChange = refine(object({ changeId: id, file: workFile, previousVersion: nullable(digest), before: nullable(text(W.fileBytes, false)), after: text(W.fileBytes, false), changed: bool }), v =>
  (v.before === null) === (v.previousVersion === null) && rawBytes(v.after) === v.file.bytes && v.changed === (v.before !== v.after));
const workExecution: Parse<WorkCycleExecution> = refine(object({
  executionId: id, language: literal('javascript'), isolation: literal('windows-appcontainer'),
  script: object({ fileId: id, version: digest }),
  inputs: array(object({ fileId: id, relativePath: workPath, version: digest, bytes: integer(0, W.fileBytes) }), W.files),
  termination: choices('exited','timed_out','cancelled','limit','isolation_failed'),
  exitCode: nullable(integer(-2147483648, 4294967295)), signal: nullable(text(128)), durationMs: integer(0, 120000),
  stdout: text(W.logBytes, false), stderr: text(W.logBytes, false), stdoutTruncated: bool, stderrTruncated: bool,
  artifacts: array(workFile, W.artifactsPerExecution), verified: bool, cleanupConfirmed: bool,
}), v => unique(v.inputs, f => f.fileId) && unique(v.artifacts, f => f.fileId)
  && v.inputs.some(f => f.fileId === v.script.fileId && f.version === v.script.version)
  && (!v.verified || (v.cleanupConfirmed && v.termination === 'exited' && v.exitCode === 0))
  && (v.verified || v.artifacts.length === 0)
  && v.artifacts.every(f => f.origin.kind === 'execution' && f.origin.executionId === v.executionId)
  && (v.termination !== 'exited' || v.exitCode !== null));
function workValue(input: unknown): WorkCycleToolValue {
  const kind = ownTag(input, 'kind');
  if (kind === 'work_list') return object({ kind: literal('work_list'), files: workFiles })(input);
  if (kind === 'work_run') return object({ kind: literal('work_run'), execution: workExecution })(input);
  if (kind === 'work_edit') return refine(object({ kind: literal('work_edit'), file: workFile, previousVersion: digest, changeId: id, changed: bool }), v =>
    v.file.origin.kind === 'write' && v.file.origin.changeId === v.changeId && v.changed === (v.file.version !== v.previousVersion))(input);
  if (kind === 'work_read') return refine(object({ kind: literal('work_read'), file: workFile, text: text(W.readPageBytes, false), offset: integer(0, W.fileBytes), nextOffset: nullable(integer(0, W.fileBytes)) }), v =>
    v.offset + rawBytes(v.text) <= v.file.bytes && (v.nextOffset === null ? v.offset + rawBytes(v.text) === v.file.bytes : v.nextOffset === v.offset + rawBytes(v.text) && v.nextOffset < v.file.bytes && rawBytes(v.text) > 0))(input);
  if (kind === 'work_write' || kind === 'work_import') return object({ kind: literal(kind), file: workFile, previousVersion: nullable(digest), changeId: id, changed: bool })(input);
  return bad();
}
export const isWorkCycleToolName = (name: unknown): name is import('./agent-work-cycle').WorkCycleToolName => typeof name === 'string' && (WORK_CYCLE_TOOL_NAMES as readonly string[]).includes(name);
export const isProjectReadDataValue = (value: C.ProjectReadToolValue): value is Extract<C.ProjectReadToolValue, {kind:'list'|'find'|'search'|'read'|'skills'}> => ['list','find','search','read','skills'].includes(value.kind);
const normalizedText = (max: number, nonblank = false): Parse<string> => refine(text(max, nonblank), v => !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(v));
const query = refine(text(PROJECT_READ_LIMITS.queryBytes, false), v => v.length > 0 && !/[\r\n\u0000]/u.test(v));
const model: Parse<C.ProjectReadModel> = value => parseProjectReadModel(value) ?? bad();
const code: Parse<C.ProjectReadCode> = choices('CWD_UNAVAILABLE','PATH_POLICY_DENIED','PATH_NOT_FOUND','ACCESS_DENIED','NOT_A_DIRECTORY','NOT_A_FILE','INVALID_REQUEST','CAPABILITY_DENIED','NOT_BOUND','CREATION_PENDING','ROOT_UNAVAILABLE','ROOT_CHANGED','FILE_UNAVAILABLE','SOURCE_CHANGED','SNAPSHOT_CHANGED','CURSOR_STALE','UNSUPPORTED_PATH','UNSUPPORTED_ENCODING','UNSUPPORTED_TEXT','FILE_LIMIT','SCOPE_LIMIT','RULES_UNAVAILABLE','RULES_LIMIT','BUDGET_EXCEEDED','CANCELLED','BUSY','STORAGE_FAILED','MODEL_UNAVAILABLE','ENGINE_FAILED','CLEANUP_FAILED','IO_ERROR','HISTORY_FULL','RUN_NOT_FOUND','RUN_HAS_DEPENDENTS','CONFLICT','UNSUPPORTED_FORMAT','UNSUPPORTED_ANALYSIS','UNSUPPORTED_UNIT','UNSUPPORTED_WAVEFORM','TRACE_UNAVAILABLE','AXIS_MISMATCH','CONVERTER_UNAVAILABLE','METRIC_INPUT_INVALID','OA_UNAVAILABLE','OA_SNAPSHOT_UNPROVEN','OA_OBJECT_NOT_FOUND','OA_UNSUPPORTED');
const runState: Parse<C.ProjectReadRunState> = choices('preparing','running','waiting_user','completed','failed','stopped','interrupted');
const cleanupState: Parse<C.ProjectReadCleanupState> = choices('idle','pending','failed');
const boundProject: Parse<C.BoundProjectReadRef> = budgeted(refine(object({
  projectId: id, bindingId: id, name: text(4096), directoryName: name,
  directorySegments: array(name, 128, 2), identity: id,
}), v => v.directorySegments.at(-1) === v.directoryName), PROJECT_READ_LIMITS.projectDisplayBytes);
const nil:Parse<null>=v=>v===null?null:bad();
const project:Parse<C.ProjectReadRef>=v=>ownTag(v,'bindingId')===null?object({projectId:id,bindingId:nil,name:text(4096),directoryName:nil,directorySegments:array(name,0),identity:nil})(v) as C.ProjectReadRef:boundProject(v);
const absolutePath:Parse<string>=v=>{const s=fileSystemPathText(v);if(!/^[A-Za-z]:\\/u.test(s)||s.slice(2).includes(':'))bad();return s;};
const fsSourceFields={kind:literal('windows_filesystem'),sourceId:id,rootPath:absolutePath,rootIdentity:digest};
const fsSource:Parse<FileSystemSourceRef>=object(fsSourceFields);
const fsLocation:Parse<FileSystemLocation>=object({...fsSourceFields,absolutePath});
const nextArguments:Parse<FileSystemNextArguments>=v=>{const x=exact(v,['toolName','arguments']);if(!isFileSystemToolName(x.toolName))bad();const arguments_=parseFileSystemToolArguments(x.toolName,x.arguments);if(!arguments_)bad();return {toolName:x.toolName,arguments:arguments_} as FileSystemNextArguments;};
const position: Parse<C.ProjectReadPosition> = object({ line: integer(1, PROJECT_READ_LIMITS.lines), column: integer(1, PROJECT_READ_LIMITS.fileBytes + 1) });
const compare = (a: C.ProjectReadPosition, b: C.ProjectReadPosition): number => a.line - b.line || a.column - b.column;
const range: Parse<C.ProjectReadRange> = refine(object({ start: position, end: position }), v => compare(v.start, v.end) <= 0);
const scope: Parse<C.ProjectReadScope> = v=>v!==null&&typeof v==='object'&&Object.hasOwn(v,'kind')?object({kind:literal('windows_filesystem'),projectId:id,bindingId:nil,sourceId:id,identity:digest,directoryId:nullable(id),absoluteDirectory:absolutePath,relativeDirectory})(v):object({ projectId: id, bindingId: id, identity: id, directoryId: nullable(id), relativeDirectory })(v);
const coverage: Parse<C.ProjectReadCoverage> = refine(object({
  scope, complete: bool, scannedCandidates: integer(0, PROJECT_READ_LIMITS.runCandidates),
  scannedFiles: integer(0, PROJECT_READ_LIMITS.runCandidates), scannedBytes: integer(0, PROJECT_READ_LIMITS.runReadBytes), returned: integer(0, PROJECT_READ_LIMITS.listPage),
  skipped: object({ policy: integer(0, PROJECT_READ_LIMITS.runCandidates), unsupported: integer(0, PROJECT_READ_LIMITS.runCandidates), fileLimit: integer(0, PROJECT_READ_LIMITS.runCandidates), unavailable: integer(0, PROJECT_READ_LIMITS.runCandidates) }),
  remaining: object({ directories: nullable(integer(0, PROJECT_READ_LIMITS.directories)), files: nullable(integer(0, PROJECT_READ_LIMITS.candidates)), position: nullable(position) }),
  nextCursor: nullable(id), limitReason: nullable(choices('page','slice','time','scope','bytes','context','rules','citations')),
}), v => !v.complete || (v.nextCursor === null && v.limitReason === null && v.remaining.position === null && (v.remaining.directories === null || v.remaining.directories === 0) && (v.remaining.files === null || v.remaining.files === 0)));
const entry: Parse<C.ProjectReadEntry> = refine(object({
  fileId: nullable(id), directoryId: nullable(id), parentId: nullable(id), name, relativePath,
  kind: choices('file','directory'), bytes: count, readability: choices('readable','unsupported','file_limit','directory'), version: nullable(digest),
}), v => v.relativePath.split('/').at(-1) === v.name && (v.kind === 'directory'
  ? v.directoryId !== null && v.fileId === null && v.readability === 'directory' && v.bytes === 0 && v.version === null
  : v.fileId !== null && v.directoryId === null && v.readability !== 'directory' && (v.readability !== 'readable' || v.bytes <= PROJECT_READ_LIMITS.fileBytes)));
const entries = refine(array(entry, PROJECT_READ_LIMITS.listPage), v => unique(v, e => e.fileId ?? e.directoryId!) && unique(v, e => e.relativePath.toLowerCase()));

const ruleSourceMatches = (v: { source: string; relativeDirectory: string }): boolean =>
  v.source === (v.relativeDirectory ? v.relativeDirectory + '/' : '') + 'AGENTS.md';
const rule: Parse<C.ProjectReadRule> = refine(withOptional({
  source: relativePath, relativeDirectory, state: choices('loaded','absent'),
  version: nullable(digest), normalizedSha256: nullable(digest), text: nullable(normalizedText(PROJECT_READ_LIMITS.ruleBytes)),
},{sourceRef:fsSource}), v => ruleSourceMatches(v) && (v.state === 'absent'
  ? v.version === null && v.normalizedSha256 === null && v.text === null
  : v.version !== null && v.normalizedSha256 !== null && v.text !== null));
const rules = refine(array(rule, PROJECT_READ_LIMITS.rules), v => unique(v, r => (r.sourceRef?.sourceId??'project')+':'+r.source.toLowerCase()) && v.reduce((n, r) => n + rawBytes(r.text ?? ''), 0) <= PROJECT_READ_LIMITS.rulesBytes);
const ruleChunk: Parse<C.ProjectReadRuleChunk> = refine(withOptional({
  ruleId: id, source: relativePath, relativeDirectory, version: digest, normalizedSha256: digest,
  offsetBytes: integer(0, PROJECT_READ_LIMITS.ruleBytes), endBytes: integer(0, PROJECT_READ_LIMITS.ruleBytes), totalBytes: integer(0, PROJECT_READ_LIMITS.ruleBytes),
  text: normalizedText(PROJECT_READ_LIMITS.ruleChunkBytes), complete: bool,
},{sourceRef:fsSource}), v => ruleSourceMatches(v) && v.endBytes >= v.offsetBytes && v.endBytes <= v.totalBytes
  && v.endBytes - v.offsetBytes === rawBytes(v.text) && v.complete === (v.endBytes === v.totalBytes)
  && (v.totalBytes === 0 || v.endBytes > v.offsetBytes));
const ruleChunks = refine(array(ruleChunk, PROJECT_READ_LIMITS.rules), v => {
  const prior = new Map<string, C.ProjectReadRuleChunk>();
  for (const item of v) {
    const before = prior.get(item.ruleId);
    if (before && (before.complete || before.endBytes !== item.offsetBytes || before.source !== item.source || JSON.stringify(before.sourceRef)!==JSON.stringify(item.sourceRef) || before.version !== item.version || before.normalizedSha256 !== item.normalizedSha256 || before.totalBytes !== item.totalBytes)) return false;
    if ([...prior.values()].some(r => r.source === item.source &&r.sourceRef?.sourceId===item.sourceRef?.sourceId&& r.ruleId !== item.ruleId)) return false;
    prior.set(item.ruleId, item);
  }
  return v.reduce((n, r) => n + rawBytes(r.text), 0) <= PROJECT_READ_LIMITS.rulesBytes;
});
const previewFields = {
  citationId: id, fileId: id, relativePath, version: digest, normalizedSha256: digest, range,
  excerpt: normalizedText(PROJECT_READ_LIMITS.readPageBytes), excerptSha256: digest,
  totalLines: integer(1, PROJECT_READ_LIMITS.lines), fileBytes: integer(0, PROJECT_READ_LIMITS.fileBytes), source: choices('read','search'),
};
function excerptRangeMatches(v: C.ProjectReadCitationPreview): boolean {
  let line = v.range.start.line, column = v.range.start.column;
  for (const point of v.excerpt) { if (point === '\n') { line++; column = 1; } else column++; }
  return line === v.range.end.line && column === v.range.end.column && line <= v.totalLines
    && v.range.start.line <= v.totalLines && (line - v.range.start.line < PROJECT_READ_LIMITS.readPageLines || (line - v.range.start.line === PROJECT_READ_LIMITS.readPageLines && column === 1))
    && v.totalLines <= v.fileBytes + 1 && v.range.start.column <= v.fileBytes + 1 && v.range.end.column <= v.fileBytes + 1
    && rawBytes(v.excerpt) <= v.fileBytes && (v.source !== 'search' || (v.excerpt.length > 0 && line === v.range.start.line));
}
const preview: Parse<C.ProjectReadCitationPreview> = refine(withOptional(previewFields,{location:fsLocation}), excerptRangeMatches);
const citation: Parse<C.ProjectReadCitation> = refine(withOptional({
  ...previewFields, runId: id, project, snapshotId: id, fileIdentity: id, createdAt: timestamp,
  origin: nullable(object({ runId: id, citationId: id })),
},{location:fsLocation}), v => excerptRangeMatches(v) && (v.origin === null || v.origin.runId !== v.runId));
const match: Parse<C.ProjectReadSearchMatch> = refine(object({
  fileId: id, relativePath, version: digest, match: range, citation: preview,
}), v => v.fileId === v.citation.fileId && v.relativePath === v.citation.relativePath && v.version === v.citation.version
  && v.citation.source === 'search' && v.match.start.line === v.match.end.line
  && compare(v.match.start, v.match.end) < 0 && compare(v.citation.range.start, v.match.start) <= 0 && compare(v.match.end, v.citation.range.end) <= 0);
const matches = refine(array(match, PROJECT_READ_LIMITS.searchMatches), v => unique(v, m => m.citation.citationId));
const resume: Parse<C.ProjectReadResumePoint> = refine(object({
  toolName: choices('project_search','project_read'), relativePath, version: digest, next: position, query: nullable(query), relativeDirectory,
}), v => (v.toolName === 'project_search' ? v.query !== null : v.query === null)
  && (!v.relativeDirectory || v.relativePath.startsWith(v.relativeDirectory + '/')));
const toolBase = { phase: choices('rules','scan','data'), snapshotId: id, coverage, rules: ruleChunks, resume: nullable(resume) };
const fsToolOptional={source:fsSource,nextArguments:nullable(nextArguments)};
const listValue = withOptional({ ...toolBase, kind: choices('list','find'), entries },fsToolOptional);
const skillDescriptor = refine(object({ skillId: id, entryRelativePath: relativePath, directoryId: nullable(id), discoveryVersion: digest,
  versionMethod: literal('metadata-observation-sha256-v1'), name: nullable(text(S.nameBytes)), description: nullable(text(S.descriptionBytes)),
  metadataStatus: choices('ready','missing_frontmatter','invalid_frontmatter','header_too_large','unsupported_encoding'), baseRelativeDirectory: relativeDirectory,
}), v => isSkillEntry(v.entryRelativePath) && v.baseRelativeDirectory === v.entryRelativePath.split('/').slice(0,-1).join('/')
  && (v.metadataStatus === 'ready' ? v.name !== null && v.description !== null : v.name === null && v.description === null));
const skillDiscoveryValue = object({ ...toolBase, kind: literal('skills'), sourceKind: literal('selected_project'),
  entries: refine(array(skillDescriptor, PROJECT_READ_LIMITS.listPage), v => unique(v, e => e.skillId)) });
const skillSource = refine(object({ sourceKind: literal('selected_project'), skillId: id, entryRelativePath: relativePath,
  discoveryVersion: digest, entryVersion: nullable(digest), entryComplete: bool, resourceRole: choices('entry','reference'),
  resourceRelativePath: relativePath, resourceVersion: nullable(digest),
}), v => isSkillEntry(v.entryRelativePath) && (!v.entryComplete || v.entryVersion !== null)
  && (v.resourceRole === 'entry' ? v.entryRelativePath === v.resourceRelativePath && v.entryVersion === v.resourceVersion
    : v.entryComplete && isSkillResource(v.entryRelativePath, v.resourceRelativePath)));
const searchValue = withOptional({ ...toolBase, kind: literal('search'), matches },fsToolOptional);
const readValue = withOptional({ ...toolBase, kind: literal('read'), citation: nullable(preview), empty: bool, next: nullable(position) }, { skill: skillSource,...fsToolOptional });
const sumValue = refine(object({ kind: literal('sum'), sum: integer(-32000000, 32000000), count: integer(1, 32), source: literal('deterministic-local'), toolVersion: literal('pilot.sum.v1') }), v => Math.abs(v.sum) <= v.count * 1000000);
const commandEnvironment: Parse<import('./agent-command').CommandBridgeValues['inspectCommandEnvironment']> = object({ environments: array(v=>isCommandEnvironment(v)?v:bad(),8), workspace: nullable(object({workspaceId:id,baselineVersion:digest,files:integer(0,W.files),bytes:integer(0,W.workspaceBytes)})) });
const commandExecution: Parse<import('./agent-command').CommandExecution> = v=>isCommandExecution(v)?structuredClone(v):bad();
const commandPage: Parse<import('./agent-command').CommandLogPage> = v=>isCommandLogPage(v)?structuredClone(v):bad();
const commandObservation=object({runId:id,startSequence:integer(2,PROJECT_READ_LIMITS.events)});
function commandValue(input:unknown):CommandToolValue {
  const kind=ownTag(input,'kind');
  if(kind==='command_environment'){const v=exact(input,['kind','environments','workspace']);return {kind,...commandEnvironment({environments:v.environments,workspace:v.workspace})};}
  if(kind==='command_log')return withOptional({kind:literal(kind),page:commandPage},{observation:commandObservation})(input);
  if(kind==='command_status')return withOptional({kind:literal(kind),execution:commandExecution},{observation:commandObservation})(input);
  if(kind==='command_start'||kind==='command_stop')return object({kind:literal(kind),execution:commandExecution})(input);
  return bad();
}
function toolValue(input: unknown): C.ProjectReadToolValue {
  const kind = ownTag(input, 'kind');
  if (kind === 'oa_read') return parseOaReadToolValue(input) ?? bad();
  if (isWslResultsToolName(kind)) return parseWslResultsToolValue(input) ?? bad();
  if (isWaveformResultsToolName(kind)) return parseWaveformResultsToolValue(input) ?? bad();
  if (isCommandToolName(kind)) return commandValue(input);
  if (isWorkCycleToolName(kind)) return workValue(input);
  if (kind === 'sum') return sumValue(input);
  const v = kind === 'list' || kind === 'find' ? listValue(input) : kind === 'skills' ? skillDiscoveryValue(input) : kind === 'search' ? searchValue(input) : kind === 'read' ? readValue(input) : bad();
  const returned = v.kind === 'search' ? v.matches.length : v.kind === 'read' ? (v.citation === null ? 0 : 1) : v.entries.length;
  if(v.kind!=='skills'){
    const scope=v.coverage.scope;
    if(v.source){
      if(scope.kind!=='windows_filesystem'||scope.sourceId!==v.source.sourceId||scope.identity!==v.source.rootIdentity||scope.bindingId!==null)bad();
      const normalizedRoot=v.source.rootPath.endsWith('\\')?v.source.rootPath:v.source.rootPath+'\\';
      if(scope.absoluteDirectory!==(scope.relativeDirectory?normalizedRoot+scope.relativeDirectory.replaceAll('/','\\'):v.source.rootPath))bad();
      const previews=v.kind==='read'?(v.citation?[v.citation]:[]):v.kind==='search'?v.matches.map(m=>m.citation):[];
      for(const c of previews){const loc=c.location;if(!loc||loc.sourceId!==v.source.sourceId||loc.rootIdentity!==v.source.rootIdentity||loc.rootPath!==v.source.rootPath||loc.absolutePath!==normalizedRoot+c.relativePath.replaceAll('/','\\'))bad();}
      if(v.rules.some(r=>JSON.stringify(r.sourceRef)!==JSON.stringify(v.source)))bad();
      if(v.nextArguments===undefined||(v.coverage.nextCursor===null)!==(v.nextArguments===null)||v.nextArguments&&v.nextArguments.arguments.cursor!==v.coverage.nextCursor)bad();
    }else if(scope.kind==='windows_filesystem'||v.nextArguments!==undefined||v.rules.some(r=>r.sourceRef)||v.kind==='read'&&v.citation?.location||v.kind==='search'&&v.matches.some(m=>m.citation.location))bad();
  }else if(v.coverage.scope.kind==='windows_filesystem')bad();
  if (v.coverage.returned !== returned || (v.phase !== 'data' && returned !== 0) || (v.phase === 'rules' && v.coverage.complete)) bad();
  if ((v.kind === 'list' || v.kind === 'find' || v.kind === 'skills') && v.resume !== null) bad();
  if (v.resume && (v.resume.toolName !== 'project_' + v.kind || v.coverage.complete)) bad();
  if (v.kind === 'read') {
    if (v.skill) {
      if (v.resume !== null || (v.skill.resourceRole === 'entry' && v.skill.entryComplete !== (v.phase === 'data' && v.coverage.complete))) bad();
      if (v.citation && (v.citation.relativePath !== v.skill.resourceRelativePath || v.citation.version !== v.skill.resourceVersion)) bad();
      if (v.phase === 'data' && v.skill.resourceVersion === null) bad();
    }
    if (v.citation && v.citation.source !== 'read') bad();
    if (v.empty && (v.phase !== 'data' || v.citation !== null || v.next !== null || !v.coverage.complete)) bad();
    if (v.phase !== 'data' && v.empty) bad();
    if (v.phase === 'data' && v.citation === null && !v.empty) bad();
    if (v.citation && v.next && compare(v.citation.range.end, v.next) !== 0) bad();
    if (v.coverage.complete && v.next !== null) bad();
    if (v.resume && v.citation && (v.resume.relativePath !== v.citation.relativePath || v.resume.version !== v.citation.version || v.next === null || compare(v.resume.next, v.next) !== 0)) bad();
  }
  return v;
}
const toolResult: Parse<C.ProjectReadToolResult> = input => {
  const result = (ownTag(input, 'ok') === true
  ? object({ ok: literal(true), value: toolValue })(input)
  : object({ ok: literal(false), error: withOptional({ code },{osCode:choices(...FILESYSTEM_OS_CODES)}), coverage: nullable(coverage) })(input));
  if (!projectReadFitsJsonBudget(result, result.ok && (isWorkCycleToolName(result.value.kind)||isCommandToolName(result.value.kind)) ? W.toolResultBytes : PROJECT_READ_LIMITS.toolResultBytes)) bad();
  return result;
};
const listingArgs = { directoryId: nullable(id), cursor: nullable(id), refresh: bool };
const refreshValid = (v: { directoryId: string | null; cursor: string | null; refresh: boolean }): boolean => !v.refresh || (v.directoryId === null && v.cursor === null);
const argumentParsers: { readonly [K in C.ProjectReadToolName]: Parse<C.ProjectReadToolArguments[K]> } = {
  oa_open_design: v => parseOaReadToolArguments('oa_open_design', v) ?? bad(),
  oa_inspect_design: v => parseOaReadToolArguments('oa_inspect_design', v) ?? bad(),
  oa_query_instances: v => parseOaReadToolArguments('oa_query_instances', v) ?? bad(),
  oa_query_nets: v => parseOaReadToolArguments('oa_query_nets', v) ?? bad(),
  oa_describe_device: v => parseOaReadToolArguments('oa_describe_device', v) ?? bad(),
  fs_list:v=>parseFileSystemToolArguments('fs_list',v)??bad(),fs_find:v=>parseFileSystemToolArguments('fs_find',v)??bad(),fs_search:v=>parseFileSystemToolArguments('fs_search',v)??bad(),fs_read:v=>parseFileSystemToolArguments('fs_read',v)??bad(),
  wsl_results_list: v => parseWslResultsToolArguments('wsl_results_list', v) ?? bad(),
  wsl_results_read: v => parseWslResultsToolArguments('wsl_results_read', v) ?? bad(),
  wsl_waveform_list: v => parseWaveformResultsToolArguments('wsl_waveform_list', v) ?? bad(),
  wsl_waveform_read: v => parseWaveformResultsToolArguments('wsl_waveform_read', v) ?? bad(),
  wsl_waveform_metrics: v => parseWaveformResultsToolArguments('wsl_waveform_metrics', v) ?? bad(),
  // Model-call syntax is separate from execution semantics. The broker records
  // invalid refresh combinations as tool errors before any index/file operation.
  project_list: object(listingArgs),
  project_find: object({ ...listingArgs, query }),
  project_search: object({ ...listingArgs, query }),
  // A rules/scan cursor can precede the first verified text version. The broker
  // binds all cursor arguments exactly; syntax must not invent a non-null version.
  project_read: object({ fileId: id, version: nullable(digest), start: position, cursor: nullable(id) }),
  skill_discover: object(listingArgs),
  skill_load: object({ skillId: id, discoveryVersion: digest, version: nullable(digest), start: position, cursor: nullable(id) }),
  skill_read_reference: object({ skillId: id, skillVersion: digest, fileId: id, version: nullable(digest), start: position, cursor: nullable(id) }),
  pilot_sum: object({ values: array(integer(-1000000, 1000000), 32, 1) }),
  work_list: object({}),
  work_read: object({ fileId: id, version: digest, offset: integer(0, W.fileBytes) }),
  work_write: object({ relativePath: workPath, expectedVersion: nullable(digest), text: text(W.writeBytes, false) }),
  work_edit: refine(object({ fileId: id, expectedVersion: digest, oldText: refine(text(W.editBytes, false), v => v.length > 0), newText: text(W.editBytes, false) }),
    v => rawBytes(v.oldText) + rawBytes(v.newText) <= W.editBytes),
  work_import: object({ fileId: id, version: digest, relativePath: workPath, expectedVersion: nullable(digest) }),
  work_run: object({ fileId: id, version: digest }),
  command_environment:v=>parseCommandArguments('command_environment',v)??bad(),
  command_start:v=>parseCommandArguments('command_start',v)??bad(),
  command_status:v=>parseCommandArguments('command_status',v)??bad(),
  command_log:v=>parseCommandArguments('command_log',v)??bad(),
  command_stop:v=>parseCommandArguments('command_stop',v)??bad(),
};
const toolName: Parse<C.ProjectReadToolName> = choices(...OA_READ_TOOL_NAMES,...FILESYSTEM_TOOL_NAMES,'project_list','project_find','project_search','project_read','pilot_sum', 'wsl_results_list', 'wsl_results_read', 'wsl_waveform_list', 'wsl_waveform_read', 'wsl_waveform_metrics', ...AGENT_SKILL_TOOL_NAMES, ...WORK_CYCLE_TOOL_NAMES, ...COMMAND_TOOL_NAMES);
function toolCall(input: unknown, completed: boolean): C.ProjectReadToolCall | C.ProjectReadEventData['tool.completed'] {
  const name = toolName(ownTag(input, 'toolName'));
  const fields = { sessionId: id, messageId: id, callId: id, toolName: literal(name), arguments: argumentParsers[name] };
  if (!completed) return object(fields)(input) as C.ProjectReadToolCall;
  const v = object({ ...fields, result: toolResult })(input);
  if (v.result.ok) {
    if ((name === 'project_list' || name === 'project_find' || name === 'project_search') && !refreshValid(argumentParsers[name](v.arguments))) bad();
    const expected = isOaReadToolName(name)?'oa_read':isFileSystemToolName(name)?name.slice(3):name === 'pilot_sum' ? 'sum' : name === 'skill_discover' ? 'skills'
      : name === 'skill_load' || name === 'skill_read_reference' ? 'read' : isWorkCycleToolName(name)||isCommandToolName(name)||isWslResultsToolName(name)||isWaveformResultsToolName(name) ? name : name.slice('project_'.length);
    if (v.result.value.kind !== expected) bad();
    if (isOaReadToolName(name) && v.result.value.kind === 'oa_read') {
      const a = parseOaReadToolArguments(name, v.arguments) ?? bad(), r = v.result.value;
      if (name === 'oa_open_design') {
        if (!('designId' in a) || a.designId !== r.source.designId || r.data.kind !== 'design') bad();
      } else {
        if (!('designHandle' in a) || a.designHandle !== r.source.designHandle || a.savedRevision !== r.source.savedRevision) bad();
        const kind = name === 'oa_inspect_design' ? 'design' : name === 'oa_query_instances' ? 'instances'
          : name === 'oa_query_nets' ? ('section' in a && a.section === 'members' ? 'net_members' : 'nets')
          : 'section' in a && a.section === 'parameters' ? 'device_parameters' : 'device_terminals';
        if (r.data.kind !== kind) bad();
        if ('selector' in a && JSON.stringify(a.selector) !== JSON.stringify(r.coverage.selector)) bad();
        if ('instanceId' in a && (!('instanceId' in r.data) || r.data.instanceId !== a.instanceId)) bad();
      }
    }
    if (name === 'wsl_results_list' && v.result.value.kind === 'wsl_results_list') {
      const a = argumentParsers.wsl_results_list(v.arguments), r = v.result.value;
      if (r.binding.id !== a.bindingId || r.relativeDirectory !== a.relativeDirectory) bad();
    }
    if (name === 'wsl_results_read' && v.result.value.kind === 'wsl_results_read') {
      const a = argumentParsers.wsl_results_read(v.arguments), r = v.result.value;
      if (r.source.id !== a.bindingId || r.fileId !== a.fileId || r.version !== a.version || r.startLine !== a.startLine || r.endLine - r.startLine + 1 > a.maxLines) bad();
    }
    if (name === 'wsl_waveform_list' && v.result.value.kind === 'wsl_waveform_list') {
      const a = argumentParsers.wsl_waveform_list(v.arguments), r = v.result.value;
      if (r.source.binding.id !== a.bindingId || r.relativePath !== a.relativePath || r.source.analysis !== a.analysis || r.nameQuery !== a.nameQuery) bad();
    }
    if (name === 'wsl_waveform_read' && v.result.value.kind === 'wsl_waveform_read') {
      const a = argumentParsers.wsl_waveform_read(v.arguments), r = v.result.value;
      if (r.source.binding.id !== a.bindingId || r.source.sourceVersion !== a.sourceVersion || r.trace.traceId !== a.traceId || r.startPoint !== a.startPoint || r.points.length > a.maxPoints) bad();
    }
    if (name === 'wsl_waveform_metrics' && v.result.value.kind === 'wsl_waveform_metrics') {
      const a = argumentParsers.wsl_waveform_metrics(v.arguments), r = v.result.value;
      if (r.source.binding.id !== a.bindingId || r.source.sourceVersion !== a.sourceVersion
        || r.numerator.positiveTraceId !== a.numerator.positiveTraceId || r.numerator.negativeTraceId !== a.numerator.negativeTraceId
        || r.denominator.positiveTraceId !== a.denominator.positiveTraceId || r.denominator.negativeTraceId !== a.denominator.negativeTraceId) bad();
    }
    if(name==='command_start'&&v.result.value.kind==='command_start'){
      const a=argumentParsers.command_start(v.arguments),e=v.result.value.execution;
      if(e.requestId!==a.requestId||e.workspaceId!==a.workspaceId||e.environment.environmentId!==a.environmentId||e.environment.revision!==a.environmentRevision||e.baselineVersion!==a.baselineVersion||e.cwdRelativePath!==a.cwdRelativePath||e.commandText!==a.commandText)bad();
    }
    if((name==='command_status'||name==='command_stop')&&(v.result.value.kind==='command_status'||v.result.value.kind==='command_stop')){
      const a=argumentParsers[name](v.arguments);if(v.result.value.execution.executionId!==a.executionId)bad();
    }
    if(name==='command_log'&&v.result.value.kind==='command_log'){
      const a=argumentParsers.command_log(v.arguments),p=v.result.value.page;
      if(p.executionId!==a.executionId||p.stream!==a.stream||p.offset!==a.offset||p.endOffset-p.offset>a.maxBytes||a.expectedPrefixVersion!==null&&p.prefixVersion!==a.expectedPrefixVersion)bad();
    }
    if (name === 'skill_discover' && !refreshValid(argumentParsers.skill_discover(v.arguments))) bad();
    if (v.result.value.kind === 'read') {
      const value = v.result.value;
      if (name === 'skill_load' || name === 'skill_read_reference') {
        const args = argumentParsers[name](v.arguments), skill = value.skill;
        if (!skill || args.skillId !== skill.skillId) bad();
        if (name === 'skill_load') {
          const a = argumentParsers.skill_load(v.arguments);
          if (skill.resourceRole !== 'entry' || a.discoveryVersion !== skill.discoveryVersion || (value.citation && value.citation.fileId !== a.skillId)) bad();
        } else {
          const a = argumentParsers.skill_read_reference(v.arguments);
          if (skill.resourceRole !== 'reference' || a.skillVersion !== skill.entryVersion || (value.citation && value.citation.fileId !== a.fileId)) bad();
        }
        if (args.version !== null && skill.resourceVersion !== null && args.version !== skill.resourceVersion) bad();
        if (value.citation && compare(args.start, value.citation.range.start) !== 0) bad();
      } else if (value.skill) bad();
    }
    if (name === 'pilot_sum') {
      const args = argumentParsers.pilot_sum(v.arguments), result = v.result.value;
      if (result.kind !== 'sum' || result.count !== args.values.length || result.sum !== args.values.reduce((a, b) => a + b, 0)) bad();
    }
    if (name === 'project_read' && v.result.value.kind === 'read' && v.result.value.citation) {
      const args = argumentParsers.project_read(v.arguments), c = v.result.value.citation;
      if (args.fileId !== c.fileId || (args.version !== null && args.version !== c.version) || compare(args.start, c.range.start) !== 0) bad();
    }
    if(isFileSystemToolName(name)&&isProjectReadDataValue(v.result.value)){
      const result=v.result.value;if(result.kind==='skills'||!result.source||result.coverage.scope.kind!=='windows_filesystem'||result.nextArguments&&result.nextArguments.toolName!==name)bad();
      if(name==='fs_read'&&result.kind==='read'){
        const a=argumentParsers.fs_read(v.arguments),c=result.citation;
        if(c&&(a.fileId!==null&&a.fileId!==c.fileId||a.version!==null&&a.version!==c.version||compare(a.start,c.range.start)!==0))bad();
      }
    }else if(isProjectReadDataValue(v.result.value)&&v.result.value.source)bad();
    if ((name === 'project_search'||name==='fs_search') && v.result.value.kind === 'search') {
      const args = argumentParsers[name](v.arguments);
      for (const match of v.result.value.matches) {
        const start = match.match.start.column - match.citation.range.start.column;
        const end = match.match.end.column - match.citation.range.start.column;
        if (Array.from(match.citation.excerpt).slice(start, end).join('') !== args.query) bad();
      }
    }
    if (name === 'work_read' && v.result.value.kind === 'work_read') {
      const args = argumentParsers.work_read(v.arguments), value = v.result.value;
      if (args.fileId !== value.file.fileId || args.version !== value.file.version || args.offset !== value.offset) bad();
    }
    if (name === 'work_edit' && v.result.value.kind === 'work_edit') {
      const args = argumentParsers.work_edit(v.arguments), value = v.result.value;
      if (args.fileId !== value.file.fileId || args.expectedVersion !== value.previousVersion || value.changed !== (args.oldText !== args.newText)) bad();
    }
    if (name === 'work_run' && v.result.value.kind === 'work_run') {
      const args = argumentParsers.work_run(v.arguments), execution = v.result.value.execution;
      if (args.fileId !== execution.script.fileId || args.version !== execution.script.version) bad();
    }
    if ((name === 'work_write' || name === 'work_import') && (v.result.value.kind === 'work_write' || v.result.value.kind === 'work_import')) {
      const args = argumentParsers[name](v.arguments), value = v.result.value;
      if (args.relativePath !== value.file.relativePath || args.expectedVersion !== value.previousVersion || value.file.origin.kind !== (name === 'work_write' ? 'write' : 'import')
        || !('changeId' in value.file.origin) || value.file.origin.changeId !== value.changeId) bad();
      if (name === 'work_import') {
        const a = argumentParsers.work_import(v.arguments);
        if (value.file.origin.kind !== 'import' || value.file.origin.source.fileId !== a.fileId || value.file.origin.source.version !== a.version || value.file.version !== a.version) bad();
      }
    }
  }
  return v as C.ProjectReadEventData['tool.completed'];
}
const accounting: Parse<C.ProjectReadAccounting> = refine(object({
  providerAttempts: count, httpDispatches: count,
  toolAttempts: count, physicalReadBytes: integer(0, PROJECT_READ_LIMITS.runReadBytes),
  visitedCandidates: integer(0, PROJECT_READ_LIMITS.runCandidates), contextBytes: nullable(integer(0, 1024*1024)),
}), v => v.httpDispatches <= v.providerAttempts);
const runBudget: Parse<C.ProjectReadBudget> = refine(object({
  providerAttempts: nullable(integer(1, PROJECT_READ_LIMITS.requests)), httpDispatches: nullable(integer(1, PROJECT_READ_LIMITS.requests)),
  toolAttempts: nullable(integer(1, PROJECT_READ_LIMITS.toolCalls)), physicalReadBytes: integer(1, PROJECT_READ_LIMITS.runReadBytes),
  visitedCandidates: integer(1, PROJECT_READ_LIMITS.runCandidates), contextBytes: integer(1, 1024*1024),
  outputBytes: integer(1, 256*1024), maxOutputTokens: integer(1, PROJECT_READ_LIMITS.maxOutputTokens),
  deadlineMs: integer(1, PROJECT_READ_LIMITS.deadlineMs), waitMs: integer(1, PROJECT_READ_LIMITS.waitMs),
}), v => v.providerAttempts === null
  ? v.httpDispatches === null && v.toolAttempts === null
  : v.httpDispatches !== null && v.toolAttempts !== null && v.httpDispatches <= v.providerAttempts);
const activeTask: Parse<C.ProjectReadActiveTask> = refine(object({
  mode: choices('calculation','project_read','project_work','conversation'), runId: id, project: nullable(project), status: runState, cleanupState,
}), v => v.mode === 'conversation'||(v.mode === 'calculation' ? v.project === null : v.project !== null&&v.project.bindingId!==null));
const status: Parse<C.ProjectReadStatus> = refine(object({
  model: nullable(model), project: nullable(project), availability: choices('unchecked','available','not_bound','creation_pending','root_unavailable','root_changed','not_configured','unsupported_model','storage_failed','busy','unavailable'),
  canStart: bool, processState: choices('idle','starting','ready','failed'), cleanupState, reason: nullable(code), activeTask: nullable(activeTask),
}), v => (!v.project||v.project.bindingId!==null)&&(!v.canStart || (v.project !== null && v.model !== null && ['unchecked','available'].includes(v.availability) && v.cleanupState === 'idle' && v.activeTask === null && v.reason === null)));
const summary: Parse<C.ProjectReadSummary> = refine(withOptional({
  runId: id, clientRequestId: id, project, model, goal: text(PROJECT_READ_LIMITS.goalBytes), constraint: text(PROJECT_READ_LIMITS.constraintBytes, false),
  continuedFrom: nullable(id), status: runState, cleanupState, createdAt: timestamp, updatedAt: timestamp, accounting,
  eventCount: integer(1, PROJECT_READ_LIMITS.events),
  continuation: nullable(object({ fromRunId: id, evidenceCount: integer(0, PROJECT_READ_LIMITS.continuationCitations), confirmedQuestions: integer(0, PROJECT_READ_LIMITS.questions), resumedFilePositions: integer(0, PROJECT_READ_LIMITS.continuationCitations), restartedQueries: integer(0, PROJECT_READ_LIMITS.toolCalls) })),
}, { workCycle: workRef, wslResultsBinding: v => parseWslResultsBinding(v) ?? bad(), origin:parseChatRunOrigin }), v => (v.project.bindingId!==null||!!v.origin&&!v.workCycle&&v.continuedFrom===null)&&v.createdAt <= v.updatedAt && v.runId !== v.continuedFrom && (v.continuation === null || v.continuation.fromRunId === v.continuedFrom) && (v.continuedFrom !== null || v.continuation === null) && (v.status !== 'completed' || v.cleanupState === 'idle') && (!v.workCycle || (v.continuation === null && (v.continuedFrom === null ? !v.workCycle.continuation : v.workCycle.continuation?.runId === v.continuedFrom))));

const eventData: { readonly [K in keyof C.ProjectReadEventData]: Parse<C.ProjectReadEventData[K]> } = {
  'work.prepared':object({workCycle:workRef,continuedFrom:nullable(id)}),
  'run.accepted': refine(withOptional({ project, model, continuedFrom: nullable(id), budget: runBudget }, { workCycle: workRef, wslResultsBinding: v => parseWslResultsBinding(v) ?? bad(), origin:parseChatRunOrigin }),v=>v.project.bindingId!==null||!!v.origin&&!v.workCycle&&v.continuedFrom===null),
  'run.started': withOptional({ sessionId: id, engine: literal('opencode'), version: literal('1.18.17') }, { controller: controllerRef }),
  'model.step': object({ step: integer(1, Number.MAX_SAFE_INTEGER) }),
  'model.response': object({ request: integer(1, Number.MAX_SAFE_INTEGER), responseModel: nullable(text(128)), usage: nullable(object({ inputTokens: count, outputTokens: count })) }),
  'message.delta': object({ messageId: id, step: integer(1, Number.MAX_SAFE_INTEGER), text: text(PROJECT_READ_LIMITS.eventBytes, false) }),
  'project.rules': object({ rules }),
  'tool.started': value => toolCall(value, false) as C.ProjectReadToolCall,
  'tool.completed': value => toolCall(value, true) as C.ProjectReadEventData['tool.completed'],
  'question.asked': object({ questionId: id, prompt: text(PROJECT_READ_LIMITS.answerBytes) }),
  'question.answered': object({ questionId: id, answer: text(PROJECT_READ_LIMITS.answerBytes) }),
  'question.delivered': object({ questionId: id }),
  'budget.updated': accounting,
  'cleanup.started': object({ reason: choices('completed','failed','stop','close') }),
  'cleanup.completed': object({ outcome: choices('confirmed','failed') }),
  'run.completed': object({ citations: refine(array(id, PROJECT_READ_LIMITS.citations), v => unique(v, x => x)) }),
  'run.failed': object({ code, stage: choices('accept','model','tool','context','storage','cleanup') }),
  'run.stopped': object({ reason: literal('user') }),
  'run.interrupted': object({ reason: choices('window_closed','restart','question_timeout') }),
};
const event: Parse<C.ProjectReadEvent> = input => {
  const type = ownTag(input, 'type');
  if (typeof type !== 'string' || !Object.hasOwn(eventData, type)) bad();
  const eventType = type as keyof C.ProjectReadEventData;
  const v = object({ runId: id, sequence: integer(1, PROJECT_READ_LIMITS.events), time: timestamp, type: literal(eventType), data: eventData[eventType] })(input) as C.ProjectReadEvent;
  if (v.type === 'run.accepted' && (v.sequence !== 1 || v.data.continuedFrom === v.runId)) bad();
  if(v.type==='run.accepted'&&!v.data.origin&&(v.data.budget.providerAttempts===null||v.data.budget.outputBytes>PROJECT_READ_LIMITS.outputBytes||v.data.budget.contextBytes>PROJECT_READ_LIMITS.contextBytes))bad();
  if (v.type === 'run.accepted' && v.data.workCycle && (v.data.continuedFrom === null ? !!v.data.workCycle.continuation : v.data.workCycle.continuation?.runId !== v.data.continuedFrom)) bad();
  if (v.type !== 'run.accepted' && v.sequence === 1) bad();
  const work = (v.type === 'tool.started' || v.type === 'tool.completed') && (isWorkCycleToolName(v.data.toolName)||isCommandToolName(v.data.toolName));
  if (!projectReadFitsJsonBudget(v, work ? W.eventBytes : PROJECT_READ_LIMITS.eventBytes)) bad();
  return v;
};
const versionFields = { contractVersion: literal(AGENT_PROJECT_READ_VERSION) };
const requestParsers: { readonly [K in C.ProjectReadMethod]: Parse<C.ProjectReadRequests[K]> } = {
  inspectCommandEnvironment:object({...versionFields,runId:id}),
  listCommandExecutions:object({...versionFields,runId:id}),
  readCommandExecution:object({...versionFields,runId:id,executionId:id,afterRevision:nullable(integer(1,Number.MAX_SAFE_INTEGER)),waitMs:integer(0,CMD.statusWaitMs)}),
  readCommandDiagnostics:object({...versionFields,runId:id,executionId:id}),
  openCommandDiagnostics:object({...versionFields,runId:id,executionId:id}),
  readCommandLog:object({...versionFields,runId:id,executionId:id,stream:choices('stdout','stderr'),offset:integer(0,CMD.logBytes),maxBytes:integer(1,CMD.logPageBytes),expectedPrefixVersion:nullable(digest)}),
  stopCommandExecution:object({...versionFields,runId:id,executionId:id}),
  getStatus: object({ ...versionFields, projectId: id }),
  selectModel: object({ ...versionFields, model }),
  revalidateProject: object({ ...versionFields, projectId: id, bindingId: id }),
  startRun: object({ ...versionFields, clientRequestId: id, projectId: id, bindingId: id, model, goal: text(PROJECT_READ_LIMITS.goalBytes), constraint: text(PROJECT_READ_LIMITS.constraintBytes, false), continuedFrom: nullable(id) }),
  startWorkRun: input => {
    const fields = { ...versionFields, clientRequestId: id, projectId: id, bindingId: id, model, goal: text(PROJECT_READ_LIMITS.goalBytes), constraint: text(PROJECT_READ_LIMITS.constraintBytes, false) };
    return ownTag(input, 'continuedFrom') === null ? object({ ...fields, continuedFrom: value => value === null ? null : bad() })(input)
      : withOptional({ ...fields, continuedFrom: id, expectedEventCount: integer(1, PROJECT_READ_LIMITS.events), baselineVersion: digest }, { recoveryVersion: digest })(input);
  },
  prepareWorkContinuation: object({ ...versionFields, runId: id, projectId: id, bindingId: id, expectedEventCount: integer(1, PROJECT_READ_LIMITS.events) }),
  listWorkFiles: object({ ...versionFields, runId: id }),
  readWorkFile: object({ ...versionFields, runId: id, fileId: id, version: digest }),
  readWorkChange: object({ ...versionFields, runId: id, changeId: id }),
  listRuns: object({ ...versionFields, projectId: nullable(id), before: nullable(id) }),
  readRun: object({ ...versionFields, runId: id, after: integer(0, PROJECT_READ_LIMITS.events) }),
  answerQuestion: object({ ...versionFields, runId: id, questionId: id, answer: text(PROJECT_READ_LIMITS.answerBytes) }),
  stopRun: object({ ...versionFields, runId: id }),
  resolveCitation: object({ ...versionFields, runId: id, citationId: id }),
  checkCitation: object({ ...versionFields, runId: id, citationId: id }),
  browseProject: refine(object({ ...versionFields, projectId: id, bindingId: id, ...listingArgs }), refreshValid),
  cancelInspection: object({ ...versionFields, projectId: id }),
  getTaskCapacity: object({ ...versionFields, projectId: nullable(id) }),
  getWslResultsBinding: object({ ...versionFields, projectId: id }),
  selectWslResultsBinding: object({ ...versionFields, projectId: id, selection: v => parseWslResultsSelection(v) ?? bad() }),
  clearWslResultsBinding: object({ ...versionFields, projectId: id, expectedBindingId: id }),
  resolveWslResultsCitation: object({ ...versionFields, runId: id, citationId: id }),
  checkWslResultsCitation: object({ ...versionFields, runId: id, citationId: id }),
  resolveWaveformCitation: object({ ...versionFields, runId: id, citationId: id }),
  checkWaveformCitation: object({ ...versionFields, runId: id, citationId: id }),
  deleteRun: withOptional({ ...versionFields, runId: id, expectedEventCount: integer(1, PROJECT_READ_LIMITS.events) }, { expectedCapacityVersion: digest }),
};
const capacityBytes = { taskBytes: count, logBytes: count, workspaceBytes: count, totalBytes: count };
const correctCapacityTotal = (v: { taskBytes: number; logBytes: number; workspaceBytes: number; totalBytes: number }): boolean =>
  v.totalBytes === v.taskBytes + v.logBytes + v.workspaceBytes;
const capacityEntry = refine(object({ ...capacityBytes, runId: id, projectId: id,
  expectedEventCount: integer(1, PROJECT_READ_LIMITS.events), capacityVersion: digest, complete: bool, canDelete: bool,
  blockedReason: nullable(choices('active', 'cleanup_unconfirmed', 'referenced', 'storage_unknown', 'storage_changed')),
  dependentRunIds: refine(array(id, PROJECT_READ_LIMITS.runs - 1), v => unique(v, x => x)),
  deletionState: choices('none', 'pending', 'failed'),
}), v => correctCapacityTotal(v) && v.canDelete === (v.complete && v.blockedReason === null)
  && (!v.dependentRunIds.length || v.blockedReason === 'referenced' || v.blockedReason === 'active' || v.blockedReason === 'cleanup_unconfirmed'));
const taskCapacity = refine(object({ runs: array(capacityEntry, PROJECT_READ_LIMITS.runs), totals: refine(object(capacityBytes), correctCapacityTotal),
  complete: bool, measuredAt: timestamp, scope: literal('tool_tasks'), byteMeasure: literal('logical_file_bytes'),
}), v => unique(v.runs, r => r.runId) && v.complete === v.runs.every(r => r.complete)
  && (['taskBytes','logBytes','workspaceBytes','totalBytes'] as const).every(k => v.totals[k] === v.runs.reduce((n, r) => n + r[k], 0)));
const readPage = refine(withOptional({
  run: summary, events: array(event, PROJECT_READ_LIMITS.eventPage), nextAfter: integer(0, PROJECT_READ_LIMITS.events), hasMore: bool,
},{workPreparation:value=>{const e=event(value);return e.type==='work.prepared'?e:bad();}}), v => {
  const p=v.workPreparation;
  if(p&&(!v.run.origin||v.run.project.bindingId===null||p.runId!==v.run.runId||p.sequence<2||p.sequence>v.run.eventCount||p.time<v.run.createdAt||p.time>v.run.updatedAt||JSON.stringify(p.data.workCycle)!==JSON.stringify(v.run.workCycle)||p.data.continuedFrom!==v.run.continuedFrom))return false;
  if (v.nextAfter > v.run.eventCount || v.hasMore !== (v.nextAfter < v.run.eventCount) || (!v.events.length && v.hasMore)) return false;
  let terminal = false;
  for (let i = 0; i < v.events.length; i++) {
    const e = v.events[i]!;
    if (e.runId !== v.run.runId || e.sequence !== v.nextAfter - v.events.length + i + 1 || e.time < v.run.createdAt || e.time > v.run.updatedAt || (i > 0 && e.time < v.events[i - 1]!.time)) return false;
    if (terminal && e.type !== 'cleanup.completed') return false;
    if (e.type === 'run.accepted' && (e.time !== v.run.createdAt || e.data.project.projectId !== v.run.project.projectId || e.data.project.bindingId !== v.run.project.bindingId || e.data.project.identity !== v.run.project.identity || (p?e.data.continuedFrom!==null||e.data.workCycle!==undefined:e.data.continuedFrom!==v.run.continuedFrom||JSON.stringify(e.data.workCycle)!==JSON.stringify(v.run.workCycle)))) return false;
    if(e.type==='work.prepared'&&(!p||JSON.stringify(e)!==JSON.stringify(p)))return false;
    if(p&&e.type==='tool.started'&&(isWorkCycleToolName(e.data.toolName)||isCommandToolName(e.data.toolName)&&e.data.toolName!=='command_status'&&e.data.toolName!=='command_log')&&e.sequence<p.sequence)return false;
    if (['run.completed','run.failed','run.stopped','run.interrupted'].includes(e.type)) {
      if (e.type.slice(4) !== v.run.status) return false;
      terminal = true;
    }
  }
  return true;
});
const valueParsers: { readonly [K in C.ProjectReadMethod]: Parse<C.ProjectReadValues[K]> } = {
  inspectCommandEnvironment:commandEnvironment,
  listCommandExecutions:refine(object({executions:array(commandExecution,CMD.executions)}),v=>unique(v.executions,e=>e.executionId)&&unique(v.executions,e=>e.requestId)),
  readCommandExecution:object({execution:commandExecution}),
  readCommandDiagnostics:object({diagnostics:(value:unknown)=>isCommandDiagnosticReadResult(value)?structuredClone(value):bad()}),
  openCommandDiagnostics:object({opened:bool}),
  readCommandLog:object({page:commandPage}),
  stopCommandExecution:object({execution:commandExecution}),
  getStatus: status, revalidateProject: status,
  selectModel: object({ model }),
  startRun: object({ runId: id }), startWorkRun: object({ runId: id }),
  prepareWorkContinuation: refine(object({ baseline: workContinuationRef, fileCount: integer(0, W.files), bytes: integer(0, W.workspaceBytes) }), v => v.bytes <= v.fileCount * W.fileBytes),
  listWorkFiles: object({ files: workFiles }), readWorkFile: workContent, readWorkChange: workChange,
  listRuns: refine(object({ runs: array(summary, PROJECT_READ_LIMITS.runs), nextBefore: nullable(id) }), v => unique(v.runs, r => r.runId) && unique(v.runs, r => r.clientRequestId) && (v.nextBefore === null || v.runs.length > 0)),
  readRun: readPage,
  answerQuestion: object({ accepted: literal(true) }), stopRun: object({ accepted: literal(true) }), cancelInspection: object({ accepted: literal(true) }),
  resolveCitation: citation,
  checkCitation: refine(object({ citationId: id, state: choices('current','changed','unavailable'), reason: nullable(code) }), v => v.state === 'current' ? v.reason === null : v.reason !== null),
  browseProject: refine(object({ snapshotId: id, coverage, entries }), v => v.coverage.returned === v.entries.length),
  deleteRun: object({ deleted: literal(true) }),
  getTaskCapacity: taskCapacity,
  getWslResultsBinding: object({ binding: nullable(v => parseWslResultsBinding(v) ?? bad()) }),
  selectWslResultsBinding: object({ binding: v => parseWslResultsBinding(v) ?? bad() }),
  clearWslResultsBinding: object({ binding: v => v === null ? null : bad() }),
  resolveWslResultsCitation: v => { const result = parseWslResultsToolValue(v); return result?.kind === 'wsl_results_read' ? result : bad(); },
  checkWslResultsCitation: refine(object({ citationId: id, state: choices('current','changed','unavailable'), reason: nullable(code) }), v => v.state === 'current' ? v.reason === null : v.reason !== null),
  resolveWaveformCitation: v => { const result = parseWaveformResultsToolValue(v); return result?.kind === 'wsl_waveform_read' || result?.kind === 'wsl_waveform_metrics' ? result : bad(); },
  checkWaveformCitation: refine(object({ citationId: id, state: choices('current','changed','unavailable'), reason: nullable(code) }), v => v.state === 'current' ? v.reason === null : v.reason !== null),
};
function failure(input: unknown, method: C.ProjectReadMethod): C.ProjectReadFailure {
  if (ownTag(ownTag(input, 'error'), 'code') === 'RUN_HAS_DEPENDENTS') {
    if (method !== 'deleteRun') bad();
    return object({ ok: literal(false), error: object({ code: literal('RUN_HAS_DEPENDENTS'), dependentRunIds: refine(array(id, PROJECT_READ_LIMITS.runs - 1, 1), v => unique(v, x => x)) }) })(input);
  }
  return object({ ok: literal(false), error: object({ code: refine(code, v => v !== 'RUN_HAS_DEPENDENTS') as Parse<Exclude<C.ProjectReadCode, 'RUN_HAS_DEPENDENTS'>> }) })(input);
}
const methodKnown = (method: unknown): method is C.ProjectReadMethod => typeof method === 'string' && (PROJECT_READ_METHODS as readonly string[]).includes(method) && Object.hasOwn(requestParsers, method) && Object.hasOwn(valueParsers, method);
const responseLimit = (method: C.ProjectReadMethod): number => method === 'readWorkChange' ? W.inspectorBytes : method === 'browseProject' ? PROJECT_READ_LIMITS.toolResultBytes : method === 'listRuns' ? PROJECT_READ_LIMITS.runBytes : PROJECT_READ_LIMITS.eventPageBytes;

export function parseProjectReadRequest<M extends C.ProjectReadMethod>(method: M, value: unknown): C.ProjectReadRequests[M] | null {
  return methodKnown(method) ? safe(budgeted(requestParsers[method], PROJECT_READ_LIMITS.requestBytes), value) : null;
}
/** Parses the payload. Use parseProjectReadResult to validate the complete IPC envelope and its cost. */
export function parseProjectReadValue<M extends C.ProjectReadMethod>(method: M, value: unknown): C.ProjectReadValues[M] | null {
  return methodKnown(method) ? safe(budgeted(valueParsers[method], responseLimit(method)), value) : null;
}
export function parseProjectReadResult<M extends C.ProjectReadMethod>(method: M, value: unknown): C.ProjectReadResult<C.ProjectReadValues[M]> | null {
  if (!methodKnown(method)) return null;
  return safe(budgeted(input => ownTag(input, 'ok') === true
    ? object({ ok: literal(true), value: valueParsers[method] })(input)
    : failure(input, method), responseLimit(method)), value);
}
export function parseProjectReadEvent(value: unknown): C.ProjectReadEvent | null { return safe(event, value); }
export function parseProjectReadToolResult(value: unknown): C.ProjectReadToolResult | null { return safe(toolResult, value); }
export function parseProjectReadToolArguments<M extends C.ProjectReadToolName>(method: M, value: unknown): C.ProjectReadToolArguments[M] | null {
  return typeof method === 'string' && Object.hasOwn(argumentParsers, method) ? safe(budgeted(argumentParsers[method], PROJECT_READ_LIMITS.requestBytes), value) : null;
}
