import {COMMAND_LIMITS,type CommandExecution,type CommandLogPage,type CommandStream,type CommandToolArguments,type CommandBridgeValues} from '../../shared/agent/agent-command';
import {isCommandExecution,isCommandLogPage,isCommandEnvironment} from '../../shared/agent/agent-command-validation';
import {AGENT_PROJECT_READ_VERSION as V,type WorkbenchAgentProjectReadApi,type ProjectReadRequests} from '../../shared/agent/agent-project-read';
import {parseProjectReadRequest,parseProjectReadResult} from '../../shared/agent/agent-project-read-validation';
import {projectReadError} from './project-read-presentation';
import {commandDiagnosticCauseCode,isCommandDiagnosticReadResult,type CommandDiagnosticReadResult} from '../../shared/agent/command-diagnostics';
import {copyChatText} from './ChatMarkdown';
import {commandOriginKey,commandPrimaryFailure,type CommandDiagnosticScope,type CommandPrimaryFailurePort} from './command-primary-failure';
import {parseChatFailureDiagnostic,type ChatFailureDiagnostic} from '../../shared/agent/chat-turns';

/** Renderer ports only. The final local-history bridge supplies these operations; no launch port exists. */
export type CommandReadResult<T>={ok:true;value:T}|{ok:false;message:string};
export type CommandExecutionPorts={
 list:(runId:string)=>Promise<CommandReadResult<readonly CommandExecution[]>>;
 environment:(runId:string)=>Promise<CommandReadResult<CommandBridgeValues['inspectCommandEnvironment']>>;
 status:(runId:string,input:CommandToolArguments['command_status'])=>Promise<CommandReadResult<CommandExecution>>;
 log:(runId:string,input:CommandToolArguments['command_log'])=>Promise<CommandReadResult<CommandLogPage>>;
 stop:(runId:string,input:CommandToolArguments['command_stop'])=>Promise<CommandReadResult<CommandExecution>>;
 diagnostics?:(runId:string,executionId:string)=>Promise<CommandReadResult<CommandDiagnosticReadResult>>;
 openDiagnostics?:(runId:string,executionId:string)=>Promise<CommandReadResult<{opened:boolean}>>;
 copyText?:(text:string)=>Promise<void>;
 primaryFailure?:CommandPrimaryFailurePort;
};
export type CommandViewScope=CommandDiagnosticScope;
type LogState=Readonly<{page:CommandLogPage|null;reading:boolean;error:string|null}>;
export type CommandExecutionEntry=Readonly<{execution:CommandExecution;refreshing:boolean;stopping:boolean;stopUnconfirmed:boolean;error:string|null;logs:Readonly<Record<CommandStream,LogState>>;diagnostics?:CommandDiagnosticReadResult|null;diagnosticsLoading?:boolean;diagnosticsError?:string|null;diagnosticsCopying?:boolean;diagnosticsOpening?:boolean;diagnosticsActionStatus?:string|null}>;
export type CommandExecutionViewState=Readonly<{scope:CommandViewScope|null;entries:readonly CommandExecutionEntry[];error:string|null;listing:boolean;environments:CommandBridgeValues['inspectCommandEnvironment']['environments']|null;inspectingEnvironment:boolean;environmentError:string|null}>;
export const initialCommandExecutionState:CommandExecutionViewState={scope:null,entries:[],error:null,listing:false,environments:null,inspectingEnvironment:false,environmentError:null};
const emptyLog=():LogState=>({page:null,reading:false,error:null});
const identity=(e:CommandExecution)=>JSON.stringify([e.executionId,e.runId,e.workspaceId,e.requestId,e.signature,e.environment.environmentId,e.environment.revision,e.environment.displayName,e.baselineVersion,e.cwdRelativePath,e.commandText,e.commandSha256,e.scriptSha256,e.createdAt,e.deadlineAt]);
const observation=(e:CommandExecution)=>JSON.stringify(e,(_key,value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):value);
const active=(e:CommandExecution)=>['intent','starting','running','settling'].includes(e.phase);

