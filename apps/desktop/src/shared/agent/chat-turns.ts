import type { CloudProviderIdV2 } from './cloud-chat-api';
import type { ProjectReadEvent, ProjectReadSummary, ProjectReadCleanupState } from './agent-project-read';
import {parseNativeEngineFailure,type NativeEngineFailure} from './native-engine-failure';
import {localToolFailureCode,type LocalToolFailureCode} from './local-tool-failure';
import {parseProviderResponseDiagnostic} from './provider-response-diagnostic';

export const CHAT_TURN_PHASES = ['accepted','preparing','running','waiting_question','needs_configuration','needs_review','stopping','completed','failed','cancelled','interrupted'] as const;
export type ChatTurnPhase = typeof CHAT_TURN_PHASES[number];
/** Application conversation identity; never OpenCode's sessionID. */
export type ChatRunOrigin = Readonly<{chatSessionId:string;turnId:string;executionId:string;inputDigest:string}>;
export type ChatAcceptedContext = Readonly<{
  projectId:string;workspaceRevision:number;bindingId:string|null;bindingIdentity:string|null;
  provider:CloudProviderIdV2;model:string;historyVersion:string;
}>;
export type ChatRunLink = Readonly<{runId:string;workspaceId:string|null}>;
export type ChatQuestionInteraction = Readonly<{
  kind:'question';interactionId:string;questionId:string;prompt:string;state:'pending'|'submitted';
}>;
export type ChatConfigurationInteraction = Readonly<{
  kind:'configuration';interactionId:string;
  required:'project_directory'|'command_environment'|'supported_model';
  action:'select_project'|'review_environment'|'select_model';message:string;
}>;
/** A recovery confirmation is a specific existing operation, never a grant of arbitrary execution. */
export type ChatPermissionInteraction = Readonly<{
  kind:'permission';interactionId:string;permissionRequestId:string;operation:'continue_verified_work';
  sourceRunId:string;recoveryVersion:string;message:string;
}>;
export type ChatTurnInteraction = ChatQuestionInteraction | ChatConfigurationInteraction | ChatPermissionInteraction;
export type ChatClarification=Readonly<{questionId:string;prompt:string;answer:string|null;delivered:boolean}>;
export type ChatNativeSession=Readonly<{sessionId:string;conversationId?:string;controller?:import('./agent-work-cycle').WorkCycleControllerRef}>;
/** Latest verified native compaction; hashes identify source and summary without duplicating chat text. */
export type ChatCompactionReceipt=Readonly<{version:number;sourceHash:string;summaryHash:string;coveredResponses:number}>;
/** Main-issued terminal metadata only: no prompt, response body, credentials or tool arguments. */
export type ChatFailureDiagnostic=Readonly<{
  stage:'request_validation'|'upstream_http'|'upstream_transport'|'response_validation'|'tool_validation'|'tool_execution'|'native_engine';
  reason:'CONTEXT_LIMIT'|'UPSTREAM'|'TIMEOUT'|'FIRST_RESPONSE_TIMEOUT'|'IDLE_TIMEOUT'|'PROTOCOL_ERROR'|'AUTHENTICATION_FAILED'|'ENGINE_FAILED';
  providerAttempts:number;httpDispatches:number;httpStatus?:number;
  nativeFailure?:NativeEngineFailure;
  toolFailure?:LocalToolFailureCode;
  responseFailure?:import('./provider-response-diagnostic').ProviderResponseDiagnostic;
}>;
export type ChatTurnExecution = {
  executionId:string;version:number;requestDigest:string;acceptedContext:ChatAcceptedContext;
  phase:ChatTurnPhase;cleanupState:ProjectReadCleanupState;runLink:ChatRunLink|null;
  parentTurnId:string|null;pendingInteraction:ChatTurnInteraction|null;
  interactionReceipts?:ReadonlyArray<Readonly<{requestId:string;interactionId:string;decisionDigest:string;resultTurnId:string|null}>>;
  clarifications?:readonly ChatClarification[];
  nativeSession?:ChatNativeSession;
  compaction?:ChatCompactionReceipt;
  failureDiagnostic?:ChatFailureDiagnostic;
  recoveryConsent?:Readonly<{sourceRunId:string;recoveryVersion:string}>;
  toolScopeRequested?:boolean;
  readOnlyScope?:true;
};
export type ChatActiveTurn = Readonly<{sessionId:string;turnId:string;executionId:string;phase:ChatTurnPhase;cleanupState:ProjectReadCleanupState}>;
export type ChatTurnPart =
  | Readonly<{kind:'text';partId:string;sequence:number;text:string}>
  | Readonly<{kind:'run_event';partId:string;sequence:number;runId:string;event:ProjectReadEvent}>
  | Readonly<{kind:'interaction';partId:string;sequence:number;interaction:ChatTurnInteraction}>
  | Readonly<{kind:'status';partId:string;sequence:number;phase:ChatTurnPhase;cleanupState:ProjectReadCleanupState;message:string}>;
