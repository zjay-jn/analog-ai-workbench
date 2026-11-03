import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decodeProjectText, ProjectTextError, type ProjectText } from '../../../../../packages/agent-adapters/src/project-read-text';
import { fileNameAllowed } from '../../shared/agent/file-context';
import { PROJECT_READ_LIMITS, type ProjectReadCode } from '../../shared/agent/agent-project-read';
import { folderReadPartAllowed, inspectProjectFolderPath, sameProjectFolderChain, type FolderRoot, type FolderIdentity } from './project-folder-files';
import { inspectFilesystemPath, filesystemReadPartAllowed, filesystemTextNameAllowed, type FileSystemReadRoot } from './filesystem-read-sources';

export const PROJECT_READ_FILE_LIMITS = Object.freeze({ fileBytes: PROJECT_READ_LIMITS.fileBytes, lines: PROJECT_READ_LIMITS.lines, operationBytes: PROJECT_READ_LIMITS.operationBytes, operationMs: PROJECT_READ_LIMITS.operationMs, runBytes: PROJECT_READ_LIMITS.runReadBytes, chunkBytes: PROJECT_READ_LIMITS.readChunkBytes, pathBytes: PROJECT_READ_LIMITS.relativePathBytes });
export class ProjectReadFsError extends Error {
  readonly code: ProjectReadCode;
  readonly osCode?:'ENOENT'|'EACCES'|'EPERM'|'ENOTDIR'|'EISDIR'|'EBUSY'|'EIO';
  constructor(code: ProjectReadCode,osCode?:string) { super(code); this.code = code;if(osCode&&['ENOENT','EACCES','EPERM','ENOTDIR','EISDIR','EBUSY','EIO'].includes(osCode))this.osCode=osCode as NonNullable<ProjectReadFsError['osCode']>; }
}
const fail = (code: ProjectReadCode): never => { throw new ProjectReadFsError(code); };
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const positive = (value: number, maximum: number) => { if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('INVALID_REQUEST'); };
const current = (signal: AbortSignal) => { if (signal.aborted) fail('CANCELLED'); };
const errorCode = (error: unknown): string | undefined => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

