import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PROJECT_READ_LIMITS as L, type ProjectReadCitation, type ProjectReadCitationPreview, type ProjectReadCoverage, type ProjectReadPosition, type ProjectReadRef, type ProjectReadResumePoint, type ProjectReadRule, type ProjectReadScope, type ProjectReadToolArguments, type ProjectReadToolCall, type ProjectReadToolResult, type ProjectReadToolValue } from '../../shared/agent/agent-project-read';
import { parseProjectReadToolArguments, parseProjectReadToolResult } from '../../shared/agent/agent-project-read-validation';
import { pageProjectText, projectTextRangeBytes, searchProjectText, ProjectTextError } from '../../../../../packages/agent-adapters/src/project-read-text';
import { executePilotSum } from '../engine-pilot/tool';
import type { FolderRoot } from './project-folder-files';
import { createProjectReadOperation, createProjectTextReader, ProjectReadFsError, type ProjectReadFile, type ProjectReadIoBudget, type ProjectReadOperation, type ProjectReadTextSnapshot } from './project-read-files';
import { ProjectReadIndexError, type ProjectReadCandidates, type ProjectReadIndex } from './project-read-index';
import { createProjectReadRules, projectReadRuleChunk } from './project-read-rules';
import { WORK_CYCLE_LIMITS as W, type WorkCycleImportSource } from '../../shared/agent/agent-work-cycle';
import { createProjectReadSkills, type SkillReadBinding } from './project-read-skills';
import type { AgentSkillDescriptor } from '../../shared/agent/agent-skills';
import {isFileSystemToolName,type FileSystemSourceRef,type FileSystemNextArguments} from '../../shared/agent/agent-filesystem-read';
import path from 'node:path';
import {captureFilesystemRoot,inspectFilesystemPath,resolveFilesystemPath,type FileSystemReadRoot} from './filesystem-read-sources';
import {createProjectReadIndex} from './project-read-index';
import type {ProjectReadRoot} from './project-read-files';

type ContentName = 'project_read' | 'project_search';
type ContentValue = Extract<ProjectReadToolValue, { kind: 'read' | 'search' }>;
type State = {
  name: ContentName; snapshotId: string; scope: ProjectReadScope;
  fileId: string | null; file: ProjectReadFile | null; version: string | null; next: ProjectReadPosition;
  query: string | null; candidates: ProjectReadCandidates | null; complete: boolean;
  scannedFiles: number; scannedBytes: number; skippedUnsupported: number; skippedUnavailable: number;
  restored?: boolean;
  skill?: SkillReadBinding;
  skillCall?: Extract<ProjectReadToolCall, { toolName: 'skill_load' | 'skill_read_reference' }>['arguments'];
  singleFileId?:string;
};
type Cursor = { state: State; arguments: ProjectReadToolArguments[ContentName]; toolName?: ProjectReadToolCall['toolName']; skillArguments?: State['skillCall'] };
export type ProjectReadPublication = Readonly<{ call: ProjectReadToolCall; result: ProjectReadToolResult; citations: readonly ProjectReadCitation[]; locators: readonly Readonly<{ citationId: string; file: ProjectReadFile }>[]; reserveBytes?: number }>;
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);
const signatureOf = (call: ProjectReadToolCall): string => JSON.stringify({ sessionId: call.sessionId, messageId: call.messageId, callId: call.callId, toolName: call.toolName, arguments: parseProjectReadToolArguments(call.toolName, call.arguments) });
const fail = (code: ConstructorParameters<typeof ProjectReadFsError>[0]): never => { throw new ProjectReadFsError(code); };
const success = (value: ProjectReadToolValue): ProjectReadToolResult => ({ ok: true, value });
const id = (): string => 'prb-' + randomUUID();
function filesystemListingResult(source:FileSystemSourceRef,call:ProjectReadToolCall,value:Extract<ProjectReadToolValue,{kind:'list'|'find'}>):ProjectReadToolResult{
  if(call.toolName!=='fs_list'&&call.toolName!=='fs_find')return fail('INVALID_REQUEST');
  const cursor=value.coverage.nextCursor,args={path:null,directoryId:value.coverage.scope.directoryId,cursor,refresh:false};
  const nextArguments:FileSystemNextArguments|null=cursor?(call.toolName==='fs_find'?{toolName:'fs_find',arguments:{...args,query:call.arguments.query}}:{toolName:'fs_list',arguments:args}):null;
  return {ok:true,value:{...value,source,nextArguments}};
}
const originPosition = (): ProjectReadPosition => Object.freeze({ line: 1, column: 1 });
const preview = (c: ProjectReadCitation): ProjectReadCitationPreview => Object.freeze({ citationId: c.citationId, fileId: c.fileId, relativePath: c.relativePath, version: c.version, normalizedSha256: c.normalizedSha256, range: c.range, excerpt: c.excerpt, excerptSha256: c.excerptSha256, totalLines: c.totalLines, fileBytes: c.fileBytes, source: c.source,...(c.location?{location:c.location}:{}) });
export type ProjectReadSharedQuota={toolAttempts:number;toolBytes:number;citations:number;readonly maxToolAttempts?:number|null};