/** Deliberate allowlist: never copy command text, source paths, environment names or chat content. */
export function commandDiagnosticClipboardText(execution:CommandExecution,diagnostics:CommandDiagnosticReadResult,primary:ChatFailureDiagnostic|null=null){
 let primaryFailure:ChatFailureDiagnostic|null=null;try{if(primary)primaryFailure=parseChatFailureDiagnostic(primary);}catch{/* Invalid metadata is never copied. */}
 const error=execution.error?{stage:execution.error.stage,code:['RESULT_ADOPTION_CANCELLED','WSL_CLEANUP_UNCONFIRMED'].includes(execution.error.code)?execution.error.code:commandDiagnosticCauseCode(execution.error.code)??'UNKNOWN_ERROR',nativeCode:execution.error.nativeCode}:null;
 return JSON.stringify({format:'command-diagnostics-v1',primaryFailure,primaryUnavailable:primaryFailure===null,runId:execution.runId,executionId:execution.executionId,workspaceId:execution.workspaceId,revision:execution.revision,phase:execution.phase,stopReason:execution.stopRequested?.reason??null,exit:execution.exit,cleanup:execution.cleanup.state,error,
  logs:Object.fromEntries((['stdout','stderr'] as const).map(stream=>[stream,{persistedBytes:execution.logs[stream].persistedBytes,observedBytes:execution.logs[stream].observedBytes,closed:execution.logs[stream].closed,coverage:execution.logs[stream].coverage}])),
  diagnostics:{unavailable:diagnostics.unavailable,truncated:diagnostics.truncated,records:diagnostics.records.map(({version,id,time,appVersion,component,operation,kind,causeCode,nativeCode,stack})=>({version,id,time,appVersion,component,operation,kind,causeCode,nativeCode,stack}))}},null,2);
}

