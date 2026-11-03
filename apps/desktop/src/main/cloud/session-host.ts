import {randomUUID,createHash} from 'node:crypto';
import {localToolFailureMessage} from '../../shared/agent/local-tool-failure';
import {CONTINUE_TEXT,continuationSource,completedHistory} from '../../shared/agent/continuation';
import {messageContextFits,messageTextDefault} from '../../shared/schematic/schematic-context';
import type {SchematicContext} from '../../shared/schematic/reviewed-schematic';
class SchematicReferenceError extends Error {}
import {parseReplyLimits,resolveChatTurnLimits,LEGACY_REPLY_LIMITS,replyBodyBytes,type ReplyLimits,type ChatReplyLimits} from '../../shared/agent/reply-limits';
import {CloudChatErrorV1,CLOUD_CHAT_LIMITS_V1} from '../../../../../packages/agent-adapters/src/cloud-chat-contract';
import {createAgentCallerFenceV1,type AgentCallerContextV1} from '../agent/agent-caller-fence';
import {buildCloudContextV2,splitCloudDeltaV2} from './cloud-budget';
import {buildMultimodalContext,selectMultimodalHistory,type MultimodalExecutor} from './multimodal-context';import {defaultModel,modelOption} from '../../shared/agent/model-options';import type {ImageAttachment} from '../../shared/agent/image-attachment';
import type {CloudExecutorV2} from './cloud-host';import type {SessionStore} from './session-store';
import {parseSessionRequest,parseSessionDisk,parseSessionResult,sessionFailure,SESSION_DISK_LIMIT,SESSION_SIZE_LIMIT,SESSION_VERSION,type SessionMethod,type SessionMethodResult,type SessionRequests,type SessionResult,type SessionState,type SessionDisk,type SessionTurn,type ChatSession} from '../../shared/agent/chat-sessions';
import {parseChatTurnExecution,nativeChatFailureMessage,type ChatTurnExecution,type ChatConfigurationInteraction,type ChatFailureDiagnostic} from '../../shared/agent/chat-turns';
import {buildUnifiedChatContext,UnifiedChatContextError} from './unified-chat-context';
import {parseProjectReadModel} from '../../shared/agent/agent-project-model';
import {UnifiedChatConfigurationError,type UnifiedChatService,type UnifiedChatExecutionUpdate} from './unified-chat-service';
type Active={startedAt:number;sessionId:string;turn:SessionTurn;abort:AbortController;chunks:number;limits:ReplyLimits;stopCause?:'user'|'failure';deadline:ReturnType<typeof setTimeout>|undefined};
const size=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
export function createSessionHost(options:{owner:AgentCallerContextV1;store:SessionStore;configured:SessionState['configured']|(()=>SessionState['configured']);execute:CloudExecutorV2;executeMultimodal?:MultimodalExecutor;defaultModel?:(provider:'deepseek'|'kimi')=>string;replyLimits?:(provider:'deepseek'|'kimi')=>ChatReplyLimits;validateImages?:(images:ImageAttachment[])=>void;validateSchematicContexts?:(sessionId:string,contexts:readonly SchematicContext[])=>void;turns?:UnifiedChatService}){
 const fence=createAgentCallerFenceV1({caller:options.owner,capabilities:['start_turn','subscribe_run','cancel_run'],generation:1});
 let disk:SessionDisk={version:6,selectedId:null,sessions:[]},storage:SessionState['storage']='saved',revision=0,revoked=false,active:Active|undefined,saveTimer:ReturnType<typeof setTimeout>|undefined;
 let retryAdmission:{sourceId:string;receipt:NonNullable<ChatTurnExecution['interactionReceipts']>[number];recoveryConsent?:ChatTurnExecution['recoveryConsent'];configuration?:ChatConfigurationInteraction}|undefined;
 const configured=()=>typeof options.configured==='function'?options.configured():options.configured;
 const requests=new Map<string,{sessionId:string;digest:string}>();
 const bump=()=>{revision++;};
 function flush(){if(saveTimer){clearTimeout(saveTimer);saveTimer=undefined;}if(storage==='error')return;try{options.store.save(disk);storage='saved';}catch{storage='error';}bump();}
 const statusFor=(phase:ChatTurnExecution['phase']):SessionTurn['status']=>phase==='completed'?'completed':phase==='cancelled'?'cancelled':phase==='interrupted'?'interrupted':['failed','needs_configuration','needs_review'].includes(phase)?'failed':'running';
 try{const loaded=parseSessionDisk(options.store.load());for(const session of loaded.sessions)for(const turn of session.turns)options.validateImages?.(turn.images??[]);disk=loaded;let recovered=false;for(const session of disk.sessions)for(const turn of session.turns){if(turn.execution){const before=JSON.stringify(turn);turn.execution=options.turns?.reconcile(session.id,turn)??{...turn.execution,phase:turn.status==='running'?'interrupted':turn.execution.phase,cleanupState:turn.status==='running'?'failed':turn.execution.cleanupState,pendingInteraction:turn.status==='running'?null:turn.execution.pendingInteraction};turn.status=statusFor(turn.execution.phase);if(before!==JSON.stringify(turn))recovered=true;}if(turn.status==='running'){turn.status='interrupted';if(turn.execution)turn.execution={...turn.execution,phase:'interrupted',cleanupState:'failed',pendingInteraction:null,version:turn.execution.version+1};turn.error='上次退出时回复尚未完成，已保留收到的内容。';recovered=true;}}if(recovered)flush();}catch{storage='error';}
 function state():SessionResult{const e=active?.turn.execution;return parseSessionResult({ok:true,value:{revision,selectedId:disk.selectedId,sessions:disk.sessions.map(({turns,...summary})=>summary),selected:disk.sessions.find(s=>s.id===disk.selectedId)??null,runningSessionId:active?.sessionId??null,activeTurn:active&&e?{sessionId:active.sessionId,turnId:active.turn.id,executionId:e.executionId,phase:e.phase,cleanupState:e.cleanupState}:null,storage,configured:configured(),capabilities:{filesystemRead:options.turns?.filesystemRead===true}}});}
  function commit(next:SessionDisk):boolean{if(storage==='error')return false;try{options.store.save(next);disk=next;storage='saved';if(saveTimer){clearTimeout(saveTimer);saveTimer=undefined;}bump();return true;}catch{storage='error';bump();return false;}}
 function saveResult(next:SessionDisk):SessionResult{
  const reserve=active?Math.max(0,replyBodyBytes(active.limits.maxOutputTokens)-Buffer.byteLength(active.turn.assistant))*6+2048:0;
  if(size(next)+reserve>SESSION_DISK_LIMIT||next.sessions.some(s=>size(s)+(active?.sessionId===s.id?reserve:0)>SESSION_SIZE_LIMIT))return sessionFailure('LIMIT');
  return commit(next)?state():sessionFailure('STORAGE_ERROR');
 }
 function changed(){if(storage!=='error'){storage='saving';if(!saveTimer)saveTimer=setTimeout(()=>{saveTimer=undefined;flush();},1000);}bump();}
 function updateExecution(run:Active,patch:UnifiedChatExecutionUpdate):void{
  if(active!==run||!run.turn.execution)throw Error('Stale chat execution');
  const prior=run.turn.execution,candidate={...prior,...patch,version:prior.version+1};if(candidate.runLink?.workspaceId&&candidate.acceptedContext.bindingId!==null)delete candidate.readOnlyScope;const next=parseChatTurnExecution(candidate);
  if(prior.runLink&&(next.runLink?.runId!==prior.runLink.runId||prior.runLink.workspaceId!==null&&next.runLink.workspaceId!==prior.runLink.workspaceId))throw Error('Changed chat run');
  if(prior.nativeSession&&JSON.stringify(prior.nativeSession)!==JSON.stringify(next.nativeSession))throw Error('Changed native session');
  if(prior.failureDiagnostic&&JSON.stringify(prior.failureDiagnostic)!==JSON.stringify(next.failureDiagnostic))throw Error('Changed terminal failure diagnostic');
  const before=prior.compaction,after=next.compaction;
  if(before&&(!after||after.version<before.version||after.coveredResponses<before.coveredResponses||after.version===before.version&&JSON.stringify(after)!==JSON.stringify(before))||after&&after.version>(before?.version??0)+1)throw Error('Changed compaction receipt');
  if(prior.toolScopeRequested===true&&next.toolScopeRequested!==true)throw Error('Changed scope preparation receipt');
  for(const q of prior.clarifications??[]){const nextQuestion=next.clarifications?.find(n=>n.questionId===q.questionId);if(!nextQuestion||nextQuestion.prompt!==q.prompt||q.answer!==null&&nextQuestion.answer!==q.answer||q.delivered&&!nextQuestion.delivered)throw Error('Changed clarification receipt');}
  run.turn.execution=next;run.turn.status=statusFor(next.phase);changed();flush();if(storage==='error'){run.abort.abort();throw Error('Chat receipt not durable');}
 }
 function finish(run:Active,status:SessionTurn['status'],error=''){
  if(revoked||active!==run)return;run.turn.status=status;run.turn.error=error;run.turn.elapsedMs=Math.min(86400000,Math.max(0,Math.round(performance.now()-run.startedAt)));const session=disk.sessions.find(s=>s.id===run.sessionId);if(session)session.updatedAt=new Date().toISOString();
  if(run.deadline)clearTimeout(run.deadline);active=undefined;changed();flush();run.abort.abort();
 }
 const stopReason=(error:unknown):NonNullable<SessionTurn['stopReason']>=>{const code=error instanceof CloudChatErrorV1?error.code:'';return code==='OUTPUT_LIMIT'?'output_limit':code==='RESPONSE_LIMIT'?'receive_limit':code==='FIRST_RESPONSE_TIMEOUT'?'first_response_timeout':code==='IDLE_TIMEOUT'?'idle_timeout':code==='TIMEOUT'?'total_timeout':code==='PROTOCOL_ERROR'?'incomplete_stream':'unavailable';};
 function stopDeadline(run:Active){if(run.deadline!==undefined)clearTimeout(run.deadline);run.deadline=undefined;}
 const failRun=(run:Active,error:unknown,turnTimeout=false)=>{if(active!==run||revoked||run.stopCause)return;run.stopCause='failure';stopDeadline(run);run.turn.stopReason=turnTimeout?'turn_timeout':stopReason(error);run.turn.error=turnTimeout?'整轮任务超过'+run.turn.limits!.turnTimeoutMs!/1000+'秒上限，已停止执行并保留收到的内容。':errorText(error,run.limits,run.turn.execution?.failureDiagnostic);if(run.turn.execution&&options.turns){try{updateExecution(run,{...run.turn.execution,phase:'stopping',cleanupState:'pending',pendingInteraction:null});}catch{storage='error';}finally{run.abort.abort();}return;}finish(run,'failed',run.turn.error);};
 const errorText=(error:unknown,budget=LEGACY_REPLY_LIMITS,diagnostic?:ChatFailureDiagnostic)=>{
  if(error instanceof UnifiedChatContextError)return 'CONTEXT_LIMIT：完整会话或工具结果超过本次上下文容量；未截断历史。请另开会话或缩小任务范围。';
  if(error instanceof SchematicReferenceError)return '原理图引用已失效或会话已移至其他项目，本次请求未发送。请重新预览选择或使用新会话。';
  const code=error instanceof CloudChatErrorV1?error.code:'';
  if(diagnostic){
   if(diagnostic.stage==='native_engine'&&diagnostic.nativeFailure)return nativeChatFailureMessage(diagnostic.nativeFailure);
   if(diagnostic.stage==='tool_execution'&&diagnostic.toolFailure)return localToolFailureMessage(diagnostic.toolFailure);
   const http=diagnostic.httpStatus!==undefined?'（HTTP '+diagnostic.httpStatus+'）':'';
   if(diagnostic.reason==='AUTHENTICATION_FAILED')return '模型服务拒绝凭据'+http+'，请检查模型设置。';
   if(diagnostic.stage==='upstream_http'&&(diagnostic.reason==='PROTOCOL_ERROR'||diagnostic.reason==='UPSTREAM'))return '模型服务返回错误'+http+'，本次请求未完成。';
   if(diagnostic.stage==='request_validation'&&diagnostic.reason==='PROTOCOL_ERROR')return '本地模型适配校验未通过，当前请求未发送到模型服务。';
   if(diagnostic.stage==='response_validation'&&diagnostic.reason==='PROTOCOL_ERROR')return '已连接模型服务，但返回内容未通过本地响应校验。';
   if(diagnostic.stage==='tool_validation'&&diagnostic.reason==='PROTOCOL_ERROR')return '工具调用未通过本地校验，本轮执行已停止。';
   if(diagnostic.stage==='upstream_transport'&&diagnostic.reason==='UPSTREAM')return '模型服务连接或传输失败，请稍后手动发送。';
  }
  return code==='FIRST_RESPONSE_TIMEOUT'?'模型响应在120秒内未出现有效进展，已停止本次请求。':code==='IDLE_TIMEOUT'?'模型响应连续60秒无有效进展，已保留收到的回答。':code==='TIMEOUT'?'单次模型请求超过'+budget.timeoutMs/1000+'秒上限，已保留收到的内容。':code==='RATE_LIMITED'?'服务请求频率受限，请稍后手动发送。':code==='AUTHENTICATION_FAILED'||code==='NOT_CONFIGURED'?'模型服务凭据不可用。':code==='OUTPUT_LIMIT'?'模型达到本次'+budget.maxOutputTokens+' tokens输出上限，已保留收到的内容。可调整模型设置或分次提问。':code==='RESPONSE_LIMIT'?'回复数据量达到软件接收限制，已保留收到的内容。':code==='PROTOCOL_ERROR'?'服务回复格式异常或缺少正常结束标记，已保留收到的内容。':'暂时无法连接模型服务，请稍后手动发送。';
 };
 function invoke(caller:unknown,method:SessionMethod,value:unknown):SessionMethodResult<SessionMethod>{
  if(revoked||!fence.authorizeInvocation({caller,operation:method==='readState'?'subscribeRun':method==='cancelReply'?'cancelRun':'startTurn'}).allowed)return sessionFailure('CAPABILITY_DENIED');
  let request:SessionRequests[SessionMethod];try{request=parseSessionRequest(method,value);}catch{return sessionFailure('INVALID_REQUEST');}
  if(method==='readState')return state();
  if(method==='cancelReply'){
   const {sessionId,turnId}=request as SessionRequests['cancelReply'];const target=disk.sessions.find(s=>s.id===sessionId)?.turns.find(t=>t.id===turnId);if(!target)return sessionFailure('NOT_FOUND');
   if(active){if(active.sessionId!==sessionId||active.turn.id!==turnId)return sessionFailure('CONFLICT');const run=active;if(!run.stopCause)run.stopCause='user';stopDeadline(run);if(target.execution&&options.turns){try{if(target.execution.phase!=='stopping')updateExecution(run,{...target.execution,phase:'stopping',cleanupState:'pending',pendingInteraction:null});}catch{return sessionFailure('STORAGE_ERROR');}finally{run.abort.abort();}}else finish(run,'cancelled','已停止接收；未完成回复不会带入下一轮上下文。');}return state();
  }
  if(method==='selectSession'&&storage==='error'){
   const {sessionId}=request as SessionRequests['selectSession'];if(!disk.sessions.some(s=>s.id===sessionId))return sessionFailure('NOT_FOUND');disk.selectedId=sessionId;bump();return state();
  }
  if(storage==='error')return sessionFailure('STORAGE_ERROR');
  if(method==='createSession'){
   if(disk.sessions.length>=50)return sessionFailure('LIMIT');const r=request as SessionRequests['createSession'],now=new Date().toISOString(),session:ChatSession={id:randomUUID(),title:r.title.trim(),provider:r.provider,model:r.model??options.defaultModel?.(r.provider)??defaultModel(r.provider),createdAt:now,updatedAt:now,turns:[]};
   return saveResult({...disk,selectedId:session.id,sessions:[session,...disk.sessions]});
  }
  const sessionId=(request as SessionRequests['selectSession']).sessionId,session=disk.sessions.find(s=>s.id===sessionId);if(!session)return sessionFailure('NOT_FOUND');
  if(method==='readTurnActivity'){const r=request as SessionRequests['readTurnActivity'],turn=session.turns.find(t=>t.id===r.turnId);if(!turn)return sessionFailure('NOT_FOUND');try{return options.turns?{ok:true,value:options.turns.activity(sessionId,turn,r.afterSequence)}:sessionFailure('NOT_FOUND');}catch{return sessionFailure('STORAGE_ERROR');}}
  if(method==='answerInteraction'){
   const r=request as SessionRequests['answerInteraction'],turn=session.turns.find(t=>t.id===r.turnId),e=turn?.execution;if(!turn||!e)return sessionFailure('NOT_FOUND');
   const decisionDigest=createHash('sha256').update(JSON.stringify(r.decision)).digest('hex'),receipts=e.interactionReceipts??[],previous=receipts.find(x=>x.requestId===r.requestId);
   if(previous)return previous.interactionId===r.interactionId&&previous.decisionDigest===decisionDigest?state():sessionFailure('CONFLICT');
   if(receipts.length>=16)return sessionFailure('LIMIT');if(disk.sessions.some(s=>s.turns.some(t=>t.id===r.requestId||t.execution?.interactionReceipts?.some(x=>x.requestId===r.requestId))))return sessionFailure('CONFLICT');
   const interaction=e.pendingInteraction;if(!interaction||interaction.interactionId!==r.interactionId||interaction.kind!==r.decision.kind)return sessionFailure('CONFLICT');
   if(interaction.kind==='configuration'&&r.decision.kind==='configuration'&&r.decision.decision==='retry'){
    if(active||e.cleanupState!=='idle')return sessionFailure('BUSY');retryAdmission={sourceId:turn.id,receipt:{requestId:r.requestId,interactionId:r.interactionId,decisionDigest,resultTurnId:r.requestId},configuration:interaction};
    try{return invoke(caller,'sendMessage',{contractVersion:SESSION_VERSION,sessionId,requestId:r.requestId,text:turn.user,images:turn.images??[],files:turn.files??[],schematics:turn.schematics??[],followUp:{fromTurnId:turn.id,expectedTurnVersion:e.version}});}finally{retryAdmission=undefined;}
   }
   if(interaction.kind==='permission'&&r.decision.kind==='permission'&&r.decision.decision==='allow_once'&&interaction.permissionRequestId===r.decision.permissionRequestId){
    if(active||e.cleanupState!=='idle')return sessionFailure('BUSY');retryAdmission={sourceId:turn.id,receipt:{requestId:r.requestId,interactionId:r.interactionId,decisionDigest,resultTurnId:r.requestId},recoveryConsent:{sourceRunId:interaction.sourceRunId,recoveryVersion:interaction.recoveryVersion}};
    try{return invoke(caller,'sendMessage',{contractVersion:SESSION_VERSION,sessionId,requestId:r.requestId,text:turn.user,images:turn.images??[],files:turn.files??[],schematics:turn.schematics??[],followUp:{fromTurnId:turn.id,expectedTurnVersion:e.version}});}finally{retryAdmission=undefined;}
   }
   const receipt={requestId:r.requestId,interactionId:r.interactionId,decisionDigest,resultTurnId:null};
   if(interaction.kind==='question'&&r.decision.kind==='question'){
    if(!options.turns||active?.turn!==turn||active.sessionId!==sessionId||e.phase!=='waiting_question'||interaction.state!=='pending'||interaction.questionId!==r.decision.questionId)return sessionFailure('CONFLICT');
    const answers=e.clarifications??[],existingQuestion=answers.find(q=>q.questionId===interaction.questionId);if(answers.length>=16&&!existingQuestion)return sessionFailure('LIMIT');
    turn.execution={...e,version:e.version+1,pendingInteraction:{...interaction,state:'submitted'},interactionReceipts:[...receipts,receipt],clarifications:[...answers.filter(q=>q.questionId!==interaction.questionId),{questionId:interaction.questionId,prompt:interaction.prompt,answer:r.decision.answer,delivered:false}]};changed();flush();if((storage as SessionState['storage'])==='error')return sessionFailure('STORAGE_ERROR');
    const run=active;void options.turns.answer(e.executionId,interaction,r.decision.answer).catch(error=>failRun(run,error));return state();
   }
   if(interaction.kind==='configuration'&&r.decision.kind==='configuration'&&r.decision.decision==='cancel'||interaction.kind==='permission'&&r.decision.kind==='permission'&&r.decision.decision==='deny'&&interaction.permissionRequestId===r.decision.permissionRequestId){
    if(active?.turn===turn||e.cleanupState!=='idle')return sessionFailure('BUSY');turn.execution={...e,version:e.version+1,pendingInteraction:null,interactionReceipts:[...receipts,receipt]};changed();flush();return (storage as SessionState['storage'])==='error'?sessionFailure('STORAGE_ERROR'):state();
   }
   return sessionFailure('CONFLICT');
  }
  if(method==='selectSession')return saveResult({...disk,selectedId:sessionId});
  if(method==='setSessionModel'){
   const r=request as SessionRequests['setSessionModel'];
   if(session.provider===r.provider&&(session.model??defaultModel(session.provider))===r.model)return state();
   // Only future sends use this selection. Preserve captured active-turn references.
   const turns=session.turns.map(t=>t.provider?t:{...t,provider:session.provider,model:session.model??defaultModel(session.provider)});
   const next={...session,provider:r.provider,model:r.model,turns,updatedAt:new Date().toISOString()};
   return saveResult({...disk,sessions:disk.sessions.map(s=>s.id===sessionId?next:s)});
  }
  if(method==='renameSession'){
   const title=(request as SessionRequests['renameSession']).title.trim();const next={...disk,sessions:disk.sessions.map(s=>s.id===sessionId?{...s,title,updatedAt:new Date().toISOString()}:s)};
   return saveResult(next);
  }
  if(method==='deleteSession'){
   if(active?.sessionId===sessionId)return sessionFailure('BUSY');const sessions=disk.sessions.filter(s=>s.id!==sessionId),selectedId=disk.selectedId===sessionId?sessions[0]?.id??null:disk.selectedId;
   return saveResult({...disk,sessions,selectedId});
  }
  const r=request as SessionRequests['sendMessage'];
  const images=r.images??[],files=r.files??[],schematics=r.schematics??[],text=messageTextDefault(r.text,files,schematics),digest=createHash('sha256').update(JSON.stringify({text:r.text,images,files,schematics,...(r.continueFrom?{continueFrom:r.continueFrom}:{}),...(r.followUp?{followUp:r.followUp}:{})})).digest('hex'),prior=requests.get(r.requestId);
  const existing=disk.sessions.flatMap(s=>s.turns.map(t=>({sessionId:s.id,turn:t}))).find(x=>x.turn.id===r.requestId);
  if(existing?.turn.execution)return existing.sessionId===sessionId&&existing.turn.execution.requestDigest===digest?state():sessionFailure('CONFLICT');
  if(prior)return prior.sessionId===sessionId&&prior.digest===digest?state():sessionFailure('CONFLICT');
  if(existing)return sessionFailure('CONFLICT');
  if(active||options.turns?.busy())return sessionFailure('BUSY');if(!configured()[session.provider])return sessionFailure('NOT_CONFIGURED');
  if(r.followUp){const from=session.turns.find(t=>t.id===r.followUp!.fromTurnId);if(!from?.execution||from.execution.version!==r.followUp.expectedTurnVersion||from.status==='running'||from.execution.cleanupState!=='idle')return sessionFailure('CONFLICT');}
  let source:ReturnType<typeof continuationSource>|undefined;
  if(r.continueFrom){if(r.text!==CONTINUE_TEXT||images.length||files.length||schematics.length||!options.executeMultimodal)return sessionFailure('INVALID_REQUEST');try{source=continuationSource(session.turns,r.continueFrom);}catch{return sessionFailure('INVALID_REQUEST');}}
  let history=source?[...completedHistory(session.turns.slice(0,session.turns.findIndex(t=>t.id===source!.root.id))),{...source.root,assistant:source.assistant}]:completedHistory(session.turns);
  if(options.turns){
   // Keep every explicit continuation segment, including its own delivered questions.
   // Only completed turns and the exact ancestors of a user-requested continuation enter history.
   const included=new Set(session.turns.filter(t=>t.status==='completed').map(t=>t.id));if(r.continueFrom)included.add(r.continueFrom);
   for(const tail of session.turns.filter(t=>included.has(t.id))){let cursor:SessionTurn|undefined=tail;while(cursor?.continueFrom){const parent=session.turns.find(t=>t.id===cursor!.continueFrom);if(!parent)break;included.add(parent.id);cursor=parent;}}
   history=session.turns.filter(t=>included.has(t.id)&&!!t.assistant.trim());
  }
  const model=session.model??defaultModel(session.provider),nativeHistory=!!options.turns&&!!parseProjectReadModel({provider:session.provider,model});
  // Historical excerpts are immutable references, not a fresh read of today's design.
  // Only current attachments must resolve against the currently selected project.
  const validateReferences=()=>{try{const batches=[schematics,...(nativeHistory?[]:options.turns?history:selectMultimodalHistory(session.provider,model,history)).map(t=>t.schematics??[])].filter(c=>c.length);if(batches.length&&!options.validateSchematicContexts)throw Error();for(const batch of batches)options.validateSchematicContexts!(sessionId,batch);}catch{throw new SchematicReferenceError();}};
  try{validateReferences();}catch{return sessionFailure('SCHEMATIC_UNAVAILABLE');}
  let context:ReturnType<typeof buildMultimodalContext>|undefined,budget=LEGACY_REPLY_LIMITS,frozenLimits=resolveChatTurnLimits(LEGACY_REPLY_LIMITS),historyVersion='';
  try{if((images.length||files.length||schematics.length||session.turns.some(t=>t.files?.length||t.schematics?.length)||model!==defaultModel(session.provider))&&!options.executeMultimodal)throw Error();if(!messageContextFits(text,files,schematics))throw Error();if(images.length&&!modelOption(session.provider,model).vision)throw Error();options.validateImages?.(images);
   const configuredBudget=options.replyLimits?.(session.provider)??LEGACY_REPLY_LIMITS;frozenLimits=resolveChatTurnLimits(configuredBudget);budget=parseReplyLimits(frozenLimits.maxOutputTokens,frozenLimits.requestTimeoutMs);
   if(options.turns){const built=buildUnifiedChatContext({provider:session.provider,model,text:source?CONTINUE_TEXT:text,images:source?[]:images,files:source?[]:files,schematics:source?[]:schematics,history:history.map(t=>({turnId:t.id,user:t.user,assistant:t.assistant,...(t.images?{images:t.images}:{}),...(t.files?{files:t.files}:{}),...(t.schematics?{schematics:t.schematics}:{}),...(t.execution?.clarifications?{clarifications:t.execution.clarifications}:{})})),replyLimits:budget},nativeHistory?{nativeHistory:true}:{});context=built.request;historyVersion=built.historyVersion;}
   else if(options.executeMultimodal){
    if(source){if(source.root.images?.length&&!modelOption(session.provider,model).vision)throw Error();context=buildMultimodalContext(session.provider,model,CONTINUE_TEXT,[],history,[],budget);if(!context.messages.some(m=>m.role==='assistant'&&m.content===source!.assistant))throw Error();}
    else context=buildMultimodalContext(session.provider,model,text,images,history,files,budget,schematics);
   }
  }catch(error){return sessionFailure(error instanceof UnifiedChatContextError?'CONTEXT_LIMIT':'INVALID_REQUEST');}
  let legacy;try{if(!options.turns)legacy=buildCloudContextV2(session.provider,text,session.turns.filter(t=>t.status==='completed').map(t=>({user:t.user,assistant:t.assistant})));}catch{return sessionFailure('INVALID_REQUEST');}
  let execution:ChatTurnExecution|undefined;if(options.turns){const executionId='chat-'+randomUUID();try{execution={executionId,version:1,requestDigest:digest,acceptedContext:options.turns.capture({sessionId,executionId,provider:session.provider,model,historyVersion,...(retryAdmission?.configuration?{retryConfiguration:retryAdmission.configuration}:{})}),phase:'accepted',cleanupState:'idle',runLink:null,parentTurnId:r.followUp?.fromTurnId??session.turns.at(-1)?.id??null,pendingInteraction:null};if(retryAdmission?.configuration?.required==='project_directory'&&execution.acceptedContext.bindingId===null&&options.turns.filesystemRead!==true)throw new UnifiedChatConfigurationError('CONFIGURATION_REQUIRED');}catch(error){options.turns.forget(executionId);return sessionFailure(error instanceof UnifiedChatConfigurationError?error.code:'STORAGE_ERROR');}}
  if(execution&&retryAdmission?.recoveryConsent){const reviewed=session.turns.find(t=>t.id===retryAdmission!.sourceId)?.execution?.acceptedContext;const c=execution.acceptedContext;if(!reviewed||reviewed.projectId!==c.projectId||reviewed.bindingId!==c.bindingId||reviewed.bindingIdentity!==c.bindingIdentity){options.turns!.forget(execution.executionId);return sessionFailure('CONFLICT');}execution.recoveryConsent=retryAdmission.recoveryConsent;}
  if(execution)execution.toolScopeRequested=false;
  const turn:SessionTurn={id:r.requestId,user:text,assistant:'',status:'running',error:'',limits:frozenLimits,images,...(files.length?{files}:{}),...(schematics.length?{schematics}:{}),provider:session.provider,model,...(r.continueFrom?{continueFrom:r.continueFrom}:{}),...(execution?{execution}:{})};const title=session.turns.length===0&&session.title==='新会话'?(Array.from(text.replace(/[\u0000-\u001f]/gu,' ').trim()).slice(0,40).join('')||'新会话'):session.title;
  const previousTurns=retryAdmission?session.turns.map(t=>t.id===retryAdmission!.sourceId&&t.execution?{...t,execution:{...t.execution,version:t.execution.version+1,pendingInteraction:null,interactionReceipts:[...(t.execution.interactionReceipts??[]),retryAdmission!.receipt]}}:t):session.turns;
  const nextSession={...session,title,updatedAt:new Date().toISOString(),turns:[...previousTurns,turn]},next={...disk,sessions:disk.sessions.map(s=>s.id===sessionId?nextSession:s)};
  const reserve=replyBodyBytes(budget.maxOutputTokens)*6+16384;if(size(nextSession)+reserve>SESSION_SIZE_LIMIT||size(next)+reserve>SESSION_DISK_LIMIT){if(execution)options.turns?.forget(execution.executionId);return sessionFailure('LIMIT');}
  try{validateReferences();}catch{if(execution)options.turns?.forget(execution.executionId);return sessionFailure('SCHEMATIC_UNAVAILABLE');}
  if(!commit(next)){if(execution)options.turns?.forget(execution.executionId);return sessionFailure('STORAGE_ERROR');}requests.set(r.requestId,{sessionId,digest});
  const run:Active={startedAt:performance.now(),sessionId,turn,abort:new AbortController(),chunks:0,limits:budget,deadline:undefined};active=run;bump();if(frozenLimits.turnTimeoutMs!==null)run.deadline=setTimeout(()=>failRun(run,new CloudChatErrorV1('TIMEOUT'),true),frozenLimits.turnTimeoutMs);
  void Promise.resolve().then(async()=>{
   if(revoked||active!==run)return;
   try{
    validateReferences();
    const executionOptions={signal:run.abort.signal,onText(text:string){
     if(revoked||active!==run)return;try{
      // Session snapshots do not retain the legacy 1024-entry event ledger.
      // Partitioning into network chunks or SSE deltas does not determine completion.
      const parts=splitCloudDeltaV2(text);if(Buffer.byteLength(run.turn.assistant)+Buffer.byteLength(text)>replyBodyBytes(run.limits.maxOutputTokens))throw new CloudChatErrorV1('RESPONSE_LIMIT');
      run.chunks+=parts.length;run.turn.assistant+=text;changed();
     }catch(error){failRun(run,error);}
    }};
    if(options.turns&&context&&run.turn.execution){
     try{await options.turns.execute({sessionId,turn:run.turn,context,historyTurnIds:history.map(turn=>turn.id),signal:run.abort.signal,onText:executionOptions.onText,onExecution:update=>updateExecution(run,update),onFailure:error=>failRun(run,error)});}
     catch(error){if(active===run&&run.turn.execution&&!['needs_configuration','needs_review'].includes(run.turn.execution.phase)){if(!run.stopCause){run.stopCause='failure';stopDeadline(run);run.turn.stopReason=stopReason(error);run.turn.error=errorText(error,run.limits,run.turn.execution.failureDiagnostic);}updateExecution(run,{...run.turn.execution,phase:run.stopCause==='user'?'cancelled':'failed',cleanupState:run.turn.execution.cleanupState==='pending'?'failed':run.turn.execution.cleanupState,pendingInteraction:null});}}
     if(active===run){const e=run.turn.execution!;if(['accepted','preparing','running','waiting_question','stopping'].includes(e.phase))updateExecution(run,{...e,phase:run.abort.signal.aborted&&!run.turn.stopReason?'cancelled':'failed',cleanupState:'failed',pendingInteraction:null});finish(run,statusFor(run.turn.execution!.phase),run.turn.error);options.turns.forget(e.executionId);}return;
    }
    const result=await (context&&options.executeMultimodal?options.executeMultimodal(context,executionOptions):options.execute(legacy!,executionOptions));
    if(revoked||active!==run)return;if(!run.turn.assistant.trim()||result.text!==run.turn.assistant)throw new CloudChatErrorV1('PROTOCOL_ERROR');finish(run,'completed');
   }catch(error){failRun(run,error);}
  });
  return state();
 }
 return {invoke:<M extends SessionMethod>(caller:unknown,method:M,value:unknown)=>invoke(caller,method,value) as SessionMethodResult<M>,getSession:(id:string)=>{if(revoked)return undefined;return parseSessionDisk(disk).sessions.find(s=>s.id===id);},isRunning:()=>!!active,activeSessionId:()=>active?.sessionId??null,referencedRunIds:()=>{if(storage==='error'||revoked)throw Error('Chat references unavailable');return new Set(disk.sessions.flatMap(s=>s.turns.flatMap(t=>t.execution?[t.execution.executionId+'.tools',...(t.execution.runLink?[t.execution.runLink.runId]:[]),...(t.execution.recoveryConsent?[t.execution.recoveryConsent.sourceRunId]:[])]:[])));},settingsChanged:bump,revoke(){if(revoked)return;if(active?.turn.execution&&options.turns){active.abort.abort();active.turn.execution={...active.turn.execution,phase:'interrupted',cleanupState:'pending',pendingInteraction:null,version:active.turn.execution.version+1};finish(active,'interrupted','关闭软件时执行尚未完成，重开后按实际执行记录核对。');}else if(active)finish(active,'interrupted','关闭软件时回复尚未完成，已保留收到的内容。');else if(storage==='saving')flush();revoked=true;if(saveTimer)clearTimeout(saveTimer);}};
}
