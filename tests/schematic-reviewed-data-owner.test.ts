import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {createReviewedSchematicHost} from '../apps/desktop/src/main/schematic/reviewed-schematic-host';
import {SESSION_VERSION,parseSessionDisk,type SessionDisk,type SessionRequests} from '../apps/desktop/src/shared/agent/chat-sessions';
import {CONTINUE_TEXT} from '../apps/desktop/src/shared/agent/continuation';
import {exportMarkdown} from '../apps/desktop/src/main/cloud/chat-export';
import {parseDraftDisk,submittedTurnMatches,emptyDraft} from '../apps/desktop/src/shared/agent/chat-drafts';
import {messageTextDefault,messageContextFits} from '../apps/desktop/src/shared/schematic/schematic-context';
import type {MultimodalRequest} from '../apps/desktop/src/main/cloud/multimodal-context';
import {adaptFoldedReviewedSources,foldedLocalToDisplay,FOLDED_ORIENTATION_MATRICES} from '../packages/schematic-workbench/src/folded-adapter';
import {FOLDED_SOURCE_FILES,type FoldedSourceFiles} from '../packages/schematic-workbench/src/folded-source-profile';
import {validateReviewedSchematicEnvelope} from '../packages/schematic-workbench/src/reviewed-display-validation';
import {buildSchematicContext,parseSchematicContext,parseOpenReviewedResult,REVIEWED_DOCUMENT_REF,REVIEWED_ARTIFACT_REF,REVIEWED_SCHEMATIC_DATASET,type SchematicReference} from '../apps/desktop/src/shared/schematic/reviewed-schematic';
const files=Object.fromEntries(Object.keys(FOLDED_SOURCE_FILES).map(name=>[name,fs.readFileSync(path.resolve('.local/reviewed-schematic/folded-v1',name),'utf8')])) as FoldedSourceFiles;
const envelope=adaptFoldedReviewedSources(files),projectId='00000000-0000-4000-8000-000000000001';
const ref=(targets:SchematicReference['targets']):SchematicReference=>({kind:'schematic_reference',projectId,datasetId:REVIEWED_SCHEMATIC_DATASET,documentRef:REVIEWED_DOCUMENT_REF,artifactRef:REVIEWED_ARTIFACT_REF,sourceDigest:envelope.display.sourceDigest,adaptedDigest:envelope.display.adaptedDigest,targets});
const selection=()=>buildSchematicContext(envelope,ref([{kind:'instance',definitionId:envelope.display.definitionId,occurrencePath:[],elementId:envelope.display.devices[0]!.id}]));
const caller={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'schematic-owner-test',windowId:'w',webContentsId:1,workspaceId:'ws',rootId:'r'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function sessions(){
 let disk:SessionDisk={version:5,selectedId:null,sessions:[]},writes=0,project=projectId,validations=0,mutateBeforeCommit=false,failFirst=false;
 const transmitted:MultimodalRequest[]=[],reviewed=createReviewedSchematicHost({hasProject:id=>id===projectId,loadEnvelope:()=>envelope});
 const host=createSessionHost({owner:caller,store:{load:()=>structuredClone(disk),save:value=>{writes++;disk=structuredClone(value);}},configured:{deepseek:true,kimi:true},execute:async()=>{throw Error('Legacy transport must not be used');},executeMultimodal:async(request,options)=>{transmitted.push(request);options.onText('synthetic reply');if(failFirst&&transmitted.length===1)throw Error('synthetic interruption');return {text:'synthetic reply'};},validateSchematicContexts:(_sessionId,contexts)=>{validations++;if(mutateBeforeCommit&&validations===2)project=randomUUID();reviewed.validateContextsForProject(project,contexts);}});
 const created=host.invoke(caller,'createSession',{contractVersion:SESSION_VERSION,provider:'deepseek',title:'test'});assert(created.ok&&created.value.selectedId);const sessionId=created.value.selectedId;writes=0;
 const send=(args:Partial<SessionRequests['sendMessage']>={})=>host.invoke(caller,'sendMessage',{contractVersion:SESSION_VERSION,sessionId,requestId:randomUUID(),text:'',schematics:[selection()],...args});
 return {host,reviewed,send,sessionId,transmitted,disk:()=>disk,writes:()=>writes,move:()=>{project=randomUUID();},invalidateAtCommit:()=>{mutateBeforeCommit=true;},interruptFirst:()=>{failFirst=true;}};
}
test('pinned whole topology/display admits and preserves source unknowns and primitive coverage',()=>{
 const e=validateReviewedSchematicEnvelope(envelope);assert.equal(e.display.primitives.length,530);assert.equal(e.display.devices.filter(d=>d.bulkBinding!==undefined).length,27);assert.equal(e.display.primitives.filter(p=>p.sourceKind==='graphic').length,48);
 const definition=e.reviewedCircuitIr.definitions[0]!;assert.equal(definition.pins?.length,108);assert(definition.pins!.every(p=>p.x===undefined&&p.y===undefined));assert(definition.ports.every(p=>p.x===undefined&&p.y===undefined));
 assert.equal(e.display.devices[0]!.parameters.find(p=>p.name==='w')!.valueText,'"10u"');assert(Object.isFrozen(e.display));
});
test('rotation/mirror matrices use source-local transform then explicit y inversion',()=>{
 const expected={R0:[120,-230],R90:[70,-220],R180:[80,-170],R270:[130,-180],MX:[120,-170],MY:[80,-230],MXR90:[130,-220],MYR90:[70,-180]};
 for(const orientation of Object.keys(FOLDED_ORIENTATION_MATRICES) as (keyof typeof expected)[]){const p=foldedLocalToDisplay({origin:{x:1,y:2},orientation,boundingBox:{lowerLeft:{x:0,y:0},upperRight:{x:2,y:3}}},{x:.2,y:.3});assert(Math.abs(p.x-expected[orientation][0]!)<1e-10);assert(Math.abs(p.y-expected[orientation][1]!)<1e-10);}
});
test('geometry, metadata, identity and unknown fields cannot be altered under the fixed revision',()=>{
 for(const mutate of [(e:any)=>e.display.devices[0].parameters[0].valueText='forged',(e:any)=>e.display.primitives[0].points[0].x+=1,(e:any)=>e.display.extra='x',(e:any)=>e.reviewedCircuitIr.definitions[0].pins[0].x=0]){const copy=structuredClone(envelope);mutate(copy);assert.throws(()=>validateReviewedSchematicEnvelope(copy));}
});
test('maximum-member net yields complete compact explicit preview within 8KiB',()=>{
 const net=[...envelope.display.nets].sort((a,b)=>b.memberIds.length-a.memberIds.length)[0]!;
 const context=buildSchematicContext(envelope,ref([{kind:'net',definitionId:envelope.display.definitionId,occurrencePath:[],netId:net.id}]));
 assert.equal(context.excerpt.nets[0]!.totalMembers,30);assert.equal(context.excerpt.nets[0]!.shownMembers,30);assert.equal(context.excerpt.devices.length,0);assert(Buffer.byteLength(JSON.stringify(context))<=8192);assert.deepEqual(parseSchematicContext(context),context);
});
test('preview tampering and duplicate target are rejected; no layout enters selected-device excerpt',()=>{
 const target={kind:'instance' as const,definitionId:envelope.display.definitionId,occurrencePath:[] as [],elementId:envelope.display.devices[0]!.id};
 const context=buildSchematicContext(envelope,ref([target]));assert(!Object.hasOwn(context.excerpt.devices[0]!,'placement'));
 const copy=structuredClone(context) as any;copy.excerpt.devices[0].name='changed';assert.throws(()=>parseSchematicContext(copy));assert.throws(()=>buildSchematicContext(envelope,ref([target,target])));
});
test('response graph rejects sparse arrays/getters before clone or access',()=>{
 const sparse:any[]=[];sparse.length=100000000;assert.throws(()=>parseOpenReviewedResult({ok:true,value:sparse}));let reads=0;const getter={get ok(){reads++;return true;}};assert.throws(()=>parseOpenReviewedResult(getter));assert.equal(reads,0);
});
test('manual send saves exact bounded context, dispatches once and keys idempotency on the full selection',async()=>{
 const s=sessions(),id=randomUUID();try{assert(s.send({requestId:id}).ok);await tick();assert.equal(s.transmitted.length,1);const saved=s.disk().sessions[0]!.turns[0]!;assert.deepEqual(saved.schematics,[selection()]);assert.equal(saved.user,messageTextDefault('',[],[selection()]));const prompt=JSON.stringify(s.transmitted[0]);assert(prompt.includes('schematic_reference'));assert(!prompt.includes('reviewedCircuitIr'));assert(!prompt.includes('boundingBox'));assert(s.send({requestId:id}).ok);assert.equal(s.transmitted.length,1);assert.equal(s.send({requestId:id,text:'different'}).ok,false);}finally{s.host.revoke();}
});
test('project mismatch and commit-time reference invalidation reject before a turn is stored',()=>{
 for(const mode of ['before','commit']){const s=sessions();try{if(mode==='before')s.move();else s.invalidateAtCommit();assert.deepEqual(s.send(),{ok:false,error:{code:'SCHEMATIC_UNAVAILABLE'}});assert.equal(s.writes(),0);assert.equal(s.transmitted.length,0);}finally{s.host.revoke();}}
});
test('queued project move or source revoke blocks transport and preserves a failed local turn',async()=>{
 for(const mode of ['move','revoke']){const s=sessions();try{assert(s.send().ok);if(mode==='move')s.move();else s.reviewed.revoke();await tick();assert.equal(s.transmitted.length,0);const turn=s.disk().sessions[0]!.turns[0]!;assert.equal(turn.status,'failed');assert.match(turn.error,/本次请求未发送/u);assert.deepEqual(turn.schematics,[selection()]);}finally{s.host.revoke();}}
});
test('historical snapshot is explicitly marked and is revalidated before later ordinary text',async()=>{
 const s=sessions();try{assert(s.send().ok);await tick();assert(s.send({text:'follow up',schematics:[]}).ok);await tick();assert(JSON.stringify(s.transmitted[1]).includes('historical\\\":true'));s.reviewed.revoke();const before=s.writes();assert.deepEqual(s.send({text:'after withdrawal',schematics:[]}),{ok:false,error:{code:'SCHEMATIC_UNAVAILABLE'}});assert.equal(s.writes(),before);assert.equal(s.transmitted.length,2);}finally{s.host.revoke();}
});
test('manual continuation carries the original reviewed snapshot and revalidates it',async()=>{
 const s=sessions();try{s.interruptFirst();assert(s.send().ok);await tick();const root=s.disk().sessions[0]!.turns[0]!;assert.equal(root.status,'failed');assert(s.send({text:CONTINUE_TEXT,schematics:[],continueFrom:root.id}).ok);await tick();assert.equal(s.transmitted.length,2);assert(JSON.stringify(s.transmitted[1]).includes(root.schematics![0]!.previewDigest));}finally{s.host.revoke();}
});
test('v1 draft migrates, v2 pending matches complete schematic snapshot, and Markdown exports original reference',async()=>{
 assert.equal(parseDraftDisk({version:1,revision:0,records:[]}).version,2);const s=sessions();try{assert(s.send().ok);await tick();const turn=s.disk().sessions[0]!.turns[0]!,draft={...emptyDraft(),schematics:[selection()]};assert(submittedTurnMatches(turn,draft));assert(!submittedTurnMatches(turn,{...draft,schematics:[]}));const session=parseSessionDisk(s.disk()).sessions[0]!;assert.equal(parseSessionDisk(s.disk()).version,5);assert(exportMarkdown(session).includes('原理图引用：'));assert(exportMarkdown(session).includes(selection().previewDigest));assert(!messageContextFits('x'.repeat(16000),[],[selection()]));}finally{s.host.revoke();}
});
