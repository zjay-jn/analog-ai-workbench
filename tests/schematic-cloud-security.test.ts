import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {admitCloudDemo} from '../packages/schematic-workbench/src/cloud-demo-admission';
import {createSyntheticAdmissionRegistryV1} from '../packages/schematic-workbench/src/synthetic-admission';
import {sha256CanonicalAawJsonV1} from '../packages/schematic-workbench/src/canonical-json';
import {createCloudSchematicHost,cloudSchematicExtension,type CloudSchematicHostOptions} from '../apps/desktop/src/main/schematic/cloud-synthetic-schematic';
import {CLOUD_SCHEMATIC_CHANNEL,CLOUD_SCHEMATIC_VERSION,CLOUD_SCHEMATIC_FIXTURE_ID,CLOUD_SCHEMATIC_DOCUMENT_REF,CLOUD_SCHEMATIC_ARTIFACT_REF,parseCloudSchematicRequest,parseCloudSchematicResult,type CloudSchematicResult} from '../apps/desktop/src/shared/schematic/cloud-schematic';
import {createProductionReviewedArtifactRegistryV1} from '../apps/desktop/src/main/schematic/reviewed-artifact-registry';
import type {AgentCallerContextV1} from '../apps/desktop/src/main/agent/agent-caller-fence';
import {createInitialViewerViewStateV1,reduceViewerViewStateV1} from '../packages/schematic-workbench/src/viewer/view-state';
import {createCloudSchematicTabs} from '../apps/desktop/src/renderer/schematic/cloud-schematic-tabs';

// Independent security vectors. Only committed synthetic assets are read; no Electron app,
// persisted workspace/chat data, credentials, provider request, or real filesystem loader.
const projectId='00000000-0000-4000-8000-000000000001';
const otherProjectId='00000000-0000-4000-8000-000000000002';
const request={contractVersion:CLOUD_SCHEMATIC_VERSION,projectId,fixtureId:CLOUD_SCHEMATIC_FIXTURE_ID};
const owner:AgentCallerContextV1=Object.freeze({senderId:7,isTopFrame:true,appOrigin:'file://',navigationEpoch:1,appSessionId:'session.synthetic',windowId:'window.synthetic',webContentsId:7,workspaceId:'workspace.synthetic',rootId:'root.synthetic'});
function frames(){return {manifestRawFrame:Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.manifest.json')),fixtureRawFrame:Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.json'))};}
function success(){const raw=frames(),entry=admitCloudDemo(raw.manifestRawFrame,raw.fixtureRawFrame);return {ok:true as const,value:{contractVersion:CLOUD_SCHEMATIC_VERSION,projectId,documentRef:entry.documentRef,artifactRef:entry.artifactRef,freshness:'current' as const,reviewedCircuitIr:entry.circuitIr}};}
function code(result:CloudSchematicResult){assert.equal(result.ok,false);if(result.ok)throw Error('Expected failure');return result.error.code;}
function deferred<T>(){let finish!:(value:T)=>void;const promise=new Promise<T>(resolve=>{finish=resolve;});return {promise,finish};}
function extensionHarness(options?:Partial<CloudSchematicHostOptions>){
  const handlers=new Map<string,(event:unknown,value:unknown)=>Promise<CloudSchematicResult>>();
  let derived:unknown=owner,deriveThrows=false,loads=0;
  const context={owner,deriveCallerContext:(_event:unknown)=>{if(deriveThrows)throw Error('PRIVATE_CALLER_DETAIL');return derived;},ipcMain:{removeHandler:(channel:string)=>{handlers.delete(channel);},handle:(channel:string,handler:(event:unknown,value:unknown)=>Promise<CloudSchematicResult>)=>{handlers.set(channel,handler);}}};
  const extension=cloudSchematicExtension({hasProject:id=>id===projectId||id===otherProjectId,loadRaw:()=>{loads++;return frames();},...options})(context as unknown as Parameters<ReturnType<typeof cloudSchematicExtension>>[0]);
  const retained=handlers.get(CLOUD_SCHEMATIC_CHANNEL);assert.ok(retained);
  return {handlers,extension,retained,loads:()=>loads,caller:(value:unknown)=>{derived=value;},throwDerivation:()=>{deriveThrows=true;}};
}

