import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { COMMAND_LIMITS as L } from '../../shared/agent/agent-command';
import { commandId } from '../../shared/agent/agent-command-validation';
import { inspectProjectFolderPath, sameProjectFolderChain } from '../cloud/project-folder-files';
import { CommandError, type CommandChunk, type CommandRecord, type CommandRepository } from './types';
import { commandDigest } from './logs';
import { assertCommandRecovery, assertCommandTransition, validateCommandRecord } from './state';

const ordinary=(s:fs.BigIntStats):boolean=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n;
const same=(a:fs.BigIntStats,b:fs.BigIntStats):boolean=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const systemCode=(e:unknown):unknown=>e&&typeof e==='object'&&'code' in e?e.code:null;
/** Fixed main-owned run directory; child execution tokens must never receive access here. */
export function createCommandRepository(options:Readonly<{directory:string;runId:string;readOnly:boolean;reconcile?:boolean;beforeReplace?:()=>void}>):CommandRepository {
  const directory=path.resolve(options.directory),parent=path.dirname(directory);
  if(!commandId(options.runId)||path.basename(directory)!==options.runId||path.basename(parent)!=='runs'||path.basename(path.dirname(parent))!=='agent-command')throw new CommandError('UNSUPPORTED_PATH');
  function ensure(target:string):void{try{inspectProjectFolderPath(target,true);}catch(e){if(systemCode(e)!=='ENOENT')throw e;const p=path.dirname(target);if(p===target)throw e;ensure(p);fs.mkdirSync(target);inspectProjectFolderPath(target,true);}}
  if(!options.readOnly)ensure(directory);
  const chain=inspectProjectFolderPath(directory,true).chain;
  let closed=false,poisoned=false;const records=new Map<string,CommandRecord>();
  const lockPath=path.join(directory,'writer.lock');let lock:Readonly<{bytes:Buffer;stat:fs.BigIntStats}>|undefined;
  const check=():void=>{if(!sameProjectFolderChain(chain,inspectProjectFolderPath(directory,true).chain))throw new CommandError('ROOT_CHANGED');};
  function checked(target:string,max:number):Readonly<{bytes:Buffer;stat:fs.BigIntStats}>{
    check();const relative=path.relative(directory,target);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new CommandError('UNSUPPORTED_PATH');
    const before=inspectProjectFolderPath(target,false);if(!ordinary(before.stat)||before.stat.size>BigInt(max)||!sameProjectFolderChain(chain,before.chain.slice(0,chain.length)))throw new CommandError('STORAGE_FAILED');
    const fd=fs.openSync(target,'r');try{if(!same(before.stat,fs.fstatSync(fd,{bigint:true})))throw new CommandError('SOURCE_CHANGED');const bytes=Buffer.alloc(Number(before.stat.size)+1);let n=0;while(n<bytes.length){const got=fs.readSync(fd,bytes,n,bytes.length-n,n);if(!got)break;n+=got;}const after=inspectProjectFolderPath(target,false);if(n!==Number(before.stat.size)||!same(before.stat,after.stat)||!same(before.stat,fs.fstatSync(fd,{bigint:true}))||!sameProjectFolderChain(before.chain,after.chain))throw new CommandError('SOURCE_CHANGED');check();return {bytes:bytes.subarray(0,n),stat:after.stat};}finally{fs.closeSync(fd);}
  }
  function put(target:string,bytes:Uint8Array):Readonly<{bytes:Buffer;stat:fs.BigIntStats}>{
    check();const p=inspectProjectFolderPath(path.dirname(target),true).chain;if(!sameProjectFolderChain(chain,p.slice(0,chain.length)))throw new CommandError('ROOT_CHANGED');
    const fd=fs.openSync(target,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const result=checked(target,bytes.byteLength);if(!result.bytes.equals(bytes)||!sameProjectFolderChain(p,inspectProjectFolderPath(path.dirname(target),true).chain))throw new CommandError('STORAGE_FAILED');return result;
  }
  function writable():void{check();if(closed)throw new CommandError('CANCELLED');if(options.readOnly)throw new CommandError('CAPABILITY_DENIED');if(poisoned||!lock)throw new CommandError('STORAGE_FAILED');const actual=checked(lockPath,1024);if(!same(lock.stat,actual.stat)||!actual.bytes.equals(lock.bytes))throw new CommandError('STORAGE_FAILED');}
  function location(id:string):string{if(!/^cmd-[a-f0-9-]{36}$/u.test(id))throw new CommandError('INVALID_REQUEST');return path.join(directory,id);}
  function diskRecord(id:string):CommandRecord{const raw=checked(path.join(location(id),'execution.json'),L.recordBytes),v:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes));validateCommandRecord(v);if(v.execution.runId!==options.runId||v.execution.executionId!==id)throw new CommandError('STORAGE_FAILED');return v;}
  function readChunk(id:string,c:CommandChunk):Uint8Array{if(!/^chunk-[a-f0-9-]{36}\.bin$/u.test(c.object))throw new CommandError('INVALID_REQUEST');const value=checked(path.join(location(id),c.object),L.logChunkBytes).bytes;if(value.length!==c.bytes||commandDigest(value)!==c.sha256)throw new CommandError('SOURCE_CHANGED');return value;}
  function auditFiles(row:CommandRecord):void{
    const id=row.execution.executionId,expected=new Set(['execution.json',...row.chunks.stdout.map(c=>c.object),...row.chunks.stderr.map(c=>c.object),...(row.retainedObjects??[]).map(c=>c.object)]),handle=fs.opendirSync(location(id));
    try{let entry:fs.Dirent|null;let uncertain=0;while((entry=handle.readSync())!==null){if(!entry.isFile())throw new CommandError('STORAGE_FAILED');if(!expected.delete(entry.name)){if(!options.reconcile||++uncertain>16||!/^(?:chunk-[a-f0-9-]{36}\.bin|state-[a-f0-9-]{36}\.tmp)$/u.test(entry.name))throw new CommandError('STORAGE_FAILED');checked(path.join(location(id),entry.name),entry.name.endsWith('.bin')?L.logChunkBytes:L.recordBytes);}}if(expected.size)throw new CommandError('STORAGE_FAILED');}finally{handle.closeSync();}
    for(const stream of ['stdout','stderr'] as const){const digest=createHash('sha256');for(const c of row.chunks[stream])digest.update(readChunk(id,c));const hash=digest.digest('hex');if(row.execution.logs[stream].closed&&row.execution.logs[stream].sha256!==hash)throw new CommandError('STORAGE_FAILED');}
    for(const item of row.retainedObjects??[]){const raw=checked(path.join(location(id),item.object),L.recordBytes).bytes;if(raw.length!==item.bytes||commandDigest(raw)!==item.sha256)throw new CommandError('STORAGE_FAILED');}
  }
  try{
    if(!options.readOnly){
      if(options.reconcile&&fs.existsSync(lockPath)){const prior=checked(lockPath,1024),owner=JSON.parse(prior.bytes.toString('utf8'));if(!owner||typeof owner.nonce!=='string'||!/^[a-f0-9-]{36}$/u.test(owner.nonce)||!Number.isSafeInteger(owner.pid)||owner.pid<1)throw new CommandError('BUSY');
        try{process.kill(owner.pid,0);throw new CommandError('BUSY');}catch(e){if(systemCode(e)!=='ESRCH')throw e;}
        const current=checked(lockPath,1024);if(!same(prior.stat,current.stat)||!prior.bytes.equals(current.bytes))throw new CommandError('CONFLICT');fs.unlinkSync(lockPath);
      }
      lock=put(lockPath,Buffer.from(JSON.stringify({nonce:randomUUID(),pid:process.pid})));
    }
    const handle=fs.opendirSync(directory);try{let entry:fs.Dirent|null;let count=0;while((entry=handle.readSync())!==null){if(++count>L.executions+1)throw new CommandError('STORAGE_FAILED');if(entry.name==='writer.lock')continue;if(!entry.isDirectory())throw new CommandError('STORAGE_FAILED');const row=diskRecord(entry.name);if(records.has(row.execution.executionId)||[...records.values()].some(r=>r.execution.requestId===row.execution.requestId))throw new CommandError('STORAGE_FAILED');auditFiles(row);records.set(row.execution.executionId,row);}}finally{handle.closeSync();}
  }catch(e){if(lock)try{const actual=checked(lockPath,1024);if(same(lock.stat,actual.stat)&&actual.bytes.equals(lock.bytes))fs.unlinkSync(lockPath);}catch{/* Preserve an unproven lock. */}throw e instanceof CommandError?e:new CommandError(systemCode(e)==='EEXIST'?'BUSY':'STORAGE_FAILED');}
  return {
    load(){check();return structuredClone([...records.values()]);},
    create(record){writable();validateCommandRecord(record);if(record.execution.runId!==options.runId||records.size>=L.executions||records.has(record.execution.executionId)||[...records.values()].some(r=>r.execution.requestId===record.execution.requestId))throw new CommandError('CONFLICT');try{fs.mkdirSync(location(record.execution.executionId));put(path.join(location(record.execution.executionId),'execution.json'),Buffer.from(JSON.stringify(record)));records.set(record.execution.executionId,structuredClone(record));}catch{poisoned=true;throw new CommandError('STORAGE_FAILED');}},
    save(previous,next){writable();assertCommandTransition(previous,next);const id=previous.execution.executionId;try{if(!isDeepStrictEqual(records.get(id),previous)||!isDeepStrictEqual(diskRecord(id),previous))throw new CommandError('CONFLICT');const temp=path.join(location(id),'state-'+randomUUID()+'.tmp');put(temp,Buffer.from(JSON.stringify(next)));options.beforeReplace?.();writable();if(!isDeepStrictEqual(diskRecord(id),previous))throw new CommandError('CONFLICT');fs.renameSync(temp,path.join(location(id),'execution.json'));if(!isDeepStrictEqual(diskRecord(id),next))throw new CommandError('STORAGE_FAILED');records.set(id,structuredClone(next));}catch(e){poisoned=true;throw e instanceof CommandError?e:new CommandError('STORAGE_FAILED');}},
    recover(previous,next){writable();if(!options.reconcile)throw new CommandError('CAPABILITY_DENIED');const id=previous.execution.executionId;try{if(!isDeepStrictEqual(records.get(id),previous)||!isDeepStrictEqual(diskRecord(id),previous))throw new CommandError('CONFLICT');const known=new Set(['execution.json',...next.chunks.stdout.map(c=>c.object),...next.chunks.stderr.map(c=>c.object)]),retained:NonNullable<CommandRecord['retainedObjects']>[number][]=[];
      for(const name of fs.readdirSync(location(id))){if(known.has(name))continue;if(retained.length>=16||!/^(?:chunk-[a-f0-9-]{36}\.bin|state-[a-f0-9-]{36}\.tmp)$/u.test(name))throw new CommandError('STORAGE_FAILED');const raw=checked(path.join(location(id),name),L.recordBytes).bytes;retained.push({object:name,bytes:raw.length,sha256:commandDigest(raw)});}next={...next,retainedObjects:retained};assertCommandRecovery(previous,next);
      const temp=path.join(location(id),'state-'+randomUUID()+'.tmp');put(temp,Buffer.from(JSON.stringify(next)));writable();if(!isDeepStrictEqual(diskRecord(id),previous))throw new CommandError('CONFLICT');fs.renameSync(temp,path.join(location(id),'execution.json'));if(!isDeepStrictEqual(diskRecord(id),next))throw new CommandError('STORAGE_FAILED');records.set(id,structuredClone(next));}catch(e){poisoned=true;throw e instanceof CommandError?e:new CommandError('STORAGE_FAILED');}},
    writeChunk(id,bytes){writable();if(!records.has(id)||bytes.byteLength<1||bytes.byteLength>L.logChunkBytes)throw new CommandError('INVALID_REQUEST');try{const object='chunk-'+randomUUID()+'.bin';put(path.join(location(id),object),bytes);return object;}catch{poisoned=true;throw new CommandError('STORAGE_FAILED');}},
    readChunk,
    close(){if(closed)return;if(lock&&!poisoned){const actual=checked(lockPath,1024);if(!same(lock.stat,actual.stat)||!actual.bytes.equals(lock.bytes))throw new CommandError('CLEANUP_FAILED');fs.unlinkSync(lockPath);}closed=true;},
  };
}
