import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {createUnifiedChatCoordinator} from '../apps/desktop/src/main/cloud/unified-chat-coordinator';
import {buildUnifiedChatContext,UnifiedChatContextError,type UnifiedChatContextInput} from '../apps/desktop/src/main/cloud/unified-chat-context';
import type {MultimodalExecutor,MultimodalMessage} from '../apps/desktop/src/main/cloud/multimodal-context';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import type {ProjectReadHost} from '../apps/desktop/src/main/agent-project-read/host';
import type {ProjectReadEngine,ProjectReadEngineInput} from '../apps/desktop/src/main/agent-project-read/engine';
import {SESSION_VERSION,parseSessionDisk,type SessionDisk,type SessionMethod} from '../apps/desktop/src/shared/agent/chat-sessions';
import {CONTINUE_TEXT} from '../apps/desktop/src/shared/agent/continuation';
import {emptyWorkspace} from '../apps/desktop/src/shared/agent/project-workspace';
import {DEFAULT_REPLY_LIMITS} from '../apps/desktop/src/shared/agent/reply-limits';
import {IMAGE_BYTES,type ImageAttachment} from '../apps/desktop/src/shared/agent/image-attachment';
import {SCHEMATIC_CONTEXT_VERSION,REVIEWED_SCHEMATIC_DATASET,REVIEWED_DOCUMENT_REF,REVIEWED_ARTIFACT_REF,schematicCanonical,type SchematicContext} from '../apps/desktop/src/shared/schematic/reviewed-schematic';
import {FOLDED_ADAPTED_DIGEST,FOLDED_REVIEWED_SOURCE_DIGEST} from '../packages/schematic-workbench/src/reviewed-display-validation';
import {CloudChatErrorV1} from '../packages/agent-adapters/src/cloud-chat-contract';

// Real host/coordinator admission with synthetic execution seams and an in-memory
// store. No provider, credentials, native process, filesystem, WSL or EDA access.
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'native-admission',windowId:'window',webContentsId:1,workspaceId:'workspace',rootId:'root'};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(done:()=>boolean){for(let i=0;i<100;i++){if(done())return;await tick();}assert.fail('synthetic admission did not settle');}
const forbidden=():never=>{throw Error('unexpected synthetic project IO');};
function fixture(options:{initial?:SessionDisk;plain?:MultimodalExecutor;validateSchematicContexts?:(sessionId:string,contexts:readonly SchematicContext[])=>void}={}){
  let disk=parseSessionDisk(options.initial??{version:6,selectedId:null,sessions:[]}),host:ReturnType<typeof createSessionHost>;
  const starts:ProjectReadEngineInput[]=[];
  const engine:ProjectReadEngine={dispose(){},shutdown:async()=>{},health:async()=>true,
    status:()=>({model:{provider:'kimi',model:'kimi-k3'},canStart:true,processState:'ready',reason:null}),
    accept:(_id,model)=>model,acceptChat:(_id,model)=>model,canDeliver:()=>true,
    accounting:()=>({providerAttempts:1,httpDispatches:0,contextBytes:0}),
    start:async input=>{starts.push(input);input.callbacks.notice({type:'started',sessionId:'native-persistent-fixture'});input.callbacks.notice({type:'text',messageId:'reply-'+starts.length,step:1,text:'native answer '+starts.length});input.callbacks.notice({type:'completed'});},
    answer:async()=>forbidden(),stop:async()=>{},
  };
  const project={captureChat:(projectId:string)=>({projectId,scope:null,wsl:Promise.resolve(null),commandEnvironmentVersion:'a'.repeat(64)}),
    createChatEngine:()=>engine,attachChat:forbidden,finishChat:forbidden,answerChat:forbidden,chatRun:()=>null,chatRuns:()=>[]} as unknown as ProjectReadHost;
  const arbiter=createAgentRuntimeArbiter();
  const service=createUnifiedChatCoordinator({project,arbiter,workspace:emptyWorkspace,getSession:id=>host.getSession(id),plain:options.plain??forbidden});
  host=createSessionHost({owner,store:{load:()=>structuredClone(disk),save:next=>{disk=parseSessionDisk(structuredClone(next));}},configured:{kimi:true,deepseek:true},
    execute:forbidden,executeMultimodal:forbidden,turns:service,...(options.validateSchematicContexts?{validateSchematicContexts:options.validateSchematicContexts}:{})});
  const invoke=<M extends SessionMethod>(method:M,args:object={})=>host.invoke(owner,method,{contractVersion:SESSION_VERSION,...args});
  const state=()=>{const result=invoke('readState');assert(result.ok);return result.value;};
  if(!disk.selectedId)assert(invoke('createSession',{provider:'kimi',title:'synthetic native admission'}).ok);
  const sessionId=state().selectedId!;
  return {host,invoke,state,sessionId,starts,durable:()=>structuredClone(disk),
    send(text:string,extra:object={}){const requestId=randomUUID();assert(invoke('sendMessage',{sessionId,requestId,text,...extra}).ok);return requestId;},
    async close(){host.revoke();await tick();await arbiter.close();}};
}

