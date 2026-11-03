import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import {admitFoldedSources,type FoldedSourceFiles} from '../packages/schematic-workbench/src/folded-source-profile';
import {adaptFoldedReviewedSources,foldedLocalToDisplay} from '../packages/schematic-workbench/src/folded-adapter';
import {validateReviewedSchematicEnvelope} from '../packages/schematic-workbench/src/reviewed-display-validation';
import {boundReviewedJson,reviewedSha256} from '../packages/schematic-workbench/src/reviewed-json';
import {buildReviewedSvgSceneV1} from '../packages/schematic-workbench/src/viewer/reviewed-svg-scene';
import {createInitialViewerViewStateV1} from '../packages/schematic-workbench/src/viewer/view-state';
import fs from 'node:fs';
import path from 'node:path';
import {createReviewedSourceLoader} from '../apps/desktop/src/main/schematic/reviewed-source-loader';
import * as reviewedApi from '../apps/desktop/src/shared/schematic/reviewed-schematic';
import {createReviewedSchematicHost} from '../apps/desktop/src/main/schematic/reviewed-schematic-host';
import {reviewedSchematicExtension} from '../apps/desktop/src/main/schematic/register-reviewed-schematic';
import type {AgentCallerContextV1} from '../apps/desktop/src/main/agent/agent-caller-fence';
import vm from 'node:vm';
import ts from 'typescript';
import {parseSessionDisk,SESSION_VERSION,type SessionTurn,type SessionDisk} from '../apps/desktop/src/shared/agent/chat-sessions';
import {parseDraftDisk,submittedTurnMatches,type ChatDraft} from '../apps/desktop/src/shared/agent/chat-drafts';
import {messageTextDefault,messageContextFits,schematicContextPrompt,schematicCitations} from '../apps/desktop/src/shared/schematic/schematic-context';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import type {MultimodalRequest} from '../apps/desktop/src/main/cloud/multimodal-context';
import {CONTINUE_TEXT} from '../apps/desktop/src/shared/agent/continuation';
import {createWorkspaceHost} from '../apps/desktop/src/main/cloud/project-workspace-host';
import {emptyWorkspace,newProject,WORKSPACE_VERSION,parseWorkspaceDisk} from '../apps/desktop/src/shared/agent/project-workspace';
import {exportMarkdown} from '../apps/desktop/src/main/cloud/chat-export';
import {planSchematicAttachment,updateDraftText} from '../apps/desktop/src/renderer/schematic/schematic-draft';
import {createDraftController} from '../apps/desktop/src/renderer/agent/draft-controller';
import {fitSchematicVisibleBounds,measureSchematicTextBounds} from '../apps/desktop/src/renderer/schematic/schematic-visible-fit';
import {applySchematicViewerAction} from '../apps/desktop/src/renderer/schematic/viewer-actions';
import {layoutReviewedDisplayText} from '../packages/schematic-workbench/src/viewer/reviewed-text-layout';

// Only the six explicitly approved, product-local export copies are read here.
// No Lab path, live user data, credentials, Electron app or provider transport.
const root='.local/reviewed-schematic/folded-v1/';
const approved=Object.freeze([
  ['snapshot.json',179036,'fd2b44561caf36d811f88dafa7bcaa305e79d7583afa28c7960a94ae6463fcac'],
  ['review.json',2414,'5737e76d5f7b9e015e72d6444151a5c77df6f525faa1053ed718aa3a02eacfbd'],
  ['reviewed-data.js',102996,'65d28ee8bc8776a91e1c830d3d2416b9c1394579207fe6fa191d688aad8b0146'],
  ['snapshot.schema.json',24977,'4ad5238dd76fd9a5c9fc995495813b6051df3d3d1bd2099e48e07f85ca0a8d6f'],
  ['ir.schema.json',25549,'8949aa3cb40b5b85c69d1684700709b91d26e81c1a28a3a532a1d42be92a1562'],
  ['review.schema.json',4337,'3bd6e082cd2d1c9b477d9ee1c727aaff3efa63c71a89d186c5086b468d6795f3'],
] as const);
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
// Data shape is schema-checked separately. This independent oracle intentionally
// does not use the adapter's types, transform, identity-map or digest helpers.
type Row=Record<string,any>;
function approvedBytes(name:typeof approved[number][0]):Buffer{
  const expected=approved.find(row=>row[0]===name)!;const value=readFileSync(root+name);
  assert.equal(value.length,expected[1],name);assert.equal(sha(value),expected[2],name);return value;
}
function sourceData(){
  const snapshot=JSON.parse(approvedBytes('snapshot.json').toString('utf8')) as Row;
  const review=JSON.parse(approvedBytes('review.json').toString('utf8')) as Row;
  const text=approvedBytes('reviewed-data.js').toString('utf8');
  const matched=text.match(/^\/\*[^]*?\*\/\s*window\.AAL_VIEWER_IR\s*=\s*(\{[^]*\});\s*$/);
  assert.ok(matched,'Only a pinned comment + one JSON assignment is accepted; never execute JS');
  return {snapshot,review,ir:JSON.parse(matched[1]!) as Row};
}
function sourceFrames():FoldedSourceFiles{return Object.fromEntries(approved.map(([name])=>[name,approvedBytes(name).toString('utf8')])) as FoldedSourceFiles;}

test('SCH reviewed security exact six approved source copies retain byte identity',()=>{
  for(const [name] of approved)approvedBytes(name);
});

test('SCH reviewed security sidecar scope and binding do not imply automatic model upload',()=>{
  const {snapshot,review,ir}=sourceData();
  assert.equal(review.withdrawalStatus,'active');assert.equal(review.decision,'approved_for_read_only_viewer_v0');assert.equal(review.sanitizationStatus,'approved');
  assert.deepEqual(review.allowedUses,['read_only_schematic_viewer']);
  assert.equal(review.reviewedArtifact.sha256,'sha256:'+approved[0][2]);
  for(const [key,value] of Object.entries(review.binding))assert.equal(key==='snapshotId'?snapshot.snapshotId:snapshot.source[key],value,key);
  assert.equal(ir.source.snapshotId,snapshot.snapshotId);assert.equal(ir.source.reviewRef,review.reviewRef);
  assert.equal(snapshot.source.containsOaDatabaseDump,false);assert.equal(snapshot.source.containsPdkContent,false);
});

test('SCH reviewed security source snapshot, extracted IR and review match pinned schemas',()=>{
  const data=sourceData();
  for(const [schemaName,value] of [['snapshot.schema.json',data.snapshot],['ir.schema.json',data.ir],['review.schema.json',data.review]] as const){
    // No remote schemas or format probes; format strings are not claimed as validated.
    const schema=JSON.parse(approvedBytes(schemaName).toString('utf8'));
    const validate=new Ajv2020({strict:false,allErrors:true,validateFormats:false}).compile(schema);
    assert.equal(validate(value),true,JSON.stringify(validate.errors));
  }
});

