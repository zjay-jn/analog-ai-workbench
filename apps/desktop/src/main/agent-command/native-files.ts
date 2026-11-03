import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sameProjectFolderChain, type FolderIdentity } from '../cloud/project-folder-files';
import { CommandError } from './types';

export const COMMAND_PRODUCT=path.resolve('C:/work/analog_ai_workbench');
export const COMMAND_EXECUTIONS=path.join(COMMAND_PRODUCT,'.local','agent-command-runner','executions');
export type NativeFilePin=Readonly<{path:string;bytes:number;sha256:string}>;
type Stamp=Readonly<{dev:bigint;ino:bigint}>;
const stamp=(s:fs.BigIntStats):Stamp=>({dev:s.dev,ino:s.ino});
const identity=(a:Stamp,b:Stamp):boolean=>a.dev===b.dev&&a.ino===b.ino;
const stable=(a:fs.BigIntStats,b:fs.BigIntStats):boolean=>identity(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const code=(e:unknown):unknown=>e&&typeof e==='object'&&'code' in e?e.code:null;
export const nativeDigest=(b:Uint8Array):string=>createHash('sha256').update(b).digest('hex');
const contained=(root:string,file:string):boolean=>{const rel=path.relative(root,path.resolve(file));return !!rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
/** Private pinned runtime evidence can include LICENSE/toolchains. Project-file name grants stay unchanged. */
export function inspectNativePath(file:string,directory:boolean):{chain:FolderIdentity[];stat:fs.BigIntStats}{
  const resolved=path.resolve(file);if((resolved!==COMMAND_PRODUCT&&!contained(COMMAND_PRODUCT,resolved))||! /^[a-z]:\\/iu.test(file)||file.slice(2).includes(':')||file.replace(/\\$/u,'').toLowerCase()!==resolved.toLowerCase())throw new CommandError('UNSUPPORTED_PATH');
  const base=path.parse(resolved).root,names=resolved.slice(base.length).split(path.sep),chain:FolderIdentity[]=[];let cursor=base,stat=fs.lstatSync(base,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new CommandError('UNSUPPORTED_PATH');chain.push({dev:String(stat.dev),ino:String(stat.ino)});
  for(let i=0;i<names.length;i++){cursor=path.join(cursor,names[i]!);stat=fs.lstatSync(cursor,{bigint:true});if(stat.isSymbolicLink()||((i<names.length-1||directory)&&!stat.isDirectory())||fs.realpathSync.native(cursor).toLowerCase()!==cursor.toLowerCase())throw new CommandError('UNSUPPORTED_PATH');chain.push({dev:String(stat.dev),ino:String(stat.ino)});}
  if(!directory&&(!stat.isFile()||stat.nlink!==1n))throw new CommandError('UNSUPPORTED_PATH');return {chain,stat};
}
export function nativeRead(file:string,max:number):Buffer{
  if(!contained(COMMAND_PRODUCT,file))throw new CommandError('UNSUPPORTED_PATH');const before=inspectNativePath(file,false);if(before.stat.nlink!==1n||before.stat.size>BigInt(max))throw new CommandError('FILE_LIMIT');
  const fd=fs.openSync(file,'r');try{if(!stable(before.stat,fs.fstatSync(fd,{bigint:true})))throw new CommandError('SOURCE_CHANGED');const b=Buffer.alloc(Number(before.stat.size)+1);let n=0;while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,n);if(!k)break;n+=k;}const after=inspectNativePath(file,false);if(n!==Number(before.stat.size)||!stable(before.stat,after.stat)||!stable(before.stat,fs.fstatSync(fd,{bigint:true}))||!sameProjectFolderChain(before.chain,after.chain))throw new CommandError('SOURCE_CHANGED');return b.subarray(0,n);}finally{fs.closeSync(fd);}
}
/** One immutable published status snapshot. The native may atomically replace its directory entry. */
export function nativeReadStatus(file:string,max:number):Buffer{
  const control=path.dirname(file),execution=path.dirname(control);
  if(file!==path.join(execution,'control','status.json')||path.dirname(execution)!==COMMAND_EXECUTIONS||!/^cmd-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(path.basename(execution))||!Number.isSafeInteger(max)||max<1||max>512*1024)throw new CommandError('UNSUPPORTED_PATH');
  const parent=inspectNativePath(control,true),before=fs.lstatSync(file,{bigint:true});
  const ordinary=(s:fs.BigIntStats):boolean=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.size<=BigInt(max);
  if(!ordinary(before))throw new CommandError('SOURCE_CHANGED');
  // libuv fs.open shares DELETE; fs.realpathSync.native on this final leaf would use share=0.
  const fd=fs.openSync(file,'r');try{
    const opened=fs.fstatSync(fd,{bigint:true});if(!ordinary(opened)||!stable(before,opened))throw new CommandError('SOURCE_CHANGED');
    const read=():Buffer=>{const bytes=Buffer.alloc(Number(opened.size)+1);let n=0;while(n<bytes.length){const got=fs.readSync(fd,bytes,n,bytes.length-n,n);if(!got)break;n+=got;}if(n!==Number(opened.size))throw new CommandError('SOURCE_CHANGED');return bytes.subarray(0,n);};
    const first=read(),second=read(),after=fs.fstatSync(fd,{bigint:true}),current=fs.lstatSync(file,{bigint:true});
    // Removing the old name can change ctime/nlink. Identity, content and size of our open object must stay fixed.
    if(!identity(opened,after)||opened.size!==after.size||opened.mtimeNs!==after.mtimeNs||!after.isFile()||after.nlink<0n||after.nlink>1n||!first.equals(second)||!ordinary(current)||!sameProjectFolderChain(parent.chain,inspectNativePath(control,true).chain))throw new CommandError('SOURCE_CHANGED');
    return first;
  }finally{fs.closeSync(fd);}
}
export function nativePinned(pin:NativeFilePin,max=128*1024*1024):Buffer{
  if(!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>max||!/^[a-f0-9]{64}$/u.test(pin.sha256))throw new CommandError('CAPABILITY_DENIED');const b=nativeRead(pin.path,pin.bytes);if(b.length!==pin.bytes||nativeDigest(b)!==pin.sha256)throw new CommandError('SOURCE_CHANGED');return b;
}
/** This helper writes only one newly allocated execution. There is no recursive delete. */
export function prepareNativeDirectory(executionId:string,existing=false){
  if(!/^cmd-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(executionId))throw new CommandError('INVALID_REQUEST');
  const root=path.join(COMMAND_EXECUTIONS,executionId);
  function ensure(target:string):void{if(target!==COMMAND_PRODUCT&&target!==COMMAND_EXECUTIONS&&!contained(COMMAND_PRODUCT,target))throw new CommandError('UNSUPPORTED_PATH');try{inspectNativePath(target,true);}catch(e){if(code(e)!=='ENOENT'||target===COMMAND_PRODUCT)throw e;ensure(path.dirname(target));fs.mkdirSync(target);inspectNativePath(target,true);}}
  if(!existing){ensure(COMMAND_EXECUTIONS);fs.mkdirSync(root);}const rootChain=inspectNativePath(root,true).chain;
  const check=():void=>{if(!sameProjectFolderChain(rootChain,inspectNativePath(root,true).chain))throw new CommandError('ROOT_CHANGED');};
  function target(relative:string):string{const full=path.resolve(root,...relative.split('/'));if(!contained(root,full)||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':')))throw new CommandError('UNSUPPORTED_PATH');return full;}
  function directory(relative:string):void{check();const full=target(relative),parts=path.relative(root,full).split(path.sep);let p=root;for(const part of parts){p=path.join(p,part);try{inspectNativePath(p,true);}catch(e){if(code(e)!=='ENOENT')throw e;fs.mkdirSync(p);inspectNativePath(p,true);}}check();}
  function write(relative:string,bytes:Uint8Array):NativeFilePin{check();const full=target(relative),parent=path.dirname(full);if(parent!==root)directory(path.relative(root,parent).split(path.sep).join('/'));const chain=inspectNativePath(parent,true).chain;const fd=fs.openSync(full,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const pin={path:full,bytes:bytes.byteLength,sha256:nativeDigest(bytes)};if(!nativeRead(full,bytes.byteLength).equals(bytes)||!sameProjectFolderChain(chain,inspectNativePath(parent,true).chain))throw new CommandError('STORAGE_FAILED');check();return pin;}
  return {root,check,target,directory,write,
    disposeRuntime(pins:readonly NativeFilePin[]):boolean{check();const runtime=target('runtime'),expected=new Set(pins.map(p=>path.basename(p.path)));if(existing&&!fs.existsSync(runtime))return true;const entries=fs.readdirSync(runtime);if(!existing&&entries.length!==expected.size||entries.some(n=>!expected.has(n)))return false;
      for(const p of pins){if(path.dirname(p.path)!==runtime)return false;if(existing&&!entries.includes(path.basename(p.path)))continue;const before=inspectNativePath(p.path,false);if(nativeDigest(nativeRead(p.path,Math.max(p.bytes,1)))!==p.sha256)return false;const after=inspectNativePath(p.path,false);if(!stable(before.stat,after.stat))return false;fs.unlinkSync(p.path);}fs.rmdirSync(runtime);check();return true;},
  };
}
/** Reads only native-announced flushed bytes; appends may change size/mtime, never file identity. */
export function createNativeLogReader(root:string){
  const identities=new Map<string,Stamp>();
  return (stream:'stdout'|'stderr',offset:number,end:number):Buffer=>{
    if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(end)||offset<0||end<offset||end-offset>65536||end>16*1024*1024)throw new CommandError('INVALID_REQUEST');
    const file=path.join(root,'control',stream+'.bin'),before=inspectNativePath(file,false);if(before.stat.nlink!==1n||before.stat.size<BigInt(end)||before.stat.size>16n*1024n*1024n)throw new CommandError('SOURCE_CHANGED');
    const prior=identities.get(stream);if(prior&&!identity(prior,before.stat))throw new CommandError('SOURCE_CHANGED');
    const fd=fs.openSync(file,'r');try{const opened=fs.fstatSync(fd,{bigint:true});if(!identity(before.stat,opened)||opened.nlink!==1n||opened.size<BigInt(end))throw new CommandError('SOURCE_CHANGED');const bytes=Buffer.alloc(end-offset);let n=0;while(n<bytes.length){const count=fs.readSync(fd,bytes,n,bytes.length-n,offset+n);if(!count)break;n+=count;}const after=inspectNativePath(file,false);if(n!==bytes.length||!identity(before.stat,after.stat)||!identity(before.stat,fs.fstatSync(fd,{bigint:true}))||!sameProjectFolderChain(before.chain,after.chain))throw new CommandError('SOURCE_CHANGED');identities.set(stream,stamp(after.stat));return bytes;}finally{fs.closeSync(fd);}
  };
}