const contextInput=(change:Partial<UnifiedChatContextInput>={}):UnifiedChatContextInput=>({provider:'kimi',model:'kimi-k3',text:'current question',images:[],files:[],schematics:[],history:[],replyLimits:{...DEFAULT_REPLY_LIMITS},...change});
function image(bytes=17):ImageAttachment{
  const jpeg=Buffer.alloc(bytes,bytes%251);Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0]).copy(jpeg);jpeg[bytes-2]=255;jpeg[bytes-1]=217;
  return {id:randomUUID(),name:'synthetic.jpg',data:jpeg.toString('base64'),width:1,height:1};
}
const imageUrls=(messages:readonly MultimodalMessage[])=>messages.flatMap(message=>typeof message.content==='string'?[]:message.content.flatMap(part=>part.type==='image_url'?[part.image_url.url]:[]));
function contextLimit(run:()=>unknown,kind:UnifiedChatContextError['limit']){assert.throws(run,error=>error instanceof UnifiedChatContextError&&error.limit===kind);}
function schematic():SchematicContext{
  const reference={kind:'schematic_reference' as const,projectId:randomUUID(),datasetId:REVIEWED_SCHEMATIC_DATASET,documentRef:REVIEWED_DOCUMENT_REF,artifactRef:REVIEWED_ARTIFACT_REF,sourceDigest:FOLDED_REVIEWED_SOURCE_DIGEST,adaptedDigest:FOLDED_ADAPTED_DIGEST,targets:[{kind:'instance' as const,occurrencePath:[] as [],definitionId:'definition:folded-cascode',elementId:'synthetic-device'}]};
  const value={contractVersion:SCHEMATIC_CONTEXT_VERSION,reference,excerpt:{title:'FOLDED_CASCODE',evidence:'reviewed_export_read_only' as const,electricalAnchors:'unavailable' as const,devices:[{id:'synthetic-device',name:'synthetic-only',master:{library:'synthetic',cell:'synthetic',view:'schematic'},parameters:[],terminals:[]}],nets:[]}};
  return {...value,previewDigest:createHash('sha256').update(schematicCanonical(value)).digest('hex')};
}

test('returning to a native conversation imports the accepted failed plain continuation ancestors without rerunning them',async()=>{
  let plainCalls=0;
  const f=fixture({plain:async(_request,options)=>{plainCalls++;options.onText('plain partial '+plainCalls);throw new CloudChatErrorV1('PROTOCOL_ERROR');}});
  try{
    const native=f.send('native opening');await until(()=>!f.host.isRunning());
    assert(f.invoke('setSessionModel',{sessionId:f.sessionId,provider:'deepseek',model:'deepseek-v4-flash-vision-exp'}).ok);
    const first=f.send('plain question after native history');await until(()=>!f.host.isRunning());
    assert.equal(f.state().selected!.turns.at(-1)!.status,'failed');
    const second=f.send(CONTINUE_TEXT,{continueFrom:first});await until(()=>!f.host.isRunning());
    assert.equal(f.state().selected!.turns.at(-1)!.status,'failed');
    const plainBefore=f.durable().sessions[0]!.turns.filter(turn=>turn.id===first||turn.id===second);
    assert.equal(plainCalls,2);assert.equal(f.starts.length,1);
    assert(f.invoke('setSessionModel',{sessionId:f.sessionId,provider:'kimi',model:'kimi-k3'}).ok);
    f.send(CONTINUE_TEXT,{continueFrom:second});await until(()=>!f.host.isRunning());
    assert.equal(f.state().selected!.turns.at(-1)!.status,'completed');
    assert.equal(f.starts.length,2);assert.equal(plainCalls,2,'reference import must not invoke the plain provider again');
    const continuation=f.starts[1]!.nativeConversation!;
    assert.equal(continuation.conversationId,f.sessionId);
    assert.equal(continuation.expectedSessionId,'native-persistent-fixture');
    assert.deepEqual(continuation.externalTurns?.map(turn=>turn.turnId),[first,second]);
    assert(!continuation.externalTurns?.some(turn=>turn.turnId===native));
    assert.deepEqual(continuation.externalTurns?.map(turn=>turn.messages),[
      [{role:'user',content:'plain question after native history'},{role:'assistant',content:'plain partial 1'}],
      [{role:'user',content:CONTINUE_TEXT},{role:'assistant',content:'plain partial 2'}],
    ]);
    assert.deepEqual(f.durable().sessions[0]!.turns.filter(turn=>turn.id===first||turn.id===second),plainBefore);
  }finally{await f.close();}
});