type CommandClock={set:(fn:()=>void,ms:number)=>unknown;clear:(key:unknown)=>void};
export function createCommandExecutionController(ports:CommandExecutionPorts,clock:CommandClock={set:(fn,ms)=>setTimeout(fn,ms),clear:key=>clearTimeout(key as ReturnType<typeof setTimeout>)}){
 let state=initialCommandExecutionState,disposed=false,epoch=0;
 let watching=false,watchPending=false,watchTimer:unknown=null;
 const listeners=new Set<()=>void>(),statusRequests=new Map<string,number>(),logRequests=new Map<string,number>(),diagnosticRequests=new Map<string,number>();
 const update=(patch:Partial<CommandExecutionViewState>)=>{if(disposed)return;state={...state,...patch};listeners.forEach(listener=>listener());schedule();};
 const find=(id:string)=>state.entries.find(entry=>entry.execution.executionId===id);
 const change=(id:string,patch:Partial<CommandExecutionEntry>)=>update({entries:state.entries.map(entry=>entry.execution.executionId===id?{...entry,...patch}:entry)});
 const changeLog=(id:string,stream:CommandStream,patch:Partial<LogState>)=>{const entry=find(id);if(entry)change(id,{logs:{...entry.logs,[stream]:{...entry.logs[stream],...patch}}});};
 function setScope(scope:CommandViewScope|null){
  if(disposed||scope?.runId===state.scope?.runId&&scope?.workspaceId===state.scope?.workspaceId&&commandOriginKey(scope?.origin)===commandOriginKey(state.scope?.origin))return;
  epoch++;watchPending=false;if(watchTimer!==null){clock.clear(watchTimer);watchTimer=null;}statusRequests.clear();logRequests.clear();diagnosticRequests.clear();update({...initialCommandExecutionState,scope:scope?structuredClone(scope):null});
 }
 function schedule(){
  if(disposed||!watching||watchPending||watchTimer!==null||!state.scope||!state.entries.some(entry=>active(entry.execution)&&!entry.error&&!entry.refreshing))return;
  watchTimer=clock.set(()=>{watchTimer=null;void observe();},1000);
 }
 async function observe(){
  if(disposed||!watching||!state.scope)return;const currentEpoch=epoch;watchPending=true;
  try{await Promise.all(state.entries.filter(entry=>active(entry.execution)&&!entry.error).map(entry=>refresh(entry.execution.executionId,COMMAND_LIMITS.statusWaitMs)));}
  finally{if(epoch===currentEpoch){watchPending=false;schedule();}}
 }
 function watch(enabled:boolean){watching=enabled;if(!enabled&&watchTimer!==null){clock.clear(watchTimer);watchTimer=null;}schedule();}
 async function refreshHistory(){
  const scope=state.scope;if(disposed||!scope||state.listing)return false;const currentEpoch=epoch;update({listing:true,error:null});
  try{const result=await ports.list(scope.runId);if(disposed||epoch!==currentEpoch)return false;
   if(!result.ok){update({error:result.message});return false;}
   if(result.value.length>COMMAND_LIMITS.executions||new Set(result.value.map(e=>e.executionId)).size!==result.value.length||result.value.some(e=>!isCommandExecution(e)||e.runId!==scope.runId||e.workspaceId!==scope.workspaceId))throw Error('Invalid history scope');
   register(result.value);return true;
  }catch{if(epoch===currentEpoch)update({error:'执行记录读取失败或归属不一致，保留先前记录。'});return false;}
  finally{if(epoch===currentEpoch)update({listing:false});}
 }
 async function inspectEnvironment(){
  const scope=state.scope;if(disposed||!scope||state.inspectingEnvironment)return false;const currentEpoch=epoch;update({inspectingEnvironment:true,environmentError:null});
  try{const result=await ports.environment(scope.runId);if(disposed||epoch!==currentEpoch)return false;
   if(!result.ok){update({environmentError:result.message});return false;}
   if(result.value.environments.length>8||!result.value.environments.every(isCommandEnvironment)||result.value.workspace!==null&&result.value.workspace.workspaceId!==scope.workspaceId)throw Error('Invalid environment scope');
   update({environments:structuredClone(result.value.environments)});return true;
  }catch{if(epoch===currentEpoch)update({environmentError:'命令环境暂时无法核对，保留先前信息。'});return false;}
  finally{if(epoch===currentEpoch)update({inspectingEnvironment:false});}
 }
 /** Call only for validated event/history observations from the selected run. */
 function register(executions:readonly CommandExecution[]){
  if(disposed||!state.scope)return;
  for(const execution of executions){
   if(!isCommandExecution(execution)||execution.runId!==state.scope.runId||execution.workspaceId!==state.scope.workspaceId){update({error:'执行记录不属于当前任务工作区，未接入操作。'});continue;}
   const known=find(execution.executionId);
   if(known){if(identity(known.execution)!==identity(execution)){change(execution.executionId,{error:'执行身份发生变化，保留原记录。'});continue;}
    if(execution.revision===known.execution.revision&&observation(execution)!==observation(known.execution)){change(execution.executionId,{error:'同一执行版本的状态不一致，保留原记录。'});continue;}
    if(execution.revision<=known.execution.revision)continue;
    change(execution.executionId,{execution:structuredClone(execution),stopUnconfirmed:execution.stopRequested||!active(execution)?false:known.stopUnconfirmed});
   }else if(state.entries.length<COMMAND_LIMITS.executions){update({entries:[...state.entries,{execution:structuredClone(execution),refreshing:false,stopping:false,stopUnconfirmed:false,error:null,logs:{stdout:emptyLog(),stderr:emptyLog()}}]});}
  }
 }
 function accept(id:string,execution:CommandExecution){
  const entry=find(id);if(!entry||!state.scope||!isCommandExecution(execution)||identity(entry.execution)!==identity(execution))throw Error('Execution identity mismatch');
  if(execution.revision<entry.execution.revision)return;
  if(execution.revision===entry.execution.revision&&observation(execution)!==observation(entry.execution))throw Error('Execution revision mismatch');
  change(id,{execution:structuredClone(execution),stopUnconfirmed:execution.stopRequested||!active(execution)?false:entry.stopUnconfirmed,error:null});
 }
 async function refresh(executionId:string,waitMs=0){
  const entry=find(executionId),scope=state.scope;if(disposed||!entry||!scope||entry.refreshing)return false;
  const currentEpoch=epoch,request=(statusRequests.get(executionId)??0)+1;statusRequests.set(executionId,request);change(executionId,{refreshing:true,error:null});
  try{const result=await ports.status(scope.runId,{executionId,afterRevision:entry.execution.revision,waitMs:Math.max(0,Math.min(COMMAND_LIMITS.statusWaitMs,waitMs))});if(disposed||epoch!==currentEpoch||statusRequests.get(executionId)!==request)return false;
   if(!result.ok){change(executionId,{error:result.message});return false;}accept(executionId,result.value);return true;
  }catch{if(epoch===currentEpoch)change(executionId,{error:'执行状态读取失败或身份不一致，保留先前记录，请再次核对。'});return false;}
  finally{if(epoch===currentEpoch&&statusRequests.get(executionId)===request)change(executionId,{refreshing:false});}
 }
 async function stop(executionId:string){
  const entry=find(executionId),scope=state.scope;if(disposed||!entry||!scope||entry.stopping||entry.execution.stopRequested||!active(entry.execution))return false;
  const currentEpoch=epoch;change(executionId,{stopping:true,error:null});
  try{const result=await ports.stop(scope.runId,{executionId});if(disposed||epoch!==currentEpoch)return false;
   if(!result.ok){change(executionId,{error:result.message});return false;}
   accept(executionId,result.value);
   if(!result.value.stopRequested&&active(result.value))throw Error('Stop not recorded');
   change(executionId,{stopUnconfirmed:false});return true;
  }catch{if(epoch===currentEpoch)change(executionId,{stopUnconfirmed:true,error:'停止请求结果尚未确认。可核对状态，或重试同一次执行的停止请求。'});return false;}
  finally{if(epoch===currentEpoch)change(executionId,{stopping:false});}
 }
 async function readLog(executionId:string,stream:CommandStream,mode:'first'|'next'|'latest'='first',sourcePage?:CommandLogPage){
  const entry=find(executionId),scope=state.scope;if(disposed||!entry||!scope||entry.logs[stream].reading)return false;
  if(sourcePage&&(!isCommandLogPage(sourcePage)||sourcePage.executionId!==executionId||sourcePage.stream!==stream||mode==='first'))return false;
  const previous=sourcePage??entry.logs[stream].page,cursor=mode==='next'?previous?.nextCursor:null;if(mode==='next'&&!cursor||mode==='latest'&&(!previous||previous.nextCursor))return false;
  const offset=cursor?.offset??(mode==='latest'&&previous?previous.snapshotBytes:0),expectedPrefixVersion=cursor?.prefixVersion??null;
  const key=`${executionId}:${stream}`,request=(logRequests.get(key)??0)+1,currentEpoch=epoch;logRequests.set(key,request);changeLog(executionId,stream,{...(sourcePage?{page:structuredClone(sourcePage)}:{}),reading:true,error:null});
  try{const result=await ports.log(scope.runId,{executionId,stream,offset,maxBytes:COMMAND_LIMITS.logPageBytes,expectedPrefixVersion});if(disposed||epoch!==currentEpoch||logRequests.get(key)!==request)return false;
   if(!result.ok){changeLog(executionId,stream,{error:result.message});return false;}
   const page=result.value;
   if(!isCommandLogPage(page)||page.executionId!==executionId||page.stream!==stream||page.offset!==offset||expectedPrefixVersion!==null&&(page.prefixVersion!==expectedPrefixVersion||page.snapshotBytes!==previous?.snapshotBytes))throw Error('Log page identity mismatch');
   changeLog(executionId,stream,{page:structuredClone(page)});return true;
  }catch{if(epoch===currentEpoch)changeLog(executionId,stream,{error:'日志页身份、范围或版本无法确认，保留先前页面。'});return false;}
  finally{if(epoch===currentEpoch&&logRequests.get(key)===request)changeLog(executionId,stream,{reading:false});}
 }
 async function readDiagnostics(executionId:string){
  const entry=find(executionId),scope=state.scope;if(disposed||!entry||!scope||entry.diagnosticsLoading||entry.execution.runId!==scope.runId||entry.execution.workspaceId!==scope.workspaceId)return false;
  if(!ports.diagnostics){change(executionId,{diagnosticsError:'当前版本尚不能读取诊断日志。'});return false;}
  const currentEpoch=epoch,request=(diagnosticRequests.get(executionId)??0)+1;diagnosticRequests.set(executionId,request);change(executionId,{diagnosticsLoading:true,diagnosticsError:null});
  try{const result=await ports.diagnostics(scope.runId,executionId);if(disposed||epoch!==currentEpoch||diagnosticRequests.get(executionId)!==request)return false;
   if(!result.ok){change(executionId,{diagnosticsError:result.message});return false;}
   const value=result.value;if(!isCommandDiagnosticReadResult(value)||new Set(value.records.map(row=>row.id)).size!==value.records.length||value.records.some(row=>row.runId!==scope.runId||row.executionId!==executionId||row.workspaceId!==undefined&&row.workspaceId!==scope.workspaceId))throw Error('Diagnostic identity mismatch');
   change(executionId,{diagnostics:structuredClone(value)});return true;
  }catch{if(epoch===currentEpoch)change(executionId,{diagnosticsError:'诊断日志读取失败或归属不一致，保留先前记录。'});return false;}
  finally{if(epoch===currentEpoch&&diagnosticRequests.get(executionId)===request)change(executionId,{diagnosticsLoading:false});}
 }
 async function copyDiagnostics(executionId:string){
  const entry=find(executionId),scope=state.scope;if(disposed||!entry||!scope||entry.diagnosticsCopying||entry.execution.runId!==scope.runId||entry.execution.workspaceId!==scope.workspaceId)return false;
  const currentEpoch=epoch;change(executionId,{diagnosticsCopying:true,diagnosticsActionStatus:null});
  try{
   if(!ports.copyText)throw Error('Clipboard unavailable');
   if(!entry.diagnostics&&!await readDiagnostics(executionId))return false;
   if(disposed||epoch!==currentEpoch)return false;
   let primary:ChatFailureDiagnostic|null=null;
   if(scope.origin&&ports.primaryFailure)try{primary=commandPrimaryFailure(await ports.primaryFailure(structuredClone(scope)),scope);}catch{/* Preserve available command diagnostics when the original turn is unavailable. */}
   if(disposed||epoch!==currentEpoch)return false;
   const current=find(executionId);if(!current?.diagnostics)return false;
   await ports.copyText(commandDiagnosticClipboardText(current.execution,current.diagnostics,primary));
   if(disposed||epoch!==currentEpoch)return false;
   change(executionId,{diagnosticsActionStatus:primary?'诊断信息已复制。':'诊断信息已复制；本轮首因暂不可用。'});return true;
  }catch{if(epoch===currentEpoch)change(executionId,{diagnosticsActionStatus:'未能复制诊断信息，请稍后重试。'});return false;}
  finally{if(epoch===currentEpoch)change(executionId,{diagnosticsCopying:false});}
 }
 async function openDiagnostics(executionId:string){
  const entry=find(executionId),scope=state.scope;if(disposed||!entry||!scope||entry.diagnosticsOpening||entry.execution.runId!==scope.runId||entry.execution.workspaceId!==scope.workspaceId)return false;
  const currentEpoch=epoch;change(executionId,{diagnosticsOpening:true,diagnosticsActionStatus:null});
  try{
   if(!ports.openDiagnostics)throw Error('Diagnostic location unavailable');
   const result=await ports.openDiagnostics(scope.runId,executionId);if(disposed||epoch!==currentEpoch)return false;
   if(!result.ok){change(executionId,{diagnosticsActionStatus:result.message});return false;}
   if(typeof result.value?.opened!=='boolean')throw Error('Invalid open result');
   change(executionId,{diagnosticsActionStatus:result.value.opened?'已打开日志位置。':'尚无可打开的诊断日志。'});return result.value.opened;
  }catch{if(epoch===currentEpoch)change(executionId,{diagnosticsActionStatus:'暂时无法打开日志位置。'});return false;}
  finally{if(epoch===currentEpoch)change(executionId,{diagnosticsOpening:false});}
 }
 return{snapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},setScope,register,refresh,stop,readLog,readDiagnostics,copyDiagnostics,openDiagnostics,refreshHistory,inspectEnvironment,watch,
  dispose:()=>{disposed=true;epoch++;watch(false);listeners.clear();statusRequests.clear();logRequests.clear();diagnosticRequests.clear();}};
}
export type CommandExecutionController=ReturnType<typeof createCommandExecutionController>;

