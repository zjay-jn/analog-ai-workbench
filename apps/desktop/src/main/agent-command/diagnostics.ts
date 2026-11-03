import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {WorkCycleError} from '../agent-work-cycle/types';
import {CommandPreparationError} from './types';
import {COMMAND_PRODUCT,inspectNativePath,nativeRead} from './native-files';
import {commandDiagnosticCauseCode,commandDiagnosticStackFrame,commandDiagnosticVersion,isCommandDiagnosticInput,isCommandDiagnosticRecord,type CommandDiagnosticCauseCode,type CommandDiagnosticInput,type CommandDiagnosticReadResult,type CommandDiagnosticRecord} from '../../shared/agent/command-diagnostics';
export type {CommandDiagnosticInput,CommandDiagnosticReadResult,CommandDiagnosticRecord} from '../../shared/agent/command-diagnostics';
export interface CommandDiagnosticJournal {
 append(input:CommandDiagnosticInput,error?:unknown):CommandDiagnosticRecord|null;
 read(runId:string,executionId:string):CommandDiagnosticReadResult;
 health():Readonly<{available:boolean}>;
}
const errno=new Set(['EACCES','EPERM','ENOENT','EEXIST','ENOSPC','EIO','EBUSY','EMFILE','ENFILE','EROFS','ENOTDIR','EISDIR','EINVAL','EPIPE','ECONNRESET','ETIMEDOUT','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_STREAM_DESTROYED','ERR_STREAM_WRITE_AFTER_END']);
const data=(error:unknown,key:string):unknown=>error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,key)?.value:undefined;
// Node 24 stores Error.stack behind a shared native accessor. Never invoke a replacement accessor.
const nativeStackDescriptor=Object.getOwnPropertyDescriptor(new Error(),'stack');
const nativeStackGetter=nativeStackDescriptor?.get,nativeStackSetter=nativeStackDescriptor?.set;
const initialPrepareStack=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace');
function stackValue(error:Error):unknown {
 const property=Object.getOwnPropertyDescriptor(error,'stack');if(!property)return undefined;if('value'in property)return property.value;
 if(!nativeStackGetter||property.get!==nativeStackGetter||property.set!==nativeStackSetter)return undefined;
 const message=Object.getOwnPropertyDescriptor(error,'message');if(!message||!('value'in message)||typeof message.value!=='string')return undefined;
 const prepare=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace');if(prepare?.value!==initialPrepareStack?.value||prepare?.get!==initialPrepareStack?.get)return undefined;
 for(const key of ['name','message']){let current:object|null=error;while(current){const descriptor=Object.getOwnPropertyDescriptor(current,key);if(descriptor){if(!('value'in descriptor)||typeof descriptor.value!=='string')return undefined;break;}current=Object.getPrototypeOf(current);}}
 return Reflect.apply(nativeStackGetter,error,[]);
}
function cause(error:unknown):CommandDiagnosticCauseCode {
 if(error instanceof CommandPreparationError)return commandDiagnosticCauseCode(data(error,'detailCode'))??'PREPARATION_FAILED';
 if(error instanceof WorkCycleError)return commandDiagnosticCauseCode(data(error,'code'))??'UNKNOWN_ERROR';
 if(error instanceof Error){const code=data(error,'code');if(typeof code==='string'&&errno.has(code))return commandDiagnosticCauseCode(code)!;}
 if(error instanceof SyntaxError)return 'SYNTAX_ERROR';if(error instanceof TypeError)return 'TYPE_ERROR';if(error instanceof RangeError)return 'RANGE_ERROR';return 'UNKNOWN_ERROR';
}
/** Copy only file/line coordinates from our code. Function names and exception messages are excluded. */
function stackFrames(error:unknown):readonly string[]{
 if(!(error instanceof Error))return [];const stack=stackValue(error);if(typeof stack!=='string'||stack.length>65536)return [];
 const root=COMMAND_PRODUCT.replaceAll('\\','/').toLowerCase()+'/',result:string[]=[];
 for(const line of stack.split(/\r?\n/u).slice(1,33)){
  const m=/((?:[A-Za-z]:[\\/])[^()\r\n]+):(\d+):(\d+)\)?$/u.exec(line);if(!m)continue;
  const absolute=m[1]!.replaceAll('\\','/');if(!absolute.toLowerCase().startsWith(root))continue;
  let relative=absolute.slice(root.length);const source=relative.indexOf('/apps/desktop/src/');if(source>=0&&relative.startsWith('.local/'))relative=relative.slice(source+1);
  const frame=relative+':'+m[2]+':'+m[3];if(commandDiagnosticStackFrame(frame)&&!result.includes(frame))result.push(frame);if(result.length===8)break;
 }
 return result;
}
const nodeCode=(e:unknown)=>(e instanceof Error?data(e,'code'):undefined);
/** One main-owned journal; synchronous append/rotation cannot reorder the first failure behind cleanup. */
export function createCommandDiagnosticJournal(options:Readonly<{directory:string;appVersion:string;maxFileBytes?:number;maxFiles?:number;now?:()=>number}>):CommandDiagnosticJournal {
 const directory=path.resolve(options.directory),maxFileBytes=options.maxFileBytes??1024*1024,maxFiles=options.maxFiles??3,now=options.now??Date.now;
 const relative=path.relative(COMMAND_PRODUCT,directory),valid=!!relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&commandDiagnosticVersion(options.appVersion)&&Number.isSafeInteger(maxFileBytes)&&maxFileBytes>=1024&&maxFileBytes<=8*1024*1024&&Number.isInteger(maxFiles)&&maxFiles>=2&&maxFiles<=3;
 let available=valid;
 const file=(index:number)=>path.join(directory,index===0?'diagnostics.jsonl':`diagnostics.${index}.jsonl`);
 function ensure():void {
  const create=(target:string):void=>{try{inspectNativePath(target,true);}catch(e){if(nodeCode(e)!=='ENOENT'||target===COMMAND_PRODUCT)throw e;create(path.dirname(target));fs.mkdirSync(target,{mode:0o700});inspectNativePath(target,true);}};
  if(!valid)throw new Error('Invalid diagnostic location');create(directory);
 }
 function readAll():{records:CommandDiagnosticRecord[];truncated:boolean}{
  const records:CommandDiagnosticRecord[]=[];let truncated=false;
  try{inspectNativePath(directory,true);}catch(e){if(nodeCode(e)==='ENOENT')return {records,truncated};throw e;}
  for(let index=maxFiles-1;index>=0;index--){let bytes:Buffer;try{bytes=nativeRead(file(index),maxFileBytes);}catch(e){if(nodeCode(e)==='ENOENT')continue;throw e;}
   if(index>0)truncated=true;if(bytes.length&&bytes.at(-1)!==10)throw new Error('Incomplete diagnostic record');
   for(const line of bytes.toString('utf8').split('\n')){if(!line)continue;const record:unknown=JSON.parse(line);if(!isCommandDiagnosticRecord(record))throw new Error('Invalid diagnostic record');records.push(record);}
  }
  return {records,truncated};
 }
 function rotate():void {
  inspectNativePath(directory,true);
  const oldest=file(maxFiles-1);try{inspectNativePath(oldest,false);fs.unlinkSync(oldest);}catch(e){if(nodeCode(e)!=='ENOENT')throw e;}
  for(let index=maxFiles-2;index>=0;index--){const source=file(index);try{inspectNativePath(source,false);fs.renameSync(source,file(index+1));}catch(e){if(nodeCode(e)!=='ENOENT')throw e;}}
  inspectNativePath(directory,true);
 }
 return {
  append(input,error){
   try{
    if(!valid||!isCommandDiagnosticInput(input))throw new Error('Invalid diagnostic input');ensure();
    const record:CommandDiagnosticRecord={...input,version:1,id:randomUUID(),time:new Date(now()).toISOString(),appVersion:options.appVersion,causeCode:input.causeCode??(input.kind==='observation'&&error===undefined?'NO_ERROR':cause(error)),nativeCode:input.nativeCode??null,stack:stackFrames(error)};
    if(!isCommandDiagnosticRecord(record))throw new Error('Invalid diagnostic record');const bytes=Buffer.from(JSON.stringify(record)+'\n');if(bytes.length>maxFileBytes)throw new Error('Diagnostic too large');
    // Validate existing bounded history before modifying it; never follow linked log files.
    readAll();let size=0;try{size=Number(inspectNativePath(file(0),false).stat.size);}catch(e){if(nodeCode(e)!=='ENOENT')throw e;}
    if(size+bytes.length>maxFileBytes)rotate();
    const before=fs.existsSync(file(0))?inspectNativePath(file(0),false).stat:null,fd=fs.openSync(file(0),before?'a':'wx',0o600);
    try{const opened=fs.fstatSync(fd,{bigint:true});if(!opened.isFile()||opened.nlink!==1n||before&&(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size))throw new Error('Diagnostic changed');fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);const after=inspectNativePath(file(0),false).stat;if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size+BigInt(bytes.length))throw new Error('Diagnostic changed');}finally{fs.closeSync(fd);}
    available=true;return Object.freeze({...record,stack:Object.freeze([...record.stack])});
   }catch{available=false;return null;}
  },
  read(runId,executionId){
   try{
    if(!valid||!isCommandDiagnosticInput({runId,executionId,component:'controller',operation:'record.save',kind:'observation'}))throw new Error('Invalid diagnostic identity');
    const all=readAll(),matches=all.records.filter(row=>row.runId===runId&&row.executionId===executionId);let records=matches;
    if(matches.length>64){records=matches.slice(-64);const first=matches.find(row=>row.kind==='failure');if(first&&!records.some(row=>row.id===first.id))records=[first,...records.slice(-63)];}
    return {records:structuredClone(records),unavailable:!available,truncated:all.truncated||matches.length>64};
   }catch{available=false;return {records:[],unavailable:true,truncated:true};}
  },
  health:()=>({available}),
 };
}
