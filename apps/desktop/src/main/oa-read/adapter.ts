import childProcess, { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OA_READ_LIMITS } from '../../shared/agent/oa-read';
import type { OaCaptureBinding } from './types';

const PRODUCT = 'C:\\work\\analog_ai_workbench';
const CAPTURES = path.win32.join(PRODUCT, '.local', 'oa-read', 'captures');
const SCRIPT = path.win32.join(PRODUCT, 'tools', 'oa-saved-read', 'capture.py');
const READER = path.win32.join(PRODUCT, 'tools', 'oa-saved-read', 'reader.il');
const SCRIPT_LINUX = '/mnt/c/work/analog_ai_workbench/tools/oa-saved-read/capture.py';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
export const OA_CAPTURE_LIMITS = Object.freeze({
  wireBytes: OA_READ_LIMITS.wireBytes, stderrBytes: 16384, sourceBytes: 128 * 1024,
  receiptBytes: 128 * 1024, backendMs: 120000, closureGraceMs: 10000, cancelPollMs: 100,
});
export type OaCapturePins = Readonly<{ captureSha256: string; readerSha256: string }>;
export type OaCaptureClosure = Readonly<{
  requestId: string; windowsProcessClosed: true; receiptSha256: string;
}> & (Readonly<{ readerStarted: true; linuxProcessGroupClosed: true }>
  | Readonly<{ readerStarted: false; linuxProcessGroupClosed: null }>);
export type OaCaptureCode = 'INVALID_REQUEST' | 'OA_UNAVAILABLE' | 'OA_SNAPSHOT_UNPROVEN'
  | 'SOURCE_CHANGED' | 'SCOPE_LIMIT' | 'BUSY' | 'CANCELLED' | 'CLEANUP_FAILED';
