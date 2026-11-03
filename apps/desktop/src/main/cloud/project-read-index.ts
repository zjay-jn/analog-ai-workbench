import fs from 'node:fs/promises';
import type { Dir, Dirent } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_READ_LIMITS as L, type ProjectReadCode, type ProjectReadCoverage, type ProjectReadEntry, type ProjectReadScope, type ProjectReadToolArguments, type ProjectReadToolValue } from '../../shared/agent/agent-project-read';
import type { FileSystemSourceRef } from '../../shared/agent/agent-filesystem-read';
import { inspectFilesystemPath, resolveFilesystemPath, filesystemReadPartAllowed, filesystemTextNameAllowed } from './filesystem-read-sources';
import { fileNameAllowed } from '../../shared/agent/file-context';
import { folderReadPartAllowed, inspectProjectFolderPath, sameProjectFolderChain, type FolderRoot } from './project-folder-files';
import { captureProjectReadFile, ProjectReadFsError, verifyProjectReadRoot, type ProjectReadFile, type ProjectReadRoot, projectReadFilesystemError } from './project-read-files';

export type ProjectReadListingPage = Extract<ProjectReadToolValue, { kind: 'list' | 'find' }>;
type Page = ProjectReadListingPage;
type Reason = ProjectReadCoverage['limitReason'];
type Skip = keyof ProjectReadCoverage['skipped'];
type Stamp = Readonly<{ chain: FolderRoot['chain']; size: string; mtimeNs: string; ctimeNs: string }>;
type Node = Readonly<{ entry: ProjectReadEntry; absolutePath: string; stamp: Stamp }>;
type Item = Readonly<{ node: Node }> | Readonly<{ skipped: Skip }>;
type Directory = { id: string | null; relativePath: string; absolutePath: string; depth: number; stamp: Stamp; visited: boolean; entries: Item[]; done: boolean; unavailable?: boolean; opening?: Promise<Dir>; handle?: Dir; closing?: Promise<void> };
type Snapshot = { id: string; root: Directory; files: Map<string, Node>; directories: Map<string | null, Directory>; candidates: number; bytes: number; fault: ProjectReadIndexError | null; revoked: boolean };
type Walk = { snapshot: Snapshot; scope: ProjectReadScope; operation: 'list' | 'find' | 'candidates'; query: string; frames: { directory: Directory; offset: number }[]; head: number; scanned: number; skipped: Record<Skip, number>; complete: boolean; omitted: number; pending: Node | null; single: Node | null; reason: Reason; closed: boolean; sliceCandidates: number; sliceStarted: number };

export class ProjectReadIndexError extends ProjectReadFsError {
  constructor(code: ProjectReadCode, readonly coverage: ProjectReadCoverage | null = null, osCode?: string) { super(code, osCode); }
}
const fail = (code: ProjectReadCode, coverage: ProjectReadCoverage | null = null): never => { throw new ProjectReadIndexError(code, coverage); };
const codeOf = (error: unknown): string => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const retainedBytes = (value: unknown): number => 128 + 2 * bytes(value);
const stamp = (value: ReturnType<typeof inspectProjectFolderPath>): Stamp => Object.freeze({ chain: value.chain.map(item => Object.freeze({ ...item })), size: String(value.stat.size), mtimeNs: String(value.stat.mtimeNs), ctimeNs: String(value.stat.ctimeNs) });
const sameStamp = (a: Stamp, b: Stamp): boolean => sameProjectFolderChain(a.chain, b.chain) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
// Per-scalar lowercase avoids context-sensitive final sigma and the full İ expansion.
const simpleLower = (value: string): string => Array.from(value, point => point === '\u0130' ? 'i' : point.toLowerCase()).join('');
const checkQuery = (query: string): void => { if (typeof query !== 'string' || !query || Buffer.byteLength(query) > L.queryBytes || /[\r\n\u0000\p{Surrogate}]/u.test(query)) fail('INVALID_REQUEST'); };
const checkId = (id: string | null): void => { if (id !== null && (typeof id !== 'string' || !id || Buffer.byteLength(id) > L.idBytes || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(id))) fail('INVALID_REQUEST'); };
const yieldIo = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export type ProjectReadDirectory = Readonly<{ directoryId: string | null; relativePath: string; absolutePath: string }>;
export type ProjectReadCandidateStep = Readonly<{ kind: 'entry'; entry: ProjectReadEntry }> | Readonly<{ kind: 'slice' | 'complete'; coverage: ProjectReadCoverage }>;
export type ProjectReadCandidates = Readonly<{ snapshotId: string; scope: ProjectReadScope; next(): Promise<ProjectReadCandidateStep>; coverage(): ProjectReadCoverage; close(): Promise<void> }>;

