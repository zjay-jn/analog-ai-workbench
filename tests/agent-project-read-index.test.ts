import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { createProjectReadIndex, ProjectReadIndexError } from '../apps/desktop/src/main/cloud/project-read-index';
import { ProjectReadFsError } from '../apps/desktop/src/main/cloud/project-read-files';
import { PROJECT_READ_LIMITS as L } from '../apps/desktop/src/shared/agent/agent-project-read';
import { parseProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read-validation';

const productRoot = path.resolve('C:/work/analog_ai_workbench');
const fixtureParent = path.join(productRoot, '.local', 'agent-project-read-tests');
function fixture() {
  const directory = path.resolve(fixtureParent, `index-fixture-${randomUUID()}`);
  assert.ok(directory.startsWith(productRoot + path.sep)); assert.equal(fs.existsSync(directory), false);
  fs.mkdirSync(directory, { recursive: false });
  const root = captureFolderRoot(randomUUID(), randomUUID(), directory), identity = randomUUID();
  return { directory, root, identity, index(kind: 'run' | 'inspection' = 'run', abort = new AbortController()) {
    return createProjectReadIndex({ root, identity, owner: { kind, id: randomUUID() }, signal: abort.signal });
  } };
}
const hasCode = (code: string) => (error: unknown) => error instanceof ProjectReadFsError && error.code === code;
const listArgs = (cursor: string | null = null, directoryId: string | null = null, refresh = false) => ({ directoryId, cursor, refresh });

test('inspection lists all 2501 ordinary files without omissions, repetitions, body I/O or a legacy 2000 cap', async () => {
  const f = fixture(), expected = new Set<string>();
  for (let n = 0; n < 2501; n++) { const name = `record-${String(n).padStart(4, '0')}.txt`; expected.add(name); fs.writeFileSync(path.join(f.directory, name), 'only synthetic fixture text'); }
  const index = f.index('inspection'), found = new Set<string>(), ids = new Set<string>(); let cursor: string | null = null, pages = 0, snapshotId = '', late = false;
  try {
    do {
      const result = await index.list(listArgs(cursor)); pages++;
      assert.ok(parseProjectReadToolResult({ ok: true, value: result }));
      assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, value: result })) <= L.toolResultBytes);
      assert.ok(result.entries.length <= L.listPage); assert.equal(result.coverage.scannedBytes, 0); assert.equal(result.coverage.scannedFiles, 0); assert.deepEqual(result.rules, []);
      if (!snapshotId) snapshotId = result.snapshotId; else assert.equal(result.snapshotId, snapshotId);
      for (const entry of result.entries) { assert.equal(found.has(entry.name), false); assert.equal(ids.has(entry.fileId!), false); found.add(entry.name); ids.add(entry.fileId!); assert.equal(entry.version, null); if (found.size > 2000) late = true; }
      cursor = result.coverage.nextCursor;
      assert.equal(result.coverage.complete, cursor === null); if (cursor) assert.ok(result.coverage.limitReason); else assert.equal(result.coverage.scannedCandidates, 2501);
      assert.ok(pages <= L.browsePages);
    } while (cursor);
    assert.deepEqual(found, expected); assert.equal(ids.size, 2501); assert.equal(late, true); assert.ok(pages > 25); assert.equal(index.accounting().indexedCandidates, 2501);
    // A fresh model query can reach the late target directly, without receiving all earlier pages.
    const model = f.index();
    try { const result = await model.find({ ...listArgs(), query: 'record-2500' }); assert.equal(result.coverage.complete, true); assert.equal(result.entries[0]?.name, 'record-2500.txt'); assert.equal(result.entries.length, 1); }
    finally { await model.dispose(); }
  } finally { await index.dispose(); }
});

