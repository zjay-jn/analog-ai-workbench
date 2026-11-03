import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { captureFilesystemRoot } from '../apps/desktop/src/main/cloud/filesystem-read-sources';
import { createProjectReadIndex } from '../apps/desktop/src/main/cloud/project-read-index';
import { captureProjectReadFile, createProjectReadIoBudget, createProjectReadOperation, createProjectTextReader, ProjectReadFsError, verifyProjectReadRoot } from '../apps/desktop/src/main/cloud/project-read-files';
import { createProjectReadRules, projectReadRuleChunk } from '../apps/desktop/src/main/cloud/project-read-rules';
import { PROJECT_READ_LIMITS as L } from '../apps/desktop/src/shared/agent/agent-project-read';
import type { FileSystemSourceRef } from '../apps/desktop/src/shared/agent/agent-filesystem-read';

const base = 'C:\\work\\analog_ai_workbench\\.local\\fs-index-memory';
const A = base + '\\source-A', B = base + '\\source-B', projectId = randomUUID();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string, osCode?: string) => (error: unknown) =>
  error instanceof ProjectReadFsError && error.code === expected && (osCode === undefined || error.osCode === osCode);
type Row = { text?: string; ino?: bigint; mtime?: bigint; links?: bigint; directory?: boolean; openError?: string; readError?: string; directoryError?: string };
function memory(t: TestContext, rows: Record<string, Row>) {
  const seen = { listed: [] as string[], opened: [] as string[], reads: 0, closed: 0, metadata: [] as string[] };
  const stat = (target: string): fs.BigIntStats => {
    const row = rows[target], directory = row?.directory ?? (row === undefined && Object.keys(rows).some(p => p.startsWith(target.endsWith('\\') ? target : target + '\\')));
    if (!row && !directory) throw Object.assign(Error('synthetic missing'), { code: 'ENOENT' });
    return { dev: 1n, ino: row?.ino ?? BigInt('0x' + digest(target).slice(0, 12)), nlink: row?.links ?? 1n,
      size: BigInt(Buffer.byteLength(row?.text ?? '')), mtimeNs: row?.mtime ?? 1n, ctimeNs: 1n,
      isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false,
    } as fs.BigIntStats;
  };
  t.mock.method(fs, 'lstatSync', ((target: fs.PathLike) => { seen.metadata.push(String(target)); return stat(String(target)); }) as typeof fs.lstatSync);
  t.mock.method(fs.realpathSync, 'native', ((target: fs.PathLike) => String(target)) as typeof fs.realpathSync.native);
  t.mock.method(asyncFs, 'lstat', (async (target: fs.PathLike) => stat(String(target))) as typeof asyncFs.lstat);
  t.mock.method(asyncFs, 'opendir', (async (target: fs.PathLike) => {
    const folder = String(target); seen.listed.push(folder);
    if (rows[folder]?.directoryError) throw Object.assign(Error('raw private directory error'), { code: rows[folder]!.directoryError });
    stat(folder); const prefix = folder.endsWith('\\') ? folder : folder + '\\', names = new Set<string>();
    for (const name of Object.keys(rows)) if (name.startsWith(prefix) && name !== folder) names.add(name.slice(prefix.length).split('\\')[0]!);
    const entries = [...names]; let offset = 0;
    return { async read() {
      if (offset === entries.length) return null; const name = entries[offset++]!, value = stat(path.win32.join(folder, name));
      return { name, isDirectory: () => value.isDirectory(), isFile: () => value.isFile(), isSymbolicLink: () => false };
    }, async close() { seen.closed++; } } as unknown as fs.Dir;
  }) as typeof asyncFs.opendir);
  t.mock.method(asyncFs, 'open', (async (target: fs.PathLike) => {
    const file = String(target); seen.opened.push(file);
    if (rows[file]?.openError) throw Object.assign(Error('raw private open error'), { code: rows[file]!.openError });
    stat(file);
    return {
      async stat() { return stat(file); },
      async read(buffer: Buffer, offset: number, count: number, position: number) {
        seen.reads++; if (rows[file]?.readError) throw Object.assign(Error('raw private read error'), { code: rows[file]!.readError });
        const source = Buffer.from(rows[file]?.text ?? ''), bytesRead = Math.min(count, Math.max(0, source.length - position));
        source.copy(buffer, offset, position, position + bytesRead); return { bytesRead, buffer };
      },
      async close() { seen.closed++; },
    } as unknown as FileHandle;
  }) as typeof asyncFs.open);
  return { rows, seen };
}
function source(rootPath: string): FileSystemSourceRef {
  const root = captureFilesystemRoot(rootPath);
  return { kind: 'windows_filesystem', sourceId: randomUUID(), rootPath, rootIdentity: digest(JSON.stringify(root.chain)) };
}
function setup(rootPath: string, quota = { indexBytes: 0, visitedCandidates: 0 }, abort = new AbortController()) {
  const root = captureFilesystemRoot(rootPath), ref = source(rootPath);
  return { root, ref, quota, abort, index: createProjectReadIndex({ root, source: ref, projectId, identity: ref.rootIdentity, owner: { kind: 'run', id: randomUUID() }, quota, signal: abort.signal }) };
}
const list = (directoryId: string | null = null, cursor: string | null = null, refresh = false) => ({ directoryId, cursor, refresh });

