import type { TestContext } from 'node:test';
import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

export const base = 'C:\\work\\analog_ai_workbench\\.local\\fs-broker-memory';
export const A = base + '\\project-A', B = base + '\\source-B';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Synthetic metadata/content only. No path in rows is opened on the actual filesystem. */
export type Row = { text?: string; ino?: bigint; mtime?: bigint; links?: bigint; directory?: boolean; openError?: string; readError?: string; directoryError?: string };
export function memory(t: TestContext, rows: Record<string, Row>) {
  const seen = { listed: [] as string[], opened: [] as string[], reads: 0, closed: 0, metadata: [] as string[] };
  const stat = (target: string): fs.BigIntStats => {
    const row = rows[target], directory = row?.directory ?? (row === undefined && Object.keys(rows).some(p => p.startsWith(target.endsWith('\\') ? target : target + '\\')));
    if (!row && !directory) throw Object.assign(Error('synthetic missing'), { code: 'ENOENT' });
    return { dev: 1n, ino: row?.ino ?? BigInt('0x' + digest(target).slice(0, 12)), nlink: row?.links ?? 1n,
      size: BigInt(Buffer.byteLength(row?.text ?? '')), mtimeNs: row?.mtime ?? 1n, ctimeNs: 1n,
      isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false,
    } as fs.BigIntStats;
  };
  t.mock.method(fs, 'lstatSync', ((target: fs.PathLike) => { seen.metadata.push(String(target)); return stat(String(target)); }) as typeof fs.lstatSync);
  t.mock.method(fs.realpathSync, 'native', ((target: fs.PathLike) => String(target)) as typeof fs.realpathSync.native);
  t.mock.method(asyncFs, 'lstat', (async (target: fs.PathLike) => stat(String(target))) as typeof asyncFs.lstat);
  t.mock.method(asyncFs, 'opendir', (async (target: fs.PathLike) => {
    const folder = String(target); seen.listed.push(folder);
    if (rows[folder]?.directoryError) throw Object.assign(Error('raw private directory error'), { code: rows[folder]!.directoryError });
    stat(folder); const prefix = folder.endsWith('\\') ? folder : folder + '\\', names = new Set<string>();
    for (const name of Object.keys(rows)) if (name.startsWith(prefix) && name !== folder) names.add(name.slice(prefix.length).split('\\')[0]!);
    const entries = [...names]; let offset = 0;
    return { async read() {
      if (offset === entries.length) return null; const name = entries[offset++]!, value = stat(path.win32.join(folder, name));
      return { name, isDirectory: () => value.isDirectory(), isFile: () => value.isFile(), isSymbolicLink: () => false };
    }, async close() { seen.closed++; } } as unknown as fs.Dir;
  }) as typeof asyncFs.opendir);
  t.mock.method(asyncFs, 'open', (async (target: fs.PathLike) => {
    const file = String(target); seen.opened.push(file);
    if (rows[file]?.openError) throw Object.assign(Error('raw private open error'), { code: rows[file]!.openError });
    stat(file);
    return {
      async stat() { return stat(file); },
      async read(buffer: Buffer, offset: number, count: number, position: number) {
        seen.reads++; if (rows[file]?.readError) throw Object.assign(Error('raw private read error'), { code: rows[file]!.readError });
        const source = Buffer.from(rows[file]?.text ?? ''), bytesRead = Math.min(count, Math.max(0, source.length - position));
        source.copy(buffer, offset, position, position + bytesRead); return { bytesRead, buffer };
      },
      async close() { seen.closed++; },
    } as unknown as FileHandle;
  }) as typeof asyncFs.open);
  return { rows, seen };
}
