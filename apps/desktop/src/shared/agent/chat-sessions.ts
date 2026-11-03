import {parseSchematicContexts,type SchematicContext} from '../schematic/reviewed-schematic';
import {MAX_REPLY_BYTES,parseReplyLimits,parseTurnTimeoutMs,type ChatTurnLimits} from './reply-limits';
import type {CloudProviderIdV2} from './cloud-chat-api';
import {parseFileContexts,type FileContext} from './file-context';
import {defaultModel,modelOption} from './model-options';import {parseImages,type ImageAttachment} from './image-attachment';
import {parseChatTurnExecution,parseChatInteractionDecision,parseChatActiveTurn,type ChatTurnExecution,type ChatActiveTurn,type ChatTurnActivity,type ChatTurnActivityRequest,type ChatTurnInteractionRequest} from './chat-turns';
import {parseChatTurnActivity} from './chat-turn-activity';
export type {ChatTurnExecution,ChatActiveTurn,ChatTurnActivity,ChatTurnPhase,ChatTurnPart,ChatTurnInteraction,ChatInteractionDecision} from './chat-turns';
export const SESSION_VERSION='workbench.sessions.v6' as const;
export const SESSION_METHODS=['readState','createSession','selectSession','renameSession','deleteSession','sendMessage','cancelReply','setSessionModel','readTurnActivity','answerInteraction'] as const;
export type SessionMethod=typeof SESSION_METHODS[number];
export const sessionChannel=(method:SessionMethod)=>`workbench.sessions.${method}.v6`;
export type SessionError='INVALID_REQUEST'|'CAPABILITY_DENIED'|'NOT_FOUND'|'BUSY'|'LIMIT'|'CONFLICT'|'CONTEXT_LIMIT'|'NOT_CONFIGURED'|'CONFIGURATION_REQUIRED'|'CONFIGURATION_UNAVAILABLE'|'STORAGE_ERROR'|'SCHEMATIC_UNAVAILABLE'|'INTERNAL';
export type SessionTurn={id:string;user:string;assistant:string;status:'running'|'completed'|'failed'|'cancelled'|'interrupted';error:string;stopReason?:'output_limit'|'receive_limit'|'first_response_timeout'|'idle_timeout'|'total_timeout'|'turn_timeout'|'incomplete_stream'|'unavailable';limits?:ChatTurnLimits;continueFrom?:string;elapsedMs?:number;images?:ImageAttachment[];files?:FileContext[];schematics?:SchematicContext[];provider?:CloudProviderIdV2;model?:string;execution?:ChatTurnExecution};
export type ChatSession={id:string;title:string;provider:CloudProviderIdV2;model?:string;createdAt:string;updatedAt:string;turns:SessionTurn[]};
export type SessionSummary=Omit<ChatSession,'turns'>;
export type SessionDisk={version:1|2|3|4|5|6;selectedId:string|null;sessions:ChatSession[]};
export type SessionState={revision:number;selectedId:string|null;sessions:SessionSummary[];selected:ChatSession|null;runningSessionId:string|null;activeTurn?:ChatActiveTurn|null;storage:'saved'|'saving'|'error';configured:Record<CloudProviderIdV2,boolean>;capabilities?:{filesystemRead:boolean}};
export type SessionFailure={ok:false;error:{code:SessionError}};
export type SessionResult={ok:true;value:SessionState}|SessionFailure;
export type SessionMethodResult<M extends SessionMethod>=M extends 'readTurnActivity'?{ok:true;value:ChatTurnActivity}|SessionFailure:SessionResult;
type Base={contractVersion:typeof SESSION_VERSION};
export type SessionRequests={readState:Base;createSession:Base&{provider:CloudProviderIdV2;title:string;model?:string};selectSession:Base&{sessionId:string};renameSession:Base&{sessionId:string;title:string};deleteSession:Base&{sessionId:string};sendMessage:Base&{sessionId:string;requestId:string;text:string;continueFrom?:string;followUp?:{fromTurnId:string;expectedTurnVersion:number};images?:ImageAttachment[];files?:FileContext[];schematics?:SchematicContext[]};cancelReply:Base&{sessionId:string;turnId:string};setSessionModel:Base&{sessionId:string;provider:CloudProviderIdV2;model:string};readTurnActivity:Base&ChatTurnActivityRequest;answerInteraction:Base&ChatTurnInteractionRequest};
export type WorkbenchSessionsApi={readonly [M in SessionMethod]:(request:SessionRequests[M])=>Promise<SessionMethodResult<M>>};
export const SESSION_DISK_LIMIT=8*1024*1024,SESSION_SIZE_LIMIT=2*1024*1024;
function bad():never{throw new TypeError('Invalid session data');}
export function sessionExact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length)bad();
 const result:Record<string,unknown>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)bad();result[key]=d.value;}return result;
}
function array<T>(value:unknown,max:number,parse:(value:unknown)=>T):T[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max||Reflect.ownKeys(value).length!==value.length+1)bad();
 return Array.from({length:value.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d))bad();return parse(d.value);});
}
const bytes=(text:string)=>new TextEncoder().encode(text).length;
function text(value:unknown,max:number,nonempty=false):string{if(typeof value!=='string'||bytes(value)>max||(nonempty&&!value.trim())||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))bad();return value;}
function id(value:unknown):string{const v=text(value,36);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v))bad();return v;}
function provider(value:unknown):CloudProviderIdV2{if(value!=='deepseek'&&value!=='kimi')bad();return value;}
function date(value:unknown):string{const v=text(value,24);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v)||!Number.isFinite(Date.parse(v)))bad();return v;}
function title(value:unknown):string{const v=text(value,240,true);if(/[\r\n\u0000-\u001f]/u.test(v))bad();return v;}
const has=(value:unknown,key:string)=>!!value&&typeof value==='object'&&Object.hasOwn(value,key);
function summary(value:unknown):SessionSummary{const v=sessionExact(value,['id','title','provider','createdAt','updatedAt',...(has(value,'model')?['model']:[])]);const selected=provider(v.provider),model=has(value,'model')?text(v.model,100):defaultModel(selected);modelOption(selected,model);return {id:id(v.id),title:title(v.title),provider:selected,model,createdAt:date(v.createdAt),updatedAt:date(v.updatedAt)};}
function turn(value:unknown):SessionTurn{
 const v=sessionExact(value,['id','user','assistant','status','error',...(has(value,'stopReason')?['stopReason']:[]),...(has(value,'limits')?['limits']:[]),...(has(value,'continueFrom')?['continueFrom']:[]),...(has(value,'elapsedMs')?['elapsedMs']:[]),...(has(value,'images')?['images']:[]),...(has(value,'files')?['files']:[]),...(has(value,'schematics')?['schematics']:[]),...(has(value,'execution')?['execution']:[]),...(has(value,'provider')||has(value,'model')?['provider','model']:[])]);if(!['running','completed','failed','cancelled','interrupted'].includes(v.status as string))bad();
 if(has(value,'stopReason')&&!['output_limit','receive_limit','first_response_timeout','idle_timeout','total_timeout','turn_timeout','incomplete_stream','unavailable'].includes(v.stopReason as string))bad();
 let limits:ChatTurnLimits|undefined;if(has(value,'limits')){const l=sessionExact(v.limits,['maxOutputTokens','requestTimeoutMs','turnTimeoutMs']),request=parseReplyLimits(l.maxOutputTokens,l.requestTimeoutMs);limits={maxOutputTokens:request.maxOutputTokens,requestTimeoutMs:request.timeoutMs,turnTimeoutMs:l.turnTimeoutMs===null?null:parseTurnTimeoutMs(l.turnTimeoutMs)};}
 const attribution=has(value,'provider')?{provider:provider(v.provider),model:text(v.model,100)}:undefined;if(attribution)modelOption(attribution.provider,attribution.model);
 if(has(value,'elapsedMs')&&(!Number.isSafeInteger(v.elapsedMs)||(v.elapsedMs as number)<0||(v.elapsedMs as number)>86400000))bad();
 const files=parseFileContexts(v.files??[]),schematics=parseSchematicContexts(v.schematics??[]),result={id:id(v.id),user:text(v.user,16384,true),assistant:text(v.assistant,MAX_REPLY_BYTES),status:v.status as SessionTurn['status'],error:text(v.error,240),...(has(value,'stopReason')?{stopReason:v.stopReason as NonNullable<SessionTurn['stopReason']>}:{}),...(has(value,'continueFrom')?{continueFrom:id(v.continueFrom)}:{}),...(has(value,'elapsedMs')?{elapsedMs:v.elapsedMs as number}:{}),images:parseImages(v.images??[]),...(files.length?{files}:{}),...(schematics.length?{schematics}:{}),...attribution};
 const execution=has(value,'execution')?parseChatTurnExecution(v.execution):undefined;
 if(execution){if(!attribution||attribution.provider!==execution.acceptedContext.provider||attribution.model!==execution.acceptedContext.model)bad();
  const expected=execution.phase==='completed'?'completed':execution.phase==='cancelled'?'cancelled':execution.phase==='interrupted'?'interrupted':['failed','needs_configuration','needs_review'].includes(execution.phase)?'failed':'running';
  if(result.status!==expected||execution.phase==='completed'&&execution.cleanupState!=='idle')bad();
 }
 if(result.status==='completed'&&!result.assistant.trim()&&!execution?.runLink)bad();return {...result,...(limits?{limits}:{}),...(execution?{execution}:{})};
}
export function parseChatSession(value:unknown):ChatSession{
 const v=sessionExact(value,['id','title','provider','createdAt','updatedAt','turns',...(has(value,'model')?['model']:[])]);const {turns,...rest}=v;const result={...summary(rest),turns:array(turns,Infinity,turn)};
 const seen=new Set<string>(),executions=new Set<string>(),runs=new Set<string>();for(const t of result.turns){if(t.continueFrom&&!seen.has(t.continueFrom)||t.execution?.parentTurnId&&!seen.has(t.execution.parentTurnId))bad();if(t.execution){if(executions.has(t.execution.executionId))bad();executions.add(t.execution.executionId);if(t.execution.runLink){if(runs.has(t.execution.runLink.runId))bad();runs.add(t.execution.runLink.runId);}}seen.add(t.id);}
 if(result.turns.some(t=>(t.images?.length??0)>0&&!modelOption(t.provider??result.provider,t.model??result.model!).vision))bad();
 if(new Set(result.turns.map(t=>t.id)).size!==result.turns.length||bytes(JSON.stringify(result))>SESSION_SIZE_LIMIT)bad();return result;
}
export function parseSessionDisk(value:unknown):SessionDisk{
 const v=sessionExact(value,['version','selectedId','sessions']);if(v.version!==1&&v.version!==2&&v.version!==3&&v.version!==4&&v.version!==5&&v.version!==6)bad();
 if(v.version===2)array(v.sessions,50,row=>{if(!row||typeof row!=='object')bad();array(Object.getOwnPropertyDescriptor(row,'turns')?.value,100,t=>{if(has(t,'files'))bad();return t;});return row;});
 if(v.version===1)array(v.sessions,50,row=>{const old=sessionExact(row,['id','title','provider','createdAt','updatedAt','turns']);array(old.turns,100,t=>sessionExact(t,['id','user','assistant','status','error']));return row;});
 const sessions=array(v.sessions,50,parseChatSession),selectedId=v.selectedId===null?null:id(v.selectedId);
 if(new Set(sessions.map(s=>s.id)).size!==sessions.length||(selectedId!==null&&!sessions.some(s=>s.id===selectedId)))bad();
 const turns=sessions.flatMap(s=>s.turns),executionIds=turns.flatMap(t=>t.execution?[t.execution.executionId]:[]),runIds=turns.flatMap(t=>t.execution?.runLink?[t.execution.runLink.runId]:[]);
 if(new Set(turns.map(t=>t.id)).size!==turns.length||new Set(executionIds).size!==executionIds.length||new Set(runIds).size!==runIds.length)bad();
 const result:SessionDisk={version:6,selectedId,sessions};if(bytes(JSON.stringify(result))>SESSION_DISK_LIMIT)bad();return result;
}
export function parseSessionRequest<M extends SessionMethod>(method:M,value:unknown):SessionRequests[M]{
 const keys={readState:[],createSession:['provider','title'],selectSession:['sessionId'],renameSession:['sessionId','title'],deleteSession:['sessionId'],sendMessage:['sessionId','requestId','text'],cancelReply:['sessionId','turnId'],setSessionModel:['sessionId','provider','model'],readTurnActivity:['sessionId','turnId','afterSequence'],answerInteraction:['sessionId','turnId','interactionId','requestId','decision']}[method];
 const v=sessionExact(value,['contractVersion',...keys,...(method==='createSession'&&has(value,'model')?['model']:[]),...(method==='sendMessage'&&has(value,'continueFrom')?['continueFrom']:[]),...(method==='sendMessage'&&has(value,'followUp')?['followUp']:[]),...(method==='sendMessage'&&has(value,'images')?['images']:[]),...(method==='sendMessage'&&has(value,'files')?['files']:[]),...(method==='sendMessage'&&has(value,'schematics')?['schematics']:[])]);if(v.contractVersion!==SESSION_VERSION)bad();
 const natural=(value:unknown,min=0)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||Object.is(value,-0)||value<min)bad();return value;};
 const extra:Record<string,unknown>={};if('turnId'in v)extra.turnId=id(v.turnId);if('afterSequence'in v)extra.afterSequence=natural(v.afterSequence);
 if('interactionId'in v){const key=text(v.interactionId,256,true);if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(key))bad();extra.interactionId=key;extra.decision=parseChatInteractionDecision(v.decision);}
 if('followUp'in v){if('continueFrom'in v)bad();const f=sessionExact(v.followUp,['fromTurnId','expectedTurnVersion']);extra.followUp={fromTurnId:id(f.fromTurnId),expectedTurnVersion:natural(f.expectedTurnVersion,1)};}
 const result:Record<string,unknown>={contractVersion:SESSION_VERSION,...extra};if('sessionId'in v)result.sessionId=id(v.sessionId);if('provider'in v){result.provider=provider(v.provider);if('model'in v){result.model=text(v.model,100);modelOption(result.provider as CloudProviderIdV2,result.model as string);}}if('title'in v)result.title=title(v.title);if('requestId'in v)result.requestId=id(v.requestId);if('continueFrom'in v)result.continueFrom=id(v.continueFrom);if('text'in v){result.images=parseImages(v.images??[]);result.files=parseFileContexts(v.files??[]);if('schematics'in v)result.schematics=parseSchematicContexts(v.schematics);result.text=text(v.text,16384,(result.images as ImageAttachment[]).length===0&&(result.files as FileContext[]).length===0&&!(result.schematics as SchematicContext[]|undefined)?.length);}return result as SessionRequests[M];
}
export const sessionFailure=(code:SessionError):SessionFailure=>({ok:false,error:{code}});
export function parseSessionResult(value:unknown):SessionResult{
 if(value&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'ok')?.value===false){const v=sessionExact(value,['ok','error']),e=sessionExact(v.error,['code']);if(!['INVALID_REQUEST','CAPABILITY_DENIED','NOT_FOUND','BUSY','LIMIT','CONFLICT','CONTEXT_LIMIT','NOT_CONFIGURED','CONFIGURATION_REQUIRED','CONFIGURATION_UNAVAILABLE','STORAGE_ERROR','SCHEMATIC_UNAVAILABLE','INTERNAL'].includes(e.code as string))bad();return sessionFailure(e.code as SessionError);}
 const envelope=sessionExact(value,['ok','value']);if(envelope.ok!==true)bad();const v=sessionExact(envelope.value,['revision','selectedId','sessions','selected','runningSessionId','storage','configured',...(has(envelope.value,'activeTurn')?['activeTurn']:[]),...(has(envelope.value,'capabilities')?['capabilities']:[])]);
 if(!Number.isSafeInteger(v.revision)||(v.revision as number)<0||!['saved','saving','error'].includes(v.storage as string))bad();
 const configured=sessionExact(v.configured,['deepseek','kimi']);if(typeof configured.deepseek!=='boolean'||typeof configured.kimi!=='boolean')bad();
 const sessions=array(v.sessions,50,summary),selected=v.selected===null?null:parseChatSession(v.selected),selectedId=v.selectedId===null?null:id(v.selectedId),runningSessionId=v.runningSessionId===null?null:id(v.runningSessionId);
 if(new Set(sessions.map(s=>s.id)).size!==sessions.length||selectedId!==(selected?.id??null)||(selected&&!sessions.some(s=>s.id===selected.id&&s.provider===selected.provider&&s.model===selected.model&&s.title===selected.title))||(runningSessionId&&!sessions.some(s=>s.id===runningSessionId)))bad();
 const activeTurn=v.activeTurn==null?null:parseChatActiveTurn(v.activeTurn);if(activeTurn&&(activeTurn.sessionId!==runningSessionId||selected?.id===activeTurn.sessionId&&!selected.turns.some(t=>t.id===activeTurn.turnId&&t.execution?.executionId===activeTurn.executionId&&t.execution.phase===activeTurn.phase&&t.execution.cleanupState===activeTurn.cleanupState)))bad();
 let capabilities:SessionState['capabilities'];if(has(v,'capabilities')){const c=sessionExact(v.capabilities,['filesystemRead']);if(typeof c.filesystemRead!=='boolean')bad();capabilities={filesystemRead:c.filesystemRead as boolean};}
 return {ok:true,value:{revision:v.revision as number,selectedId,sessions,selected,runningSessionId,activeTurn,storage:v.storage as SessionState['storage'],configured:configured as Record<CloudProviderIdV2,boolean>,...(capabilities?{capabilities}:{})}};
}
export function parseSessionMethodResult<M extends SessionMethod>(method:M,value:unknown):SessionMethodResult<M>{
 if(method!=='readTurnActivity'||value&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'ok')?.value===false)return parseSessionResult(value) as SessionMethodResult<M>;
 const envelope=sessionExact(value,['ok','value']);if(envelope.ok!==true)bad();return {ok:true,value:parseChatTurnActivity(envelope.value)} as SessionMethodResult<M>;
}