test('filesystem reader: ordinary log/dot text uses both passes; old project text policy stays unchanged', async t => {
  const file = A + '\\.notes', text = 'first\nsecond 😀\n'; const m = memory(t, { [file]: { text } });
  const root = captureFilesystemRoot(A), captured = captureProjectReadFile(root, '.notes');
  const abort = new AbortController(), budget = createProjectReadIoBudget(), reader = createProjectTextReader({ root, file: captured, expectedVersion: null, signal: abort.signal, budget });
  const result = await reader.step(createProjectReadOperation(abort.signal));
  assert.equal(result.kind, 'complete'); if (result.kind === 'complete') { assert.equal(result.value.version, digest(text)); assert.equal(result.value.source.text, text); }
  assert.equal(budget.evidence().physicalReadBytes, Buffer.byteLength(text) * 2); assert.equal(m.seen.listed.length, 0);
  const legacy = { ...root, projectId, bindingId: randomUUID() };
  assert.throws(() => captureProjectReadFile(legacy, '.notes'), code('UNSUPPORTED_PATH'));
  await reader.close();
});
test('filesystem index: direct drive-root file and single-file candidates never enumerate parent', async t => {
  const file = 'C:\\notes.log', m = memory(t, { [file]: { text: 'needle' }, 'C:\\other.log': { text: 'needle' } });
  const f = setup('C:\\');
  try {
    const rootScope = f.index.scope(); assert.equal(rootScope.kind, 'windows_filesystem'); assert.ok(rootScope.directoryId);
    const entry = f.index.captureFile(file); assert.equal(entry.parentId, rootScope.directoryId);
    assert.equal(f.index.resolveDirectory(rootScope.directoryId).absolutePath, 'C:\\');
    const candidates = await f.index.candidates({ directoryId: null, fileId: entry.fileId!, query: 'needle', refresh: false });
    assert.equal(candidates.scope.kind, 'windows_filesystem');
    if (candidates.scope.kind === 'windows_filesystem') assert.equal(candidates.scope.absoluteDirectory, file);
    const first = await candidates.next(); assert.equal(first.kind, 'entry');
    if (first.kind === 'entry') assert.equal(first.entry.fileId, entry.fileId);
    assert.equal((await candidates.next()).kind, 'complete'); assert.equal(candidates.coverage().scannedCandidates, 1);
    await candidates.close(); assert.deepEqual(m.seen.listed, []); assert.deepEqual(m.seen.opened, []);
  } finally { await f.index.dispose(); }
});
test('filesystem index: source root IDs and cursor ownership survive paging without falling back to cwd', async t => {
  const rows: Record<string, Row> = { [A + '\\.notes']: { text: 'plain' }, [A + '\\models\\data.out']: { text: 'plain' }, [A + '\\.env']: { text: 'synthetic denied' }, [B + '\\same.log']: { text: 'b' } };
  for (let i = 0; i < 110; i++) rows[A + '\\item-' + i + '.log'] = { text: 'plain' };
  memory(t, rows); const quota = { indexBytes: 0, visitedCandidates: 0 }, a = setup(A, quota), b = setup(B, quota);
  try {
    const rootId = a.index.scope().directoryId!, otherRoot = b.index.scope().directoryId!;
    assert.notEqual(rootId, otherRoot); const first = await a.index.list(list(rootId)); assert.ok(first.coverage.nextCursor);
    assert.equal(first.source?.sourceId, a.ref.sourceId);
    assert.equal(first.coverage.scope.directoryId, rootId);
    assert.throws(() => b.index.resolveDirectory(rootId), code('CURSOR_STALE'));
    await assert.rejects(b.index.list(list(otherRoot, first.coverage.nextCursor)), code('CURSOR_STALE'));
    const names = first.entries.map(e => e.name); let cursor: string | null = first.coverage.nextCursor;
    while (cursor) { const next = await a.index.list(list(rootId, cursor)); names.push(...next.entries.map(e => e.name)); cursor = next.coverage.nextCursor; }
    assert.ok(names.includes('.notes') && names.includes('models')); assert.equal(names.includes('.env'), false);
    assert.equal(new Set(names).size, names.length);
    const refreshed = await a.index.list(list(rootId, null, true));
    assert.notEqual(refreshed.coverage.scope.directoryId, rootId); assert.equal(b.index.scope().directoryId, otherRoot);
    assert.throws(() => a.index.resolveDirectory(rootId), code('CURSOR_STALE'));
  } finally { await a.index.dispose(); await b.index.dispose(); }
  assert.equal(quota.indexBytes, 0); assert.ok(quota.visitedCandidates > 110);
});
test('filesystem index: root opendir denial returns actual failure, while legacy scope remains unchanged', async t => {
  memory(t, { [A]: { directory: true, directoryError: 'EACCES' }, [B + '\\ok.txt']: { text: 'ok' } });
  const f = setup(A);
  try { await assert.rejects(f.index.list(list()), code('ACCESS_DENIED', 'EACCES')); }
  finally { await f.index.dispose(); }
  const root = { ...captureFilesystemRoot(B), projectId, bindingId: randomUUID() };
  const old = createProjectReadIndex({ root, identity: randomUUID(), owner: { kind: 'run', id: randomUUID() }, signal: new AbortController().signal });
  try { const value = await old.list(list()); assert.equal(value.coverage.scope.kind, undefined); assert.equal(value.coverage.scope.directoryId, null); assert.equal(value.entries[0]?.name, 'ok.txt'); }
  finally { await old.dispose(); }
});
test('filesystem index: shared candidate quota survives refresh and only owned memory is released', async t => {
  memory(t, { [A + '\\a.log']: { text: 'a' }, [B + '\\b.log']: { text: 'b' } });
  const quota = { indexBytes: 0, visitedCandidates: L.runCandidates - 1 }, a = setup(A, quota), b = setup(B, quota);
  try {
    a.index.scope(); b.index.scope(); const bBytes = b.index.accounting().indexBytes;
    const entry = a.index.captureFile(A + '\\a.log'); assert.ok(entry.fileId); assert.equal(quota.visitedCandidates, L.runCandidates);
    assert.throws(() => b.index.captureFile(B + '\\b.log'), code('SCOPE_LIMIT'));
    await a.index.dispose(); assert.equal(quota.indexBytes, bBytes); assert.equal(quota.visitedCandidates, L.runCandidates);
  } finally { await a.index.dispose(); await b.index.dispose(); }
  assert.equal(quota.indexBytes, 0); assert.equal(quota.visitedCandidates, L.runCandidates);
});
test('filesystem index: shared memory ceiling applies before a second source allocates', async t => {
  memory(t, { [A + '\\a.log']: { text: 'a' }, [B + '\\b.log']: { text: 'b' } });
  const quota = { indexBytes: L.indexBytes - 100, visitedCandidates: 0 }, f = setup(A, quota);
  assert.throws(() => f.index.scope(), code('SCOPE_LIMIT')); assert.equal(quota.indexBytes, L.indexBytes - 100);
  await f.index.dispose(); assert.equal(quota.indexBytes, L.indexBytes - 100);
});
test('filesystem reader: open and read failures retain OS classification, without raw error text', async t => {
  const file = A + '\\run.out', m = memory(t, { [file]: { text: 'synthetic' } }), root = captureFilesystemRoot(A);
  const captured = captureProjectReadFile(root, 'run.out');
  for (const operation of ['openError', 'readError'] as const) {
    m.rows[file]![operation] = 'EACCES'; const abort = new AbortController();
    const reader = createProjectTextReader({ root, file: captured, expectedVersion: null, signal: abort.signal, budget: createProjectReadIoBudget() });
    await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), error => {
      assert.ok(code('ACCESS_DENIED', 'EACCES')(error)); assert.equal((error as Error).message, 'ACCESS_DENIED'); return true;
    });
    await reader.close(); delete m.rows[file]![operation];
  }
});
test('filesystem capture and candidates reject changed file identity and foreign issued IDs', async t => {
  const m = memory(t, { [A + '\\same.log']: { text: 'a', ino: 5n }, [B + '\\same.log']: { text: 'b' } });
  const a = setup(A), b = setup(B);
  try {
    const entry = a.index.captureFile(A + '\\same.log');
    await assert.rejects(b.index.candidates({ fileId: entry.fileId!, directoryId: null, query: 'a', refresh: false }), code('CURSOR_STALE'));
    m.rows[A + '\\same.log']!.ino = 6n; assert.throws(() => a.index.resolveFile(entry.fileId!), code('SOURCE_CHANGED'));
    const candidates = await a.index.candidates({ fileId: entry.fileId!, directoryId: null, query: 'a', refresh: false });
    await assert.rejects(candidates.next(), code('SOURCE_CHANGED')); await candidates.close();
    m.rows[A] = { directory: true, ino: 99n }; assert.throws(() => verifyProjectReadRoot(a.root), code('ROOT_CHANGED'));
  } finally { await a.index.dispose(); await b.index.dispose(); }
});
test('filesystem rules: equal AGENTS names keep source identity and never inspect above source root', async t => {
  const m = memory(t, { [A + '\\AGENTS.md']: { text: 'Rules A\n' }, [A + '\\notes.log']: { text: 'data' }, [B + '\\AGENTS.md']: { text: 'Rules B\n' } });
  const rules = [A, B].map(rootPath => {
    const root = captureFilesystemRoot(rootPath), ref = source(rootPath), abort = new AbortController();
    return { rootPath, root, ref, abort, rules: createProjectReadRules({ root, source: ref, signal: abort.signal, budget: createProjectReadIoBudget(), publish: async () => {} }) };
  });
  try {
    const found = [];
    for (const f of rules) {
      const value = await f.rules.loadRoot(createProjectReadOperation(f.abort.signal)); found.push(value);
      assert.equal(value.rule.sourceRef?.sourceId, f.ref.sourceId);
      const chunk = projectReadRuleChunk({ ruleId: value.ruleId, rule: value.rule, offsetBytes: 0, fits: () => true });
      assert.equal(chunk.sourceRef?.sourceId, f.ref.sourceId); assert.equal(chunk.source, 'AGENTS.md');
    }
    assert.notEqual(found[0]!.ruleId, found[1]!.ruleId);
    assert.deepEqual(m.seen.listed, []);
    assert.ok(m.seen.opened.every(name => name === A + '\\AGENTS.md' || name === B + '\\AGENTS.md'));
    assert.equal(m.seen.metadata.includes(base + '\\AGENTS.md'), false);
  } finally { for (const f of rules) await f.rules.close(); }
});
test('filesystem protected source files and rule files remain denied in generic reader paths', async t => {
  memory(t, { [A + '\\AGENTS.md']: { text: 'private synthetic' }, [A + '\\notes.log']: { text: 'private synthetic' } });
  const root = { ...captureFilesystemRoot(A), protectedRoots: [A + '\\notes.log', A + '\\AGENTS.md'] };
  assert.throws(() => captureProjectReadFile(root, 'notes.log'), code('PATH_POLICY_DENIED'));
  const abort = new AbortController(), rules = createProjectReadRules({ root, source: source(A), signal: abort.signal, budget: createProjectReadIoBudget(), publish: async () => {} });
  try { await assert.rejects(rules.loadRoot(createProjectReadOperation(abort.signal)), code('PATH_POLICY_DENIED')); }
  finally { await rules.close(); }
});

