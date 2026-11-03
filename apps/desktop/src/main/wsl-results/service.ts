import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { WSL_RESULTS_VERSION, WSL_RESULTS_LIMITS as L, parseWslResultsBinding, parseWslResultsSelection, parseWslResultsToolArguments, parseWslResultsToolValue, type WslResultsBinding, type WslResultsCode, type WslResultsSelection, type WslResultsEntry, type WslResultsToolArguments, type WslResultsListValue, type WslResultsReadValue } from '../../shared/agent/wsl-results';
import { createWslResultsTransport, WslResultsError, type WslResultsTransport, type WslReaderRequest } from './transport';
export { WslResultsError } from './transport';
const makeId = (): string => 'wsl-' + randomUUID();
const hash = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
const statVersion = (v: unknown): v is string => typeof v === 'string' && /^\d+:\d+:\d+:\d+:\d+$/u.test(v);
const compareNames = (a: string, b: string): number => {
  const left = Array.from(a), right = Array.from(b);
  for (let n = 0; n < Math.min(left.length, right.length); n++) { const diff = left[n]!.codePointAt(0)! - right[n]!.codePointAt(0)!; if (diff) return diff; }
  return left.length - right.length;
};
const fail = (code: WslResultsCode): never => { throw new WslResultsError(code); };
const readerCodes: readonly WslResultsCode[] = ['INVALID_REQUEST', 'CAPABILITY_DENIED', 'ROOT_CHANGED', 'FILE_UNAVAILABLE', 'SOURCE_CHANGED', 'CURSOR_STALE', 'UNSUPPORTED_PATH', 'UNSUPPORTED_ENCODING', 'UNSUPPORTED_TEXT', 'FILE_LIMIT', 'SCOPE_LIMIT'];
type FileRef = { binding: WslResultsBinding; relativePath: string; version: string; bytes: number; rawSha256: string | null };
type Cursor = { binding: WslResultsBinding; directory: string; query: string; afterName: string; directoryVersion: string };
/** One instance per run limits file/cursor capability lifetime; settings selection may use a separate instance. */
export function createWslResultsService(options: Readonly<{ transport?: WslResultsTransport }> = {}) {
  const transport = options.transport ?? createWslResultsTransport(), files = new Map<string, FileRef>(), cursors = new Map<string, Cursor>();
  let busy = false, closed = false, cleanupFailed = false, active: Promise<unknown> | null = null;
  const shutdown = new AbortController();
  const alive = (signal: AbortSignal): void => { if (closed || signal.aborted) fail('CANCELLED'); };
  const binding = (v: unknown): WslResultsBinding => parseWslResultsBinding(v) ?? fail('INVALID_REQUEST');
  async function call(selected: WslResultsSelection, rootIdentity: string | null, operation: WslReaderRequest['operation'], args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    alive(signal); if (busy) fail('BUSY'); busy = true;
    try {
      active = transport.execute({ distro: selected.distro, user: selected.user, rootPath: selected.rootPath, readerVersion: WSL_RESULTS_VERSION, rootIdentity, operation, arguments: args }, AbortSignal.any([signal, shutdown.signal]));
      const input = await active; alive(signal);
      if (!object(input) || input.readerVersion !== WSL_RESULTS_VERSION) return fail('ENGINE_FAILED');
      if (input.ok === false) { if (!exact(input, ['ok', 'readerVersion', 'error']) || !readerCodes.includes(input.error as WslResultsCode)) return fail('ENGINE_FAILED'); return fail(input.error as WslResultsCode); }
      if (input.ok !== true || !exact(input, ['ok', 'readerVersion', 'value']) || !object(input.value) || input.value.operation !== operation || typeof input.value.rootIdentity !== 'string' || !/^\d+:\d+$/u.test(input.value.rootIdentity)) return fail('ENGINE_FAILED');
      if (rootIdentity !== null && input.value.rootIdentity !== rootIdentity) return fail('ROOT_CHANGED');
      return input.value;
    } catch (error) { if (error instanceof WslResultsError && error.code === 'CLEANUP_FAILED') cleanupFailed = true; throw error; }
    finally { busy = false; active = null; }
  }
  return {
    restoreBinding(input: unknown): WslResultsBinding { return binding(input); },
    async select(input: WslResultsSelection, signal: AbortSignal): Promise<WslResultsBinding> {
      const selected = parseWslResultsSelection(input) ?? fail('INVALID_REQUEST');
      const result = await call(selected, null, 'select', {}, signal);
      if (!exact(result, ['operation', 'rootIdentity', 'physicalReadBytes', 'scannedCandidates']) || result.physicalReadBytes !== 0 || result.scannedCandidates !== 0) return fail('ENGINE_FAILED');
      return binding({ ...selected, id: makeId(), rootIdentity: result.rootIdentity, readerVersion: WSL_RESULTS_VERSION, selectedAt: new Date().toISOString() });
    },
    async list(input: WslResultsBinding, rawArgs: WslResultsToolArguments['wsl_results_list'], signal: AbortSignal): Promise<WslResultsListValue> {
      const selected = binding(input), args = parseWslResultsToolArguments('wsl_results_list', rawArgs) ?? fail('INVALID_REQUEST');
      if (args.bindingId !== selected.id) return fail('CAPABILITY_DENIED');
      const prior = args.cursor === null ? null : cursors.get(args.cursor) ?? fail('CURSOR_STALE');
      if (prior && (!isDeepStrictEqual(prior.binding, selected) || prior.directory !== args.relativeDirectory || prior.query !== args.nameQuery)) return fail('CURSOR_STALE');
      const raw = await call(selected, selected.rootIdentity, 'list', { relativeDirectory: args.relativeDirectory, nameQuery: args.nameQuery, afterName: prior?.afterName ?? null, directoryVersion: prior?.directoryVersion ?? null }, signal);
      if (!exact(raw, ['operation', 'rootIdentity', 'directoryVersion', 'entries', 'hasMore', 'physicalReadBytes', 'scannedCandidates']) || !statVersion(raw.directoryVersion) || !Array.isArray(raw.entries) || raw.entries.length > L.listEntries || typeof raw.hasMore !== 'boolean') return fail('ENGINE_FAILED');
      const nextId = makeId(), pending: { id: string; file: FileRef }[] = [];
      const result: WslResultsListValue = { kind: 'wsl_results_list', binding: selected, relativeDirectory: args.relativeDirectory, entries: [], nextCursor: raw.hasMore ? nextId : null, complete: !raw.hasMore, scannedCandidates: raw.scannedCandidates as number, physicalReadBytes: raw.physicalReadBytes as number };
      const all: WslResultsEntry[] = [];
      for (const inputEntry of raw.entries) {
        if (!object(inputEntry) || !exact(inputEntry, ['name', 'relativePath', 'kind', 'readability', 'bytes', 'version'])) return fail('ENGINE_FAILED');
        const fileId = inputEntry.readability === 'text_result' ? makeId() : null;
        all.push({ ...inputEntry, fileId } as WslResultsEntry);
      }
      // Validate every row, including a row dropped when shrinking a long-path page.
      let lastName = prior?.afterName ?? null;
      for (const entry of all) {
        if (!parseWslResultsToolValue({ ...result, entries: [entry] }) || lastName !== null && compareNames(entry.name, lastName) <= 0 || !entry.name.includes(args.nameQuery)) return fail('ENGINE_FAILED');
        lastName = entry.name;
      }
      let entries = all;
      while (entries.length && Buffer.byteLength(JSON.stringify({ ...result, entries })) > L.toolResultBytes) entries = entries.slice(0, -1);
      if (!entries.length && all.length) return fail('BUDGET_EXCEEDED');
      const more = raw.hasMore || entries.length < all.length;
      const final = parseWslResultsToolValue({ ...result, entries, nextCursor: more ? nextId : null, complete: !more });
      if (!final || final.kind !== 'wsl_results_list' || more && !entries.length) return fail('ENGINE_FAILED');
      for (const entry of entries) if (entry.fileId && entry.version) pending.push({ id: entry.fileId, file: { binding: selected, relativePath: entry.relativePath, version: entry.version, bytes: entry.bytes, rawSha256: null } });
      if (files.size + pending.length > L.directoryCandidates || cursors.size >= 128) return fail('BUDGET_EXCEEDED');
      alive(signal); for (const item of pending) files.set(item.id, item.file);
      if (more) cursors.set(nextId, { binding: selected, directory: args.relativeDirectory, query: args.nameQuery, afterName: entries.at(-1)!.name, directoryVersion: raw.directoryVersion });
      if (args.cursor) cursors.delete(args.cursor);
      return final;
    },
    async read(input: WslResultsBinding, rawArgs: WslResultsToolArguments['wsl_results_read'], signal: AbortSignal): Promise<WslResultsReadValue> {
      const selected = binding(input), args = parseWslResultsToolArguments('wsl_results_read', rawArgs) ?? fail('INVALID_REQUEST');
      if (args.bindingId !== selected.id) return fail('CAPABILITY_DENIED');
      const file = files.get(args.fileId) ?? fail('FILE_UNAVAILABLE');
      if (!isDeepStrictEqual(file.binding, selected)) return fail('CAPABILITY_DENIED');
      if (args.version !== file.version) return fail('SOURCE_CHANGED');
      const raw = await call(selected, selected.rootIdentity, 'read', { relativePath: file.relativePath, version: file.version, rawSha256: file.rawSha256, startLine: args.startLine, maxLines: args.maxLines }, signal);
      if (!exact(raw, ['operation', 'rootIdentity', 'fileIdentity', 'version', 'rawSha256', 'excerptSha256', 'startLine', 'endLine', 'totalLines', 'fileBytes', 'text', 'nextLine', 'physicalReadBytes', 'scannedCandidates'])) return fail('ENGINE_FAILED');
      const { operation: _op, rootIdentity: _root, ...data } = raw;
      const result = parseWslResultsToolValue({ ...data, kind: 'wsl_results_read', source: { ...selected, relativePath: file.relativePath, absolutePath: selected.rootPath + '/' + file.relativePath }, fileId: args.fileId, citationId: makeId(), complete: raw.nextLine === null });
      if (!result || result.kind !== 'wsl_results_read' || result.version !== file.version || result.fileBytes !== file.bytes || result.startLine !== args.startLine || result.endLine - result.startLine + 1 > args.maxLines || result.excerptSha256 !== hash(result.text) || file.rawSha256 !== null && result.rawSha256 !== file.rawSha256) return fail('SOURCE_CHANGED');
      alive(signal); file.rawSha256 = result.rawSha256; return result;
    },
    async close(): Promise<void> {
      closed = true; shutdown.abort(); files.clear(); cursors.clear();
      const pending = active; if (pending) { try { await pending; } catch (error) { if (error instanceof WslResultsError && error.code === 'CLEANUP_FAILED') throw error; } }
      if (cleanupFailed) throw new WslResultsError('CLEANUP_FAILED');
    },
  };
}
export type WslResultsService = ReturnType<typeof createWslResultsService>;
