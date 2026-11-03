import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type * as C from '../apps/desktop/src/shared/agent/agent-project-read';
import type { FolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import {
  createProjectReadStore, parseProjectReadDisk, recoverProjectReadDisk, listProjectReadRuns, readProjectReadPage,
  resolveStoredProjectReadCitation, deleteStoredProjectReadRun, ProjectReadStoreError,
  type ProjectReadDisk, type ProjectReadStoredRun, type ProjectReadStoredCitation,
} from '../apps/desktop/src/main/agent-project-read/store';

const productRoot = path.resolve('C:/work/analog_ai_workbench'), time = '2026-09-11T12:00:00.000Z', later = '2026-09-11T12:01:00.000Z';
const hash = (v: string): string => createHash('sha256').update(v).digest('hex');
const sourceRoot: FolderRoot = { projectId: 'project_1', bindingId: 'binding_1', root: 'Q:\\Synthetic\\A12-Source', chain: [{ dev: '1', ino: '10' }, { dev: '1', ino: '11' }, { dev: '1', ino: '12' }] };
const project: C.ProjectReadRef = { projectId: 'project_1', bindingId: 'binding_1', name: 'Synthetic', directoryName: 'A12-Source', directorySegments: ['Q', 'Synthetic', 'A12-Source'], identity: 'root_1' };
const model: C.ProjectReadModel = { provider: 'deepseek', model: 'deepseek-v4-flash' };
const budget: C.ProjectReadBudget = { providerAttempts: 24, httpDispatches: 24, toolAttempts: 64, physicalReadBytes: 268435456, visitedCandidates: 100000, contextBytes: 196608, outputBytes: 65536, maxOutputTokens: 16384, deadlineMs: 14400000, waitMs: 1800000 };
const zero: C.ProjectReadAccounting = { providerAttempts: 0, httpDispatches: 0, toolAttempts: 0, physicalReadBytes: 0, visitedCandidates: 0, contextBytes: null };
const event = (runId: string, sequence: number, type: keyof C.ProjectReadEventData, data: unknown, at = time): C.ProjectReadEvent => ({ runId, sequence, time: at, type, data }) as C.ProjectReadEvent;
function makeRun(runId = 'run_1', options: { preparing?: boolean; running?: boolean; citation?: boolean; ruleCopies?: number } = {}): ProjectReadStoredRun {
  const events: C.ProjectReadEvent[] = [], citations: ProjectReadStoredCitation[] = [];
  const add = (type: keyof C.ProjectReadEventData, data: unknown) => events.push(event(runId, events.length + 1, type, data));
  let accounting = zero;
  add('run.accepted', { project, model, continuedFrom: null, budget });
  for (let i = 0; i < (options.ruleCopies ?? 0); i++) add('project.rules', { rules: [{ source: 'AGENTS.md', relativeDirectory: '', state: 'loaded', version: hash('r'.repeat(8000)), normalizedSha256: hash('r'.repeat(8000)), text: 'r'.repeat(8000) }] });
  if (!options.preparing) {
    add('run.started', { sessionId: 'session_' + runId, engine: 'opencode', version: '1.18.17' });
    add('model.step', { step: 1 }); add('model.response', { request: 1, responseModel: 'deepseek-flash', usage: null });
    add('message.delta', { messageId: 'message_' + runId, step: 1, text: 'Synthetic response.' });
    accounting = { ...zero, providerAttempts: 1, httpDispatches: 1, contextBytes: 500 };
    if (options.citation) {
      const text = 'evidence 😀', fileIdentity = hash(JSON.stringify({ dev: '1', ino: '13' }));
      const c: C.ProjectReadCitation = { citationId: 'citation_' + runId, runId, project, snapshotId: 'snapshot_' + runId, fileId: 'file_' + runId, fileIdentity, relativePath: 'notes.md', version: hash(text), normalizedSha256: hash(text), range: { start: { line: 1, column: 1 }, end: { line: 1, column: 11 } }, excerpt: text, excerptSha256: hash(text), totalLines: 1, fileBytes: Buffer.byteLength(text), source: 'read', createdAt: time, origin: null };
      citations.push({ citation: c, file: { absolutePath: sourceRoot.root + '\\notes.md', relativePath: 'notes.md', chain: [...sourceRoot.chain, { dev: '1', ino: '13' }], dev: '1', ino: '13', size: c.fileBytes, mtimeNs: '100', ctimeNs: '101', fileIdentity } });
      const { runId: _r, project: _p, snapshotId: _s, fileIdentity: _f, createdAt: _c, origin: _o, ...preview } = c;
      const call = { sessionId: 'session_' + runId, messageId: 'message_' + runId, callId: 'call_' + runId, toolName: 'project_read', arguments: { fileId: c.fileId, version: c.version, start: c.range.start, cursor: null } };
      add('tool.started', call);
      add('tool.completed', { ...call, result: { ok: true, value: { kind: 'read', phase: 'data', snapshotId: c.snapshotId, coverage: { scope: { projectId: project.projectId, bindingId: project.bindingId, identity: project.identity, directoryId: null, relativeDirectory: '' }, complete: true, scannedCandidates: 1, scannedFiles: 1, scannedBytes: c.fileBytes, returned: 1, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 0, position: null }, nextCursor: null, limitReason: null }, rules: [], resume: null, citation: preview, empty: false, next: null } } });
      accounting = { ...accounting, toolAttempts: 1, physicalReadBytes: c.fileBytes * 2, visitedCandidates: 1 };
    }
    add('budget.updated', accounting);
    if (!options.running) { add('cleanup.started', { reason: 'completed' }); add('cleanup.completed', { outcome: 'confirmed' }); add('run.completed', { citations: citations.map(c => c.citation.citationId) }); }
  }
  return { root: sourceRoot, citations, run: { runId, clientRequestId: 'client_' + runId, project, model, goal: 'Inspect synthetic evidence.', constraint: '', continuedFrom: null, status: options.preparing ? 'preparing' : options.running ? 'running' : 'completed', cleanupState: 'idle', createdAt: time, updatedAt: time, accounting, eventCount: events.length, continuation: null, events } };
}
const disk = (...runs: ProjectReadStoredRun[]): ProjectReadDisk => ({ version: 1, runs });
function changed(stored: ProjectReadStoredRun, index: number, data: unknown): ProjectReadStoredRun {
  return { ...stored, run: { ...stored.run, events: stored.run.events.map((e, i) => i === index ? { ...e, data } as C.ProjectReadEvent : e) } };
}
function child(parent: ProjectReadStoredRun, runId: string): ProjectReadStoredRun {
  const value = makeRun(runId), p = parent.citations[0];
  const citations = p ? [{ citation: { ...p.citation, runId, citationId: 'inherited_' + runId, fileId: 'newfile_' + runId, snapshotId: 'newsnapshot_' + runId, origin: { runId: parent.run.runId, citationId: p.citation.citationId } }, file: p.file }] : [];
  return { ...value, citations, run: { ...value.run, continuedFrom: parent.run.runId, continuation: { fromRunId: parent.run.runId, evidenceCount: citations.length, confirmedQuestions: 0, resumedFilePositions: 0, restartedQueries: 0 }, events: value.run.events.map(e => e.type === 'run.accepted' ? { ...e, data: { ...e.data, continuedFrom: parent.run.runId } } : e.type === 'run.completed' ? { ...e, data: { citations: citations.map(c => c.citation.citationId) } } : e) } };
}
function isolated(): { base: string; directory: string; cleanup(): void } {
  const base = path.join(productRoot, '.local', 'agent-project-read-tests', randomUUID()), directory = path.join(base, 'agent-project-read');
  return { base, directory, cleanup() { const resolved = path.resolve(base); if (!resolved.startsWith(path.join(productRoot, '.local', 'agent-project-read-tests') + path.sep) || !/^[0-9a-f-]{36}$/u.test(path.basename(resolved))) throw new Error('Unsafe test cleanup'); fs.rmSync(resolved, { recursive: true, force: true }); } };
}
const errorCode = (expected: string) => (e: unknown): boolean => e instanceof ProjectReadStoreError && e.code === expected;
const bootstrap = 'const fs=require("node:fs"),ts=require("typescript");require.extensions[".ts"]=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023,esModuleInterop:true}}).outputText,f);const api=require("./apps/desktop/src/main/agent-project-read/store.ts");const input=JSON.parse(fs.readFileSync(0,"utf8"));';
function crashWriter(directory: string, value: ProjectReadDisk): number {
  const source = bootstrap + 'const s=api.createProjectReadStore(input.root,input.directory);s.load();s.save(input.disk);process.stdout.write(String(process.pid));process.exit(0);';
  const result = spawnSync(process.execPath, ['-e', source], { cwd: productRoot, input: JSON.stringify({ root: productRoot, directory, disk: value }), encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); const pid = Number(result.stdout); assert.ok(Number.isSafeInteger(pid) && pid > 0); return pid;
}

test('strict stored authority is validated and frozen without any source path filesystem access', () => {
  const fixture = disk(makeRun('evidence', { citation: true }));
  const original = Object.getOwnPropertyDescriptor(fs, 'lstatSync')!; let reads = 0;
  Object.defineProperty(fs, 'lstatSync', { ...original, value() { reads++; throw new Error('No OS lookup permitted'); } });
  try { const parsed = parseProjectReadDisk(fixture); assert.ok(parsed); assert.equal(reads, 0); assert.ok(parsed.runs[0]!.root); assert.ok(Object.isFrozen(parsed.runs[0]!.root.chain)); assert.ok(Object.isFrozen(parsed.runs[0]!.citations[0]!.file)); assert.notEqual(parsed, fixture); }
  finally { Object.defineProperty(fs, 'lstatSync', original); }
  const s = fixture.runs[0]!, c = s.citations[0]!;
  for (const file of [{ ...c.file, absolutePath: 'C:\\outside\\notes.md' }, { ...c.file, relativePath: '../notes.md' }, { ...c.file, ino: '14' }, { ...c.file, chain: c.file.chain.slice(1) }, { ...c.file, size: c.file.size + 1 }, { ...c.file, mtimeNs: 'NaN' }, { ...c.file, ctimeNs: Infinity }, { ...c.file, fileIdentity: 'a'.repeat(64) }]) assert.equal(parseProjectReadDisk(disk({ ...s, citations: [{ ...c, file }] } as ProjectReadStoredRun)), null);
  assert.equal(parseProjectReadDisk(disk({ ...s, citations: [{ ...c, citation: { ...c.citation, excerptSha256: 'a'.repeat(64) } }] })), null);
  assert.equal(parseProjectReadDisk(disk({ ...s, root: { ...sourceRoot, root: 'Q:\\Other\\A12-Source' } })), null);
});

test('disk schemas reject unknown fields, aliases, accessors, mixed versions and malformed lifecycle facts', () => {
  const s = makeRun();
  let invoked = false; const accessor = Object.defineProperty({}, 'run', { enumerable: true, get() { invoked = true; return s.run; } });
  for (const invalid of [{ version: 2, runs: [] }, { ...disk(s), canonical: {} }, disk({ ...s, canonical: {} } as ProjectReadStoredRun), disk({ ...s, run: { ...s.run, status: 'running' } }), disk({ ...s, run: { ...s.run, eventCount: 1 } }), disk({ ...s, run: { ...s.run, cleanupState: 'pending' } }), { version: 1, runs: [accessor] }, Object.assign(Object.create(null), disk(s))]) assert.equal(parseProjectReadDisk(invalid), null);
  assert.equal(invoked, false);
  assert.equal(parseProjectReadDisk(disk(changed(s, 3, { request: 2, responseModel: null, usage: null }))), null);
  assert.equal(parseProjectReadDisk(disk(changed(s, 7, { outcome: 'failed' }))), null);
  assert.equal(parseProjectReadDisk(disk({ ...s, run: { ...s.run, events: [...s.run.events, event(s.run.runId, 10, 'message.delta', { messageId: 'late', step: 1, text: 'late' })], eventCount: 10 } })), null);
});

test('question answers remain waiting until a matching durable delivery event', () => {
  const s = makeRun('question', { running: true }), run = s.run;
  const asked = event(run.runId, run.eventCount + 1, 'question.asked', { questionId: 'q_1', prompt: 'Which section?' });
  const answered = event(run.runId, run.eventCount + 2, 'question.answered', { questionId: 'q_1', answer: 'Second.' });
  const waiting = { ...s, run: { ...run, status: 'waiting_user' as const, events: [...run.events, asked, answered], eventCount: run.eventCount + 2 } };
  assert.ok(parseProjectReadDisk(disk(waiting)));
  assert.equal(parseProjectReadDisk(disk({ ...waiting, run: { ...waiting.run, status: 'running' } })), null);
  const delivered = event(run.runId, run.eventCount + 3, 'question.delivered', { questionId: 'q_1' });
  assert.ok(parseProjectReadDisk(disk({ ...waiting, run: { ...waiting.run, status: 'running', events: [...waiting.run.events, delivered], eventCount: run.eventCount + 3 } })));
  assert.equal(parseProjectReadDisk(disk({ ...waiting, run: { ...waiting.run, events: [...waiting.run.events, { ...delivered, data: { questionId: 'other' } } as C.ProjectReadEvent], eventCount: run.eventCount + 3 } })), null);
});

test('recovery appends interruption and failed cleanup without replay or evidence rewriting', () => {
  const s = makeRun('active', { running: true, citation: true }), result = recoverProjectReadDisk(disk(s), later), run = result.runs[0]!.run;
  assert.equal(run.status, 'interrupted'); assert.equal(run.cleanupState, 'failed');
  assert.deepEqual(run.events.slice(-3).map(e => e.type), ['cleanup.started', 'run.interrupted', 'cleanup.completed']);
  assert.deepEqual(run.events.at(-1)!.data, { outcome: 'failed' });
  assert.deepEqual(run.events.slice(0, s.run.eventCount), s.run.events); assert.deepEqual(result.runs[0]!.citations, s.citations);
  assert.deepEqual(recoverProjectReadDisk(result, later), result);
  const pending = { ...s, run: { ...s.run, cleanupState: 'pending' as const, events: [...s.run.events, event(s.run.runId, s.run.eventCount + 1, 'cleanup.started', { reason: 'close' })], eventCount: s.run.eventCount + 1 } };
  const resumed = recoverProjectReadDisk(disk(pending), later).runs[0]!.run;
  assert.deepEqual(resumed.events.slice(0, pending.run.eventCount), pending.run.events);
  assert.deepEqual(resumed.events.slice(-2).map(e => e.type), ['run.interrupted', 'cleanup.completed']);
  assert.equal(resumed.cleanupState, 'failed');
  const preparing = recoverProjectReadDisk(disk(makeRun('prepare', { preparing: true })), later).runs[0]!.run;
  assert.equal(preparing.events.length, 2); assert.equal(preparing.cleanupState, 'idle');
  const confirmed = event(run.runId, run.eventCount + 1, 'cleanup.completed', { outcome: 'confirmed' }, later);
  assert.equal(parseProjectReadDisk(disk({ ...result.runs[0]!, run: { ...run, cleanupState: 'idle', events: [...run.events, confirmed], eventCount: run.eventCount + 1 } })), null);
});

test('absent rule metadata has an independent directory limit while loaded rules remain bounded', () => {
  const initial = makeRun('absent_rules', { preparing: true });
  const fixture = (absent: number, loaded: number): ProjectReadDisk => {
    const rules: C.ProjectReadRule[] = [
      ...Array.from({ length: loaded }, (_, n) => ({ source: `loaded${n}/AGENTS.md`, relativeDirectory: `loaded${n}`, state: 'loaded' as const, version: hash('loaded version ' + n), normalizedSha256: hash('x'), text: 'x' })),
      ...Array.from({ length: absent }, (_, n) => ({ source: `absent${n}/AGENTS.md`, relativeDirectory: `absent${n}`, state: 'absent' as const, version: null, normalizedSha256: null, text: null })),
    ];
    const events = [...initial.run.events];
    for (let at = 0; at < rules.length; at += 16) events.push(event(initial.run.runId, events.length + 1, 'project.rules', { rules: rules.slice(at, at + 16) }));
    return disk({ ...initial, run: { ...initial.run, events, eventCount: events.length } });
  };
  assert.ok(parseProjectReadDisk(fixture(40, 0)));
  assert.ok(parseProjectReadDisk(fixture(4096, 16)));
  assert.equal(parseProjectReadDisk(fixture(4097, 16)), null);
  assert.equal(parseProjectReadDisk(fixture(40, 17)), null);
});

test('recovered terminal pending cleanup becomes failed and is deletable only after retention is released', () => {
  const s = makeRun('terminal_pending', { running: true }), events = [...s.run.events,
    event(s.run.runId, s.run.eventCount + 1, 'cleanup.started', { reason: 'stop' }),
    event(s.run.runId, s.run.eventCount + 2, 'run.stopped', { reason: 'user' }),
  ];
  const pending: ProjectReadStoredRun = { ...s, run: { ...s.run, status: 'stopped', cleanupState: 'pending', events, eventCount: events.length } };
  assert.deepEqual(deleteStoredProjectReadRun(disk(s), s.run.runId, s.run.eventCount, []), { ok: false, error: { code: 'BUSY' } });
  assert.deepEqual(deleteStoredProjectReadRun(disk(pending), s.run.runId, events.length, []), { ok: false, error: { code: 'BUSY' } });
  const i = isolated(), store = createProjectReadStore(productRoot, i.directory);
  try {
    store.load(); store.save(disk(pending)); assert.throws(() => store.save(disk()), errorCode('BUSY'));
    const recovered = recoverProjectReadDisk(store.load(), later), failed = recovered.runs[0]!;
    assert.equal(failed.run.status, 'stopped'); assert.equal(failed.run.cleanupState, 'failed');
    assert.equal(failed.run.eventCount, pending.run.eventCount + 1);
    assert.deepEqual(failed.run.events.slice(0, pending.run.eventCount), events);
    assert.equal(failed.run.events.at(-1)!.type, 'cleanup.completed'); assert.deepEqual(failed.run.events.at(-1)!.data, { outcome: 'failed' });
    assert.deepEqual(recoverProjectReadDisk(recovered, later), recovered); store.save(recovered);
    assert.deepEqual(deleteStoredProjectReadRun(recovered, s.run.runId, failed.run.eventCount, [s.run.runId]), { ok: false, error: { code: 'BUSY' } });
    assert.deepEqual(deleteStoredProjectReadRun(recovered, s.run.runId, pending.run.eventCount, []), { ok: false, error: { code: 'CONFLICT' } });
    assert.equal(parseProjectReadDisk(disk(failed, child(failed, 'forbidden_continuation'))), null);
    const independent = makeRun('independent_restart', { preparing: true }), restarted = disk(failed, independent); store.save(restarted);
    const deleted = deleteStoredProjectReadRun(store.load(), s.run.runId, failed.run.eventCount, []); assert.ok(deleted.ok); store.save(deleted.value);
    assert.deepEqual(store.load().runs.map(r => r.run.runId), [independent.run.runId]);
  } finally { store.close(); i.cleanup(); }
});

test('read/list/resolve helpers are bounded projections and never expose locators', () => {
  const s = makeRun('history', { citation: true, ruleCopies: 40 }), value = disk(s), seen: C.ProjectReadEvent[] = [];
  let after = 0;
  while (after < s.run.eventCount) {
    const result = readProjectReadPage(value, s.run.runId, after); assert.ok(result.ok);
    assert.ok(result.value.events.length <= 64); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 262144);
    assert.ok(result.value.nextAfter > after); seen.push(...result.value.events); after = result.value.nextAfter;
    assert.equal(result.value.hasMore, after < s.run.eventCount);
  }
  assert.deepEqual(seen, s.run.events);
  assert.ok(readProjectReadPage(value, s.run.runId, s.run.eventCount).ok);
  assert.deepEqual(readProjectReadPage(value, s.run.runId, s.run.eventCount + 1), { ok: false, error: { code: 'CONFLICT' } });
  assert.deepEqual(readProjectReadPage(value, 'missing', 0), { ok: false, error: { code: 'RUN_NOT_FOUND' } });
  const list = listProjectReadRuns(value, project.projectId, null); assert.ok(list.ok); assert.equal('root' in list.value.runs[0]!, false);
  assert.deepEqual(listProjectReadRuns(value, 'another_project', null), { ok: true, value: { runs: [], nextBefore: null } });
  const citation = resolveStoredProjectReadCitation(value, s.run.runId, s.citations[0]!.citation.citationId); assert.ok(citation.ok); assert.equal('absolutePath' in citation.value, false);
});