export type ChatTurnActivity = Readonly<{
  sessionId:string;turnId:string;version:number;execution:ChatTurnExecution|null;
  run:ProjectReadSummary|null;parts:readonly ChatTurnPart[];nextSequence:number;hasMore:boolean;
}>;
export type ChatInteractionDecision =
  | Readonly<{kind:'question';questionId:string;answer:string}>
  | Readonly<{kind:'permission';permissionRequestId:string;decision:'allow_once'|'deny'}>
  | Readonly<{kind:'configuration';decision:'retry'|'cancel'}>;
export type ChatTurnActivityRequest = Readonly<{sessionId:string;turnId:string;afterSequence:number}>;
export type ChatTurnInteractionRequest = Readonly<{sessionId:string;turnId:string;interactionId:string;requestId:string;decision:ChatInteractionDecision}>;
export const CHAT_TURN_ACTIVITY_PAGE = 64;
export const CHAT_TURN_ACTIVITY_BYTES = 256 * 1024;

const bad=():never=>{throw TypeError('Invalid chat turn data');};
function object(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)return bad();
  const keys=Reflect.ownKeys(value);if(keys.some(k=>typeof k!=='string'||!required.includes(k)&&!optional.includes(k))||required.some(k=>!Object.hasOwn(value,k)))return bad();
  const out:Record<string,unknown>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d||!d.enumerable||!('value'in d))return bad();out[key]=d.value;}return out;
}
const text=(v:unknown,max:number,empty=false):string=>typeof v==='string'&&new TextEncoder().encode(v).length<=max&&(empty||!!v.trim())&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)?v:bad();
const id=(v:unknown):string=>{const s=text(v,256);return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(s)?s:bad();};
const uuid=(v:unknown):string=>{const s=text(v,36);return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(s)?s:bad();};
const integer=(v:unknown,min=0):number=>typeof v==='number'&&Number.isSafeInteger(v)&&!Object.is(v,-0)&&v>=min?v:bad();
const hash=(v:unknown):string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v)?v:bad();
const nullableId=(v:unknown):string|null=>v===null?null:id(v);
export function parseChatRunOrigin(value:unknown):ChatRunOrigin{const v=object(value,['chatSessionId','turnId','executionId','inputDigest']);return {chatSessionId:uuid(v.chatSessionId),turnId:uuid(v.turnId),executionId:id(v.executionId),inputDigest:hash(v.inputDigest)};}
export function parseChatCompactionReceipt(value:unknown):ChatCompactionReceipt{
 const v=object(value,['version','sourceHash','summaryHash','coveredResponses']);
 return {version:integer(v.version,1),sourceHash:hash(v.sourceHash),summaryHash:hash(v.summaryHash),coveredResponses:integer(v.coveredResponses)};
}
export function parseChatFailureDiagnostic(value:unknown):ChatFailureDiagnostic{
 const v=object(value,['stage','reason','providerAttempts','httpDispatches'],['httpStatus','nativeFailure','toolFailure','responseFailure']);
 if(!['request_validation','upstream_http','upstream_transport','response_validation','tool_validation','tool_execution','native_engine'].includes(v.stage as string)||!['CONTEXT_LIMIT','UPSTREAM','TIMEOUT','FIRST_RESPONSE_TIMEOUT','IDLE_TIMEOUT','PROTOCOL_ERROR','AUTHENTICATION_FAILED','ENGINE_FAILED'].includes(v.reason as string))return bad();
 const native=v.stage==='native_engine',localTool=v.stage==='tool_execution';
 if((native||localTool)!==(v.reason==='ENGINE_FAILED')||native!==Object.hasOwn(v,'nativeFailure')||localTool!==Object.hasOwn(v,'toolFailure')||(native||localTool)&&Object.hasOwn(v,'httpStatus'))return bad();
 const toolFailure=localTool?localToolFailureCode(v.toolFailure):undefined;if(localTool&&!toolFailure)return bad();
 const nativeFailure=native?parseNativeEngineFailure(v.nativeFailure):undefined;
 if(native&&!nativeFailure)return bad();
 const providerAttempts=integer(v.providerAttempts),httpDispatches=integer(v.httpDispatches);if(httpDispatches>providerAttempts)return bad();
 const httpStatus=Object.hasOwn(v,'httpStatus')?integer(v.httpStatus,100):undefined;if(httpStatus!==undefined&&httpStatus>599)return bad();
 const responseFailure=Object.hasOwn(v,'responseFailure')?parseProviderResponseDiagnostic(v.responseFailure):undefined;
 if(responseFailure&&(v.stage!=='response_validation'||v.reason!=='PROTOCOL_ERROR'||httpDispatches<1))return bad();
 return {stage:v.stage as ChatFailureDiagnostic['stage'],reason:v.reason as ChatFailureDiagnostic['reason'],providerAttempts,httpDispatches,...(httpStatus!==undefined?{httpStatus}:{}),...(nativeFailure?{nativeFailure}:{}),...(toolFailure?{toolFailure}:{}),...(responseFailure?{responseFailure}:{})};
}
/** Fixed user-facing descriptions; raw native errors never enter chat history. */
export function nativeChatFailureMessage(failure:NativeEngineFailure):string{
 const stage=String(failure.stage),reason=String(failure.reason);
 const where=stage.startsWith('event_')?'接收引擎实时消息':stage==='message_read'?'读取引擎回复':stage==='text_projection'?'同步回答内容':stage==='snapshot_validate'?'核对引擎会话':stage==='tool_projection'||stage==='tool_callback'?'同步工具结果':stage.startsWith('question_')?'同步引擎提问':stage==='completion_validate'?'核对回答完成状态':'与本地任务引擎通信';
 const why=reason==='timeout'?'超时':reason==='transport'||reason==='stream_closed'?'时连接中断':reason==='text_regression'?'时发现回答内容不一致':reason==='text_after_end'?'时收到结束后的文本':reason==='native_session_error'?'时引擎报告错误':reason==='native_disposed'?'时引擎已退出':reason==='unknown'?'时发生异常':'时数据校验未通过';
 return where+why+'，已保留收到的内容。';
}
export function parseChatClarifications(value:unknown):ChatClarification[]{
 const a=value;if(!Array.isArray(a)||Object.getPrototypeOf(a)!==Array.prototype||a.length>16||Reflect.ownKeys(a).length!==a.length+1)return bad();
 const result=Array.from({length:a.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d||!d.enumerable||!('value'in d))return bad();const q=object(d.value,['questionId','prompt','answer','delivered']);if(typeof q.delivered!=='boolean'||q.delivered&&q.answer===null)return bad();return {questionId:id(q.questionId),prompt:text(q.prompt,4096),answer:q.answer===null?null:text(q.answer,4096),delivered:q.delivered};});
 if(new Set(result.map(q=>q.questionId)).size!==result.length)return bad();return result;
}
export function parseChatTurnInteraction(value:unknown):ChatTurnInteraction{
  if(!value||typeof value!=='object')return bad();const kind=Object.getOwnPropertyDescriptor(value,'kind')?.value;
  if(kind==='question'){const v=object(value,['kind','interactionId','questionId','prompt','state']);if(v.state!=='pending'&&v.state!=='submitted')return bad();return {kind,interactionId:id(v.interactionId),questionId:id(v.questionId),prompt:text(v.prompt,4096),state:v.state};}
  if(kind==='configuration'){const v=object(value,['kind','interactionId','required','action','message']);const pairs={project_directory:'select_project',command_environment:'review_environment',supported_model:'select_model'} as const;
    if(typeof v.required!=='string'||!Object.hasOwn(pairs,v.required)||pairs[v.required as keyof typeof pairs]!==v.action)return bad();return {kind,interactionId:id(v.interactionId),required:v.required as keyof typeof pairs,action:v.action as ChatConfigurationInteraction['action'],message:text(v.message,4096)};}
  if(kind==='permission'){const v=object(value,['kind','interactionId','permissionRequestId','operation','sourceRunId','recoveryVersion','message']);if(v.operation!=='continue_verified_work')return bad();return {kind,interactionId:id(v.interactionId),permissionRequestId:id(v.permissionRequestId),operation:v.operation,sourceRunId:id(v.sourceRunId),recoveryVersion:hash(v.recoveryVersion),message:text(v.message,4096)};}
  return bad();
}
export function parseChatTurnExecution(value:unknown):ChatTurnExecution{
  const v=object(value,['executionId','version','requestDigest','acceptedContext','phase','cleanupState','runLink','parentTurnId','pendingInteraction'],['interactionReceipts','clarifications','nativeSession','compaction','failureDiagnostic','recoveryConsent','toolScopeRequested','readOnlyScope']);
  if(!CHAT_TURN_PHASES.includes(v.phase as ChatTurnPhase)||!['idle','pending','failed'].includes(v.cleanupState as string))return bad();
  const c=object(v.acceptedContext,['projectId','workspaceRevision','bindingId','bindingIdentity','provider','model','historyVersion']);
  if(c.provider!=='deepseek'&&c.provider!=='kimi')return bad();
  const model=text(c.model,100);if(c.provider==='kimi'?model!=='kimi-k3':!['deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(model))return bad();
  if((c.bindingId===null)!==(c.bindingIdentity===null))return bad();
  const acceptedContext:ChatAcceptedContext={projectId:uuid(c.projectId),workspaceRevision:integer(c.workspaceRevision),bindingId:nullableId(c.bindingId),bindingIdentity:c.bindingIdentity===null?null:hash(c.bindingIdentity),provider:c.provider,model,historyVersion:hash(c.historyVersion)};
  let runLink:ChatRunLink|null=null;if(v.runLink!==null){const r=object(v.runLink,['runId','workspaceId']);runLink={runId:id(r.runId),workspaceId:nullableId(r.workspaceId)};}
  const pendingInteraction=v.pendingInteraction===null?null:parseChatTurnInteraction(v.pendingInteraction);
  if(pendingInteraction&&((pendingInteraction.kind==='question'&&v.phase!=='waiting_question'&&v.phase!=='stopping')||(pendingInteraction.kind==='configuration'&&v.phase!=='needs_configuration')||(pendingInteraction.kind==='permission'&&v.phase!=='needs_review')))return bad();
  if(v.phase==='waiting_question'&&pendingInteraction?.kind!=='question'||v.phase==='completed'&&v.cleanupState!=='idle')return bad();
  if(Object.hasOwn(v,'readOnlyScope')&&(v.readOnlyScope!==true||runLink?.workspaceId!==null))return bad();
  if(runLink&&acceptedContext.bindingId===null&&(v.readOnlyScope!==true||runLink.workspaceId!==null))return bad();
  if(Object.hasOwn(v,'toolScopeRequested')&&(typeof v.toolScopeRequested!=='boolean'||runLink&&v.toolScopeRequested===false))return bad();
  let interactionReceipts:NonNullable<ChatTurnExecution['interactionReceipts']>|undefined;
  if(Object.hasOwn(v,'interactionReceipts')){if(!Array.isArray(v.interactionReceipts)||Object.getPrototypeOf(v.interactionReceipts)!==Array.prototype||v.interactionReceipts.length>16||Reflect.ownKeys(v.interactionReceipts).length!==v.interactionReceipts.length+1)return bad();
    interactionReceipts=Array.from({length:v.interactionReceipts.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(v.interactionReceipts,String(i));if(!d||!('value'in d))return bad();const r=object(d.value,['requestId','interactionId','decisionDigest','resultTurnId']);return {requestId:uuid(r.requestId),interactionId:id(r.interactionId),decisionDigest:hash(r.decisionDigest),resultTurnId:r.resultTurnId===null?null:uuid(r.resultTurnId)};});
    if(new Set(interactionReceipts.map(r=>r.requestId)).size!==interactionReceipts.length)return bad();
  }
  let clarifications:ChatClarification[]|undefined,nativeSession:ChatNativeSession|undefined;
  if(Object.hasOwn(v,'clarifications'))clarifications=parseChatClarifications(v.clarifications);
  if(Object.hasOwn(v,'nativeSession')){const n=object(v.nativeSession,['sessionId'],['controller','conversationId']);nativeSession={sessionId:id(n.sessionId),...(Object.hasOwn(n,'conversationId')?{conversationId:uuid(n.conversationId)}:{})};if(Object.hasOwn(n,'controller')){const r=object(n.controller,['guardianId','guardianPid','enginePid','intentVersion','readyVersion']);const guardianPid=integer(r.guardianPid,1),enginePid=integer(r.enginePid,1);if(guardianPid===enginePid||guardianPid>4294967295||enginePid>4294967295)return bad();nativeSession={...nativeSession,controller:{guardianId:uuid(r.guardianId),guardianPid,enginePid,intentVersion:hash(r.intentVersion),readyVersion:hash(r.readyVersion)}};}}
  const compaction=Object.hasOwn(v,'compaction')?parseChatCompactionReceipt(v.compaction):undefined;
  const failureDiagnostic=Object.hasOwn(v,'failureDiagnostic')?parseChatFailureDiagnostic(v.failureDiagnostic):undefined;
  let recoveryConsent:ChatTurnExecution['recoveryConsent'];if(Object.hasOwn(v,'recoveryConsent')){const r=object(v.recoveryConsent,['sourceRunId','recoveryVersion']);recoveryConsent={sourceRunId:id(r.sourceRunId),recoveryVersion:hash(r.recoveryVersion)};}
  return {executionId:id(v.executionId),version:integer(v.version,1),requestDigest:hash(v.requestDigest),acceptedContext,phase:v.phase as ChatTurnPhase,cleanupState:v.cleanupState as ProjectReadCleanupState,runLink,parentTurnId:v.parentTurnId===null?null:uuid(v.parentTurnId),pendingInteraction,...(interactionReceipts?{interactionReceipts}:{}),...(clarifications?{clarifications}:{}),...(nativeSession?{nativeSession}:{}),...(compaction?{compaction}:{}),...(failureDiagnostic?{failureDiagnostic}:{}),...(recoveryConsent?{recoveryConsent}:{}),...(Object.hasOwn(v,'toolScopeRequested')?{toolScopeRequested:v.toolScopeRequested as boolean}:{}),...(v.readOnlyScope===true?{readOnlyScope:true}:{})};
}
export function parseChatInteractionDecision(value:unknown):ChatInteractionDecision{
  if(!value||typeof value!=='object')return bad();const kind=Object.getOwnPropertyDescriptor(value,'kind')?.value;
  if(kind==='question'){const v=object(value,['kind','questionId','answer']);return {kind,questionId:id(v.questionId),answer:text(v.answer,4096)};}
  if(kind==='permission'){const v=object(value,['kind','permissionRequestId','decision']);if(v.decision!=='allow_once'&&v.decision!=='deny')return bad();return {kind,permissionRequestId:id(v.permissionRequestId),decision:v.decision};}
  if(kind==='configuration'){const v=object(value,['kind','decision']);if(v.decision!=='retry'&&v.decision!=='cancel')return bad();return {kind,decision:v.decision};}
  return bad();
}
export function parseChatActiveTurn(value:unknown):ChatActiveTurn{
  const v=object(value,['sessionId','turnId','executionId','phase','cleanupState']);
  if(!CHAT_TURN_PHASES.includes(v.phase as ChatTurnPhase)||!['idle','pending','failed'].includes(v.cleanupState as string))return bad();
  return {sessionId:uuid(v.sessionId),turnId:uuid(v.turnId),executionId:id(v.executionId),phase:v.phase as ChatTurnPhase,cleanupState:v.cleanupState as ProjectReadCleanupState};
}
