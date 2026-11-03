import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { createOaReadAdapterForTests, OA_CAPTURE_LIMITS as L, OaCaptureError } from '../apps/desktop/src/main/oa-read/adapter';
import type { OaCaptureBinding } from '../apps/desktop/src/main/oa-read/types';

const ROOT = 'C:\\work\\analog_ai_workbench';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const binding = (requestId = ID): OaCaptureBinding => ({
  requestId, designId: 'folded', environmentBindingId: 'main-only', libraryMappingIdentity: 'main-only',
  lcv: { library: 'FOLDED_CASCODE', cell: 'FOLDED_CASCODE', view: 'schematic' },
  adapterVersion: 'aaw.oa-saved-read.capture.v1', allowedFiles: ['master.tag', 'sch.oa'],
});
const expectedError = (code: string, hasClosure?: boolean) => (error: unknown): boolean =>
  error instanceof OaCaptureError && error.code === code && (hasClosure === undefined || !!error.closure === hasClosure);
class ProcessStub extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); kills = 0;
  kill() { this.kills++; return true; }
  finish(bytes: Buffer, code = 0, signal: string | null = null) {
    this.stdout.write(bytes); this.stdout.end(); this.stderr.end(); this.emit('close', code, signal);
  }
}
function fixture() {
  const capturePath = path.win32.join(ROOT, 'tools', 'oa-saved-read', 'capture.py');
  const readerPath = path.win32.join(ROOT, 'tools', 'oa-saved-read', 'reader.il');
  const requestRoot = path.win32.join(ROOT, '.local', 'oa-read', 'captures', ID);
  const receiptPath = path.win32.join(requestRoot, 'receipt.json'), factsPath = path.win32.join(requestRoot, 'facts.json');
  const captureBytes = Buffer.from('synthetic capture source'), readerBytes = Buffer.from('synthetic reader source');
  const pins = { captureSha256: digest(captureBytes), readerSha256: digest(readerBytes) };
  const data = new Map<string, Buffer>([[capturePath, captureBytes], [readerPath, readerBytes]]);
  const reads: string[] = [], markers: string[] = [];
  let absent = true, markerReady = true;
  const spawns: { file: string; args: string[]; options: SpawnOptionsWithoutStdio; child: ProcessStub }[] = [];
  const files = {
    read(file: string, maximum: number) {
      reads.push(file); const bytes = data.get(file);
      if (!bytes) throw new Error('synthetic missing file');
      if (bytes.length > maximum) throw new OaCaptureError('SCOPE_LIMIT');
      return Buffer.from(bytes);
    },
    absentCapture(requestId: string) { assert.match(requestId, /^[a-f0-9-]{36}$/u); return absent; },
    requestCancel(requestId: string): 'written' | 'not_ready' {
      markers.push(path.win32.join(ROOT, '.local', 'oa-read', 'captures', requestId, 'run', 'cancel.request'));
      return markerReady ? 'written' : 'not_ready';
    },
  };
  const spawn = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    absent = false; const child = new ProcessStub(); spawns.push({ file, args, options, child });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const wire = encode({ schema: 'aaw.oa-saved-read.snapshot.v1', requestId: ID, facts: {} });
  const receipt = () => ({
    schema: 'aaw.oa-saved-read.receipt.v1', requestId: ID, status: 'completed', errorCode: null,
    startedAt: '2026-09-14T00:00:00.000Z', completedAt: '2026-09-14T00:00:02.000Z',
    published: true, sourceUnchanged: true, copyUnchanged: true,
    reader: { started: true, pid: 4200, pgid: 4200, sessionId: 4200, startTicks: 100000,
      exitCode: 0, groupEnded: true, resourcesClosed: true, closedAt: '2026-09-14T00:00:01.000Z' },
    adapterDigests: { 'reader.il': pins.readerSha256, 'capture.py': pins.captureSha256 },
    factsFileSha256: digest(wire), wireBytes: wire.length,
  });
  const publish = (value: unknown = receipt(), bytes = wire) => {
    data.set(receiptPath, encode(value)); data.set(factsPath, bytes);
  };
  const open = (expectedPins = pins) => createOaReadAdapterForTests({ expectedPins, files, spawn });
  return { pins, data, reads, markers, spawns, files, spawn, wire, receipt, publish, open,
    capturePath, receiptPath, factsPath, notReady: () => { markerReady = false; } };
}

