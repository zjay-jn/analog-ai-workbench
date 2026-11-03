import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type * as C from '../apps/desktop/src/shared/agent/agent-project-read';
import { PROJECT_READ_LIMITS as L } from '../apps/desktop/src/shared/agent/agent-project-read';
import type { FolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { createProjectReadStore, parseProjectReadDisk, recoverProjectReadDisk, readProjectReadPage,
  resolveStoredProjectReadCitation, deleteStoredProjectReadRun, ProjectReadStoreError,
  type ProjectReadDisk, type ProjectReadStoredRun, type ProjectReadStoredCitation, type ProjectReadStore,
} from '../apps/desktop/src/main/agent-project-read/store';

const product = path.resolve('C:/work/analog_ai_workbench');
const fixtureParent = path.join(product, '.local/agent-project-read-tests');
const now = '2026-09-11T12:00:00.000Z', restartTime = '2026-09-11T12:05:00.000Z';
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const bytes = (input: unknown) => Buffer.byteLength(JSON.stringify(input));
const root: FolderRoot = { projectId: 'independent-project', bindingId: 'independent-binding', root: 'R:\\Synthetic\\Independent-A12', chain: [{ dev: '7', ino: '101' }, { dev: '7', ino: '102' }, { dev: '7', ino: '103' }] };
const project: Extract<C.ProjectReadRef, {bindingId:string}> = { projectId: root.projectId, bindingId: root.bindingId, name: 'Independent synthetic store evidence', directoryName: 'Independent-A12', directorySegments: ['R', 'Synthetic', 'Independent-A12'], identity: hash(JSON.stringify(root.chain)) };
const model: C.ProjectReadModel = { provider: 'deepseek', model: 'deepseek-v4-flash' };
const limits: C.ProjectReadBudget = { providerAttempts: 24, httpDispatches: 24, toolAttempts: 64, physicalReadBytes: 268435456, visitedCandidates: 100000, contextBytes: 196608, outputBytes: 65536, maxOutputTokens: 16384, deadlineMs: 14400000, waitMs: 1800000 };
const zero: C.ProjectReadAccounting = { providerAttempts: 0, httpDispatches: 0, toolAttempts: 0, physicalReadBytes: 0, visitedCandidates: 0, contextBytes: null };
const code = (expected: string) => (error: unknown) => error instanceof ProjectReadStoreError && error.code === expected;
const disk = (...runs: ProjectReadStoredRun[]): ProjectReadDisk => ({ version: 1, runs });
const okay = <T>(result: C.ProjectReadResult<T>): T => { assert.ok(result.ok, JSON.stringify(result)); return result.value; };
function refusal<T>(result: C.ProjectReadResult<T>, expected: string): void { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, expected); }
function syntheticCitation(runId: string): ProjectReadStoredCitation {
  const text = '合成🙂', fileIdentity = hash(JSON.stringify({ dev: '7', ino: '104' }));
  const citation: C.ProjectReadCitation = { citationId: 'citation-' + runId, runId, project, snapshotId: 'snapshot-' + runId, fileId: 'file-' + runId, fileIdentity,
    relativePath: 'source.txt', version: hash(text), normalizedSha256: hash(text), range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } }, excerpt: text, excerptSha256: hash(text), totalLines: 1, fileBytes: Buffer.byteLength(text), source: 'read', createdAt: now, origin: null };
  return { citation, file: { absolutePath: path.join(root.root, 'source.txt'), relativePath: 'source.txt', chain: [...root.chain, { dev: '7', ino: '104' }], dev: '7', ino: '104', size: citation.fileBytes, mtimeNs: '51', ctimeNs: '52', fileIdentity } };
}
type Mode = 'preparing' | 'running' | 'waiting-pending' | 'terminal-pending' | 'stopped' | 'cleanup-failed';
function syntheticRun(runId: string, mode: Mode = 'stopped', evidence = false, parent: ProjectReadStoredRun | null = null): ProjectReadStoredRun {
  const events: C.ProjectReadEvent[] = [], citations: ProjectReadStoredCitation[] = [];
  const add = <K extends keyof C.ProjectReadEventData>(type: K, data: C.ProjectReadEventData[K]) => events.push({ runId, sequence: events.length + 1, time: now, type, data } as C.ProjectReadEvent);
  let accounting = zero, status: C.ProjectReadRunState = 'preparing', cleanupState: C.ProjectReadCleanupState = 'idle';
  add('run.accepted', { project, model, budget: limits, continuedFrom: parent?.run.runId ?? null });
  if (parent?.citations.length) {
    const old = parent.citations[0]!, fresh = syntheticCitation(runId);
    citations.push({ file: old.file, citation: { ...old.citation, runId, citationId: fresh.citation.citationId, fileId: fresh.citation.fileId, snapshotId: fresh.citation.snapshotId, origin: { runId: parent.run.runId, citationId: old.citation.citationId } } });
  }
  if (mode !== 'preparing') {
    const sessionId = 'session-' + runId;
    add('run.started', { sessionId, engine: 'opencode', version: '1.18.17' }); status = 'running';
    add('model.step', { step: 1 });
    if (evidence) {
      const item = syntheticCitation(runId), c = item.citation; citations.push(item);
      const { runId: _r, project: _p, snapshotId: _s, fileIdentity: _f, createdAt: _t, origin: _o, ...preview } = c;
      const call: C.ProjectReadToolCall = { sessionId, messageId: 'message-' + runId, callId: 'call-' + runId, toolName: 'project_read', arguments: { fileId: c.fileId, version: c.version, cursor: null, start: c.range.start } };
      const coverage: C.ProjectReadCoverage = { scope: { projectId: project.projectId, bindingId: project.bindingId, identity: project.identity, directoryId: null, relativeDirectory: '' }, complete: true, scannedCandidates: 1, scannedFiles: 1, scannedBytes: c.fileBytes, returned: 1, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 0, position: null }, nextCursor: null, limitReason: null };
      add('tool.started', call); add('tool.completed', { ...call, result: { ok: true, value: { kind: 'read', phase: 'data', snapshotId: c.snapshotId, coverage, rules: [], resume: null, citation: preview, empty: false, next: null } } });
      accounting = { ...zero, toolAttempts: 1, physicalReadBytes: c.fileBytes * 2, visitedCandidates: 1 };
    }
    add('budget.updated', accounting);
    if (mode === 'waiting-pending') { add('question.asked', { questionId: 'question-' + runId, prompt: 'Which synthetic section?' }); add('question.answered', { questionId: 'question-' + runId, answer: 'Second section, not delivered yet.' }); status = 'waiting_user'; }
    if (mode !== 'running') {
      add('cleanup.started', { reason: 'close' }); cleanupState = 'pending';
      if (mode === 'stopped' || mode === 'cleanup-failed') { add('cleanup.completed', { outcome: mode === 'stopped' ? 'confirmed' : 'failed' }); cleanupState = mode === 'stopped' ? 'idle' : 'failed'; }
      if (mode !== 'waiting-pending') { add('run.stopped', { reason: 'user' }); status = 'stopped'; }
    }
  }
  return { root, citations, run: { runId, clientRequestId: 'request-' + runId, project, model, goal: 'Inspect synthetic store evidence.', constraint: '', continuedFrom: parent?.run.runId ?? null, status, cleanupState, createdAt: now, updatedAt: now, accounting, eventCount: events.length,
    continuation: parent ? { fromRunId: parent.run.runId, evidenceCount: citations.length, confirmedQuestions: 0, resumedFilePositions: 0, restartedQueries: 0 } : null, events } };
}
function noLinks(target: string): void { let current = path.parse(target).root; for (const part of target.slice(current.length).split(path.sep)) { current = path.join(current, part); if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false, current); } }
function checkedChild(target: string, parent: string): string { const resolved = path.resolve(target), relative = path.relative(parent, resolved); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); return resolved; }
function fixture(body: (f: { directory: string; target: string; lock: string; open(): ProjectReadStore }) => void): void {
  assert.equal(path.resolve(process.cwd()).toLowerCase(), product.toLowerCase()); noLinks(fixtureParent);
  const base = checkedChild(path.join(fixtureParent, randomUUID()), fixtureParent); assert.equal(fs.existsSync(base), false); fs.mkdirSync(base, { recursive: true });
  const directory = path.join(base, 'agent-project-read'), stores: ProjectReadStore[] = [];
  try { body({ directory, target: path.join(directory, 'runs.json'), lock: path.join(directory, 'writer.lock'), open() { const store = createProjectReadStore(product, directory); stores.push(store); return store; } }); }
  finally { for (const store of stores) store.close(); const actual = fs.realpathSync.native(base); assert.equal(actual.toLowerCase(), base.toLowerCase()); checkedChild(actual, fixtureParent); noLinks(actual); assert.match(path.basename(actual), /^[0-9a-f-]{36}$/u); fs.rmSync(actual, { recursive: true }); }
}
function patched(key: keyof typeof fs, replacement: unknown, body: () => void): void { const descriptor = Object.getOwnPropertyDescriptor(fs, key)!; Object.defineProperty(fs, key, { ...descriptor, value: replacement }); try { body(); } finally { Object.defineProperty(fs, key, descriptor); } }
function withoutSourceIo(body: () => void): void {
  let sourceCalls = 0;
  const keys = ['lstatSync', 'statSync', 'openSync', 'readFileSync'] as const;
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(fs, key)!);
  for (let i = 0; i < keys.length; i++) { const descriptor = descriptors[i]!; Object.defineProperty(fs, keys[i]!, { ...descriptor, value: (...args: unknown[]) => { if (typeof args[0] === 'string' && /^R:[\\/]/iu.test(args[0])) { sourceCalls++; throw new Error('Stored source access forbidden'); } return Reflect.apply(descriptor.value as (...parameters: unknown[]) => unknown, fs, args); } }); }
  try { body(); assert.equal(sourceCalls, 0); } finally { keys.forEach((key, i) => Object.defineProperty(fs, key, descriptors[i]!)); }
}
function append(stored: ProjectReadStoredRun, type: keyof C.ProjectReadEventData, data: unknown): ProjectReadStoredRun {
  const events = [...stored.run.events, { runId: stored.run.runId, sequence: stored.run.eventCount + 1, time: now, type, data } as C.ProjectReadEvent];
  return { ...stored, run: { ...stored.run, events, eventCount: events.length } };
}

