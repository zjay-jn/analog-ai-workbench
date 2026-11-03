import type {DesktopBootstrapOptionsV1} from '../bootstrap';import {createAgentCallerFenceV1} from '../agent/agent-caller-fence';
import {EDIT_CHANNEL,parseEditSaveResult} from '../../shared/agent/reviewed-edit';import {createReviewedSaveHost} from './reviewed-save';
export function reviewedSaveExtension(chooseFile:(name:string)=>Promise<string|undefined>):NonNullable<DesktopBootstrapOptionsV1['registerExtension']>{
 return context=>{
  const host=createReviewedSaveHost(chooseFile),fence=createAgentCallerFenceV1({caller:context.owner,capabilities:['start_turn'],generation:1});let revoked=false;
  context.ipcMain.removeHandler(EDIT_CHANNEL);context.ipcMain.handle(EDIT_CHANNEL,async(event:unknown,value:unknown)=>{
   const allowed=()=>{try{return !revoked&&fence.authorizeInvocation({caller:context.deriveCallerContext(event),operation:'startTurn'}).allowed;}catch{return false;}};
   return parseEditSaveResult(await host.save(value,allowed));
  });
  return {revoke(){revoked=true;host.revoke();},dispose(){revoked=true;host.revoke();context.ipcMain.removeHandler(EDIT_CHANNEL);}};
 };
}
