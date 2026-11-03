import fs from 'node:fs';
import path from 'node:path';
import { verifyFrozenWorkRecovery } from '../agent-work-cycle/interrupted-continuation';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AGENT_PROJECT_READ_VERSION as V, PROJECT_READ_LIMITS as L } from '../../shared/agent/agent-project-read';
import type * as C from '../../shared/agent/agent-project-read';
import { parseProjectReadEvent, parseProjectReadRequest, parseProjectReadResult, parseProjectReadValue, projectReadFitsJsonBudget } from '../../shared/agent/agent-project-read-validation';
import { isProjectReadDataValue, isWorkCycleToolName } from '../../shared/agent/agent-project-read-validation';
import { isCommandToolName } from '../../shared/agent/agent-command-validation';
import { checkedFolderPath, folderDisplaySegments, type FolderIdentity, type FolderRoot } from '../cloud/project-folder-files';
import type { ProjectReadFile } from '../cloud/project-read-files';
import { createSkillHistoryAudit } from './skills-history';
import { commandObservationStart, createCommandHistoryAudit } from '../agent-command/history';
import { parseTaskDeletion, type TaskDeletion } from './capacity-journal';
import { isWslResultsToolName, type WslResultsEntry } from '../../shared/agent/wsl-results';
import { isOaReadToolName } from '../../shared/agent/oa-read-validation';
import { createWaveformHistoryAudit } from './waveform-history';
import {resolveFilesystemPath} from '../cloud/filesystem-read-sources';
import {isFileSystemToolName,type FileSystemSourceRef} from '../../shared/agent/agent-filesystem-read';
import type {StoredFileSystemSource} from '../cloud/project-read-broker';