test('SCH reviewed security source pins, parameters and unknown fields remain truthful',()=>{
  const {snapshot,ir}=sourceData();const devices=ir.devices as Row[],ports=ir.ports as Row[],pins=devices.flatMap(d=>d.pins as Row[]);
  assert.equal(devices.length,33);assert.equal(pins.length,108);assert.equal(ports.length,6);
  for(const p of [...pins,...ports]){assert.equal(p.position,null);assert.equal(p.positionStatus,'unavailable_in_current_view');}
  for(const p of pins)assert.equal(p.terminalRole,'unknown');
  const bulk=devices.filter(d=>Object.hasOwn(d,'bulkBinding'));assert.equal(bulk.length,27);
  for(const d of bulk)assert.deepEqual(d.bulkBinding,{evidence:'none',status:'implicit_unresolved'});
  assert.equal(devices.filter(d=>!Object.hasOwn(d,'bulkBinding')).length,6);
  assert.deepEqual(ir.symbolDefinitions,[]);assert.deepEqual(ir.conditions,{});
  assert.equal(ir.coordinateSystem.grid.snapSpacingX,null);assert.equal(ir.coordinateSystem.grid.snapSpacingY,null);
  for(const d of devices){
    const original=(snapshot.instances as Row[]).find(source=>source.id===d.id);assert.ok(original);
    assert.deepEqual(d.parameters,original.parameters);assert.deepEqual(d.placement,original.placement);assert.deepEqual(d.master,original.master);assert.equal(d.name,original.name);
    assert.equal(Object.hasOwn(d,'bulkBinding'),Object.hasOwn(original,'bulkBinding'));
    if(Object.hasOwn(original,'bulkBinding'))assert.deepEqual(d.bulkBinding,original.bulkBinding);
    for(const p of d.pins as Row[]){const t:Row|undefined=(original.terminals as Row[]).find(term=>term.id===p.id);assert.ok(t);for(const key of Object.keys(p))if(Object.hasOwn(t,key))assert.deepEqual(p[key],t[key]);}
  }
});

test('SCH reviewed security all electrical membership is explicit with no geometry inference',()=>{
  const {snapshot,ir}=sourceData();const nets=ir.nets as Row[],devices=ir.devices as Row[],ports=ir.ports as Row[],wires=ir.wires as Row[];
  assert.equal(nets.length,17);assert.equal(wires.length,181);
  const endpoints=[...devices.flatMap(d=>d.pins as Row[]),...ports],seen=new Set<string>();
  for(const net of nets){
    const original=(snapshot.nets as Row[]).find(n=>n.id===net.id);assert.ok(original);
    assert.deepEqual(net.members,(original.members as Row[]).map(m=>({...m,objectKind:m.objectKind==='instance_terminal'?'device_pin':m.objectKind})));
    for(const member of net.members as Row[]){assert.equal(seen.has(member.objectId),false);seen.add(member.objectId);const endpoint=endpoints.find(p=>p.id===member.objectId);assert.ok(endpoint);assert.equal(endpoint.netId,net.id);}
  }
  assert.equal(seen.size,114);assert.equal(endpoints.length,114);
  for(const wire of wires)assert.ok(nets.some(n=>n.id===wire.netId));
  for(const p of ports){const original=(snapshot.ports as Row[]).find(port=>port.id===p.id);assert.ok(original);for(const key of Object.keys(original))assert.deepEqual(p[key],original[key]);assert.equal(nets.filter(n=>(n.members as Row[]).some(m=>m.objectId===p.id)).length,1);}
  for(const key of ['wires','labels','graphics','primitiveMappings','symbolDefinitions','displayOrder','coordinateSystem','connectivityPolicy','viewport'])assert.deepEqual(ir[key],snapshot[key],key);
});

test('SCH reviewed security production source admission accepts the exact approved profile',()=>{
  const admitted=admitFoldedSources(sourceFrames()),independent=sourceData().ir;
  assert.deepEqual(admitted,independent);
});

test('SCH reviewed security changed script, sidecar or schema cannot redefine approved source',()=>{
  const files=sourceFrames();
  for(const [name] of approved)assert.throws(()=>admitFoldedSources({...files,[name]:files[name]+'\n'}));
  const review=JSON.parse(files['review.json']);review.withdrawalStatus='withdrawn';
  assert.throws(()=>admitFoldedSources({...files,'review.json':JSON.stringify(review)}));
  assert.throws(()=>admitFoldedSources({...files,'reviewed-data.js':files['reviewed-data.js']+'globalThis.__should_not_execute=true;'}));
  assert.throws(()=>admitFoldedSources({...files,'ir.schema.json':'{"type":"object"}'}));
});

test('SCH reviewed security adapted topology preserves all explicit membership and omits unknown anchors',()=>{
  const source=sourceData().ir,envelope=adaptFoldedReviewedSources(sourceFrames()),definition=envelope.reviewedCircuitIr.definitions[0]!;
  assert.ok(definition.pins);
  assert.equal(definition.instances.length,33);assert.equal(definition.pins.length,108);assert.equal(definition.ports.length,6);
  for(const endpoint of [...definition.pins,...definition.ports]){assert.equal(Object.hasOwn(endpoint,'x'),false);assert.equal(Object.hasOwn(endpoint,'y'),false);}
  for(const net of source.nets as Row[]){
    const actual=definition.nets.find(n=>n.netId===net.id);assert.ok(actual);
    assert.deepEqual(actual.memberElementIds,[...(net.members as Row[]).map(m=>m.objectId),...(source.wires as Row[]).filter(w=>w.netId===net.id).map(w=>w.id)]);
  }
  for(const wire of source.wires as Row[]){const actual=definition.wires.find(w=>w.wireId===wire.id);assert.ok(actual);assert.equal(actual.netId,wire.netId);assert.deepEqual(actual.points,(wire.points as Row[]).map(p=>({x:p.x===0?0:p.x*100,y:p.y===0?0:p.y*-100})));}
});

test('SCH reviewed security adapted metadata preserves parameters and absent bulk evidence',()=>{
  const source=sourceData().ir,{display}=adaptFoldedReviewedSources(sourceFrames());
  for(const device of source.devices as Row[]){
    const actual=display.devices.find(d=>d.id===device.id);assert.ok(actual);
    assert.deepEqual(actual.parameters,device.parameters);assert.deepEqual(actual.master,device.master);assert.deepEqual(actual.placement,device.placement);
    assert.equal(Object.hasOwn(actual,'bulkBinding'),Object.hasOwn(device,'bulkBinding'));
    assert.deepEqual(actual.bulkBinding,device.bulkBinding);
    assert.deepEqual(actual.pinIds,(device.pins as Row[]).map(p=>p.id));
  }
  assert.equal(display.terminals.length,114);
  for(const terminal of display.terminals){assert.equal(terminal.position,null);assert.equal(terminal.positionStatus,'unavailable_in_current_view');assert.equal(terminal.terminalRole,'unknown');}
  assert.equal(display.devices.filter(d=>d.renderEvidence==='placeholder').length,6);
  assert.equal(display.devices.filter(d=>d.renderEvidence==='builtin_normalized_display_only').length,27);
  for(const net of display.nets){const original=(source.nets as Row[]).find(n=>n.id===net.id)!;assert.deepEqual(net.memberIds,(original.members as Row[]).map(m=>m.objectId));}
  assert.equal(display.primitives.some(p=>p.sourceKind==='port'),false,'Unknown port anchors must not become hit targets');
});