test('independent store recovery: real reopen persists truthful cleanup and never delivers an old answer or opens recorded source', async t => {
  for (const mode of ['waiting-pending', 'terminal-pending', 'preparing'] as const) await t.test(mode, () => withoutSourceIo(() => fixture(f => {
    const original = syntheticRun('recover-' + mode, mode, mode !== 'preparing'); assert.ok(parseProjectReadDisk(disk(original)));
    const writer = f.open(); assert.deepEqual(writer.load(), disk()); writer.save(disk(original)); writer.close();
    const restarted = f.open(), loaded = restarted.load(); assert.deepEqual(loaded, disk(original));
    const recovered = recoverProjectReadDisk(loaded, restartTime), next = recovered.runs[0]!;
    assert.equal(next.run.status, mode === 'terminal-pending' ? 'stopped' : 'interrupted'); assert.equal(next.run.cleanupState, mode === 'preparing' ? 'idle' : 'failed');
    assert.deepEqual(next.run.events.slice(0, original.run.eventCount), original.run.events); assert.deepEqual(next.citations, original.citations); assert.deepEqual(next.run.accounting, original.run.accounting);
    assert.equal(next.run.events.some(e => e.type === 'question.delivered'), false);
    assert.equal(next.run.events.slice(original.run.eventCount).some(e => e.type === 'cleanup.completed' && e.data.outcome === 'confirmed'), false);
    assert.deepEqual(recoverProjectReadDisk(recovered, restartTime), recovered);
    restarted.save(recovered); restarted.close(); const third = f.open(); assert.deepEqual(third.load(), recovered);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.target, 'utf8')), recovered);
    const page = okay(readProjectReadPage(third.load(), original.run.runId, original.run.eventCount)); assert.deepEqual(page.events, next.run.events.slice(original.run.eventCount)); assert.equal(page.hasMore, false);
  })));
});

