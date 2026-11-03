import type {DesktopBootstrapOptionsV1} from '../bootstrap';
import {createAgentCallerFenceV1} from '../agent/agent-caller-fence';
import {createWorkspaceHost,createWorkspaceStore,type WorkspaceStore} from './project-workspace-host';
import {workspaceChannel,workspaceFailure,parseWorkspaceResult} from '../../shared/agent/project-workspace';
export function workspaceExtension(options:{root:string;directory:string;store?:WorkspaceStore;activeSessionId?:()=>string|null}){
 return (context:Parameters<NonNullable<DesktopBootstrapOptionsV1['registerExtension']>>[0])=>{
  const host=createWorkspaceHost(options.store??createWorkspaceStore(options.root,options.directory),options.activeSessionId),fence=createAgentCallerFenceV1({caller:context.owner,capabilities:['start_turn'],generation:1});
  for(const method of ['read','save'] as const){const channel=workspaceChannel(method);context.ipcMain.removeHandler(channel);context.ipcMain.handle(channel,(event:unknown,value:unknown)=>{
   try{return parseWorkspaceResult(host.invoke(method,value,fence.authorizeInvocation({caller:context.deriveCallerContext(event),operation:'startTurn'}).allowed));}catch{return workspaceFailure('CAPABILITY_DENIED');}
  });}
  return {hasProject:host.hasProject,projectForSession:host.projectForSession,creationSnapshot:host.creationSnapshot,createProject:host.createProject,revoke(){host.revoke();},dispose(){host.revoke();for(const method of ['read','save'] as const)context.ipcMain.removeHandler(workspaceChannel(method));}};
 };
}
