import {parseChatFailureDiagnostic,parseChatRunOrigin,type ChatFailureDiagnostic,type ChatRunOrigin,type ChatTurnActivity} from '../../shared/agent/chat-turns';
import {parseSessionMethodResult,parseSessionRequest,SESSION_VERSION,type WorkbenchSessionsApi} from '../../shared/agent/chat-sessions';

export type CommandDiagnosticScope=Readonly<{runId:string;workspaceId:string;origin?:ChatRunOrigin}>;
export type CommandPrimaryFailurePort=(scope:CommandDiagnosticScope)=>Promise<ChatTurnActivity|null>;
export const commandOriginKey=(origin:ChatRunOrigin|undefined)=>origin?JSON.stringify([origin.chatSessionId,origin.turnId,origin.executionId,origin.inputDigest]):'';

/** Only the bound chat turn's fixed diagnostic metadata may enter a command copy. */
export function commandPrimaryFailure(activity:ChatTurnActivity|null,scope:CommandDiagnosticScope):ChatFailureDiagnostic|null{
 try{
  if(!scope.origin||!activity?.execution||!activity.run)return null;
  const origin=parseChatRunOrigin(scope.origin),execution=activity.execution,run=activity.run;
  if(activity.sessionId!==origin.chatSessionId||activity.turnId!==origin.turnId||execution.executionId!==origin.executionId||execution.requestDigest!==origin.inputDigest||execution.runLink?.runId!==scope.runId||execution.runLink.workspaceId!==scope.workspaceId||run.runId!==scope.runId||run.workCycle?.workspaceId!==scope.workspaceId||commandOriginKey(run.origin)!==commandOriginKey(origin))return null;
  return execution.failureDiagnostic?structuredClone(parseChatFailureDiagnostic(execution.failureDiagnostic)):null;
 }catch{return null;}
}

/** Explicit copy lookup only; no selection change, history polling, model or command port. */
export function commandPrimaryFailurePort(api:Pick<WorkbenchSessionsApi,'readTurnActivity'>|undefined):CommandPrimaryFailurePort{
 return async scope=>{
  if(!api||!scope.origin)return null;
  const origin=parseChatRunOrigin(scope.origin),request=parseSessionRequest('readTurnActivity',{contractVersion:SESSION_VERSION,sessionId:origin.chatSessionId,turnId:origin.turnId,afterSequence:0});
  const result=parseSessionMethodResult('readTurnActivity',await api.readTurnActivity(request));
  return result.ok?result.value:null;
 };
}