test('main-issued IDs, cursor operation/query/scope binding, one-shot advance and inspection domains are enforced', async () => {
  const f = fixture(); for (let n = 0; n < 150; n++) fs.writeFileSync(path.join(f.directory, `row-${n}.txt`), 'synthetic'); fs.mkdirSync(path.join(f.directory, 'child'));
  const first = f.index(), other = f.index(), inspection = f.index('inspection');
  try {
    const page = await first.list(listArgs()), cursor = page.coverage.nextCursor!; assert.ok(cursor);
    const file = page.entries.find(entry => entry.kind === 'file')!; assert.ok(first.resolveFile(file.fileId!).absolutePath.startsWith(f.directory + path.sep));
    assert.throws(() => first.resolveFile('row-1.txt'), hasCode('CURSOR_STALE'));
    assert.throws(() => other.resolveFile(file.fileId!), hasCode('CURSOR_STALE'));
    await assert.rejects(other.list(listArgs(cursor)), hasCode('CURSOR_STALE'));
    await assert.rejects(inspection.list(listArgs(cursor)), hasCode('CURSOR_STALE'));
    await assert.rejects(first.find({ ...listArgs(cursor), query: 'row' }), hasCode('CURSOR_STALE'));
    await assert.rejects(first.list(listArgs(cursor, 'invented-directory')), hasCode('CURSOR_STALE'));
    await first.list(listArgs(cursor)); await assert.rejects(first.list(listArgs(cursor)), hasCode('CURSOR_STALE'));
    const queryPage = await first.find({ ...listArgs(), query: 'row' });
    await assert.rejects(first.find({ ...listArgs(queryPage.coverage.nextCursor), query: 'ROW' }), hasCode('CURSOR_STALE'));
    await first.find({ ...listArgs(queryPage.coverage.nextCursor), query: 'row' });
    const empty = await first.find({ ...listArgs(), query: '*.txt' }); assert.equal(empty.entries.length, 0); assert.equal(empty.coverage.complete, true);
    await assert.rejects(first.list(listArgs(null, file.fileId)), hasCode('CURSOR_STALE'));
  } finally { await Promise.all([first.dispose(), other.dispose(), inspection.dispose()]); }
});

test('find uses scalar simple lowercase, recursive scope and no glob or body/rules reads', async () => {
  const f = fixture(); fs.mkdirSync(path.join(f.directory, 'docs'));
  for (const name of ['ΟΣ.txt', 'İSTANBUL.txt', 'Äpfel.txt', 'AGENTS.md']) fs.writeFileSync(path.join(f.directory, 'docs', name), new Uint8Array([0xff, 0x00]));
  fs.writeFileSync(path.join(f.directory, 'outside.txt'), 'needle only in the body');
  const index = f.index();
  try {
    const listing = await index.list(listArgs()), directoryId = listing.entries.find(entry => entry.name === 'docs')!.directoryId;
    assert.equal(index.resolveDirectory(directoryId).relativePath, 'docs');
    for (const [query, name] of [['οσ', 'ΟΣ.txt'], ['istanbul', 'İSTANBUL.txt'], ['äPF', 'Äpfel.txt'], ['agents', 'AGENTS.md']]) {
      const result = await index.find({ ...listArgs(null, directoryId), query: query! }); assert.equal(result.entries[0]?.name, name); assert.equal(result.coverage.scope.relativeDirectory, 'docs'); assert.equal(result.entries[0]?.parentId, directoryId); assert.equal(result.coverage.scannedBytes, 0); assert.deepEqual(result.rules, []);
    }
    const noBody = await index.find({ ...listArgs(), query: 'needle' }); assert.equal(noBody.entries.length, 0); assert.equal(noBody.coverage.complete, true);
  } finally { await index.dispose(); }
});

test('policy names and links remain anonymous while unsupported and oversized ordinary files remain discoverable', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.directory, 'ordinary.txt'), 'synthetic'); fs.writeFileSync(path.join(f.directory, 'picture.bin'), new Uint8Array([1, 2, 3]));
  fs.writeFileSync(path.join(f.directory, 'huge.txt'), ''); const fd = fs.openSync(path.join(f.directory, 'huge.txt'), 'r+'); try { fs.ftruncateSync(fd, L.fileBytes + 1); } finally { fs.closeSync(fd); }
  fs.writeFileSync(path.join(f.directory, 'private-secret.txt'), 'synthetic denied name'); fs.mkdirSync(path.join(f.directory, '.hidden'));
  fs.mkdirSync(path.join(f.directory, 'safe-child')); fs.symlinkSync(path.join(f.directory, 'safe-child'), path.join(f.directory, 'junction'), 'junction');
  fs.linkSync(path.join(f.directory, 'ordinary.txt'), path.join(f.directory, 'hardlink.txt'));
  const index = f.index();
  try {
    const result = await index.list(listArgs()), serialized = JSON.stringify(result);
    for (const forbidden of ['private-secret', '.hidden', 'junction', 'ordinary.txt', 'hardlink.txt']) assert.equal(serialized.includes(forbidden), false);
    assert.ok(result.coverage.skipped.policy >= 5); assert.equal(result.coverage.skipped.unsupported, 1); assert.equal(result.coverage.skipped.fileLimit, 1);
    const unsupported = result.entries.find(entry => entry.name === 'picture.bin')!, huge = result.entries.find(entry => entry.name === 'huge.txt')!;
    assert.equal(unsupported.readability, 'unsupported'); assert.equal(huge.readability, 'file_limit');
    assert.throws(() => index.resolveFile(unsupported.fileId!), hasCode('UNSUPPORTED_TEXT')); assert.throws(() => index.resolveFile(huge.fileId!), hasCode('FILE_LIMIT'));
    const find = await index.find({ ...listArgs(), query: 'huge' }); assert.equal(find.entries[0]?.bytes, L.fileBytes + 1);
  } finally { await index.dispose(); }
});

