import {sessionExact} from './chat-sessions';import {fileNameAllowed,validFileText,textBytes} from './file-context';
export const EDIT_VERSION='workbench.reviewed-edit.v1' as const,EDIT_CHANNEL='workbench.reviewed-edit.save.v1';
export type ReviewedEdit={contractVersion:typeof EDIT_VERSION;name:string;before:string;after:string};
export type EditSaveCode='INVALID_REQUEST'|'CAPABILITY_DENIED'|'BUSY'|'CANCELLED'|'CONFLICT'|'UNSUPPORTED_FILE'|'WRITE_FAILED'|'VERIFY_FAILED';
export type EditSaveResult={ok:true}|{ok:false;error:{code:EditSaveCode}};
export type WorkbenchEditsApi={saveReviewedEdit:(value:ReviewedEdit)=>Promise<EditSaveResult>};
export function parseReviewedEdit(value:unknown):ReviewedEdit{
 const v=sessionExact(value,['contractVersion','name','before','after']);
 if(v.contractVersion!==EDIT_VERSION||typeof v.name!=='string'||!fileNameAllowed(v.name))throw Error('Invalid reviewed edit');
 for(const key of ['before','after'] as const)if(!validFileText(v[key])||textBytes(v[key])>256*1024||v[key].split('\n').length>10000)throw Error('Invalid reviewed text');
 return v as ReviewedEdit;
}
export function parseEditSaveResult(value:unknown):EditSaveResult{
 if(value&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'ok')?.value===true){sessionExact(value,['ok']);return {ok:true};}
 const v=sessionExact(value,['ok','error']),e=sessionExact(v.error,['code']);if(v.ok!==false||!['INVALID_REQUEST','CAPABILITY_DENIED','BUSY','CANCELLED','CONFLICT','UNSUPPORTED_FILE','WRITE_FAILED','VERIFY_FAILED'].includes(e.code as string))throw Error('Invalid save result');
 return {ok:false,error:{code:e.code as EditSaveCode}};
}
/** Only one complete top-level code fence, with no prose outside, is an editable result. */
export function replacementFromReply(reply:string):string{
 const lines=reply.replace(/\r\n?/gu,'\n').trim().split('\n'),first=/^(`{3,}|~{3,})[A-Za-z0-9._+-]*\s*$/u.exec(lines[0]??'');
 if(!first||lines.length<2)throw Error('Expected one complete code block');const marker=first[1]!,last=lines.at(-1)!;
 if(last!==marker||lines.slice(1,-1).some(line=>new RegExp('^'+marker[0]+'{3,}').test(line)))throw Error('Ambiguous code block');
 const text=lines.slice(1,-1).join('\n');if(!validFileText(text)||textBytes(text)>65536)throw Error('Invalid replacement');return text;
}
export function replaceLineRange(before:string,start:number,end:number,replacement:string):string{
 const lines=before.split('\n');if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end>lines.length||!validFileText(replacement))throw Error('Invalid range');
 const result=[...lines.slice(0,start-1),...(replacement===''?[]:replacement.split('\n')),...lines.slice(end)].join('\n');
 if(textBytes(result)>256*1024||result.split('\n').length>10000)throw Error('Result too large');return result;
}
