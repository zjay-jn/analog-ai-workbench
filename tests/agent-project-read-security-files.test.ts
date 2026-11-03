import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { captureFolderRoot, type FolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import {
  captureProjectReadFile, verifyProjectReadRoot, createProjectTextReader,
  createProjectReadIoBudget, createProjectReadOperation, ProjectReadFsError,
  type ProjectReadFile, type ProjectReadIoBudget, type ProjectReadTextSnapshot,
} from '../apps/desktop/src/main/cloud/project-read-files';

const product = path.resolve('C:/work/analog_ai_workbench');
const fixtureParent = path.join(product, '.local/quality-evidence/20260911-agent-project-read-security-01/fixtures');
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const code = (...expected: string[]) => (error: unknown) => error instanceof ProjectReadFsError && expected.includes(error.code);
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
type Reader = ReturnType<typeof createProjectTextReader>;
type ReadObservation = { path: string; ordinal: number; offset: number; requested: number; bufferOffset: number; actual: number | null };
type Observation = { opened: string[]; reads: ReadObservation[]; closeAttempts: number; closed: number };
type Hooks = {
  beforeOpen?: () => Promise<void>;
  redirectOpen?: string;
  afterOpen?: (handle: FileHandle) => void | Promise<void>;
  readLimit?: number;
  beforeRead?: (row: ReadObservation) => void | Promise<void>;
  afterRead?: (row: ReadObservation, buffer: Buffer) => void | Promise<void>;
  afterClose?: () => void | Promise<void>;
};
type Fixture = {
  base: string; source: string; root: FolderRoot; seen: Observation;
  write: (name: string, value: string | Uint8Array) => string;
  junction: (link: string, target: string) => void;
  reader: (file: ProjectReadFile, abort: AbortController, budget: ProjectReadIoBudget, version?: string | null, root?: FolderRoot) => Reader;
};
function inside(target: string, parent: string): string {
  const absolute = path.resolve(target), relative = path.relative(parent, absolute);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return absolute;
}
function noLinks(target: string): void {
  let at = path.parse(target).root;
  for (const part of target.slice(at.length).split(path.sep)) {
    at = path.join(at, part);
    if (fs.existsSync(at)) assert.equal(fs.lstatSync(at).isSymbolicLink(), false);
  }
}
async function fixture<T>(body: (f: Fixture) => Promise<T>, hooks: Hooks = {}): Promise<T> {
  assert.equal(path.resolve(process.cwd()).toLowerCase(), product.toLowerCase());
  noLinks(fixtureParent);
  const base = inside(path.join(fixtureParent, randomUUID()), fixtureParent), source = path.join(base, 'source');
  assert.equal(fs.existsSync(base), false); fs.mkdirSync(source, { recursive: true }); noLinks(base);
  const root = captureFolderRoot(randomUUID(), randomUUID(), source), readers: Reader[] = [], links: string[] = [];
  const seen: Observation = { opened: [], reads: [], closeAttempts: 0, closed: 0 };
  const descriptor = Object.getOwnPropertyDescriptor(asyncFs, 'open')!, originalOpen = asyncFs.open;
  const rawCloses: (() => Promise<void>)[] = [];
  Object.defineProperty(asyncFs, 'open', { ...descriptor, value: async (...args: Parameters<typeof asyncFs.open>) => {
    const requestedPath = inside(String(args[0]), base);
    await hooks.beforeOpen?.();
    const actualPath = hooks.redirectOpen ? inside(hooks.redirectOpen, base) : requestedPath;
    const handle = await originalOpen(actualPath, args[1], args[2]); seen.opened.push(actualPath);
    const read = handle.read, close = handle.close;
    rawCloses.push(() => Reflect.apply(close, handle, []) as Promise<void>);
    Object.defineProperty(handle, 'read', { configurable: true, value: async (buffer: Buffer, bufferOffset: number, requested: number, position: number) => {
      const row: ReadObservation = { path: actualPath, ordinal: seen.reads.length + 1, offset: position, requested, bufferOffset, actual: null };
      seen.reads.push(row); await hooks.beforeRead?.(row);
      const result = await Reflect.apply(read, handle, [buffer, bufferOffset, Math.min(requested, hooks.readLimit ?? requested), position]) as { bytesRead: number; buffer: Buffer };
      row.actual = result.bytesRead; await hooks.afterRead?.(row, buffer); return result;
    } });
    Object.defineProperty(handle, 'close', { configurable: true, value: async () => {
      seen.closeAttempts++; await Reflect.apply(close, handle, []); seen.closed++; await hooks.afterClose?.();
    } });
    await hooks.afterOpen?.(handle); return handle;
  } });
  const f: Fixture = {
    base, source, root, seen,
    write(name, value) { const target = inside(path.join(base, name), base); noLinks(path.dirname(target)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return target; },
    junction(link, target) { inside(link, base); inside(target, base); fs.symlinkSync(target, link, 'junction'); links.push(link); },
    reader(file, abort, budget, version = null, readerRoot = root) {
      const value = createProjectTextReader({ root: readerRoot, file, expectedVersion: version, signal: abort.signal, budget }); readers.push(value); return value;
    },
  };
  try { return await body(f); }
  finally {
    await Promise.allSettled(readers.map(reader => reader.close()));
    await Promise.allSettled(rawCloses.map(close => close()));
    Object.defineProperty(asyncFs, 'open', descriptor);
    for (const link of links) if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(inside(link, base));
    const resolved = fs.realpathSync.native(base);
    assert.equal(resolved.toLowerCase(), base.toLowerCase()); inside(resolved, fixtureParent); noLinks(resolved);
    assert.match(path.basename(resolved), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    fs.rmSync(resolved, { recursive: true });
  }
}
async function drain(reader: Reader, abort: AbortController, operationBytes = 49152): Promise<ProjectReadTextSnapshot> {
  for (let i = 0; i < 256; i++) {
    const step = await reader.step(createProjectReadOperation(abort.signal, { bytes: operationBytes }));
    if (step.kind === 'complete') return step.value;
    assert.deepEqual(Object.keys(step).sort(), ['kind', 'offset', 'pass']);
  }
  return assert.fail('bounded reader did not finish');
}

test('project files independent scope: lexical, hidden and application-data locators cannot open content', async () => {
  await fixture(async f => {
    f.write('source/ok.txt', 'allowed synthetic text');
    for (const name of ['api.txt', 'agent-engine-live/runs.json', 'agent-engine-pilot/runs.json', 'agent-project-read/runs.json', 'agent-engine-candidate-v1.18.17/source.txt', '.hidden/info.md', 'models/info.txt']) f.write('source/' + name, 'rejected synthetic text');
    for (const locator of ['../outside.txt', '/ok.txt', 'C:/outside.txt', 'C:\\outside.txt', 'a\\ok.txt', 'ok.txt:stream', './ok.txt', 'folder/../ok.txt', 'ok.txt.', 'ok.txt ', 'CON.txt', 'api.txt', 'agent-engine-live/runs.json', 'agent-engine-pilot/runs.json', 'agent-project-read/runs.json', 'agent-engine-candidate-v1.18.17/source.txt', '.hidden/info.md', 'models/info.txt']) {
      assert.throws(() => captureProjectReadFile(f.root, locator), code('UNSUPPORTED_PATH'), locator);
    }
    const captured = captureProjectReadFile(f.root, 'ok.txt');
    assert.equal(captured.relativePath, 'ok.txt'); assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.chain));
    assert.equal(f.seen.opened.length, 0); assert.equal(f.seen.reads.length, 0);
  });
});

test('project files independent scope: a forged outside locator or conflicting relative identity is rejected before open', async () => {
  await fixture(async f => {
    f.write('source/file.txt', 'inside'); f.write('source-neighbour/file.txt', 'outside but synthetic');
    const foreignRoot = captureFolderRoot(f.root.projectId, f.root.bindingId, path.join(f.base, 'source-neighbour'));
    const foreign = captureProjectReadFile(foreignRoot, 'file.txt'), own = captureProjectReadFile(f.root, 'file.txt');
    for (const file of [foreign, { ...own, absolutePath: foreign.absolutePath }, { ...own, relativePath: '../source-neighbour/file.txt' }, { ...own, chain: foreign.chain }]) {
      const abort = new AbortController(), budget = createProjectReadIoBudget(), reader = f.reader(file, abort, budget);
      await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), code('UNSUPPORTED_PATH'));
      assert.deepEqual(budget.evidence(), { maxBytes: 268435456, chargedBytes: 0, physicalReadBytes: 0, uncertainReadCalls: 0, readCalls: 0 });
    }
    assert.equal(f.seen.opened.length, 0);
  });
});

