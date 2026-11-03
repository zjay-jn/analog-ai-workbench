import type { ProjectReadEventData, ProjectReadRun } from '../../shared/agent/agent-project-read';
import { isDeepStrictEqual } from 'node:util';
import type { CommandExecution, CommandObservation } from '../../shared/agent/agent-command';
import { isCommandToolName } from '../../shared/agent/agent-command-validation';
import { commandDigest } from './logs';
import { commandRequestSignature } from './state';

/** Ledger audit binds command evidence to the issuing work task, without granting replay authority. */
export function commandObservationStart(run:ProjectReadRun,source:ProjectReadRun|undefined,observation:CommandObservation):CommandExecution|null{
  if(!source||source.runId!==observation.runId||source.runId===run.runId||!source.workCycle||!source.origin||!run.origin
    ||source.origin.chatSessionId!==run.origin.chatSessionId||source.project.bindingId===null||run.project.bindingId===null
    ||source.project.projectId!==run.project.projectId||source.project.bindingId!==run.project.bindingId||source.project.identity!==run.project.identity
    ||['preparing','running','waiting_user'].includes(source.status)||source.updatedAt>run.createdAt)return null;
  const event=source.events[observation.startSequence-1];
  return event?.sequence===observation.startSequence&&event.type==='tool.completed'&&event.data.toolName==='command_start'
    &&event.data.result.ok&&event.data.result.value.kind==='command_start'?event.data.result.value.execution:null;
}

export function createCommandHistoryAudit(runId:string,workspace:string|undefined|(()=>string|undefined),fail:()=>never,resolveObservation?:(source:CommandObservation)=>CommandExecution|null){
  const executions=new Map<string,CommandExecution>(),requests=new Map<string,string>();
  const observed=new Map<string,{source:CommandObservation;execution:CommandExecution}>();
  function follows(e:CommandExecution,previous:CommandExecution):void{
    for(const key of ['executionId','runId','workspaceId','requestId','signature','environment','baselineVersion','cwdRelativePath','commandText','commandSha256','scriptSha256','createdAt','deadlineAt'] as const)if(!isDeepStrictEqual(e[key],previous[key]))fail();
    if(e.revision<previous.revision||previous.exit?.shellExited&&(!e.exit?.shellExited||e.exit.shellExitCode!==previous.exit.shellExitCode||e.exit.observedAt!==previous.exit.observedAt))fail();
    if(previous.runtime&&!isDeepStrictEqual(previous.runtime,e.runtime)||previous.artifactCollection&&!isDeepStrictEqual(previous.artifactCollection,e.artifactCollection))fail();
  }
  function logBytes(p:import('../../shared/agent/agent-command').CommandLogPage):void{const bytes=Buffer.from(p.data,p.format==='base64'?'base64':'utf8');if(bytes.length!==p.endOffset-p.offset||commandDigest(bytes)!==p.bytesSha256)fail();}
  return (call:ProjectReadEventData['tool.completed']):void=>{
    if(!isCommandToolName(call.toolName)||!call.result.ok)return;const value=call.result.value;
    const workspaceId=typeof workspace==='function'?workspace():workspace;
    if((value.kind==='command_status'||value.kind==='command_log')&&value.observation){
      const source=value.observation,start=resolveObservation?.(source);if(!start)return fail();
      const executionId=value.kind==='command_status'?value.execution.executionId:value.page.executionId,prior=observed.get(executionId);
      if(executionId!==start.executionId||prior&&!isDeepStrictEqual(prior.source,source))return fail();
      if(value.kind==='command_status'){follows(value.execution,prior?.execution??start);observed.set(executionId,{source,execution:value.execution});}
      else logBytes(value.page);
      return;
    }
    if(!workspaceId)return fail();
    if(value.kind==='command_environment'){if(value.workspace&&value.workspace.workspaceId!==workspaceId)fail();return;}
    if(value.kind==='command_log'){
      const p=value.page;if(!executions.has(p.executionId))fail();logBytes(p);return;
    }
    if(value.kind!=='command_start'&&value.kind!=='command_status'&&value.kind!=='command_stop')return fail();
    const e=value.execution,previous=executions.get(e.executionId);
    if(e.runId!==runId||e.workspaceId!==workspaceId)return fail();
    if(call.toolName==='command_start'){
      if(e.signature!==commandRequestSignature(runId,call.arguments))return fail();const old=requests.get(e.requestId);if(old&&old!==e.executionId)return fail();requests.set(e.requestId,e.executionId);
    }else if(!previous)return fail();
    if(previous&&(e.signature!==previous.signature||e.revision<previous.revision||previous.exit?.shellExited&&(!e.exit?.shellExited||e.exit.shellExitCode!==previous.exit.shellExitCode||e.exit.observedAt!==previous.exit.observedAt)))return fail();
    if(previous?.runtime&&!isDeepStrictEqual(previous.runtime,e.runtime))return fail();
    if(previous?.artifactCollection&&!isDeepStrictEqual(previous.artifactCollection,e.artifactCollection))return fail();
    executions.set(e.executionId,e);
  };
}