test('SCH reviewed security transform covers all eight orientations without changing source placement',()=>{
  const expected={R0:[1200,-2300],R90:[700,-2200],R180:[800,-1700],R270:[1300,-1800],MX:[1200,-1700],MY:[800,-2300],MXR90:[1300,-2200],MYR90:[700,-1800]} as const;
  for(const orientation of Object.keys(expected) as (keyof typeof expected)[]){
    const placement={origin:{x:10,y:20},orientation,boundingBox:{lowerLeft:{x:0,y:0},upperRight:{x:30,y:30}}},before=JSON.stringify(placement);
    assert.deepEqual(foldedLocalToDisplay(placement,{x:2,y:3}),{x:expected[orientation][0],y:expected[orientation][1]});assert.equal(JSON.stringify(placement),before);
  }
});

test('SCH reviewed security adapted digest binds every topology and display field except itself',()=>{
  const first=adaptFoldedReviewedSources(sourceFrames()),second=adaptFoldedReviewedSources(sourceFrames());
  assert.deepEqual(first,second);
  // Independent canonicalization for this admitted JSON-only value; no production digest helper.
  const canonical=(value:any):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
  const {adaptedDigest,...display}=first.display;
  const digest=(value:unknown)=>sha(Buffer.from(canonical(value),'utf8'));
  assert.equal(adaptedDigest,digest({reviewedCircuitIr:first.reviewedCircuitIr,display}));
  assert.notEqual(adaptedDigest,digest({reviewedCircuitIr:first.reviewedCircuitIr,display:{...display,transform:{scaleX:1,scaleY:-1}}}));
  assert.notEqual(adaptedDigest,digest({reviewedCircuitIr:first.reviewedCircuitIr,display:{...display,devices:[]}}));
  assert.ok(Buffer.byteLength(JSON.stringify(first))<2*1024*1024);
});

test('SCH reviewed security display admission pins content and returns an isolated deeply frozen value',()=>{
  const raw=adaptFoldedReviewedSources(sourceFrames()),admitted=validateReviewedSchematicEnvelope(raw);
  assert.deepEqual(admitted,raw);assert.notEqual(admitted,raw);
  const frozen=(v:unknown):void=>{if(v!==null&&typeof v==='object'){assert.equal(Object.isFrozen(v),true);for(const child of Object.values(v))frozen(child);}};frozen(admitted);
  assert.equal(validateReviewedSchematicEnvelope(admitted),admitted);
  for(const mutate of [
    (v:Row)=>{v.display.devices[0].parameters[0].valueText='forged';},
    (v:Row)=>{v.display.primitives[0].tag='script';},
    (v:Row)=>{v.display.terminals[0].position={x:0,y:0};},
    (v:Row)=>{v.reviewedCircuitIr.definitions[0].nets[0].memberElementIds=[];},
    (v:Row)=>{v.display.artifactRef.revisionId='latest';},
    (v:Row)=>{v.display.source.path='C:/secret';},
  ]){
    const changed=structuredClone(raw) as unknown as Row;mutate(changed);assert.throws(()=>validateReviewedSchematicEnvelope(changed));
  }
  assert.throws(()=>validateReviewedSchematicEnvelope({...raw,path:'C:/secret'}));
});

test('SCH reviewed security bounded JSON rejects non-data structures and allocation abuse before clone',()=>{
  let getterCalls=0;const accessor=Object.defineProperty({},'x',{enumerable:true,get(){getterCalls++;return 1;}});
  const cycle:Row={};cycle.self=cycle;const hidden=Object.defineProperty({},'x',{value:1});
  const deep:Row={};let tail=deep;for(let i=0;i<34;i++){tail.child={};tail=tail.child;}
  for(const invalid of [accessor,cycle,hidden,deep,new Date(),Object.create(null),{x:undefined},{x:BigInt(1)},{x:()=>0},{x:NaN},{x:Infinity},{x:-0},new Array(3),Array(4097).fill(0),{x:'a'.repeat(16385)},{x:'\ud800'},Object.fromEntries(Array.from({length:65},(_,i)=>['k'+i,i])),{[Symbol('x')]:1}])assert.throws(()=>boundReviewedJson(invalid));
  assert.equal(getterCalls,0);assert.throws(()=>boundReviewedJson({text:'1234567890'},8));
  for(const text of ['', 'abc','原理图参数 W="1u"', '🧪'.repeat(300)])assert.equal(reviewedSha256(text),sha(Buffer.from(text,'utf8')));
});

test('SCH reviewed security scene exposes only source display targets and clears revoked geometry',()=>{
  const envelope=validateReviewedSchematicEnvelope(adaptFoldedReviewedSources(sourceFrames())),artifactRef=envelope.display.artifactRef;
  const viewState=createInitialViewerViewStateV1(envelope.reviewedCircuitIr,{width:1200,height:800},artifactRef);
  const before=JSON.stringify(envelope),input={envelope,artifactRef,viewState};
  const scene=buildReviewedSvgSceneV1({...input,renderState:{status:'ready',freshness:'current'}});
  assert.equal(scene.hitTargets.length,33+181+24);
  assert.equal(scene.hitTargets.some(t=>t.target.elementKind==='pin'||t.target.elementKind==='port'),false);
  assert.equal(scene.primitives.every(p=>['polyline','circle','text'].includes(p.tag)),true);
  for(const primitive of scene.primitives)for(const attribute of Object.keys(primitive.attributes))assert.equal(/^(on|href|src|style)/i.test(attribute),false);
  const revoked=buildReviewedSvgSceneV1({...input,renderState:{status:'revoked'}});
  assert.deepEqual(revoked.primitives,[]);assert.deepEqual(revoked.hitTargets,[]);assert.equal(revoked.deliveryAllowed,false);assert.equal(revoked.cancelDelivery,true);
  assert.throws(()=>buildReviewedSvgSceneV1({...input,artifactRef:{...artifactRef,revisionId:'latest'},renderState:{status:'ready',freshness:'current'}}));
  assert.equal(JSON.stringify(envelope),before);
});

test('SCH reviewed security fixed loader checks original bytes, links, handle identity and cached revalidation',t=>{
  const files=new Map<string,Buffer>(approved.map(([name])=>[name,approvedBytes(name)]));
  const appRoot=path.resolve('.local/security-memory-only-root');
  for(const scenario of ['normal','bom','symlink','hardlink','parent-link','realpath','changed-handle','oversize','cache-withdrawal'] as const){
    let nextFd=100,reads=0,closes=0,withdrawn=false;const handles=new Map<number,{name:string;position:number}>();
    const bytes=(name:string)=>{const original=files.get(name)!;return (scenario==='bom'||withdrawn)&&name==='snapshot.json'?Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),original]):original;};
    const stat=(name:string)=>({dev:1,ino:files.has(name)?Array.from(files.keys()).indexOf(name)+100:1,nlink:scenario==='hardlink'?2:1,size:files.has(name)?bytes(name).length:0,mtimeMs:1,ctimeMs:1,isFile:()=>files.has(name),isDirectory:()=>!files.has(name),isSymbolicLink:()=>scenario==='symlink'&&name==='snapshot.json'||scenario==='parent-link'&&name==='folded-v1'});
    const mock=(object:any,key:string,implementation:any)=>(t.mock.method as any)(object,key,implementation);
    mock(fs,'lstatSync',(file:string)=>{const name=path.basename(file),s=stat(name);return scenario==='oversize'&&name==='snapshot.json'?{...s,size:1048577}:s;});
    mock(fs.realpathSync,'native',(file:string)=>scenario==='realpath'&&path.basename(file)==='snapshot.json'?file+'.other':file);
    mock(fs,'openSync',(file:string)=>{const name=path.basename(file);assert.ok(files.has(name),'Only fixed six source names may be opened');const fd=nextFd++;handles.set(fd,{name,position:0});return fd;});
    mock(fs,'fstatSync',(fd:number)=>{const handle=handles.get(fd)!;const s=stat(handle.name);return scenario==='changed-handle'?{...s,ino:999}:s;});
    mock(fs,'readSync',(fd:number,buffer:Buffer,offset:number,length:number)=>{reads++;const handle=handles.get(fd)!,content=bytes(handle.name),count=Math.min(length,content.length-handle.position);content.copy(buffer,offset,handle.position,handle.position+count);handle.position+=count;return count;});
    mock(fs,'closeSync',(fd:number)=>{assert.ok(handles.delete(fd));closes++;});
    try{
      const load=createReviewedSourceLoader(appRoot);
      if(scenario==='normal'){assert.equal(load().display.counts.devices,33);assert.ok(reads>=6);assert.equal(closes,6);}
      else if(scenario==='cache-withdrawal'){load();withdrawn=true;assert.throws(load,'A cached envelope cannot hide changed source bytes');}
      else assert.throws(load,scenario);
      assert.equal(handles.size,0,'All opened descriptors must be closed on rejection');
      if(['symlink','hardlink','parent-link','realpath','oversize'].includes(scenario))assert.equal(reads,0);
    }finally{t.mock.restoreAll();}
  }
});