test('project files independent identity: captured files, parents and roots cannot be replaced before the first body read', async t => {
  for (const vector of ['same-length-write', 'replace-same-content', 'delete', 'add-hardlink', 'replace-parent', 'replace-root', 'missing-root', 'junction-parent'] as const) await t.test(vector, async () => {
    await fixture(async f => {
      const target = f.write('source/folder/file.txt', 'original content');
      const file = captureProjectReadFile(f.root, 'folder/file.txt');
      if (vector === 'same-length-write') fs.writeFileSync(target, 'modified content');
      if (vector === 'replace-same-content') { fs.renameSync(target, path.join(f.source, 'folder/old.txt')); fs.writeFileSync(target, 'original content'); }
      if (vector === 'delete') fs.unlinkSync(target);
      if (vector === 'add-hardlink') fs.linkSync(target, path.join(f.base, 'other-link.txt'));
      if (vector === 'replace-parent') { fs.renameSync(path.dirname(target), path.join(f.source, 'previous')); f.write('source/folder/file.txt', 'original content'); }
      if (vector === 'replace-root' || vector === 'missing-root') {
        fs.renameSync(f.source, path.join(f.base, 'previous-source'));
        if (vector === 'replace-root') f.write('source/folder/file.txt', 'original content');
      }
      if (vector === 'junction-parent') {
        fs.renameSync(path.dirname(target), path.join(f.base, 'original-folder'));
        f.junction(path.dirname(target), path.join(f.base, 'original-folder'));
      }
      const abort = new AbortController(), budget = createProjectReadIoBudget(), reader = f.reader(file, abort, budget);
      const expected = vector === 'missing-root' ? ['ROOT_UNAVAILABLE'] : vector === 'replace-root' ? ['ROOT_CHANGED'] : vector === 'delete' ? ['FILE_UNAVAILABLE'] : ['SOURCE_CHANGED'];
      await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), code(...expected));
      assert.equal(f.seen.opened.length, 0); assert.equal(budget.evidence().readCalls, 0);
    });
  });
});

