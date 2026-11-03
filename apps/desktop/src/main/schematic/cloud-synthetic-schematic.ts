import type {DesktopBootstrapOptionsV1} from '../bootstrap';
import {createAgentCallerFenceV1} from '../agent/agent-caller-fence';
import {admitCloudDemo} from '../../../../../packages/schematic-workbench/src/cloud-demo-admission';
import {CLOUD_SCHEMATIC_CHANNEL,CLOUD_SCHEMATIC_VERSION,parseCloudSchematicRequest,parseCloudSchematicResult,cloudSchematicFailure,type CloudSchematicResult} from '../../shared/schematic/cloud-schematic';

export type CloudSchematicHostOptions=Readonly<{
  hasProject:(projectId:string)=>boolean;
  loadRaw:()=>Readonly<{manifestRawFrame:Uint8Array;fixtureRawFrame:Uint8Array}>|Promise<Readonly<{manifestRawFrame:Uint8Array;fixtureRawFrame:Uint8Array}>>;
}>;
export function createCloudSchematicHost(options:CloudSchematicHostOptions){
  let revoked=false,generation=0;
  return Object.freeze({
    async openSynthetic(value:unknown,authorized:()=>boolean):Promise<CloudSchematicResult>{
      const currentGeneration=generation;
      const allowed=()=>{try{return !revoked&&generation===currentGeneration&&authorized();}catch{return false;}};
      if(!allowed())return cloudSchematicFailure('CAPABILITY_DENIED');
      let request;try{request=parseCloudSchematicRequest(value);}catch{return cloudSchematicFailure('INVALID_REQUEST');}
      const projectExists=()=>{try{return options.hasProject(request.projectId);}catch{return false;}};
      if(!projectExists())return cloudSchematicFailure('CAPABILITY_DENIED');
      try{
        const raw=await options.loadRaw();
        if(!allowed()||!projectExists())return cloudSchematicFailure('CAPABILITY_DENIED');
        const entry=admitCloudDemo(raw.manifestRawFrame,raw.fixtureRawFrame);
        const result=parseCloudSchematicResult({ok:true,value:{contractVersion:CLOUD_SCHEMATIC_VERSION,projectId:request.projectId,documentRef:entry.documentRef,artifactRef:entry.artifactRef,freshness:entry.freshness,reviewedCircuitIr:entry.circuitIr}},request.projectId);
        return allowed()&&projectExists()?result:cloudSchematicFailure('CAPABILITY_DENIED');
      }catch{return cloudSchematicFailure(allowed()&&projectExists()?'INTERNAL':'CAPABILITY_DENIED');}
    },
    revoke():void{revoked=true;generation+=1;},
  });
}
export function cloudSchematicExtension(options:CloudSchematicHostOptions):NonNullable<DesktopBootstrapOptionsV1['registerExtension']>{
  return context=>{
    const host=createCloudSchematicHost(options),fence=createAgentCallerFenceV1({caller:context.owner,capabilities:['resolve_artifact'],generation:1});
    context.ipcMain.removeHandler(CLOUD_SCHEMATIC_CHANNEL);
    context.ipcMain.handle(CLOUD_SCHEMATIC_CHANNEL,(event:unknown,value:unknown)=>host.openSynthetic(value,()=>fence.authorizeInvocation({caller:context.deriveCallerContext(event),operation:'resolveArtifact'}).allowed));
    return {revoke(){host.revoke();},dispose(){host.revoke();context.ipcMain.removeHandler(CLOUD_SCHEMATIC_CHANNEL);}};
  };
}