test('SCH security fixed synthetic profile is pinned independently and does not change P3 history',()=>{
  const raw=frames();
  assert.equal(createHash('sha256').update(raw.fixtureRawFrame).digest('hex'),'7799af98416e2a340d045eb6a0b68a42e0fe2a371ef7b8a07588590cb8a3e3c9');
  assert.equal(createHash('sha256').update(raw.manifestRawFrame).digest('hex'),'6603bb05962bceecd11ab2d0539059ec49124ac2aff63a9400f6ddc448abfd1b');
  assert.equal(raw.manifestRawFrame.byteLength,1017);
  const manifest=JSON.parse(Buffer.from(raw.manifestRawFrame).toString('utf8'));
  assert.equal(manifest.license,'MIT');
  for(const license of ['UNLICENSED; internal product synthetic test asset','UNKNOWN'])assert.throws(()=>admitCloudDemo(Uint8Array.from(Buffer.from(JSON.stringify({...manifest,license}))),raw.fixtureRawFrame));
  const entry=admitCloudDemo(raw.manifestRawFrame,raw.fixtureRawFrame);
  assert.equal(entry.payloadDigest,'sha256:13428144e3e4cb7aa415883b2e2f2605c1aaac1af9f7cbbb5cb704b178b1b3c5');
  assert.deepEqual(entry.documentRef,CLOUD_SCHEMATIC_DOCUMENT_REF);assert.deepEqual(entry.artifactRef,CLOUD_SCHEMATIC_ARTIFACT_REF);
  assert.equal(entry.dirty,false);assert.equal(Object.isFrozen(entry.circuitIr.definitions[0]),true);
  const p3Manifest=Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/approved-synthetic-fixtures.manifest.json'));
  assert.equal(createHash('sha256').update(p3Manifest).digest('hex'),'b446b2063c9c580dd4009f43759f42e02bba851dd8070b94ab76acb1f7282ff4');
  assert.equal(createHash('sha256').update(readFileSync('packages/schematic-workbench/fixtures/flat-basic.json')).digest('hex'),'e7a602fb696a136c1f37b06eec074770168ca0b7b4cf12891c0c06b96f5f3afb');
  assert.throws(()=>createSyntheticAdmissionRegistryV1(raw.manifestRawFrame));
  assert.throws(()=>admitCloudDemo(p3Manifest,raw.fixtureRawFrame));
  const production=createProductionReviewedArtifactRegistryV1();assert.equal(production.size(),0);assert.deepEqual(production.fixtureIds(),[]);
  assert.throws(()=>production.resolveExact({documentRef:entry.documentRef,artifactRef:entry.artifactRef}));
});

test('SCH security cannot self-approve changed payload using a matching attacker manifest',()=>{
  const raw=frames(),original=JSON.parse(Buffer.from(raw.fixtureRawFrame).toString('utf8'));
  original.definitions[0].labels[0].text='replacement synthetic content';
  const alteredFrame=Uint8Array.from(Buffer.from(JSON.stringify(original)));
  const manifest=JSON.parse(Buffer.from(raw.manifestRawFrame).toString('utf8'));
  manifest.byteLength=alteredFrame.byteLength;manifest.rawSha256='sha256:'+createHash('sha256').update(alteredFrame).digest('hex');manifest.payloadDigest=sha256CanonicalAawJsonV1(original);
  assert.throws(()=>admitCloudDemo(Uint8Array.from(Buffer.from(JSON.stringify(manifest))),alteredFrame));
  assert.throws(()=>admitCloudDemo(raw.manifestRawFrame,alteredFrame));
  assert.throws(()=>admitCloudDemo(raw.manifestRawFrame,new Uint8Array(65537)));
  assert.throws(()=>admitCloudDemo(new Uint8Array(16385),raw.fixtureRawFrame));
});