test('SCH reviewed security actual fixed loader opens only the approved product copies and returns a pinned frozen envelope',()=>{
  const load=createReviewedSourceLoader(path.resolve('.'));
  const first=load();assert.equal(first.display.counts.devices,33);assert.equal(first.display.sourceDigest,approved[0][2]);assert.equal(Object.isFrozen(first),true);
  assert.equal(load(),first,'A cache hit still rereads and verifies all fixed source files');
});

const projectId='10000000-0000-4000-8000-000000000001',otherProjectId='10000000-0000-4000-8000-000000000002';
function reference(envelope:ReturnType<typeof adaptFoldedReviewedSources>,targets:readonly reviewedApi.SchematicSelectionTarget[]):reviewedApi.SchematicReference{
  return {kind:'schematic_reference',projectId,datasetId:reviewedApi.REVIEWED_SCHEMATIC_DATASET,documentRef:envelope.display.documentRef,artifactRef:envelope.display.artifactRef,sourceDigest:envelope.display.sourceDigest,adaptedDigest:envelope.display.adaptedDigest,targets};
}

test('SCH reviewed security narrow request parsers reject path, raw data, hierarchy and revision injection',()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),ref=reference(envelope,[{kind:'instance',definitionId:envelope.display.definitionId,occurrencePath:[],elementId:envelope.display.devices[0]!.id}]);
  const request={contractVersion:reviewedApi.REVIEWED_SCHEMATIC_VERSION,projectId,datasetId:reviewedApi.REVIEWED_SCHEMATIC_DATASET};
  assert.deepEqual(reviewedApi.parseOpenReviewedRequest(request),request);
  for(const addition of [{path:'C:/secret'},{url:'https://example.invalid'},{raw:'{}'},{source:envelope}])assert.throws(()=>reviewedApi.parseOpenReviewedRequest({...request,...addition}));
  assert.throws(()=>reviewedApi.parseOpenReviewedRequest({...request,datasetId:'../snapshot.json'}));
  assert.throws(()=>reviewedApi.parseSchematicReference({...ref,artifactRef:{...ref.artifactRef,revisionId:'latest'}}));
  assert.throws(()=>reviewedApi.parseSchematicReference({...ref,sourceDigest:'0'.repeat(64)}));
  assert.throws(()=>reviewedApi.parseSchematicTargets([{...ref.targets[0],occurrencePath:['child']}]));
  assert.throws(()=>reviewedApi.parseSchematicTargets([ref.targets[0],ref.targets[0]]));
  assert.throws(()=>reviewedApi.parseSchematicTargets(Array(9).fill(ref.targets[0])));
  assert.throws(()=>reviewedApi.parseResolveSchematicReferenceRequest({contractVersion:request.contractVersion,projectId:otherProjectId,reference:ref}));
  const opened={...envelope,...request,documentRef:ref.documentRef,artifactRef:ref.artifactRef,sourceDigest:ref.sourceDigest,adaptedDigest:ref.adaptedDigest,freshness:'current'};
  assert.equal(reviewedApi.parseOpenReviewedResult({ok:true,value:opened},projectId).ok,true);
  assert.throws(()=>reviewedApi.parseOpenReviewedResult({ok:true,value:opened},otherProjectId));
  assert.throws(()=>reviewedApi.parseOpenReviewedResult({ok:true,value:{...opened,display:{...envelope.display,sourceDigest:'0'.repeat(64)}}}));
});

test('SCH reviewed security every selected network excerpt contains its complete explicit member set only',()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),source=sourceData().ir;
  for(const net of source.nets as Row[]){
    const ref=reference(envelope,[{kind:'net',occurrencePath:[],definitionId:envelope.display.definitionId,netId:net.id}]);
    const context=reviewedApi.buildSchematicContext(envelope,ref),actual=context.excerpt.nets[0]!;
    assert.equal(context.excerpt.nets.length,1);assert.deepEqual(context.excerpt.devices,[]);
    assert.equal(actual.id,net.id);assert.equal(actual.totalMembers,net.members.length);assert.equal(actual.shownMembers,actual.totalMembers);assert.equal(actual.truncated,false);
    assert.deepEqual(actual.members.map(m=>m.terminalId),(net.members as Row[]).map(m=>m.objectId));
    assert.equal(actual.wireCount,(source.wires as Row[]).filter(w=>w.netId===net.id).length);
    assert.ok(Buffer.byteLength(JSON.stringify(context))<=8192);
    assert.deepEqual(reviewedApi.parseSchematicContext(context),context);
    assert.throws(()=>reviewedApi.parseSchematicContext({...context,previewDigest:'0'.repeat(64)}));
    assert.equal(Object.hasOwn(context,'reviewedCircuitIr'),false);assert.equal(Object.hasOwn(context,'display'),false);
  }
});

test('SCH reviewed security device preview is selected data only and rejects nonexistent objects and excess contexts',()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),device=envelope.display.devices[0]!;
  const ref=reference(envelope,[{kind:'instance',occurrencePath:[],definitionId:envelope.display.definitionId,elementId:device.id}]);
  const context=reviewedApi.buildSchematicContext(envelope,ref);
  assert.deepEqual(context.excerpt.nets,[]);assert.equal(context.excerpt.devices.length,1);assert.deepEqual(context.excerpt.devices[0]!.parameters,device.parameters);
  assert.deepEqual(context.excerpt.devices[0]!.terminals.map(p=>p.id),device.pinIds);
  assert.throws(()=>reviewedApi.buildSchematicContext(envelope,{...ref,targets:[{...ref.targets[0]!,kind:'instance',elementId:'missing'}]}));
  assert.throws(()=>reviewedApi.parseSchematicContexts([context,context]));assert.throws(()=>reviewedApi.parseSchematicContexts([context,context,context]));
  assert.throws(()=>reviewedApi.parseSchematicContext({...context,excerpt:{...context.excerpt,unknown:'a'.repeat(8192)}}));
});