test('independent store deletion: failed cleanup remains blocked while retained and can be explicitly removed after release', () => fixture(f => {
  const failed = syntheticRun('failed-cleanup', 'cleanup-failed', true), current = disk(failed), store = f.open(); store.load(); store.save(current);
  refusal(deleteStoredProjectReadRun(current, failed.run.runId, failed.run.eventCount, [failed.run.runId]), 'BUSY');
  refusal(deleteStoredProjectReadRun(current, failed.run.runId, failed.run.eventCount - 1, []), 'CONFLICT');
  for (const mode of ['running', 'terminal-pending'] as const) { const active = syntheticRun('unreleased-' + mode, mode); refusal(deleteStoredProjectReadRun(disk(active), active.run.runId, active.run.eventCount, []), 'BUSY'); }
  assert.equal(parseProjectReadDisk(disk(failed, syntheticRun('bad-inherit', 'preparing', false, failed))), null);
  const independent = syntheticRun('fresh-unrelated', 'preparing'); assert.ok(parseProjectReadDisk(disk(failed, independent)));
  const removed = okay(deleteStoredProjectReadRun(current, failed.run.runId, failed.run.eventCount, [])); store.save(removed); assert.deepEqual(store.load(), disk());
}));

test('independent store ancestry: persisted citation ownership and transitive delete blockers survive reopening without source I/O', () => withoutSourceIo(() => fixture(f => {
  const ancestor = syntheticRun('ancestor', 'stopped', true), child = syntheticRun('child', 'stopped', false, ancestor), grandchild = syntheticRun('grandchild', 'stopped', false, child);
  const initial = disk(ancestor, child, grandchild), writer = f.open(); assert.ok(parseProjectReadDisk(initial)); writer.load(); writer.save(initial); writer.close();
  const store = f.open(), loaded = store.load(), resolved = okay(resolveStoredProjectReadCitation(loaded, grandchild.run.runId, grandchild.citations[0]!.citation.citationId));
  assert.deepEqual(resolved.origin, { runId: child.run.runId, citationId: child.citations[0]!.citation.citationId }); assert.equal(resolved.excerpt, ancestor.citations[0]!.citation.excerpt);
  refusal(resolveStoredProjectReadCitation(loaded, ancestor.run.runId, resolved.citationId), 'FILE_UNAVAILABLE');
  const denied = deleteStoredProjectReadRun(loaded, ancestor.run.runId, ancestor.run.eventCount, []); refusal(denied, 'RUN_HAS_DEPENDENTS'); if (!denied.ok && denied.error.code === 'RUN_HAS_DEPENDENTS') assert.deepEqual(denied.error.dependentRunIds, ['child', 'grandchild']);
  const altered = { ...grandchild, citations: grandchild.citations.map(item => ({ ...item, citation: { ...item.citation, excerpt: '伪造🙂', excerptSha256: hash('伪造🙂') } })) };
  assert.equal(parseProjectReadDisk(disk(ancestor, child, altered)), null, 'a self-consistent excerpt hash cannot change inherited content');
  let current = loaded;
  for (const item of [grandchild, child, ancestor]) { current = okay(deleteStoredProjectReadRun(current, item.run.runId, item.run.eventCount, [])); store.save(current); }
  assert.deepEqual(store.load(), disk());
})));