export type ProjectReadStoredCitation = Readonly<{ citation: C.ProjectReadCitation; file: ProjectReadFile }>;
export type ProjectReadStoredRun = Readonly<{ run: C.ProjectReadRun; root: FolderRoot|null; citations: readonly ProjectReadStoredCitation[];sources?:readonly StoredFileSystemSource[] }>;
export type ProjectReadDisk = Readonly<{ version: 1; runs: readonly ProjectReadStoredRun[]; deletions?: readonly TaskDeletion[] }>;
export interface ProjectReadStore { load(): ProjectReadDisk; save(next: ProjectReadDisk): void; close(): void; }
export class ProjectReadStoreError extends Error {
  readonly code: C.ProjectReadCode;
  readonly dependentRunIds: readonly string[];
  constructor(code: C.ProjectReadCode = 'STORAGE_FAILED', dependentRunIds: readonly string[] = []) {
    super('Project read store: ' + code); this.code = code; this.dependentRunIds = Object.freeze([...dependentRunIds]);
  }
}
function fail(code: C.ProjectReadCode = 'INVALID_REQUEST'): never { throw new ProjectReadStoreError(code); }
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const equal = isDeepStrictEqual;
const active = (state: C.ProjectReadRunState): boolean => ['preparing','running','waiting_user'].includes(state);
const failure = <T>(code: Exclude<C.ProjectReadCode, 'RUN_HAS_DEPENDENTS'>): C.ProjectReadResult<T> => Object.freeze({ ok: false, error: Object.freeze({ code }) });
const success = <T>(value: T): C.ProjectReadResult<T> => Object.freeze({ ok: true, value });
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail();
  const out: Record<string, unknown> = {};
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !('value' in d) || !d.enumerable) fail(); out[key] = d.value; }
  return out;
}
function list<T>(value: unknown, max: number, parse: (v: unknown) => T, limitCode: C.ProjectReadCode = 'INVALID_REQUEST'): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail();
  if (value.length > max) fail(limitCode);
  return Object.freeze(Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !('value' in d) || !d.enumerable) fail(); return parse(d.value);
  }));
}
function decimal(value: unknown, signed = false): string {
  if (typeof value !== 'string' || !(signed ? /^-?(?:0|[1-9][0-9]{0,29})$/u : /^(?:0|[1-9][0-9]{0,29})$/u).test(value) || value === '-0') fail();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length > L.idBytes || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) fail(); return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) fail(); return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); return value;
}
const identity = (value: unknown): FolderIdentity => { const v = exact(value, ['dev','ino']); return Object.freeze({ dev: decimal(v.dev), ino: decimal(v.ino) }); };
const chain = (value: unknown): readonly FolderIdentity[] => list(value, 154, identity);
function rootRecord(value: unknown, project: C.ProjectReadRef): FolderRoot {
  const v = exact(value, ['projectId','bindingId','root','chain']);
  if (typeof v.root !== 'string') fail();
  // checkedFolderPath is a pure lexical policy check; never inspect a recorded source path here.
  const root = checkedFolderPath(v.root), parts = folderDisplaySegments(root), links = chain(v.chain);
  if (root !== v.root || links.length !== parts.length || links.length > 128 || v.projectId !== project.projectId || v.bindingId !== project.bindingId || !equal(parts, project.directorySegments) || path.basename(root) !== project.directoryName) fail();
  return Object.freeze({ projectId: id(v.projectId), bindingId: id(v.bindingId), root, chain: links as FolderIdentity[] });
}
function sourceRecord(value:unknown):StoredFileSystemSource{
  const v=exact(value,['source','root']),s=exact(v.source,['kind','sourceId','rootPath','rootIdentity']),r=exact(v.root,['root','chain']);
  if(s.kind!=='windows_filesystem'||typeof r.root!=='string'||resolveFilesystemPath(r.root,null)!==r.root||s.rootPath!==r.root)return fail();
  const root={root:r.root,chain:chain(r.chain) as FolderIdentity[]};
  if(root.chain.length!==1+root.root.slice(path.win32.parse(root.root).root.length).split('\\').filter(Boolean).length||s.rootIdentity!==sha(JSON.stringify(root)))return fail();
  return {source:{kind:'windows_filesystem',sourceId:id(s.sourceId),rootPath:root.root,rootIdentity:s.rootIdentity as string},root};
}
function citationRecord(value: unknown, projectRoot: FolderRoot|null, run: C.ProjectReadSummary,sources:readonly StoredFileSystemSource[]): ProjectReadStoredCitation {
  const v = exact(value, ['citation','file']), c = parseProjectReadValue('resolveCitation', v.citation);
  if (!c || c.runId !== run.runId || !equal(c.project, run.project) || c.createdAt < run.createdAt || c.createdAt > run.updatedAt || sha(c.excerpt) !== c.excerptSha256) fail();
  const source=c.location?sources.find(s=>s.source.sourceId===c.location!.sourceId):null,root=source?.root??projectRoot;
  if(!root||c.location&&(!source||!equal(source.source,(({absolutePath:_,...ref})=>ref)(c.location))))fail();
  const f = exact(v.file, ['absolutePath','relativePath','chain','dev','ino','size','mtimeNs','ctimeNs','fileIdentity']);
  const links = chain(f.chain), dev = decimal(f.dev), ino = decimal(f.ino), size = integer(f.size, 0, L.fileBytes);
  const absolutePath = path.join(root.root, ...c.relativePath.split('/'));
  if (f.absolutePath !== absolutePath || f.relativePath !== c.relativePath || (source?resolveFilesystemPath(absolutePath,null):checkedFolderPath(absolutePath)) !== absolutePath||c.location&&c.location.absolutePath!==absolutePath
    || links.length !== root.chain.length + c.relativePath.split('/').length || !equal(links.slice(0, root.chain.length), root.chain)
    || !equal(links.at(-1), { dev, ino }) || f.fileIdentity !== sha(JSON.stringify({ dev, ino })) || c.fileIdentity !== f.fileIdentity || c.fileBytes !== size) fail();
  const file: ProjectReadFile = Object.freeze({ absolutePath, relativePath: c.relativePath, chain: links, dev, ino, size, mtimeNs: decimal(f.mtimeNs, true), ctimeNs: decimal(f.ctimeNs, true), fileIdentity: c.fileIdentity });
  return Object.freeze({ citation: c, file });
}
function summaryOf(run: C.ProjectReadRun): C.ProjectReadSummary { const { events: _events, ...summary } = run; return Object.freeze(summary); }
function previews(result: C.ProjectReadToolResult): readonly C.ProjectReadCitationPreview[] {
  if (!result.ok) return [];
  const v = result.value; return v.kind === 'search' ? v.matches.map(m => m.citation) : v.kind === 'read' && v.citation ? [v.citation] : [];
}
function previewOf(c: C.ProjectReadCitation): C.ProjectReadCitationPreview {
  const { citationId, fileId, relativePath, version, normalizedSha256, range, excerpt, excerptSha256, totalLines, fileBytes, source } = c;
  return { citationId, fileId, relativePath, version, normalizedSha256, range, excerpt, excerptSha256, totalLines, fileBytes, source,...(c.location?{location:c.location}:{}) };
}
function checkEvents(run: C.ProjectReadRun, citations: readonly ProjectReadStoredCitation[],sources:readonly StoredFileSystemSource[],priorRuns:ReadonlyMap<string,ProjectReadStoredRun>): void {
  const first = run.events[0];
  if (!first || first.type !== 'run.accepted' || first.time !== run.createdAt || !equal(first.data.project, run.project) || !equal(first.data.model, run.model) || run.eventCount !== run.events.length || run.events.at(-1)!.time !== run.updatedAt) fail();
  if (!equal(first.data.wslResultsBinding, run.wslResultsBinding) || !equal(first.data.origin,run.origin)) fail();
  const unboundedConversation = !!first.data.origin && first.data.budget.providerAttempts === null;
  let workRef=first.data.workCycle,parent=first.data.continuedFrom;
  const ruleKey=(rule:{source:string;sourceRef?:FileSystemSourceRef})=>(rule.sourceRef?.sourceId??'project')+':'+rule.source;
  const validSource=(ref:FileSystemSourceRef)=>sources.some(s=>equal(s.source,ref));
  let state: C.ProjectReadRunState = 'preparing', cleanup: C.ProjectReadCleanupState = 'idle', cleanupStarted = false, cleanupConfirmed = false;
  let session: string | null = null, step = 0, response = 0, outputBytes = 0, toolBytes = 0, sums = 0;
  let pending: string | null = null;
  let accounting: C.ProjectReadAccounting = { providerAttempts: 0, httpDispatches: 0, toolAttempts: 0, physicalReadBytes: 0, visitedCandidates: 0, contextBytes: null };
  const calls = new Map<string, C.ProjectReadToolCall>(), completed = new Set<string>(), questions = new Map<string, 'asked' | 'answered' | 'delivered'>();
  const rules = new Map<string, C.ProjectReadRule>(), evidence = new Map(citations.map(c => [c.citation.citationId, c.citation])), referenced = new Set<string>();
  const auditSkills = createSkillHistoryAudit(() => fail());
  const resolveCommandObservation=(source:import('../../shared/agent/agent-command').CommandObservation)=>commandObservationStart(run,priorRuns.get(source.runId)?.run,source);
  const auditCommands=createCommandHistoryAudit(run.runId,()=>workRef?.workspaceId,()=>fail(),resolveCommandObservation);
  const wslFiles = new Map<string, WslResultsEntry>(), wslCitations = new Set(citations.map(c => c.citation.citationId));
  const auditWaveforms = createWaveformHistoryAudit(run.wslResultsBinding, () => fail(), wslCitations);
  for (let i = 0; i < run.events.length; i++) {
    const e = run.events[i]!;
    if (e.runId !== run.runId || e.sequence !== i + 1 || (i && e.time < run.events[i - 1]!.time) || (i && e.type === 'run.accepted')) fail();
    if (!active(state) && e.type !== 'cleanup.completed') fail();
    if (cleanupStarted && !['cleanup.completed','budget.updated','run.completed','run.failed','run.stopped','run.interrupted'].includes(e.type)) fail();
    switch (e.type) {
      case 'run.accepted': break;
      case 'work.prepared':
        if(!run.origin||run.project.bindingId===null||workRef||parent!==null||!session||state!=='running'||e.data.continuedFrom!==(e.data.workCycle.continuation?.runId??null))fail();
        workRef=e.data.workCycle;parent=e.data.continuedFrom;break;
      case 'run.started': if (session || state !== 'preparing') fail(); session = e.data.sessionId; state = 'running'; break;
      case 'model.step': if (!session || state !== 'running' || e.data.step !== ++step) fail(); break;
      case 'model.response': if (!session || state !== 'running' || e.data.request <= response) fail(); response = e.data.request; break;
      case 'message.delta': if (!session || state !== 'running' || e.data.step > step) fail(); outputBytes += Buffer.byteLength(e.data.text); break;
      case 'project.rules':
        for (const rule of e.data.rules) { if(rule.sourceRef&&!validSource(rule.sourceRef))fail();const key=ruleKey(rule),old = rules.get(key); if (old && !equal(old, rule)) fail(); if (rule.state === 'loaded' && sha(rule.text!) !== rule.normalizedSha256) fail(); rules.set(key, rule); }
        if ([...rules.values()].filter(r => r.state === 'loaded').length > L.rules || [...rules.values()].filter(r => r.state === 'absent').length > L.directories || [...rules.values()].reduce((n, r) => n + Buffer.byteLength(r.text ?? ''), 0) > L.rulesBytes) fail('BUDGET_EXCEEDED');
        break;
      case 'tool.started':
        if (!session || state !== 'running' || e.data.sessionId !== session || calls.has(e.data.callId)) fail();
        if ((isWorkCycleToolName(e.data.toolName)||isCommandToolName(e.data.toolName)&&e.data.toolName!=='command_status'&&e.data.toolName!=='command_log') && !workRef) fail();
        if(run.project.bindingId===null&&!isOaReadToolName(e.data.toolName)&&!isFileSystemToolName(e.data.toolName)&&e.data.toolName!=='pilot_sum')fail();
        calls.set(e.data.callId, e.data); if (e.data.toolName === 'pilot_sum') sums++; break;
      case 'tool.completed': {
        const call = calls.get(e.data.callId), { result, ...actual } = e.data;
        if (!call || completed.has(e.data.callId) || !equal(call, actual)) fail(); completed.add(e.data.callId);
        auditSkills(e.data);
        auditCommands(e.data);
        auditWaveforms(e.data);
        if(result.ok&&result.value.kind==='oa_read'&&(result.value.source.runId!==run.runId||result.value.source.projectId!==run.project.projectId))fail();
        if (result.ok && isWslResultsToolName(result.value.kind)) {
          const value = result.value;
          if (!run.wslResultsBinding) fail();
          if (value.kind === 'wsl_results_list') {
            if (!equal(value.binding, run.wslResultsBinding)) fail();
            for (const entry of value.entries) if (entry.fileId) { const previous = wslFiles.get(entry.fileId); if (previous && !equal(previous, entry)) fail(); wslFiles.set(entry.fileId, entry); }
          } else if (value.kind === 'wsl_results_read') {
            const { relativePath, absolutePath: _path, ...binding } = value.source, source = wslFiles.get(value.fileId);
            if (!equal(binding, run.wslResultsBinding) || !source || source.relativePath !== relativePath || source.version !== value.version || source.bytes !== value.fileBytes
              || sha(value.text) !== value.excerptSha256 || wslCitations.has(value.citationId)) fail();
            wslCitations.add(value.citationId);
          }
        }
        // Stored history is not the active model context after native compaction.
        // The complete stored run still has its byte limit and terminal reserve.
        toolBytes += bytes(result); if (!unboundedConversation && toolBytes > L.toolContextBytes) fail('BUDGET_EXCEEDED');
        const cov = result.ok && isProjectReadDataValue(result.value) ? result.value.coverage : !result.ok ? result.coverage : null;
        if(cov){if(cov.scope.projectId!==run.project.projectId)fail();if(cov.scope.kind==='windows_filesystem'){
          const scope=cov.scope,ref=sources.find(s=>s.source.sourceId===scope.sourceId)?.source;if(!ref||ref.rootIdentity!==scope.identity||!isFileSystemToolName(call.toolName))fail();
        }else if(cov.scope.bindingId!==run.project.bindingId||cov.scope.identity!==run.project.identity||isFileSystemToolName(call.toolName))fail();}
        if(result.ok&&isProjectReadDataValue(result.value)&&result.value.kind!=='skills'&&isFileSystemToolName(call.toolName)&&(!result.value.source||!validSource(result.value.source)))fail();
        for (const p of previews(result)) { const c = evidence.get(p.citationId); if (!c || !equal(previewOf(c), p) || c.createdAt > e.time || referenced.has(p.citationId)) fail(); referenced.add(p.citationId); }
        if (result.ok && isProjectReadDataValue(result.value)) for (const chunk of result.value.rules) { const source = rules.get(ruleKey(chunk)); if (!source || source.state !== 'loaded' || source.version !== chunk.version || source.normalizedSha256 !== chunk.normalizedSha256 || Buffer.byteLength(source.text!) !== chunk.totalBytes || !Buffer.from(source.text!, 'utf8').subarray(chunk.offsetBytes, chunk.endBytes).equals(Buffer.from(chunk.text, 'utf8'))) fail(); }
        break;
      }
      case 'question.asked': if (!session || state !== 'running' || pending || questions.has(e.data.questionId)) fail(); pending = e.data.questionId; questions.set(pending, 'asked'); state = 'waiting_user'; break;
      case 'question.answered': if (pending !== e.data.questionId || questions.get(e.data.questionId) !== 'asked') fail(); questions.set(e.data.questionId, 'answered'); break;
      case 'question.delivered': if (pending !== e.data.questionId || questions.get(e.data.questionId) !== 'answered') fail(); questions.set(e.data.questionId, 'delivered'); pending = null; state = 'running'; break;
      case 'budget.updated':
        for (const key of ['providerAttempts','httpDispatches','toolAttempts','physicalReadBytes','visitedCandidates'] as const) if (e.data[key] < accounting[key]) fail();
        accounting = e.data; break;
      case 'cleanup.started': if (cleanupStarted) fail(); cleanupStarted = true; cleanup = 'pending'; break;
      case 'cleanup.completed': if (cleanup !== 'pending') fail(); cleanup = e.data.outcome === 'confirmed' ? 'idle' : 'failed'; cleanupConfirmed = e.data.outcome === 'confirmed'; break;
      case 'run.completed':
        if (!session || state !== 'running' || !cleanupConfirmed || cleanup !== 'idle' || pending || completed.size !== calls.size || e.data.citations.some(c => !evidence.has(c))) fail();
        state = 'completed'; break;
      case 'run.failed': case 'run.stopped': case 'run.interrupted':
        if (session && !cleanupStarted) fail(); state = e.type === 'run.failed' ? 'failed' : e.type === 'run.stopped' ? 'stopped' : 'interrupted'; break;
    }
  }
  if(!equal(workRef,run.workCycle)||parent!==run.continuedFrom)fail();
  if (state !== run.status || cleanup !== run.cleanupState || !equal(accounting, run.accounting) || response > accounting.httpDispatches || calls.size > accounting.toolAttempts || outputBytes > first.data.budget.outputBytes || !unboundedConversation && (step > L.steps || sums > L.sums) || questions.size > L.questions) fail();
  for (const key of ['providerAttempts','httpDispatches','toolAttempts','physicalReadBytes','visitedCandidates'] as const) { const limit=first.data.budget[key]; if (limit !== null && accounting[key] > limit) fail('BUDGET_EXCEEDED'); }
  if (accounting.contextBytes !== null && accounting.contextBytes > first.data.budget.contextBytes) fail('BUDGET_EXCEEDED');
  for (const c of citations) if (!referenced.has(c.citation.citationId) && c.citation.origin === null) fail();
}
function storedRun(value: unknown): ProjectReadStoredRun {
  const v = exact(value, ['run','root','citations',...(value&&typeof value==='object'&&Object.hasOwn(value,'sources')?['sources']:[])]);
  const record = exact(v.run, ['runId','clientRequestId','project','model','goal','constraint','continuedFrom','status','cleanupState','createdAt','updatedAt','accounting','eventCount','continuation','events', ...(v.run && typeof v.run === 'object' && Object.hasOwn(v.run,'workCycle') ? ['workCycle'] : []), ...(v.run && typeof v.run === 'object' && Object.hasOwn(v.run,'wslResultsBinding') ? ['wslResultsBinding'] : []), ...(v.run && typeof v.run === 'object' && Object.hasOwn(v.run,'origin') ? ['origin'] : [])]);
  const { events: rawEvents, ...rawSummary } = record;
  const summary = parseProjectReadValue('listRuns', { runs: [rawSummary], nextBefore: null })?.runs[0]; if (!summary) fail();
  const events = list(rawEvents, L.events, v => parseProjectReadEvent(v) ?? fail(), 'BUDGET_EXCEEDED');
  const run: C.ProjectReadRun = Object.freeze({ ...summary, events }), root = v.root===null?null:rootRecord(v.root, summary.project);
  if((root===null)!==(summary.project.bindingId===null)||root===null&&!run.origin)fail();
  const sources=v.sources===undefined?[]:list(v.sources,16,sourceRecord,'BUDGET_EXCEEDED');if(new Set(sources.map(s=>s.source.sourceId)).size!==sources.length)fail();
  const citations = list(v.citations, L.citations, c => citationRecord(c, root, run,sources), 'BUDGET_EXCEEDED');
  if (new Set(citations.map(c => c.citation.citationId)).size !== citations.length) fail();
  const result = Object.freeze({ run, root, citations,...(v.sources===undefined?{}:{sources}) }); if (!projectReadFitsJsonBudget(result, L.runBytes)) fail('BUDGET_EXCEEDED'); return result;
}
function decodeDisk(value: unknown): ProjectReadDisk {
  const v = exact(value, ['version','runs', ...(value && typeof value === 'object' && Object.hasOwn(value, 'deletions') ? ['deletions'] : [])]); if (v.version !== 1) fail();
  const runs = list(v.runs, L.runs, storedRun, 'HISTORY_FULL');
  const priorRuns=new Map<string,ProjectReadStoredRun>();
  for(const stored of runs){checkEvents(stored.run,stored.citations,stored.sources??[],priorRuns);priorRuns.set(stored.run.runId,stored);}
  const byId = new Map(runs.map(r => [r.run.runId, r]));
  if (byId.size !== runs.length || new Set(runs.map(r => r.run.clientRequestId)).size !== runs.length || runs.filter(r => active(r.run.status)).length > 1) fail();
  const origins=runs.flatMap(r=>r.run.origin?[r.run.origin]:[]);
  if(new Set(origins.map(o=>o.executionId)).size!==origins.length||new Set(origins.map(o=>o.chatSessionId+':'+o.turnId)).size!==origins.length)fail();
  const workspaces = runs.flatMap(stored => stored.run.workCycle ? [stored.run.workCycle.workspaceId] : []);
  if (new Set(workspaces).size !== workspaces.length) fail();
  const citationIds = runs.flatMap(r => r.citations.map(c => c.citation.citationId)); if (new Set(citationIds).size !== citationIds.length) fail();
  for (const stored of runs) {
    const { run } = stored, ancestors = new Set<string>(); let child = stored, parentId = run.continuedFrom;
    while (parentId !== null) {
      if (ancestors.has(parentId) || parentId === run.runId || ancestors.size >= L.continuationDepth - 1) fail(); ancestors.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || active(parent.run.status) || !equal(parent.root, child.root) || !equal(parent.run.project, child.run.project)
        || !!parent.run.workCycle !== !!child.run.workCycle || parent.run.createdAt > child.run.createdAt) fail();
      if (child.run.workCycle) {
        const source = child.run.workCycle.continuation;
        if (!source || source.runId !== parent.run.runId || source.workspaceId !== parent.run.workCycle!.workspaceId || source.eventCount !== parent.run.eventCount
          || child.run.continuation !== null || parent.run.updatedAt > child.run.createdAt) fail();
        if (parent.run.cleanupState !== 'idle') verifyFrozenWorkRecovery(parent, source);
        else if (source.recovery) fail();
      } else if (parent.run.cleanupState !== 'idle' || parent.run.goal !== child.run.goal || parent.run.constraint !== child.run.constraint) fail();
      child = parent; parentId = parent.run.continuedFrom;
    }
    for (const { citation: c, file } of stored.citations) if (c.origin) {
      if (!ancestors.has(c.origin.runId)) fail();
      const old = byId.get(c.origin.runId)?.citations.find(x => x.citation.citationId === c.origin!.citationId);
      if (!old || !equal(old.file, file) || c.citationId === old.citation.citationId || c.fileId === old.citation.fileId || c.snapshotId === old.citation.snapshotId) fail();
      const omit = (x: C.ProjectReadCitation) => { const { citationId: _a, runId: _b, snapshotId: _c, fileId: _d, createdAt: _e, origin: _f, ...rest } = x; return rest; };
      if (!equal(omit(old.citation), omit(c))) fail();
    }
  }
  const deletions = v.deletions === undefined ? undefined : list(v.deletions, L.runs, value => parseTaskDeletion(value) ?? fail());
  if (deletions) {
    if (new Set(deletions.map(d => d.runId)).size !== deletions.length) fail();
    for (const d of deletions) {
      const stored = byId.get(d.runId); if (!stored || active(stored.run.status) || stored.run.cleanupState !== 'idle'
        || d.workspaceId !== (stored.run.workCycle?.workspaceId ?? null) || d.expectedEventCount !== stored.run.eventCount
        || projectReadDependents({version:1,runs},d.runId).length) fail();
      const ids = new Set<string>();
      for (const e of stored.run.events) if (e.type === 'tool.completed' && e.data.result.ok) {
        const r = e.data.result.value;
        if (r.kind === 'work_run') ids.add('work_execution:' + r.execution.executionId);
        if ((r.kind === 'command_start' || r.kind === 'command_status' || r.kind === 'command_stop') && r.execution.runId === stored.run.runId) ids.add('command_execution:' + r.execution.executionId);
      }
      if (d.targets.some(t => (t.kind === 'work_execution' || t.kind === 'command_execution') && !ids.has(t.kind + ':' + t.id))) fail();
    }
  }
  const disk: ProjectReadDisk = Object.freeze({ version: 1, runs, ...(deletions ? { deletions } : {}) }); if (!projectReadFitsJsonBudget(disk, L.diskBytes)) fail('HISTORY_FULL'); return disk;
}
function checkedDisk(value: unknown): ProjectReadDisk {
  try { return decodeDisk(value); } catch (e) { if (e instanceof ProjectReadStoreError) throw e; return fail(); }
}
export function parseProjectReadDisk(value: unknown): ProjectReadDisk | null { try { return checkedDisk(value); } catch { return null; } }

