import type {DesktopBootstrapOptionsV1} from '../bootstrap';
import {createAgentCallerFenceV1} from '../agent/agent-caller-fence';
import {REVIEWED_SCHEMATIC_CHANNELS,reviewedSchematicFailure} from '../../shared/schematic/reviewed-schematic';
import {createReviewedSchematicHost,type ReviewedSchematicHostOptions} from './reviewed-schematic-host';
export function reviewedSchematicExtension(options:ReviewedSchematicHostOptions){return (context:Parameters<NonNullable<DesktopBootstrapOptionsV1['registerExtension']>>[0])=>{
  const host=createReviewedSchematicHost(options),fence=createAgentCallerFenceV1({caller:context.owner,capabilities:['resolve_artifact'],generation:1});let revoked=false;
  for(const method of Object.keys(REVIEWED_SCHEMATIC_CHANNELS) as (keyof typeof REVIEWED_SCHEMATIC_CHANNELS)[]){
    const channel=REVIEWED_SCHEMATIC_CHANNELS[method];context.ipcMain.removeHandler(channel);
    context.ipcMain.handle(channel,async(event:unknown,value:unknown)=>{
      const allowed=()=>{try{return !revoked&&fence.authorizeInvocation({caller:context.deriveCallerContext(event),operation:'resolveArtifact'}).allowed;}catch{return false;}};
      const result=await host.invoke(method,value,allowed);return allowed()?result:reviewedSchematicFailure('CAPABILITY_DENIED');
    });
  }
  return {validateContextsForProject:host.validateContextsForProject,revoke(){revoked=true;host.revoke();},dispose(){revoked=true;host.revoke();for(const channel of Object.values(REVIEWED_SCHEMATIC_CHANNELS))context.ipcMain.removeHandler(channel);}};
};}
