import type {DesktopBootstrapOptionsV1} from '../bootstrap';
import {createAgentCallerFenceV1} from '../agent/agent-caller-fence';
import {PROJECT_FOLDER_METHODS,projectFolderChannel,projectFolderFailure,parseProjectFolderResult} from '../../shared/agent/project-folders';
import {createProjectFolderHost,createProjectFolderStore,type ProjectFolderStore,type ProjectCreationWorkspace} from './project-folder-host';
type ExtensionContext=Parameters<NonNullable<DesktopBootstrapOptionsV1['registerExtension']>>[0];
export function projectFolderExtension(options:{root:string;directory:string;chooseFolder:()=>Promise<string|undefined>;hasProject:(id:string)=>boolean;workspace:ProjectCreationWorkspace;store?:ProjectFolderStore}){
 return (context:ExtensionContext)=>{
  const host=createProjectFolderHost({...options,store:options.store??createProjectFolderStore(options.root,options.directory)}),fence=createAgentCallerFenceV1({caller:context.owner,capabilities:['start_turn'],generation:1});
  for(const method of PROJECT_FOLDER_METHODS){const channel=projectFolderChannel(method);context.ipcMain.removeHandler(channel);context.ipcMain.handle(channel,async(event:unknown,value:unknown)=>{try{return parseProjectFolderResult(method,await host.invoke(method,value,()=>fence.authorizeInvocation({caller:context.deriveCallerContext(event),operation:'startTurn'}).allowed));}catch{return projectFolderFailure('IO_ERROR');}});}
  return {snapshotBinding:host.snapshotBinding,revoke(){host.revoke();},dispose(){host.revoke();for(const method of PROJECT_FOLDER_METHODS)context.ipcMain.removeHandler(projectFolderChannel(method));}};
 };
}
