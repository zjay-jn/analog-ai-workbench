import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parsePilotDisk, PILOT_LIMITS, type PilotDisk } from '../../shared/agent/engine-pilot';

export class PilotStorageError extends Error { constructor() { super('Pilot storage unavailable'); } }
export interface PilotStore { load(): PilotDisk; save(value: PilotDisk): void; close(): void; }
const digest = (value: Buffer | null): string | null => value === null ? null : createHash('sha256').update(value).digest('hex');
/** Only product-owned pilot state or explicitly isolated synthetic test state. */
export function createPilotStore(root: string, directory = path.join(root,'.local','agent-engine-pilot')): PilotStore {
  const base = path.resolve(root), folder = path.resolve(directory);
  if (base.toLowerCase() !== path.resolve('C:/work/analog_ai_workbench').toLowerCase()) throw new PilotStorageError();
  const relative = path.relative(base,folder).replaceAll('\\','/');
  if (relative !== '.local/agent-engine-pilot' && relative !== '.local/agent-engine-live' && !/^\.local\/agent-engine-pilot-tests\/[0-9a-f-]{36}$/u.test(relative) && !/^\.local\/agent-engine-live-tests\/[0-9a-f-]{36}\/agent-engine-live$/u.test(relative)) throw new PilotStorageError();
  const target = path.join(folder,'runs.json'), lock = path.join(folder,'writer.lock'), nonce = randomUUID();
  let closed = false, poisoned = false, loaded = false, expected: string | null = null;
  function directories(create = false): void {
    let current = path.parse(folder).root;
    for (const component of folder.slice(current.length).split(path.sep)) {
      current = path.join(current,component);
      if (!fs.existsSync(current) && create && current.startsWith(base + path.sep)) fs.mkdirSync(current);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PilotStorageError();
    }
    if (path.resolve(fs.realpathSync(folder)).toLowerCase() !== folder.toLowerCase()) throw new PilotStorageError();
  }
  function boundedRead(file: string, max: number): Buffer | null {
    directories(); let before: fs.Stats;
    try { before=fs.lstatSync(file); } catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max) throw new PilotStorageError();
    const fd=fs.openSync(file,'r');
    try {
      const opened=fs.fstatSync(fd); if (!opened.isFile() || opened.nlink!==1 || opened.ino!==before.ino || opened.dev!==before.dev || opened.size>max) throw new PilotStorageError();
      const buffer=Buffer.alloc(opened.size+1); let length=0,count=0;
      while(length<buffer.length && (count=fs.readSync(fd,buffer,length,buffer.length-length,null))>0) length+=count;
      const after=fs.lstatSync(file); directories();
      if(length!==opened.size || after.isSymbolicLink() || after.nlink!==1 || after.ino!==opened.ino || after.dev!==opened.dev || after.size!==opened.size || after.mtimeMs!==opened.mtimeMs) throw new PilotStorageError();
      return buffer.subarray(0,length);
    } finally { fs.closeSync(fd); }
  }
  function ownsLock(): boolean { return boundedRead(lock,128)?.toString('utf8') === nonce; }
  try {
    directories(true); const fd=fs.openSync(lock,'wx',0o600);
    try { fs.writeFileSync(fd,nonce); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { throw new PilotStorageError(); }
  return {
    load() {
      try { if(closed || poisoned || !ownsLock()) throw new PilotStorageError(); const data=boundedRead(target,PILOT_LIMITS.diskBytes); const value=data===null ? parsePilotDisk({version:1,runs:[]}) : parsePilotDisk(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data))); expected=digest(data); loaded=true; return value; }
      catch { poisoned=true; throw new PilotStorageError(); }
    },
    save(value) {
      let temporary: string | undefined;
      try {
        if(closed || poisoned || !loaded || !ownsLock()) throw new PilotStorageError();
        const data=Buffer.from(JSON.stringify(parsePilotDisk(value))); if(data.length>PILOT_LIMITS.diskBytes || digest(boundedRead(target,PILOT_LIMITS.diskBytes))!==expected) throw new PilotStorageError();
        temporary=path.join(folder,`.runs-${randomUUID()}.tmp`); const fd=fs.openSync(temporary,'wx',0o600);
        try { fs.writeFileSync(fd,data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if(!ownsLock() || digest(boundedRead(target,PILOT_LIMITS.diskBytes))!==expected) throw new PilotStorageError();
        fs.renameSync(temporary,target); temporary=undefined;
        const next=digest(data); if(digest(boundedRead(target,PILOT_LIMITS.diskBytes))!==next) throw new PilotStorageError(); expected=next;
      } catch { poisoned=true; throw new PilotStorageError(); }
      finally { if(temporary) { try { fs.unlinkSync(temporary); } catch { /* Never recover from a temp file. */ } } }
    },
    close() { if(closed) return; try { if(ownsLock()) fs.unlinkSync(lock); } catch { /* Do not remove an unverified lock. */ } closed=true; },
  };
}