/** One run, one serialized tool lane. Persistence and final escaped request reservations are supplied by the host/gateway. */
export function createProjectReadBroker(options: Readonly<{
  root: ProjectReadRoot; project: ProjectReadRef; runId: string; signal: AbortSignal; budget: ProjectReadIoBudget; index: ProjectReadIndex;
  source?:FileSystemSourceRef;quota?:ProjectReadSharedQuota;
  authorize: (call: ProjectReadToolCall) => boolean;
  publishRule: (rule: ProjectReadRule) => Promise<void>;
  installRootRule: (rule: ProjectReadRule) => Promise<void>;
  canDeliver: (publication: ProjectReadPublication) => boolean;
  publish: (publication: ProjectReadPublication) => Promise<void>;
}>) {
  const rules = createProjectReadRules({ root: options.root, signal: options.signal, budget: options.budget, publish: options.publishRule,...(options.source?{source:options.source}:{}) });
  const skills = options.source?null:createProjectReadSkills(options.index, {...options,root:options.root as FolderRoot});
  const quota=options.quota??{toolAttempts:0,toolBytes:0,citations:0};
  const maxToolAttempts=quota.maxToolAttempts===undefined?L.toolCalls:quota.maxToolAttempts;
  if(maxToolAttempts!==null&&(!Number.isSafeInteger(maxToolAttempts)||maxToolAttempts<1||maxToolAttempts>L.toolCalls))fail('INVALID_REQUEST');
  const normalizedCalls=new Map<string,ProjectReadToolCall>();
  type Discovery = { snapshotId: string; directoryId: string | null; entries: readonly AgentSkillDescriptor[]; coverage: ProjectReadCoverage; indexCursor: string | null; metadataReadBytes: number };
  const discoveryCursors = new Map<string, Discovery>();
  const deliveredRules = new Map<string, { offset: number; complete: boolean }>();
  const ledger = new Map<string, { signature: string; result: ProjectReadToolResult }>();
  const inFlight = new Map<string, { signature: string; promise: Promise<ProjectReadToolResult> }>();
  const evidenceLocators = new Map<string, ProjectReadFile>();
  const cursors = new Map<string, Cursor>(), states = new Set<State>();
  let busy = false, closed = false, prepared = false, toolAttempts = 0, sums = 0, citations = 0, toolBytes = 0;
  let slot: { state: State; reader: ReturnType<typeof createProjectTextReader>; value: ProjectReadTextSnapshot | null } | null = null;
  const alive = (): void => { if (closed || options.signal.aborted) fail('CANCELLED'); };
  const checkScope = (state: State): void => { alive(); if (state.snapshotId !== options.index.snapshotId()) fail('CURSOR_STALE'); };
  const decorate=(call:ProjectReadToolCall,result:ProjectReadToolResult):ProjectReadToolResult=>{
    if(!options.source||!result.ok||!['list','find','search','read'].includes(result.value.kind))return result;
    if(result.value.kind==='list'||result.value.kind==='find')return filesystemListingResult(options.source,call,result.value);
    const value=result.value as Extract<ProjectReadToolValue,{kind:'list'|'find'|'search'|'read'}>, normalized=normalizedCalls.get(call.callId);
    let nextArguments:FileSystemNextArguments|null=null;const cursor=value.coverage.nextCursor;
    if(cursor&&normalized){
      if(call.toolName==='fs_read'&&normalized.toolName==='project_read')nextArguments={toolName:'fs_read',arguments:{path:null,fileId:normalized.arguments.fileId,version:value.kind==='read'?(value.citation?.version??value.resume?.version??normalized.arguments.version):null,start:value.kind==='read'?(value.next??normalized.arguments.start):{line:1,column:1},cursor}};
      else if(call.toolName==='fs_search'&&normalized.toolName==='project_search')nextArguments={toolName:'fs_search',arguments:{path:null,directoryId:value.coverage.scope.directoryId,fileId:(normalized.arguments as typeof normalized.arguments&{fileId?:string}).fileId??null,query:normalized.arguments.query,cursor,refresh:false}};
      else if(call.toolName==='fs_find'&&normalized.toolName==='project_find')nextArguments={toolName:'fs_find',arguments:{path:null,directoryId:value.coverage.scope.directoryId,query:normalized.arguments.query,cursor,refresh:false}};
      else if(call.toolName==='fs_list'&&normalized.toolName==='project_list')nextArguments={toolName:'fs_list',arguments:{path:null,directoryId:value.coverage.scope.directoryId,cursor,refresh:false}};
    }
    return {ok:true,value:{...value,source:options.source,nextArguments}};
  };
  const fits = (call: ProjectReadToolCall, raw: ProjectReadToolResult, evidence: readonly ProjectReadCitation[]): boolean => {
    const result=decorate(call,raw);return bytes(result) <= L.toolResultBytes && quota.toolBytes + bytes(result) <= (maxToolAttempts===null?L.runBytes:L.toolContextBytes) && quota.citations + evidence.length <= L.citations && options.canDeliver({ call, result, citations: evidence, locators: [] });
  };
  const closeSlot = async (): Promise<void> => { const old = slot; slot = null; if (old) await old.reader.close(); };
  const closeState = async (state: State): Promise<void> => {
    if (slot?.state === state) await closeSlot(); await state.candidates?.close(); states.delete(state);
    for (const [cursor, item] of cursors) if (item.state === state) cursors.delete(cursor);
  };
  const coverage = (state: State, returned: number, nextCursor: string | null, reason: ProjectReadCoverage['limitReason']): ProjectReadCoverage => {
    const indexed = state.candidates?.coverage();
    const partialRestart = state.restored && state.complete;
    return Object.freeze({ scope: state.scope, complete: state.complete && !partialRestart, scannedCandidates: indexed?.scannedCandidates ?? 1,
      scannedFiles: state.scannedFiles, scannedBytes: state.scannedBytes, returned,
      skipped: Object.freeze({ policy: indexed?.skipped.policy ?? 0, unsupported: (indexed?.skipped.unsupported ?? 0) + state.skippedUnsupported, fileLimit: indexed?.skipped.fileLimit ?? 0, unavailable: (indexed?.skipped.unavailable ?? 0) + state.skippedUnavailable }),
      remaining: Object.freeze({ directories: partialRestart ? null : state.complete ? 0 : indexed?.remaining.directories ?? 0, files: partialRestart ? null : state.complete ? 0 : state.name === 'project_read' ? 1 : null, position: state.complete || !state.file ? null : state.next }),
      nextCursor, limitReason: partialRestart ? 'scope' : state.complete ? null : reason });
  };
  const resume = (state: State): ProjectReadResumePoint | null => state.file && state.version && !state.complete
    ? Object.freeze({ toolName: state.name, relativePath: state.file.relativePath, version: state.version, next: state.next, query: state.query, relativeDirectory: state.singleFileId?state.file.relativePath.split('/').slice(0,-1).join('/'):state.scope.relativeDirectory }) : null;
  const value = (state: State, phase: 'rules' | 'scan' | 'data', cursor: string | null, reason: ProjectReadCoverage['limitReason'], extra: Partial<ContentValue> = {}): ContentValue => {
    const base = { phase, snapshotId: state.snapshotId, coverage: coverage(state, 0, cursor, reason), rules: [], resume: state.skill ? null : resume(state) };
    return state.name === 'project_read'
      ? { ...base, kind: 'read', citation: null, empty: false, next: state.complete ? null : state.next, ...extra,
        ...(state.skill ? { skill: skills!.source(state.skill, state.file!, state.version, phase === 'data' && state.complete) } : {}) } as ContentValue
      : { ...base, kind: 'search', matches: [], ...extra } as ContentValue;
  };
  const continuationArgs = (state: State, cursor: string): ProjectReadToolArguments[ContentName] => state.name === 'project_read'
    ? { fileId: state.fileId!, version: state.version, start: state.next, cursor }
    : { directoryId: state.scope.directoryId, query: state.query!, cursor, refresh: false,...(state.singleFileId?{fileId:state.singleFileId}:{}) };
  const publish = async (call: ProjectReadToolCall, result: ProjectReadToolResult, evidence: readonly ProjectReadCitation[], commit: () => void = () => {}): Promise<ProjectReadToolResult> => {
    alive(); const parsed = parseProjectReadToolResult(decorate(call,result)); if (!parsed) return fail('ENGINE_FAILED');
    if (!fits(call, parsed, evidence)) return fail('BUDGET_EXCEEDED');
    const locators = evidence.map(item => { const file = evidenceLocators.get(item.citationId); if (!file) return fail('ENGINE_FAILED'); return Object.freeze({ citationId: item.citationId, file }); });
    try { await options.publish({ call, result: parsed, citations: evidence, locators }); } catch { return fail('STORAGE_FAILED'); }
    alive(); commit(); citations += evidence.length; toolBytes += bytes(parsed);quota.citations+=evidence.length;quota.toolBytes+=bytes(parsed);
    ledger.set(call.callId, { signature: signatureOf(call), result: parsed }); return parsed;
  };
  const publishContent = async (call: ProjectReadToolCall, state: State, result: ContentValue, evidence: readonly ProjectReadCitation[], cursor: string, commit: () => void = () => {}): Promise<ProjectReadToolResult> => {
    const complete = state.complete;
    const skillCommit = state.skill && complete && result.phase === 'data' && state.version ? skills!.prepareComplete(state.skill, state.version) : () => {};
    const output = await publish(call, success(result), evidence, () => {
      commit(); skillCommit(); if (!complete) cursors.set(cursor, { state, arguments: continuationArgs(state, cursor), toolName: call.toolName,
        ...(state.skillCall ? { skillArguments: { ...state.skillCall, version: state.version, start: state.next, cursor } } : {}) });
    });
    if (complete) await closeState(state); return output;
  };
  async function text(state: State, operation: ProjectReadOperation): Promise<ProjectReadTextSnapshot | null> {
    checkScope(state); if (!state.file || !state.fileId) return fail('ENGINE_FAILED');
    options.index.resolveFile(state.fileId);
    if (slot?.state !== state) {
      await closeSlot(); alive();
      slot = { state, reader: createProjectTextReader({ root: options.root, file: state.file, expectedVersion: state.version, signal: options.signal, budget: options.budget }), value: null };
    }
    if (!slot!.value) {
      const result = await slot!.reader.step(operation); alive();
      if (result.kind === 'pending') return null;
      if (result.value.workingBytes > L.textWorkingBytes) return fail('BUDGET_EXCEEDED');
      slot!.value = result.value; state.version = result.value.version;
    }
    return slot!.value;
  }
  function citation(state: State, source: ProjectReadTextSnapshot, range: ProjectReadCitation['range'], excerpt: string): ProjectReadCitation {
    const citationId = id(); evidenceLocators.set(citationId, source.file);
    return Object.freeze({ citationId, runId: options.runId, project: options.project, snapshotId: state.snapshotId, fileId: state.fileId!,
      fileIdentity: source.file.fileIdentity, relativePath: source.file.relativePath, version: source.version, normalizedSha256: source.normalizedSha256,
      range, excerpt, excerptSha256: hash(excerpt), totalLines: source.source.totalLines, fileBytes: source.file.size,
      source: state.name === 'project_read' ? 'read' : 'search', createdAt: new Date().toISOString(), origin: null,...(options.source?{location:{...options.source,absolutePath:source.file.absolutePath}}:{}) });
  }
  async function rulePage(call: ProjectReadToolCall, state: State, operation: ProjectReadOperation, cursor: string): Promise<ProjectReadToolResult | null> {
    const applicable = await rules.forFile(state.file!, operation); alive();
    for (const item of applicable) {
      if (item.rule.state === 'absent') continue;
      const previous = deliveredRules.get(item.ruleId); if (previous?.complete) continue;
      const chunk = projectReadRuleChunk({ ruleId: item.ruleId, rule: item.rule, offsetBytes: previous?.offset ?? 0,
        fits: part => fits(call, success(value(state, 'rules', cursor, 'rules', { rules: [part] })), []) });
      return publishContent(call, state, value(state, 'rules', cursor, 'rules', { rules: [chunk] }), [], cursor,
        () => { deliveredRules.set(item.ruleId, { offset: chunk.endBytes, complete: chunk.complete }); });
    }
    return null;
  }
  async function newState(call: Extract<ProjectReadToolCall, { toolName: ContentName }>, original: ProjectReadToolCall = call, skill?: SkillReadBinding): Promise<State> {
    const args = call.arguments;
    if (args.cursor !== null) {
      const saved = cursors.get(args.cursor);
      if (!saved || saved.state.name !== call.toolName || !same(saved.arguments, args) || (saved.toolName ?? saved.state.name) !== original.toolName
        || (skill && !same(saved.skillArguments, original.arguments))) return fail('CURSOR_STALE');
      checkScope(saved.state); cursors.delete(args.cursor); return saved.state;
    }
    let state: State;
    const common = { complete: false, scannedFiles: 0, scannedBytes: 0, skippedUnsupported: 0, skippedUnavailable: 0 };
    if (call.toolName === 'project_read') {
      const a = call.arguments, file = options.index.resolveFile(a.fileId);
      const scope: ProjectReadScope = options.index.scope(null);
      state = { ...common, name: call.toolName, snapshotId: options.index.snapshotId(), scope, fileId: a.fileId, file, version: a.version, next: a.start, query: null, candidates: null };
    } else {
      const a = call.arguments as typeof call.arguments&{fileId?:string}, candidates = await options.index.candidates({ directoryId: a.directoryId, query: a.query, refresh: a.refresh,...(a.fileId?{fileId:a.fileId}:{}) });
      state = { ...common, name: call.toolName, snapshotId: candidates.snapshotId, scope: candidates.scope, fileId: null, file: null, version: null, next: originPosition(), query: a.query, candidates,...(a.fileId?{singleFileId:a.fileId}:{}) };
    }
    if (skill) { state.skill = skill; state.skillCall = original.arguments as NonNullable<State['skillCall']>; }
    states.add(state); return state;
  }
  async function read(call: ProjectReadToolCall, state: State, operation: ProjectReadOperation): Promise<ProjectReadToolResult> {
    const cursor = id();
    const ruleResult = await rulePage(call, state, operation, cursor); if (ruleResult) return ruleResult;
    const source = await text(state, operation);
    if (!source) return publishContent(call, state, value(state, 'scan', cursor, 'slice'), [], cursor);
    if (quota.citations >= L.citations) return fail('BUDGET_EXCEEDED');
    for (let maxBytes: number = L.readPageBytes;; maxBytes = Math.max(4, Math.floor(maxBytes / 2))) {
      const page = pageProjectText(source.source, state.next, { maxBytes, maxLines: L.readPageLines });
      const evidence = page.text ? [citation(state, source, page.range, page.text)] : [];
      const oldNext = state.next, oldBytes = state.scannedBytes, oldFiles = state.scannedFiles;
      state.next = page.next ?? page.range.end; state.complete = page.complete; state.scannedBytes += page.bytes; if (page.complete) state.scannedFiles++;
      const result = value(state, 'data', page.complete ? null : cursor, 'page', { citation: evidence[0] ? preview(evidence[0]) : null, empty: !page.text, next: page.next,
        coverage: coverage(state, evidence.length, page.complete ? null : cursor, 'page') });
      if (fits(call, success(result), evidence)) return publishContent(call, state, result, evidence, cursor);
      state.next = oldNext; state.complete = false; state.scannedBytes = oldBytes; state.scannedFiles = oldFiles;
      if (maxBytes <= 4) return fail('BUDGET_EXCEEDED');
    }
  }
  async function search(call: ProjectReadToolCall, state: State, operation: ProjectReadOperation): Promise<ProjectReadToolResult> {
    const cursor = id(), evidence: ProjectReadCitation[] = [], matches: Extract<ContentValue, { kind: 'search' }>['matches'][number][] = [];
    let reason: ProjectReadCoverage['limitReason'] = 'slice', examined = 0;
    const result = (): ContentValue => value(state, matches.length || state.complete ? 'data' : 'scan', state.complete ? null : cursor, reason, { matches: [...matches], coverage: coverage(state, matches.length, state.complete ? null : cursor, reason) });
    for (;;) {
      alive(); checkScope(state);
      if (operation.remaining() <= 0 || examined >= L.operationCandidates) break;
      if (!state.file) {
        const next = await state.candidates!.next(); alive();
        if (options.index.accounting().visitedCandidates > L.runCandidates) return fail('BUDGET_EXCEEDED');
        if (next.kind !== 'entry') { if (next.kind === 'complete') state.complete = next.coverage.complete; break; }
        examined++; if (next.entry.kind !== 'file' || next.entry.readability !== 'readable') continue;
        state.fileId = next.entry.fileId; state.file = options.index.resolveFile(state.fileId!); state.next = originPosition(); state.version = null;
      }
      // Do not mix a preceding file's data with a newly required rule page.
      if (matches.length) break;
      const ruleResult = await rulePage(call, state, operation, cursor); if (ruleResult) return ruleResult;
      let source: ProjectReadTextSnapshot | null;
      try { source = await text(state, operation); }
      catch (error) {
        if (error instanceof ProjectReadFsError && ['UNSUPPORTED_TEXT', 'UNSUPPORTED_ENCODING', 'FILE_LIMIT', 'FILE_UNAVAILABLE'].includes(error.code)) {
          if (error.code === 'FILE_UNAVAILABLE') state.skippedUnavailable++; else state.skippedUnsupported++;
          await closeSlot(); state.file = null; state.fileId = null; continue;
        } throw error;
      }
      if (!source) break;
      while (operation.remaining() > 0) {
        if (quota.citations + evidence.length >= L.citations) { if (!evidence.length) return fail('BUDGET_EXCEEDED'); reason = 'citations'; break; }
        const start = state.next;
        const found = searchProjectText(source.source, state.query!, start, { maxMatches: 1, maxLines: 2000, contextPoints: 64 });
        const match = found.matches[0], c = match ? citation(state, source, match.excerptRange, match.excerpt) : null;
        const item = match && c ? { fileId: state.fileId!, relativePath: state.file!.relativePath, version: source.version, match: match.range, citation: preview(c) } : null;
        const advanceBytes = projectTextRangeBytes(source.source, start, found.next);
        const oldBytes = state.scannedBytes, oldFiles = state.scannedFiles;
        state.scannedBytes += advanceBytes; state.next = found.next ?? start; if (found.complete) state.scannedFiles++;
        if (item && c) { matches.push(item); evidence.push(c); }
        if (!fits(call, success(result()), evidence)) {
          if (item) { matches.pop(); evidence.pop(); } state.next = start; state.scannedBytes = oldBytes; state.scannedFiles = oldFiles; reason = 'bytes';
          if (!matches.length) return fail('BUDGET_EXCEEDED'); break;
        }
        if (found.complete) { await closeSlot(); state.file = null; state.fileId = null; state.version = null; break; }
        if (matches.length >= L.searchMatches) { reason = 'page'; break; }
        if (quota.citations + evidence.length >= L.citations) { reason = 'citations'; break; }
        await new Promise<void>(resolve => setImmediate(resolve)); alive();
      }
      if (matches.length || state.file) break;
    }
    return publishContent(call, state, result(), evidence, cursor);
  }
  async function discover(call: Extract<ProjectReadToolCall, { toolName: 'skill_discover' }>): Promise<ProjectReadToolResult> {
    const args = call.arguments;
    if (args.refresh && (args.directoryId !== null || args.cursor !== null)) return fail('INVALID_REQUEST');
    let page: Discovery | undefined;
    if (args.cursor !== null) {
      page = discoveryCursors.get(args.cursor);
      if (!page || page.directoryId !== args.directoryId || args.refresh || page.snapshotId !== options.index.snapshotId()) return fail('CURSOR_STALE');
      discoveryCursors.delete(args.cursor);
    }
    if (!page || !page.entries.length) {
      const listed = await options.index.find({ directoryId: args.directoryId, cursor: page?.indexCursor ?? null,
        refresh: page ? false : args.refresh, query: 'SKILL.md' });
      if (options.index.accounting().visitedCandidates > L.runCandidates) return fail('BUDGET_EXCEEDED');
      const entries: AgentSkillDescriptor[] = [], operation = createProjectReadOperation(options.signal);
      const before = options.budget.evidence().physicalReadBytes;
      for (const entry of listed.entries) {
        const descriptor = await skills!.describe(entry, operation); alive();
        if (descriptor) entries.push(descriptor);
      }
      page = { snapshotId: listed.snapshotId, directoryId: args.directoryId, entries, coverage: listed.coverage, indexCursor: listed.coverage.nextCursor,
        metadataReadBytes: (page?.metadataReadBytes ?? 0) + options.budget.evidence().physicalReadBytes - before };
    }
    const cursor = id(), found = page;
    const result = (length: number): ProjectReadToolResult => {
      const more = length < found.entries.length || found.indexCursor !== null;
      return success({ kind: 'skills', sourceKind: 'selected_project', phase: found.coverage.scannedCandidates ? 'data' : 'scan',
        snapshotId: found.snapshotId, entries: found.entries.slice(0,length), rules: [], resume: null,
        coverage: { ...found.coverage, scannedBytes: found.metadataReadBytes, returned: length, complete: !more && found.coverage.complete,
          nextCursor: more ? cursor : null, limitReason: length < found.entries.length ? 'bytes' : found.coverage.limitReason } });
    };
    let length = found.entries.length;
    while (length > 0 && !fits(call, result(length), [])) length--;
    if (found.entries.length && !length) return fail('BUDGET_EXCEEDED');
    const commit = skills!.prepareDiscovery(found.entries.slice(0,length));
    return publish(call, result(length), [], () => {
      commit(); if (length < found.entries.length || found.indexCursor !== null) discoveryCursors.set(cursor, { ...found, entries: found.entries.slice(length) });
    });
  }
  async function executeOnce(call: ProjectReadToolCall): Promise<ProjectReadToolResult> {
    alive(); if (!prepared || !options.authorize(call)) return fail('CAPABILITY_DENIED');
    const signature = signatureOf(call), previous = ledger.get(call.callId);
    if (previous) { if (previous.signature !== signature) return fail('CONFLICT'); return previous.result; }
    if (busy) return fail('BUSY'); if (maxToolAttempts!==null && quota.toolAttempts >= maxToolAttempts || !Number.isSafeInteger(quota.toolAttempts+1)) return fail('BUDGET_EXCEEDED');
    if (!parseProjectReadToolArguments(call.toolName, call.arguments)) return fail('INVALID_REQUEST');
    busy = true; toolAttempts++;quota.toolAttempts++; let state: State | null = null;
    try {
      if(isFileSystemToolName(call.toolName)){
        if(!options.source)return fail('CAPABILITY_DENIED');const normalized=normalizedCalls.get(call.callId);if(!normalized)return fail('INVALID_REQUEST');
        if(normalized.toolName==='project_list'||normalized.toolName==='project_find'){
          const page=normalized.toolName==='project_list'?await options.index.list(normalized.arguments):await options.index.find(normalized.arguments);
          return await publish(call,success(page),[]);
        }
        if(normalized.toolName!=='project_read'&&normalized.toolName!=='project_search')return fail('INVALID_REQUEST');
        state=await newState(normalized,call);const operation=createProjectReadOperation(options.signal);
        return normalized.toolName==='project_read'?await read(call,state,operation):await search(call,state,operation);
      }
      if(options.source)return fail('CAPABILITY_DENIED');
      if (call.toolName === 'work_list' || call.toolName === 'work_read' || call.toolName === 'work_write' || call.toolName === 'work_edit' || call.toolName === 'work_import' || call.toolName === 'work_run' || call.toolName === 'command_environment' || call.toolName === 'command_start' || call.toolName === 'command_status' || call.toolName === 'command_log' || call.toolName === 'command_stop') return fail('CAPABILITY_DENIED');
      if (call.toolName === 'project_list' || call.toolName === 'project_find' || call.toolName === 'project_search') {
        const args = call.arguments;
        if (args.refresh && (args.directoryId !== null || args.cursor !== null)) return fail('INVALID_REQUEST');
      }
      if (call.toolName === 'pilot_sum') { if (maxToolAttempts!==null && sums >= L.sums) return fail('BUDGET_EXCEEDED'); sums++; return await publish(call, success({ kind: 'sum', ...executePilotSum(call.arguments) }), []); }
      if (call.toolName === 'skill_discover') return await discover(call);
      if (call.toolName === 'skill_load' || call.toolName === 'skill_read_reference') {
        const skill = skills!.bind(call), a = call.arguments;
        const normalized: Extract<ProjectReadToolCall, { toolName: 'project_read' }> = { ...call, toolName: 'project_read',
          arguments: { fileId: call.toolName === 'skill_load' ? call.arguments.skillId : call.arguments.fileId, version: a.version, start: a.start, cursor: a.cursor } };
        state = await newState(normalized, call, skill);
        return await read(call, state, createProjectReadOperation(options.signal));
      }
      if (call.toolName === 'project_list' || call.toolName === 'project_find') {
        const page = call.toolName === 'project_list' ? await options.index.list(call.arguments) : await options.index.find(call.arguments);
        if (options.index.accounting().visitedCandidates > L.runCandidates) return fail('BUDGET_EXCEEDED');
        return await publish(call, success(page), []);
      }
      if (call.toolName !== 'project_read' && call.toolName !== 'project_search') return fail('CAPABILITY_DENIED');
      state = await newState(call); const operation = createProjectReadOperation(options.signal);
      return call.toolName === 'project_read' ? await read(call, state, operation) : await search(call, state, operation);
    } catch (error) {
      if (state) await closeState(state);
      alive();
      const code = error instanceof ProjectReadFsError || error instanceof ProjectTextError ? error.code : 'IO_ERROR';
      if (['STORAGE_FAILED', 'CANCELLED', 'CLEANUP_FAILED'].includes(code)) throw error;
      const result: ProjectReadToolResult = { ok: false, error: { code,...(error instanceof ProjectReadFsError&&error.osCode?{osCode:error.osCode}:{}) }, coverage: error instanceof ProjectReadIndexError ? error.coverage : null };
      return await publish(call, result, []);
    } finally { evidenceLocators.clear(); busy = false; }
  }
  function execute(call: ProjectReadToolCall,normalized?:ProjectReadToolCall): Promise<ProjectReadToolResult> {
    const signature = signatureOf(call), pending = inFlight.get(call.callId);
    if (pending) return pending.signature === signature ? pending.promise : Promise.reject(new ProjectReadFsError('CONFLICT'));
    if(normalized){const prior=normalizedCalls.get(call.callId);if(prior&&!same(prior,normalized))return Promise.reject(new ProjectReadFsError('CONFLICT'));normalizedCalls.set(call.callId,normalized);}
    const promise = executeOnce(call); inFlight.set(call.callId, { signature, promise });
    void promise.finally(() => { inFlight.delete(call.callId); }).catch(() => {}); return promise;
  }
  let shutdown: Promise<void> | undefined;
  return Object.freeze({
    async importSource(fileId: string, version: string): Promise<Readonly<{ source: WorkCycleImportSource; bytes: Uint8Array }>> {
      if(options.source||options.project.bindingId===null)return fail('CAPABILITY_DENIED');
      alive(); if (!prepared || busy) return fail('BUSY');
      const file = options.index.resolveFile(fileId);
      if (file.size > W.fileBytes) return fail('FILE_LIMIT');
      const operation = createProjectReadOperation(options.signal), applicable = await rules.forFile(file, operation);
      // Scoped rules must already have been delivered through project_read before an input is used by a program.
      if (applicable.some(r => r.rule.state === 'loaded' && !deliveredRules.get(r.ruleId)?.complete)) return fail('RULES_UNAVAILABLE');
      const reader = createProjectTextReader({ root: options.root, file, expectedVersion: version, signal: options.signal, budget: options.budget, captureRaw: true });
      try {
        const result = await reader.step(operation); alive();
        if (result.kind !== 'complete' || !result.value.rawBytes) return fail('BUDGET_EXCEEDED');
        const bytes = result.value.rawBytes;
        // Preserve BOM/newlines exactly; UTF-16 and other encodings are outside C1's first input adapter.
        let decoded: string; try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail('UNSUPPORTED_ENCODING'); }
        if (!Buffer.from(decoded, 'utf8').equals(Buffer.from(bytes))) return fail('UNSUPPORTED_ENCODING');
        return { source: { projectId: options.project.projectId, bindingId: options.project.bindingId, identity: options.project.identity, fileId, relativePath: file.relativePath, version: result.value.version, bytes: bytes.byteLength }, bytes };
      } finally { await reader.close(); }
    },
    async prepare(): Promise<void> {
      alive(); if (prepared) return; if (busy) return fail('BUSY'); busy = true;
      try { const root = await rules.loadRoot(createProjectReadOperation(options.signal)); await options.installRootRule(root.rule); alive();
        if (!options.source&&root.rule.state === 'loaded') deliveredRules.set(root.ruleId, { offset: Buffer.byteLength(root.rule.text!), complete: true }); prepared = true;
      } finally { busy = false; }
    },
    execute,
    suspend:closeSlot,
    /** Called only after host has reserved the exact initial request containing these verified scoped rules/evidence. */
    acceptContinuationState(input: Readonly<{ citationCount: number; rules: readonly ProjectReadRule[] }>): void {
      alive(); if (!prepared || busy || toolAttempts !== 0 || !Number.isSafeInteger(input.citationCount) || input.citationCount < 0 || input.citationCount > L.continuationCitations) return fail('INVALID_REQUEST');
      for (const expected of input.rules) { const saved = rules.confirmed(expected.source); if (!saved || !same(saved.rule, expected)) return fail('RULES_UNAVAILABLE'); }
      for (const expected of input.rules) { const saved = rules.confirmed(expected.source)!; if (expected.state === 'loaded') deliveredRules.set(saved.ruleId, { offset: Buffer.byteLength(expected.text!), complete: true }); }
      citations = input.citationCount;quota.citations+=input.citationCount;
    },
    async verifyRules(expected: readonly ProjectReadRule[]): Promise<readonly ProjectReadRule[]> {
      alive(); if (!prepared || busy || expected.length > L.directories) return fail('BUSY'); busy = true;
      try {
        const output: ProjectReadRule[] = [];
        for (const prior of expected) {
          const current = await rules.forDirectory(prior.relativeDirectory, createProjectReadOperation(options.signal));
          if (!same(prior, current.rule)) return fail('SOURCE_CHANGED'); output.push(current.rule);
        }
        return Object.freeze(output);
      } finally { busy = false; }
    },
    /** Main-only continuation input, after host version/identity preflight. No old cursor is accepted. */
    restoreResume(point: ProjectReadResumePoint, fileId: string, directoryId: string | null): Readonly<{ toolName: ContentName; arguments: ProjectReadToolArguments[ContentName] }> {
      alive(); if (!prepared || busy) return fail('BUSY');
      const file = options.index.resolveFile(fileId), directory = options.index.resolveDirectory(directoryId);
      if (file.relativePath !== point.relativePath || directory.relativePath !== point.relativeDirectory) return fail('SOURCE_CHANGED');
      const cursor = id(), state: State = { name: point.toolName, snapshotId: options.index.snapshotId(), restored: point.toolName === 'project_search',
        scope: options.index.scope(directoryId),
        file, fileId, version: point.version, next: point.next, query: point.query, candidates: null,
        complete: false, scannedFiles: 0, scannedBytes: 0, skippedUnavailable: 0, skippedUnsupported: 0 };
      // A restored search covers only the remaining part of this verified file. Other directories restart separately.
      const restoredCoverage: ProjectReadCoverage = { scope: state.scope, complete: true, scannedCandidates: 1, scannedFiles: 0, scannedBytes: 0, returned: 0, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 0, position: null }, nextCursor: null, limitReason: null };
      if (point.toolName === 'project_search') state.candidates = { snapshotId: state.snapshotId, scope: state.scope, next: async () => ({ kind: 'complete', coverage: restoredCoverage }), coverage: () => restoredCoverage, close: async () => {} };
      states.add(state); const args = continuationArgs(state, cursor); cursors.set(cursor, { state, arguments: args }); return Object.freeze({ toolName: point.toolName, arguments: args });
    },
    accounting: () => Object.freeze({ toolAttempts, physicalReadBytes: options.budget.evidence().physicalReadBytes, visitedCandidates: options.index.accounting().visitedCandidates, toolBytes, citations }),
    close(): Promise<void> {
      if (shutdown) return shutdown; closed = true; cursors.clear(); discoveryCursors.clear(); skills?.clear();normalizedCalls.clear();
      shutdown = (async () => {
        const results = await Promise.allSettled([closeSlot(), rules.close(), ...[...states].map(state => state.candidates?.close()), options.index.dispose()]); states.clear();
        if (results.some(item => item.status === 'rejected')) return fail('CLEANUP_FAILED');
      })(); void shutdown.catch(() => {}); return shutdown;
    },
  });
}
export type ProjectReadBroker = ReturnType<typeof createProjectReadBroker>;