/** Main-only authority. Construct from a host binding, never a renderer/model locator.
 * No directory operation opens a file body, including AGENTS.md. */
export function createProjectReadIndex(options: Readonly<{ root: ProjectReadRoot; identity: string; owner: Readonly<{ kind: 'run' | 'inspection'; id: string }>; signal: AbortSignal;
  source?: FileSystemSourceRef; projectId?: string; quota?: { indexBytes: number; visitedCandidates: number };
  /** Main-owned conversation policy. Inspection keeps its independent browsing limit. */
  maxRunPages?: number | null;
  measurePage?: (value: ProjectReadListingPage) => number;
}>) {
  checkId(options.identity); checkId(options.owner.id);
  if (!options.identity || !options.owner.id || !['run', 'inspection'].includes(options.owner.kind)) fail('INVALID_REQUEST');
  const maxPages=options.owner.kind==='inspection'?L.browsePages:options.maxRunPages===undefined?L.toolCalls:options.maxRunPages;
  if(maxPages!==null&&(!Number.isSafeInteger(maxPages)||maxPages<1))fail('INVALID_REQUEST');
  const maxReturnedBytes=options.owner.kind==='inspection'?L.browseReturnBytes:maxPages===null?L.runBytes:L.toolContextBytes;
  const root: ProjectReadRoot = { ...options.root, chain: options.root.chain.map(item => ({ ...item })), ...(!('projectId' in options.root) && options.root.protectedRoots ? { protectedRoots: [...options.root.protectedRoots] } : {}) };
  const source = options.source ? Object.freeze({ ...options.source }) : undefined, filesystem = !('projectId' in root);
  if (filesystem !== Boolean(source)) fail('INVALID_REQUEST');
  if (source && (source.kind !== 'windows_filesystem' || source.rootPath.toLowerCase() !== root.root.toLowerCase() || source.rootIdentity !== options.identity || !options.projectId)) fail('INVALID_REQUEST');
  if (source) { checkId(source.sourceId); checkId(options.projectId!); }
  const quota = options.quota ?? { indexBytes: 0, visitedCandidates: 0 };
  const measurePage = options.measurePage ?? ((value: Page) => bytes({ ok: true, value }));
  if (![quota.indexBytes, quota.visitedCandidates].every(value => Number.isSafeInteger(value) && value >= 0)) fail('INVALID_REQUEST');
  const inspect = (target: string, directory: boolean) => 'projectId' in root ? inspectProjectFolderPath(target, directory)
    : inspectFilesystemPath(target, directory ? 'directory' : 'file', root.protectedRoots);
  const partAllowed = (name: string) => filesystem ? filesystemReadPartAllowed(name) : folderReadPartAllowed(name) && !name.startsWith('.');
  const textNameAllowed = filesystem ? filesystemTextNameAllowed : fileNameAllowed;
  const prefix = options.owner.kind === 'run' ? 'pri-r' : 'pri-i';
  const opaque = (kind: string): string => `${prefix}-${kind}-${randomUUID()}`;
  const cursors = new Map<string, Walk>(), walkers = new Set<Walk>(), snapshots = new Set<Snapshot>();
  let snapshot: Snapshot | undefined, snapshotCount = 0, visitedCandidates = 0, pages = 0, returnedBytes = 0, busy = false, disposed = false, disposal: Promise<void> | undefined;
  const alive = (): void => { if (disposed || options.signal.aborted) fail('CANCELLED'); };
  const current = (s: Snapshot): void => { alive(); if (s.revoked || snapshot !== s) fail('CURSOR_STALE'); if (s.fault) throw s.fault; };
  const closeDirectory = (directory: Directory): Promise<void> => {
    directory.closing ??= (async () => {
      const handle = directory.handle ?? await directory.opening?.catch(() => undefined);
      if (handle) try { await handle.close(); } catch (error) { if (codeOf(error) !== 'ERR_DIR_CLOSED') fail('CLEANUP_FAILED'); }
    })();
    void directory.closing.catch(() => {}); return directory.closing;
  };
  const closeSnapshot = async (s: Snapshot): Promise<void> => {
    const results = await Promise.allSettled([...s.directories.values()].map(closeDirectory));
    if (results.some(result => result.status === 'rejected')) fail('CLEANUP_FAILED');
  };
  const poison = (s: Snapshot, code: ProjectReadCode, osCode?: string): never => { s.fault = new ProjectReadIndexError(code, null, osCode); void closeSnapshot(s).catch(() => {}); throw s.fault; };
  const chargeSnapshot = (s: Snapshot, cost: number): void => {
    if (quota.indexBytes + cost > L.indexBytes) fail('SCOPE_LIMIT');
    s.bytes += cost; quota.indexBytes += cost;
  };
  const releaseSnapshot = (s: Snapshot): void => { quota.indexBytes -= s.bytes; s.bytes = 0; for (const directory of s.directories.values()) directory.entries.length = 0; s.files.clear(); s.directories.clear(); };
  const visit = (walk: Walk): void => {
    if (quota.visitedCandidates >= (options.owner.kind === 'inspection' ? L.candidates : L.runCandidates)) scopeLimit(walk);
    walk.scanned++; visitedCandidates++; quota.visitedCandidates++; walk.sliceCandidates++;
  };
  const verify = (s: Snapshot): void => {
    current(s);
    try { verifyProjectReadRoot(root); }
    catch (error) { poison(s, error instanceof ProjectReadFsError ? error.code : 'ROOT_CHANGED', error instanceof ProjectReadFsError ? error.osCode : undefined); }
    for (const directory of s.directories.values()) {
      if (!directory.visited) continue;
      try { if (!sameStamp(directory.stamp, stamp(inspect(directory.absolutePath, true)))) poison(s, 'SNAPSHOT_CHANGED'); }
      catch (error) { if (error instanceof ProjectReadIndexError) throw error; if (filesystem && error instanceof ProjectReadFsError) poison(s, error.code, error.osCode); poison(s, 'SNAPSHOT_CHANGED'); }
    }
    current(s);
  };
  const initial = (): Snapshot => {
    alive(); if (snapshot) { current(snapshot); return snapshot; }
    if (snapshotCount >= L.snapshots) fail('SCOPE_LIMIT');
    verifyProjectReadRoot(root);
    const rootStamp = stamp(inspect(root.root, true));
    const directory: Directory = { id: source ? opaque('d') : null, relativePath: '', absolutePath: root.root, depth: 0, stamp: rootStamp, visited: true, entries: [], done: false };
    const s: Snapshot = { id: opaque('s'), root: directory, files: new Map(), directories: new Map([[null, directory]]), candidates: 0, bytes: 0, fault: null, revoked: false };
    chargeSnapshot(s, retainedBytes({ root: directory, identity: options.identity }));
    snapshot = s; snapshotCount++; snapshots.add(s); return s;
  };
  const refresh = async (): Promise<Snapshot> => {
    alive(); if (!snapshot) return initial();
    if (snapshotCount >= L.snapshots) fail('SCOPE_LIMIT');
    const old = snapshot; old.revoked = true; cursors.clear(); for (const walker of walkers) walker.closed = true; walkers.clear();
    await closeSnapshot(old); alive(); releaseSnapshot(old); snapshots.delete(old); snapshot = undefined; return initial();
  };
  const scoped = (s: Snapshot, directoryId: string | null): Directory => {
    checkId(directoryId); current(s); const directory = directoryId === s.root.id ? s.root : s.directories.get(directoryId); if (!directory) return fail('CURSOR_STALE'); return directory;
  };
  const scopeFor = (directory: Directory): ProjectReadScope => source
    ? Object.freeze({ kind: 'windows_filesystem', projectId: options.projectId!, bindingId: null, sourceId: source.sourceId, identity: source.rootIdentity, directoryId: directory.id, absoluteDirectory: directory.absolutePath, relativeDirectory: directory.relativePath })
    : Object.freeze({ projectId: (root as FolderRoot).projectId, bindingId: (root as FolderRoot).bindingId, identity: options.identity, directoryId: directory.id, relativeDirectory: directory.relativePath });
  const makeWalk = (s: Snapshot, directoryId: string | null, operation: Walk['operation'], query: string, single: Node | null = null): Walk => {
    const directory = scoped(s, directoryId), directoryScope = scopeFor(directory);
    const scope: ProjectReadScope = single && directoryScope.kind === 'windows_filesystem'
      ? Object.freeze({ ...directoryScope, directoryId: null, absoluteDirectory: single.absolutePath, relativeDirectory: single.entry.relativePath }) : directoryScope;
    const walk: Walk = { snapshot: s, scope, operation, query, frames: single ? [] : [{ directory, offset: 0 }], head: 0, scanned: 0, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, complete: false, omitted: 0, pending: null, single, reason: null, closed: false, sliceCandidates: 0, sliceStarted: performance.now() };
    const cost = retainedBytes({ scope, operation, query }) + 256;
    chargeSnapshot(s, cost);
    walkers.add(walk); return walk;
  };
  const activeWalk = (walk: Walk): void => { current(walk.snapshot); if (walk.closed) fail('CURSOR_STALE'); };
  const coverage = (walk: Walk, returned = 0, nextCursor: string | null = null, reason: Reason = walk.reason): ProjectReadCoverage => Object.freeze({
    scope: walk.scope, complete: walk.complete && walk.omitted === 0, scannedCandidates: walk.scanned, scannedFiles: 0, scannedBytes: 0, returned,
    skipped: Object.freeze({ ...walk.skipped }),
    remaining: Object.freeze({ directories: walk.single || walk.complete && !walk.omitted ? 0 : Math.min(L.directories, walk.frames.length - walk.head + walk.omitted), files: walk.complete && !walk.omitted ? 0 : walk.single ? 1 : null, position: null }),
    nextCursor, limitReason: walk.omitted ? 'scope' : walk.complete ? null : reason,
  });
  const scopeLimit = (walk: Walk): never => { walk.reason = 'scope'; return fail('SCOPE_LIMIT', coverage(walk)); };
  const charge = (walk: Walk, cost: number): void => { if (quota.indexBytes + cost > L.indexBytes) scopeLimit(walk); chargeSnapshot(walk.snapshot, cost); };
  const validateDirectory = (s: Snapshot, directory: Directory): void => {
    current(s);
    try {
      const value = stamp(inspect(directory.absolutePath, true));
      if (!sameProjectFolderChain(directory.stamp.chain, value.chain) || directory.visited && !sameStamp(directory.stamp, value)) poison(s, 'SNAPSHOT_CHANGED');
      if (!directory.visited) directory.stamp = value;
      directory.visited = true;
    } catch (error) { if (error instanceof ProjectReadIndexError) throw error; if (filesystem && error instanceof ProjectReadFsError) poison(s, error.code, error.osCode); poison(s, 'SNAPSHOT_CHANGED'); }
  };
  const inspectEntry = (walk: Walk, directory: Directory, entry: Dirent): Item => {
    const s = walk.snapshot;
    if (!partAllowed(entry.name)) return { skipped: 'policy' };
    const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
    if (Buffer.byteLength(relativePath) > L.relativePathBytes || /\p{Surrogate}/u.test(entry.name)) return { skipped: 'unsupported' };
    if (entry.isSymbolicLink()) return { skipped: 'policy' };
    if (!entry.isDirectory() && !entry.isFile()) return { skipped: 'unsupported' };
    const absolutePath = path.join(directory.absolutePath, entry.name);
    let value: ReturnType<typeof inspectProjectFolderPath>;
    try { value = inspect(absolutePath, entry.isDirectory()); }
    catch (error) { return { skipped: ['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES', 'PATH_NOT_FOUND', 'NOT_A_DIRECTORY', 'ACCESS_DENIED', 'IO_ERROR'].includes(codeOf(error)) ? 'unavailable' : 'policy' }; }
    if (!sameProjectFolderChain(root.chain, value.chain.slice(0, root.chain.length))) return poison(s, 'ROOT_CHANGED');
    if (entry.isDirectory() !== value.stat.isDirectory() || entry.isFile() !== value.stat.isFile()) return poison(s, 'SNAPSHOT_CHANGED');
    if (value.stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return { skipped: 'unsupported' };
    const isDirectory = value.stat.isDirectory(), directoryId = isDirectory ? opaque('d') : null, fileId = isDirectory ? null : opaque('f');
    const publicEntry: ProjectReadEntry = Object.freeze({ directoryId, fileId, parentId: directory.id, name: entry.name, relativePath, kind: isDirectory ? 'directory' : 'file', bytes: isDirectory ? 0 : Number(value.stat.size), readability: isDirectory ? 'directory' : !textNameAllowed(entry.name) ? 'unsupported' : value.stat.size > BigInt(L.fileBytes) ? 'file_limit' : 'readable', version: null });
    const node: Node = Object.freeze({ entry: publicEntry, absolutePath, stamp: stamp(value) });
    charge(walk, retainedBytes(node));
    if (isDirectory) {
      if (s.directories.size >= L.directories) scopeLimit(walk);
      const child: Directory = { id: directoryId, relativePath, absolutePath, depth: directory.depth + 1, stamp: node.stamp, visited: false, entries: [], done: false };
      charge(walk, retainedBytes(child)); s.directories.set(directoryId, child);
    } else s.files.set(fileId!, node);
    return { node };
  };
  const readItem = async (walk: Walk, directory: Directory, offset: number): Promise<Item | null> => {
    const s = walk.snapshot;
    if (offset < directory.entries.length) return directory.entries[offset]!;
    if (directory.done) return null;
    if (s.candidates >= L.candidates) return scopeLimit(walk);
    validateDirectory(s, directory);
    if (!directory.opening) directory.opening = fs.opendir(directory.absolutePath, { bufferSize: 1 });
    try { directory.handle = await directory.opening; } catch (error) {
      current(s);
      if (filesystem && directory === walk.frames[0]?.directory) { const failure = projectReadFilesystemError(error); return poison(s, failure.code, failure.osCode); }
      directory.unavailable = true; directory.done = true; return null;
    }
    current(s); let entry: Dirent | null;
    try { entry = await directory.handle.read(); }
    catch (error) { current(s); if (filesystem) { const failure = projectReadFilesystemError(error); return poison(s, failure.code, failure.osCode); } return poison(s, 'IO_ERROR'); }
    current(s);
    if (!entry) { validateDirectory(s, directory); directory.done = true; await closeDirectory(directory); current(s); return null; }
    s.candidates++;
    const item = inspectEntry(walk, directory, entry);
    charge(walk, 'skipped' in item ? retainedBytes(item) : 16); directory.entries.push(item); return item;
  };
  const beginSlice = (walk: Walk): void => { walk.sliceCandidates = 0; walk.sliceStarted = performance.now(); walk.reason = null; };
  const advance = async (walk: Walk): Promise<Node | null> => {
    activeWalk(walk);
    if (walk.pending) { const node = walk.pending; walk.pending = null; return node; }
    if (walk.single) {
      if (walk.complete) return null;
      if (!sameStamp(walk.single.stamp, stamp(inspect(walk.single.absolutePath, false)))) fail('SOURCE_CHANGED');
      visit(walk); walk.complete = true;
      if (walk.single.entry.readability === 'unsupported') walk.skipped.unsupported++;
      if (walk.single.entry.readability === 'file_limit') walk.skipped.fileLimit++;
      return walk.single;
    }
    while (walk.head < walk.frames.length) {
      activeWalk(walk);
      if (walk.sliceCandidates >= L.operationCandidates) { walk.reason = 'slice'; return null; }
      if (performance.now() - walk.sliceStarted >= L.operationMs) { walk.reason = 'time'; return null; }
      if (quota.visitedCandidates >= (options.owner.kind === 'inspection' ? L.candidates : L.runCandidates)) return scopeLimit(walk);
      const frame = walk.frames[walk.head]!;
      // Entries at the maximum directory depth remain visible; descending further is outside scope.
      if (frame.directory.depth > L.depth) { walk.omitted++; walk.head++; continue; }
      const indexedBefore = walk.snapshot.candidates;
      let item: Item | null;
      try { item = await readItem(walk, frame.directory, frame.offset); }
      catch (error) { if (walk.snapshot.candidates > indexedBefore) { visit(walk); } throw error; }
      activeWalk(walk);
      if (!item) { if (frame.directory.unavailable) { walk.skipped.unavailable++; walk.omitted++; } walk.head++; continue; }
      frame.offset++; visit(walk);
      if ('skipped' in item) walk.skipped[item.skipped]++;
      else {
        const node = item.node;
        if (node.entry.readability === 'unsupported') walk.skipped.unsupported++;
        if (node.entry.readability === 'file_limit') walk.skipped.fileLimit++;
        if (node.entry.kind === 'directory' && walk.operation !== 'list') {
          const child = walk.snapshot.directories.get(node.entry.directoryId)!;
          if (child.depth > L.depth) walk.omitted++;
          else { charge(walk, 128); walk.frames.push({ directory: child, offset: 0 }); }
        }
        if (walk.operation !== 'find' || simpleLower(node.entry.name).includes(simpleLower(walk.query))) { await yieldIo(); activeWalk(walk); return node; }
      }
      await yieldIo();
    }
    walk.complete = walk.omitted === 0; walk.reason = walk.omitted ? 'scope' : null;
    if (walk.omitted) scopeLimit(walk); return null;
  };
  const exclusive = async <T>(action: () => Promise<T>): Promise<T> => {
    alive(); if (busy) return fail('BUSY'); busy = true;
    try { return await action(); }
    catch (error) { if (error instanceof ProjectReadFsError) throw error; if (options.signal.aborted || disposed) return fail('CANCELLED'); if (filesystem) throw projectReadFilesystemError(error); return fail('IO_ERROR'); }
    finally { busy = false; }
  };
  const pageValue = (walk: Walk, kind: 'list' | 'find', entries: readonly ProjectReadEntry[], cursor: string | null, reason: Reason): Page => Object.freeze({ kind, phase: entries.length || walk.complete ? 'data' : 'scan', snapshotId: walk.snapshot.id, coverage: coverage(walk, entries.length, cursor, reason), entries: Object.freeze([...entries]), rules: Object.freeze([]), resume: null, ...(source ? { source } : {}) });
  const page = (operation: 'list' | 'find', args: ProjectReadToolArguments['project_list'] | ProjectReadToolArguments['project_find']): Promise<Page> => exclusive(async () => {
    const started = performance.now();
    checkId(args.directoryId); checkId(args.cursor); if (typeof args.refresh !== 'boolean' || args.refresh && (args.cursor !== null || args.directoryId !== null && (!source || args.directoryId !== snapshot?.root.id))) fail('INVALID_REQUEST');
    const query = 'query' in args ? args.query : ''; if (operation === 'find') checkQuery(query);
    if (maxPages!==null && pages>=maxPages || !Number.isSafeInteger(pages+1)) fail('BUDGET_EXCEEDED');
    const s = args.refresh ? await refresh() : initial(); verify(s);
    let walk: Walk;
    if (args.cursor !== null) {
      const existing = cursors.get(args.cursor);
      if (!existing || existing.snapshot !== s || existing.operation !== operation || existing.query !== query || existing.scope.directoryId !== scoped(s, args.directoryId).id) return fail('CURSOR_STALE');
      walk = existing; cursors.delete(args.cursor); activeWalk(walk);
    } else walk = makeWalk(s, args.refresh ? null : args.directoryId, operation, query);
    beginSlice(walk); walk.sliceStarted = started; const entries: ProjectReadEntry[] = [], nextCursor = opaque('c'); let reason: Reason = null;
    try {
      for (;;) {
        const node = await advance(walk);
        if (!node) { reason = walk.reason; break; }
        const candidate = pageValue(walk, operation, [...entries, node.entry], nextCursor, 'bytes');
        if (measurePage(candidate) > L.toolResultBytes) { walk.pending = node; reason = 'bytes'; break; }
        entries.push(node.entry);
        if (entries.length >= L.listPage) { reason = 'page'; break; }
      }
      verify(s); activeWalk(walk);
      const result = pageValue(walk, operation, entries, walk.complete ? null : nextCursor, reason);
      const resultBytes = measurePage(result);
      if (resultBytes > L.toolResultBytes || returnedBytes + resultBytes > maxReturnedBytes) {
        walk.complete = false; walk.reason = 'context'; fail('BUDGET_EXCEEDED', coverage(walk));
      }
      if (!walk.complete) cursors.set(nextCursor, walk); else { walk.closed = true; walkers.delete(walk); }
      pages++; returnedBytes += resultBytes; return result;
    } catch (error) { walk.closed = true; walkers.delete(walk); throw error; }
  });
  const captureFile = (absolutePath: string): ProjectReadEntry => {
      alive(); if (!source) fail('CAPABILITY_DENIED');
      const target = resolveFilesystemPath(absolutePath, null), relative = path.relative(root.root, target);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('UNSUPPORTED_PATH');
      const relativePath = relative.split(path.sep).join('/');
      if (Buffer.byteLength(relativePath) > L.relativePathBytes) fail('UNSUPPORTED_PATH');
      const s = initial(); verify(s);
      if (quota.visitedCandidates >= (options.owner.kind === 'inspection' ? L.candidates : L.runCandidates) || s.candidates >= L.candidates) fail('SCOPE_LIMIT');
      const value = inspect(target, false); visitedCandidates++; quota.visitedCandidates++;
      if (!sameProjectFolderChain(root.chain, value.chain.slice(0, root.chain.length))) return poison(s, 'ROOT_CHANGED');
      for (const node of s.files.values()) if (node.absolutePath.toLowerCase() === target.toLowerCase()) {
        if (!sameStamp(node.stamp, stamp(value))) fail('SOURCE_CHANGED'); return node.entry;
      }
      if (value.stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('UNSUPPORTED_TEXT');
      const parent = [...s.directories.values()].find(directory => path.dirname(target).toLowerCase() === directory.absolutePath.toLowerCase());
      const name = path.basename(target), fileId = opaque('f');
      const entry: ProjectReadEntry = Object.freeze({ fileId, directoryId: null, parentId: parent?.id ?? null, name, relativePath, kind: 'file', bytes: Number(value.stat.size), readability: !textNameAllowed(name) ? 'unsupported' : value.stat.size > BigInt(L.fileBytes) ? 'file_limit' : 'readable', version: null });
      const node: Node = Object.freeze({ entry, absolutePath: target, stamp: stamp(value) });
      chargeSnapshot(s, retainedBytes(node)); s.files.set(fileId, node); s.candidates++; return entry;
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true; cursors.clear(); for (const walk of walkers) walk.closed = true; walkers.clear();
    disposal = (async () => { const results = await Promise.allSettled([...snapshots].map(closeSnapshot)); options.signal.removeEventListener('abort', onAbort); if (results.some(result => result.status === 'rejected')) fail('CLEANUP_FAILED'); for (const saved of snapshots) releaseSnapshot(saved); snapshots.clear(); })();
    void disposal.catch(() => {}); return disposal;
  };
  const onAbort = (): void => { void dispose(); };
  options.signal.addEventListener('abort', onAbort, { once: true });
  return Object.freeze({
    snapshotId: (): string => initial().id,
    scope(directoryId: string | null = null): ProjectReadScope { const s = initial(); verify(s); return scopeFor(scoped(s, directoryId)); },
    captureFile(absolutePath: string): ProjectReadEntry {
      alive(); if (busy) fail('BUSY'); return captureFile(absolutePath);
    },
    refreshFile(target: { fileId: string } | { absolutePath: string }): Promise<ProjectReadEntry> {
      return exclusive(async () => {
        if (!source) fail('CAPABILITY_DENIED');
        if (!target || typeof target !== 'object' || Object.keys(target).length !== 1) fail('INVALID_REQUEST');
        let absolutePath: string;
        if ('fileId' in target) {
          checkId(target.fileId);
          const node = snapshot && !snapshot.revoked ? snapshot.files.get(target.fileId) : undefined;
          if (!node) return fail('CURSOR_STALE');
          // Explicit refresh uses the issued locator even when the old file's metadata changed.
          absolutePath = node.absolutePath;
        } else if ('absolutePath' in target) {
          absolutePath = resolveFilesystemPath(target.absolutePath, null);
          const relative = path.relative(root.root, absolutePath);
          if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('UNSUPPORTED_PATH');
        } else return fail('INVALID_REQUEST');
        await refresh();
        return captureFile(absolutePath);
      });
    },
    list: (args: ProjectReadToolArguments['project_list']): Promise<Page> => page('list', args),
    find: (args: ProjectReadToolArguments['project_find']): Promise<Page> => page('find', args),
    resolveDirectory(directoryId: string | null): ProjectReadDirectory {
      const s = initial(); verify(s); const directory = scoped(s, directoryId); validateDirectory(s, directory);
      return Object.freeze({ directoryId, relativePath: directory.relativePath, absolutePath: directory.absolutePath });
    },
    resolveFile(fileId: string): ProjectReadFile {
      checkId(fileId); const s = initial(); verify(s); const node = s.files.get(fileId); if (!node) return fail('CURSOR_STALE');
      if (node.entry.readability === 'unsupported') return fail('UNSUPPORTED_TEXT'); if (node.entry.readability === 'file_limit') return fail('FILE_LIMIT');
      const file = captureProjectReadFile(root, node.entry.relativePath);
      if (!sameProjectFolderChain(node.stamp.chain, [...file.chain]) || node.stamp.size !== String(file.size) || node.stamp.mtimeNs !== file.mtimeNs || node.stamp.ctimeNs !== file.ctimeNs) return fail('SOURCE_CHANGED');
      return file;
    },
    candidates(args: Readonly<{ directoryId: string | null; query: string; refresh: boolean; fileId?: string | null }>): Promise<ProjectReadCandidates> {
      return exclusive(async () => {
        checkId(args.directoryId); checkQuery(args.query); if (typeof args.refresh !== 'boolean' || args.refresh && args.directoryId !== null && (!source || args.directoryId !== snapshot?.root.id)) fail('INVALID_REQUEST');
        const fileId = args.fileId ?? null; checkId(fileId);
        if (fileId !== null && (!source || args.directoryId !== null || args.refresh)) fail('INVALID_REQUEST');
        const s = args.refresh ? await refresh() : initial(); verify(s);
        const single = fileId === null ? null : s.files.get(fileId); if (fileId !== null && !single) fail('CURSOR_STALE');
        const walk = makeWalk(s, args.refresh ? null : args.directoryId, 'candidates', args.query, single ?? null); beginSlice(walk);
        return Object.freeze({ snapshotId: s.id, scope: walk.scope,
          next: (): Promise<ProjectReadCandidateStep> => exclusive(async () => {
            activeWalk(walk); verify(s); const node = await advance(walk); verify(s); activeWalk(walk);
            if (node) return Object.freeze({ kind: 'entry', entry: node.entry });
            const value = coverage(walk); if (!walk.complete) beginSlice(walk);
            return Object.freeze({ kind: walk.complete ? 'complete' : 'slice', coverage: value });
          }),
          coverage: (): ProjectReadCoverage => { activeWalk(walk); return coverage(walk); },
          close: async (): Promise<void> => { walk.closed = true; walkers.delete(walk); },
        });
      });
    },
    accounting: () => Object.freeze({ visitedCandidates, indexedCandidates: snapshot?.candidates ?? 0, indexBytes: snapshot?.bytes ?? 0, pages, returnedBytes }),
    dispose,
  });
}
export type ProjectReadIndex = ReturnType<typeof createProjectReadIndex>;