test('SCH reviewed security host rejects self-hashed forged excerpts and source/project withdrawal',()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),ref=reference(envelope,[{kind:'instance',occurrencePath:[],definitionId:envelope.display.definitionId,elementId:envelope.display.devices[0]!.id}]);
  const context=reviewedApi.buildSchematicContext(envelope,ref);let exists=true,available=true,loads=0;
  const host=createReviewedSchematicHost({hasProject:()=>exists,loadEnvelope:()=>{loads++;if(!available)throw Error('PRIVATE_SOURCE_DETAIL');return envelope;}});
  host.validateContextsForProject(projectId,[]);assert.equal(loads,0);host.validateContextsForProject(projectId,[context]);
  const forged=structuredClone(context) as unknown as Row;forged.excerpt.devices[0].name='forged';
  const {previewDigest:_,...content}=forged;forged.previewDigest=reviewedSha256(reviewedApi.schematicCanonical(content));
  const syntactic=reviewedApi.parseSchematicContext(forged);assert.throws(()=>host.validateContextsForProject(projectId,[syntactic]),'A checksum is not proof of authoritative excerpt');
  assert.throws(()=>host.validateContextsForProject(otherProjectId,[context]));
  available=false;assert.throws(()=>host.validateContextsForProject(projectId,[context]));available=true;exists=false;assert.throws(()=>host.validateContextsForProject(projectId,[context]));exists=true;
  host.revoke();assert.throws(()=>host.validateContextsForProject(projectId,[context]));
});

test('SCH reviewed security four method fence rejects caller changes and permanently revokes retained handlers',async()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames());
  const owner:AgentCallerContextV1={senderId:7,isTopFrame:true,appOrigin:'file://',navigationEpoch:1,appSessionId:'security.test',windowId:'security.window',webContentsId:7,workspaceId:'security.workspace',rootId:'security.root'};
  let caller:unknown=owner,loads=0,deriveThrows=false;
  const handlers=new Map<string,(event:unknown,value:unknown)=>Promise<reviewedApi.ReviewedSchematicResult<unknown>>>();
  const context={owner,deriveCallerContext:()=>{if(deriveThrows)throw Error('PRIVATE_CALLER_DETAIL');return caller;},ipcMain:{removeHandler:(channel:string)=>handlers.delete(channel),handle:(channel:string,handler:typeof handlers extends Map<string,infer V>?V:never)=>handlers.set(channel,handler)}};
  const extension=reviewedSchematicExtension({hasProject:id=>id===projectId,loadEnvelope:()=>{loads++;return envelope;}})(context as unknown as Parameters<ReturnType<typeof reviewedSchematicExtension>>[0]);
  assert.equal(handlers.size,4);const handler=handlers.get(reviewedApi.REVIEWED_SCHEMATIC_CHANNELS.openReviewed)!;
  const request={contractVersion:reviewedApi.REVIEWED_SCHEMATIC_VERSION,projectId,datasetId:reviewedApi.REVIEWED_SCHEMATIC_DATASET};
  const denied={ok:false,error:{code:'CAPABILITY_DENIED'}};
  for(const mutation of [{senderId:8},{isTopFrame:false},{appOrigin:'https://invalid.example'},{navigationEpoch:2},{appSessionId:'other'},{windowId:'other'},{webContentsId:8},{workspaceId:'other'},{rootId:'other'}]){caller={...owner,...mutation};assert.deepEqual(await handler({},request),denied);}
  assert.equal(loads,0);caller=owner;assert.equal((await handler({},request)).ok,true);
  const pending=handler({},request);caller={...owner,navigationEpoch:2};assert.deepEqual(await pending,denied);
  caller=owner;deriveThrows=true;assert.deepEqual(await handler({},request),denied);deriveThrows=false;
  caller=owner;extension.revoke();assert.deepEqual(await handler({},request),denied);extension.dispose();assert.equal(handlers.size,0);assert.deepEqual(await handler({},request),denied);
  // An exception while deriving trusted caller context must not leak private details as an IPC rejection.
  const host=createReviewedSchematicHost({hasProject:()=>true,loadEnvelope:()=>envelope});deriveThrows=true;
  assert.deepEqual(await host.invoke('openReviewed',request,()=>{throw Error('PRIVATE_CALLER_DETAIL');}),denied);
});

test('SCH reviewed security actual preload is four methods and rejects same-project mismatched preview targets',async()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),target=(index:number):reviewedApi.SchematicSelectionTarget=>({kind:'instance',occurrencePath:[],definitionId:envelope.display.definitionId,elementId:envelope.display.devices[index]!.id});
  const ref=reference(envelope,[target(0)]),wrong=reference(envelope,[target(1)]),wrongContext=reviewedApi.buildSchematicContext(envelope,wrong);
  let calls=0,api!:reviewedApi.WorkbenchReviewedSchematicApi,response:unknown={ok:true,value:wrongContext};
  const code=ts.transpileModule(readFileSync('apps/desktop/src/preload/reviewed-schematic.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(code,{exports:{},require:(name:string)=>{if(name==='electron')return {contextBridge:{exposeInMainWorld:(key:string,value:reviewedApi.WorkbenchReviewedSchematicApi)=>{assert.equal(key,'workbenchReviewedSchematic');api=value;}},ipcRenderer:{invoke:async()=>{calls++;return response;}}};if(name==='../shared/schematic/reviewed-schematic')return reviewedApi;throw Error('Unexpected preload import');}});
  assert.deepEqual(Object.keys(api).sort(),['list','openReviewed','previewSelection','resolveReference']);assert.equal(Object.isFrozen(api),true);
  const {kind:_,...fields}=ref,request={contractVersion:reviewedApi.REVIEWED_SCHEMATIC_VERSION,...fields};
  const malformed=await api.previewSelection({...request,path:'C:/secret'} as unknown as reviewedApi.PreviewSelectionRequest);assert.equal(malformed.ok,false);assert.equal(calls,0);
  const mismatch=await api.previewSelection(request);assert.equal(mismatch.ok,false,'A different selected device in the same project is not the requested preview');assert.equal(calls,1);
  response={ok:true,value:reviewedApi.buildSchematicContext(envelope,ref)};assert.equal((await api.previewSelection(request)).ok,true);
  const {targets:__,kind:___,...identity}=ref,document={...envelope,...identity,contractVersion:reviewedApi.REVIEWED_SCHEMATIC_VERSION,freshness:'current'};
  response={ok:true,value:{document,reference:wrong}};assert.equal((await api.resolveReference({contractVersion:reviewedApi.REVIEWED_SCHEMATIC_VERSION,projectId,reference:ref})).ok,false);
  response={ok:true,value:{document,reference:ref}};assert.equal((await api.resolveReference({contractVersion:reviewedApi.REVIEWED_SCHEMATIC_VERSION,projectId,reference:ref})).ok,true);
});