test('independent store external changes: stale writer cannot overwrite replaced data or remove a foreign lock', async t => {
  await t.test('identical-bytes-new-object', () => fixture(f => {
    const store = f.open(), original = disk(syntheticRun('original')); store.load(); store.save(original);
    const unchanged = fs.readFileSync(f.target), replacement = path.join(f.directory, 'external-replacement.json'); fs.writeFileSync(replacement, unchanged); fs.renameSync(replacement, f.target);
    assert.throws(() => store.save(disk(...original.runs, syntheticRun('uncommitted'))), code('STORAGE_FAILED')); assert.deepEqual(fs.readFileSync(f.target), unchanged);
    assert.throws(() => store.load(), code('STORAGE_FAILED')); assert.throws(() => store.save(original), code('STORAGE_FAILED'));
  }));
  await t.test('change-while-temporary-file-is-flushed', () => fixture(f => {
    const store = f.open(), original = disk(syntheticRun('original')), foreign = Buffer.from(JSON.stringify(disk(syntheticRun('external')))); store.load(); store.save(original);
    const sync = fs.fsyncSync; let injections = 0;
    patched('fsyncSync', (fd: number) => { sync(fd); if (injections++ === 0) fs.writeFileSync(f.target, foreign); }, () => assert.throws(() => store.save(disk(...original.runs, syntheticRun('uncommitted'))), code('STORAGE_FAILED')));
    assert.equal(injections, 1); assert.deepEqual(fs.readFileSync(f.target), foreign); assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
  }));
  await t.test('foreign-writer-lock-preserved-on-close', () => fixture(f => {
    const store = f.open(); store.load(); store.save(disk(syntheticRun('original'))); const oldData = fs.readFileSync(f.target);
    const foreign = Buffer.from(JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID(), createdAt: now })); fs.writeFileSync(f.lock, foreign);
    assert.throws(() => store.save(disk()), code('STORAGE_FAILED')); store.close(); assert.deepEqual(fs.readFileSync(f.lock), foreign); assert.deepEqual(fs.readFileSync(f.target), oldData);
  }));
});

