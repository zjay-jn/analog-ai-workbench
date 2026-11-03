import {parseSchematicContexts,schematicCanonical,type SchematicContext} from '../schematic/reviewed-schematic';
import {messageTextDefault} from '../schematic/schematic-context';
import {sessionExact,type SessionTurn} from './chat-sessions';
import {parseImages,type ImageAttachment} from './image-attachment';
import {parseFileContexts,validFileText,textBytes,type FileContext} from './file-context';
export const DRAFT_VERSION='workbench.drafts.v2' as const,DRAFT_DISK_LIMIT=16*1024*1024;
export type ChatDraft={text:string;revision:number;images:ImageAttachment[];files:FileContext[];schematics?:SchematicContext[]};
export type DraftRecord={sessionId:string;draft:ChatDraft;pending:{requestId:string;submitted:ChatDraft}|null};
export type DraftDisk={version:1|2;revision:number;records:DraftRecord[]};
export type DraftCode='INVALID_REQUEST'|'CAPABILITY_DENIED'|'CONFLICT'|'STORAGE_ERROR'|'LIMIT';
export type DraftFailure={ok:false;error:{code:DraftCode}};
export type DraftRead={contractVersion:typeof DRAFT_VERSION};
export type DraftSave=DraftRead&{expectedRevision:number;sessionId:string;record:DraftRecord|null};
export type DraftReadResult={ok:true;value:DraftDisk}|DraftFailure;
export type DraftSaveResult={ok:true;revision:number}|DraftFailure;
export type WorkbenchDraftsApi={read:(request:DraftRead)=>Promise<DraftReadResult>;save:(request:DraftSave)=>Promise<DraftSaveResult>};
export const draftChannel=(method:'read'|'save')=>'workbench.drafts.'+method+'.v2';
function bad():never{throw new TypeError('Invalid draft');}
export function draftId(value:unknown):string{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))bad();return value;}
function revision(value:unknown):number{if(!Number.isSafeInteger(value)||(value as number)<0||(value as number)>Number.MAX_SAFE_INTEGER-100)bad();return value as number;}
export const emptyDraft=():ChatDraft=>({text:'',revision:0,images:[],files:[]});
export function parseChatDraft(value:unknown):ChatDraft{const v=sessionExact(value,['text','revision','images','files',...(!!value&&typeof value==='object'&&Object.hasOwn(value,'schematics')?['schematics']:[])]);if(!validFileText(v.text)||v.text.length>16384||textBytes(v.text)>65536)bad();return {text:v.text,revision:revision(v.revision),images:parseImages(v.images),files:parseFileContexts(v.files),...('schematics'in v?{schematics:parseSchematicContexts(v.schematics)}:{})};}
export function parseDraftRecord(value:unknown):DraftRecord{
 const v=sessionExact(value,['sessionId','draft','pending']);let pending:DraftRecord['pending']=null;
 if(v.pending!==null){const p=sessionExact(v.pending,['requestId','submitted']);pending={requestId:draftId(p.requestId),submitted:parseChatDraft(p.submitted)};}
 const result={sessionId:draftId(v.sessionId),draft:parseChatDraft(v.draft),pending};if(pending&&pending.submitted.revision>result.draft.revision)bad();if(textBytes(JSON.stringify(result))>2*1024*1024)bad();return result;
}
export function emptyDraftDisk():DraftDisk{return {version:2,revision:0,records:[]};}
export function parseDraftDisk(value:unknown):DraftDisk{
 const v=sessionExact(value,['version','revision','records']);if((v.version!==1&&v.version!==2)||!Array.isArray(v.records)||Object.getPrototypeOf(v.records)!==Array.prototype||v.records.length>50||Reflect.ownKeys(v.records).length!==v.records.length+1)bad();
 const records=Array.from({length:v.records.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(v.records,String(i));if(!d||!('value'in d))bad();return parseDraftRecord(d.value);});
 if(new Set(records.map(r=>r.sessionId)).size!==records.length)bad();const result:DraftDisk={version:2,revision:revision(v.revision),records};if(textBytes(JSON.stringify(result))>DRAFT_DISK_LIMIT)bad();return result;
}
export function parseDraftRead(value:unknown):DraftRead{const v=sessionExact(value,['contractVersion']);if(v.contractVersion!==DRAFT_VERSION)bad();return {contractVersion:DRAFT_VERSION};}
export function parseDraftSave(value:unknown):DraftSave{const v=sessionExact(value,['contractVersion','expectedRevision','sessionId','record']);if(v.contractVersion!==DRAFT_VERSION)bad();const sessionId=draftId(v.sessionId),record=v.record===null?null:parseDraftRecord(v.record);if(record&&record.sessionId!==sessionId)bad();return {contractVersion:DRAFT_VERSION,sessionId,record,expectedRevision:revision(v.expectedRevision)};}
export const draftFailure=(code:DraftCode):DraftFailure=>({ok:false,error:{code}});
function failure(value:unknown):DraftFailure{const v=sessionExact(value,['ok','error']),e=sessionExact(v.error,['code']);if(v.ok!==false||!['INVALID_REQUEST','CAPABILITY_DENIED','CONFLICT','STORAGE_ERROR','LIMIT'].includes(e.code as string))bad();return draftFailure(e.code as DraftCode);}
export function parseDraftReadResult(value:unknown):DraftReadResult{if(Object.getOwnPropertyDescriptor(value??{},'ok')?.value!==true)return failure(value);const v=sessionExact(value,['ok','value']);return {ok:true,value:parseDraftDisk(v.value)};}
export function parseDraftSaveResult(value:unknown):DraftSaveResult{if(Object.getOwnPropertyDescriptor(value??{},'ok')?.value!==true)return failure(value);const v=sessionExact(value,['ok','revision']);return {ok:true,revision:revision(v.revision)};}
/** Only a precise same-session accepted turn can consume a recovered submission. */
export function submittedTurnMatches(turn:SessionTurn,submitted:ChatDraft):boolean{
 const text=messageTextDefault(submitted.text,submitted.files,submitted.schematics??[]);
 return turn.user===text&&JSON.stringify(turn.images??[])===JSON.stringify(submitted.images)&&JSON.stringify(turn.files??[])===JSON.stringify(submitted.files)&&schematicCanonical(turn.schematics??[])===schematicCanonical(submitted.schematics??[]);
}
