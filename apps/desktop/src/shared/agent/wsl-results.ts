/** Only the explicitly admitted experimental WSL environment is available. */
export const WSL_RESULTS_VERSION = 'aaw.wsl-results.v1' as const;
export const WSL_RESULTS_ENVIRONMENT = Object.freeze({ distro: 'ROCKY9_LLM_LAB', user: 'maxwell' } as const);
export const WSL_RESULTS_LIMITS = Object.freeze({ pathBytes: 1024, fileBytes: 4 * 1024 * 1024, pageBytes: 4096, pageLines: 200, listEntries: 24, directoryCandidates: 2000, toolResultBytes: 12288, transportBytes: 128 * 1024, requestBytes: 8192, timeoutMs: 10000, maxBindings: 64 });
export type WslResultsCode = 'INVALID_REQUEST' | 'CAPABILITY_DENIED' | 'NOT_BOUND' | 'ROOT_UNAVAILABLE' | 'ROOT_CHANGED' | 'FILE_UNAVAILABLE' | 'SOURCE_CHANGED' | 'CURSOR_STALE' | 'UNSUPPORTED_PATH' | 'UNSUPPORTED_ENCODING' | 'UNSUPPORTED_TEXT' | 'FILE_LIMIT' | 'SCOPE_LIMIT' | 'BUDGET_EXCEEDED' | 'CANCELLED' | 'BUSY' | 'STORAGE_FAILED' | 'ENGINE_FAILED' | 'CLEANUP_FAILED' | 'IO_ERROR';
export type WslResultsSelection = Readonly<{ distro: 'ROCKY9_LLM_LAB'; user: 'maxwell'; rootPath: string }>;
export type WslResultsBinding = WslResultsSelection & Readonly<{ id: string; rootIdentity: string; readerVersion: typeof WSL_RESULTS_VERSION; selectedAt: string }>;
export type WslResultsSource = WslResultsBinding & Readonly<{ relativePath: string; absolutePath: string }>;
export type WslResultsEntry = Readonly<{ name: string; relativePath: string; kind: 'directory' | 'file'; readability: 'directory' | 'text_result' | 'binary_result' | 'unsupported' | 'file_limit'; bytes: number; fileId: string | null; version: string | null }>;
export type WslResultsToolArguments = {
  wsl_results_list: Readonly<{ bindingId: string; relativeDirectory: string; nameQuery: string; cursor: string | null }>;
  wsl_results_read: Readonly<{ bindingId: string; fileId: string; version: string; startLine: number; maxLines: number }>;
};
export type WslResultsToolName = keyof WslResultsToolArguments;
export type WslResultsListValue = Readonly<{ kind: 'wsl_results_list'; binding: WslResultsBinding; relativeDirectory: string; entries: readonly WslResultsEntry[]; nextCursor: string | null; complete: boolean; scannedCandidates: number; physicalReadBytes: number }>;
export type WslResultsReadValue = Readonly<{ kind: 'wsl_results_read'; source: WslResultsSource; fileId: string; fileIdentity: string; version: string; rawSha256: string; excerptSha256: string; startLine: number; endLine: number; totalLines: number; fileBytes: number; text: string; nextLine: number | null; complete: boolean; citationId: string; physicalReadBytes: number; scannedCandidates: number }>;
export type WslResultsToolValue = WslResultsListValue | WslResultsReadValue;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const size = (v: string): number => new TextEncoder().encode(v).byteLength;
const string = (v: unknown, n: number, empty = false): v is string => typeof v === 'string' && (empty || v.length > 0) && size(v) <= n && !/[\u0000-\u001f\u007f-\u009f]/u.test(v) && !/[\ud800-\udfff]/u.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''));
const exact = (v: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
const int = (v: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): v is number => Number.isSafeInteger(v) && !Object.is(v, -0) && (v as number) >= min && (v as number) <= max;
const id = (v: unknown): v is string => typeof v === 'string' && /^wsl-[a-z0-9-]{1,100}$/u.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const identity = (v: unknown): v is string => typeof v === 'string' && /^\d+:\d+$/u.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^\d+:\d+:\d+:\d+:\d+$/u.test(v);
export function isWslResultsRelativePath(v: unknown, empty = false): v is string {
  return string(v, WSL_RESULTS_LIMITS.pathBytes, empty) && (v === '' && empty || !v.startsWith('/') && !v.includes('\\') && v.split('/').every(p => p !== '.' && p !== '..' && size(p) <= 255 && p.length > 0 && !p.startsWith('.')));
}
export function parseWslResultsSelection(v: unknown): WslResultsSelection | null {
  if (!record(v) || !exact(v, ['distro', 'user', 'rootPath']) || v.distro !== WSL_RESULTS_ENVIRONMENT.distro || v.user !== WSL_RESULTS_ENVIRONMENT.user || !string(v.rootPath, WSL_RESULTS_LIMITS.pathBytes)) return null;
  const path = v.rootPath;
  if (!/^\/home\/maxwell\/(?:simulation\/|virtuoso_workspace[A-Za-z0-9_-]*\/_codex_runs\/)[^/]+(?:\/[^/]+)*$/u.test(path) || !isWslResultsRelativePath(path.slice(1)) || path.split('/').some(p => /^(?:PDK|models?|licenses?|credentials?|secrets?|\.ssh)$/iu.test(p))) return null;
  return Object.freeze({ distro: v.distro, user: v.user, rootPath: path });
}
export function parseWslResultsBinding(v: unknown): WslResultsBinding | null {
  if (!record(v) || !exact(v, ['distro', 'user', 'rootPath', 'id', 'rootIdentity', 'readerVersion', 'selectedAt'])) return null;
  const selected = parseWslResultsSelection({ distro: v.distro, user: v.user, rootPath: v.rootPath });
  if (!selected || !id(v.id) || !identity(v.rootIdentity) || v.readerVersion !== WSL_RESULTS_VERSION || typeof v.selectedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v.selectedAt) || !Number.isFinite(Date.parse(v.selectedAt))) return null;
  return Object.freeze({ ...selected, id: v.id, rootIdentity: v.rootIdentity, readerVersion: v.readerVersion, selectedAt: v.selectedAt });
}
export const isWslResultsToolName = (v: unknown): v is WslResultsToolName => v === 'wsl_results_list' || v === 'wsl_results_read';
export function parseWslResultsToolArguments<K extends WslResultsToolName>(name: K, v: unknown): WslResultsToolArguments[K] | null {
  if (!record(v) || !id(v.bindingId)) return null;
  if (name === 'wsl_results_list' && exact(v, ['bindingId', 'relativeDirectory', 'nameQuery', 'cursor']) && isWslResultsRelativePath(v.relativeDirectory, true) && string(v.nameQuery, 128, true) && (v.cursor === null || id(v.cursor))) return Object.freeze({ ...v }) as WslResultsToolArguments[K];
  if (name === 'wsl_results_read' && exact(v, ['bindingId', 'fileId', 'version', 'startLine', 'maxLines']) && id(v.fileId) && version(v.version) && int(v.startLine, 500000, 1) && int(v.maxLines, WSL_RESULTS_LIMITS.pageLines, 1)) return Object.freeze({ ...v }) as WslResultsToolArguments[K];
  return null;
}
export function parseWslResultsToolValue(v: unknown): WslResultsToolValue | null {
  let serialized: string;
  try { serialized = JSON.stringify(v); if (size(serialized) > WSL_RESULTS_LIMITS.toolResultBytes) return null; v = JSON.parse(serialized); } catch { return null; }
  if (!record(v) || !int(v.physicalReadBytes, WSL_RESULTS_LIMITS.fileBytes) || !int(v.scannedCandidates, WSL_RESULTS_LIMITS.directoryCandidates)) return null;
  if (v.kind === 'wsl_results_list') {
    if (!exact(v, ['kind', 'binding', 'relativeDirectory', 'entries', 'nextCursor', 'complete', 'scannedCandidates', 'physicalReadBytes']) || !parseWslResultsBinding(v.binding) || !isWslResultsRelativePath(v.relativeDirectory, true) || !Array.isArray(v.entries) || v.entries.length > WSL_RESULTS_LIMITS.listEntries || typeof v.complete !== 'boolean' || (v.nextCursor !== null && !id(v.nextCursor)) || v.complete !== (v.nextCursor === null) || v.physicalReadBytes !== 0) return null;
    const seen = new Set<string>();
    for (const e of v.entries) {
      if (!record(e) || !exact(e, ['name', 'relativePath', 'kind', 'readability', 'bytes', 'fileId', 'version']) || !string(e.name, 255) || e.name.includes('/') || !isWslResultsRelativePath(e.relativePath) || e.relativePath !== (v.relativeDirectory ? v.relativeDirectory + '/' : '') + e.name || seen.has(e.name) || !int(e.bytes) || !['directory', 'file'].includes(e.kind as string) || !['directory', 'text_result', 'binary_result', 'unsupported', 'file_limit'].includes(e.readability as string)) return null;
      if (e.kind === 'directory' ? e.readability !== 'directory' || e.fileId !== null || e.version !== null : e.readability === 'directory' || (e.readability === 'text_result' ? !id(e.fileId) || !version(e.version) || e.bytes > WSL_RESULTS_LIMITS.fileBytes : e.fileId !== null || e.version !== null)) return null;
      if (typeof e.version === 'string' && Number(e.version.split(':')[2]) !== e.bytes) return null;
      seen.add(e.name);
    }
    return freezeWslResult(v as WslResultsListValue);
  }
  if (v.kind === 'wsl_results_read') {
    if (!exact(v, ['kind', 'source', 'fileId', 'fileIdentity', 'version', 'rawSha256', 'excerptSha256', 'startLine', 'endLine', 'totalLines', 'fileBytes', 'text', 'nextLine', 'complete', 'citationId', 'physicalReadBytes', 'scannedCandidates']) || !record(v.source) || !exact(v.source, ['distro', 'user', 'rootPath', 'id', 'rootIdentity', 'readerVersion', 'selectedAt', 'relativePath', 'absolutePath'])) return null;
    const { relativePath, absolutePath, ...binding } = v.source;
    if (!parseWslResultsBinding(binding) || !isWslResultsRelativePath(relativePath) || absolutePath !== binding.rootPath + '/' + relativePath || !id(v.fileId) || !id(v.citationId) || !identity(v.fileIdentity) || !version(v.version) || !(v.version as string).startsWith(v.fileIdentity + ':') || !hex(v.rawSha256) || !hex(v.excerptSha256) || !int(v.fileBytes, WSL_RESULTS_LIMITS.fileBytes) || !int(v.totalLines, 500000) || !int(v.startLine, Math.max(1, v.totalLines as number), 1) || !int(v.endLine, v.totalLines as number) || typeof v.text !== 'string' || size(v.text) > WSL_RESULTS_LIMITS.pageBytes || v.text.includes('\u0000') || typeof v.complete !== 'boolean' || (v.nextLine !== null && !int(v.nextLine, v.totalLines as number, (v.endLine as number) + 1)) || v.complete !== (v.nextLine === null) || v.physicalReadBytes !== v.fileBytes || v.scannedCandidates !== 1) return null;
    if (Number((v.version as string).split(':')[2]) !== v.fileBytes || (v.totalLines === 0 ? v.text !== '' || v.endLine !== 0 : (v.endLine as number) < (v.startLine as number)) || (v.complete && v.endLine !== v.totalLines) || (!v.complete && v.nextLine !== (v.endLine as number) + 1)) return null;
    return freezeWslResult(v as WslResultsReadValue);
  }
  return null;
}
/** Validated JSON is detached from transport/caller objects before it enters the ledger. */
function freezeWslResult<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freezeWslResult(child); Object.freeze(value); }
  return value;
}
const obj = (properties: object) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: 'string', minLength: 1, maxLength: 128 };
export const WSL_RESULTS_TOOLS = Object.freeze([
  { type: 'function', function: { name: 'wsl_results_list', description: 'List one directory within the user-selected experimental WSL results binding. Copy bindingId from the run context. Start with relativeDirectory="", nameQuery="", cursor=null. Navigate returned directories; nameQuery is literal case-sensitive name filtering. Preserve all arguments while following nextCursor. Hidden, sensitive and symlink entries are excluded. Binary PSF results are metadata only. No simulation is started.', parameters: obj({ bindingId: str, relativeDirectory: { type: 'string', maxLength: WSL_RESULTS_LIMITS.pathBytes }, nameQuery: { type: 'string', maxLength: 128 }, cursor: { anyOf: [str, { type: 'null' }] } }) } },
  { type: 'function', function: { name: 'wsl_results_read', description: 'Read an existing UTF-8 exported result or log from the frozen experimental WSL binding. Use fileId and exact version from wsl_results_list. Start at line 1 and continue with nextLine; complete only describes coverage from the requested start. A spectre.out log is not a waveform or a new simulation. Cite citationId, source path, version and line range. PSF binary parsing, netlists, models, credentials and scripts are unavailable.', parameters: obj({ bindingId: str, fileId: str, version: { type: 'string', minLength: 1, maxLength: 256 }, startLine: { type: 'integer', minimum: 1, maximum: 500000 }, maxLines: { type: 'integer', minimum: 1, maximum: WSL_RESULTS_LIMITS.pageLines } }) } },
]);