test('snapshot signatures reject additions and previously traversed subtree changes; refresh revokes all old authority', async () => {
  const f = fixture(); fs.mkdirSync(path.join(f.directory, 'visited')); fs.writeFileSync(path.join(f.directory, 'visited', 'one.txt'), 'one'); for (let n = 0; n < 150; n++) fs.writeFileSync(path.join(f.directory, `a-${n}.txt`), 'synthetic');
  const index = f.index('inspection');
  try {
    const dirs = await index.find({ ...listArgs(), query: 'visited' }), directoryId = dirs.entries[0]!.directoryId;
    await index.list(listArgs(null, directoryId)); const page = await index.list(listArgs()), oldFile = page.entries.find(entry => entry.kind === 'file')!.fileId!, oldCursor = page.coverage.nextCursor!;
    const candidate = await index.candidates({ directoryId: null, query: 'text', refresh: false });
    fs.writeFileSync(path.join(f.directory, 'visited', 'new.txt'), 'new');
    await assert.rejects(index.list(listArgs(oldCursor)), hasCode('SNAPSHOT_CHANGED'));
    const fresh = await index.list(listArgs(null, null, true)); assert.notEqual(fresh.snapshotId, page.snapshotId);
    assert.throws(() => index.resolveFile(oldFile), hasCode('CURSOR_STALE')); assert.throws(() => index.resolveDirectory(directoryId), hasCode('CURSOR_STALE'));
    await assert.rejects(index.list(listArgs(oldCursor)), hasCode('CURSOR_STALE')); await assert.rejects(candidate.next(), hasCode('CURSOR_STALE'));
    await assert.rejects(index.list(listArgs(null, null, true)), hasCode('SCOPE_LIMIT'));
    fs.writeFileSync(path.join(f.directory, 'new-root.txt'), 'new'); await assert.rejects(index.list(listArgs(fresh.coverage.nextCursor)), hasCode('SNAPSHOT_CHANGED'));
  } finally { await index.dispose(); }
});

test('signed file metadata detects content replacement before granting a file reader', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.directory, 'source.txt'), 'initial'); const index = f.index();
  try { const result = await index.list(listArgs()), fileId = result.entries[0]!.fileId!; fs.writeFileSync(path.join(f.directory, 'source.txt'), 'changed content'); assert.throws(() => index.resolveFile(fileId), hasCode('SOURCE_CHANGED')); }
  finally { await index.dispose(); }
});

test('incremental metadata candidates yield a 5000-candidate slice and reach the later ordinary target', async () => {
  const f = fixture(); for (let n = 0; n < L.operationCandidates + 1; n++) fs.writeFileSync(path.join(f.directory, `.excluded-${n}`), ''); fs.writeFileSync(path.join(f.directory, 'later.txt'), 'synthetic');
  const index = f.index(), walker = await index.candidates({ directoryId: null, query: 'content-query', refresh: false }); let slices = 0, target = false, complete = false;
  try {
    for (let n = 0; n < 20; n++) { const step = await walker.next(); if (step.kind === 'slice') { slices++; assert.equal(step.coverage.complete, false); assert.ok(['slice', 'time'].includes(step.coverage.limitReason!)); } else if (step.kind === 'entry') { if (step.entry.name === 'later.txt') target = true; } else { complete = true; assert.equal(step.coverage.scannedCandidates, L.operationCandidates + 2); assert.equal(step.coverage.skipped.policy, L.operationCandidates + 1); break; } }
    assert.equal(target, true); assert.equal(complete, true); assert.ok(slices >= 1); assert.equal(walker.coverage().scannedBytes, 0);
    await walker.close(); await assert.rejects(walker.next(), hasCode('CURSOR_STALE'));
  } finally { await index.dispose(); }
});

test('UTF-8 complete wire pages remain within 12 KiB and preserve all long-path entries', async () => {
  const f = fixture(); let target = f.directory;
  for (let level = 0; level < 7; level++) { target = path.join(target, `${level}资料`.repeat(15)); fs.mkdirSync(target); }
  const expected = new Set<string>(); for (let n = 0; n < 23; n++) { const name = `测量数据-${n}.txt`; fs.writeFileSync(path.join(target, name), 'synthetic'); expected.add(name); }
  const index = f.index('inspection'), found = new Set<string>(); let cursor: string | null = null, bytePages = 0;
  try { do { const result = await index.find({ ...listArgs(cursor), query: '测量数据' }); assert.ok(parseProjectReadToolResult({ ok: true, value: result })); assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, value: result })) <= L.toolResultBytes); for (const entry of result.entries) { assert.equal(found.has(entry.name), false); found.add(entry.name); } if (result.coverage.limitReason === 'bytes') bytePages++; cursor = result.coverage.nextCursor; } while (cursor); assert.deepEqual(found, expected); assert.ok(bytePages >= 2); }
  finally { await index.dispose(); }
});

