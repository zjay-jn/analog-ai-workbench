import {sessionExact} from './chat-sessions';
import {fileNameAllowed,textBytes} from './file-context';

export const DISPLAY_PATH_VERSION='workbench.display-paths.v1' as const;
export const DISPLAY_PATH_LIMIT=2*1024*1024;
export const DISPLAY_PATH_COUNT=512;
export const displayPathChannel=(method:'read'|'remember')=>'workbench.display-paths.'+method+'.v1';
export type DisplayPathRecord={id:string;name:string;segments:string[]};
export type DisplayPathDisk={version:1;records:DisplayPathRecord[]};
export type DisplayPathCode='INVALID_REQUEST'|'CAPABILITY_DENIED'|'STORAGE_ERROR'|'LIMIT'|'CONFLICT';
export type DisplayPathResult={ok:true;records:DisplayPathRecord[]}|{ok:false;error:{code:DisplayPathCode}};
export type DisplayPathRead={contractVersion:typeof DISPLAY_PATH_VERSION;ids:string[]};
export type DisplayPathRemember={contractVersion:typeof DISPLAY_PATH_VERSION;record:DisplayPathRecord};
export type WorkbenchDisplayPathsApi={read:(request:DisplayPathRead)=>Promise<DisplayPathResult>;remember:(request:DisplayPathRemember)=>Promise<DisplayPathResult>};
function bad():never{throw new TypeError('Invalid display path metadata');}
function uuid(v:unknown):string{if(typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v))bad();return v;}
function list<T>(v:unknown,max:number,parse:(item:unknown)=>T):T[]{
 if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype||v.length>max||Reflect.ownKeys(v).length!==v.length+1)bad();
 return Array.from({length:v.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!('value'in d)||!d.enumerable)bad();return parse(d.value);});
}
function unique(ids:string[]){if(new Set(ids).size!==ids.length)bad();}
export function parseDisplayPathRecord(raw:unknown):DisplayPathRecord{
 const v=sessionExact(raw,['id','name','segments']),id=uuid(v.id);
 if(typeof v.name!=='string'||!fileNameAllowed(v.name))bad();
 const segments=list(v.segments,128,item=>{if(typeof item!=='string'||!item||item.length>255||item==='.'||item==='..'||/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u.test(item))bad();return item;});
 if(segments.length<2||segments.join('\\').length>8192||segments.at(-1)!==v.name)bad();
 return {id,name:v.name,segments};
}
export const emptyDisplayPaths=():DisplayPathDisk=>({version:1,records:[]});
export function parseDisplayPathDisk(raw:unknown):DisplayPathDisk{
 const v=sessionExact(raw,['version','records']);if(v.version!==1)bad();
 const records=list(v.records,DISPLAY_PATH_COUNT,parseDisplayPathRecord);unique(records.map(r=>r.id));
 const result:DisplayPathDisk={version:1,records};if(textBytes(JSON.stringify(result))>DISPLAY_PATH_LIMIT)bad();return result;
}
export function parseDisplayPathRead(raw:unknown):DisplayPathRead{
 const v=sessionExact(raw,['contractVersion','ids']);if(v.contractVersion!==DISPLAY_PATH_VERSION)bad();const ids=list(v.ids,8,uuid);unique(ids);return {contractVersion:DISPLAY_PATH_VERSION,ids};
}
export function parseDisplayPathRemember(raw:unknown):DisplayPathRemember{
 const v=sessionExact(raw,['contractVersion','record']);if(v.contractVersion!==DISPLAY_PATH_VERSION)bad();return {contractVersion:DISPLAY_PATH_VERSION,record:parseDisplayPathRecord(v.record)};
}
export const displayPathFailure=(code:DisplayPathCode):DisplayPathResult=>({ok:false,error:{code}});
export function parseDisplayPathResult(raw:unknown):DisplayPathResult{
 if(!raw||typeof raw!=='object')bad();
 const ok=Object.getOwnPropertyDescriptor(raw,'ok');if(!ok||!('value'in ok))bad();
 if(ok.value===true){const v=sessionExact(raw,['ok','records']),records=list(v.records,8,parseDisplayPathRecord);unique(records.map(r=>r.id));return {ok:true,records};}
 const v=sessionExact(raw,['ok','error']),error=sessionExact(v.error,['code']);
 if(v.ok!==false||!['INVALID_REQUEST','CAPABILITY_DENIED','STORAGE_ERROR','LIMIT','CONFLICT'].includes(error.code as string))bad();return displayPathFailure(error.code as DisplayPathCode);
}
