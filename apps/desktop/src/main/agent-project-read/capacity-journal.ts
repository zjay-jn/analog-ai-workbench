/** Main-private deletion inventory. Paths are relative to fixed main-owned roots. */
export const CAPACITY_LIMITS = Object.freeze({ entries: 32768, targets: 66, depth: 32, scanMs: 5000, jsonBytes: 16 * 1024 * 1024 });
export type CapacityTargetKind = 'workspace' | 'command_records' | 'work_execution' | 'command_execution';
export type CapacityFile = Readonly<{
  relativePath: string; kind: 'file' | 'directory'; dev: string; ino: string;
  bytes: number; mtimeNs: string; ctimeNs: string;
  category: 'taskBytes' | 'logBytes' | 'workspaceBytes';
}>;
export type CapacityTarget = Readonly<{ kind: CapacityTargetKind; id: string; entries: readonly CapacityFile[] }>;
export type TaskDeletion = Readonly<{
  runId: string; workspaceId: string | null; expectedEventCount: number;
  createdAt: string; state: 'pending' | 'failed'; targets: readonly CapacityTarget[];
}>;
const token = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const numeric = /^-?\d{1,30}$/u;
function exact(v: unknown, keys: readonly string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length !== keys.length
    || keys.some(k => { const d = Object.getOwnPropertyDescriptor(v, k); return !d || !('value' in d) || !d.enumerable; })) throw Error('INVALID_CAPACITY_JOURNAL');
}
export function capacityRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && (value === '' || value.split('/').every(p => !!p && p !== '.' && p !== '..'
    && !/[\\:\x00-\x1f<>"|?*]/u.test(p) && !/[ .]$/u.test(p) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(p)))
    && value.split('/').length <= CAPACITY_LIMITS.depth;
}
export function parseTaskDeletion(value: unknown): TaskDeletion | null {
  try {
    exact(value, ['runId','workspaceId','expectedEventCount','createdAt','state','targets']);
    if (typeof value.runId !== 'string' || !token.test(value.runId) || value.workspaceId !== null && (typeof value.workspaceId !== 'string' || !token.test(value.workspaceId))
      || !Number.isSafeInteger(value.expectedEventCount) || Number(value.expectedEventCount) < 1 || Number(value.expectedEventCount) > 1024
      || typeof value.createdAt !== 'string' || new Date(value.createdAt).toISOString() !== value.createdAt
      || !['pending','failed'].includes(String(value.state)) || !Array.isArray(value.targets) || value.targets.length > CAPACITY_LIMITS.targets) return null;
    const keys = new Set<string>(); let count = 0;
    for (const t of value.targets) {
      exact(t, ['kind','id','entries']);
      if (!['workspace','command_records','work_execution','command_execution'].includes(String(t.kind)) || typeof t.id !== 'string' || !token.test(t.id)
        || t.kind === 'workspace' && t.id !== value.workspaceId || t.kind === 'command_records' && t.id !== value.runId
        || (t.kind === 'work_execution' && !/^wce-[a-f0-9-]{36}$/u.test(t.id)) || (t.kind === 'command_execution' && !/^cmd-[a-f0-9-]{36}$/u.test(t.id))
        || keys.has(t.kind + ':' + t.id) || !Array.isArray(t.entries) || (count += t.entries.length) > CAPACITY_LIMITS.entries) return null;
      keys.add(t.kind + ':' + t.id); const paths = new Map<string, string>();
      for (const e of t.entries) {
        exact(e, ['relativePath','kind','dev','ino','bytes','mtimeNs','ctimeNs','category']);
        if (!capacityRelativePath(e.relativePath) || !['file','directory'].includes(String(e.kind)) || paths.has(e.relativePath.toLowerCase())
          || !['dev','ino','mtimeNs','ctimeNs'].every(k => typeof e[k] === 'string' && numeric.test(e[k]))
          || !Number.isSafeInteger(e.bytes) || Number(e.bytes) < 0 || (e.kind === 'directory' && e.bytes !== 0)
          || !['taskBytes','logBytes','workspaceBytes'].includes(String(e.category))) return null;
        if (e.relativePath === '' ? e.kind !== 'directory' : paths.get(e.relativePath.split('/').slice(0,-1).join('/').toLowerCase()) !== 'directory') return null;
        paths.set(e.relativePath.toLowerCase(), String(e.kind));
      }
      if (t.entries.length && !paths.has('')) return null;
    }
    if (value.workspaceId !== null && !keys.has('workspace:' + value.workspaceId)) return null;
    const copy = structuredClone(value) as TaskDeletion;
    return Object.freeze({ ...copy, targets: Object.freeze(copy.targets.map(t => Object.freeze({ ...t,
      entries: Object.freeze(t.entries.map(e => Object.freeze(e))),
    }))) });
  } catch { return null; }
}