/** Pure recovery: no source-file access, model work, answer replay or invented cleanup confirmation. */
export function recoverProjectReadDisk(value: ProjectReadDisk, now: string): ProjectReadDisk {
  const disk = checkedDisk(value); timestamp(now);
  return checkedDisk({ ...disk, runs: disk.runs.map(stored => {
    if (!active(stored.run.status) && stored.run.cleanupState !== 'pending') return stored;
    const run = stored.run, events = [...run.events], time = now < run.updatedAt ? run.updatedAt : now;
    let cleanupState = run.cleanupState;
    const append = (type: 'cleanup.started' | 'run.interrupted' | 'cleanup.completed', data: unknown): void => {
      const parsed = parseProjectReadEvent({ runId: run.runId, sequence: events.length + 1, time, type, data }); if (!parsed) fail('BUDGET_EXCEEDED'); events.push(parsed);
    };
    if (active(run.status)) {
      if (events.some(e => e.type === 'run.started') && !events.some(e => e.type === 'cleanup.started')) { append('cleanup.started', { reason: 'close' }); cleanupState = 'pending'; }
      append('run.interrupted', { reason: 'restart' });
    }
    if (cleanupState === 'pending') { append('cleanup.completed', { outcome: 'failed' }); cleanupState = 'failed'; }
    return { ...stored, run: { ...run, status: active(run.status) ? 'interrupted' : run.status, cleanupState, updatedAt: time, eventCount: events.length, events } };
  }) });
}
export function listProjectReadRuns(value: ProjectReadDisk, projectId: string | null, before: string | null): C.ProjectReadResult<C.ProjectReadValues['listRuns']> {
  try {
    if (!parseProjectReadRequest('listRuns', { contractVersion: V, projectId, before })) return failure('INVALID_REQUEST');
    const disk = checkedDisk(value), all = disk.runs.map(s => s.run).filter(r => projectId === null || r.project.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
    const index = before === null ? -1 : all.findIndex(r => r.runId === before); if (before !== null && index < 0) return failure('CONFLICT');
    const runs = Object.freeze(all.slice(index + 1, index + 1 + L.runs).map(summaryOf));
    return parseProjectReadResult('listRuns', { ok: true, value: { runs, nextBefore: null } }) ?? failure('BUDGET_EXCEEDED');
  } catch { return failure('INVALID_REQUEST'); }
}
export function readProjectReadPage(value: ProjectReadDisk, runId: string, after: number): C.ProjectReadResult<C.ProjectReadValues['readRun']> {
  try {
    if (!parseProjectReadRequest('readRun', { contractVersion: V, runId, after })) return failure('INVALID_REQUEST');
    const stored = checkedDisk(value).runs.find(s => s.run.runId === runId); if (!stored) return failure('RUN_NOT_FOUND');
    if (after > stored.run.eventCount) return failure('CONFLICT');
    const events: C.ProjectReadEvent[] = [], run = summaryOf(stored.run);
    const prepared=stored.run.events.find(e=>e.type==='work.prepared'),proof=prepared?.type==='work.prepared'?{workPreparation:prepared}:{};
    for (const event of stored.run.events.slice(after, after + L.eventPage)) {
      const candidate = { ok: true, value: { run, events: [...events, event], nextAfter: event.sequence, hasMore: event.sequence < run.eventCount,...proof } };
      if (!projectReadFitsJsonBudget(candidate, L.eventPageBytes)) break; events.push(event);
    }
    if (!events.length && after < run.eventCount) return failure('BUDGET_EXCEEDED');
    const nextAfter = events.at(-1)?.sequence ?? after;
    return parseProjectReadResult('readRun', { ok: true, value: { run, events, nextAfter, hasMore: nextAfter < run.eventCount,...proof } }) ?? failure('INVALID_REQUEST');
  } catch { return failure('INVALID_REQUEST'); }
}
export function resolveStoredProjectReadCitation(value: ProjectReadDisk, runId: string, citationId: string): C.ProjectReadResult<C.ProjectReadCitation> {
  try {
    if (!parseProjectReadRequest('resolveCitation', { contractVersion: V, runId, citationId })) return failure('INVALID_REQUEST');
    const stored = checkedDisk(value).runs.find(s => s.run.runId === runId); if (!stored) return failure('RUN_NOT_FOUND');
    const citation = stored.citations.find(c => c.citation.citationId === citationId)?.citation;
    return citation ? success(citation) : failure('FILE_UNAVAILABLE');
  } catch { return failure('INVALID_REQUEST'); }
}
export function projectReadDependents(disk: ProjectReadDisk, runId: string): string[] {
  const dependent = new Set<string>([runId]); let changed = true;
  while (changed) { changed = false; for (const s of disk.runs) if (!dependent.has(s.run.runId) && ((s.run.continuedFrom && dependent.has(s.run.continuedFrom)) || s.citations.some(c => c.citation.origin && dependent.has(c.citation.origin.runId)) || s.run.events.some(e=>e.type==='tool.completed'&&e.data.result.ok&&(e.data.result.value.kind==='command_status'||e.data.result.value.kind==='command_log')&&e.data.result.value.observation&&dependent.has(e.data.result.value.observation.runId)))) { dependent.add(s.run.runId); changed = true; } }
  return disk.runs.filter(s => s.run.runId !== runId && dependent.has(s.run.runId)).map(s => s.run.runId);
}
export function deleteStoredProjectReadRun(value: ProjectReadDisk, runId: string, expectedEventCount: number, retainedRunIds: readonly string[]): C.ProjectReadResult<ProjectReadDisk> {
  try {
    if (!parseProjectReadRequest('deleteRun', { contractVersion: V, runId, expectedEventCount })) return failure('INVALID_REQUEST');
    const retained = list(retainedRunIds, L.runs, id), disk = checkedDisk(value), stored = disk.runs.find(s => s.run.runId === runId);
    if (!stored) return failure('RUN_NOT_FOUND');
    if (active(stored.run.status) || stored.run.cleanupState === 'pending' || !!stored.run.workCycle && stored.run.cleanupState !== 'idle' || retained.includes(runId)) return failure('BUSY');
    if (stored.run.eventCount !== expectedEventCount) return failure('CONFLICT');
    const dependentRunIds = projectReadDependents(disk, runId);
    if (dependentRunIds.length) return Object.freeze({ ok: false, error: Object.freeze({ code: 'RUN_HAS_DEPENDENTS', dependentRunIds: Object.freeze(dependentRunIds) }) });
    return success(checkedDisk({ ...disk, runs: disk.runs.filter(s => s !== stored), ...(disk.deletions ? { deletions: disk.deletions.filter(d => d.runId !== runId) } : {}) }));
  } catch { return failure('INVALID_REQUEST'); }
}
function reserve(stored: ProjectReadStoredRun): { events: number; bytes: number } {
  const run = stored.run, pending = run.cleanupState === 'pending';
  const events = active(run.status) ? (pending ? 2 : 4) : pending ? 1 : 0;
  // Includes final accounting, cleanup start, terminal and cleanup outcome. Fixed
  // control data plus the longest admitted opaque run ID fit this measured bound.
  const envelope = bytes({ runId: run.runId, sequence: L.events, time: '9999-12-31T23:59:59.999Z', type: 'cleanup.completed', data: { outcome: 'confirmed' } });
  return { events, bytes: events * (envelope + 512) + (events ? 64 : 0) };
}
function admission(disk: ProjectReadDisk): void {
  let reserved = 0;
  for (const stored of disk.runs) { const tail = reserve(stored); if (stored.run.eventCount + tail.events > L.events || bytes(stored) + tail.bytes > L.runBytes) fail('BUDGET_EXCEEDED'); reserved += tail.bytes; }
  if (bytes(disk) + reserved > L.diskBytes) fail('HISTORY_FULL');
}
function checkUpdate(previous: ProjectReadDisk, next: ProjectReadDisk): void {
  const removed = previous.runs.filter(old => !next.runs.some(n => n.run.runId === old.run.runId));
  if (removed.length > 1) fail('CONFLICT');
  for (const old of removed) { if (active(old.run.status) || old.run.cleanupState === 'pending' || !!old.run.workCycle && old.run.cleanupState !== 'idle') fail('BUSY'); const ids = projectReadDependents(previous, old.run.runId); if (ids.length) throw new ProjectReadStoreError('RUN_HAS_DEPENDENTS', ids); }
  for (const old of previous.deletions ?? []) {
    const updated = next.deletions?.find(d => d.runId === old.runId);
    if (!updated) { if (next.runs.some(s => s.run.runId === old.runId)) fail('CONFLICT'); continue; }
    if (!equal({ ...old, state: updated.state }, updated) || !equal(previous.runs.find(s => s.run.runId === old.runId), next.runs.find(s => s.run.runId === old.runId))) fail('CONFLICT');
  }
  for (const old of previous.runs) {
    const updated = next.runs.find(n => n.run.runId === old.run.runId); if (!updated) continue;
    for (const key of ['runId','clientRequestId','project','model','goal','constraint','createdAt','wslResultsBinding','origin'] as const) if (!equal(old.run[key], updated.run[key])) fail('CONFLICT');
    if(!equal(old.run.workCycle,updated.run.workCycle)||old.run.continuedFrom!==updated.run.continuedFrom){const receipt=updated.run.events.slice(old.run.eventCount).find(e=>e.type==='work.prepared');if(!active(old.run.status)||old.run.workCycle||old.run.continuedFrom!==null||!receipt||receipt.type!=='work.prepared'||!equal(receipt.data.workCycle,updated.run.workCycle)||receipt.data.continuedFrom!==updated.run.continuedFrom)fail('CONFLICT');}
    if(!(old.sources??[]).every(s=>(updated.sources??[]).some(n=>equal(n,s)))||!active(old.run.status)&&!equal(old.sources,updated.sources))fail('CONFLICT');
    if (!equal(old.root, updated.root) || !equal(old.run.events, updated.run.events.slice(0, old.run.eventCount))) fail('CONFLICT');
    if (!active(old.run.status) && (!equal(old.citations, updated.citations) || !equal(old.run.continuation, updated.run.continuation))) fail('CONFLICT');
    for (const c of old.citations) if (!equal(c, updated.citations.find(n => n.citation.citationId === c.citation.citationId))) fail('CONFLICT');
  }
}

type FileStamp = Readonly<{ dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }>;
type ReadFile = Readonly<{ data: Buffer; stamp: FileStamp }>;
type LockData = Readonly<{ version: 1; pid: number; nonce: string; createdAt: string }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECOVERY_CLAIM_SLOTS = 8;
const stamp = (s: fs.BigIntStats): FileStamp => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs });
function lockData(data: Buffer): LockData {
  const v = exact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)), ['version','pid','nonce','createdAt']);
  if (v.version !== 1 || typeof v.nonce !== 'string' || !uuid.test(v.nonce)) fail('STORAGE_FAILED');
  return { version: 1, pid: integer(v.pid, 1, 2147483647), nonce: v.nonce, createdAt: timestamp(v.createdAt) };
}
function dead(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** Only fixed application state paths; stored source locators are never opened by this module. */
export function createProjectReadStore(productRoot: string, directory = path.join(productRoot, '.local', 'agent-project-read')): ProjectReadStore {
  const base = path.resolve(productRoot), folder = path.resolve(directory);
  const relative = path.relative(base, folder).replaceAll('\\', '/');
  if (base.toLowerCase() !== path.resolve('C:/work/analog_ai_workbench').toLowerCase()
    || (relative !== '.local/agent-project-read' && !/^\.local\/(?:agent-project-read-tests|agent-engine-live-tests)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/agent-project-read$/u.test(relative))) fail('CAPABILITY_DENIED');
  const target = path.join(folder, 'runs.json'), lock = path.join(folder, 'writer.lock');
  const own: LockData = { version: 1, pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
  const ownBytes = Buffer.from(JSON.stringify(own));
  let directoriesStamp: readonly { dev: bigint; ino: bigint }[] | null = null, ownStamp: FileStamp | null = null;
  let expected: ReadFile | null = null, previous: ProjectReadDisk | null = null, closed = false, poisoned = false;
  function directories(create = false): void {
    let current = path.parse(folder).root; const result: { dev: bigint; ino: bigint }[] = [];
    const inspect = (): void => { const s = fs.lstatSync(current, { bigint: true }); if (!s.isDirectory() || s.isSymbolicLink() || path.resolve(fs.realpathSync.native(current)).toLowerCase() !== current.toLowerCase()) fail('STORAGE_FAILED'); result.push({ dev: s.dev, ino: s.ino }); };
    inspect();
    for (const part of folder.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      try { inspect(); } catch (e) {
        if (!create || (e as NodeJS.ErrnoException).code !== 'ENOENT' || !current.toLowerCase().startsWith(base.toLowerCase() + path.sep)) throw e;
        try { fs.mkdirSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } inspect();
      }
    }
    if (directoriesStamp && !equal(result, directoriesStamp)) fail('STORAGE_FAILED'); directoriesStamp ??= result;
  }
  function read(file: string, limit: number): ReadFile | null {
    directories(); let before: fs.BigIntStats;
    try { before = fs.lstatSync(file, { bigint: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) fail('STORAGE_FAILED');
    const fd = fs.openSync(file, 'r');
    try {
      const opened = fs.fstatSync(fd, { bigint: true }); if (!opened.isFile() || opened.nlink !== 1n || !equal(stamp(before), stamp(opened))) fail('STORAGE_FAILED');
      const buffer = Buffer.alloc(Number(opened.size) + 1); let length = 0;
      while (length < buffer.length) { const n = fs.readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
      const afterFd = fs.fstatSync(fd, { bigint: true }), after = fs.lstatSync(file, { bigint: true }); directories();
      if (length !== Number(opened.size) || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !equal(stamp(opened), stamp(afterFd)) || !equal(stamp(opened), stamp(after))) fail('STORAGE_FAILED');
      return { data: buffer.subarray(0, length), stamp: stamp(after) };
    } finally { fs.closeSync(fd); }
  }
  const sameFile = (a: ReadFile | null, b: ReadFile | null): boolean => a === null || b === null ? a === b : equal(a.stamp, b.stamp) && a.data.equals(b.data);
  function writeNew(file: string, data: Buffer): ReadFile {
    directories(); const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const written = read(file, Math.max(data.length, 1024)); if (!written || !written.data.equals(data)) fail('STORAGE_FAILED'); return written;
  }
  function owns(): boolean { const current = read(lock, 1024); return current !== null && equal(current.stamp, ownStamp) && current.data.equals(ownBytes); }
  function acquire(): void {
    try { ownStamp = writeNew(lock, ownBytes).stamp; return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const stale = read(lock, 1024); if (!stale) fail('BUSY');
    const old = lockData(stale.data); if (!dead(old.pid)) fail('BUSY');
    let claim: string | null = null, claimFile: ReadFile | null = null;
    // An exclusive claim tied to the old nonce serializes stale-lock removal.
    // Dead claim owners advance bounded slots; a live/reused/unknown PID blocks.
    for (let slot = 0; slot < RECOVERY_CLAIM_SLOTS; slot++) {
      const candidate = path.join(folder, `recovery-${old.nonce}-${slot}.lock`);
      try { claimFile = writeNew(candidate, ownBytes); claim = candidate; break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const held = read(candidate, 1024); if (!held || !dead(lockData(held.data).pid)) fail('BUSY');
      }
    }
    if (!claim || !claimFile) fail('STORAGE_FAILED');
    try {
      if (!sameFile(stale, read(lock, 1024)) || !dead(old.pid) || !sameFile(claimFile, read(claim, 1024))) fail('BUSY');
      fs.unlinkSync(lock);
      try { ownStamp = writeNew(lock, ownBytes).stamp; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('BUSY'); throw e; }
    } finally {
      // Only this live process owns this claim; never delete another claimant.
      if (sameFile(claimFile, read(claim, 1024))) fs.unlinkSync(claim);
    }
  }
  try { directories(true); acquire(); } catch (e) { if (e instanceof ProjectReadStoreError && e.code === 'BUSY') throw e; throw new ProjectReadStoreError(); }
  return Object.freeze({
    load(): ProjectReadDisk {
      try {
        if (closed || poisoned || !owns()) fail('STORAGE_FAILED');
        const data = read(target, L.diskBytes);
        if (previous && !sameFile(expected, data)) fail('STORAGE_FAILED');
        const disk = checkedDisk(data === null ? { version: 1, runs: [] } : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.data)));
        expected = data; previous = disk; return disk;
      } catch { poisoned = true; throw new ProjectReadStoreError(); }
    },
    save(value: ProjectReadDisk): void {
      if (closed || poisoned || !previous) throw new ProjectReadStoreError();
      const next = checkedDisk(value); admission(next); checkUpdate(previous, next);
      let temporary: string | null = null, temporaryFile: ReadFile | null = null;
      try {
        if (!owns() || !sameFile(expected, read(target, L.diskBytes))) fail('STORAGE_FAILED');
        const data = Buffer.from(JSON.stringify(next)); temporary = path.join(folder, `.runs-${randomUUID()}.tmp`); temporaryFile = writeNew(temporary, data);
        if (!owns() || !sameFile(expected, read(target, L.diskBytes)) || !sameFile(temporaryFile, read(temporary, L.diskBytes))) fail('STORAGE_FAILED');
        fs.renameSync(temporary, target); temporary = null;
        const committed = read(target, L.diskBytes);
        if (!owns() || !committed || !committed.data.equals(data)) fail('STORAGE_FAILED');
        expected = committed; previous = next;
      } catch { poisoned = true; throw new ProjectReadStoreError(); }
      finally { if (temporary && temporaryFile) { try { if (sameFile(temporaryFile, read(temporary, L.diskBytes))) fs.unlinkSync(temporary); } catch { /* Unknown files are retained, never treated as committed. */ } } }
    },
    close(): void { if (closed) return; try { if (owns()) fs.unlinkSync(lock); } catch { /* Preserve unknown or foreign locks. */ } closed = true; },
  });
}
