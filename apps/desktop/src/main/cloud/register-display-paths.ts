import type {DesktopBootstrapOptionsV1} from '../bootstrap';
import {createAgentCallerFenceV1} from '../agent/agent-caller-fence';
import {createDisplayPathHost,createDisplayPathStore,type DisplayPathStore} from './display-path-host';
import {displayPathChannel,displayPathFailure,parseDisplayPathResult} from '../../shared/agent/display-paths';
export function displayPathExtension(options:{root:string;directory:string;store?:DisplayPathStore}):NonNullable<DesktopBootstrapOptionsV1['registerExtension']>{
 return context=>{
  const host=createDisplayPathHost(options.store??createDisplayPathStore(options.root,options.directory)),fence=createAgentCallerFenceV1({caller:context.owner,capabilities:['start_turn'],generation:1});
  for(const method of ['read','remember'] as const){const channel=displayPathChannel(method);context.ipcMain.removeHandler(channel);context.ipcMain.handle(channel,(event:unknown,value:unknown)=>{
   try{return parseDisplayPathResult(host.invoke(method,value,fence.authorizeInvocation({caller:context.deriveCallerContext(event),operation:'startTurn'}).allowed));}catch{return displayPathFailure('CAPABILITY_DENIED');}
  });}
  return {revoke(){host.revoke();},dispose(){host.revoke();for(const method of ['read','remember'] as const)context.ipcMain.removeHandler(displayPathChannel(method));}};
 };
}
