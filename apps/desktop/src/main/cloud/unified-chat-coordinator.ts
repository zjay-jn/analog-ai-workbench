import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {AGENT_SKILL_INSTRUCTIONS} from '../../shared/agent/agent-skills';
import {PROJECT_READ_LIMITS as L,type ProjectReadRun,type ProjectReadEvent,type ProjectReadToolCall,type ProjectReadModel} from '../../shared/agent/agent-project-read';
import {parseProjectReadModel} from '../../shared/agent/agent-project-model';
import {CHAT_TURN_ACTIVITY_BYTES,CHAT_TURN_ACTIVITY_PAGE,parseChatTurnExecution,parseChatFailureDiagnostic,type ChatAcceptedContext,type ChatTurnExecution,type ChatTurnPart,type ChatTurnInteraction} from '../../shared/agent/chat-turns';
import {parseChatTurnActivity} from '../../shared/agent/chat-turn-activity';
import type {ChatSession,SessionTurn} from '../../shared/agent/chat-sessions';
import {parseReplyLimits,replyBodyBytes} from '../../shared/agent/reply-limits';
import {projectToolSystem,type ProjectReadHost} from '../agent-project-read/host';
import type {ChatProjectSnapshot,ChatProjectEvent} from '../agent-project-read/chat-scope';
import type {ProjectReadEngine,ProjectReadEngineInput,ProjectReadEngineNotice} from '../agent-project-read/engine';
import type {AgentRuntimeArbiter,AgentRuntimeLease} from '../agent-project-read/runtime-arbiter';
import {ProjectReadFsError,verifyProjectReadRoot} from './project-read-files';
import type {WorkspaceDisk} from '../../shared/agent/project-workspace';
import {projectForSession} from '../../shared/agent/project-workspace';
import {splitCloudDeltaV2} from './cloud-budget';
import {verifyClosedEngineController} from '../engine-pilot/engine-guardian';
import {readChatTurnRun,buildChatTurnActivity,reconcileChatTurn} from './unified-chat-ledger';
import {buildUnifiedChatContext,UnifiedChatContextError} from './unified-chat-context';
import {CloudChatErrorV1} from '../../../../../packages/agent-adapters/src/cloud-chat-contract';
import {UnifiedChatConfigurationError,type UnifiedChatService,type UnifiedChatExecutionUpdate} from './unified-chat-service';
import type {MultimodalExecutor} from './multimodal-context';
import {isFileSystemToolName} from '../../shared/agent/agent-filesystem-read';

type Captured={context:ChatAcceptedContext;project:ChatProjectSnapshot};
type Active={input:Parameters<UnifiedChatService['execute']>[0];captured:Captured;state:ChatTurnExecution;abort:AbortController;
 runId:string;engine?:ProjectReadEngine;lease?:AgentRuntimeLease;callbacks?:ProjectReadEngineInput['callbacks'];attaching?:Promise<ProjectReadEngineInput['callbacks']>;
 history:ChatProjectEvent[];pendingQuestion:string|null;outcome:'completed'|'failed';configuration:ChatTurnInteraction|null;questionTimer?:ReturnType<typeof setTimeout>};
const terminal=(phase:ChatTurnExecution['phase'])=>['completed','failed','cancelled','interrupted','needs_configuration','needs_review'].includes(phase);
const fail=(code:'CONFLICT'|'NOT_BOUND'|'BUSY'|'CANCELLED'|'ENGINE_FAILED'|'CLEANUP_FAILED'):never=>{throw new ProjectReadFsError(code);};
const summary=(run:ProjectReadRun)=>{const {events:_,...rest}=run;return rest;};