test('SCH security exact requests reject path/raw/identity/caller inputs without evaluating getters',async()=>{
  const h=extensionHarness();
  for(const field of ['path','url','html','svg','rawFrame','reviewedCircuitIr','documentRef','artifactRef','owner','caller','receipt']){
    const input={...request,[field]:'PRIVATE_REQUEST_DETAIL'};assert.throws(()=>parseCloudSchematicRequest(input));assert.equal(code(await h.retained({},input)),'INVALID_REQUEST');
  }
  for(const input of [null,[],{...request,fixtureId:'flat-basic'},{...request,fixtureId:'../cloud-demo'},{...request,projectId:'C:/private/design'},{...request,contractVersion:'wrong'},Object.assign(Object.create(null),request)])assert.equal(code(await h.retained({},input)),'INVALID_REQUEST');
  let getters=0;const accessor={...request};Object.defineProperty(accessor,'projectId',{enumerable:true,get(){getters++;throw Error('getter');}});
  assert.equal(code(await h.retained({},accessor)),'INVALID_REQUEST');assert.equal(getters,0);assert.equal(h.loads(),0);
});

test('SCH security each main caller ownership dimension fails closed before raw load',async()=>{
  const h=extensionHarness();
  const mutations:Partial<AgentCallerContextV1>[]=[{senderId:8},{isTopFrame:false},{appOrigin:'https://invalid.example'},{navigationEpoch:2},{appSessionId:'other'},{windowId:'other'},{webContentsId:8},{workspaceId:'other'},{rootId:'other'}];
  for(const mutation of mutations){h.caller({...owner,...mutation});assert.equal(code(await h.retained({},request)),'CAPABILITY_DENIED');}
  h.caller(null);assert.equal(code(await h.retained({},request)),'CAPABILITY_DENIED');h.throwDerivation();assert.equal(code(await h.retained({},request)),'CAPABILITY_DENIED');assert.equal(h.loads(),0);
});

test('SCH security unknown projects and membership exceptions do not load synthetic assets',async()=>{
  for(const hasProject of [()=>false,()=>{throw Error('PRIVATE_PROJECT_PATH');}]){
    let loads=0;const host=createCloudSchematicHost({hasProject,loadRaw:()=>{loads++;return frames();}});
    assert.deepEqual(await host.openSynthetic(request,()=>true),{ok:false,error:{code:'CAPABILITY_DENIED'}});assert.equal(loads,0);
  }
});

test('SCH security revoke and dispose permanently deny retained handlers, even with original caller',async()=>{
  for(const operation of ['revoke','dispose'] as const){
    const h=extensionHarness();assert.equal((await h.retained({},request)).ok,true);const before=h.loads();
    h.extension[operation]();h.extension[operation]();
    assert.equal(code(await h.retained({},request)),'CAPABILITY_DENIED');assert.equal(h.loads(),before);
    if(operation==='dispose')assert.equal(h.handlers.has(CLOUD_SCHEMATIC_CHANNEL),false);
  }
});

test('SCH security revocation denies all concurrent in-flight loads and never resurrects',async()=>{
  const gate=deferred<ReturnType<typeof frames>>();let loads=0;
  const host=createCloudSchematicHost({hasProject:()=>true,loadRaw:()=>{loads++;return gate.promise;}});
  const one=host.openSynthetic(request,()=>true),two=host.openSynthetic({...request,projectId:otherProjectId},()=>true);
  assert.equal(loads,2);host.revoke();gate.finish(frames());
  for(const result of await Promise.all([one,two]))assert.equal(code(result),'CAPABILITY_DENIED');
  assert.equal(code(await host.openSynthetic(request,()=>true)),'CAPABILITY_DENIED');assert.equal(loads,2);
});