test('filesystem refreshFile: changed issued file receives a new ID without refreshing other sources', async t => {
  const file = A + '\\notes.log', other = B + '\\notes.log';
  const m = memory(t, { [file]: { text: 'old', ino: 51n }, [other]: { text: 'other', ino: 61n } });
  const quota = { indexBytes: 0, visitedCandidates: 0 }, a = setup(A, quota), b = setup(B, quota);
  try {
    const old = a.index.captureFile(file), untouched = b.index.captureFile(other);
    const oldSnapshot = a.index.snapshotId(), otherSnapshot = b.index.snapshotId(), otherRootId = b.index.scope().directoryId;
    const cursorOwner = await a.index.candidates({ directoryId: null, fileId: old.fileId!, query: 'old', refresh: false });
    m.rows[file] = { text: 'fresh\ncontent\n', ino: 52n, mtime: 2n };
    assert.throws(() => a.index.resolveFile(old.fileId!), code('SOURCE_CHANGED'));
    const refreshed = await a.index.refreshFile({ fileId: old.fileId! });
    assert.notEqual(refreshed.fileId, old.fileId); assert.notEqual(a.index.snapshotId(), oldSnapshot);
    assert.throws(() => a.index.resolveFile(old.fileId!), code('CURSOR_STALE'));
    await assert.rejects(cursorOwner.next(), code('CURSOR_STALE'));
    assert.equal(b.index.snapshotId(), otherSnapshot); assert.equal(b.index.scope().directoryId, otherRootId);
    assert.equal(b.index.resolveFile(untouched.fileId!).absolutePath, other);
    const captured = a.index.resolveFile(refreshed.fileId!), reader = createProjectTextReader({
      root: a.root, file: captured, expectedVersion: null, signal: a.abort.signal, budget: createProjectReadIoBudget(),
    });
    const result = await reader.step(createProjectReadOperation(a.abort.signal));
    assert.equal(result.kind, 'complete'); if (result.kind === 'complete') assert.equal(result.value.version, digest('fresh\ncontent\n'));
    await reader.close(); await cursorOwner.close();
    assert.deepEqual(m.seen.listed, []); assert.deepEqual(m.seen.opened, [file]);
  } finally { await a.index.dispose(); await b.index.dispose(); }
  assert.equal(quota.indexBytes, 0);
});
test('filesystem refreshFile: direct absolute file refresh stays singular and rejects foreign issued identity', async t => {
  const file = A + '\\run.out', m = memory(t, { [file]: { text: 'old' }, [A + '\\neighbor.out']: { text: 'neighbor' }, [B + '\\run.out']: { text: 'foreign' } });
  const a = setup(A), b = setup(B);
  try {
    const initial = a.index.captureFile(file), foreign = b.index.captureFile(B + '\\run.out'), snapshot = a.index.snapshotId();
    await assert.rejects(a.index.refreshFile({ fileId: foreign.fileId! }), code('CURSOR_STALE'));
    assert.equal(a.index.snapshotId(), snapshot);
    m.rows[file]!.text = 'updated output'; m.rows[file]!.mtime = 3n;
    const fresh = await a.index.refreshFile({ absolutePath: file });
    assert.notEqual(fresh.fileId, initial.fileId); assert.equal(a.index.resolveFile(fresh.fileId!).size, Buffer.byteLength('updated output'));
    const stream = await a.index.candidates({ directoryId: null, fileId: fresh.fileId!, query: 'updated', refresh: false });
    const first = await stream.next(); assert.equal(first.kind, 'entry');
    if (first.kind === 'entry') assert.equal(first.entry.fileId, fresh.fileId);
    assert.equal((await stream.next()).kind, 'complete'); await stream.close();
    assert.deepEqual(m.seen.listed, []); assert.deepEqual(m.seen.opened, []);
  } finally { await a.index.dispose(); await b.index.dispose(); }
});