test('native image references retain more than two historical images across a text-only model switch',()=>{
  const old=[image(17),image(18),image(19)],current=image(20);
  const history=old.map((attachment,index)=>({turnId:randomUUID(),user:'old question '+index,assistant:'old answer '+index,images:[attachment]})),before=structuredClone(history);
  const vision=buildUnifiedChatContext(contextInput({history,images:[current]}),{nativeHistory:true});
  assert.deepEqual(imageUrls(vision.request.messages),[...old,current].map(attachment=>'data:image/jpeg;base64,'+attachment.data));
  const textOnly={provider:'deepseek' as const,model:'deepseek-v4-flash'};
  const native=buildUnifiedChatContext(contextInput({...textOnly,history}),{nativeHistory:true});
  assert.deepEqual(imageUrls(native.request.messages),old.map(attachment=>'data:image/jpeg;base64,'+attachment.data));
  assert.equal(native.historyVersion,vision.historyVersion,'historical image identity must survive a current-model change');
  assert.deepEqual(history,before);
  assert.throws(()=>buildUnifiedChatContext(contextInput({...textOnly,history,images:[current]}),{nativeHistory:true}),CloudChatErrorV1);
  contextLimit(()=>buildUnifiedChatContext(contextInput({history,images:[current]})),'images');
  contextLimit(()=>buildUnifiedChatContext(contextInput({images:[...old]}),{nativeHistory:true}),'images');
  const plain=buildUnifiedChatContext(contextInput({...textOnly,history}));
  assert.deepEqual(imageUrls(plain.request.messages),[]);
  for(const message of plain.request.messages.filter(message=>message.role==='user').slice(0,-1))assert.match(message.content as string,/历史图片未发送/u);
});

test('native reference envelope does not bypass the direct plain transport byte limit',()=>{
  const history=[{turnId:randomUUID(),user:'first',assistant:'a'.repeat(200000)},{turnId:randomUUID(),user:'second',assistant:'b'.repeat(200000)}],images=[image(IMAGE_BYTES),image(IMAGE_BYTES)];
  contextLimit(()=>buildUnifiedChatContext(contextInput({history,images})),'wire_bytes');
  const native=buildUnifiedChatContext(contextInput({history,images}),{nativeHistory:true});
  assert.equal(native.request.messages.length,5);assert.deepEqual(imageUrls(native.request.messages),images.map(attachment=>'data:image/jpeg;base64,'+attachment.data));
});

test('old schematic observations survive current-source rejection while a newly attached invalid reference dispatches nothing',async()=>{
  const old=schematic(),sessionId=randomUUID(),turnId=randomUUID(),now='2026-10-23T00:00:00.000Z';
  const initial:SessionDisk={version:6,selectedId:sessionId,sessions:[{id:sessionId,title:'historical schematic',provider:'kimi',model:'kimi-k3',createdAt:now,updatedAt:now,turns:[{id:turnId,user:'inspect the prior circuit',assistant:'saved observation',status:'completed',error:'',schematics:[old]}]}]};
  const validations:SchematicContext[][]=[];
  const f=fixture({initial,validateSchematicContexts:(_sessionId,contexts)=>{validations.push(structuredClone([...contexts]));throw Error('current project/source does not match this reference');}});
  try{
    f.send('explain the saved observation');await until(()=>!f.host.isRunning());
    assert.equal(f.state().selected!.turns.at(-1)!.status,'completed');
    assert.equal(validations.length,0,'historical observations must not be revalidated as today\'s source');
    const migrated=f.starts[0]!.nativeConversation!.externalTurns!;
    assert.deepEqual(migrated.map(turn=>turn.turnId),[turnId]);
    const content=migrated[0]!.messages[0]!.content as string;
    assert.match(content,/历史版本快照/u);assert(content.includes(old.previewDigest));
    assert.deepEqual(f.durable().sessions[0]!.turns[0]!.schematics,[old]);
    const before=f.durable(),current=schematic();
    assert.deepEqual(f.invoke('sendMessage',{sessionId,requestId:randomUUID(),text:'inspect this current reference',schematics:[current]}),{ok:false,error:{code:'SCHEMATIC_UNAVAILABLE'}});
    await tick();assert.deepEqual(validations,[[current]]);assert.equal(f.starts.length,1);assert.deepEqual(f.durable(),before);
  }finally{await f.close();}
});
