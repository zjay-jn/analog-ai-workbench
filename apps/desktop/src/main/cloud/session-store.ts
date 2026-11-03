import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {parseSessionDisk,SESSION_DISK_LIMIT,type SessionDisk} from '../../shared/agent/chat-sessions';
export class SessionStorageError extends Error{constructor(){super('Session storage unavailable');}}
export type SessionStore={load:()=>SessionDisk;save:(state:SessionDisk)=>void};
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
/** Fixed main-owned application-data directory; no renderer path is accepted. */
export function createSessionStore(root:string,directory:string):SessionStore{
 return createAtomicJsonStore(root,directory,'sessions.json',parseSessionDisk,SESSION_DISK_LIMIT,()=>({version:6,selectedId:null,sessions:[]}));
}
export function createAtomicJsonStore<T>(root:string,directory:string,filename:'sessions.json'|'model-settings.json'|'workspace.json'|'drafts.json'|'paths.json'|'folders.json',parse:(value:unknown)=>T,maxBytes:number,empty:()=>T):{load:()=>T;save:(value:T)=>void}{
 const base=path.resolve(root),folder=path.resolve(directory),relative=path.relative(base,folder);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new SessionStorageError();
 const target=path.join(folder,filename);let expected:string|null|undefined;
 function checkDirectories(create=false){
  const parsed=path.parse(folder);let current=parsed.root;
  for(const part of folder.slice(parsed.root.length).split(path.sep)){
   current=path.join(current,part);if(!fs.existsSync(current)&&create&&path.relative(base,current)!==''&&!path.relative(base,current).startsWith('..'))fs.mkdirSync(current);
   const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new SessionStorageError();
  }
  if(path.resolve(fs.realpathSync(folder)).toLowerCase()!==folder.toLowerCase())throw new SessionStorageError();
 }
 function read():Buffer|null{
  checkDirectories();let before:fs.Stats;
  try{before=fs.lstatSync(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maxBytes)throw new SessionStorageError();
  const fd=fs.openSync(target,'r');try{
   const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.nlink!==1||opened.ino!==before.ino||opened.dev!==before.dev||opened.size>maxBytes)throw new SessionStorageError();
   const buffer=Buffer.alloc(opened.size+1);let length=0,count:number;
   while(length<buffer.length&&(count=fs.readSync(fd,buffer,length,buffer.length-length,null))>0)length+=count;
   const after=fs.lstatSync(target);checkDirectories();
   if(length!==opened.size||after.isSymbolicLink()||after.nlink!==1||after.ino!==opened.ino||after.dev!==opened.dev||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)throw new SessionStorageError();
   return buffer.subarray(0,length);
  }finally{fs.closeSync(fd);}
 }
 function currentDigest(){const data=read();return data===null?null:digest(data);}
 return {
  load(){try{
   checkDirectories(true);const data=read();const result=data===null?empty():parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)));
   expected=data===null?null:digest(data);return result;
  }catch{expected=undefined;throw new SessionStorageError();}},
  save(state){let temporary:string|undefined;try{
   if(expected===undefined)throw new SessionStorageError();const data=Buffer.from(JSON.stringify(parse(state)));if(data.length>maxBytes||currentDigest()!==expected)throw new SessionStorageError();
   temporary=path.join(folder,`.sessions-${randomUUID()}.tmp`);const fd=fs.openSync(temporary,'wx',0o600);
   try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   if(currentDigest()!==expected)throw new SessionStorageError();
   fs.renameSync(temporary,target);temporary=undefined;const next=digest(data);if(currentDigest()!==next)throw new SessionStorageError();expected=next;
  }catch{throw new SessionStorageError();}finally{if(temporary)try{fs.unlinkSync(temporary);}catch{/* A stale private temp is never used as history. */}}},
 };
}