test('dependencies include the entire descendant chain and deletion preserves unrelated runs', () => {
  const parent = makeRun('parent', { citation: true }), middle = child(parent, 'middle'), leaf = child(middle, 'leaf'), unrelated = makeRun('unrelated');
  const value = disk(parent, middle, leaf, unrelated); assert.ok(parseProjectReadDisk(value));
  assert.deepEqual(deleteStoredProjectReadRun(value, 'parent', parent.run.eventCount, []), { ok: false, error: { code: 'RUN_HAS_DEPENDENTS', dependentRunIds: ['middle','leaf'] } });
  assert.deepEqual(deleteStoredProjectReadRun(value, 'leaf', leaf.run.eventCount, ['leaf']), { ok: false, error: { code: 'BUSY' } });
  assert.deepEqual(deleteStoredProjectReadRun(value, 'leaf', leaf.run.eventCount - 1, []), { ok: false, error: { code: 'CONFLICT' } });
  const deleted = deleteStoredProjectReadRun(value, 'leaf', leaf.run.eventCount, []); assert.ok(deleted.ok); assert.deepEqual(deleted.value.runs.map(r => r.run.runId), ['parent','middle','unrelated']);
  assert.deepEqual(value.runs.map(r => r.run.runId), ['parent','middle','leaf','unrelated']);
  assert.equal(parseProjectReadDisk(disk(middle)), null);
  assert.equal(parseProjectReadDisk(disk(parent, { ...middle, run: { ...middle.run, goal: 'Changed goal' } })), null);
});