export class OaCaptureError extends Error {
  constructor(readonly code: OaCaptureCode, readonly closure: OaCaptureClosure | null = null) {
    super(code); this.name = 'OaCaptureError';
  }
}
export type OaReadAdapter = Readonly<{
  capture(args: Readonly<{ requestId: string; binding: OaCaptureBinding; signal: AbortSignal }>):
    Promise<Readonly<{ envelopeJson: string; closure: OaCaptureClosure }>>;
  close(): Promise<void>;
}>;
type Spawn = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
type Files = Readonly<{
  read(file: string, maximum: number): Buffer;
  absentCapture(requestId: string): boolean;
  requestCancel(requestId: string): 'written' | 'not_ready';
}>;
type Host = Readonly<{ pins: OaCapturePins | null; spawn: Spawn; files: Files; platform: string }>;
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function fail(code: OaCaptureCode): never { throw new OaCaptureError(code); }
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('OA_SNAPSHOT_UNPROVEN');
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))) fail('OA_SNAPSHOT_UNPROVEN');
  return record;
}
function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { return fail('OA_SNAPSHOT_UNPROVEN'); }
}
const samePath = (a: string, b: string): boolean => path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
function ordinary(file: string, directory: boolean): fs.BigIntStats {
  const absolute = path.win32.resolve(file);
  if (!samePath(absolute, PRODUCT) && !absolute.toLowerCase().startsWith(PRODUCT.toLowerCase() + '\\')) fail('OA_SNAPSHOT_UNPROVEN');
  const chain: string[] = [];
  for (let part = absolute; path.win32.dirname(part) !== part; part = path.win32.dirname(part)) chain.unshift(part);
  let last!: fs.BigIntStats;
  for (const part of chain) {
    const current = fs.lstatSync(part, { bigint: true });
    if (current.isSymbolicLink() || !samePath(fs.realpathSync.native(part), part)) fail('OA_SNAPSHOT_UNPROVEN');
    if (part !== absolute || directory ? !current.isDirectory() : !current.isFile() || current.nlink !== 1n) fail('OA_SNAPSHOT_UNPROVEN');
    last = current;
  }
  return last;
}
function read(file: string, maximum: number): Buffer {
  const before = ordinary(file, false);
  if (before.size > BigInt(maximum)) fail('SCOPE_LIMIT');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameFile(before, opened) || !opened.isFile() || opened.nlink !== 1n) fail('SOURCE_CHANGED');
    const bytes = Buffer.alloc(Number(opened.size) + 1); let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== Number(opened.size) || !sameFile(opened, fs.fstatSync(fd, { bigint: true }))
      || !sameFile(opened, ordinary(file, false))) fail('SOURCE_CHANGED');
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
const files: Files = {
  read,
  absentCapture(requestId) {
    ordinary(PRODUCT, true);
    let current = PRODUCT;
    for (const part of ['.local', 'oa-read', 'captures', requestId]) {
      current = path.win32.join(current, part);
      try { ordinary(current, true); } catch (error) { if (missing(error)) return true; throw error; }
    }
    return false;
  },
  requestCancel(requestId) {
    const directory = path.win32.join(CAPTURES, requestId, 'run');
    try { ordinary(directory, true); } catch (error) { if (missing(error)) return 'not_ready'; throw error; }
    const file = path.win32.join(directory, 'cancel.request'), content = Buffer.from('cancel\n');
    let fd: number;
    try { fd = fs.openSync(file, 'wx'); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST' && read(file, content.length).equals(content)) return 'written';
      throw error;
    }
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n) fail('OA_SNAPSHOT_UNPROVEN');
      fs.writeFileSync(fd, content); fs.fsyncSync(fd);
      if (!sameFile(fs.fstatSync(fd, { bigint: true }), ordinary(file, false))) fail('SOURCE_CHANGED');
    } finally { fs.closeSync(fd); }
    return 'written';
  },
};
function checkPins(host: Host): OaCapturePins {
  const pins = host.pins;
  if (host.platform !== 'win32' || !pins || !isHash(pins.captureSha256) || !isHash(pins.readerSha256)) fail('OA_UNAVAILABLE');
  if (hash(host.files.read(SCRIPT, OA_CAPTURE_LIMITS.sourceBytes)) !== pins.captureSha256
    || hash(host.files.read(READER, OA_CAPTURE_LIMITS.sourceBytes)) !== pins.readerSha256) fail('OA_UNAVAILABLE');
  return pins;
}
type Receipt = Readonly<{
  closure: OaCaptureClosure; status: 'completed' | 'failed' | 'cancelled';
  errorCode: string | null; factsFileSha256: string | null; wireBytes: number | null;
}>;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function readReceipt(host: Host, requestId: string, pins: OaCapturePins): Receipt {
  const bytes = host.files.read(path.win32.join(CAPTURES, requestId, 'receipt.json'), OA_CAPTURE_LIMITS.receiptBytes);
  const receipt = object(json(bytes));
  const reader = exact(receipt.reader, ['started', 'pid', 'pgid', 'sessionId', 'startTicks', 'exitCode', 'groupEnded', 'resourcesClosed', 'closedAt']);
  const digests = exact(receipt.adapterDigests, ['reader.il', 'capture.py']);
  if (receipt.schema !== 'aaw.oa-saved-read.receipt.v1' || receipt.requestId !== requestId
    || !['completed', 'failed', 'cancelled'].includes(String(receipt.status))
    || !timestamp(receipt.startedAt) || !timestamp(receipt.completedAt) || receipt.completedAt < receipt.startedAt
    || digests['capture.py'] !== pins.captureSha256 || digests['reader.il'] !== pins.readerSha256
    || typeof receipt.published !== 'boolean'
    || ![true, false, null].includes(receipt.sourceUnchanged as boolean | null)
    || ![true, false, null].includes(receipt.copyUnchanged as boolean | null)) fail('CLEANUP_FAILED');
  const common = { requestId, windowsProcessClosed: true as const, receiptSha256: hash(bytes) };
  let closure: OaCaptureClosure;
  if (reader.started === false) {
    if (!['pid', 'pgid', 'sessionId', 'startTicks', 'exitCode', 'groupEnded', 'resourcesClosed', 'closedAt'].every(key => reader[key] === null)) fail('CLEANUP_FAILED');
    closure = { ...common, readerStarted: false, linuxProcessGroupClosed: null };
  } else {
    if (reader.started !== true || !positive(reader.pid) || reader.pid === 1 || reader.pgid !== reader.pid
      || reader.sessionId !== reader.pid || !positive(reader.startTicks)
      || !Number.isSafeInteger(reader.exitCode) || Number(reader.exitCode) < -128 || Number(reader.exitCode) > 255
      || reader.groupEnded !== true || reader.resourcesClosed !== true || !timestamp(reader.closedAt)
      || reader.closedAt < receipt.startedAt || reader.closedAt > receipt.completedAt) fail('CLEANUP_FAILED');
    closure = { ...common, readerStarted: true, linuxProcessGroupClosed: true };
  }
  if (receipt.status === 'completed') {
    if (!closure.readerStarted || reader.exitCode !== 0 || receipt.errorCode !== null
      || receipt.published !== true || receipt.sourceUnchanged !== true || receipt.copyUnchanged !== true
      || !isHash(receipt.factsFileSha256) || !positive(receipt.wireBytes)
      || receipt.wireBytes > OA_CAPTURE_LIMITS.wireBytes) fail('OA_SNAPSHOT_UNPROVEN');
  } else if (typeof receipt.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(receipt.errorCode)
    || receipt.published !== false || receipt.factsFileSha256 !== null || receipt.wireBytes !== null) fail('OA_SNAPSHOT_UNPROVEN');
  return { closure, status: receipt.status as Receipt['status'], errorCode: receipt.errorCode as string | null,
    factsFileSha256: receipt.factsFileSha256 as string | null, wireBytes: receipt.wireBytes as number | null };
}
function backendCode(code: string | null): OaCaptureCode {
  if (code === 'SOURCE_CHANGED') return 'SOURCE_CHANGED';
  if (code === 'CANCELLED') return 'CANCELLED';
  if (code === 'SCOPE_LIMIT' || code === 'RESULT_LIMIT' || code === 'LOG_LIMIT') return 'SCOPE_LIMIT';
  if (code === 'OA_UNAVAILABLE' || code === 'READER_FAILED' || code === 'READER_TIMEOUT'
    || code === 'FIXED_RUNTIME_UNAVAILABLE' || code === 'ENVIRONMENT_REJECTED') return 'OA_UNAVAILABLE';
  return 'OA_SNAPSHOT_UNPROVEN';
}
function makeAdapter(host: Host): OaReadAdapter {
  let closed = false, busy = false, cleanupFailed = false;
  let stopActive: (() => void) | null = null, active: Promise<void> | null = null;
  return {
    async capture({ requestId, binding, signal }) {
      if (typeof requestId !== 'string' || !UUID.test(requestId) || binding?.requestId !== requestId
        || !(signal instanceof AbortSignal)) fail('INVALID_REQUEST');
      if (cleanupFailed) fail('CLEANUP_FAILED');
      if (closed || signal.aborted) fail('CANCELLED');
      if (busy) fail('BUSY');
      let pins: OaCapturePins;
      try {
        pins = checkPins(host);
        if (!host.files.absentCapture(requestId)) fail('OA_SNAPSHOT_UNPROVEN');
      } catch (error) {
        throw error instanceof OaCaptureError ? error : new OaCaptureError('OA_UNAVAILABLE');
      }
      busy = true;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = host.spawn('C:\\Windows\\System32\\wsl.exe',
          ['-d', 'ROCKY9_LLM_LAB', '-u', 'maxwell', '--', 'bash', '-lc',
            'exec python3 ' + SCRIPT_LINUX + ' --execute --request-id ' + requestId],
          { cwd: PRODUCT, windowsHide: true, shell: false,
            env: { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:' } });
      } catch { busy = false; throw new OaCaptureError('OA_UNAVAILABLE'); }
      const pending = new Promise<Readonly<{ envelopeJson: string; closure: OaCaptureClosure }>>((resolve, reject) => {
        let settled = false, reason: OaCaptureCode | null = null, transportError = false;
        let stdoutBytes = 0, stderrBytes = 0;
        const chunks: Buffer[] = [];
        let grace: ReturnType<typeof setTimeout> | null = null;
        let poll: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          settled = true; clearTimeout(watchdog);
          if (grace) clearTimeout(grace);
          if (poll) clearTimeout(poll);
          signal.removeEventListener('abort', onAbort);
          stopActive = null;
        };
        const rejectOnce = (error: OaCaptureError) => {
          if (settled) return;
          if (error.code === 'CLEANUP_FAILED') cleanupFailed = true;
          cleanup(); reject(error);
        };
        const marker = () => {
          if (settled) return;
          try {
            if (host.files.requestCancel(requestId) === 'written') return;
          } catch { /* A failed marker cannot establish process termination. */ }
          poll = setTimeout(marker, OA_CAPTURE_LIMITS.cancelPollMs);
        };
        const stop = (code: OaCaptureCode) => {
          if (settled || reason) return;
          reason = code; chunks.length = 0; marker();
          grace = setTimeout(() => {
            // Closing this transport cannot prove that its Linux children ended.
            try { child.kill(); } catch { /* Retain the unconfirmed Linux state. */ }
            rejectOnce(new OaCaptureError('CLEANUP_FAILED'));
          }, OA_CAPTURE_LIMITS.closureGraceMs);
        };
        const onAbort = () => stop('CANCELLED');
        const watchdog = setTimeout(() => stop('OA_UNAVAILABLE'), OA_CAPTURE_LIMITS.backendMs);
        stopActive = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', (chunk: Buffer) => {
          if (settled || reason) return;
          const bytes = Buffer.from(chunk); stdoutBytes += bytes.length;
          if (stdoutBytes > OA_CAPTURE_LIMITS.wireBytes) { stop('SCOPE_LIMIT'); return; }
          chunks.push(bytes);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          if (settled) return;
          stderrBytes += chunk.length;
          if (stderrBytes > OA_CAPTURE_LIMITS.stderrBytes) stop('SCOPE_LIMIT');
        });
        child.on('error', () => { transportError = true; stop('OA_UNAVAILABLE'); });
        child.stdin.on('error', () => { transportError = true; stop('OA_UNAVAILABLE'); });
        child.once('close', (exitCode: number | null, exitSignal: string | null) => {
          if (settled) return;
          let closure: OaCaptureClosure | null = null;
          try {
            checkPins(host);
            const receipt = readReceipt(host, requestId, pins);
            closure = receipt.closure;
            if (reason || signal.aborted || closed) throw new OaCaptureError(reason ?? 'CANCELLED', closure);
            if (transportError || exitSignal !== null) throw new OaCaptureError('OA_UNAVAILABLE', closure);
            const wire = Buffer.concat(chunks, stdoutBytes), value = object(json(wire));
            if (receipt.status !== 'completed') {
              exact(value, ['schema', 'requestId', 'errorCode']);
              if (exitCode === null || exitCode === 0 || value.schema !== 'aaw.oa-saved-read.failure.v1'
                || value.requestId !== requestId || value.errorCode !== receipt.errorCode) fail('OA_SNAPSHOT_UNPROVEN');
              throw new OaCaptureError(backendCode(receipt.errorCode), closure);
            }
            if (exitCode !== 0 || value.schema !== 'aaw.oa-saved-read.snapshot.v1' || value.requestId !== requestId
              || receipt.wireBytes !== wire.length || receipt.factsFileSha256 !== hash(wire)
              || !host.files.read(path.win32.join(CAPTURES, requestId, 'facts.json'), OA_CAPTURE_LIMITS.wireBytes).equals(wire)) fail('OA_SNAPSHOT_UNPROVEN');
            // Main's independent admission validates LCV, manifests, facts and all relationships.
            const envelopeJson = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(wire);
            cleanup(); resolve({ envelopeJson, closure });
          } catch (error) {
            if (!closure) { rejectOnce(new OaCaptureError('CLEANUP_FAILED')); return; }
            rejectOnce(new OaCaptureError(error instanceof OaCaptureError ? error.code : 'OA_SNAPSHOT_UNPROVEN', closure));
          }
        });
        try { child.stdin.end(); } catch { transportError = true; stop('OA_UNAVAILABLE'); }
        if (signal.aborted) onAbort();
      });
      active = pending.then(() => {}, () => {});
      try { return await pending; }
      finally { busy = false; active = null; }
    },
    async close() {
      closed = true; stopActive?.();
      await active;
      if (cleanupFailed) fail('CLEANUP_FAILED');
    },
  };
}

/** Main-only construction. Missing release pins never admit a source script. */
export function createOaReadAdapter(options: Readonly<{ expectedPins: OaCapturePins | null }> = { expectedPins: null }): OaReadAdapter {
  return makeAdapter({ pins: options.expectedPins ? Object.freeze({ ...options.expectedPins }) : null,
    files, spawn: childProcess.spawn, platform: process.platform });
}
/** Pure substitute seam; this export is never reachable from IPC or the renderer. */
export function createOaReadAdapterForTests(options: Readonly<{
  expectedPins: OaCapturePins | null; files: Files; spawn: Spawn;
}>): OaReadAdapter {
  return makeAdapter({ pins: options.expectedPins ? Object.freeze({ ...options.expectedPins }) : null,
    files: options.files, spawn: options.spawn, platform: 'win32' });
}