test('project files independent descriptor: an open race returning a foreign real handle is detected by fstat before content', async () => {
  const hooks: Hooks = {};
  await fixture(async f => {
    f.write('source/file.txt', 'same length'); hooks.redirectOpen = f.write('foreign.txt', 'same length');
    const abort = new AbortController(), budget = createProjectReadIoBudget();
    const reader = f.reader(captureProjectReadFile(f.root, 'file.txt'), abort, budget);
    await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), code('SOURCE_CHANGED'));
    await reader.close(); assert.equal(f.seen.reads.length, 0); assert.equal(f.seen.closed, 1); assert.equal(budget.evidence().physicalReadBytes, 0);
  }, hooks);
});

test('project files independent integrity: a corrupt second read cannot publish an otherwise metadata-stable file', async () => {
  let starts = 0;
  const hooks: Hooks = { afterRead(row, buffer) { if (row.offset === 0 && ++starts === 2) buffer[row.bufferOffset] = buffer[row.bufferOffset]! ^ 1; } };
  await fixture(async f => {
    const target = f.write('source/text.txt', 'known original bytes\n');
    const abort = new AbortController(), budget = createProjectReadIoBudget();
    const reader = f.reader(captureProjectReadFile(f.root, 'text.txt'), abort, budget);
    await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), code('SOURCE_CHANGED'));
    assert.equal(starts, 2); assert.equal(f.seen.closed, 1); assert.equal(fs.readFileSync(target, 'utf8'), 'known original bytes\n');
    assert.equal(budget.evidence().physicalReadBytes, 2 * Buffer.byteLength('known original bytes\n'));
  }, hooks);
});

test('project files independent accounting: short reads count actual bytes and unknown failed reads retain reservation', async t => {
  await t.test('short-confirmed', async () => {
    await fixture(async f => {
      const raw = Buffer.from('short-read-'.repeat(11)); f.write('source/data.txt', raw);
      const abort = new AbortController(), budget = createProjectReadIoBudget(raw.length * 2);
      const reader = f.reader(captureProjectReadFile(f.root, 'data.txt'), abort, budget), value = await drain(reader, abort, 1000);
      assert.equal(value.version, digest(raw)); assert.equal(value.source.text, raw.toString());
      assert.equal(budget.evidence().physicalReadBytes, raw.length * 2);
      assert.equal(budget.evidence().chargedBytes, raw.length * 2); assert.equal(budget.remaining(), 0);
      assert.ok(f.seen.reads.every(row => row.actual !== null && row.actual <= 3));
      assert.equal(f.seen.reads.reduce((sum, row) => sum + row.actual!, 0), budget.evidence().physicalReadBytes);
    }, { readLimit: 3 });
  });
  await t.test('uncertain-after-os-read', async () => {
    await fixture(async f => {
      f.write('source/data.txt', '0123456789');
      const abort = new AbortController(), budget = createProjectReadIoBudget(10), reader = f.reader(captureProjectReadFile(f.root, 'data.txt'), abort, budget);
      await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), code('IO_ERROR'));
      assert.equal(f.seen.reads[0]!.actual, 10);
      assert.deepEqual(budget.evidence(), { maxBytes: 10, chargedBytes: 10, physicalReadBytes: 0, uncertainReadCalls: 1, readCalls: 1 });
      assert.throws(() => budget.reserve(1), code('BUDGET_EXCEEDED')); assert.equal(f.seen.closed, 1);
    }, { afterRead() { throw Error('synthetic uncertain delivery after OS read'); } });
  });
  await t.test('last-reservation-is-exclusive', async () => {
    const budget = createProjectReadIoBudget(8), settle = budget.reserve(8);
    assert.throws(() => budget.reserve(1), code('BUDGET_EXCEEDED')); settle(null);
    assert.throws(() => budget.reserve(1), code('BUDGET_EXCEEDED'));
    assert.throws(() => settle(0), code('INVALID_REQUEST'));
    assert.equal(budget.remaining(), 0); assert.equal(budget.evidence().uncertainReadCalls, 1);
  });
});

