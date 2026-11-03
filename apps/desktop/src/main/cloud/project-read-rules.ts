import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileSystemSourceRef } from '../../shared/agent/agent-filesystem-read';
import { inspectFilesystemPath } from './filesystem-read-sources';
import { PROJECT_READ_LIMITS, type ProjectReadRule, type ProjectReadRuleChunk } from '../../shared/agent/agent-project-read';
import { inspectProjectFolderPath, sameProjectFolderChain, type FolderIdentity } from './project-folder-files';
import { captureProjectReadFile, createProjectTextReader, ProjectReadFsError, verifyProjectReadRoot, type ProjectReadFile, type ProjectReadIoBudget, type ProjectReadOperation, type ProjectReadRoot, projectReadFilesystemError } from './project-read-files';

type StoredRule = Readonly<{ ruleId: string; rule: ProjectReadRule; rawBytes: number }>;
const fail = (code: ConstructorParameters<typeof ProjectReadFsError>[0]): never => { throw new ProjectReadFsError(code); };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');
const codeOf = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

/** Rules are complete, verified records before publication; ordinary markdown is never promoted. */
export function createProjectReadRules(options: Readonly<{
  root: ProjectReadRoot; source?: FileSystemSourceRef; signal: AbortSignal; budget: ProjectReadIoBudget;
  publish: (rule: ProjectReadRule) => Promise<void>;
}>) {
  const records = new Map<string, StoredRule>();
  const sourceRef = options.source ? Object.freeze({ ...options.source }) : undefined, filesystem = !('projectId' in options.root);
  if (filesystem !== Boolean(sourceRef) || sourceRef && sourceRef.rootPath.toLowerCase() !== options.root.root.toLowerCase()) fail('INVALID_REQUEST');
  const sourceFields = sourceRef ? { sourceRef } : {};
  const recordKey = (source: string) => sourceRef ? sourceRef.sourceId + ':' + source : source;
  const inspectDirectory = (target: string) => 'projectId' in options.root ? inspectProjectFolderPath(target, true)
    : inspectFilesystemPath(target, 'directory', options.root.protectedRoots);
  let loadedCount = 0, loadedRawBytes = 0, closed = false, busy = false;
  const readers = new Set<ReturnType<typeof createProjectTextReader>>();
  const alive = () => { if (closed || options.signal.aborted) fail('CANCELLED'); };
  function verifyDirectory(relativeDirectory: string, expected: readonly FolderIdentity[]) {
    alive(); verifyProjectReadRoot(options.root);
    try {
      const actual = inspectDirectory(path.join(options.root.root, ...relativeDirectory.split('/').filter(Boolean)));
      if (!sameProjectFolderChain([...expected], actual.chain)) fail('SOURCE_CHANGED');
    } catch (error) { if (error instanceof ProjectReadFsError) throw error; fail('RULES_UNAVAILABLE'); }
  }
  async function load(relativeDirectory: string, expected: readonly FolderIdentity[], operation: ProjectReadOperation): Promise<StoredRule> {
    verifyDirectory(relativeDirectory, expected);
    if (operation.remaining() <= 0) return fail('BUDGET_EXCEEDED');
    const source = relativeDirectory ? relativeDirectory + '/AGENTS.md' : 'AGENTS.md';
    if (byteLength(source) > PROJECT_READ_LIMITS.relativePathBytes) return fail('RULES_UNAVAILABLE');
    let absent = false;
    try {
      const target = path.join(options.root.root, ...source.split('/'));
      if ('projectId' in options.root) await fs.lstat(target);
      else inspectFilesystemPath(target, 'file', options.root.protectedRoots);
    } catch (error) {
      if (codeOf(error) === 'ENOENT' || filesystem && codeOf(error) === 'PATH_NOT_FOUND') absent = true;
      else if (filesystem) throw projectReadFilesystemError(error);
      else return fail('RULES_UNAVAILABLE');
    }
    alive(); verifyDirectory(relativeDirectory, expected);
    let rule: ProjectReadRule, rawBytes = 0;
    if (absent) rule = Object.freeze({ ...sourceFields, source, relativeDirectory, state: 'absent', version: null, normalizedSha256: null, text: null });
    else {
      let file: ProjectReadFile;
      try { file = captureProjectReadFile(options.root, source); }
      catch (error) { if (filesystem) throw projectReadFilesystemError(error); return fail('RULES_UNAVAILABLE'); }
      if (file.size > PROJECT_READ_LIMITS.ruleBytes) return fail('RULES_LIMIT');
      rawBytes = file.size;
      if (!records.has(recordKey(source)) && (loadedCount >= PROJECT_READ_LIMITS.rules || loadedRawBytes + rawBytes > PROJECT_READ_LIMITS.rulesBytes)) return fail('RULES_LIMIT');
      // Reserve space for both passes before opening, leaving an accurate retry point to the broker.
      if (operation.remaining() < rawBytes * 2 || options.budget.remaining() < rawBytes * 2) return fail('BUDGET_EXCEEDED');
      const reader = createProjectTextReader({ root: options.root, file, expectedVersion: null, signal: options.signal, budget: options.budget });
      readers.add(reader);
      try {
        const result = await reader.step(operation); alive();
        if (result.kind !== 'complete') return fail('BUDGET_EXCEEDED');
        rule = Object.freeze({ ...sourceFields, source, relativeDirectory, state: 'loaded', version: result.value.version, normalizedSha256: result.value.normalizedSha256, text: result.value.source.text });
      } catch (error) {
        if (error instanceof ProjectReadFsError && (filesystem || ['CANCELLED', 'BUDGET_EXCEEDED', 'SOURCE_CHANGED'].includes(error.code))) throw error;
        return fail('RULES_UNAVAILABLE');
      } finally { await reader.close(); readers.delete(reader); }
    }
    verifyDirectory(relativeDirectory, expected); alive();
    const previous = records.get(recordKey(source));
    if (previous) { if (!same(previous.rule, rule)) return fail('SOURCE_CHANGED'); return previous; }
    if (records.size >= PROJECT_READ_LIMITS.directories) return fail('RULES_LIMIT');
    // Publication owns the durable boundary. A rejected callback never makes a rule available.
    try { await options.publish(rule); } catch { return fail('STORAGE_FAILED'); }
    alive();
    const stored = Object.freeze({ ruleId: randomUUID(), rule, rawBytes }); records.set(recordKey(source), stored);
    if (rule.state === 'loaded') { loadedCount++; loadedRawBytes += rawBytes; }
    return stored;
  }
  async function run<T>(work: () => Promise<T>): Promise<T> {
    alive(); if (busy) return fail('BUSY'); busy = true;
    try { return await work(); } finally { busy = false; }
  }
  let shutdown: Promise<void> | undefined;
  return Object.freeze({
    loadRoot(operation: ProjectReadOperation) { return run(() => load('', options.root.chain, operation)); },
    forDirectory(relativeDirectory: string, operation: ProjectReadOperation) {
      return run(async () => {
        if (typeof relativeDirectory !== 'string' || relativeDirectory.includes('\\') || relativeDirectory.startsWith('/') || relativeDirectory.split('/').some(part => part === '.' || part === '..' || !part && relativeDirectory !== '') || byteLength(relativeDirectory) > PROJECT_READ_LIMITS.relativePathBytes) return fail('UNSUPPORTED_PATH');
        verifyProjectReadRoot(options.root);
        const directory = inspectDirectory(path.join(options.root.root, ...relativeDirectory.split('/').filter(Boolean)));
        if (!sameProjectFolderChain(directory.chain.slice(0, options.root.chain.length), options.root.chain)) return fail('ROOT_CHANGED');
        return load(relativeDirectory, directory.chain, operation);
      });
    },
    forFile(file: ProjectReadFile, operation: ProjectReadOperation) {
      return run(async () => {
        const actual = captureProjectReadFile(options.root, file.relativePath);
        if (!same(actual, file)) return fail('SOURCE_CHANGED');
        const directoryParts = file.relativePath.split('/').slice(0, -1), result: StoredRule[] = [];
        for (let depth = 0; depth <= directoryParts.length; depth++) {
          result.push(await load(directoryParts.slice(0, depth).join('/'), file.chain.slice(0, options.root.chain.length + depth), operation));
        }
        return Object.freeze(result);
      });
    },
    evidence: () => Object.freeze({ loadedCount, loadedRawBytes, observedSources: records.size }),
    confirmed(source: string): StoredRule | null { alive(); return records.get(recordKey(source)) ?? null; },
    close(): Promise<void> {
      if (shutdown) return shutdown; closed = true;
      shutdown = Promise.all([...readers].map(reader => reader.close())).then(() => { records.clear(); });
      void shutdown.catch(() => {}); return shutdown;
    },
  });
}

