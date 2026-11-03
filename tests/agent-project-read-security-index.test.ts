import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureFolderRoot, type FolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { ProjectReadFsError } from '../apps/desktop/src/main/cloud/project-read-files';
import { createProjectReadIndex, ProjectReadIndexError, type ProjectReadIndex } from '../apps/desktop/src/main/cloud/project-read-index';

const product = path.resolve('C:/work/analog_ai_workbench');
const parent = path.join(product, '.local/quality-evidence/20260911-agent-project-read-security-01/fixtures');
const args = (cursor: string | null = null, directoryId: string | null = null, refresh = false) => ({ cursor, directoryId, refresh });
const code = (expected: string) => (error: unknown) => error instanceof ProjectReadFsError && error.code === expected;
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
type Hooks = { beforeOpen?: (directory: string) => Promise<void>; afterRead?: () => Promise<void> };
function under(target: string, base: string): string {
  const value = path.resolve(target), relative = path.relative(base, value);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); return value;
}
function noLinks(target: string): void {
  let value = path.parse(target).root;
  for (const part of target.slice(value.length).split(path.sep)) { value = path.join(value, part); if (fs.existsSync(value)) assert.equal(fs.lstatSync(value).isSymbolicLink(), false); }
}
async function fixture(body: (f: { base: string; root: FolderRoot; write(name: string): void; make(kind?: 'run' | 'inspection', abort?: AbortController, root?: FolderRoot): ProjectReadIndex; seen: { opened: number; reads: number; closed: number; bodies: number } }) => Promise<void>, hooks: Hooks = {}) {
  assert.equal(path.resolve(process.cwd()).toLowerCase(), product.toLowerCase()); noLinks(parent);
  const base = under(path.join(parent, randomUUID()), parent); assert.equal(fs.existsSync(base), false); fs.mkdirSync(base, { recursive: true });
  const root = captureFolderRoot(randomUUID(), randomUUID(), base), indexes: ProjectReadIndex[] = [], closes: (() => Promise<void>)[] = [];
  const seen = { opened: 0, reads: 0, closed: 0, bodies: 0 }, identity = randomUUID(), ownerId = randomUUID();
  const descriptors = [[asyncFs, 'opendir'], [asyncFs, 'open'], [asyncFs, 'readFile'], [fs, 'readFileSync']].map(([object, key]) => ({ object: object as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(object, key as string)! }));
  const originalOpen = asyncFs.opendir;
  const deniedBody = () => { seen.bodies++; throw new Error('index attempted a file body read'); };
  Object.defineProperty(asyncFs, 'opendir', { ...descriptors[0]!.descriptor, value: async (...parameters: Parameters<typeof asyncFs.opendir>) => {
    const directory = path.resolve(String(parameters[0])); assert.ok(directory === base || under(directory, base));
    await hooks.beforeOpen?.(directory); const handle = await originalOpen(...parameters); seen.opened++;
    const read = handle.read, close = handle.close;
    closes.push(() => Reflect.apply(close, handle, []) as Promise<void>);
    Object.defineProperty(handle, 'read', { configurable: true, value: async () => { const entry = await Reflect.apply(read, handle, []); seen.reads++; await hooks.afterRead?.(); return entry; } });
    Object.defineProperty(handle, 'close', { configurable: true, value: async () => { await Reflect.apply(close, handle, []); seen.closed++; } });
    return handle;
  } });
  for (const row of descriptors.slice(1)) Object.defineProperty(row.object, row.key, { ...row.descriptor, value: deniedBody });
  try { await body({ base, root, seen, write(name) { const target = under(path.join(base, name), base); noLinks(path.dirname(target)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'synthetic body and AGENTS rules must remain unread'); }, make(kind = 'inspection', abort = new AbortController(), chosenRoot = root) { const index = createProjectReadIndex({ root: chosenRoot, identity, owner: { kind, id: ownerId }, signal: abort.signal }); indexes.push(index); return index; } }); }
  finally {
    await Promise.allSettled(indexes.map(index => index.dispose())); await Promise.allSettled(closes.map(close => close()));
    for (const row of descriptors) Object.defineProperty(row.object, row.key, row.descriptor);
    const resolved = fs.realpathSync.native(base); assert.equal(resolved.toLowerCase(), base.toLowerCase()); under(resolved, parent); noLinks(resolved); assert.match(path.basename(resolved), /^[0-9a-f-]{36}$/u); fs.rmSync(resolved, { recursive: true });
  }
}