test('cancellation wins over pending enumeration and disposal closes directory handles and revokes completed objects', async () => {
  const f = fixture(); for (let n = 0; n < 120; n++) fs.writeFileSync(path.join(f.directory, `cancel-${n}.txt`), 'synthetic');
  const abort = new AbortController(), index = f.index('inspection', abort); const page = await index.list(listArgs());
  const walker = await index.candidates({ directoryId: null, query: 'synthetic', refresh: false });
  const pending = walker.next(); setImmediate(() => abort.abort());
  await assert.rejects(pending, hasCode('CANCELLED')); await index.dispose();
  assert.throws(() => index.snapshotId(), hasCode('CANCELLED')); assert.throws(() => index.resolveFile(page.entries[0]!.fileId!), hasCode('CANCELLED'));
  await assert.rejects(index.list(listArgs(page.coverage.nextCursor)), hasCode('CANCELLED')); await assert.rejects(walker.next(), hasCode('CANCELLED'));
  const renamed = f.directory + '-closed'; assert.equal(fs.existsSync(renamed), false); fs.renameSync(f.directory, renamed);
});

test('depth exclusions retain partial coverage and invalid refresh cannot repurpose a signed subtree', async () => {
  const f = fixture(); let target = f.directory; for (let n = 0; n < L.depth + 1; n++) { target = path.join(target, `d${n}`); fs.mkdirSync(target); } fs.writeFileSync(path.join(target, 'beyond.txt'), 'synthetic');
  const index = f.index();
  try {
    const listing = await index.list(listArgs()), directoryId = listing.entries[0]!.directoryId;
    await assert.rejects(index.list(listArgs(null, directoryId, true)), hasCode('INVALID_REQUEST'));
    await assert.rejects(index.find({ ...listArgs(), query: 'beyond' }), (error: unknown) => { assert.ok(error instanceof ProjectReadIndexError); assert.equal(error.code, 'SCOPE_LIMIT'); assert.equal(error.coverage?.complete, false); assert.equal(error.coverage?.limitReason, 'scope'); assert.ok(error.coverage?.remaining.directories); return true; });
  } finally { await index.dispose(); }
});

test('root replacement rejects a same-path new directory and closes the former directory handle', async () => {
  const f = fixture(); for (let n = 0; n < 120; n++) fs.writeFileSync(path.join(f.directory, `original-${n}.txt`), 'synthetic');
  const index = f.index('inspection');
  try {
    const page = await index.list(listArgs()), retired = path.resolve(f.directory + '-retired');
    assert.ok(retired.startsWith(productRoot + path.sep)); assert.equal(fs.existsSync(retired), false); fs.renameSync(f.directory, retired); fs.mkdirSync(f.directory);
    await assert.rejects(index.list(listArgs(page.coverage.nextCursor)), hasCode('ROOT_CHANGED'));
    assert.throws(() => index.resolveFile(page.entries[0]!.fileId!), hasCode('ROOT_CHANGED'));
    await index.dispose(); const released = path.resolve(retired + '-closed'); assert.ok(released.startsWith(productRoot + path.sep)); assert.equal(fs.existsSync(released), false); fs.renameSync(retired, released);
  } finally { await index.dispose(); }
});

test('run cumulative return budget preserves partial context coverage instead of claiming a complete listing', async () => {
  const f = fixture(); for (let n = 0; n < 400; n++) fs.writeFileSync(path.join(f.directory, `ordinary-${n}-${'x'.repeat(80)}.txt`), 'synthetic');
  const index = f.index(); let cursor: string | null = null, delivered = 0, reachedBudget = false;
  try {
    for (let n = 0; n < L.toolCalls; n++) {
      try { const result = await index.list(listArgs(cursor)); delivered += result.entries.length; cursor = result.coverage.nextCursor; if (cursor === null) break; }
      catch (error) { assert.ok(error instanceof ProjectReadIndexError); assert.equal(error.code, 'BUDGET_EXCEEDED'); assert.equal(error.coverage?.complete, false); assert.equal(error.coverage?.limitReason, 'context'); reachedBudget = true; break; }
    }
    assert.equal(reachedBudget, true); assert.ok(delivered > 0 && delivered < 400); assert.ok(index.accounting().returnedBytes <= L.toolContextBytes);
  } finally { await index.dispose(); }
});