/** All calls use the frozen local bridge; reading history and observing execution never dispatch a model or start a process. */
export function commandExecutionPorts(api:Pick<WorkbenchAgentProjectReadApi,'inspectCommandEnvironment'|'listCommandExecutions'|'readCommandExecution'|'readCommandLog'|'stopCommandExecution'>&Partial<Pick<WorkbenchAgentProjectReadApi,'readCommandDiagnostics'|'openCommandDiagnostics'>>):CommandExecutionPorts{
 async function call<K extends 'inspectCommandEnvironment'|'listCommandExecutions'|'readCommandExecution'|'readCommandLog'|'stopCommandExecution'>(method:K,input:ProjectReadRequests[K]){
  const request=parseProjectReadRequest(method,input);if(!request)throw Error('Invalid command request');
  const result=parseProjectReadResult(method,await api[method](request as never));if(!result)throw Error('Invalid command response');return result;
 }
 return{
  list:async runId=>{const result=await call('listCommandExecutions',{contractVersion:V,runId});return result.ok?{ok:true,value:result.value.executions}:{ok:false,message:projectReadError(result.error.code)};},
  environment:async runId=>{const result=await call('inspectCommandEnvironment',{contractVersion:V,runId});return result.ok?{ok:true,value:result.value}:{ok:false,message:projectReadError(result.error.code)};},
  status:async(runId,input)=>{const result=await call('readCommandExecution',{contractVersion:V,runId,...input});return result.ok?{ok:true,value:result.value.execution}:{ok:false,message:projectReadError(result.error.code)};},
  log:async(runId,input)=>{const result=await call('readCommandLog',{contractVersion:V,runId,...input});return result.ok?{ok:true,value:result.value.page}:{ok:false,message:projectReadError(result.error.code)};},
  stop:async(runId,input)=>{const result=await call('stopCommandExecution',{contractVersion:V,runId,...input});return result.ok?{ok:true,value:result.value.execution}:{ok:false,message:projectReadError(result.error.code)};},
  ...(api.readCommandDiagnostics?{copyText:copyChatText,diagnostics:async(runId:string,executionId:string)=>{const request=parseProjectReadRequest('readCommandDiagnostics',{contractVersion:V,runId,executionId});if(!request)throw Error('Invalid diagnostic request');const result=parseProjectReadResult('readCommandDiagnostics',await api.readCommandDiagnostics!(request));if(!result)throw Error('Invalid diagnostic response');return result.ok?{ok:true as const,value:result.value.diagnostics}:{ok:false as const,message:projectReadError(result.error.code)};}}:{}),
  ...(api.openCommandDiagnostics?{openDiagnostics:async(runId:string,executionId:string)=>{const request=parseProjectReadRequest('openCommandDiagnostics',{contractVersion:V,runId,executionId});if(!request)throw Error('Invalid diagnostic request');const result=parseProjectReadResult('openCommandDiagnostics',await api.openCommandDiagnostics!(request));if(!result)throw Error('Invalid diagnostic response');return result.ok?{ok:true as const,value:result.value}:{ok:false as const,message:projectReadError(result.error.code)};}}:{}),
 };
}