test('independent index authority: opaque IDs and one-use cursors bind instance, scope and operation without body reads', async () => {
  await fixture(async f => {
    for (let n = 0; n < 95; n++) f.write(`left/entry-${n}-${'x'.repeat(80)}.txt`);
    f.write('right/AGENTS.md');
    const index = f.make(), rootPage = await index.list(args());
    const left = rootPage.entries.find(row => row.name === 'left')!.directoryId!, right = rootPage.entries.find(row => row.name === 'right')!.directoryId!;
    const page = await index.list(args(null, left)), cursor = page.coverage.nextCursor!, file = page.entries[0]!.fileId!;
    assert.ok(cursor); assert.equal(page.coverage.scope.relativeDirectory, 'left');
    const foreignRoot = captureFolderRoot(randomUUID(), randomUUID(), f.base), foreign = f.make('inspection', undefined, foreignRoot), model = f.make('run');
    for (const other of [foreign, model]) { assert.throws(() => other.resolveFile(file), code('CURSOR_STALE')); await assert.rejects(other.list(args(cursor, left)), code('CURSOR_STALE')); }
    const reads = f.seen.reads;
    await assert.rejects(index.list(args(cursor, right)), code('CURSOR_STALE'));
    await assert.rejects(index.find({ ...args(cursor, left), query: 'entry' }), code('CURSOR_STALE'));
    assert.equal(f.seen.reads, reads);
    const next = await index.list(args(cursor, left)); await assert.rejects(index.list(args(cursor, left)), code('CURSOR_STALE'));
    assert.equal(new Set([...page.entries, ...next.entries].map(row => row.fileId)).size, page.entries.length + next.entries.length);
    assert.equal(page.coverage.scannedFiles, 0); assert.equal(page.coverage.scannedBytes, 0); assert.deepEqual(page.rules, []);
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, value: page })) <= 12288);
    const walker = await index.candidates({ directoryId: left, query: 'content', refresh: false });
    const refreshed = await index.list(args(null, null, true)); assert.notEqual(refreshed.snapshotId, page.snapshotId);
    assert.throws(() => index.resolveFile(file), code('CURSOR_STALE')); assert.throws(() => index.resolveDirectory(left), code('CURSOR_STALE')); await assert.rejects(walker.next(), code('CURSOR_STALE'));
    assert.equal(f.seen.bodies, 0);
  });
});

test('independent index atomic result: a directory mutation after real enumeration invalidates the whole pending page', async () => {
  const entered = gate(), released = gate(); let once = false;
  await fixture(async f => {
    f.write('existing.txt'); const index = f.make(), work = index.list(args());
    try {
      await Promise.race([entered.promise, work.then(() => assert.fail('page returned before race gate'))]);
      f.write('added-during-read.txt'); released.release(); await assert.rejects(work, code('SNAPSHOT_CHANGED'));
      await index.dispose(); assert.equal(f.seen.opened, f.seen.closed); assert.equal(f.seen.bodies, 0);
    } finally { released.release(); await work.catch(() => {}); }
  }, { afterRead: async () => { if (!once) { once = true; entered.release(); await released.promise; } } });
});

test('independent index cancellation: pending real open and pending real entry delivery close their exact handles', async t => {
  for (const stage of ['open', 'read'] as const) await t.test(stage, async () => {
    const entered = gate(), released = gate(); let once = false;
    const pause = async () => { if (!once) { once = true; entered.release(); await released.promise; } };
    await fixture(async f => {
      f.write('one.txt'); const abort = new AbortController(), index = f.make('inspection', abort), work = index.list(args());
      try {
        await Promise.race([entered.promise, work.then(() => assert.fail('operation returned before cancellation gate'))]);
        abort.abort(); const close = index.dispose(); assert.equal(index.dispose(), close); released.release();
        await assert.rejects(work, code('CANCELLED')); await close;
        assert.equal(f.seen.opened, 1); assert.equal(f.seen.closed, 1); assert.equal(f.seen.reads, stage === 'open' ? 0 : 1);
        const reads = f.seen.reads; await assert.rejects(index.list(args()), code('CANCELLED')); assert.equal(f.seen.reads, reads); assert.equal(f.seen.bodies, 0);
      } finally { released.release(); await work.catch(() => {}); }
    }, stage === 'open' ? { beforeOpen: pause } : { afterRead: pause });
  });
});

test('independent index unavailable coverage: a failed directory open is partial evidence, never complete absence', async t => {
  for (const scope of ['root', 'child'] as const) await t.test(scope, async () => {
    let rejectedPath = '';
    await fixture(async f => {
      f.write('blocked/hidden-target.txt'); f.write('available.txt'); rejectedPath = scope === 'root' ? f.base : path.join(f.base, 'blocked');
      const index = f.make();
      await assert.rejects(index.find({ ...args(), query: 'hidden-target' }), (error: unknown) => {
        assert.ok(error instanceof ProjectReadIndexError); assert.equal(error.code, 'SCOPE_LIMIT'); assert.ok(error.coverage);
        assert.equal(error.coverage.complete, false); assert.equal(error.coverage.limitReason, 'scope'); assert.equal(error.coverage.skipped.unavailable, 1);
        assert.ok(error.coverage.remaining.directories! > 0); assert.equal(error.coverage.scannedBytes, 0); assert.equal(error.coverage.scannedFiles, 0); return true;
      });
      await index.dispose(); assert.equal(f.seen.opened, f.seen.closed); assert.equal(f.seen.bodies, 0);
    }, { beforeOpen: async directory => { if (directory === rejectedPath) throw Object.assign(new Error('synthetic access denial'), { code: 'EACCES' }); } });
  });
});

test('independent index walker close: late candidate cannot escape its revoked walk while shared index remains usable', async () => {
  const entered = gate(), released = gate(); let once = false;
  await fixture(async f => {
    f.write('entry.txt'); const index = f.make(), walker = await index.candidates({ directoryId: null, query: 'body', refresh: false }), work = walker.next();
    try {
      await Promise.race([entered.promise, work.then(() => assert.fail('candidate returned before close gate'))]);
      await walker.close(); released.release(); await assert.rejects(work, code('CURSOR_STALE')); assert.throws(() => walker.coverage(), code('CURSOR_STALE'));
      const page = await index.list(args()); assert.equal(page.entries[0]?.name, 'entry.txt'); assert.equal(page.coverage.complete, true);
      assert.equal(f.seen.opened, 1); assert.equal(f.seen.closed, 1); assert.equal(f.seen.bodies, 0);
    } finally { released.release(); await work.catch(() => {}); }
  }, { afterRead: async () => { if (!once) { once = true; entered.release(); await released.promise; } } });
});
