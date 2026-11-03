import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createCloudSchematicHost,cloudSchematicExtension} from '../apps/desktop/src/main/schematic/cloud-synthetic-schematic';
import {CLOUD_SCHEMATIC_VERSION,CLOUD_SCHEMATIC_FIXTURE_ID,CLOUD_SCHEMATIC_CHANNEL} from '../apps/desktop/src/shared/schematic/cloud-schematic';
const projectId='00000000-0000-4000-8000-000000000001';
const request={contractVersion:CLOUD_SCHEMATIC_VERSION,projectId,fixtureId:CLOUD_SCHEMATIC_FIXTURE_ID};
const raw=()=>({manifestRawFrame:Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.manifest.json')),fixtureRawFrame:Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.json'))});
test('SCH host authorizes exact project and independent view identity without file capabilities',async()=>{
  const other='00000000-0000-4000-8000-000000000002',host=createCloudSchematicHost({hasProject:id=>[projectId,other].includes(id),loadRaw:raw});
  const first=await host.openSynthetic(request,()=>true),second=await host.openSynthetic({...request,projectId:other},()=>true);
  assert.ok(first.ok&&second.ok);assert.notEqual(first.value.projectId,second.value.projectId);assert.deepEqual(first.value.artifactRef,second.value.artifactRef);assert.notEqual(first.value.reviewedCircuitIr,second.value.reviewedCircuitIr);
  assert.deepEqual(Object.keys(first.value).sort(),['contractVersion','projectId','documentRef','artifactRef','freshness','reviewedCircuitIr'].sort());
});
test('SCH rejects caller, invalid request and unknown project before raw loading',async()=>{
  let loads=0;const host=createCloudSchematicHost({hasProject:id=>id===projectId,loadRaw:()=>{loads++;return raw();}});
  assert.deepEqual(await host.openSynthetic(request,()=>false),{ok:false,error:{code:'CAPABILITY_DENIED'}});
  assert.deepEqual(await host.openSynthetic({...request,path:'x'},()=>true),{ok:false,error:{code:'INVALID_REQUEST'}});
  assert.deepEqual(await host.openSynthetic({...request,projectId:'00000000-0000-4000-8000-000000000002'},()=>true),{ok:false,error:{code:'CAPABILITY_DENIED'}});assert.equal(loads,0);
});
test('SCH revoke permanently rejects fresh calls and delayed delivery',async()=>{
  let finish!:(value:ReturnType<typeof raw>)=>void,loads=0;const host=createCloudSchematicHost({hasProject:()=>true,loadRaw:()=>{loads++;return new Promise(resolve=>finish=resolve);}});
  const pending=host.openSynthetic(request,()=>true);host.revoke();finish(raw());
  assert.deepEqual(await pending,{ok:false,error:{code:'CAPABILITY_DENIED'}});
  assert.deepEqual(await host.openSynthetic(request,()=>true),{ok:false,error:{code:'CAPABILITY_DENIED'}});assert.equal(loads,1);
});
test('SCH delayed load rechecks caller and project existence',async()=>{
  for(const scenario of ['caller','project']){let alive=true;const host=createCloudSchematicHost({hasProject:()=>scenario==='project'?alive:true,loadRaw:()=>{alive=false;return raw();}});
  assert.deepEqual(await host.openSynthetic(request,()=>scenario==='caller'?alive:true),{ok:false,error:{code:'CAPABILITY_DENIED'}});}
});
test('SCH corrupt assets and throwing dependencies return sanitized failure',async()=>{
  for(const loadRaw of [()=>{throw new Error('DO_NOT_EXPOSE');},()=>({...raw(),fixtureRawFrame:new Uint8Array([0xff])})]){
    const host=createCloudSchematicHost({hasProject:()=>true,loadRaw});assert.deepEqual(await host.openSynthetic(request,()=>true),{ok:false,error:{code:'INTERNAL'}});
  }
  const host=createCloudSchematicHost({hasProject:()=>{throw Error('DO_NOT_EXPOSE');},loadRaw:raw});assert.deepEqual(await host.openSynthetic(request,()=>true),{ok:false,error:{code:'CAPABILITY_DENIED'}});
});
test('SCH cloud extension binds current caller and disposes only its fixed channel',async()=>{
  const owner={senderId:1,isTopFrame:true,appOrigin:'file://',navigationEpoch:1,appSessionId:'session',windowId:'window',webContentsId:1,workspaceId:'workspace',rootId:'root'};
  let handler:((event:unknown,value:unknown)=>Promise<unknown>)|undefined;const removed:string[]=[];
  const context={owner,deriveCallerContext:(event:unknown)=>event,ipcMain:{removeHandler:(channel:string)=>removed.push(channel),handle:(channel:string,next:typeof handler)=>{assert.equal(channel,CLOUD_SCHEMATIC_CHANNEL);handler=next;}}};
  const extension=cloudSchematicExtension({hasProject:()=>true,loadRaw:raw})(context as never);assert.ok(handler);
  assert.deepEqual(await handler({...owner,isTopFrame:false},request),{ok:false,error:{code:'CAPABILITY_DENIED'}});
  assert.equal((await handler(owner,request) as {ok:boolean}).ok,true);extension.revoke();assert.deepEqual(await handler(owner,request),{ok:false,error:{code:'CAPABILITY_DENIED'}});extension.dispose();assert.deepEqual(removed,[CLOUD_SCHEMATIC_CHANNEL,CLOUD_SCHEMATIC_CHANNEL]);
});