test('tool evidence requires a matching call and immutable citation metadata', () => {
  const s = makeRun('proof', { citation: true }), at = s.run.events.findIndex(e => e.type === 'tool.completed');
  assert.equal(parseProjectReadDisk(disk({ ...s, citations: [] })), null);
  const completed = s.run.events[at]!; assert.equal(completed.type, 'tool.completed');
  if (completed.type === 'tool.completed') assert.equal(parseProjectReadDisk(disk(changed(s, at, { ...completed.data, callId: 'forged' }))), null);
  assert.equal(parseProjectReadDisk(disk({ ...s, run: { ...s.run, accounting: { ...s.run.accounting, toolAttempts: 0 } } })), null);
});

test('exclusive writer reload, application path fences and external edits fail closed', () => {
  const i = isolated();
  try {
    const store = createProjectReadStore(productRoot, i.directory); assert.deepEqual(store.load(), disk()); store.save(disk(makeRun()));
    assert.throws(() => createProjectReadStore(productRoot, i.directory), errorCode('BUSY')); store.close();
    const reopened = createProjectReadStore(productRoot, i.directory); assert.equal(reopened.load().runs.length, 1);
    fs.writeFileSync(path.join(i.directory, 'runs.json'), 'malformed isolated data');
    assert.throws(() => reopened.save(disk(makeRun())), errorCode('STORAGE_FAILED')); assert.throws(() => reopened.load(), errorCode('STORAGE_FAILED')); reopened.close();
    assert.equal(fs.readFileSync(path.join(i.directory, 'runs.json'), 'utf8'), 'malformed isolated data');
    assert.throws(() => createProjectReadStore(productRoot, path.join(productRoot, '.local', 'chat-history')), errorCode('CAPABILITY_DENIED'));
  } finally { i.cleanup(); }
});