test('SCH security changed caller or project during asynchronous load prevents delivery',async()=>{
  for(const change of ['caller','project','derive-throws'] as const){
    const gate=deferred<ReturnType<typeof frames>>();let exists=true;
    const h=extensionHarness({hasProject:()=>exists,loadRaw:()=>gate.promise});const result=h.retained({},request);
    if(change==='caller')h.caller({...owner,navigationEpoch:2});else if(change==='project')exists=false;else h.throwDerivation();
    gate.finish(frames());assert.equal(code(await result),'CAPABILITY_DENIED');
  }
});

test('SCH security final delivery rechecks both authority and membership after validation',async()=>{
  for(const dimension of ['authority','membership'] as const){
    let authorityChecks=0,membershipChecks=0;
    const host=createCloudSchematicHost({hasProject:()=>++membershipChecks<3||dimension!=='membership',loadRaw:frames});
    const result=await host.openSynthetic(request,()=>++authorityChecks<3||dimension!=='authority');
    assert.equal(code(result),'CAPABILITY_DENIED');
    assert.ok(dimension==='authority'?authorityChecks>=3:membershipChecks>=3);
  }
});

test('SCH security failures expose only safe code and no loader details',async()=>{
  const host=createCloudSchematicHost({hasProject:()=>true,loadRaw:()=>{throw Error('PRIVATE_PATH_AND_CONTENT');}});
  assert.deepEqual(await host.openSynthetic(request,()=>true),{ok:false,error:{code:'INTERNAL'}});
  assert.deepEqual(await host.openSynthetic(request,()=>{throw Error('PRIVATE_AUTH');}),{ok:false,error:{code:'CAPABILITY_DENIED'}});
});

test('SCH security full response validates fixed identity, requesting project and nested graph',()=>{
  const valid=success();assert.equal(parseCloudSchematicResult(valid,projectId).ok,true);
  assert.throws(()=>parseCloudSchematicResult(valid,otherProjectId));
  const mutate=(change:(value:typeof valid)=>void)=>{const candidate=structuredClone(valid);change(candidate);assert.throws(()=>parseCloudSchematicResult(candidate,projectId));};
  mutate(v=>{(v.value.documentRef as {revisionId:string}).revisionId='rev-2';});
  mutate(v=>{(v.value.artifactRef as {artifactId:string}).artifactId='synthetic.circuit-ir.flat-basic';});
  mutate(v=>{(v.value as unknown as Record<string,unknown>).path='private';});
  mutate(v=>{(v.value.reviewedCircuitIr as unknown as Record<string,unknown>).svg='<svg onload="bad()"/>';});
  mutate(v=>{(v.value.reviewedCircuitIr.definitions[0]!.nets[0]!.memberElementIds as string[]).push('missing.element');});
  mutate(v=>{(v.value.reviewedCircuitIr.definitions[0]!.labels[0] as unknown as {text:string}).text='x'.repeat(65537);});
});

test('SCH security sparse array budget is enforced before JSON serialization without allocation',()=>{
  const invalid={ok:true,value:{reviewedCircuitIr:{definitions:new Array(1_000_000)}}};
  const original=JSON.stringify;let serializationAttempts=0;
  // Avoid serializing the malicious sparse array itself: merely reaching serialization
  // is the failing oracle. Restore the process global before asserting test results.
  JSON.stringify=((..._args:unknown[])=>{serializationAttempts++;throw Error('STOP_BEFORE_ALLOCATION');}) as typeof JSON.stringify;
  try{assert.throws(()=>parseCloudSchematicResult(invalid));}finally{JSON.stringify=original;}
  assert.equal(serializationAttempts,0,'Sparse length must fail in pre-serialization structural budget');
});

test('SCH security schema-invalid response getters never execute',()=>{
  let reads=0;const invalid={ok:true,value:{}};Object.defineProperty(invalid.value,'reviewedCircuitIr',{enumerable:true,get(){reads++;throw Error('PRIVATE_GETTER');}});
  assert.throws(()=>parseCloudSchematicResult(invalid));assert.equal(reads,0);
});