test('project files independent cancellation: abort before open, during opening and after real read never returns data', async t => {
  await t.test('before-open', async () => fixture(async f => {
    f.write('source/data.txt', 'data'); const abort = new AbortController(), budget = createProjectReadIoBudget();
    const reader = f.reader(captureProjectReadFile(f.root, 'data.txt'), abort, budget); abort.abort();
    await assert.rejects(reader.step(createProjectReadOperation(new AbortController().signal)), code('CANCELLED'));
    await reader.close(); assert.equal(f.seen.opened.length, 0); assert.equal(budget.evidence().readCalls, 0);
  }));
  await t.test('pending-open', async () => {
    const entered = defer(), release = defer();
    await fixture(async f => {
      f.write('source/data.txt', 'data'); const abort = new AbortController(), budget = createProjectReadIoBudget();
      const reader = f.reader(captureProjectReadFile(f.root, 'data.txt'), abort, budget);
      const running = reader.step(createProjectReadOperation(abort.signal));
      const rejection = assert.rejects(running, code('CANCELLED'));
      try { await entered.promise; abort.abort(); const close = reader.close(); assert.equal(close, reader.close()); release.resolve(); await rejection; await close; }
      finally { release.resolve(); }
      assert.equal(f.seen.reads.length, 0); assert.equal(f.seen.closed, 1); assert.equal(budget.evidence().physicalReadBytes, 0);
    }, { async beforeOpen() { entered.resolve(); await release.promise; } });
  });
  await t.test('read-delivery-pending', async () => {
    const entered = defer(), release = defer();
    await fixture(async f => {
      const raw = Buffer.alloc(100000, 0x78); f.write('source/data.txt', raw);
      const abort = new AbortController(), budget = createProjectReadIoBudget(), reader = f.reader(captureProjectReadFile(f.root, 'data.txt'), abort, budget);
      const rejection = assert.rejects(reader.step(createProjectReadOperation(abort.signal)), code('CANCELLED'));
      try { await entered.promise; abort.abort(); release.resolve(); await rejection; await reader.close(); }
      finally { release.resolve(); }
      assert.equal(f.seen.reads.length, 1); assert.equal(f.seen.closed, 1); assert.equal(budget.evidence().physicalReadBytes, 65536);
      await assert.rejects(reader.step(createProjectReadOperation(new AbortController().signal)), code('CANCELLED'));
      assert.equal(f.seen.reads.length, 1);
    }, { async afterRead() { entered.resolve(); await release.promise; } });
  });
});

test('project files independent lifecycle: another step cannot race the same handle and close failure cannot publish success', async t => {
  await t.test('concurrent-step', async () => {
    const entered = defer(), release = defer();
    await fixture(async f => {
      f.write('source/data.txt', 'bounded'); const abort = new AbortController(), budget = createProjectReadIoBudget(), reader = f.reader(captureProjectReadFile(f.root, 'data.txt'), abort, budget);
      const running = reader.step(createProjectReadOperation(abort.signal));
      try { await entered.promise; await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), code('BUSY')); release.resolve(); assert.equal((await running).kind, 'complete'); }
      finally { release.resolve(); }
      assert.equal(f.seen.opened.length, 1); assert.equal(f.seen.closed, 1); assert.equal(budget.evidence().physicalReadBytes, 14);
    }, { async beforeOpen() { entered.resolve(); await release.promise; } });
  });
  await t.test('close-failure', async () => {
    await fixture(async f => {
      f.write('source/data.txt', 'bounded'); const abort = new AbortController(), budget = createProjectReadIoBudget(), reader = f.reader(captureProjectReadFile(f.root, 'data.txt'), abort, budget);
      await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), code('IO_ERROR'));
      const close = reader.close(); assert.equal(close, reader.close()); await assert.rejects(close, /synthetic close failure/u);
      assert.equal(f.seen.closeAttempts, 1); assert.equal(f.seen.closed, 1);
    }, { afterClose() { throw Error('synthetic close failure after real handle close'); } });
  });
});