test('capacity and invalid updates do not poison a healthy writer or silently delete history', () => {
  const i = isolated(), store = createProjectReadStore(productRoot, i.directory);
  try {
    store.load(); const runs = Array.from({ length: 32 }, (_, n) => makeRun('history_' + n)); store.save(disk(...runs));
    assert.throws(() => store.save(disk(...runs, makeRun('overflow'))), errorCode('HISTORY_FULL'));
    assert.equal(store.load().runs.length, 32);
    assert.throws(() => store.save(disk(...runs.slice(2))), errorCode('CONFLICT'));
    const removed = deleteStoredProjectReadRun(store.load(), runs[0]!.run.runId, runs[0]!.run.eventCount, []); assert.ok(removed.ok); store.save(removed.value);
    store.save(disk(...removed.value.runs, makeRun('replacement'))); assert.equal(store.load().runs.length, 32);
  } finally { store.close(); i.cleanup(); }
});

test('active admission reserves terminal and cleanup event slots, allowing interruption at the boundary', () => {
  const i = isolated(), store = createProjectReadStore(productRoot, i.directory);
  try {
    store.load(); const initial = makeRun('near_limit', { running: true }), events = [...initial.run.events];
    while (events.length < 1020) events.push(event(initial.run.runId, events.length + 1, 'budget.updated', initial.run.accounting));
    const near = disk({ ...initial, run: { ...initial.run, events, eventCount: events.length } }); store.save(near);
    const overflow = { ...near.runs[0]!, run: { ...near.runs[0]!.run, events: [...events, event(initial.run.runId, 1021, 'budget.updated', initial.run.accounting)], eventCount: 1021 } };
    assert.throws(() => store.save(disk(overflow)), errorCode('BUDGET_EXCEEDED'));
    const recovered = recoverProjectReadDisk(near, later); store.save(recovered); assert.equal(store.load().runs[0]!.run.status, 'interrupted'); assert.equal(store.load().runs[0]!.run.cleanupState, 'failed'); assert.equal(store.load().runs[0]!.run.eventCount, 1023);
  } finally { store.close(); i.cleanup(); }
});