test('independent store commit failures: write, rename and post-rename uncertainty never report a successful save', async t => {
  for (const phase of ['flush', 'rename', 'readback'] as const) await t.test(phase, () => fixture(f => {
    const store = f.open(), old = disk(syntheticRun('old')), next = disk(...old.runs, syntheticRun('new')); store.load(); store.save(old); const previousBytes = fs.readFileSync(f.target);
    const sync = fs.fsyncSync, rename = fs.renameSync; let hits = 0;
    const foreign = Buffer.from(JSON.stringify(disk(syntheticRun('unconfirmed-disk'))));
    const key = phase === 'flush' ? 'fsyncSync' : 'renameSync';
    const replacement = phase === 'flush' ? (fd: number) => { sync(fd); hits++; throw new Error('Synthetic fsync failure'); } : (from: fs.PathLike, to: fs.PathLike) => { hits++; if (phase === 'rename') throw new Error('Synthetic rename failure'); rename(from, to); fs.writeFileSync(f.target, foreign); };
    patched(key, replacement, () => assert.throws(() => store.save(next), code('STORAGE_FAILED')));
    assert.equal(hits, 1); assert.deepEqual(fs.readFileSync(f.target), phase === 'readback' ? foreign : previousBytes);
    assert.throws(() => store.load(), code('STORAGE_FAILED'));
    const temporary = fs.readdirSync(f.directory).filter(name => name.endsWith('.tmp'));
    // A flush exception prevents the store from obtaining a verified temporary-file
    // identity. Keeping that unknown object is intentional; it is never committed.
    assert.equal(temporary.length, phase === 'flush' ? 1 : 0);
    if (phase === 'flush') { assert.match(temporary[0]!, /^\.runs-[0-9a-f-]{36}\.tmp$/u); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, temporary[0]!), 'utf8')), next); }
    store.close(); const recovered = f.open(); assert.deepEqual(recovered.load(), phase === 'readback' ? JSON.parse(foreign.toString()) : old);
    assert.deepEqual(fs.readdirSync(f.directory).filter(name => name.endsWith('.tmp')), temporary, 'reopening must neither adopt nor remove an unconfirmed temporary file');
  }));
});