export type ProjectReadRoot = FolderRoot | (FileSystemReadRoot & { protectedRoots?: readonly string[] });
/** Main-only common OS mapping; never forwards exception text or arbitrary OS codes. */
export function projectReadFilesystemError(error: unknown): ProjectReadFsError {
  if (error instanceof ProjectReadFsError) return error;
  const raw = errorCode(error), osCode = ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EBUSY', 'EIO'].includes(raw ?? '') ? raw : undefined;
  const code: ProjectReadCode = osCode === 'ENOENT' ? 'PATH_NOT_FOUND' : osCode === 'EACCES' || osCode === 'EPERM' ? 'ACCESS_DENIED'
    : osCode === 'ENOTDIR' ? 'NOT_A_DIRECTORY' : osCode === 'EISDIR' ? 'NOT_A_FILE' : 'IO_ERROR';
  return new ProjectReadFsError(code, osCode);
}
export function verifyProjectReadRoot(root: ProjectReadRoot): void {
  if (!('projectId' in root)) {
    const current = inspectFilesystemPath(root.root, 'directory', root.protectedRoots);
    if (!sameProjectFolderChain(root.chain, current.chain)) fail('ROOT_CHANGED');
    return;
  }
  try { if (!sameProjectFolderChain(root.chain, inspectProjectFolderPath(root.root, true).chain)) fail('ROOT_CHANGED'); }
  catch (error) {
    if (error instanceof ProjectReadFsError) throw error;
    if (['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(errorCode(error) ?? '')) fail('ROOT_UNAVAILABLE');
    fail('ROOT_CHANGED');
  }
}
export type ProjectReadFile = Readonly<{
  absolutePath: string; relativePath: string; chain: readonly FolderIdentity[];
  dev: string; ino: string; size: number; mtimeNs: string; ctimeNs: string; fileIdentity: string;
}>;
/** Only the broker may supply this relative locator, from its signed index or persisted citation. */
export function captureProjectReadFile(root: ProjectReadRoot, relativePath: string): ProjectReadFile {
  verifyProjectReadRoot(root);
  if (typeof relativePath !== 'string' || !relativePath || Buffer.byteLength(relativePath) > PROJECT_READ_FILE_LIMITS.pathBytes) return fail('UNSUPPORTED_PATH');
  const parts = relativePath.split('/');
  const filesystem = !('projectId' in root);
  if (filesystem) {
    if (parts.some(part => !filesystemReadPartAllowed(part))) return fail('PATH_POLICY_DENIED');
    if (!filesystemTextNameAllowed(parts.at(-1)!)) return fail('UNSUPPORTED_TEXT');
  } else if (parts.some(part => !folderReadPartAllowed(part) || part.startsWith('.')) || !fileNameAllowed(parts.at(-1)!)) return fail('UNSUPPORTED_PATH');
  const absolutePath = path.join(root.root, ...parts), relative = path.relative(root.root, absolutePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return fail('UNSUPPORTED_PATH');
  let inspected: ReturnType<typeof inspectProjectFolderPath>;
  try { inspected = 'projectId' in root ? inspectProjectFolderPath(absolutePath, false) : inspectFilesystemPath(absolutePath, 'file', root.protectedRoots); }
  catch (error) { if (filesystem) throw projectReadFilesystemError(error); return fail(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(errorCode(error) ?? '') ? 'FILE_UNAVAILABLE' : 'UNSUPPORTED_PATH'); }
  if (!sameProjectFolderChain(root.chain, inspected.chain.slice(0, root.chain.length))) return fail('ROOT_CHANGED');
  const stat = inspected.stat;
  if (stat.size > BigInt(PROJECT_READ_FILE_LIMITS.fileBytes)) return fail('FILE_LIMIT');
  const dev = String(stat.dev), ino = String(stat.ino);
  return Object.freeze({ absolutePath, relativePath, chain: Object.freeze(inspected.chain.map(item => Object.freeze({ ...item }))), dev, ino, size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), fileIdentity: digest(JSON.stringify({ dev, ino })) });
}
function sameFile(file: ProjectReadFile, stat: BigIntStats): boolean {
  return stat.isFile() && stat.nlink === 1n && String(stat.dev) === file.dev && String(stat.ino) === file.ino
    && stat.size === BigInt(file.size) && String(stat.mtimeNs) === file.mtimeNs && String(stat.ctimeNs) === file.ctimeNs;
}
function verifyFilePath(root: ProjectReadRoot, file: ProjectReadFile): void {
  const filesystem = !('projectId' in root);
  const relative = path.relative(root.root, file.absolutePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || relative.split(path.sep).join('/') !== file.relativePath || Buffer.byteLength(file.relativePath) > PROJECT_READ_FILE_LIMITS.pathBytes
    || file.relativePath.split('/').some(part => filesystem ? !filesystemReadPartAllowed(part) : !folderReadPartAllowed(part) || part.startsWith('.'))
    || !(filesystem ? filesystemTextNameAllowed : fileNameAllowed)(path.basename(file.absolutePath)) || !sameProjectFolderChain(root.chain, file.chain.slice(0, root.chain.length))) fail('UNSUPPORTED_PATH');
  verifyProjectReadRoot(root);
  try {
    const value = 'projectId' in root ? inspectProjectFolderPath(file.absolutePath, false) : inspectFilesystemPath(file.absolutePath, 'file', root.protectedRoots);
    if (!sameProjectFolderChain([...file.chain], value.chain) || !sameFile(file, value.stat)) fail('SOURCE_CHANGED');
  } catch (error) {
    if (error instanceof ProjectReadFsError) throw error;
    if (filesystem) throw projectReadFilesystemError(error);
    fail(['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '') ? 'FILE_UNAVAILABLE' : 'SOURCE_CHANGED');
  }
}

/** Failed I/O retains its reserved upper bound; only confirmed returned bytes count as physical reads. */
export function createProjectReadIoBudget(maxBytes: number = PROJECT_READ_FILE_LIMITS.runBytes) {
  positive(maxBytes, PROJECT_READ_FILE_LIMITS.runBytes);
  let chargedBytes = 0, physicalReadBytes = 0, uncertainReadCalls = 0, readCalls = 0;
  return Object.freeze({
    remaining: () => maxBytes - chargedBytes,
    evidence: () => Object.freeze({ maxBytes, chargedBytes, physicalReadBytes, uncertainReadCalls, readCalls }),
    reserve(bytes: number) {
      positive(bytes, PROJECT_READ_FILE_LIMITS.chunkBytes);
      if (chargedBytes + bytes > maxBytes) return fail('BUDGET_EXCEEDED');
      chargedBytes += bytes; readCalls++; let settled = false;
      return (actual: number | null): void => {
        if (settled || actual !== null && (!Number.isSafeInteger(actual) || actual < 0 || actual > bytes)) return fail('INVALID_REQUEST');
        settled = true;
        if (actual === null) uncertainReadCalls++;
        else { physicalReadBytes += actual; chargedBytes -= bytes - actual; }
      };
    },
  });
}
export type ProjectReadIoBudget = ReturnType<typeof createProjectReadIoBudget>;
export function createProjectReadOperation(signal: AbortSignal, limits: Readonly<{ bytes?: number; timeoutMs?: number }> = {}) {
  const bytes = limits.bytes ?? PROJECT_READ_FILE_LIMITS.operationBytes, timeoutMs = limits.timeoutMs ?? PROJECT_READ_FILE_LIMITS.operationMs;
  positive(bytes, PROJECT_READ_FILE_LIMITS.operationBytes); positive(timeoutMs, PROJECT_READ_FILE_LIMITS.operationMs);
  const deadline = performance.now() + timeoutMs; let used = 0;
  return Object.freeze({
    remaining() { current(signal); return performance.now() >= deadline ? 0 : bytes - used; },
    consume(count: number) { current(signal); if (!Number.isSafeInteger(count) || count < 0 || used + count > bytes) fail('BUDGET_EXCEEDED'); used += count; },
  });
}
export type ProjectReadOperation = ReturnType<typeof createProjectReadOperation>;
export type ProjectReadTextSnapshot = Readonly<{ file: ProjectReadFile; version: string; normalizedSha256: string; source: ProjectText; workingBytes: number; rawBytes?: Uint8Array }>;
export type ProjectReadStep = Readonly<{ kind: 'pending'; pass: 1 | 2; offset: number }>
  | Readonly<{ kind: 'complete'; value: ProjectReadTextSnapshot }>;

/** Two identical bounded prefix reads for skill metadata; preserves ordinary path/handle policy. */
export async function readProjectMetadataPrefix(options: Readonly<{
  root: FolderRoot; file: ProjectReadFile; signal: AbortSignal; budget: ProjectReadIoBudget;
  operation: ProjectReadOperation; maxBytes: number;
}>): Promise<Buffer> {
  positive(options.maxBytes, 8192);
  current(options.signal); verifyFilePath(options.root, options.file);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(options.file.absolutePath, 'r'); current(options.signal);
    const passes: Buffer[] = [];
    for (let pass = 0; pass < 2; pass++) {
      if (!sameFile(options.file, await handle.stat({ bigint: true }))) return fail('SOURCE_CHANGED');
      verifyFilePath(options.root, options.file);
      const buffer = Buffer.alloc(Math.min(options.file.size, options.maxBytes));
      let offset = 0;
      while (offset < buffer.length) {
        current(options.signal);
        const count = Math.min(buffer.length - offset, options.operation.remaining(), options.budget.remaining());
        if (count <= 0) return fail('BUDGET_EXCEEDED');
        const settle = options.budget.reserve(count); options.operation.consume(count);
        let actual: number;
        try { actual = (await handle.read(buffer, offset, count, offset)).bytesRead; settle(actual); }
        catch { settle(null); return fail('IO_ERROR'); }
        if (actual <= 0) return fail('SOURCE_CHANGED');
        offset += actual;
      }
      current(options.signal);
      if (!sameFile(options.file, await handle.stat({ bigint: true }))) return fail('SOURCE_CHANGED');
      verifyFilePath(options.root, options.file); passes.push(buffer);
    }
    if (!passes[0]!.equals(passes[1]!)) return fail('SOURCE_CHANGED');
    return passes[1]!;
  } catch (error) {
    if (error instanceof ProjectReadFsError) throw error;
    return fail(options.signal.aborted ? 'CANCELLED' : 'IO_ERROR');
  } finally { if (handle) { try { await handle.close(); } catch { fail('CLEANUP_FAILED'); } } }
}

/** Two-pass reader with resumable main-only state. No bytes escape until both passes agree. */
export function createProjectTextReader(options: Readonly<{ root: ProjectReadRoot; file: ProjectReadFile; expectedVersion: string | null; signal: AbortSignal; budget: ProjectReadIoBudget; captureRaw?: boolean }>) {
  if (options.expectedVersion !== null && !/^[0-9a-f]{64}$/u.test(options.expectedVersion)) fail('INVALID_REQUEST');
  let opening: Promise<FileHandle> | undefined, handle: FileHandle | undefined, closing: Promise<void> | undefined;
  let closed = false, busy = false, pass: 1 | 2 = 1, offset = 0, firstDigest: string | undefined;
  let hash = createHash('sha256'), second: Buffer | undefined, completed: ProjectReadTextSnapshot | undefined;
  const alive = () => { current(options.signal); if (closed) fail('CANCELLED'); };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve().then(async () => {
      const owned = handle ?? await opening?.catch(() => undefined);
      await owned?.close(); options.signal.removeEventListener('abort', onAbort);
    });
    void closing.catch(() => {}); return closing;
  };
  const onAbort = () => { void close(); };
  options.signal.addEventListener('abort', onAbort, { once: true });
  return Object.freeze({
    close,
    async step(operation: ProjectReadOperation): Promise<ProjectReadStep> {
      current(options.signal); if (completed) return { kind: 'complete', value: completed };
      alive(); if (busy) return fail('BUSY'); busy = true;
      try {
        verifyFilePath(options.root, options.file); alive();
        opening ??= fs.open(options.file.absolutePath, 'r'); handle = await opening; alive();
        if (!sameFile(options.file, await handle.stat({ bigint: true }))) return fail('SOURCE_CHANGED');
        for (;;) {
          alive();
          if (operation.remaining() <= 0) return { kind: 'pending', pass, offset };
          if (offset === options.file.size) {
            if (!sameFile(options.file, await handle.stat({ bigint: true }))) return fail('SOURCE_CHANGED');
            verifyFilePath(options.root, options.file); alive();
            if (pass === 1) { firstDigest = hash.digest('hex'); pass = 2; offset = 0; hash = createHash('sha256'); second = Buffer.alloc(options.file.size); continue; }
            const version = hash.digest('hex');
            if (version !== firstDigest || options.expectedVersion !== null && options.expectedVersion !== version) return fail('SOURCE_CHANGED');
            const source = decodeProjectText(second!, { maxBytes: PROJECT_READ_FILE_LIMITS.fileBytes, maxLines: PROJECT_READ_FILE_LIMITS.lines });
            alive(); verifyFilePath(options.root, options.file);
            if (operation.remaining() <= 0) return fail('BUDGET_EXCEEDED');
            const value = Object.freeze({ file: options.file, version, normalizedSha256: digest(source.text), source, workingBytes: options.file.size + source.text.length * 2 + source.lineStarts.length * 8, ...(options.captureRaw ? { rawBytes: new Uint8Array(second!) } : {}) });
            await close(); current(options.signal); completed = value; second = undefined;
            return { kind: 'complete', value };
          }
          const count = Math.min(PROJECT_READ_FILE_LIMITS.chunkBytes, operation.remaining(), options.budget.remaining(), options.file.size - offset);
          if (count <= 0) return fail('BUDGET_EXCEEDED');
          const buffer = pass === 2 ? second! : Buffer.allocUnsafe(count), at = pass === 2 ? offset : 0;
          const settle = options.budget.reserve(count); operation.consume(count);
          let actual: number;
          try { actual = (await handle.read(buffer, at, count, offset)).bytesRead; settle(actual); }
          catch (error) { settle(null); throw error; }
          alive(); if (actual <= 0) return fail('SOURCE_CHANGED');
          hash.update(buffer.subarray(at, at + actual)); offset += actual;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      } catch (error) {
        await close().catch(() => {});
        if (error instanceof ProjectReadFsError) throw error;
        if (error instanceof ProjectTextError) return fail(error.code);
        if (options.signal.aborted) return fail('CANCELLED');
        if (!('projectId' in options.root)) throw projectReadFilesystemError(error);
        return fail('IO_ERROR');
      } finally { busy = false; }
    },
  });
}