test('SCH reviewed security session and draft migration preserve exact snapshots and pending comparison',()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),ref=reference(envelope,[{kind:'instance',occurrencePath:[],definitionId:envelope.display.definitionId,elementId:envelope.display.devices[0]!.id}]),context=reviewedApi.buildSchematicContext(envelope,ref);
  const draft:ChatDraft={text:'',revision:2,images:[],files:[],schematics:[context]};
  const turn:SessionTurn={id:otherProjectId,user:messageTextDefault('',[],[context]),assistant:'answer',status:'completed',error:'',schematics:[context]};
  const session={id:projectId,title:'Security synthetic',provider:'deepseek',createdAt:'2026-09-09T00:00:00.000Z',updatedAt:'2026-09-09T00:00:00.000Z',turns:[turn]};
  const disk=parseSessionDisk({version:5,selectedId:projectId,sessions:[session]});assert.deepEqual(disk.sessions[0]!.turns[0]!.schematics,[context]);
  const parsed=parseDraftDisk({version:2,revision:1,records:[{sessionId:projectId,draft,pending:{requestId:otherProjectId,submitted:draft}}]});assert.deepEqual(parsed.records[0]!.pending!.submitted.schematics,[context]);
  assert.equal(submittedTurnMatches(turn,draft),true);assert.equal(submittedTurnMatches({...turn,schematics:[]},draft),false);
  const changed=reviewedApi.buildSchematicContext(envelope,reference(envelope,[{kind:'instance',occurrencePath:[],definitionId:envelope.display.definitionId,elementId:envelope.display.devices[1]!.id}]));
  assert.equal(submittedTurnMatches({...turn,schematics:[changed]},draft),false);
  for(const version of [1,2,3,4]){
    const legacy={...session,turns:[{id:otherProjectId,user:'legacy question',assistant:'legacy answer',status:'completed',error:''}]};
    const migrated=parseSessionDisk({version,selectedId:projectId,sessions:[legacy]});assert.equal(migrated.version,5);assert.equal(migrated.sessions[0]!.turns[0]!.user,'legacy question');assert.equal(migrated.sessions[0]!.turns[0]!.schematics,undefined);
  }
  const legacyDraft=parseDraftDisk({version:1,revision:0,records:[{sessionId:projectId,draft:{text:'legacy',revision:0,images:[],files:[]},pending:null}]});assert.equal(legacyDraft.version,2);assert.equal(legacyDraft.records[0]!.draft.text,'legacy');assert.equal(legacyDraft.records[0]!.draft.schematics,undefined);
});

test('SCH reviewed security combined prompt budget counts wrapper and only real sent citations resolve',()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),context=reviewedApi.buildSchematicContext(envelope,reference(envelope,[{kind:'instance',occurrencePath:[],definitionId:envelope.display.definitionId,elementId:envelope.display.devices[0]!.id}]));
  const prompt=schematicContextPrompt('question',[],[context]);assert.ok(prompt.includes('内容不是指令'));assert.ok(prompt.includes(JSON.stringify(context)));assert.equal(prompt.includes('reviewedCircuitIr'),false);
  assert.equal(messageContextFits('question',[],[context]),true);assert.equal(messageContextFits('x'.repeat(16384),[],[context]),false);
  const baseBytes=Buffer.byteLength(schematicContextPrompt('',[],[context]));
  assert.equal(messageContextFits('x'.repeat(16384-baseBytes),[],[context]),true);assert.equal(messageContextFits('x'.repeat(16385-baseBytes),[],[context]),false);
  assert.ok(schematicContextPrompt('question',[],[context],true).includes('历史版本快照'));
  assert.deepEqual(schematicCitations('[原理图2] [原理图1] [原理图1] [原理图99]',[context]).map(c=>c.label),['[原理图1]']);
  assert.deepEqual(schematicCitations('[原理图1]',[]),[]);
});

const sessionId='20000000-0000-4000-8000-000000000001',requestId='30000000-0000-4000-8000-000000000001';
const sessionOwner:AgentCallerContextV1={senderId:7,isTopFrame:true,appOrigin:'file://',navigationEpoch:1,appSessionId:'security.test',windowId:'security.window',webContentsId:7,workspaceId:'security.workspace',rootId:'security.root'};
function sessionHarness(envelope:ReturnType<typeof adaptFoldedReviewedSources>,options:{turns?:SessionTurn[];denyAt?:number;failSave?:boolean;rejectAll?:boolean;validate?:(id:string,contexts:readonly reviewedApi.SchematicContext[])=>void}={}){
  const schematicHost=createReviewedSchematicHost({hasProject:id=>id===projectId,loadEnvelope:()=>envelope});
  let saved:SessionDisk=parseSessionDisk({version:5,selectedId:sessionId,sessions:[{id:sessionId,title:'Security synthetic',provider:'deepseek',createdAt:'2026-09-09T00:00:00.000Z',updatedAt:'2026-09-09T00:00:00.000Z',turns:options.turns??[]}]}),writes=0,checks=0;
  const wire:MultimodalRequest[]=[];
  const host=createSessionHost({owner:sessionOwner,store:{load:()=>structuredClone(saved),save:value=>{writes++;if(options.failSave)throw Error('PRIVATE_STORE_DETAIL');saved=structuredClone(value);}},configured:{deepseek:true,kimi:false},execute:async()=>{throw Error('Legacy transport must not send schematic data');},executeMultimodal:async(request,callbacks)=>{wire.push(structuredClone(request));callbacks.onText('synthetic answer');return {text:'synthetic answer'};},validateSchematicContexts:(id,contexts)=>{assert.equal(id,sessionId);checks++;if(options.rejectAll||checks===options.denyAt)throw Error('PRIVATE_PROJECT_DETAIL');if(options.validate)options.validate(id,contexts);else schematicHost.validateContextsForProject(projectId,contexts);}});
  return {host,wire,writes:()=>writes,checks:()=>checks,saved:()=>saved,send:(contexts:reviewedApi.SchematicContext[]=[],extra:Record<string,unknown>={})=>host.invoke(sessionOwner,'sendMessage',{contractVersion:SESSION_VERSION,sessionId,requestId,text:'question',schematics:contexts,...extra})};
}
const settleSession=()=>new Promise<void>(resolve=>setImmediate(resolve));
function firstContext(envelope:ReturnType<typeof adaptFoldedReviewedSources>){return reviewedApi.buildSchematicContext(envelope,reference(envelope,[{kind:'instance',occurrencePath:[],definitionId:envelope.display.definitionId,elementId:envelope.display.devices[0]!.id}]));}

test('SCH reviewed security manual session send persists selected excerpt and includes it exactly once without an automatic call',async()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),context=firstContext(envelope),h=sessionHarness(envelope);
  try{
    assert.equal(h.wire.length,0);assert.equal(h.writes(),0);
    const result=h.send([context]);assert.equal(result.ok,true);assert.equal(h.wire.length,0);
    await settleSession();assert.equal(h.wire.length,1);assert.ok(h.checks()>=3);
    const content=h.wire[0]!.messages.at(-1)!.content;assert.equal(typeof content,'string');assert.ok((content as string).includes(JSON.stringify(context)));assert.equal((content as string).includes('reviewedCircuitIr'),false);
    assert.deepEqual(h.saved().sessions[0]!.turns[0]!.schematics,[context]);assert.equal(h.saved().sessions[0]!.turns[0]!.status,'completed');
    assert.equal(h.send([context]).ok,true);await settleSession();assert.equal(h.wire.length,1,'An identical request id must not execute twice');
    assert.equal(h.send([]).ok,false,'Different excerpt content cannot reuse a committed request id');
  }finally{h.host.revoke();}
});

