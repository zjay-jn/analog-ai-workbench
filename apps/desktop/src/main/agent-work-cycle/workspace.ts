import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { WORK_CYCLE_LIMITS as L, isWorkCycleRelativePath, type WorkCycleFile, type WorkCycleChange, type WorkCycleContinuationRef, type WorkCycleExecution, type WorkCycleImportSource, type WorkCycleToolArguments, type WorkCycleToolValue } from '../../shared/agent/agent-work-cycle';
import { PROJECT_READ_LIMITS as P } from '../../shared/agent/agent-project-read';
import { parseWorkCycleContinuationRef } from '../../shared/agent/agent-project-read-validation';
import { fileNameAllowed, validFileText } from '../../shared/agent/file-context';
import { folderPartAllowed, inspectProjectFolderPath, sameProjectFolderChain, type FolderIdentity } from '../cloud/project-folder-files';
import { WorkCycleError, type WorkCycleWorkspace, type WorkCycleWorkspaceFactory, type WorkCycleSnapshot, type WorkCycleRunnerResult, type WorkCycleBaseline, type WorkCycleSeed } from './types';
import { validateCommandChanges } from '../agent-command/changes';
import type { CommandProducedChanges } from '../agent-command/types';

type StoredFile = { file: WorkCycleFile; object: string };
type WriteValue = Extract<WorkCycleToolValue, { kind: 'work_write' | 'work_import' | 'work_edit' }>;
type Change = { callId: string; signature: string; result: WriteValue; object: string; beforeObject: string | null; confirmed: boolean };
type Execution = { callId: string; signature: string; executionId: string; script: WorkCycleSnapshot['script']; scriptRelativePath: string; inputs: WorkCycleSnapshot['inputs']; inputChain: FolderIdentity[]; outputChain: FolderIdentity[]; result: WorkCycleExecution | null; resultSignature: string | null; artifacts: StoredFile[]; confirmed: boolean };
type Seed = { source: WorkCycleContinuationRef; state: 'preparing' | 'ready'; files: StoredFile[] };
type CommandArtifacts = {executionId:string;manifestVersion:string;baselineVersion:string;signature:string;artifacts:StoredFile[];confirmed:boolean};
type Disk = { schema: 1; runId: string; workspaceId: string; revision: number; files: StoredFile[]; changes: Change[]; executions: Execution[]; commands?:CommandArtifacts[]; seed?: Seed };
type ReadResult = { bytes: Buffer; stat: fs.BigIntStats };
type Hooks = Readonly<{ beforeManifestReplace?(): void; afterManifestReplace?(): void }>;
type Options = Parameters<WorkCycleWorkspaceFactory>[0] & Readonly<{ hooks?: Hooks }>;
// Only an actual export in this main process issues seed material. The caller
// cannot turn a path, copied JSON, or a different parent's files into authority.
const issuedBases = new WeakMap<object, { runId: string; workspaceId: string; version: string; directory: string; signature: string; verify(): void }>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const shaPattern = /^[0-9a-f]{64}$/u;
const diskBytes = L.revisions * 4096 + L.executions * (L.logBytes * 2 + L.files * 1024);
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical((value as Record<string, unknown>)[key]))])) : value);
const signatureOf = (value: unknown): string => digest(canonical(value));
const clone = <T>(value: T): T => structuredClone(value);
function fail(code: ConstructorParameters<typeof WorkCycleError>[0]): never { throw new WorkCycleError(code); }
const code = (error: unknown): string => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
const same = (a: fs.BigIntStats, b: fs.BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const ordinary = (stat: fs.BigIntStats): boolean => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || Buffer.byteLength(value) > P.idBytes || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) fail('INVALID_REQUEST'); }
function sha(value: unknown): asserts value is string { if (typeof value !== 'string' || !shaPattern.test(value)) fail('INVALID_REQUEST'); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail('INVALID_REQUEST');
  for (const key of keys) { const property = Object.getOwnPropertyDescriptor(value, key); if (!property || !property.enumerable || !('value' in property)) fail('INVALID_REQUEST'); }
  return value as Record<string, unknown>;
}
function workPath(value: unknown): asserts value is string {
  if (!isWorkCycleRelativePath(value) || value.split('/').some(part => part.startsWith('.') || !folderPartAllowed(part)) || !fileNameAllowed(value.split('/').at(-1)!)) fail('UNSUPPORTED_PATH');
}
function compatiblePaths(a: string, b: string): boolean {
  const left = a.split('/'), right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i]!.toLowerCase() !== right[i]!.toLowerCase()) return true;
    if (left[i] !== right[i]) return false;
  }
  return a === b;
}
function textOf(bytes: Uint8Array): string {
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail('UNSUPPORTED_ENCODING'); }
  if (!validFileText(text.replace(/\r\n?/gu, '\n'))) fail('UNSUPPORTED_TEXT');
  return text;
}
function source(value: unknown): asserts value is WorkCycleImportSource {
  const v = exact(value, ['projectId', 'bindingId', 'identity', 'fileId', 'relativePath', 'version', 'bytes']);
  for (const key of ['projectId', 'bindingId', 'identity', 'fileId']) id(v[key]); sha(v.version);
  if (typeof v.relativePath !== 'string' || !v.relativePath || Buffer.byteLength(v.relativePath) > P.relativePathBytes || v.relativePath.split('/').some(part => part.startsWith('.') || !folderPartAllowed(part)) || !fileNameAllowed(v.relativePath.split('/').at(-1)!)) fail('UNSUPPORTED_PATH');
  if (!Number.isSafeInteger(v.bytes) || Number(v.bytes) < 0 || Number(v.bytes) > L.fileBytes) fail('FILE_LIMIT');
}
function file(value: unknown): asserts value is WorkCycleFile {
  const v = exact(value, ['fileId', 'relativePath', 'version', 'bytes', 'confirmation', 'origin']); id(v.fileId); workPath(v.relativePath); sha(v.version);
  if (!Number.isSafeInteger(v.bytes) || Number(v.bytes) < 0 || Number(v.bytes) > L.fileBytes || !['confirmed', 'unconfirmed'].includes(String(v.confirmation))) fail('INVALID_REQUEST');
  if (!v.origin || typeof v.origin !== 'object') fail('INVALID_REQUEST'); const origin = v.origin as Record<string, unknown>;
  if (origin.kind === 'write') { exact(origin, ['kind', 'changeId']); id(origin.changeId); }
  else if (origin.kind === 'execution') { exact(origin, ['kind', 'executionId']); id(origin.executionId); }
  else if (origin.kind === 'command') { exact(origin,['kind','executionId','manifestVersion','sourceRelativePath']);id(origin.executionId);sha(origin.manifestVersion);workPath(origin.sourceRelativePath); }
  else if (origin.kind === 'import') { exact(origin, ['kind', 'changeId', 'source']); id(origin.changeId); source(origin.source); }
  else if (origin.kind === 'continuation') { exact(origin, ['kind', 'source']); const s = exact(origin.source, ['runId', 'workspaceId', 'fileId', 'version', 'baselineVersion']); id(s.runId); id(s.workspaceId); id(s.fileId); sha(s.version); sha(s.baselineVersion); }
  else fail('INVALID_REQUEST');
}
function continuationRef(value: unknown): asserts value is WorkCycleContinuationRef {
  if (!parseWorkCycleContinuationRef(value)) fail('INVALID_REQUEST');
}
const materialSignature = (files: WorkCycleBaseline['files']): string => signatureOf(files.map(item => ({ file: item.file, bytes: digest(item.bytes) })));
function seedMaterial(seed: WorkCycleSeed, directory: string, runId: string, workspaceId: string): WorkCycleSeed {
  exact(seed, ['source', 'files']); continuationRef(seed.source);
  const proof = issuedBases.get(seed.files);
  if (!proof || proof.runId !== seed.source.runId || proof.workspaceId !== seed.source.workspaceId || proof.version !== seed.source.baselineVersion
      || proof.runId === runId || proof.workspaceId === workspaceId || path.dirname(directory) !== path.dirname(proof.directory)) fail('CONFLICT');
  if (!Array.isArray(seed.files) || seed.files.length > L.files || seed.files.length > L.revisions) fail('BUDGET_EXCEEDED');
  let total = 0;
  for (const item of seed.files) { exact(item, ['file', 'bytes']); file(item.file); if (!(item.bytes instanceof Uint8Array) || item.bytes.byteLength !== item.file.bytes || digest(item.bytes) !== item.file.version) fail('SOURCE_CHANGED'); if (item.file.confirmation !== 'confirmed') fail('CONFLICT'); textOf(item.bytes); total += item.bytes.byteLength; }
  if (total > L.workspaceBytes) fail('BUDGET_EXCEEDED');
  if (materialSignature(seed.files) !== proof.signature) fail('CONFLICT');
  proof.verify();
  return { source: clone(seed.source), files: seed.files.map(item => ({ file: clone(item.file), bytes: Uint8Array.from(item.bytes) })) };
}
function objectName(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.endsWith('.txt') || !uuid.test(value.slice(0, -4))) fail('INVALID_REQUEST'); }
function storedFile(value: unknown): asserts value is StoredFile { const v = exact(value, ['file', 'object']); file(v.file); objectName(v.object); }
function runnerResult(value: unknown): asserts value is WorkCycleRunnerResult {
  const v = exact(value, ['executionId', 'language', 'isolation', 'termination', 'exitCode', 'signal', 'durationMs', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated', 'cleanupConfirmed']); id(v.executionId);
  if (v.language !== 'javascript' || v.isolation !== 'windows-appcontainer' || !['exited', 'timed_out', 'cancelled', 'limit', 'isolation_failed'].includes(String(v.termination))) fail('INVALID_REQUEST');
  if (v.exitCode !== null && (!Number.isSafeInteger(v.exitCode) || Math.abs(Number(v.exitCode)) > 4294967295)) fail('INVALID_REQUEST');
  if (v.signal !== null && (typeof v.signal !== 'string' || !/^[A-Z0-9_]{1,64}$/u.test(v.signal))) fail('INVALID_REQUEST');
  if (typeof v.durationMs !== 'number' || !Number.isFinite(v.durationMs) || v.durationMs < 0 || v.durationMs > L.nativeCallMs) fail('INVALID_REQUEST');
  for (const key of ['stdout', 'stderr']) if (typeof v[key] !== 'string' || Buffer.byteLength(v[key] as string) > L.logBytes || /\p{Surrogate}/u.test(v[key] as string)) fail('INVALID_REQUEST');
  if (typeof v.cleanupConfirmed !== 'boolean' || typeof v.stdoutTruncated !== 'boolean' || typeof v.stderrTruncated !== 'boolean' || v.termination === 'exited' && v.exitCode === null) fail('INVALID_REQUEST');
}
function parseDisk(value: unknown, runId: string, workspaceId: string): Disk {
  const v = exact(value, ['schema', 'runId', 'workspaceId', 'revision', 'files', 'changes', 'executions', ...(value && typeof value === 'object' && Object.hasOwn(value, 'commands') ? ['commands'] : []), ...(value && typeof value === 'object' && Object.hasOwn(value, 'seed') ? ['seed'] : [])]);
  if (v.schema !== 1 || v.runId !== runId || v.workspaceId !== workspaceId || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0) fail('STORAGE_FAILED');
  if (!Array.isArray(v.files) || v.files.length > L.files || !Array.isArray(v.changes) || v.changes.length > L.changes || !Array.isArray(v.executions) || v.executions.length > L.executions) fail('STORAGE_FAILED');
  const calls = new Set<string>(), changes = new Set<string>(), paths = new Set<string>(), files = new Set<string>(), executions = new Set<string>(); let totalBytes = 0, revisions = 0;
  for (const item of v.files) { storedFile(item); if (paths.has(item.file.relativePath.toLowerCase()) || files.has(item.file.fileId) || [...paths].some(p => !compatiblePaths(p, item.file.relativePath.toLowerCase()))) fail('STORAGE_FAILED'); paths.add(item.file.relativePath.toLowerCase()); files.add(item.file.fileId); totalBytes += item.file.bytes; }
  if (totalBytes > L.workspaceBytes) fail('STORAGE_FAILED');
  if (v.seed !== undefined) {
    const seed = exact(v.seed, ['source', 'state', 'files']); continuationRef(seed.source);
    if (seed.source.runId === runId || seed.source.workspaceId === workspaceId || !['preparing', 'ready'].includes(String(seed.state)) || !Array.isArray(seed.files) || seed.files.length > L.files) fail('STORAGE_FAILED');
    const initialIds = new Set<string>(), initialPaths: string[] = []; let initialBytes = 0;
    for (const item of seed.files) {
      storedFile(item); const origin = item.file.origin;
      if (initialIds.has(item.file.fileId) || initialPaths.some(p => p.toLowerCase() === item.file.relativePath.toLowerCase() || !compatiblePaths(p, item.file.relativePath))
          || origin.kind !== 'continuation' || origin.source.runId !== seed.source.runId || origin.source.workspaceId !== seed.source.workspaceId || origin.source.baselineVersion !== seed.source.baselineVersion
          || origin.source.version !== item.file.version || item.file.confirmation !== (seed.state === 'ready' ? 'confirmed' : 'unconfirmed')) fail('STORAGE_FAILED');
      initialIds.add(item.file.fileId); initialPaths.push(item.file.relativePath); initialBytes += item.file.bytes; revisions++;
    }
    if (initialBytes > L.workspaceBytes) fail('STORAGE_FAILED');
    if (seed.state === 'preparing' && (v.changes.length !== 0 || v.executions.length !== 0 || v.files.length !== 0 && !isDeepStrictEqual(v.files, seed.files))) fail('STORAGE_FAILED');
    const headFiles = v.files as StoredFile[];
    if (seed.state === 'ready' && seed.files.some((initial: StoredFile) => !headFiles.some(head => head.file.fileId === initial.file.fileId && head.file.relativePath === initial.file.relativePath))) fail('STORAGE_FAILED');
    for (const head of v.files) if (head.file.origin.kind === 'continuation' && !seed.files.some((initial: StoredFile) => isDeepStrictEqual(initial, head))) fail('STORAGE_FAILED');
  } else if (v.files.some((item: StoredFile) => item.file.origin.kind === 'continuation')) fail('STORAGE_FAILED');
  for (const item of v.changes) {
    const c = exact(item, ['callId', 'signature', 'result', 'object', 'beforeObject', 'confirmed']); id(c.callId); sha(c.signature); objectName(c.object); if (c.beforeObject !== null) objectName(c.beforeObject); if (typeof c.confirmed !== 'boolean' || calls.has(c.callId)) fail('STORAGE_FAILED'); calls.add(c.callId);
    const r = exact(c.result, ['kind', 'file', 'previousVersion', 'changeId', 'changed']); file(r.file); id(r.changeId); if (r.previousVersion !== null) sha(r.previousVersion);
    if (!['work_write', 'work_import', 'work_edit'].includes(String(r.kind)) || typeof r.changed !== 'boolean' || changes.has(r.changeId) || (r.previousVersion === null) !== (c.beforeObject === null) || r.kind === 'work_edit' && (r.previousVersion === null || r.file.origin.kind !== 'write')) fail('STORAGE_FAILED'); changes.add(r.changeId); revisions++;
  }
  for (const item of v.executions) {
    const e = exact(item, ['callId', 'signature', 'executionId', 'script', 'scriptRelativePath', 'inputs', 'inputChain', 'outputChain', 'result', 'resultSignature', 'artifacts', 'confirmed']); id(e.callId); id(e.executionId); sha(e.signature); workPath(e.scriptRelativePath);
    if (calls.has(e.callId) || executions.has(e.executionId) || typeof e.confirmed !== 'boolean' || !Array.isArray(e.inputs) || e.inputs.length > L.files || !Array.isArray(e.artifacts) || e.artifacts.length > L.artifactsPerExecution) fail('STORAGE_FAILED'); calls.add(e.callId); executions.add(e.executionId);
    const s = exact(e.script, ['fileId', 'version']); id(s.fileId); sha(s.version);
    for (const chain of [e.inputChain, e.outputChain]) { if (!Array.isArray(chain) || chain.length < 2 || chain.length > 64) fail('STORAGE_FAILED'); for (const part of chain) { const identity = exact(part, ['dev', 'ino']); if (typeof identity.dev !== 'string' || typeof identity.ino !== 'string' || !/^\d{1,32}$/u.test(identity.dev) || !/^\d{1,32}$/u.test(identity.ino)) fail('STORAGE_FAILED'); } }
    for (const input of e.inputs) { const i = exact(input, ['fileId', 'relativePath', 'version', 'bytes']); id(i.fileId); workPath(i.relativePath); sha(i.version); if (!Number.isSafeInteger(i.bytes) || Number(i.bytes) < 0 || Number(i.bytes) > L.fileBytes) fail('STORAGE_FAILED'); }
    for (const artifact of e.artifacts) { storedFile(artifact); revisions++; }
    if (e.result === null) { if (e.resultSignature !== null || e.artifacts.length !== 0 || e.confirmed) fail('STORAGE_FAILED'); }
    else {
      sha(e.resultSignature); const result = exact(e.result, ['executionId', 'language', 'isolation', 'termination', 'exitCode', 'signal', 'durationMs', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated', 'cleanupConfirmed', 'script', 'inputs', 'artifacts', 'verified']);
      const { script: ignoredScript, inputs: ignoredInputs, artifacts: ignoredArtifacts, verified: ignoredVerified, ...run } = result; runnerResult(run);
      if (run.executionId !== e.executionId || signatureOf(run) !== e.resultSignature || !isDeepStrictEqual(result.script, e.script) || !isDeepStrictEqual(result.inputs, e.inputs) || !isDeepStrictEqual(result.artifacts, e.artifacts.map((a: StoredFile) => a.file)) || result.verified !== (run.cleanupConfirmed && run.termination === 'exited' && run.exitCode === 0 && run.signal === null) || !result.verified && e.artifacts.length !== 0) fail('STORAGE_FAILED');
    }
  }
  if(v.commands!==undefined){if(!Array.isArray(v.commands)||v.commands.length>L.executions)fail('STORAGE_FAILED');const commandIds=new Set<string>();
    for(const input of v.commands){const c=exact(input,['executionId','manifestVersion','baselineVersion','signature','artifacts','confirmed']);id(c.executionId);sha(c.manifestVersion);sha(c.baselineVersion);sha(c.signature);if(typeof c.confirmed!=='boolean'||!Array.isArray(c.artifacts)||c.artifacts.length>L.artifactsPerExecution||commandIds.has(c.executionId))fail('STORAGE_FAILED');commandIds.add(c.executionId);
      for(const a of c.artifacts){storedFile(a);if(a.file.origin.kind!=='command'||a.file.origin.executionId!==c.executionId||a.file.origin.manifestVersion!==c.manifestVersion||a.file.confirmation!==(c.confirmed?'confirmed':'unconfirmed')||!(v.files as StoredFile[]).some(f=>isDeepStrictEqual(f,a)))fail('STORAGE_FAILED');revisions++;}
    }
  }
  for(const f of v.files as StoredFile[])if(f.file.origin.kind==='command'&&!(v.commands as CommandArtifacts[]|undefined)?.some(c=>c.artifacts.some(a=>isDeepStrictEqual(a,f))))fail('STORAGE_FAILED');
  if (revisions > L.revisions) fail('STORAGE_FAILED');
  return value as Disk;
}

/** Pure state gate for explicit task reclamation; never adopts or repairs an unknown receipt. */
export function inspectWorkCycleReclamationManifest(value: unknown, runId: string, workspaceId: string): Readonly<{ executionIds: readonly string[]; clear: boolean }> {
  const disk = parseDisk(value, runId, workspaceId);
  // Confirmation controls reuse, not deletion of an owned private file. Only execution uncertainty blocks reclamation.
  return { executionIds: disk.executions.map(e => e.executionId), clear: disk.executions.every(e => e.result?.cleanupConfirmed === true) };
}

/** Only main supplies this dedicated directory. Logical paths never authorize a host path.
 * Bodies are immutable objects; the checked manifest rename is the publication point.
 * A failed publication poisons this instance. History can reopen it without replaying IO. */
export const createWorkCycleWorkspace = async (options: Options): Promise<WorkCycleWorkspace> => {
  id(options.runId); id(options.workspaceId);
  const directory = path.resolve(options.directory);
  if (process.platform !== 'win32' || directory !== options.directory || path.basename(directory) !== options.workspaceId || options.signal.aborted) fail(options.signal.aborted ? 'CANCELLED' : 'UNSUPPORTED_PATH');
  const parent = path.dirname(directory), allowedParent = path.basename(parent) === 'workspaces' && path.basename(path.dirname(parent)) === 'agent-work-cycle';
  const testParent = /[\\/]\.local[\\/]agent-work-cycle-tests[\\/][0-9a-f-]{36}(?:[\\/]workspaces)?$/u.test(parent);
  if (!allowedParent && !testParent) fail('UNSUPPORTED_PATH');
  // Revalidate the issued parent before creating any directory or lock.
  const initialSeed = options.seed ? seedMaterial(options.seed, directory, options.runId, options.workspaceId) : undefined;
  let created = false;
  function ensureDirectory(target: string): void {
    try { inspectProjectFolderPath(target, true); }
    catch (error) { if (code(error) !== 'ENOENT') throw error; const ancestor = path.dirname(target); if (ancestor === target) throw error; ensureDirectory(ancestor); fs.mkdirSync(target); inspectProjectFolderPath(target, true); }
  }
  try { inspectProjectFolderPath(directory, true); }
  catch (error) { if (options.readOnly || code(error) !== 'ENOENT') fail('STORAGE_FAILED'); ensureDirectory(parent); fs.mkdirSync(directory); created = true; }
  const chain = inspectProjectFolderPath(directory, true).chain;
  let closed = false, poisoned = false, expected: ReadResult | null = null, lock: ReadResult | undefined, canConfirmSeed = false;
  const manifest = path.join(directory, 'workspace.json'), lockPath = path.join(directory, 'writer.lock');
  function checkRoot(): void { if (!sameProjectFolderChain(chain, inspectProjectFolderPath(directory, true).chain)) fail('ROOT_CHANGED'); }
  function alive(write = false, allowPreparing = false): void { if (closed || options.signal.aborted) fail('CANCELLED'); if (poisoned) fail('STORAGE_FAILED'); if (write && options.readOnly) fail('CAPABILITY_DENIED'); if (write && !allowPreparing && state.seed?.state === 'preparing') fail('CONFLICT'); checkRoot(); }
  function checked(target: string, maximum: number): ReadResult {
    checkRoot(); const relative = path.relative(directory, target); if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('UNSUPPORTED_PATH');
    const before = inspectProjectFolderPath(target, false); if (!sameProjectFolderChain(chain, before.chain.slice(0, chain.length)) || before.stat.size > BigInt(maximum)) fail('STORAGE_FAILED');
    const fd = fs.openSync(target, 'r'); try {
      if (!same(before.stat, fs.fstatSync(fd, { bigint: true }))) fail('SOURCE_CHANGED'); const bytes = Buffer.alloc(Number(before.stat.size) + 1); let count = 0;
      while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
      const after = inspectProjectFolderPath(target, false); if (count !== Number(before.stat.size) || !same(before.stat, fs.fstatSync(fd, { bigint: true })) || !same(before.stat, after.stat) || !sameProjectFolderChain(before.chain, after.chain)) fail('SOURCE_CHANGED'); checkRoot();
      return { bytes: bytes.subarray(0, count), stat: after.stat };
    } finally { fs.closeSync(fd); }
  }
  function newFile(target: string, bytes: Buffer): ReadResult {
    checkRoot(); const parentChain = inspectProjectFolderPath(path.dirname(target), true).chain; if (!sameProjectFolderChain(chain, parentChain.slice(0, chain.length))) fail('ROOT_CHANGED');
    const fd = fs.openSync(target, 'wx', 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const result = checked(target, Math.max(bytes.length, 1)); if (!result.bytes.equals(bytes) || !sameProjectFolderChain(parentChain, inspectProjectFolderPath(path.dirname(target), true).chain)) fail('STORAGE_FAILED'); return result;
  }
  function removeOwned(target: string, proof: ReadResult): void { const value = checked(target, Math.max(proof.bytes.length, 1)); if (same(value.stat, proof.stat) && value.bytes.equals(proof.bytes)) fs.unlinkSync(target); else fail('CLEANUP_FAILED'); }
  function ownLock(): void { if (options.readOnly) return; if (!lock) fail('STORAGE_FAILED'); const value = checked(lockPath, 1024); if (!same(lock.stat, value.stat) || !lock.bytes.equals(value.bytes)) fail('STORAGE_FAILED'); }
  function stoppedWriter(): void {
    if (!options.requireStoppedWriter) return;
    if (!options.readOnly) fail('CAPABILITY_DENIED');
    let held: ReadResult;
    try { held = checked(lockPath, 1024); } catch (error) { if (code(error) === 'ENOENT') return; throw error; }
    const owner = exact(JSON.parse(held.bytes.toString('utf8')), ['pid', 'nonce']);
    if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || typeof owner.nonce !== 'string' || !uuid.test(owner.nonce)) fail('CLEANUP_FAILED');
    try { process.kill(Number(owner.pid), 0); fail('CLEANUP_FAILED'); } catch (error) { if (code(error) !== 'ESRCH') fail('CLEANUP_FAILED'); }
    const current = checked(lockPath, 1024); if (!same(held.stat, current.stat) || !held.bytes.equals(current.bytes)) fail('CONFLICT');
  }
  function targetCurrent(): void {
    ownLock(); let actual: ReadResult | null; try { actual = checked(manifest, diskBytes); } catch (error) { if (code(error) !== 'ENOENT') throw error; actual = null; }
    if (expected === null ? actual !== null : actual === null || !same(expected.stat, actual.stat) || !actual.bytes.equals(expected.bytes)) fail('CONFLICT');
  }
  if (!options.readOnly) {
    try { lock = newFile(lockPath, Buffer.from(JSON.stringify({ pid: process.pid, nonce: randomUUID() }))); }
    catch (error) { if (code(error) !== 'EEXIST') throw error; const stale = checked(lockPath, 1024); let owner: Record<string, unknown>; try { owner = exact(JSON.parse(stale.bytes.toString('utf8')), ['pid', 'nonce']); } catch { return fail('BUSY'); }
      if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || typeof owner.nonce !== 'string' || !uuid.test(owner.nonce)) fail('BUSY');
      try { process.kill(Number(owner.pid), 0); fail('BUSY'); } catch (probe) { if (code(probe) !== 'ESRCH') throw probe; }
      removeOwned(lockPath, stale); lock = newFile(lockPath, Buffer.from(JSON.stringify({ pid: process.pid, nonce: randomUUID() })));
    }
  }
  let state: Disk;
  function persist(next: Disk, allowPreparing = false): void {
    alive(true, allowPreparing); next.revision = state.revision + 1; parseDisk(next, options.runId, options.workspaceId); const bytes = Buffer.from(JSON.stringify(next)); if (bytes.length > diskBytes) fail('BUDGET_EXCEEDED');
    let temp: string | undefined, proof: ReadResult | undefined;
    try { targetCurrent(); temp = path.join(directory, `manifest-${randomUUID()}.tmp`); proof = newFile(temp, bytes); options.hooks?.beforeManifestReplace?.(); alive(true, allowPreparing); targetCurrent(); fs.renameSync(temp, manifest); temp = undefined; options.hooks?.afterManifestReplace?.();
      const saved = checked(manifest, diskBytes); if (!saved.bytes.equals(bytes)) fail('STORAGE_FAILED'); ownLock(); alive(true, allowPreparing); expected = saved; state = next;
    } catch (error) { poisoned = true; throw error instanceof WorkCycleError ? error : new WorkCycleError('STORAGE_FAILED'); }
    finally { if (temp && proof) try { removeOwned(temp, proof); } catch { /* An unproven temp is never promoted or reused. */ } }
  }
  try {
    try { expected = checked(manifest, diskBytes); state = parseDisk(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(expected.bytes)), options.runId, options.workspaceId); if (initialSeed) fail('CONFLICT'); }
    catch (error) {
      if (code(error) !== 'ENOENT' || options.readOnly || !created) throw error;
      const seed: Seed | undefined = initialSeed ? { source: initialSeed.source, state: 'preparing', files: initialSeed.files.map(item => ({
        file: { fileId: `wcf-${randomUUID()}`, relativePath: item.file.relativePath, version: item.file.version, bytes: item.file.bytes, confirmation: 'unconfirmed', origin: { kind: 'continuation', source: { runId: initialSeed.source.runId, workspaceId: initialSeed.source.workspaceId, fileId: item.file.fileId, version: item.file.version, baselineVersion: initialSeed.source.baselineVersion } } },
        object: `${randomUUID()}.txt`,
      })) } : undefined;
      state = { schema: 1, runId: options.runId, workspaceId: options.workspaceId, revision: 0, files: [], changes: [], executions: [], ...(seed ? { seed } : {}) };
      parseDisk(state, options.runId, options.workspaceId); expected = newFile(manifest, Buffer.from(JSON.stringify(state)));
    }
    if (!options.readOnly) { ensureDirectory(path.join(directory, 'objects')); ensureDirectory(path.join(directory, 'executions')); }
    if (initialSeed) {
      alive(true, true);
      for (let i = 0; i < initialSeed.files.length; i++) { alive(true, true); newFile(path.join(directory, 'objects', state.seed!.files[i]!.object), Buffer.from(initialSeed.files[i]!.bytes)); }
      const next = clone(state); next.files = clone(next.seed!.files); persist(next, true); canConfirmSeed = true;
    }
  } catch (error) { if (lock) try { removeOwned(lockPath, lock); } catch { /* Preserve unknown ownership. */ } throw error instanceof WorkCycleError ? error : new WorkCycleError('STORAGE_FAILED'); }
  function content(item: StoredFile): Buffer {
    const target = path.join(directory, 'objects', item.object), first = checked(target, L.fileBytes), second = checked(target, L.fileBytes);
    if (!same(first.stat, second.stat) || !first.bytes.equals(second.bytes) || second.bytes.length !== item.file.bytes || digest(second.bytes) !== item.file.version) fail('SOURCE_CHANGED'); textOf(second.bytes); return second.bytes;
  }
  function object(bytes: Buffer): string { const name = `${randomUUID()}.txt`; newFile(path.join(directory, 'objects', name), bytes); return name; }
  const receipt = (callId: string): Change | Execution | undefined => state.changes.find(c => c.callId === callId) ?? state.executions.find(e => e.callId === callId);
  const writeReceipt = (change: Change): WriteValue => clone({ ...change.result, file: { ...change.result.file, confirmation: change.confirmed ? 'confirmed' : 'unconfirmed' } });
  function executionReceipt(execution: Execution): WorkCycleExecution { if (!execution.result) fail('CONFLICT'); return clone({ ...execution.result, artifacts: execution.result.artifacts.map(item => ({ ...item, confirmation: execution.confirmed ? 'confirmed' as const : 'unconfirmed' as const })) }); }
  function currentFile(fileId: string, version: string): StoredFile { id(fileId); sha(version); const item = state.files.find(f => f.file.fileId === fileId); if (!item || item.file.version !== version) fail('CONFLICT'); return item; }
  function capacity(next: Disk): void { if (next.files.length > L.files || next.files.reduce((sum, f) => sum + f.file.bytes, 0) > L.workspaceBytes || (next.seed?.files.length ?? 0) + next.changes.length + next.executions.reduce((sum, e) => sum + e.artifacts.length, 0) + (next.commands??[]).reduce((sum,c)=>sum+c.artifacts.length,0) > L.revisions) fail('BUDGET_EXCEEDED'); }
  function confirmedBodies(disk: Disk): void {
    if(disk.commands?.some(c=>!c.confirmed))fail('CONFLICT');
    if (disk.seed?.state === 'preparing' || disk.files.some(item => item.file.confirmation !== 'confirmed') || disk.changes.some(item => !item.confirmed) || disk.executions.some(item => !item.confirmed || !item.result)) fail('CONFLICT');
    if (disk.executions.some(item => !item.result!.cleanupConfirmed)) fail('CLEANUP_FAILED');
    capacity(disk);
    for (const item of [...disk.files, ...(disk.seed?.files ?? []), ...disk.executions.flatMap(e => e.artifacts)]) content(item);
    for (const change of disk.changes) {
      content({ file: change.result.file, object: change.object });
      if (change.beforeObject) { const bytes = checked(path.join(directory, 'objects', change.beforeObject), L.fileBytes).bytes; if (digest(bytes) !== change.result.previousVersion) fail('SOURCE_CHANGED'); textOf(bytes); }
    }
  }
  function save(callId: string, args: WorkCycleToolArguments['work_write'] | WorkCycleToolArguments['work_import'], bytes: Buffer, origin?: WorkCycleImportSource): WriteValue {
    alive(true); id(callId); workPath(args.relativePath); if (args.relativePath.split('/')[0]!.toLowerCase() === 'artifacts') fail('UNSUPPORTED_PATH'); if (args.expectedVersion !== null) sha(args.expectedVersion);
    const signature = signatureOf({ kind: origin ? 'work_import' : 'work_write', args, source: origin ?? null, bytes: digest(bytes) }), oldReceipt = receipt(callId);
    if (oldReceipt) { if (!('beforeObject' in oldReceipt) || oldReceipt.signature !== signature) fail('CONFLICT'); content({ file: oldReceipt.result.file, object: oldReceipt.object }); return writeReceipt(oldReceipt); }
    if (state.changes.length >= L.changes) fail('BUDGET_EXCEEDED'); if (bytes.length > (origin ? L.fileBytes : L.writeBytes)) fail('FILE_LIMIT'); textOf(bytes);
    const before = state.files.find(f => f.file.relativePath.toLowerCase() === args.relativePath.toLowerCase());
    if (state.files.some(item => !compatiblePaths(item.file.relativePath, args.relativePath))) fail('CONFLICT');
    if (before ? args.expectedVersion !== before.file.version || before.file.relativePath !== args.relativePath : args.expectedVersion !== null) fail('CONFLICT');
    return publishChange(callId, signature, before, args.relativePath, bytes, origin ? 'work_import' : 'work_write', origin);
  }
  function publishChange(callId: string, signature: string, before: StoredFile | undefined, relativePath: string, bytes: Buffer, kind: WriteValue['kind'], origin?: WorkCycleImportSource): WriteValue {
    if (state.changes.length >= L.changes) fail('BUDGET_EXCEEDED'); if (bytes.length > L.fileBytes) fail('FILE_LIMIT'); textOf(bytes);
    if (kind === 'work_edit' && !before) fail('CONFLICT');
    const beforeBytes = before ? content(before) : null, version = digest(bytes), changeId = `wcc-${randomUUID()}`;
    const resultFile: WorkCycleFile = { fileId: before?.file.fileId ?? `wcf-${randomUUID()}`, relativePath, version, bytes: bytes.length, confirmation: 'unconfirmed', origin: origin ? { kind: 'import', changeId, source: clone(origin) } : { kind: 'write', changeId } };
    const common = { file: resultFile, previousVersion: before?.file.version ?? null, changeId, changed: beforeBytes === null || !beforeBytes.equals(bytes) };
    const result: WriteValue = kind === 'work_edit' ? { ...common, kind, previousVersion: before!.file.version } : { ...common, kind };
    const next = clone(state), item: StoredFile = { file: resultFile, object: beforeBytes?.equals(bytes) ? before!.object : '' };
    const index = next.files.findIndex(f => f.file.fileId === resultFile.fileId); if (index < 0) next.files.push(item); else next.files[index] = item;
    next.changes.push({ callId, signature, result, object: item.object, beforeObject: before?.object ?? null, confirmed: false }); capacity(next);
    item.object ||= object(bytes); next.changes.at(-1)!.object = item.object; persist(next); return clone(result);
  }
  function snapshotValue(e: Execution): WorkCycleSnapshot { return { executionId: e.executionId, inputDirectory: path.join(directory, 'executions', e.executionId, 'input'), outputDirectory: path.join(directory, 'executions', e.executionId, 'output'), scriptRelativePath: e.scriptRelativePath, script: clone(e.script), inputs: clone(e.inputs) }; }
  function verifySnapshot(e: Execution): void { const snapshot = snapshotValue(e); if (!sameProjectFolderChain(e.inputChain, inspectProjectFolderPath(snapshot.inputDirectory, true).chain) || !sameProjectFolderChain(e.outputChain, inspectProjectFolderPath(snapshot.outputDirectory, true).chain)) fail('ROOT_CHANGED'); for (const item of e.inputs) { const bytes = checked(path.join(snapshot.inputDirectory, ...item.relativePath.split('/')), L.fileBytes).bytes; if (bytes.length !== item.bytes || digest(bytes) !== item.version) fail('SOURCE_CHANGED'); } }
  function outputs(e: Execution): { relativePath: string; bytes: Buffer }[] {
    const root = snapshotValue(e).outputDirectory, found: { relativePath: string; bytes: Buffer }[] = [], names = new Set<string>(); let total = 0, visited = 0;
    const visit = (relative: string): void => {
      const target = path.join(root, ...relative.split('/').filter(Boolean)), before = inspectProjectFolderPath(target, true), entries = fs.readdirSync(target, { withFileTypes: true });
      if (entries.length + visited > L.files * L.pathDepth) fail('BUDGET_EXCEEDED'); visited += entries.length;
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = relative ? `${relative}/${entry.name}` : entry.name, logical = `artifacts/${e.executionId}/${rel}`; workPath(entry.isDirectory() ? `${logical}/entry.txt` : logical);
        if (entry.isSymbolicLink()) fail('UNSUPPORTED_PATH'); const current = path.join(target, entry.name);
        if (entry.isDirectory()) visit(rel);
        else {
          const info = inspectProjectFolderPath(current, false); if (!ordinary(info.stat) || info.stat.size > BigInt(L.fileBytes)) fail('FILE_LIMIT');
          const first = checked(current, L.fileBytes), second = checked(current, L.fileBytes); if (!same(first.stat, second.stat) || !first.bytes.equals(second.bytes)) fail('SOURCE_CHANGED'); textOf(second.bytes);
          if (names.has(logical.toLowerCase()) || found.length >= L.artifactsPerExecution) fail('BUDGET_EXCEEDED'); names.add(logical.toLowerCase()); total += second.bytes.length; if (total > L.outputBytes) fail('BUDGET_EXCEEDED'); found.push({ relativePath: logical, bytes: second.bytes });
        }
      }
      const after = inspectProjectFolderPath(target, true); if (!same(before.stat, after.stat) || !sameProjectFolderChain(before.chain, after.chain)) fail('SOURCE_CHANGED');
    }; visit(''); return found;
  }
  return Object.freeze({
    ref: Object.freeze({ workspaceId: options.workspaceId, ...(state.seed ? { continuation: clone(state.seed.source) } : {}) }),
    async exportConfirmedBase() {
      alive(); targetCurrent(); stoppedWriter(); confirmedBodies(state);
      const sealed = expected!, exportedState = state, version = digest(sealed.bytes), files = Object.freeze(state.files.map(item => ({ file: clone(item.file), bytes: Uint8Array.from(content(item)) })));
      const verify = (): void => { const current = checked(manifest, diskBytes); if (!same(sealed.stat, current.stat) || !sealed.bytes.equals(current.bytes)) fail('CONFLICT'); stoppedWriter(); confirmedBodies(exportedState); };
      verify(); alive(); issuedBases.set(files, { runId: options.runId, workspaceId: options.workspaceId, directory, version, signature: materialSignature(files), verify });
      return Object.freeze({ runId: options.runId, workspaceId: options.workspaceId, version, files });
    },
    async confirmSeed() {
      alive(true, true); if (!state.seed || state.seed.state === 'ready') return;
      if (!canConfirmSeed || !isDeepStrictEqual(state.files, state.seed.files)) fail('CONFLICT');
      for (const item of state.seed.files) content(item);
      const next = clone(state); next.seed!.state = 'ready';
      for (const item of next.seed!.files) item.file = { ...item.file, confirmation: 'confirmed' };
      next.files = clone(next.seed!.files); persist(next, true); canConfirmSeed = false;
    },
    list() { alive(); for (const item of state.files) content(item); return clone(state.files.map(item => item.file)); },
    read(fileId: string, version: string) { alive(); const item = currentFile(fileId, version); return { file: clone(item.file), text: textOf(content(item)), verified: true as const }; },
    change(changeId: string): WorkCycleChange { alive(); id(changeId); const c = state.changes.find(item => item.result.changeId === changeId); if (!c) fail('CONFLICT'); const after = textOf(content({ file: c.result.file, object: c.object })); let before: string | null = null;
      if (c.beforeObject) { const bytes = checked(path.join(directory, 'objects', c.beforeObject), L.fileBytes).bytes; if (digest(bytes) !== c.result.previousVersion) fail('SOURCE_CHANGED'); before = textOf(bytes); }
      return { changeId, file: writeReceipt(c).file, previousVersion: c.result.previousVersion, before, after, changed: c.result.changed }; },
    async write(callId: string, args: WorkCycleToolArguments['work_write']) { exact(args, ['relativePath', 'expectedVersion', 'text']); if (typeof args.text !== 'string') fail('INVALID_REQUEST'); if (!validFileText(args.text.replace(/\r\n?/gu, '\n'))) fail('UNSUPPORTED_TEXT'); return save(callId, args, Buffer.from(args.text)) as Extract<WorkCycleToolValue, { kind: 'work_write' }>; },
    async importFile(callId: string, args: WorkCycleToolArguments['work_import'], src: WorkCycleImportSource, bytes: Uint8Array) { exact(args, ['fileId', 'version', 'relativePath', 'expectedVersion']); source(src); if (!(bytes instanceof Uint8Array) || args.fileId !== src.fileId || args.version !== src.version || bytes.byteLength !== src.bytes || digest(bytes) !== src.version) fail('SOURCE_CHANGED'); return save(callId, args, Buffer.from(bytes), src) as Extract<WorkCycleToolValue, { kind: 'work_import' }>; },
    async edit(callId: string, args: WorkCycleToolArguments['work_edit']) {
      alive(true); id(callId); exact(args, ['fileId', 'expectedVersion', 'oldText', 'newText']); id(args.fileId); sha(args.expectedVersion);
      if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') fail('INVALID_REQUEST');
      if (/\p{Surrogate}/u.test(args.oldText) || /\p{Surrogate}/u.test(args.newText)) fail('UNSUPPORTED_TEXT');
      const signature = signatureOf({ kind: 'work_edit', args }), previous = receipt(callId);
      if (previous) {
        if (!('beforeObject' in previous) || previous.result.kind !== 'work_edit' || previous.signature !== signature) fail('CONFLICT');
        content({ file: previous.result.file, object: previous.object }); return writeReceipt(previous) as Extract<WorkCycleToolValue, { kind: 'work_edit' }>;
      }
      const oldBytes = Buffer.from(args.oldText), newBytes = Buffer.from(args.newText);
      if (oldBytes.length + newBytes.length > L.editBytes) fail('INVALID_REQUEST'); textOf(oldBytes); textOf(newBytes);
      const before = currentFile(args.fileId, args.expectedVersion);
      if (before.file.relativePath.split('/')[0]!.toLowerCase() === 'artifacts') fail('UNSUPPORTED_PATH');
      const beforeBytes = content(before), first = beforeBytes.indexOf(oldBytes);
      if (first < 0 || beforeBytes.indexOf(oldBytes, first + 1) !== -1) fail('CONFLICT');
      const resultBytes = beforeBytes.length - oldBytes.length + newBytes.length;
      if (resultBytes > L.fileBytes) fail('FILE_LIMIT');
      const bytes = Buffer.concat([beforeBytes.subarray(0, first), newBytes, beforeBytes.subarray(first + oldBytes.length)], resultBytes);
      return publishChange(callId, signature, before, before.file.relativePath, bytes, 'work_edit') as Extract<WorkCycleToolValue, { kind: 'work_edit' }>;
    },
    async snapshot(callId: string, args: WorkCycleToolArguments['work_run']) {
      alive(true); id(callId); exact(args, ['fileId', 'version']); const signature = signatureOf({ kind: 'work_run', args }), previous = receipt(callId);
      if (previous) { if (!('executionId' in previous) || previous.signature !== signature || previous.result !== null) fail('CONFLICT'); verifySnapshot(previous); return snapshotValue(previous); }
      const script = currentFile(args.fileId, args.version); if (!/\.js$/iu.test(script.file.relativePath)) fail('UNSUPPORTED_TEXT'); if (state.executions.length >= L.executions) fail('BUDGET_EXCEEDED');
      if (state.files.some(item => item.file.confirmation !== 'confirmed')) fail('CONFLICT');
      const inputs = state.files.map(item => ({ fileId: item.file.fileId, relativePath: item.file.relativePath, version: item.file.version, bytes: item.file.bytes }));
      const e: Execution = { callId, signature, executionId: `wce-${randomUUID()}`, script: clone(args), scriptRelativePath: script.file.relativePath, inputs, inputChain: [], outputChain: [], result: null, resultSignature: null, artifacts: [], confirmed: false }, value = snapshotValue(e);
      ensureDirectory(value.inputDirectory); ensureDirectory(value.outputDirectory);
      e.inputChain = inspectProjectFolderPath(value.inputDirectory, true).chain; e.outputChain = inspectProjectFolderPath(value.outputDirectory, true).chain;
      for (const item of state.files) { const bytes = content(item), target = path.join(value.inputDirectory, ...item.file.relativePath.split('/')); ensureDirectory(path.dirname(target)); newFile(target, bytes); }
      alive(true); verifySnapshot(e); const next = clone(state); next.executions.push(e); persist(next); return value;
    },
    async acceptExecution(snapshot: WorkCycleSnapshot, result: WorkCycleRunnerResult) {
      alive(true); runnerResult(result); const e = state.executions.find(item => item.executionId === snapshot.executionId); if (!e || !isDeepStrictEqual(snapshotValue(e), snapshot) || result.executionId !== e.executionId) fail('CONFLICT');
      const signature = signatureOf(result); if (e.result) { if (e.resultSignature !== signature) fail('CONFLICT'); for (const artifact of e.artifacts) content(artifact); return executionReceipt(e); }
      verifySnapshot(e); const verified = result.cleanupConfirmed && result.termination === 'exited' && result.exitCode === 0 && result.signal === null;
      const values = verified ? outputs(e) : [], next = clone(state), target = next.executions.find(item => item.executionId === e.executionId)!;
      target.artifacts = values.map(value => ({ file: { fileId: `wcf-${randomUUID()}`, relativePath: value.relativePath, version: digest(value.bytes), bytes: value.bytes.length, confirmation: 'unconfirmed', origin: { kind: 'execution', executionId: e.executionId } }, object: '' }));
      next.files.push(...clone(target.artifacts)); capacity(next); for (let index = 0; index < values.length; index++) { target.artifacts[index]!.object = object(values[index]!.bytes); next.files.find(item => item.file.fileId === target.artifacts[index]!.file.fileId)!.object = target.artifacts[index]!.object; }
      target.result = { ...clone(result), script: clone(e.script), inputs: clone(e.inputs), artifacts: clone(target.artifacts.map(item => item.file)), verified }; target.resultSignature = signature;
      persist(next); return clone(target.result);
    },
    async publishCommandArtifacts(executionId:string,changes:CommandProducedChanges){
      alive(true);id(executionId);const signature=signatureOf({executionId,baselineVersion:changes.baselineVersion,manifestVersion:changes.manifestVersion,files:changes.files.map(f=>({...f,bytes:digest(f.bytes)})),deleted:changes.deleted});
      const prior=state.commands?.find(c=>c.executionId===executionId);if(prior){if(prior.signature!==signature)fail('CONFLICT');for(const item of prior.artifacts)content(item);return clone(prior.artifacts.map(a=>a.file));}
      confirmedBodies(state);targetCurrent();if(!expected||digest(expected.bytes)!==changes.baselineVersion)fail('CONFLICT');
      validateCommandChanges(changes,state.files.map(({file})=>({fileId:file.fileId,relativePath:file.relativePath,version:file.version,bytes:file.bytes})));
      if((state.commands?.length??0)>=L.executions)fail('BUDGET_EXCEEDED');
      const next=clone(state),entry:CommandArtifacts={executionId,manifestVersion:changes.manifestVersion,baselineVersion:changes.baselineVersion,signature,artifacts:changes.files.map((f,i)=>({file:{fileId:'wcf-'+randomUUID(),relativePath:`artifacts/${executionId}/${i}/${f.relativePath.split('/').at(-1)!}`,version:f.version,bytes:f.bytes.byteLength,confirmation:'unconfirmed',origin:{kind:'command',executionId,manifestVersion:changes.manifestVersion,sourceRelativePath:f.relativePath}},object:''})),confirmed:false};
      for(const item of entry.artifacts)workPath(item.file.relativePath);next.commands??=[];next.commands.push(entry);next.files.push(...entry.artifacts);capacity(next);
      for(let i=0;i<entry.artifacts.length;i++)entry.artifacts[i]!.object=object(Buffer.from(changes.files[i]!.bytes));persist(next);return clone(entry.artifacts.map(a=>a.file));
    },
    async confirmCommandArtifacts(executionId:string,manifestVersion:string){alive(true);id(executionId);sha(manifestVersion);const entry=state.commands?.find(c=>c.executionId===executionId);if(!entry||entry.manifestVersion!==manifestVersion)fail('CONFLICT');for(const a of entry.artifacts)content(a);if(entry.confirmed)return clone(entry.artifacts.map(a=>a.file));
      const next=clone(state),target=next.commands!.find(c=>c.executionId===executionId)!;target.confirmed=true;for(const a of target.artifacts){a.file={...a.file,confirmation:'confirmed'};const head=next.files.find(f=>f.file.fileId===a.file.fileId);if(!head)fail('CONFLICT');head.file=clone(a.file);}persist(next);return clone(target.artifacts.map(a=>a.file));
    },
    async confirm(callId: string) { alive(true); id(callId); const c = receipt(callId); if (!c || 'executionId' in c && !c.result) fail('CONFLICT'); if (c.confirmed) return;
      const next = clone(state), change = next.changes.find(item => item.callId === callId), execution = next.executions.find(item => item.callId === callId); if (change) change.confirmed = true; if (execution) execution.confirmed = true;
      const candidates = change ? [change.result.file] : execution!.artifacts.map(item => item.file);
      for (const item of next.files) if (candidates.some(candidate => candidate.fileId === item.file.fileId && candidate.version === item.file.version && isDeepStrictEqual(candidate.origin, item.file.origin))) { content(item); item.file = { ...item.file, confirmation: 'confirmed' }; }
      persist(next);
    },
    async close() { if (closed) return; closed = true; if (lock) { const proof = lock; lock = undefined; try { removeOwned(lockPath, proof); } catch { fail('CLEANUP_FAILED'); } } },
  });
};