test('OA adapter uses only the fixed login command and admits matching envelope, bytes and Linux closure', async () => {
  const f = fixture(), adapter = f.open();
  const pending = adapter.capture({ requestId: ID, binding: binding(), signal: new AbortController().signal });
  const call = f.spawns[0]!;
  assert.equal(call.file, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(call.args, ['-d', 'ROCKY9_LLM_LAB', '-u', 'maxwell', '--', 'bash', '-lc',
    'exec python3 /mnt/c/work/analog_ai_workbench/tools/oa-saved-read/capture.py --execute --request-id ' + ID]);
  assert.deepEqual(call.options, { cwd: ROOT, windowsHide: true, shell: false,
    env: { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:' } });
  f.publish(); call.child.finish(f.wire);
  const result = await pending;
  assert.equal(result.envelopeJson, f.wire.toString('utf8'));
  assert.deepEqual(result.closure, { requestId: ID, windowsProcessClosed: true, readerStarted: true,
    linuxProcessGroupClosed: true, receiptSha256: digest(encode(f.receipt())) });
  assert.equal(f.markers.length, 0); assert.equal(call.child.kills, 0);
  await assert.rejects(adapter.capture({ requestId: ID, binding: binding(), signal: new AbortController().signal }), expectedError('OA_SNAPSHOT_UNPROVEN', false));
  await adapter.close();
});

test('OA adapter rejects missing or changed source pins, malformed UUID and pre-cancellation before spawning', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const unpinned = createOaReadAdapterForTests({ expectedPins: null, files: f.files, spawn: f.spawn });
  await assert.rejects(unpinned.capture({ requestId: ID, binding: binding(), signal }), expectedError('OA_UNAVAILABLE', false));
  assert.equal(f.reads.length, 0);
  const adapter = f.open();
  for (const invalid of [ID + ';echo bad', '../' + ID, 'A' + ID.slice(1), '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(adapter.capture({ requestId: invalid, binding: binding(invalid), signal }), expectedError('INVALID_REQUEST', false));
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(adapter.capture({ requestId: ID, binding: binding(), signal: abort.signal }), expectedError('CANCELLED', false));
  f.data.set(f.capturePath, Buffer.from('changed source'));
  await assert.rejects(adapter.capture({ requestId: ID, binding: binding(), signal }), expectedError('OA_UNAVAILABLE', false));
  assert.equal(f.spawns.length, 0); assert.equal(f.markers.length, 0);
  await adapter.close(); await unpinned.close();
});

test('OA adapter rejects concurrent captures and discards late success after explicit cancellation', async () => {
  const f = fixture(), adapter = f.open(), abort = new AbortController();
  const pending = adapter.capture({ requestId: ID, binding: binding(), signal: abort.signal });
  await assert.rejects(adapter.capture({ requestId: OTHER, binding: binding(OTHER), signal: new AbortController().signal }), expectedError('BUSY', false));
  abort.abort();
  assert.deepEqual(f.markers, [path.win32.join(ROOT, '.local', 'oa-read', 'captures', ID, 'run', 'cancel.request')]);
  f.publish(); f.spawns[0]!.child.finish(f.wire);
  await assert.rejects(pending, expectedError('CANCELLED', true));
  assert.equal(f.spawns[0]!.child.kills, 0); await adapter.close();
});

test('OA adapter treats missing, foreign, unclosed or unpinned receipts as uncertain Linux cleanup', async () => {
  const base = fixture().receipt();
  for (const receipt of [null, { ...base, requestId: OTHER },
    { ...base, reader: { ...base.reader, groupEnded: false } },
    { ...base, reader: { ...base.reader, resourcesClosed: false } },
    { ...base, reader: { ...base.reader, pgid: 9999 } },
    { ...base, adapterDigests: { ...base.adapterDigests, 'capture.py': '0'.repeat(64) } }]) {
    const f = fixture(), adapter = f.open();
    const pending = adapter.capture({ requestId: ID, binding: binding(), signal: new AbortController().signal });
    if (receipt !== null) f.publish(receipt);
    f.spawns[0]!.child.finish(f.wire);
    await assert.rejects(pending, expectedError('CLEANUP_FAILED', false));
    await assert.rejects(adapter.close(), expectedError('CLEANUP_FAILED'));
  }
});

test('OA adapter never accepts mismatched published bytes or malformed UTF-8 as facts', async () => {
  for (const changedFile of [true, false]) {
    const f = fixture(), adapter = f.open();
    const pending = adapter.capture({ requestId: ID, binding: binding(), signal: new AbortController().signal });
    f.publish();
    if (changedFile) f.data.set(f.factsPath, Buffer.from('{}'));
    f.spawns[0]!.child.finish(changedFile ? f.wire : Buffer.from([0xff]));
    await assert.rejects(pending, expectedError('OA_SNAPSHOT_UNPROVEN', true));
    await adapter.close();
  }
});

test('OA adapter confirms a measured pre-reader failure without claiming a Linux group existed', async () => {
  const f = fixture(), adapter = f.open();
  const pending = adapter.capture({ requestId: ID, binding: binding(), signal: new AbortController().signal });
  const failure = { ...f.receipt(), status: 'failed', errorCode: 'FIXED_RUNTIME_UNAVAILABLE', published: false,
    factsFileSha256: null, wireBytes: null, sourceUnchanged: null, copyUnchanged: null,
    reader: { started: false, pid: null, pgid: null, sessionId: null, startTicks: null, exitCode: null,
      groupEnded: null, resourcesClosed: null, closedAt: null } };
  f.publish(failure);
  f.spawns[0]!.child.finish(encode({ schema: 'aaw.oa-saved-read.failure.v1', requestId: ID, errorCode: failure.errorCode }), 2);
  await assert.rejects(pending, error => error instanceof OaCaptureError && error.code === 'OA_UNAVAILABLE'
    && error.closure?.readerStarted === false && error.closure.linuxProcessGroupClosed === null);
  assert.equal(f.reads.includes(f.factsPath), false); await adapter.close();
});

test('OA adapter caps either stream and preserves cleanup proof while rejecting the result', async () => {
  for (const channel of ['stdout', 'stderr'] as const) {
    const f = fixture(), adapter = f.open();
    const pending = adapter.capture({ requestId: ID, binding: binding(), signal: new AbortController().signal });
    const child = f.spawns[0]!.child;
    child[channel].write(Buffer.alloc((channel === 'stdout' ? L.wireBytes : L.stderrBytes) + 1));
    assert.equal(f.markers.length, 1);
    f.publish(); child.finish(f.wire);
    await assert.rejects(pending, expectedError('SCOPE_LIMIT', true));
    await adapter.close();
  }
});

test('OA adapter watchdog is finite and transport kill never proves Linux cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), adapter = f.open(); f.notReady();
  const pending = adapter.capture({ requestId: ID, binding: binding(), signal: new AbortController().signal });
  const rejected = assert.rejects(pending, expectedError('CLEANUP_FAILED', false));
  t.mock.timers.tick(L.backendMs);
  assert.equal(f.markers.length, 1); assert.equal(f.spawns[0]!.child.kills, 0);
  t.mock.timers.tick(L.closureGraceMs);
  await rejected;
  assert.equal(f.spawns[0]!.child.kills, 1);
  assert.ok(f.markers.length > 1);
  f.publish(); f.spawns[0]!.child.finish(f.wire);
  await assert.rejects(adapter.close(), expectedError('CLEANUP_FAILED'));
});

test('OA adapter close waits for owned cleanup and rejects late successful delivery', async () => {
  const f = fixture(), adapter = f.open();
  const pending = adapter.capture({ requestId: ID, binding: binding(), signal: new AbortController().signal });
  let resolved = false;
  const closing = adapter.close().then(() => { resolved = true; });
  await Promise.resolve(); assert.equal(resolved, false); assert.equal(f.markers.length, 1);
  f.publish(); f.spawns[0]!.child.finish(f.wire);
  await assert.rejects(pending, expectedError('CANCELLED', true)); await closing;
  assert.equal(resolved, true);
});

test('OA adapter does not trust a receipt after the admitted source script changes', async () => {
  const f = fixture(), adapter = f.open();
  const pending = adapter.capture({ requestId: ID, binding: binding(), signal: new AbortController().signal });
  f.publish(); f.data.set(f.capturePath, Buffer.from('changed after launch'));
  f.spawns[0]!.child.finish(f.wire);
  await assert.rejects(pending, expectedError('CLEANUP_FAILED', false));
  await assert.rejects(adapter.close(), expectedError('CLEANUP_FAILED'));
});
