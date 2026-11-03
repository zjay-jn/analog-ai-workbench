import childProcess, { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {runtimePaths} from '../runtime-paths';
import {runtimeComponent} from '../runtime-manifest';
import {nativeWindowsEnvironment} from '../native-environment';
import { WORK_CYCLE_LIMITS as L, isWorkCycleRelativePath } from '../../shared/agent/agent-work-cycle';
import { PROJECT_READ_LIMITS as P } from '../../shared/agent/agent-project-read';
import { fileNameAllowed } from '../../shared/agent/file-context';
import { folderPartAllowed } from '../cloud/project-folder-files';
import { WorkCycleError, type WorkCycleRunner, type WorkCycleRunnerResult, type WorkCycleSnapshot } from './types';

const product = () => runtimePaths().storageRoot;
const runnerRoot = () => path.join(runtimePaths().dataRoot, 'agent-work-cycle-runner');
const hashPattern = /^[0-9a-f]{64}$/u;
const executionPattern = /^wce-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_RECEIPTS = P.runs * L.executions;
const WIRE_BYTES = 16384;
/** Pins remain unavailable until root admits both the native binary and actual isolation proof. */
export const WORK_CYCLE_RUNNER_IDENTITY = Object.freeze({
  version: 'aaw.c1.windows-runner.v1',
  get runtime() {return path.join(runtimePaths().runtimeRoot, 'node', 'node.exe');},
  runtimeBytes: 93381448, runtimeSha256: '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',
  licenseSha256: 'ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9',
  get native() {return path.join(runtimePaths().nativeRoot, 'work-runner.exe');}, nativeSha256: null as string | null,
  get proof() {return path.join(runtimePaths().runtimeRoot, 'work-proof.json');}, proofSha256: null as string | null,
});
function installedIdentity(): Identity {
  try {
    const runtime=runtimeComponent('node'),license=runtimeComponent('nodeLicense'),native=runtimeComponent('workRunner'),proof=runtimeComponent('workProof');
    return Object.freeze({version:WORK_CYCLE_RUNNER_IDENTITY.version,runtime:runtime.path,runtimeBytes:runtime.bytes,runtimeSha256:runtime.sha256,
      licenseSha256:license.sha256,native:native.path,nativeSha256:native.sha256,proof:proof.path,proofSha256:proof.sha256});
  } catch {return {...WORK_CYCLE_RUNNER_IDENTITY};}
}
type Identity = Readonly<{ version: string; runtime: string; runtimeBytes: number; runtimeSha256: string; licenseSha256: string; native: string; nativeSha256: string | null; proof: string; proofSha256: string | null }>;
type NativeSpawn = (program: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
type Removal = Readonly<{ unlink(filename: string): void; rmdir(directory: string): void; exists(filename: string): boolean; entries(directory: string): string[] }>;
type Host = Readonly<{ identity: Identity; executions: string; spawn: NativeSpawn; removal: Removal; beforePrepare?: () => Promise<void>; beforeResult?: () => Promise<void> }>;
type Stamp = Readonly<{ dev: string; ino: string }>;
type Intent = { schema: 'aaw.c1.execution-intent.v1'; executionId: string; signature: string; nonce: string; snapshot: WorkCycleSnapshot; nativeSha256: string; runtimeSha256: string; createdAt: string };
const digest = (value: Uint8Array | string): string => crypto.createHash('sha256').update(value).digest('hex');
function fail(code: ConstructorParameters<typeof WorkCycleError>[0]): never { throw new WorkCycleError(code); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail('ENGINE_FAILED');
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !d.enumerable || !('value' in d)) fail('ENGINE_FAILED'); }
  return value as Record<string, unknown>;
}
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical((value as Record<string, unknown>)[key]))])) : value);
const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const stamp = (s: fs.BigIntStats): Stamp => ({ dev: String(s.dev), ino: String(s.ino) });
const sameStamp = (a: Stamp, b: Stamp): boolean => a.dev === b.dev && a.ino === b.ino;
const stable = (a: fs.BigIntStats, b: fs.BigIntStats): boolean => sameStamp(stamp(a), stamp(b)) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function ordinary(filename: string, directory: boolean): fs.BigIntStats {
  const absolute = path.resolve(filename);
  if (![product(),runtimePaths().installationRoot].some(root=>absolute.toLowerCase().startsWith(root.toLowerCase()+path.sep))) fail('UNSUPPORTED_PATH');
  const chain: string[] = []; let cursor = absolute;
  while (path.dirname(cursor) !== cursor) { chain.unshift(cursor); cursor = path.dirname(cursor); }
  let final: fs.BigIntStats | undefined;
  for (const item of chain) {
    const value = fs.lstatSync(item, { bigint: true });
    if (value.isSymbolicLink() || !samePath(fs.realpathSync.native(item), item)) fail('UNSUPPORTED_PATH');
    if (item !== absolute || directory ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n) fail('UNSUPPORTED_PATH');
    final = value;
  }
  return final!;
}
function readBytes(filename: string, maximum: number): Buffer {
  const before = ordinary(filename, false); if (before.size > BigInt(maximum)) fail('FILE_LIMIT');
  const fd = fs.openSync(filename, 'r'); try {
    const opened = fs.fstatSync(fd, { bigint: true }); if (!stable(before, opened) || !opened.isFile() || opened.nlink !== 1n) fail('SOURCE_CHANGED');
    const result = Buffer.alloc(Number(opened.size) + 1); let offset = 0;
    while (offset < result.length) { const n = fs.readSync(fd, result, offset, result.length - offset, offset); if (!n) break; offset += n; }
    if (offset !== Number(opened.size) || !stable(opened, fs.fstatSync(fd, { bigint: true })) || !stable(opened, ordinary(filename, false))) fail('SOURCE_CHANGED');
    return result.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
function readJson(filename: string): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBytes(filename, 65536))); }
function makeDirectory(filename: string): void { if (!fs.existsSync(filename)) { makeDirectory(path.dirname(filename)); fs.mkdirSync(filename); } ordinary(filename, true); }
function newFile(filename: string, value: Uint8Array | string): void {
  ordinary(path.dirname(filename), true); const data = Buffer.from(value), fd = fs.openSync(filename, 'wx');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!readBytes(filename, data.length).equals(data)) fail('STORAGE_FAILED');
}
function workPath(value: unknown): value is string {
  return isWorkCycleRelativePath(value) && value.split('/').every(part => !part.startsWith('.') && folderPartAllowed(part)) && fileNameAllowed(value.split('/').at(-1)!);
}
function opaque(value: unknown): value is string { return typeof value === 'string' && Buffer.byteLength(value) <= P.idBytes && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value); }
const resultKeys = ['executionId', 'language', 'isolation', 'termination', 'exitCode', 'signal', 'durationMs', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated', 'cleanupConfirmed'] as const;
function validResult(value: unknown, executionId: string): value is WorkCycleRunnerResult {
  try {
    const r = exact(value, resultKeys);
    return r.executionId === executionId && r.language === 'javascript' && r.isolation === 'windows-appcontainer'
      && ['exited', 'timed_out', 'cancelled', 'limit', 'isolation_failed'].includes(String(r.termination))
      && (r.exitCode === null || Number.isSafeInteger(r.exitCode) && !Object.is(r.exitCode, -0) && Number(r.exitCode) >= 0 && Number(r.exitCode) <= 0xffffffff)
      && (r.termination !== 'exited' || r.exitCode !== null) && r.signal === null
      && Number.isSafeInteger(r.durationMs) && !Object.is(r.durationMs, -0) && Number(r.durationMs) >= 0 && Number(r.durationMs) <= L.nativeCallMs
      && typeof r.stdout === 'string' && Buffer.byteLength(r.stdout) <= L.logBytes && !/\p{Surrogate}/u.test(r.stdout)
      && typeof r.stderr === 'string' && Buffer.byteLength(r.stderr) <= L.logBytes && !/\p{Surrogate}/u.test(r.stderr)
      && typeof r.stdoutTruncated === 'boolean' && typeof r.stderrTruncated === 'boolean' && typeof r.cleanupConfirmed === 'boolean';
  } catch { return false; }
}
function logText(hex: unknown, truncated: boolean): string {
  if (typeof hex !== 'string' || hex.length > L.logBytes * 2 || !/^(?:[0-9a-f]{2})*$/u.test(hex)) fail('ENGINE_FAILED');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(hex, 'hex'), { stream: truncated }); } catch { return fail('ENGINE_FAILED'); }
}
/** Pure decoder of the frozen 18-key native report. It does not prove real isolation. */
export function parseWorkCycleNativeReport(value: unknown, executionId: string, signature: string): WorkCycleRunnerResult {
  const r = exact(value, ['version', 'executionId', 'signature', 'termination', 'exitCode', 'durationMs', 'stdoutHex', 'stderrHex', 'stdoutTruncated', 'stderrTruncated', 'cleanupConfirmed', 'appContainer', 'capabilityCount', 'atomicJob', 'lowIntegrity', 'profileDeleted', 'aclRestored', 'activeProcesses']);
  if (r.version !== 1 || r.executionId !== executionId || r.signature !== signature || !hashPattern.test(signature)) fail('ENGINE_FAILED');
  for (const key of ['stdoutTruncated', 'stderrTruncated', 'cleanupConfirmed', 'appContainer', 'atomicJob', 'lowIntegrity', 'profileDeleted', 'aclRestored']) if (typeof r[key] !== 'boolean') fail('ENGINE_FAILED');
  if (!Number.isSafeInteger(r.capabilityCount) || Number(r.capabilityCount) < 0 || Number(r.capabilityCount) > 1024 || !Number.isSafeInteger(r.activeProcesses) || Number(r.activeProcesses) < 0 || Number(r.activeProcesses) > 1024) fail('ENGINE_FAILED');
  const result: WorkCycleRunnerResult = { executionId, language: 'javascript', isolation: 'windows-appcontainer',
    termination: r.termination as WorkCycleRunnerResult['termination'], exitCode: r.exitCode as number | null, signal: null, durationMs: r.durationMs as number,
    stdout: logText(r.stdoutHex, r.stdoutTruncated as boolean), stderr: logText(r.stderrHex, r.stderrTruncated as boolean),
    stdoutTruncated: r.stdoutTruncated as boolean, stderrTruncated: r.stderrTruncated as boolean,
    cleanupConfirmed: r.cleanupConfirmed === true && r.aclRestored === true && r.profileDeleted === true && r.activeProcesses === 0 };
  if (!validResult(result, executionId)) fail('ENGINE_FAILED');
  if (r.appContainer !== true || r.capabilityCount !== 0 || r.atomicJob !== true || r.lowIntegrity !== true) return { ...result, termination: 'isolation_failed' };
  return result;
}
function snapshotIdentity(snapshot: WorkCycleSnapshot): string {
  exact(snapshot, ['executionId', 'inputDirectory', 'outputDirectory', 'scriptRelativePath', 'script', 'inputs']);
  exact(snapshot.script, ['fileId', 'version']);
  if (!executionPattern.test(snapshot.executionId) || !workPath(snapshot.scriptRelativePath) || !snapshot.scriptRelativePath.endsWith('.js') || !opaque(snapshot.script.fileId) || !hashPattern.test(snapshot.script.version) || !Array.isArray(snapshot.inputs) || snapshot.inputs.length < 1 || snapshot.inputs.length > L.files) fail('INVALID_REQUEST');
  if (typeof snapshot.inputDirectory !== 'string' || typeof snapshot.outputDirectory !== 'string') fail('INVALID_REQUEST');
  const input = path.resolve(snapshot.inputDirectory), output = path.resolve(snapshot.outputDirectory);
  if (input !== snapshot.inputDirectory || output !== snapshot.outputDirectory || !input.toLowerCase().startsWith(path.join(product(), '.local').toLowerCase() + path.sep) || path.basename(input) !== 'input' || path.basename(output) !== 'output' || !samePath(path.dirname(input), path.dirname(output)) || path.basename(path.dirname(input)) !== snapshot.executionId) fail('UNSUPPORTED_PATH');
  ordinary(input, true); ordinary(output, true); const names = new Set<string>(), ids = new Set<string>(); let total = 0;
  for (const item of snapshot.inputs) {
    exact(item, ['fileId', 'relativePath', 'version', 'bytes']);
    if (!workPath(item.relativePath) || !opaque(item.fileId) || !hashPattern.test(item.version) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > L.fileBytes || names.has(item.relativePath.toLowerCase()) || ids.has(item.fileId)) fail('INVALID_REQUEST');
    names.add(item.relativePath.toLowerCase()); ids.add(item.fileId); total += item.bytes;
    const content = readBytes(path.join(input, ...item.relativePath.split('/')), L.fileBytes); if (content.length !== item.bytes || digest(content) !== item.version) fail('SOURCE_CHANGED');
  }
  if (total > L.workspaceBytes || !snapshot.inputs.some(item => item.fileId === snapshot.script.fileId && item.version === snapshot.script.version && item.relativePath === snapshot.scriptRelativePath)) fail('INVALID_REQUEST');
  let visited = 0; const declared = new Set(snapshot.inputs.map(item => item.relativePath));
  const inspect = (directory: string, prefix: string): void => {
    const before = ordinary(directory, true), children = fs.readdirSync(directory, { withFileTypes: true }); visited += children.length; if (visited > L.files * L.pathDepth) fail('BUDGET_EXCEEDED');
    for (const child of children) { const relative = prefix ? prefix + '/' + child.name : child.name, target = path.join(directory, child.name); if (child.isSymbolicLink()) fail('UNSUPPORTED_PATH'); if (child.isDirectory()) inspect(target, relative); else { ordinary(target, false); if (!declared.delete(relative)) fail('CONFLICT'); } }
    if (!stable(before, ordinary(directory, true))) fail('SOURCE_CHANGED');
  }; inspect(input, ''); if (declared.size) fail('SOURCE_CHANGED');
  return digest(canonical(snapshot));
}
function pinned(identity: Identity): boolean {
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64' || !identity.nativeSha256 || !identity.proofSha256) return false;
    const runtime = readBytes(identity.runtime, identity.runtimeBytes);
    if (runtime.length !== identity.runtimeBytes || digest(runtime) !== identity.runtimeSha256 || digest(readBytes(path.join(path.dirname(identity.runtime), 'LICENSE'), 1024 * 1024)) !== identity.licenseSha256 || digest(readBytes(identity.native, 4 * 1024 * 1024)) !== identity.nativeSha256 || digest(readBytes(identity.proof, 65536)) !== identity.proofSha256) return false;
    const proof = readJson(identity.proof) as Record<string, unknown>;
    return proof.status === 'PASS' && proof.nativeSha256 === identity.nativeSha256 && proof.runtimeSha256 === identity.runtimeSha256 && proof.appContainer === true && proof.capabilityCount === 0 && proof.atomicJob === true && proof.cleanupConfirmed === true && proof.aclRestored === true && proof.profileDeleted === true;
  } catch { return false; }
}
function readIntent(execution: string, executionId: string): Intent {
  const r = exact(readJson(path.join(execution, 'intent.json')), ['schema', 'executionId', 'signature', 'nonce', 'snapshot', 'nativeSha256', 'runtimeSha256', 'createdAt']);
  if (r.schema !== 'aaw.c1.execution-intent.v1' || r.executionId !== executionId || typeof r.signature !== 'string' || !hashPattern.test(r.signature) || typeof r.nonce !== 'string' || !/^[0-9a-f]{32}$/u.test(r.nonce) || typeof r.nativeSha256 !== 'string' || !hashPattern.test(r.nativeSha256) || typeof r.runtimeSha256 !== 'string' || !hashPattern.test(r.runtimeSha256) || typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt)) || digest(canonical(r.snapshot)) !== r.signature) fail('STORAGE_FAILED');
  return r as Intent;
}
function readReceipt(execution: string, intent: Intent, removal: Removal): WorkCycleRunnerResult {
  const r = exact(readJson(path.join(execution, 'result.json')), ['schema', 'executionId', 'signature', 'nonce', 'result', 'nativeReportSha256', 'runtimeDisposed', 'completedAt']);
  if (r.schema !== 'aaw.c1.execution-result.v1' || r.executionId !== intent.executionId || r.signature !== intent.signature || r.nonce !== intent.nonce || !validResult(r.result, intent.executionId) || typeof r.runtimeDisposed !== 'boolean' || typeof r.completedAt !== 'string' || !Number.isFinite(Date.parse(r.completedAt))) fail('STORAGE_FAILED');
  if (r.nativeReportSha256 !== null && (typeof r.nativeReportSha256 !== 'string' || !hashPattern.test(r.nativeReportSha256) || digest(readBytes(path.join(execution, 'native-report.json'), WIRE_BYTES)) !== r.nativeReportSha256)) fail('STORAGE_FAILED');
  if (r.result.cleanupConfirmed && (!r.runtimeDisposed || removal.exists(path.join(execution, 'runtime')))) fail('STORAGE_FAILED');
  return structuredClone(r.result);
}
function retained(host: Host): Readonly<{ pending: boolean; full: boolean }> {
  if (!fs.existsSync(host.executions)) return { pending: false, full: false };
  ordinary(host.executions, true); const entries = fs.readdirSync(host.executions, { withFileTypes: true });
  if (entries.length > MAX_RECEIPTS) return { pending: true, full: true };
  return { full: entries.length >= MAX_RECEIPTS, pending: entries.some(item => {
    if (!item.isDirectory() || item.isSymbolicLink() || !executionPattern.test(item.name)) return true;
    try { const execution = path.join(host.executions, item.name), intent = readIntent(execution, item.name); return !readReceipt(execution, intent, host.removal).cleanupConfirmed; } catch { return true; }
  }) };
}
const failed = (executionId: string, termination: WorkCycleRunnerResult['termination'], cleanupConfirmed: boolean, started: number): WorkCycleRunnerResult => ({ executionId, language: 'javascript', isolation: 'windows-appcontainer', termination, exitCode: null, signal: null, durationMs: Math.min(L.nativeCallMs, Math.max(0, Date.now() - started)), stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, cleanupConfirmed });
const yieldTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
type Active = { executionId: string; signature: string; abort: AbortController; promise: Promise<WorkCycleRunnerResult> };