test('SCH reviewed security project/source changes before commit or queued execution and save failure prevent transport',async()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),context=firstContext(envelope);
  for(const scenario of [{denyAt:1},{denyAt:2},{denyAt:3},{failSave:true}]){
    const h=sessionHarness(envelope,scenario);
    try{
      const result=h.send([context]);await settleSession();assert.equal(h.wire.length,0);
      if(scenario.denyAt===3){assert.equal(result.ok,true);const turn=h.saved().sessions[0]!.turns[0]!;assert.equal(turn.status,'failed');assert.ok(turn.error.includes('未发送'));assert.deepEqual(turn.schematics,[context]);}
      else {assert.equal(result.ok,false);assert.equal(h.saved().sessions[0]!.turns.length,0);if(!scenario.failSave)assert.equal(h.writes(),0);}
    }finally{h.host.revoke();}
  }
});

test('SCH reviewed security history filtering cannot resurrect an unvalidated older project reference',async()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),context=firstContext(envelope),other=reviewedApi.buildSchematicContext(envelope,{...context.reference,projectId:otherProjectId});
  const turns:SessionTurn[]=Array.from({length:9},(_,index)=>({id:'40000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),user:index===8?'x'.repeat(16300):'historical question',assistant:'historical answer '+index,status:'completed',error:'',...(index===0?{schematics:[other]}:index===8?{schematics:[context]}:{})}));
  assert.ok(Buffer.byteLength(schematicContextPrompt(turns[8]!.user,[],[context],true))>16384);
  const h=sessionHarness(envelope,{turns});try{const result=h.send();await settleSession();assert.deepEqual(result,{ok:false,error:{code:'SCHEMATIC_UNAVAILABLE'}});assert.equal(h.wire.length,0);assert.equal(h.writes(),0);}finally{h.host.revoke();}
  const positive=sessionHarness(envelope,{turns:turns.map((turn,index)=>index===0?{...turn,schematics:[context]}:turn)});
  try{assert.equal(positive.send().ok,true);await settleSession();assert.equal(positive.wire.length,1);assert.ok(JSON.stringify(positive.wire[0]).includes('historical answer 0'),'The older pair really can reenter the wire candidate set');}finally{positive.host.revoke();}
});

test('SCH reviewed security continuation preserves and revalidates the original schematic snapshot',async()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),context=firstContext(envelope);
  const root:SessionTurn={id:'40000000-0000-4000-8000-000000000001',user:'original question',assistant:'partial answer',status:'failed',error:'interrupted',schematics:[context]};
  for(const rejected of [false,true]){
    const h=sessionHarness(envelope,{turns:[root],rejectAll:rejected});
    try{
      const result=h.send([],{text:CONTINUE_TEXT,continueFrom:root.id});await settleSession();assert.equal(result.ok,!rejected);
      if(rejected){assert.equal(h.wire.length,0);assert.equal(h.writes(),0);}else{assert.equal(h.wire.length,1);const text=JSON.stringify(h.wire[0]!.messages);assert.ok(text.includes('partial answer'));assert.ok(text.includes(context.previewDigest));assert.ok(text.includes('历史版本快照'));}
    }finally{h.host.revoke();}
  }
});

test('SCH reviewed security actual workspace session reassignment prevents queued schematic transmission',async()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),context=firstContext(envelope);
  const empty=emptyWorkspace();let saved=parseWorkspaceDisk({...empty,projects:[...empty.projects,{...newProject(projectId,'A'),sessionIds:[sessionId],selectedId:sessionId},newProject(otherProjectId,'B')]});
  const workspace=createWorkspaceHost({load:()=>structuredClone(saved),save:value=>{saved=structuredClone(value);}});
  const schematicHost=createReviewedSchematicHost({hasProject:workspace.hasProject,loadEnvelope:()=>envelope});
  const h=sessionHarness(envelope,{validate:(id,contexts)=>{const authoritative=workspace.projectForSession(id);assert.ok(authoritative);schematicHost.validateContextsForProject(authoritative,contexts);}});
  try{
    assert.equal(workspace.projectForSession(sessionId),projectId);assert.equal(h.send([context]).ok,true);
    const moved={...saved,projects:saved.projects.map(project=>project.id===projectId?{...project,sessionIds:[],selectedId:null}:project.id===otherProjectId?{...project,sessionIds:[sessionId],selectedId:sessionId}:project)};
    assert.equal(workspace.invoke('save',{contractVersion:WORKSPACE_VERSION,expectedRevision:saved.revision,state:moved},true).ok,true);
    assert.equal(workspace.projectForSession(sessionId),otherProjectId);await settleSession();assert.equal(h.wire.length,0);assert.equal(h.saved().sessions[0]!.turns[0]!.status,'failed');
    assert.ok(h.saved().sessions[0]!.turns[0]!.error.includes('未发送'));
  }finally{h.host.revoke();workspace.revoke();schematicHost.revoke();}
});

test('SCH reviewed security Markdown export contains bounded sent snapshot without resolving source files',()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),context=firstContext(envelope);
  const text=exportMarkdown({id:sessionId,title:'Synthetic export',provider:'deepseek',createdAt:'2026-09-09T00:00:00.000Z',updatedAt:'2026-09-09T00:00:00.000Z',turns:[{id:requestId,user:'question',assistant:'answer [原理图1]',status:'completed',error:'',schematics:[context]}]});
  assert.ok(text.includes('原理图引用：'));assert.ok(text.includes(JSON.stringify(context,null,2)));assert.ok(text.includes(context.reference.artifactRef.revisionId));
  assert.equal(text.includes('reviewedCircuitIr'),false);assert.equal(text.includes('analog_ai_lab'),false);assert.equal(text.includes('C:\\work'),false);
});

test('SCH reviewed security recovered draft survives editing, rejected send and failed persistence without sending',async()=>{
  const envelope=adaptFoldedReviewedSources(sourceFrames()),context=firstContext(envelope);
  for(const outcome of ['rejected','store-failure','accepted-with-new-input'] as const){
    let revision=0,saves=0;
    const controller=createDraftController({read:async()=>({ok:true,value:{version:2,revision:0,records:[]}}),save:async()=>{saves++;return outcome==='store-failure'?{ok:false,error:{code:'STORAGE_ERROR'}}:{ok:true,revision:++revision};}});
    try{
      await controller.start();const restored=planSchematicAttachment({text:'new question',revision:4,images:[],files:[]},context,projectId);assert.ok(restored.ok);
      const edited=updateDraftText(restored.draft,'edited after recovery');assert.deepEqual(edited.schematics,[context]);assert.equal(restored.draft.text,'new question');
      controller.change(current=>({...current,[sessionId]:edited}));
      const began=await controller.beginSend(sessionId,requestId,edited);assert.equal(began,outcome!=='store-failure');
      if(outcome==='rejected')await controller.finishSend(sessionId,false,true);
      if(outcome==='accepted-with-new-input'){
        const later=reviewedApi.buildSchematicContext(envelope,reference(envelope,[{kind:'instance',occurrencePath:[],definitionId:envelope.display.definitionId,elementId:envelope.display.devices[1]!.id}]));
        controller.change(current=>({...current,[sessionId]:{...updateDraftText(current[sessionId],'later question'),schematics:[context,later]}}));
        await controller.finishSend(sessionId,true,true);assert.deepEqual(controller.snapshot().records[sessionId]!.draft.schematics,[later]);assert.equal(controller.snapshot().records[sessionId]!.draft.text,'later question');
      }else{assert.deepEqual(controller.snapshot().records[sessionId]!.draft.schematics,[context]);assert.equal(controller.snapshot().records[sessionId]!.draft.text,'edited after recovery');}
      assert.ok(saves>0);if(outcome==='store-failure')assert.equal(controller.snapshot().status,'error');
    }finally{controller.dispose();}
  }
});