export type StoredFileSystemSource=Readonly<{source:FileSystemSourceRef;root:FileSystemReadRoot}>;
/** Per-run routing; issued IDs identify a captured source, never a write/import grant. */
export function createFilesystemReadBroker(options:Omit<Parameters<typeof createProjectReadBroker>[0],'root'|'index'|'source'|'installRootRule'>&{
  cwd:string|null;protectedRoots:readonly string[];indexQuota:{indexBytes:number;visitedCandidates:number};
  register(source:StoredFileSystemSource):void;
}){
  type Source={record:StoredFileSystemSource;index:ProjectReadIndex;broker:ProjectReadBroker;selectPageCall:(call:ProjectReadToolCall)=>void};
  const sources=new Map<string,Source>(),ids=new Map<string,Source>(),calls=new Map<string,{signature:string;result:ProjectReadToolResult}>();
  let active:Source|undefined,busy=false,closed=false;
  const remember=(source:Source,result:ProjectReadToolResult)=>{
    if(!result.ok)return;const value=result.value;
    if('coverage'in value&&'scope'in value.coverage&&value.coverage.scope.directoryId)ids.set(value.coverage.scope.directoryId,source);
    if(value.kind==='list'||value.kind==='find')for(const e of value.entries){if(e.fileId)ids.set(e.fileId,source);if(e.directoryId)ids.set(e.directoryId,source);}
    if(value.kind==='read'&&value.citation)ids.set(value.citation.fileId,source);
    if(value.kind==='search')for(const match of value.matches)ids.set(match.fileId,source);
  };
  return Object.freeze({
    async execute(call:ProjectReadToolCall):Promise<ProjectReadToolResult>{
      if(!isFileSystemToolName(call.toolName)||!options.authorize(call))return fail('CAPABILITY_DENIED');
      const signature=signatureOf(call),prior=calls.get(call.callId);if(prior){if(prior.signature!==signature)return fail('CONFLICT');return prior.result;}
      if(busy)return fail('BUSY');if(closed||options.signal.aborted)return fail('CANCELLED');busy=true;
      try{
        if(!parseProjectReadToolArguments(call.toolName,call.arguments))return fail('INVALID_REQUEST');
        const fsCall=call as Extract<ProjectReadToolCall,{toolName:'fs_list'|'fs_find'|'fs_search'|'fs_read'}>,a=fsCall.arguments;
        const issued='fileId'in a&&a.fileId?a.fileId:'directoryId'in a?a.directoryId:null;
        let source:Source|undefined, fileId='fileId'in a?a.fileId:null, directoryId='directoryId'in a?a.directoryId:null;
        if(issued){source=ids.get(issued);if(!source)return fail(a.cursor?'CURSOR_STALE':'FILE_UNAVAILABLE');}
        else{
          const absolute=resolveFilesystemPath(a.path??'.',options.cwd),target=inspectFilesystemPath(absolute,fsCall.toolName==='fs_read'?'file':fsCall.toolName==='fs_search'?'either':'directory',options.protectedRoots);
          const rootPath=target.stat.isDirectory()?absolute:path.win32.dirname(absolute),key=rootPath.toLowerCase();source=sources.get(key);
          if(!source){
            if(sources.size>=16)return fail('SCOPE_LIMIT');const root=captureFilesystemRoot(rootPath,options.protectedRoots);
            const ref:FileSystemSourceRef={kind:'windows_filesystem',sourceId:'fs-source-'+randomUUID(),rootPath:root.root,rootIdentity:hash(JSON.stringify(root))};
            const record={source:ref,root};options.register(record);
            let pageCall:ProjectReadToolCall|undefined;
            const index=createProjectReadIndex({root:{...root,protectedRoots:options.protectedRoots},source:ref,projectId:options.project.projectId,identity:ref.rootIdentity,owner:{kind:'run',id:options.runId},signal:options.signal,quota:options.indexQuota,...(options.quota?.maxToolAttempts===null?{maxRunPages:null}:{}),measurePage:value=>bytes(filesystemListingResult(ref,pageCall??fail('INVALID_REQUEST'),value))});
            const broker=createProjectReadBroker({...options,root:{...root,protectedRoots:options.protectedRoots},source:ref,index,installRootRule:async()=>{}});
            source={record,index,broker,selectPageCall:call=>{pageCall=call;}};sources.set(key,source);const rootId=index.scope(null).directoryId;if(rootId)ids.set(rootId,source);await broker.prepare();
          }
          if(target.stat.isFile()){const entry=fsCall.toolName==='fs_search'&&fsCall.arguments.refresh?await source.index.refreshFile({absolutePath:absolute}):source.index.captureFile(absolute);fileId=entry.fileId;ids.set(fileId!,source);directoryId=null;}
          else directoryId=source.index.scope(null).directoryId;
        }
        if(active&&active!==source)await active.broker.suspend();active=source;
        if(issued&&fileId&&fsCall.toolName==='fs_search'&&fsCall.arguments.refresh){const entry=await source.index.refreshFile({fileId});fileId=entry.fileId;ids.set(fileId!,source);}
        let normalized:ProjectReadToolCall;
        if(fsCall.toolName==='fs_read')normalized={...fsCall,toolName:'project_read',arguments:{fileId:fileId??fail('NOT_A_FILE'),version:fsCall.arguments.version,start:fsCall.arguments.start,cursor:a.cursor}};
        else if(fsCall.toolName==='fs_search')normalized={...fsCall,toolName:'project_search',arguments:{directoryId,query:fsCall.arguments.query,cursor:a.cursor,refresh:fileId?false:fsCall.arguments.refresh,...(fileId?{fileId}:{})}};
        else if(fsCall.toolName==='fs_find')normalized={...fsCall,toolName:'project_find',arguments:{directoryId,query:fsCall.arguments.query,cursor:a.cursor,refresh:fsCall.arguments.refresh}};
        else normalized={...fsCall,toolName:'project_list',arguments:{directoryId,cursor:a.cursor,refresh:fsCall.arguments.refresh}};
        source.selectPageCall(call);const result=await source.broker.execute(call,normalized);remember(source,result);calls.set(call.callId,{signature,result});return result;
      }catch(error){
        if(error instanceof ProjectReadFsError&&['STORAGE_FAILED','CANCELLED','CLEANUP_FAILED'].includes(error.code))throw error;
        const result:ProjectReadToolResult={ok:false,error:{code:error instanceof ProjectReadFsError?error.code:'IO_ERROR',...(error instanceof ProjectReadFsError&&error.osCode?{osCode:error.osCode}:{})},coverage:null};
        if(!options.canDeliver({call,result,citations:[],locators:[]}))return fail('BUDGET_EXCEEDED');await options.publish({call,result,citations:[],locators:[]});calls.set(call.callId,{signature,result});return result;
      }finally{busy=false;}
    },
    async suspend(){await active?.broker.suspend();active=undefined;},
    async close(){closed=true;const results=await Promise.allSettled([...sources.values()].map(s=>s.broker.close()));if(results.some(r=>r.status==='rejected'))return fail('CLEANUP_FAILED');},
  });
}
export type FilesystemReadBroker=ReturnType<typeof createFilesystemReadBroker>;