test('crashed writer lock is reclaimed only after its controlled Node process has exited', () => {
  const i = isolated();
  try {
    const value = disk(makeRun('crashed', { running: true, citation: true })), pid = crashWriter(i.directory, value);
    const oldLock = JSON.parse(fs.readFileSync(path.join(i.directory, 'writer.lock'), 'utf8')); assert.equal(oldLock.pid, pid);
    const store = createProjectReadStore(productRoot, i.directory);
    try { const loaded = store.load(); assert.deepEqual(loaded, value); const recovered = recoverProjectReadDisk(loaded, later); store.save(recovered); assert.equal(store.load().runs[0]!.run.status, 'interrupted'); assert.equal(store.load().runs[0]!.run.cleanupState, 'failed'); }
    finally { store.close(); }
  } finally { i.cleanup(); }
});

test('a delayed second recovery cannot unlink the successful new writer lock', async () => {
  const i = isolated(); let current: ReturnType<typeof createProjectReadStore> | null = null;
  try {
    const stalePid = crashWriter(i.directory, disk(makeRun('race', { preparing: true }))), ready = path.join(i.base, 'ready'), proceed = path.join(i.base, 'proceed');
    const source = bootstrap + 'const original=process.kill;let held=false;process.kill=function(pid,signal){try{return original(pid,signal)}catch(e){if(pid===input.stalePid&&!held&&e.code==="ESRCH"){held=true;fs.writeFileSync(input.ready,"ready");const until=Date.now()+10000;while(!fs.existsSync(input.proceed)){if(Date.now()>until)throw Error("bounded wait expired");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}}throw e}};try{const s=api.createProjectReadStore(input.root,input.directory);s.close();process.stdout.write("UNEXPECTED_SUCCESS")}catch(e){process.stdout.write(e.code||"ERROR")}';
    const contender = spawn(process.execPath, ['-e', source], { cwd: productRoot, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let output = '', errors = ''; contender.stdout.setEncoding('utf8'); contender.stderr.setEncoding('utf8'); contender.stdout.on('data', s => output += s); contender.stderr.on('data', s => errors += s);
    const ended = new Promise<number | null>((resolve, reject) => { contender.once('error', reject); contender.once('exit', resolve); });
    contender.stdin.end(JSON.stringify({ root: productRoot, directory: i.directory, stalePid, ready, proceed }));
    const deadline = Date.now() + 10000; while (!fs.existsSync(ready)) { assert.ok(Date.now() < deadline, errors); await delay(20); }
    current = createProjectReadStore(productRoot, i.directory); const value = current.load();
    const winner = fs.readFileSync(path.join(i.directory, 'writer.lock'), 'utf8'); fs.writeFileSync(proceed, 'go');
    assert.equal(await ended, 0, errors); assert.equal(output, 'BUSY');
    assert.equal(fs.readFileSync(path.join(i.directory, 'writer.lock'), 'utf8'), winner); current.save(value); assert.deepEqual(current.load(), value);
  } finally { current?.close(); i.cleanup(); }
});

test('malformed, live or changed locks and oversized or linked ledgers are never adopted', () => {
  const i = isolated();
  try {
    const store = createProjectReadStore(productRoot, i.directory); store.load(); store.save(disk());
    const lock = path.join(i.directory, 'writer.lock'), target = path.join(i.directory, 'runs.json');
    fs.writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID(), createdAt: time }));
    assert.throws(() => store.save(disk()), errorCode('STORAGE_FAILED')); store.close(); assert.ok(fs.existsSync(lock));
    assert.throws(() => createProjectReadStore(productRoot, i.directory), errorCode('BUSY'));
    fs.writeFileSync(lock, '{}'); assert.throws(() => createProjectReadStore(productRoot, i.directory), errorCode('STORAGE_FAILED')); fs.unlinkSync(lock);
    fs.truncateSync(target, 67108865); const oversized = createProjectReadStore(productRoot, i.directory); try { assert.throws(() => oversized.load(), errorCode('STORAGE_FAILED')); } finally { oversized.close(); }
    fs.writeFileSync(target, JSON.stringify(disk())); fs.linkSync(target, path.join(i.base, 'hardlink'));
    const linked = createProjectReadStore(productRoot, i.directory); try { assert.throws(() => linked.load(), errorCode('STORAGE_FAILED')); } finally { linked.close(); }
  } finally { i.cleanup(); }
});

