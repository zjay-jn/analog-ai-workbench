import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {parseReviewedEdit,type ReviewedEdit,type EditSaveResult,type EditSaveCode} from '../../shared/agent/reviewed-edit';
import {validFileText,fileNameAllowed} from '../../shared/agent/file-context';
class SaveError extends Error{constructor(readonly code:EditSaveCode){super(code);}}
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex'),fail=(code:EditSaveCode):never=>{throw new SaveError(code);};
const same=(a:fs.Stats,b:fs.Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
export function checkReviewedTarget(target:string,name:string):void{
 const resolved=path.resolve(target);
 if(process.platform!=='win32'||!path.isAbsolute(target)||! /^[A-Za-z]:\\/u.test(resolved)||resolved.slice(2).includes(':')||target.startsWith('\\\\')||!fileNameAllowed(path.basename(resolved))||path.basename(resolved).toLowerCase()!==name.toLowerCase())fail('UNSUPPORTED_FILE');
 const lower=resolved.toLowerCase(),parts=lower.split(path.sep);
 if(parts.some(p=>['.git','.codex','.agents','.ssh','.aws','node_modules','windows','program files','program files (x86)','programdata','chat-history','chat-drafts','project-workspace','project-folders','display-paths','model-settings','cloud-user-data','analog_gpt','analog_ai_lab','toolchains','npm-cache'].includes(p)))fail('UNSUPPORTED_FILE');
 let cursor=path.parse(resolved).root;
 for(const part of resolved.slice(cursor.length).split(path.sep)){cursor=path.join(cursor,part);const stat=fs.lstatSync(cursor);if(stat.isSymbolicLink()||(cursor!==resolved&&!stat.isDirectory()))fail('UNSUPPORTED_FILE');}
 if(fs.realpathSync(resolved).toLowerCase()!==lower)fail('UNSUPPORTED_FILE');
}
function read(target:string,name:string){
 checkReviewedTarget(target,name);const before=fs.lstatSync(target);if(!before.isFile()||before.nlink!==1||before.size>256*1024||(before.mode&0o200)===0)fail('UNSUPPORTED_FILE');
 const fd=fs.openSync(target,'r');
 try{
  const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.nlink!==1||!same(before,opened))fail('CONFLICT');
  const bytes=Buffer.alloc(before.size+1);let count=0;while(count<bytes.length){const n=fs.readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
  if(count!==before.size||!same(before,fs.fstatSync(fd)))fail('CONFLICT');
  checkReviewedTarget(target,name);if(!same(before,fs.lstatSync(target)))fail('CONFLICT');return {bytes:bytes.subarray(0,count),stat:before};
 }finally{fs.closeSync(fd);}
}
export function writeReviewedTarget(target:string,request:ReviewedEdit,isCurrent:()=>boolean,hooks?:{beforeCommit?:()=>void}):void{
 let temporary:string|undefined,renamed=false;
 try{
  request=parseReviewedEdit(request);if(!isCurrent())fail('CAPABILITY_DENIED');const source=read(target,request.name);
  let decoded:string;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes);}catch{fail('UNSUPPORTED_FILE');}
  const crlf=decoded!.includes('\r\n');if(/\r(?!\n)/u.test(decoded!)||(crlf&&/(?<!\r)\n/u.test(decoded!)))fail('UNSUPPORTED_FILE');
  const normalized=decoded!.replace(/\r\n/gu,'\n');if(!validFileText(normalized)||normalized!==request.before)fail('CONFLICT');
  const bom=source.bytes.subarray(0,3).equals(Buffer.from([239,187,191])),output=Buffer.from((bom?'\ufeff':'')+(crlf?request.after.replace(/\n/gu,'\r\n'):request.after),'utf8');
  if(output.length>256*1024)fail('UNSUPPORTED_FILE');if(!isCurrent())fail('CAPABILITY_DENIED');
  if(output.equals(source.bytes))return;
  temporary=path.join(path.dirname(target),'.aaw-edit-'+randomUUID()+'.tmp');
  const fd=fs.openSync(temporary,'wx',source.stat.mode&0o777);
  try{fs.writeFileSync(fd,output);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  hooks?.beforeCommit?.();if(!isCurrent())fail('CAPABILITY_DENIED');
  const latest=read(target,request.name);if(!same(source.stat,latest.stat)||hash(source.bytes)!==hash(latest.bytes))fail('CONFLICT');
  fs.renameSync(temporary,target);temporary=undefined;renamed=true;
  const saved=read(target,request.name);if(hash(saved.bytes)!==hash(output))fail('VERIFY_FAILED');
 }catch(error){if(renamed)throw new SaveError('VERIFY_FAILED');throw error instanceof SaveError?error:new SaveError('WRITE_FAILED');}
 finally{if(temporary)try{fs.unlinkSync(temporary);}catch{/* Only this operation's private temp may remain. */}}
}
export function createReviewedSaveHost(chooseFile:(name:string)=>Promise<string|undefined>){
 let busy=false,revoked=false;
 return {revoke(){revoked=true;},async save(value:unknown,isCurrent:()=>boolean):Promise<EditSaveResult>{
  const allowed=()=>!revoked&&isCurrent();if(!allowed())return {ok:false,error:{code:'CAPABILITY_DENIED'}};
  let request:ReviewedEdit;try{request=parseReviewedEdit(value);}catch{return {ok:false,error:{code:'INVALID_REQUEST'}};}
  if(busy)return {ok:false,error:{code:'BUSY'}};busy=true;
  try{const target=await chooseFile(request.name);if(!allowed())fail('CAPABILITY_DENIED');if(!target)return {ok:false,error:{code:'CANCELLED'}};writeReviewedTarget(target,request,allowed);return {ok:true};}
  catch(error){return {ok:false,error:{code:error instanceof SaveError?error.code:'WRITE_FAILED'}};}finally{busy=false;}
 }};
}