/** Pure chunk construction. The broker commits offsets only after its complete result is durable. */
export function projectReadRuleChunk(input: Readonly<{
  ruleId: string; rule: ProjectReadRule; offsetBytes: number;
  fits: (chunk: ProjectReadRuleChunk) => boolean;
}>): ProjectReadRuleChunk {
  const { rule, ruleId, offsetBytes, fits } = input;
  if (rule.state !== 'loaded' || rule.text === null || rule.version === null || rule.normalizedSha256 === null
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(ruleId)
    || !/^[0-9a-f]{64}$/u.test(rule.version) || !/^[0-9a-f]{64}$/u.test(rule.normalizedSha256)) return fail('INVALID_REQUEST');
  const bytes = Buffer.from(rule.text, 'utf8');
  if (bytes.length > PROJECT_READ_LIMITS.ruleBytes || !Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > bytes.length
    || offsetBytes < bytes.length && (bytes[offsetBytes]! & 0xc0) === 0x80) return fail('INVALID_REQUEST');
  let length = Math.min(PROJECT_READ_LIMITS.ruleChunkBytes, bytes.length - offsetBytes);
  for (;;) {
    let endBytes = offsetBytes + length;
    while (endBytes > offsetBytes && endBytes < bytes.length && (bytes[endBytes]! & 0xc0) === 0x80) endBytes--;
    const chunk: ProjectReadRuleChunk = Object.freeze({ ruleId, source: rule.source, relativeDirectory: rule.relativeDirectory, ...(rule.sourceRef ? { sourceRef: rule.sourceRef } : {}),
      version: rule.version, normalizedSha256: rule.normalizedSha256, offsetBytes, endBytes, totalBytes: bytes.length,
      text: bytes.subarray(offsetBytes, endBytes).toString('utf8'), complete: endBytes === bytes.length });
    if ((endBytes > offsetBytes || bytes.length === 0) && fits(chunk)) return chunk;
    if (length <= 4) return fail('BUDGET_EXCEEDED');
    length = Math.max(4, Math.floor(length / 2));
  }
}