test('a dead recovery claim advances one bounded slot, while an unconfirmable PID blocks recovery', () => {
  const i = isolated();
  try {
    const value = disk(makeRun('claim', { preparing: true })); crashWriter(i.directory, value);
    const writer = JSON.parse(fs.readFileSync(path.join(i.directory, 'writer.lock'), 'utf8'));
    const deadClaim = path.join(i.directory, `recovery-${writer.nonce}-0.lock`);
    fs.writeFileSync(deadClaim, JSON.stringify({ ...writer, nonce: randomUUID() }));
    const recovered = createProjectReadStore(productRoot, i.directory);
    try { assert.deepEqual(recovered.load(), value); assert.ok(fs.existsSync(deadClaim)); assert.equal(fs.existsSync(path.join(i.directory, `recovery-${writer.nonce}-1.lock`)), false); }
    finally { recovered.close(); }
    crashWriter(i.directory, value); const before = fs.readFileSync(path.join(i.directory, 'writer.lock'), 'utf8');
    const original = Object.getOwnPropertyDescriptor(process, 'kill')!;
    Object.defineProperty(process, 'kill', { ...original, value() { throw Object.assign(new Error('controlled unknown status'), { code: 'EPERM' }); } });
    try { assert.throws(() => createProjectReadStore(productRoot, i.directory), errorCode('BUSY')); }
    finally { Object.defineProperty(process, 'kill', original); }
    assert.equal(fs.readFileSync(path.join(i.directory, 'writer.lock'), 'utf8'), before);
  } finally { i.cleanup(); }
});