test('SCH security actual preload exposes one method, blocks raw input and binds returned project',async()=>{
  let exposed:unknown,exposedName='',calls=0;const outputs:unknown[]=[];
  const source=readFileSync('apps/desktop/src/preload/schematic.ts','utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
  const bindings={exports:{},require:(name:string)=>{
    if(name==='electron')return {contextBridge:{exposeInMainWorld:(name:string,api:unknown)=>{exposedName=name;exposed=api;}},ipcRenderer:{invoke:async(channel:string,value:unknown)=>{calls++;assert.equal(channel,CLOUD_SCHEMATIC_CHANNEL);assert.deepEqual(value,request);return outputs.shift();}}};
    if(name==='../shared/schematic/cloud-schematic')return {CLOUD_SCHEMATIC_CHANNEL,parseCloudSchematicRequest,parseCloudSchematicResult,cloudSchematicFailure:(errorCode:string)=>({ok:false,error:{code:errorCode}})};
    throw Error('Unexpected preload dependency: '+name);
  }};
  new vm.Script(compiled,{filename:'schematic-preload-under-review.js'}).runInNewContext(bindings);
  assert.equal(exposedName,'workbenchSchematic');assert.equal(Object.isFrozen(exposed),true);assert.deepEqual(Object.keys(exposed as object),['openSynthetic']);
  const api=exposed as {openSynthetic:(value:unknown)=>Promise<CloudSchematicResult>};
  assert.equal(code(await api.openSynthetic({...request,path:'C:/private'})),'INVALID_REQUEST');assert.equal(calls,0);
  outputs.push({...success(),value:{...success().value,projectId:otherProjectId}});
  assert.equal(code(await api.openSynthetic(request)),'INTERNAL');
  outputs.push({...success(),value:{...success().value,rawFrame:'PRIVATE_CONTENT'}});
  assert.equal(code(await api.openSynthetic(request)),'INTERNAL');
  outputs.push(success());const result=await api.openSynthetic(request);assert.equal(result.ok,true);assert.equal(calls,3);
  assert.ok(result.ok);assert.equal(Object.isFrozen(result.value.reviewedCircuitIr.definitions[0]),true);
});

test('SCH security same-label nets remain distinct and interactions never change admitted IR',()=>{
  const raw=frames(),entry=admitCloudDemo(raw.manifestRawFrame,raw.fixtureRawFrame),ir=entry.circuitIr;
  const before=sha256CanonicalAawJsonV1(ir),definition=ir.definitions[0]!;
  assert.equal(definition.instances.length,2);assert.equal(definition.wires.length,4);assert.equal(definition.nets.length,2);
  assert.equal(definition.labels.find(l=>l.labelId==='label.signal')?.text,definition.labels.find(l=>l.labelId==='label.return')?.text);
  const signal=definition.nets.find(n=>n.netId==='net.signal')!,returned=definition.nets.find(n=>n.netId==='net.return')!;
  assert.equal(signal.memberElementIds.some(id=>returned.memberElementIds.includes(id)),false);
  let state=createInitialViewerViewStateV1(ir,{width:800,height:600},entry.artifactRef);
  state=reduceViewerViewStateV1(ir,state,{type:'primary-select',ctrlKey:false,target:{...entry.artifactRef,occurrencePath:[],definitionId:definition.definitionId,elementKind:'wire',elementId:'wire.signal.link'}});
  state=reduceViewerViewStateV1(ir,state,{type:'toggle-selection-net'});assert.equal(state.netHighlight?.netId,'net.signal');
  state=reduceViewerViewStateV1(ir,state,{type:'keyboard-pan',direction:'right',largeStep:false});
  state=reduceViewerViewStateV1(ir,state,{type:'keyboard-zoom',direction:'out'});
  assert.equal(sha256CanonicalAawJsonV1(ir),before);assert.equal(Object.isFrozen(ir),true);assert.equal(entry.dirty,false);
});

test('SCH security late tab results cannot resurrect closed tabs or overwrite project changes',async()=>{
  const gates:Array<ReturnType<typeof deferred<CloudSchematicResult>>>=[];
  const tabs=createCloudSchematicTabs({openSynthetic:async()=>{const gate=deferred<CloudSchematicResult>();gates.push(gate);return gate.promise;}});
  tabs.setProject(projectId);const closed=tabs.open();tabs.close();gates[0]!.finish(success());await closed;assert.deepEqual(tabs.snapshot(),[]);
  const old=tabs.open();tabs.setProject(otherProjectId);const current=tabs.open();
  gates[1]!.finish(success());await old;assert.equal(tabs.snapshot().find(t=>t.projectId===projectId)?.status,'error');
  gates[2]!.finish({...success(),value:{...success().value,projectId:otherProjectId}});await current;
  assert.equal(tabs.snapshot().find(t=>t.projectId===otherProjectId)?.status,'ready');
  tabs.dispose();assert.deepEqual(tabs.snapshot(),[]);await tabs.open();assert.equal(gates.length,3);
});

test('SCH security same artifact in separate projects has isolated actions and immutable payload',async()=>{
  const tabs=createCloudSchematicTabs({openSynthetic:async req=>({...success(),value:{...success().value,projectId:req.projectId}})});
  tabs.setProject(projectId);await tabs.open();const first=tabs.snapshot()[0]!;assert.ok(first.status==='ready');
  const firstView=first.viewState,firstPayload=sha256CanonicalAawJsonV1(first.delivery.reviewedCircuitIr);
  tabs.setProject(otherProjectId);await tabs.open();const second=tabs.snapshot().find(t=>t.projectId===otherProjectId)!;assert.ok(second.status==='ready');
  assert.deepEqual(second.delivery.artifactRef,first.delivery.artifactRef);assert.notEqual(second.key,first.key);
  tabs.action(first.key,{type:'zoom-css',factor:2,anchorCss:{x:200,y:100}});
  assert.equal((tabs.snapshot().find(t=>t.projectId===otherProjectId) as typeof second).viewState.viewport.zoom,second.viewState.viewport.zoom);
  tabs.selectText();tabs.action(second.key,{type:'zoom-css',factor:2,anchorCss:{x:200,y:100}});
  assert.equal((tabs.snapshot().find(t=>t.projectId===otherProjectId) as typeof second).viewState.viewport.zoom,second.viewState.viewport.zoom);
  tabs.setProject(projectId);const restored=tabs.snapshot().find(t=>t.projectId===projectId)!;assert.ok(restored.status==='ready');assert.equal(restored.viewState,firstView);
  assert.equal(sha256CanonicalAawJsonV1(restored.delivery.reviewedCircuitIr),firstPayload);tabs.dispose();
});

test('SCH security project tab retention is bounded to twelve and evicted identities reset',async()=>{
  let requests=0;const tabs=createCloudSchematicTabs({openSynthetic:async req=>{requests++;return {...success(),value:{...success().value,projectId:req.projectId}};}});
  for(let index=1;index<=13;index++){
    const id='00000000-0000-4000-8000-'+String(index).padStart(12,'0');tabs.setProject(id);await tabs.open();assert.ok(tabs.snapshot().length<=12);
  }
  assert.equal(tabs.snapshot().length,12);assert.equal(tabs.snapshot().some(t=>t.projectId===projectId),false);
  await tabs.open();assert.equal(requests,13);
  tabs.setProject(projectId);await tabs.open();assert.equal(requests,14);const reopened=tabs.snapshot().find(t=>t.projectId===projectId)!;assert.ok(reopened.status==='ready');assert.deepEqual(reopened.viewState.selection,[]);
  tabs.dispose();assert.deepEqual(tabs.snapshot(),[]);
});