test('independent store event tail: admission preserves restart space at the exact event limit without poisoning a valid writer', () => fixture(f => {
  let near = syntheticRun('event-limit', 'running'); while (near.run.eventCount < L.events - 4) near = append(near, 'budget.updated', zero);
  const over = append(near, 'budget.updated', zero); assert.ok(parseProjectReadDisk(disk(near))); assert.ok(parseProjectReadDisk(disk(over)));
  const store = f.open(); store.load(); store.save(disk(near)); const committed = fs.readFileSync(f.target);
  assert.throws(() => store.save(disk(over)), code('BUDGET_EXCEEDED')); assert.deepEqual(fs.readFileSync(f.target), committed); assert.deepEqual(store.load(), disk(near));
  const recovered = recoverProjectReadDisk(disk(near), restartTime); assert.ok(recovered.runs[0]!.run.eventCount <= L.events); assert.equal(recovered.runs[0]!.run.cleanupState, 'failed'); store.save(recovered); assert.deepEqual(store.load(), recovered);
}));

test('independent store byte tail and pages: real JSON escaping counts toward storage and every event is returned once', () => fixture(f => {
  const text = '"'.repeat(8192), rule: C.ProjectReadRule = { source: 'AGENTS.md', relativeDirectory: '', state: 'loaded', version: hash(text), normalizedSha256: hash(text), text };
  let admitted = syntheticRun('byte-limit', 'running'), candidate = append(admitted, 'project.rules', { rules: [rule] });
  while (bytes(candidate) < L.runBytes - 18000) { admitted = candidate; candidate = append(admitted, 'project.rules', { rules: [rule] }); }
  let near = append(admitted, 'project.rules', { rules: [rule] });
  const empty = append(near, 'message.delta', { messageId: 'padding', step: 1, text: '' }), available = L.runBytes - bytes(empty) - 128;
  assert.ok(available > 0 && available < 32700); const padding = '"'.repeat(Math.floor(available / 2)) + (available % 2 ? 'a' : '');
  near = append(near, 'message.delta', { messageId: 'padding', step: 1, text: padding }); assert.equal(bytes(near), L.runBytes - 128); assert.ok(parseProjectReadDisk(disk(near)));
  const store = f.open(); store.load(); assert.throws(() => store.save(disk(near)), code('BUDGET_EXCEEDED')); assert.equal(fs.existsSync(f.target), false);
  store.save(disk(admitted)); const stored = store.load(), seen: C.ProjectReadEvent[] = []; let after = 0, boundedByBytes = false;
  while (after < admitted.run.eventCount) { const result = readProjectReadPage(stored, admitted.run.runId, after), page = okay(result); assert.ok(bytes(result) <= L.eventPageBytes); assert.ok(page.events.length > 0 && page.events.length <= L.eventPage); boundedByBytes ||= page.hasMore && page.events.length < L.eventPage; seen.push(...page.events); assert.ok(page.nextAfter > after); after = page.nextAfter; }
  assert.equal(boundedByBytes, true); assert.deepEqual(seen, admitted.run.events); assert.equal(okay(readProjectReadPage(stored, admitted.run.runId, after)).hasMore, false);
  store.save(recoverProjectReadDisk(stored, restartTime));
}));

test('independent store history capacity: refused thirty-third record leaves all accepted records intact and permits an explicit deletion', () => fixture(f => {
  const accepted = disk(...Array.from({ length: 32 }, (_, i) => syntheticRun('history-' + i))), store = f.open(); store.load(); store.save(accepted); const previous = fs.readFileSync(f.target);
  assert.throws(() => store.save(disk(...accepted.runs, syntheticRun('history-overflow'))), code('HISTORY_FULL')); assert.deepEqual(fs.readFileSync(f.target), previous);
  const chosen = accepted.runs[7]!, reduced = okay(deleteStoredProjectReadRun(store.load(), chosen.run.runId, chosen.run.eventCount, [])); store.save(reduced); assert.equal(store.load().runs.length, 31);
}));
