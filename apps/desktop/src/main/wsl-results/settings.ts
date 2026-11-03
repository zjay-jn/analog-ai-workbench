import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WSL_RESULTS_LIMITS as L, WSL_RESULTS_VERSION, parseWslResultsBinding, type WslResultsBinding } from '../../shared/agent/wsl-results';
import { WslResultsError } from './transport';
const MAX_BYTES = 128 * 1024;
const fail = (): never => { throw new WslResultsError('STORAGE_FAILED'); };
const validProject = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 256 && !/[\u0000-\u001f\u007f]/u.test(v);
/** directory is a main-owned settings directory, never supplied by Renderer or a model. */
export function createWslResultsSettings(options: Readonly<{ directory: string }>) {
  const directory = path.resolve(options.directory), file = path.join(directory, 'wsl-results-bindings.json');
  let queue: Promise<unknown> = Promise.resolve();
  async function checkDirectory(create: boolean): Promise<void> {
    const parsed = path.parse(directory), parts = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (const part of parts) {
      current = path.join(current, part);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw e; await fs.mkdir(current); stat = await fs.lstat(current); }
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    }
  }
  async function load(): Promise<Map<string, WslResultsBinding>> {
    try {
      await checkDirectory(false);
      const before = await fs.lstat(file); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) return fail();
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let text: string;
      try {
        const opened = await handle.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return fail();
        const bytes = Buffer.alloc(before.size), read = await handle.read(bytes, 0, before.size, 0), after = await handle.stat();
        if (read.bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return fail();
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } finally { await handle.close(); }
      await checkDirectory(false); const final = await fs.lstat(file); if (final.dev !== before.dev || final.ino !== before.ino || final.isSymbolicLink()) return fail();
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail();
      const data = parsed as Record<string, unknown>;
      if (Object.keys(data).length !== 2 || data.version !== WSL_RESULTS_VERSION || !Array.isArray(data.bindings) || data.bindings.length > L.maxBindings) return fail();
      const map = new Map<string, WslResultsBinding>();
      for (const item of data.bindings) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 || !validProject(item.projectId)) return fail();
        const binding = parseWslResultsBinding(item.binding); if (!binding || map.has(item.projectId)) return fail(); map.set(item.projectId, binding);
      }
      return map;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map(); return fail(); }
  }
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => { const task = queue.then(operation, operation); queue = task.catch(() => {}); return task; };
  return {
    get(projectId: string): Promise<WslResultsBinding | null> { return serialized(async () => { if (!validProject(projectId)) throw new WslResultsError('INVALID_REQUEST'); return (await load()).get(projectId) ?? null; }); },
    set(projectId: string, input: WslResultsBinding | null): Promise<void> { return serialized(async () => {
      if (!validProject(projectId)) throw new WslResultsError('INVALID_REQUEST');
      const binding = input === null ? null : parseWslResultsBinding(input); if (input !== null && !binding) throw new WslResultsError('INVALID_REQUEST');
      const values = await load(); if (binding) values.set(projectId, binding); else values.delete(projectId);
      if (values.size > L.maxBindings) throw new WslResultsError('BUDGET_EXCEEDED');
      const text = JSON.stringify({ version: WSL_RESULTS_VERSION, bindings: [...values].map(([key, value]) => ({ projectId: key, binding: value })) });
      if (Buffer.byteLength(text) > MAX_BYTES) throw new WslResultsError('BUDGET_EXCEEDED');
      try {
        await checkDirectory(true);
        const temporary = path.join(directory, 'wsl-bindings-' + randomUUID() + '.tmp');
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await checkDirectory(false); await fs.rename(temporary, file);
      } catch { fail(); }
    }); },
  };
}
export type WslResultsSettings = ReturnType<typeof createWslResultsSettings>;