function createRunner(host: Host): WorkCycleRunner {
  let closed = false, active: Active | null = null, closing: Promise<void> | undefined, cleanupFailed = false;
  return Object.freeze({
    available() { try { if (closed || active || !pinned(host.identity)) return { available: false, language: 'javascript' as const, isolation: 'windows-appcontainer' as const }; const state = retained(host); return { available: !state.pending && !state.full, language: 'javascript' as const, isolation: 'windows-appcontainer' as const }; } catch { return { available: false, language: 'javascript' as const, isolation: 'windows-appcontainer' as const }; } },
    async run(snapshot: WorkCycleSnapshot, signal: AbortSignal) {
      if (closed) fail('CANCELLED'); if (signal.aborted) return failed(snapshot.executionId, 'cancelled', true, Date.now());
      const signature = snapshotIdentity(snapshot), execution = path.join(host.executions, snapshot.executionId);
      if (active) { if (active.executionId !== snapshot.executionId || active.signature !== signature) fail('BUSY'); return active.promise; }
      if (fs.existsSync(execution)) { const intent = readIntent(execution, snapshot.executionId); if (intent.signature !== signature) fail('CONFLICT'); if (!fs.existsSync(path.join(execution, 'result.json'))) fail('CLEANUP_FAILED'); return readReceipt(execution, intent, host.removal); }
      const existing = retained(host); if (existing.full) fail('BUDGET_EXCEEDED'); if (existing.pending) fail('CLEANUP_FAILED'); if (!pinned(host.identity)) fail('ENGINE_FAILED');
      const abort = new AbortController(), cancel = () => abort.abort(), started = Date.now(); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
      const promise = Promise.resolve().then(async (): Promise<WorkCycleRunnerResult> => {
        makeDirectory(host.executions); fs.mkdirSync(execution); const executionStamp = stamp(ordinary(execution, true));
        const nonce = crypto.randomBytes(16).toString('hex'), intent: Intent = { schema: 'aaw.c1.execution-intent.v1', executionId: snapshot.executionId, signature, nonce, snapshot: structuredClone(snapshot), nativeSha256: host.identity.nativeSha256!, runtimeSha256: host.identity.runtimeSha256, createdAt: new Date().toISOString() };
        newFile(path.join(execution, 'intent.json'), JSON.stringify(intent));
        const intentBytes = readBytes(path.join(execution, 'intent.json'), 65536), runtime = path.join(execution, 'runtime');
        let runtimeStamp: Stamp | undefined, processMayHaveStarted = false, cleanupProved = false, reportHash: string | null = null;
        const copies = new Map<string, { stamp: Stamp; sha256: string; bytes: number }>();
        function captureCopy(name: string, expectedHash: string, maximum: number): void {
          const target = path.join(runtime, name), data = readBytes(target, maximum); if (digest(data) !== expectedHash) fail('SOURCE_CHANGED');
          copies.set(name, { stamp: stamp(ordinary(target, false)), sha256: expectedHash, bytes: data.length });
        }
        function disposeCopies(): boolean {
          try {
            if (!cleanupProved || !sameStamp(executionStamp, stamp(ordinary(execution, true))) || !readBytes(path.join(execution, 'intent.json'), 65536).equals(intentBytes)) return false;
            if (!runtimeStamp) return !host.removal.exists(runtime);
            if (!sameStamp(runtimeStamp, stamp(ordinary(runtime, true)))) return false;
            const names = host.removal.entries(runtime); if (names.length !== copies.size || names.some(name => !copies.has(name))) return false;
            for (const [name, proof] of copies) { const target = path.join(runtime, name); if (!['node.exe', 'LICENSE', 'program.cjs'].includes(name) || !sameStamp(proof.stamp, stamp(ordinary(target, false))) || digest(readBytes(target, proof.bytes)) !== proof.sha256) return false; }
            for (const [name, proof] of copies) { const target = path.join(runtime, name); if (!sameStamp(proof.stamp, stamp(ordinary(target, false))) || digest(readBytes(target, proof.bytes)) !== proof.sha256) return false; host.removal.unlink(target); if (host.removal.exists(target)) return false; }
            if (host.removal.entries(runtime).length !== 0) return false; host.removal.rmdir(runtime); return !host.removal.exists(runtime);
          } catch { return false; }
        }
        let result: WorkCycleRunnerResult;
        try {
          await (host.beforePrepare?.() ?? yieldTurn());
          if (abort.signal.aborted || closed) { cleanupProved = true; result = failed(snapshot.executionId, 'cancelled', true, started); }
          else {
            makeDirectory(runtime); runtimeStamp = stamp(ordinary(runtime, true));
            fs.copyFileSync(host.identity.runtime, path.join(runtime, 'node.exe'), fs.constants.COPYFILE_EXCL); captureCopy('node.exe', host.identity.runtimeSha256, host.identity.runtimeBytes);
            fs.copyFileSync(path.join(path.dirname(host.identity.runtime), 'LICENSE'), path.join(runtime, 'LICENSE'), fs.constants.COPYFILE_EXCL); captureCopy('LICENSE', host.identity.licenseSha256, 1024 * 1024);
            const program = readBytes(path.join(snapshot.inputDirectory, ...snapshot.scriptRelativePath.split('/')), L.fileBytes); if (digest(program) !== snapshot.script.version) fail('SOURCE_CHANGED');
            newFile(path.join(runtime, 'program.cjs'), program); captureCopy('program.cjs', snapshot.script.version, L.fileBytes);
            await yieldTurn(); if (snapshotIdentity(snapshot) !== signature || fs.readdirSync(snapshot.outputDirectory).length !== 0) fail('CONFLICT');
            if (abort.signal.aborted || closed) { cleanupProved = true; result = failed(snapshot.executionId, 'cancelled', true, started); }
            else {
              if (!pinned(host.identity)) fail('ENGINE_FAILED');
              const args = [execution, runtime, snapshot.inputDirectory, snapshot.outputDirectory, snapshot.executionId, signature, nonce, snapshot.scriptRelativePath, snapshot.script.version, ...snapshot.inputs.map(item => item.version + ':' + item.bytes + ':' + item.relativePath)];
              if (args.join(' ').length > 24000) fail('BUDGET_EXCEEDED');
              const child = host.spawn(host.identity.native, args, { cwd: execution, shell: false, windowsHide: true, env: nativeWindowsEnvironment() }); processMayHaveStarted = child.pid !== undefined;
              const received = await new Promise<{ code: number | null; stdout: Buffer; cleanClose: boolean; malformed: boolean; timedOut: boolean }>(resolve => {
                const chunks: Buffer[] = []; let length = 0, errors = 0, malformed = false, timedOut = false, settled = false, killTimer: ReturnType<typeof setTimeout> | undefined;
                const finish = (code: number | null, cleanClose: boolean) => { if (settled) return; settled = true; clearTimeout(watchdog); if (killTimer) clearTimeout(killTimer); abort.signal.removeEventListener('abort', stop); resolve({ code, stdout: Buffer.concat(chunks), cleanClose, malformed, timedOut }); };
                const stop = () => { if (settled || killTimer) return; try { child.stdin.write('C'); child.stdin.end(); } catch { /* Native observes stdin EOF. */ } killTimer = setTimeout(() => { try { child.kill(); } catch { /* Cleanup stays unconfirmed. */ } finish(null, false); }, L.cleanupMs); };
                const watchdog = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, L.nativeCallMs - L.cleanupMs));
                child.stdout.on('data', (chunk: Buffer) => { const data = Buffer.from(chunk); length += data.length; if (length > WIRE_BYTES) { malformed = true; stop(); } else chunks.push(data); });
                child.stderr.on('data', (chunk: Buffer) => { errors += chunk.length; if (errors > 4096) { malformed = true; stop(); } });
                child.stdin.on('error', () => {}); child.once('error', () => { if (child.pid === undefined) finish(null, true); else stop(); });
                child.once('close', code => finish(code, true)); abort.signal.addEventListener('abort', stop, { once: true }); if (abort.signal.aborted || closed) stop();
              });
              if (!received.cleanClose || received.code !== 0 || received.malformed) { cleanupProved = !processMayHaveStarted; result = failed(snapshot.executionId, received.malformed ? 'limit' : received.timedOut ? 'timed_out' : 'isolation_failed', cleanupProved, started); }
              else {
                const report: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(received.stdout)); result = parseWorkCycleNativeReport(report, snapshot.executionId, signature);
                newFile(path.join(execution, 'native-report.json'), received.stdout); reportHash = digest(received.stdout); cleanupProved = result.cleanupConfirmed;
                if (received.timedOut) result = { ...result, termination: 'timed_out' };
                if (abort.signal.aborted || closed) result = { ...result, termination: 'cancelled' };
              }
            }
          }
        } catch { cleanupProved = !processMayHaveStarted; result = failed(snapshot.executionId, abort.signal.aborted || closed ? 'cancelled' : 'isolation_failed', cleanupProved, started); }
        const runtimeDisposed = disposeCopies(); result = { ...result, cleanupConfirmed: result.cleanupConfirmed && runtimeDisposed }; if (!result.cleanupConfirmed) cleanupFailed = true;
        await host.beforeResult?.();
        if (abort.signal.aborted || closed) result = { ...result, termination: 'cancelled' };
        newFile(path.join(execution, 'result.json'), JSON.stringify({ schema: 'aaw.c1.execution-result.v1', executionId: snapshot.executionId, signature, nonce, result, nativeReportSha256: reportHash, runtimeDisposed, completedAt: new Date().toISOString() }));
        return result;
      }).catch((error: unknown) => { cleanupFailed = true; throw error instanceof WorkCycleError ? error : new WorkCycleError('STORAGE_FAILED'); }).finally(() => { signal.removeEventListener('abort', cancel); if (active?.promise === promise) active = null; });
      active = { executionId: snapshot.executionId, signature, abort, promise };
      return promise;
    },
    close() {
      closing ??= (async () => { closed = true; const current = active; if (current) { current.abort.abort(); try { const result = await current.promise; if (!result.cleanupConfirmed) cleanupFailed = true; } catch { cleanupFailed = true; } } if (cleanupFailed) fail('CLEANUP_FAILED'); })();
      return closing;
    },
  });
}
const realRemoval: Removal = { unlink: filename => fs.unlinkSync(filename), rmdir: directory => fs.rmdirSync(directory), exists: filename => fs.existsSync(filename), entries: directory => fs.readdirSync(directory) };
export function createWindowsWorkCycleRunner(): WorkCycleRunner {
  return createRunner({ identity: installedIdentity(), executions: path.join(runnerRoot(), 'executions'), spawn: (program, args, options) => childProcess.spawn(program, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }), removal: realRemoval });
}
export const createWorkCycleRunner = createWindowsWorkCycleRunner;
/** Explicit in-process test dependency seam; never used by bootstrap, IPC or a model.
 * Tests must supply a process stub and removal counters, and can only use a fresh private test root. */
export function createWorkCycleRunnerForTests(options: Readonly<{ directory: string; identity: Identity; spawn: NativeSpawn; removal: Removal; beforePrepare?: () => Promise<void>; beforeResult?: () => Promise<void> }>): WorkCycleRunner {
  const directory = path.resolve(options.directory);
  if (directory !== options.directory || !/[/\\]\.local[/\\]agent-work-cycle-runner-tests[/\\][0-9a-f-]{36}$/u.test(directory) || !directory.toLowerCase().startsWith(product().toLowerCase() + path.sep)) fail('UNSUPPORTED_PATH');
  ordinary(directory, true);
  for (const candidate of [options.identity.runtime, options.identity.native, options.identity.proof]) if (!path.resolve(candidate).toLowerCase().startsWith(directory.toLowerCase() + path.sep)) fail('UNSUPPORTED_PATH');
  return createRunner({ ...options, executions: path.join(directory, 'executions') });
}