/** Owns one accepted chat turn; source/work/command services exist only after an actual tool call. */
export function createUnifiedChatCoordinator(options:{project:ProjectReadHost;arbiter:AgentRuntimeArbiter;workspace:()=>WorkspaceDisk;getSession:(id:string)=>ChatSession|undefined;plain:MultimodalExecutor}):UnifiedChatService{
 const snapshots=new Map<string,Captured>();let active:Active|undefined,uncertainCleanup=false;
 function requestFailure(owner:Active):Error|undefined{
  if(owner.input.signal.aborted)return undefined;
  const accounting=owner.engine?.accounting(owner.runId),reason=accounting?.failureReason;
  if(accounting?.failureDiagnostic&&!owner.state.failureDiagnostic)set(owner,{failureDiagnostic:accounting.failureDiagnostic});
  if(reason==='CONTEXT_LIMIT')return new UnifiedChatContextError('wire_bytes');
  if(reason==='TIMEOUT'||reason==='FIRST_RESPONSE_TIMEOUT'||reason==='IDLE_TIMEOUT')return new CloudChatErrorV1(reason);
  if(reason==='PROTOCOL_ERROR'||reason==='AUTHENTICATION_FAILED')return new CloudChatErrorV1(reason);
  if(reason==='UPSTREAM')return new CloudChatErrorV1('UPSTREAM_UNAVAILABLE');
  if(reason==='ENGINE_FAILED')return new Error('Local tool execution failed');
  return undefined;
 }
 function set(owner:Active,patch:Partial<UnifiedChatExecutionUpdate>):void{
  owner.state={...owner.state,...patch};
  const update:UnifiedChatExecutionUpdate={phase:owner.state.phase,cleanupState:owner.state.cleanupState,runLink:owner.state.runLink,pendingInteraction:owner.state.pendingInteraction,...(owner.state.clarifications?{clarifications:owner.state.clarifications}:{}),...(owner.state.nativeSession?{nativeSession:owner.state.nativeSession}:{}),...(owner.state.compaction?{compaction:owner.state.compaction}:{}),...(owner.state.failureDiagnostic?{failureDiagnostic:owner.state.failureDiagnostic}:{}),...(owner.state.toolScopeRequested!==undefined?{toolScopeRequested:owner.state.toolScopeRequested}:{}),...(owner.state.readOnlyScope?{readOnlyScope:true as const}:{})};
  if(!owner.state.readOnlyScope)delete owner.state.readOnlyScope;
  owner.input.onExecution(update);
 }
 function nativeEvent(owner:Active,event:ProjectReadEngineNotice):void{
  if(active!==owner||owner.abort.signal.aborted)return;
  if(event.type==='compaction'){
   const {type:_,...receipt}=event,prior=owner.state.compaction;
   if(receipt.version!==(prior?.version??0)+1||receipt.coveredResponses<(prior?.coveredResponses??0))return fail('ENGINE_FAILED');
   set(owner,{compaction:receipt});return;
  }
  if(event.type==='completed'||event.type==='failed'){
   owner.outcome=event.type;
   let failure:unknown;
   if(event.type==='failed'){
    failure=requestFailure(owner);
    if(event.nativeFailure&&!owner.state.failureDiagnostic){
     const accounting=owner.engine?.accounting(owner.runId);
     set(owner,{failureDiagnostic:parseChatFailureDiagnostic({stage:'native_engine',reason:'ENGINE_FAILED',providerAttempts:accounting?.providerAttempts??0,httpDispatches:accounting?.httpDispatches??0,nativeFailure:event.nativeFailure})});
     failure=new Error('Native engine failed');
    }
   }
   // Record the linked run's terminal cause before session failure aborts it.
   owner.callbacks?.notice(event);
   if(failure)owner.input.onFailure?.(failure);
   return;
  }
  const additions:ChatProjectEvent[]=[];
  if(event.type==='started'){set(owner,{nativeSession:{sessionId:event.sessionId,conversationId:owner.input.sessionId,...(event.controller?{controller:event.controller}:{})}});additions.push({type:'run.started',data:{sessionId:event.sessionId,engine:'opencode',version:'1.18.17',...(event.controller?{controller:event.controller}:{})}});}
  else if(event.type==='step')additions.push({type:'model.step',data:{step:event.step}});
  else if(event.type==='response')additions.push({type:'model.response',data:{request:event.request,responseModel:event.responseModel,usage:event.usage}});
  else if(event.type==='text'){
   owner.input.onText(event.text);for(const text of splitCloudDeltaV2(event.text))additions.push({type:'message.delta',data:{messageId:event.messageId,step:event.step,text}});
  }else if(event.type==='question'){
   if(owner.pendingQuestion&&owner.pendingQuestion!==event.questionId)return fail('CONFLICT');owner.pendingQuestion=event.questionId;
   additions.push({type:'question.asked',data:{questionId:event.questionId,prompt:event.prompt}});
   const questions=owner.state.clarifications??[];if(questions.length>=16||questions.some(q=>q.questionId===event.questionId))return fail('ENGINE_FAILED');
   set(owner,{phase:'waiting_question',clarifications:[...questions,{questionId:event.questionId,prompt:event.prompt,answer:null,delivered:false}],pendingInteraction:{kind:'question',interactionId:owner.state.executionId+':'+event.questionId,questionId:event.questionId,prompt:event.prompt,state:'pending'}});
   owner.questionTimer=setTimeout(()=>owner.abort.abort(),L.waitMs);
  }
  if(owner.callbacks)owner.callbacks.notice(event);else owner.history.push(...additions);
  if(owner.history.length>L.events||Buffer.byteLength(JSON.stringify(owner.history))>L.runBytes)return fail('ENGINE_FAILED');
 }
 const linkedRun=(sessionId:string,turn:SessionTurn,adopt=false)=>readChatTurnRun(options.project,sessionId,turn,adopt);
 async function workHead(owner:Active):Promise<string|null>{
  const session=options.getSession(owner.input.sessionId);if(!session)return fail('CONFLICT');
  for(const turn of [...session.turns].reverse()){
   if(turn.id===owner.input.turn.id||!turn.execution?.runLink||turn.execution.acceptedContext.projectId!==owner.captured.context.projectId)continue;
   const run=linkedRun(session.id,turn);if(!run?.workCycle||!run.events.some(e=>(e.type==='tool.started'||e.type==='tool.completed')&&(/^(work_|command_)/u.test(e.data.toolName))))continue;
   if(owner.state.recoveryConsent&&owner.state.recoveryConsent.sourceRunId!==run.runId)return fail('CONFLICT');
   if(!['completed','failed','stopped','interrupted'].includes(run.status))return fail('CLEANUP_FAILED');
   if(run.cleanupState!=='idle'){
    if(!owner.lease)return fail('ENGINE_FAILED');const source=await options.project.prepareChatContinuation(run.runId,owner.captured.project,owner.lease);if(!source.recovery)return fail('CLEANUP_FAILED');
    const consent=owner.state.recoveryConsent;if(!consent||consent.sourceRunId!==run.runId||consent.recoveryVersion!==source.recovery.version){
     owner.configuration={kind:'permission',interactionId:owner.state.executionId+':recovery',permissionRequestId:owner.state.executionId+':recovery',operation:'continue_verified_work',sourceRunId:run.runId,recoveryVersion:source.recovery.version,message:'上次工作中断。已核对所属进程收尾和已确认文件；允许基于此版本建立新的工作副本继续吗？'};
     set(owner,{phase:'needs_review',cleanupState:'pending',pendingInteraction:owner.configuration});return fail('CONFLICT');
    }
   }return run.runId;
  }if(owner.state.recoveryConsent)return fail('CONFLICT');return null;
 }
 async function tool(owner:Active,call:ProjectReadToolCall){
  if(active!==owner||owner.abort.signal.aborted)return fail('CANCELLED');
  if(!owner.captured.project.scope&&!isFileSystemToolName(call.toolName)){
   owner.configuration={kind:'configuration',interactionId:owner.state.executionId+':project',required:'project_directory',action:'select_project',message:'本轮需要已关联的项目目录。请选择或新建已绑定目录的项目后重试；原问题和附件会保留。'};
   set(owner,{phase:'needs_configuration',cleanupState:'pending',pendingInteraction:owner.configuration});return fail('NOT_BOUND');
  }
  if(!owner.attaching){
   if(!owner.engine||!owner.lease)return fail('ENGINE_FAILED');
   const model=parseProjectReadModel({provider:owner.captured.context.provider,model:owner.captured.context.model});if(!model)return fail('ENGINE_FAILED');
   set(owner,{toolScopeRequested:true});
   owner.attaching=options.project.attachChat({runId:owner.runId,origin:{chatSessionId:owner.input.sessionId,turnId:owner.input.turn.id,executionId:owner.state.executionId,inputDigest:owner.state.requestDigest},model,snapshot:owner.captured.project,lease:owner.lease,abort:owner.abort,engine:owner.engine,outputBytes:replyBodyBytes(owner.input.context.maxOutputTokens),history:owner.history,
    ...(owner.state.recoveryConsent?{recoveryVersion:owner.state.recoveryConsent.recoveryVersion}:{}),prepareWorkHead:()=>workHead(owner),onLinked:runLink=>{if(runLink.workspaceId)delete owner.state.readOnlyScope;set(owner,{runLink,phase:'preparing',...(runLink.workspaceId?{}:{readOnlyScope:true})});},onReady:callbacks=>{owner.callbacks=callbacks;},onFailure:()=>{}},null);
  }
  owner.callbacks=await owner.attaching;if(owner.abort.signal.aborted)return fail('CANCELLED');set(owner,{phase:'running'});return owner.callbacks.tool(call);
 }
 async function cleanup(owner:Active):Promise<void>{
  if(owner.questionTimer)clearTimeout(owner.questionTimer);
  let clean=true;const linked=!!owner.state.runLink;
  const reason=owner.abort.signal.aborted?'stop':owner.outcome;
  try{if(linked)await options.project.finishChat(owner.runId,reason);else{
    try{set(owner,{cleanupState:'pending',phase:owner.configuration?owner.state.phase:'stopping',pendingInteraction:owner.configuration});}catch{ /* A lost session writer must not bypass native cleanup. */ }
    await owner.engine?.stop(owner.runId);
    if(owner.lease){options.arbiter.update(owner.lease,reason==='completed'?'completed':reason==='stop'?'stopped':'failed','idle');options.arbiter.release(owner.lease);}
  }}catch{clean=false;uncertainCleanup=true;if(owner.lease)try{options.arbiter.update(owner.lease,'failed','failed');}catch{}}
  let run:ProjectReadRun|null=null;try{if(linked){run=options.project.chatRun(owner.runId);if(!run||run.cleanupState!=='idle')clean=false;}}catch{clean=false;}
  if(!clean)uncertainCleanup=true;
  const failed=run?run.status!=='completed':owner.outcome!=='completed';
  const cancelled=owner.input.signal.aborted&&!owner.input.turn.stopReason;
  const phase=cancelled?'cancelled':owner.configuration?owner.configuration.kind==='permission'?'needs_review':'needs_configuration':failed||!clean?'failed':'completed';
  set(owner,{phase,cleanupState:clean?'idle':'failed',pendingInteraction:cancelled?null:owner.configuration});
 }
 return {
  filesystemRead:true,
  capture(input){
   if(snapshots.has(input.executionId))return fail('CONFLICT');const workspace=options.workspace(),projectId=projectForSession(workspace,input.sessionId);if(!projectId)return fail('CONFLICT');
   const project=options.project.captureChat(projectId,workspace.projects.find(p=>p.id===projectId)!.name),context:ChatAcceptedContext=Object.freeze({projectId,workspaceRevision:workspace.revision,bindingId:project.scope?.project.bindingId??null,bindingIdentity:project.scope?.project.identity??null,provider:input.provider,model:input.model,historyVersion:input.historyVersion});
   snapshots.set(input.executionId,{context,project});return context;
  },
  async execute(input){
   const e=input.turn.execution;if(!e)return fail('CONFLICT');const captured=snapshots.get(e.executionId);if(!captured||!isDeepStrictEqual(captured.context,e.acceptedContext))return fail('CONFLICT');
   if(active||uncertainCleanup)return fail('BUSY');
   const owner:Active={input,captured,state:structuredClone(e),abort:new AbortController(),runId:e.executionId+'.tools',history:[],pendingQuestion:null,outcome:'failed',configuration:null};active=owner;
   const abort=()=>owner.abort.abort();input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort();
   try{
    if(owner.abort.signal.aborted)return;
    set(owner,{phase:'preparing'});
    const model=parseProjectReadModel({provider:input.context.provider,model:input.context.model});
    if(!model){
     // This explicit vision model remains a normal multimodal chat, with its selected identity.
     const result=await options.plain(input.context,{signal:owner.abort.signal,onText:input.onText});if(!result.text.trim())return fail('ENGINE_FAILED');owner.outcome='completed';return;
    }
    owner.lease=options.arbiter.reserveRun({mode:'conversation',runId:owner.runId,project:null,status:'preparing',cleanupState:'idle'},abort);
    owner.engine=await options.arbiter.runtime(owner.lease,options.project.createChatEngine);
    const limits=parseReplyLimits(input.context.maxOutputTokens,input.context.timeoutMs??30000);if(!owner.engine.acceptChat)return fail('ENGINE_FAILED');owner.engine.acceptChat(owner.runId,model,limits);
    const wsl=await captured.project.wsl.catch(()=>null);
    if(owner.abort.signal.aborted)return;
    const last=input.context.messages.at(-1)!;const initialUserText=typeof last.content==='string'?last.content:last.content.filter(p=>p.type==='text').map(p=>p.type==='text'?p.text:'').join('\n');
    const storedTurns=options.getSession(input.sessionId)?.turns??[],acceptedHistory=input.historyTurnIds?new Set(input.historyTurnIds):undefined;
    const expectedSessionId=storedTurns.filter(turn=>turn.execution?.nativeSession?.conversationId===input.sessionId).at(-1)?.execution?.nativeSession?.sessionId;
    const externalTurns=storedTurns.filter(turn=>(acceptedHistory?acceptedHistory.has(turn.id):turn.status==='completed')&&!turn.execution?.nativeSession&&turn.assistant.trim()).map(turn=>({turnId:turn.id,messages:buildUnifiedChatContext({provider:input.context.provider,model:input.context.model,text:'migration reference',images:[],files:[],schematics:[],history:[{turnId:turn.id,user:turn.user,assistant:turn.assistant,images:turn.images??[],files:turn.files??[],schematics:turn.schematics??[],...(turn.execution?.clarifications?{clarifications:turn.execution.clarifications}:{})}],replyLimits:limits},{nativeHistory:true}).request.messages.slice(0,-1)}));
    const systemText=projectToolSystem(true)+'\n'+AGENT_SKILL_INSTRUCTIONS+'\nThis is a unified conversation. Answer normal questions directly when no tool is necessary. question is a native clarification and needs no project directory. Native fs_* reads work with explicit Windows absolute paths even without a project binding; relative paths use only the following frozen default cwd. Project/work/command resources are prepared only for their actual tool category. Never infer user intent from keywords or silently change the selected model. OpenCode owns this conversation history and compression. Historical attachments and migrated transcript excerpts describe past observations, not current engineering facts or renewed permissions. The latest user message includes its current selected attachments. Do not invent project or environment IDs. Scoped AGENTS records will be delivered before source content.\nFrozen default cwd: '+JSON.stringify(captured.project.cwd??null)+'\nFrozen WSL result binding: '+JSON.stringify(wsl);
    set(owner,{phase:'running'});
    await owner.engine.start({runId:owner.runId,model,signal:owner.abort.signal,workCycle:true,chatContext:input.context,nativeConversation:{conversationId:input.sessionId,...(expectedSessionId?{expectedSessionId}:{}),legacyMessages:input.context.messages.slice(0,-1),externalTurns},prompt:{goal:'Respond to the accepted turn using this native conversation and its current engineering scope.',constraint:'',rules:'fs_* accepts explicit filesystem paths independently of project binding; IDs and cursors must be main-issued. Other tools retain their main-authorized scope.',systemText,initialUserText},callbacks:{
     notice:event=>nativeEvent(owner,event),tool:call=>tool(owner,call),questionDelivered:async questionId=>{
      if(active!==owner||owner.pendingQuestion!==questionId)return fail('CONFLICT');if(owner.callbacks)await owner.callbacks.questionDelivered(questionId);else owner.history.push({type:'question.delivered',data:{questionId}});
      owner.pendingQuestion=null;if(owner.questionTimer)clearTimeout(owner.questionTimer);const clarifications=owner.state.clarifications?.map(q=>q.questionId===questionId?{...q,delivered:true}:q);set(owner,{phase:'running',pendingInteraction:null,...(clarifications?{clarifications}:{})});
     },
    }});
    const failure=requestFailure(owner);if(failure)throw failure;
    if(owner.outcome==='failed'&&!owner.configuration&&!owner.abort.signal.aborted)return fail('ENGINE_FAILED');
   }catch(error){const failure=requestFailure(owner)??error;if(!owner.input.signal.aborted&&(failure instanceof CloudChatErrorV1||failure instanceof UnifiedChatContextError))input.onFailure?.(failure);throw failure;}finally{
    try{await cleanup(owner);}finally{input.signal.removeEventListener('abort',abort);if(active===owner)active=undefined;}
   }
  },
  async answer(executionId,interaction,answer){
   const owner=active;if(!owner||owner.state.executionId!==executionId||interaction.kind!=='question'||owner.pendingQuestion!==interaction.questionId||owner.abort.signal.aborted)return fail('CONFLICT');
   const clarifications=owner.input.turn.execution?.clarifications;if(clarifications)owner.state={...owner.state,clarifications};
   if(owner.callbacks){await options.project.answerChat(owner.runId,interaction.questionId,answer);return;}
   owner.history.push({type:'question.answered',data:{questionId:interaction.questionId,answer}});if(!owner.engine)return fail('ENGINE_FAILED');await owner.engine.answer(owner.runId,interaction.questionId,answer);
  },
  activity:(sessionId,turn,afterSequence)=>buildChatTurnActivity(turn.execution?.toolScopeRequested===false?{chatRun:()=>null,chatRuns:()=>[]}:options.project,sessionId,turn,afterSequence),
  reconcile(sessionId,turn){
   let next=reconcileChatTurn(turn.execution?.toolScopeRequested===false?{chatRun:()=>null,chatRuns:()=>[]}:options.project,sessionId,turn);
   if(!next.runLink&&next.cleanupState!=='idle'){
    let closed=next.acceptedContext.model==='deepseek-v4-flash-vision-exp';
    if(next.nativeSession?.controller)try{verifyClosedEngineController(next.nativeSession.controller);closed=true;}catch{}
    if(closed)next=parseChatTurnExecution({...next,version:next.version+1,cleanupState:'idle'});else uncertainCleanup=true;
   }return next;
  },
  forget(executionId){if(active?.state.executionId===executionId)return;snapshots.delete(executionId);},
  busy:()=>!!active||uncertainCleanup||options.arbiter.snapshot().busy,
 };
}