test('SCH display delta security measured text bounds affect only the validated viewport',()=>{
  const envelope=validateReviewedSchematicEnvelope(adaptFoldedReviewedSources(sourceFrames()));
  const before=JSON.stringify(envelope),state=createInitialViewerViewStateV1(envelope.reviewedCircuitIr,{width:900,height:600},envelope.display.artifactRef);
  const extra={minX:envelope.reviewedCircuitIr.bounds.minX-100,minY:envelope.reviewedCircuitIr.bounds.minY-20,maxX:envelope.reviewedCircuitIr.bounds.maxX+180,maxY:envelope.reviewedCircuitIr.bounds.maxY+20};
  const viewport=fitSchematicVisibleBounds(envelope.reviewedCircuitIr.bounds,[extra],{width:900,height:600});assert.ok(viewport);
  const next=applySchematicViewerAction({artifactRef:envelope.display.artifactRef,reviewedCircuitIr:envelope.reviewedCircuitIr},state,{type:'fit',viewport});
  assert.deepEqual(next.viewport,viewport);assert.deepEqual(next.selection,state.selection);assert.deepEqual(next.netHighlight,state.netHighlight);assert.deepEqual(next.artifactBinding,state.artifactBinding);
  for(const p of [{x:extra.minX,y:extra.minY},{x:extra.maxX,y:extra.maxY}]){const x=p.x*viewport.zoom+viewport.translateXCss,y=p.y*viewport.zoom+viewport.translateYCss;assert.ok(x>=24-1e-6&&x<=876+1e-6);assert.ok(y>=24-1e-6&&y<=576+1e-6);}
  const rejected=applySchematicViewerAction({artifactRef:envelope.display.artifactRef,reviewedCircuitIr:envelope.reviewedCircuitIr},state,{type:'fit',viewport:{...viewport,zoom:Infinity}});assert.equal(rejected,state);
  assert.equal(JSON.stringify(envelope),before);assert.equal(fitSchematicVisibleBounds(extra,[{...extra,maxX:NaN}],{width:900,height:600}),null);
  assert.equal(fitSchematicVisibleBounds(extra,[],{width:0,height:600}),null);
});

test('SCH display delta security text measurement is confined to the supplied SVG and inverts its viewport',()=>{
  let queries=0;const viewport={zoom:2,translateXCss:10,translateYCss:20,widthCss:900,heightCss:600};
  const canvas={getBoundingClientRect:()=>({left:100,top:200}),querySelectorAll:(selector:string)=>{queries++;assert.equal(selector,'text');return [{getBoundingClientRect:()=>({left:114,right:134,top:226,bottom:246})}];}} as unknown as SVGSVGElement;
  assert.deepEqual(measureSchematicTextBounds(canvas,viewport),[{minX:2,maxX:12,minY:3,maxY:13}]);assert.equal(queries,1);
});

test('SCH display delta security layout changes only generated MOS text y positions with fixed bounds',()=>{
  const envelope=validateReviewedSchematicEnvelope(adaptFoldedReviewedSources(sourceFrames())),before=JSON.stringify(envelope),display=envelope.display;
  const result=layoutReviewedDisplayText(display);assert.equal(result.length,530);assert.deepEqual(result,layoutReviewedDisplayText(display));
  const mosIds=new Set(display.devices.filter(d=>d.renderEvidence==='builtin_normalized_display_only').map(d=>d.id));let generated=0,changed=0;
  for(const [index,original] of display.primitives.entries()){
    const next=result[index]!;
    if(original.tag!=='text'||original.sourceKind!=='instance'||!mosIds.has(original.sourceId)){assert.deepEqual(next,original);continue;}
    generated++;assert.equal(next.tag,'text');if(next.tag!=='text')throw Error('Changed primitive type');
    const {position:sourcePosition,...sourceFields}=original,{position:targetPosition,...targetFields}=next;
    assert.deepEqual(targetFields,sourceFields);assert.equal(targetPosition.x,sourcePosition.x);assert.ok(Number.isFinite(targetPosition.y));if(targetPosition.y!==sourcePosition.y)changed++;
  }
  assert.equal(generated,54);assert.ok(changed>0);
  for(const id of mosIds){
    const original=display.primitives.filter(p=>p.tag==='text'&&p.sourceId===id),next=result.filter(p=>p.tag==='text'&&p.sourceId===id);assert.equal(original.length,2);assert.equal(next.length,2);
    const first=original[0]!,a=next[0]!,b=next[1]!;assert.ok(first.tag==='text'&&a.tag==='text'&&b.tag==='text');
    assert.ok(Math.abs((b.position.y-a.position.y)-14)<1e-9);assert.ok(Math.abs(a.position.y-first.position.y)<=42+1e-9);
  }
  assert.equal(JSON.stringify(envelope),before);assert.equal(display.adaptedDigest,'098a4eec59b22dee954816a4b49440eee18d8370b5d54413a428d7d146c67b30');
});

test('SCH display delta security scene layout is independent of viewport and preserves source hit identities',()=>{
  const envelope=validateReviewedSchematicEnvelope(adaptFoldedReviewedSources(sourceFrames())),state=createInitialViewerViewStateV1(envelope.reviewedCircuitIr,{width:1000,height:700},envelope.display.artifactRef),before=JSON.stringify(envelope),contextBefore=firstContext(envelope);
  const scene=(zoom:number)=>buildReviewedSvgSceneV1({envelope,artifactRef:envelope.display.artifactRef,viewState:{...state,viewport:{...state.viewport,zoom,translateXCss:zoom*9,translateYCss:zoom*-5}},renderState:{status:'ready',freshness:'current'}});
  const baseline=scene(.1);
  for(const zoom of [.65,2,32]){const next=scene(zoom);assert.deepEqual(next.primitives,baseline.primitives);assert.deepEqual(next.hitTargets.map(hit=>hit.target),baseline.hitTargets.map(hit=>hit.target));}
  const selected=buildReviewedSvgSceneV1({envelope,artifactRef:envelope.display.artifactRef,viewState:{...state,selection:[{artifactId:envelope.display.artifactRef.artifactId,revisionId:envelope.display.artifactRef.revisionId,occurrencePath:[],definitionId:envelope.display.definitionId,elementKind:'instance',elementId:envelope.display.devices[0]!.id}]},renderState:{status:'ready',freshness:'current'}});
  for(const overlay of selected.primitives.filter(p=>p.layer==='selection')){const base=selected.primitives.find(p=>p.key===overlay.key.replace(/:selected$/,''))!;assert.ok(base);assert.deepEqual(overlay.attributes,base.attributes);assert.equal(overlay.text,base.text);assert.deepEqual(overlay.target,base.target);}
  assert.equal(baseline.primitives.length,530);assert.equal(baseline.hitTargets.length,238);assert.equal(baseline.hitTargets.some(hit=>['pin','port'].includes(hit.target.elementKind)),false);
  assert.deepEqual(firstContext(envelope),contextBefore);assert.equal(JSON.stringify(envelope),before);
});