test('an external inode replacement is rejected even when every JSON byte is identical', () => {
  const i = isolated(), store = createProjectReadStore(productRoot, i.directory);
  try {
    store.load(); store.save(disk(makeRun('identity')));
    const target = path.join(i.directory, 'runs.json'), replacement = path.join(i.directory, 'controlled-replacement.json');
    for (const candidate of [target, replacement]) assert.ok(path.resolve(candidate).startsWith(path.resolve(i.base) + path.sep));
    const before = fs.statSync(target, { bigint: true }), data = fs.readFileSync(target);
    fs.writeFileSync(replacement, data); fs.renameSync(replacement, target);
    assert.notEqual(fs.statSync(target, { bigint: true }).ino, before.ino);
    assert.throws(() => store.save(disk(makeRun('identity'))), errorCode('STORAGE_FAILED'));
    assert.deepEqual(fs.readFileSync(target), data);
  } finally { store.close(); i.cleanup(); }
});

test('a valid near-two-MiB active record cannot consume the bytes reserved for a terminal tail', () => {
  const i = isolated(), store = createProjectReadStore(productRoot, i.directory);
  try {
    store.load(); const initial = makeRun('byte_limit', { preparing: true }), text = 'r'.repeat(6000);
    const data = { rules: [{ source: 'AGENTS.md', relativeDirectory: '', state: 'loaded', version: hash(text), normalizedSha256: hash(text), text }] };
    const target = 2097151, entryBytes = Buffer.byteLength(JSON.stringify(event(initial.run.runId, 2, 'project.rules', data))) + 1;
    let copies = Math.floor((target - Buffer.byteLength(JSON.stringify(initial))) / entryBytes);
    const build = (count: number): ProjectReadStoredRun => {
      const events = [initial.run.events[0]!, ...Array.from({ length: count }, (_, n) => event(initial.run.runId, n + 2, 'project.rules', data))];
      return { ...initial, run: { ...initial.run, events, eventCount: events.length } };
    };
    let near = build(copies); while (Buffer.byteLength(JSON.stringify(near)) > target) near = build(--copies);
    const deficit = target - Buffer.byteLength(JSON.stringify(near)), constraint = 'c'.repeat(Math.min(deficit, 4096));
    near = { ...near, run: { ...near.run, constraint, goal: near.run.goal + 'g'.repeat(deficit - constraint.length) } };
    assert.equal(Buffer.byteLength(JSON.stringify(near)), target); assert.ok(parseProjectReadDisk(disk(near)));
    assert.throws(() => store.save(disk(near)), errorCode('BUDGET_EXCEEDED'));
    store.save(disk()); assert.deepEqual(store.load(), disk());
  } finally { store.close(); i.cleanup(); }
});