test('project files independent slice deadline: an elapsed operation preserves only resume state and cannot issue another read', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now'); let clock = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
  try {
    await fixture(async f => {
      f.write('source/data.txt', Buffer.alloc(100000, 0x79));
      const abort = new AbortController(), budget = createProjectReadIoBudget(), reader = f.reader(captureProjectReadFile(f.root, 'data.txt'), abort, budget);
      const first = await reader.step(createProjectReadOperation(abort.signal, { timeoutMs: 10 }));
      assert.deepEqual(first, { kind: 'pending', pass: 1, offset: 65536 }); assert.equal(f.seen.reads.length, 1);
      const value = await drain(reader, abort); assert.equal(value.source.text.length, 100000); assert.equal(budget.evidence().physicalReadBytes, 200000);
    }, { afterRead(row) { if (row.ordinal === 1) clock = 20; } });
  } finally { if (descriptor) Object.defineProperty(performance, 'now', descriptor); else Reflect.deleteProperty(performance, 'now'); }
});

test('project files independent content: bounded actual two-pass I/O preserves raw version and detects wrong version or encoding', async t => {
  await t.test('large-normalized-content', async () => fixture(async f => {
    const raw = Buffer.from('\ufeff' + Array.from({ length: 14009 }, (_, i) => i === 13007 ? 'verified late source: 424243' : 'synthetic row ' + 'q'.repeat(72)).join('\r\n') + '\r\n');
    assert.ok(raw.length > 1048576); f.write('source/large.txt', raw);
    const abort = new AbortController(), budget = createProjectReadIoBudget(), file = captureProjectReadFile(f.root, 'large.txt');
    const value = await drain(f.reader(file, abort, budget), abort);
    assert.equal(value.version, digest(raw)); assert.notEqual(value.normalizedSha256, value.version);
    assert.equal(value.normalizedSha256, digest(Buffer.from(value.source.text)));
    assert.equal(value.source.totalLines, 14010); assert.equal(value.source.text.split('\n')[13007], 'verified late source: 424243');
    assert.ok(value.workingBytes <= 67108864); assert.equal(budget.evidence().physicalReadBytes, raw.length * 2);
    assert.equal(f.seen.opened.length, 1); assert.equal(f.seen.closed, 1);
  }));
  for (const vector of ['wrong-version', 'invalid-utf8', 'too-many-lines'] as const) await t.test(vector, async () => fixture(async f => {
    const raw = vector === 'invalid-utf8' ? Buffer.from([0xed, 0xa0, 0x80]) : vector === 'too-many-lines' ? Buffer.from('\n'.repeat(500000)) : Buffer.from('valid');
    f.write('source/data.txt', raw); const abort = new AbortController(), budget = createProjectReadIoBudget();
    const reader = f.reader(captureProjectReadFile(f.root, 'data.txt'), abort, budget, vector === 'wrong-version' ? '0'.repeat(64) : null);
    await assert.rejects(drain(reader, abort), code(vector === 'wrong-version' ? 'SOURCE_CHANGED' : vector === 'invalid-utf8' ? 'UNSUPPORTED_ENCODING' : 'FILE_LIMIT'));
    assert.equal(budget.evidence().physicalReadBytes, raw.length * 2); assert.equal(f.seen.closed, 1);
  }));
});

test('project files independent root recovery: a missing original directory can recover only when its original identity returns', async () => fixture(async f => {
  f.write('source/data.txt', 'same identity'); const moved = path.join(f.base, 'temporarily-moved');
  fs.renameSync(f.source, moved); assert.throws(() => verifyProjectReadRoot(f.root), code('ROOT_UNAVAILABLE'));
  fs.renameSync(moved, f.source); assert.doesNotThrow(() => verifyProjectReadRoot(f.root));
  fs.renameSync(f.source, moved); f.write('source/data.txt', 'same identity');
  assert.throws(() => verifyProjectReadRoot(f.root), code('ROOT_CHANGED'));
}));