test('stored tool results also obey the aggregate ninety-six-KiB delivered-context bound', () => {
  const initial = makeRun('context', { running: true }), template = makeRun('template', { citation: true }), c = template.citations[0]!;
  const text = 'x'.repeat(6000), fullText = Array(16).fill(text).join('\n'), version = hash(fullText), fileBytes = Buffer.byteLength(fullText);
  function build(count: number): { value: ProjectReadDisk; total: number } {
    const events = [...initial.run.events], citations: ProjectReadStoredCitation[] = []; let total = 0;
    for (let n = 0; n < count; n++) {
      const citation: C.ProjectReadCitation = { ...c.citation, runId: initial.run.runId, citationId: 'context_citation_' + n, snapshotId: 'context_snapshot', fileId: 'context_file', excerpt: text, excerptSha256: hash(text), version, normalizedSha256: version, range: { start: { line: n + 1, column: 1 }, end: { line: n + 1, column: 6001 } }, fileBytes, totalLines: 16 };
      citations.push({ citation, file: { ...c.file, size: fileBytes } });
      const { runId: _r, project: _p, snapshotId: _s, fileIdentity: _f, createdAt: _t, origin: _o, ...preview } = citation;
      const call = { sessionId: 'session_context', messageId: 'message_context', callId: 'context_call_' + n, toolName: 'project_read', arguments: { fileId: citation.fileId, version, start: citation.range.start, cursor: null } };
      const result = { ok: true, value: { kind: 'read', phase: 'data', snapshotId: citation.snapshotId, rules: [], resume: null, citation: preview, empty: false, next: null, coverage: { scope: { projectId: project.projectId, bindingId: project.bindingId, identity: project.identity, directoryId: null, relativeDirectory: '' }, complete: true, scannedCandidates: 1, scannedFiles: 1, scannedBytes: 6000, returned: 1, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 0, position: null }, nextCursor: null, limitReason: null } } };
      total += Buffer.byteLength(JSON.stringify(result)); events.push(event(initial.run.runId, events.length + 1, 'tool.started', call)); events.push(event(initial.run.runId, events.length + 1, 'tool.completed', { ...call, result }));
    }
    const accounting = { ...initial.run.accounting, toolAttempts: count, physicalReadBytes: fileBytes * 2 * count, visitedCandidates: count };
    events.push(event(initial.run.runId, events.length + 1, 'budget.updated', accounting));
    return { value: disk({ ...initial, citations, run: { ...initial.run, accounting, events, eventCount: events.length } }), total };
  }
  assert.ok(parseProjectReadDisk(build(1).value)); const over = build(16); assert.ok(over.total > 98304); assert.equal(parseProjectReadDisk(over.value), null);
});

test('rule chunk offsets compare original UTF-8 bytes and cannot hide a split scalar as replacement text', () => {
  const initial = makeRun('rule_boundary', { running: true }), text = '😀', version = hash(text);
  function build(chunkText: string, endBytes: number): ProjectReadDisk {
    const events = [...initial.run.events], add = (type: keyof C.ProjectReadEventData, data: unknown) => events.push(event(initial.run.runId, events.length + 1, type, data));
    add('project.rules', { rules: [{ source: 'AGENTS.md', relativeDirectory: '', state: 'loaded', version, normalizedSha256: version, text }] });
    const call = { sessionId: 'session_rule_boundary', messageId: 'message_rule_boundary', callId: 'rule_call', toolName: 'project_read', arguments: { fileId: 'rule_file', version: null, start: { line: 1, column: 1 }, cursor: null } };
    add('tool.started', call);
    add('tool.completed', { ...call, result: { ok: true, value: { kind: 'read', phase: 'rules', snapshotId: 'rule_snapshot', coverage: { scope: { projectId: project.projectId, bindingId: project.bindingId, identity: project.identity, directoryId: null, relativeDirectory: '' }, complete: false, scannedCandidates: 1, scannedFiles: 0, scannedBytes: 0, returned: 0, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 1, position: null }, nextCursor: 'rule_cursor', limitReason: 'rules' }, rules: [{ ruleId: 'rule_1', source: 'AGENTS.md', relativeDirectory: '', version, normalizedSha256: version, offsetBytes: 0, endBytes, totalBytes: 4, text: chunkText, complete: endBytes === 4 }], resume: null, citation: null, empty: false, next: { line: 1, column: 1 } } } });
    const accounting = { ...initial.run.accounting, toolAttempts: 1, physicalReadBytes: 8 }; add('budget.updated', accounting);
    return disk({ ...initial, run: { ...initial.run, accounting, events, eventCount: events.length } });
  }
  assert.ok(parseProjectReadDisk(build('😀', 4)));
  assert.equal(Buffer.from(text).subarray(0, 3).toString('utf8'), '�');
  assert.equal(parseProjectReadDisk(build('�', 3)), null);
});
