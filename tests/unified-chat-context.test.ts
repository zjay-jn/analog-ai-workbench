import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {buildUnifiedChatContext,validateUnifiedChatRequest,UnifiedChatContextError,type UnifiedChatContextInput} from '../apps/desktop/src/main/cloud/unified-chat-context';
import {multimodalBody,type MultimodalRequest} from '../apps/desktop/src/main/cloud/multimodal-context';
import {DEFAULT_REPLY_LIMITS,MAX_REPLY_BYTES} from '../apps/desktop/src/shared/agent/reply-limits';
import {IMAGE_BYTES,type ImageAttachment} from '../apps/desktop/src/shared/agent/image-attachment';
import type {FileContext} from '../apps/desktop/src/shared/agent/file-context';
import type {ChatClarification} from '../apps/desktop/src/shared/agent/chat-turns';
import {SCHEMATIC_CONTEXT_VERSION,REVIEWED_SCHEMATIC_DATASET,REVIEWED_DOCUMENT_REF,REVIEWED_ARTIFACT_REF,schematicCanonical,type SchematicContext} from '../apps/desktop/src/shared/schematic/reviewed-schematic';
import {FOLDED_ADAPTED_DIGEST,FOLDED_REVIEWED_SOURCE_DIGEST} from '../packages/schematic-workbench/src/reviewed-display-validation';

// Pure synthetic objects only. No host, files, credentials, network, WSL or EDA.
const input=(change:Partial<UnifiedChatContextInput>={}):UnifiedChatContextInput=>({provider:'kimi',model:'kimi-k3',text:'current',images:[],files:[],schematics:[],history:[],replyLimits:{...DEFAULT_REPLY_LIMITS},...change});
const turn=(user='old question',assistant='old answer')=>({turnId:randomUUID(),user,assistant});
const image=(bytes=17):ImageAttachment=>{
  const jpeg=Buffer.alloc(bytes);Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0]).copy(jpeg);jpeg[bytes-2]=255;jpeg[bytes-1]=217;
  return {id:randomUUID(),name:'synthetic.jpg',data:jpeg.toString('base64'),width:1,height:1};
};
const file=():FileContext=>({id:randomUUID(),name:'synthetic.txt',text:'fixture only',startLine:4,endLine:4,totalLines:8});
function schematic():SchematicContext{
  const reference={kind:'schematic_reference' as const,projectId:randomUUID(),datasetId:REVIEWED_SCHEMATIC_DATASET,documentRef:REVIEWED_DOCUMENT_REF,artifactRef:REVIEWED_ARTIFACT_REF,sourceDigest:FOLDED_REVIEWED_SOURCE_DIGEST,adaptedDigest:FOLDED_ADAPTED_DIGEST,targets:[{kind:'instance' as const,occurrencePath:[] as [],definitionId:'definition:folded-cascode',elementId:'synthetic-device'}]};
  const value={contractVersion:SCHEMATIC_CONTEXT_VERSION,reference,excerpt:{title:'FOLDED_CASCODE',evidence:'reviewed_export_read_only' as const,electricalAnchors:'unavailable' as const,devices:[{id:'synthetic-device',name:'synthetic-only',master:{library:'synthetic',cell:'synthetic',view:'schematic'},parameters:[],terminals:[]}],nets:[]}};
  return {...value,previewDigest:createHash('sha256').update(schematicCanonical(value)).digest('hex')};
}
function contextLimit(run:()=>unknown,kind:UnifiedChatContextError['limit']){
  assert.throws(run,error=>error instanceof UnifiedChatContextError&&error.code==='CONTEXT_LIMIT'&&error.limit===kind);
}
function invalid(run:()=>unknown){assert.throws(run,error=>error instanceof Error&&!(error instanceof UnifiedChatContextError));}

test('all supplied turns survive beyond the legacy eight-pair window, in exact order',()=>{
  const history=Array.from({length:12},(_,index)=>turn('q'+index,'a'+index)),original=structuredClone(history);
  const result=buildUnifiedChatContext(input({history}));
  assert.equal(result.request.messages.length,25);
  assert.deepEqual(result.request.messages.map(message=>message.content),history.flatMap(row=>[row.user,row.assistant]).concat('current'));
  assert.deepEqual(result.historyTurnIds,history.map(row=>row.turnId));assert.deepEqual(history,original);
  assert.equal(validateUnifiedChatRequest(result.request),result.request);assert.match(result.historyVersion,/^[a-f0-9]{64}$/u);
});

test('history beyond 100 turns is preserved without a count-based admission limit',()=>{
  const history=Array.from({length:99},()=>turn());
  assert.equal(buildUnifiedChatContext(input({history})).request.messages.length,199);
  assert.equal(buildUnifiedChatContext(input({history:[...history,turn()]})).request.messages.length,201);
  const request=buildUnifiedChatContext(input()).request;
  assert.equal(validateUnifiedChatRequest({...request,messages:Array.from({length:241},(_,i)=>({role:i%2?'assistant':'user',content:'q'}))}).messages.length,241);
});

test('single-user and reply limits measure UTF-8 bytes, including boundary values',()=>{
  const boundary='中'.repeat(5461)+'x';assert.equal(Buffer.byteLength(boundary),16384);
  assert.equal(buildUnifiedChatContext(input({text:boundary})).request.messages[0]!.content,boundary);
  contextLimit(()=>buildUnifiedChatContext(input({text:boundary+'x'})),'user_bytes');
  assert.equal(buildUnifiedChatContext(input({history:[turn('q','a'.repeat(MAX_REPLY_BYTES))]})).historyTurnIds.length,1);
  contextLimit(()=>buildUnifiedChatContext(input({history:[turn('q','a'.repeat(MAX_REPLY_BYTES+1))]})),'reply_bytes');
});

test('history beyond 512KiB is preserved without an aggregate text admission limit',()=>{
  const history=[turn('u'.repeat(16384),'a'.repeat(MAX_REPLY_BYTES)),turn('u','a'.repeat(245758))];
  const result=buildUnifiedChatContext(input({text:'u',history}));
  assert.equal(result.request.messages.reduce((n,m)=>n+Buffer.byteLength(m.content as string),0),512*1024);
  const expanded=buildUnifiedChatContext(input({text:'uu',history}));
  assert.equal(expanded.request.messages.reduce((n,m)=>n+Buffer.byteLength(m.content as string),0),512*1024+1);
});

test('native history is a reference envelope, while current input and actual direct transport remain bounded',()=>{
  const history=Array.from({length:120},()=>turn('old question','a'.repeat(10000))),before=structuredClone(history);
  contextLimit(()=>buildUnifiedChatContext(input({history})),'wire_bytes');
  const native=buildUnifiedChatContext(input({history}),{nativeHistory:true});
  assert.equal(native.historyTurnIds.length,120);assert.equal(native.request.messages.length,241);
  assert.deepEqual(history,before);
  assert.equal(validateUnifiedChatRequest(native.request,{nativeHistory:true}),native.request);
  contextLimit(()=>buildUnifiedChatContext(input({history,text:'x'.repeat(16385)}),{nativeHistory:true}),'user_bytes');
});

test('wire cap counts JSON escaping, even when all text fits the text cap',()=>{
  const history=[turn('u','\\'.repeat(262140)),turn('u','\\'.repeat(262140))];
  contextLimit(()=>buildUnifiedChatContext(input({text:'u',history})),'wire_bytes');
  const request:MultimodalRequest={provider:'kimi',model:'kimi-k3',...DEFAULT_REPLY_LIMITS,messages:history.flatMap(row=>[{role:'user' as const,content:row.user},{role:'assistant' as const,content:row.assistant}]).concat({role:'user',content:'u'})};
  assert.ok(Buffer.byteLength(multimodalBody(request))>1024*1024);
  contextLimit(()=>validateUnifiedChatRequest(request),'wire_bytes');
});

test('vision preserves current and historical image bytes, with a total cap of two',()=>{
  const current=image(),old=image(),history=[{...turn(),images:[old]}];
  const result=buildUnifiedChatContext(input({history,images:[current]}));
  assert.ok(multimodalBody(result.request).includes(old.data));assert.ok(multimodalBody(result.request).includes(current.data));
  contextLimit(()=>buildUnifiedChatContext(input({history,images:[current,image()]})),'images');
  contextLimit(()=>buildUnifiedChatContext(input({images:[current,old,image()]})),'images');
  assert.equal(result.historyTurnIds.length,1);
});

test('total wire cap includes base64 image payloads together with historical replies',()=>{
  const images=[image(IMAGE_BYTES),image(IMAGE_BYTES)];
  contextLimit(()=>buildUnifiedChatContext(input({images,history:[turn('u','a'.repeat(200000)),turn('u','b'.repeat(200000))]})),'wire_bytes');
});

test('text-only model explicitly marks historical images; current images are refused',()=>{
  const old={...turn(),images:[image()]},selection={provider:'deepseek' as const,model:'deepseek-v4-flash'};
  const result=buildUnifiedChatContext(input({...selection,history:[old]}));
  assert.equal(result.request.provider,'deepseek');assert.equal(result.request.model,'deepseek-v4-flash');
  assert.match(result.request.messages[0]!.content as string,/历史图片未发送/u);assert.ok((result.request.messages[0]!.content as string).startsWith(old.user));
  assert.ok(!multimodalBody(result.request).includes('image_url'));
  invalid(()=>buildUnifiedChatContext(input({...selection,images:[image()]})));
});

test('file and schematic excerpts are retained with historical attribution and counted',()=>{
  const f=file(),s=schematic(),history=[{...turn(),files:[f],schematics:[s]}];
  const result=buildUnifiedChatContext(input({history,files:[f],schematics:[s]}));
  const earlier=result.request.messages[0]!.content as string,current=result.request.messages[2]!.content as string;
  assert.match(earlier,/历史版本快照/u);assert.match(earlier,/L4\| fixture only/u);assert.ok(earlier.includes('synthetic-only'));
  assert.ok(current.includes('synthetic-only'));assert.ok(!current.includes('历史版本快照'));
  contextLimit(()=>buildUnifiedChatContext(input({text:'u'.repeat(16384),files:[f]})),'user_bytes');
  const malformed={...s,previewDigest:'0'.repeat(64)};
  invalid(()=>buildUnifiedChatContext(input({history:[{...turn(),schematics:[malformed]}]})));
});

test('history fingerprint is stable, ordered and binds exact content plus attachment identity',()=>{
  const history:UnifiedChatContextInput['history'][number][]=[{...turn(),images:[image()],files:[file()],schematics:[schematic()]},turn()];
  const first=buildUnifiedChatContext(input({history}));
  const reordered=history.map(row=>Object.fromEntries(Object.entries(row).reverse())) as typeof history;
  assert.equal(buildUnifiedChatContext(input({history:reordered,text:'different current'})).historyVersion,first.historyVersion);
  assert.equal(buildUnifiedChatContext(input({history,provider:'deepseek',model:'deepseek-v4-flash'})).historyVersion,first.historyVersion);
  for(const change of [
    (h:typeof history)=>{h.reverse();},
    (h:typeof history)=>{h[0]!.user+=' changed';},
    (h:typeof history)=>{h[0]!.assistant+=' changed';},
    (h:typeof history)=>{h[0]!.turnId=randomUUID();},
    (h:typeof history)=>{h[0]!.images![0]!.id=randomUUID();},
    (h:typeof history)=>{h[0]!.files![0]!.id=randomUUID();},
    (h:typeof history)=>{h[0]!.images![0]!.name='renamed.jpg';},
  ]){const changed=structuredClone(history);change(changed);assert.notEqual(buildUnifiedChatContext(input({history:changed})).historyVersion,first.historyVersion);}
  const t=turn();assert.equal(buildUnifiedChatContext(input({history:[t]})).historyVersion,buildUnifiedChatContext(input({history:[{...t,images:[],files:[],schematics:[]}]})).historyVersion);
});

test('malformed history, model, attachments and reply configuration do not become limits',()=>{
  const a=turn();
  invalid(()=>buildUnifiedChatContext(input({history:[a,a]})));
  invalid(()=>buildUnifiedChatContext(input({history:[{...a,turnId:'not-an-id'}]})));
  invalid(()=>buildUnifiedChatContext(input({history:[{...a,user:'bad\ud800'}]})));
  invalid(()=>buildUnifiedChatContext(input({history:[{...a,images:[{...image(),data:'https://invalid.example'}]}]})));
  invalid(()=>buildUnifiedChatContext(input({history:[{...a,images:null as unknown as ImageAttachment[]}]})));
  invalid(()=>buildUnifiedChatContext(input({images:[image(),...Array(2).fill(image())]})));
  invalid(()=>buildUnifiedChatContext(input({model:'unknown'})));
  invalid(()=>buildUnifiedChatContext(input({replyLimits:{maxOutputTokens:8191,timeoutMs:600000}})));
  invalid(()=>buildUnifiedChatContext(input({text:''})));
});

test('image-only sends use the existing visible default prompt without losing the image',()=>{
  const result=buildUnifiedChatContext(input({text:'',images:[image()]}));
  assert.match(multimodalBody(result.request),/请描述这张图片/u);assert.match(multimodalBody(result.request),/image_url/u);
});

test('strict main-owned request rejects hidden keys, getters, sparse arrays and forged parts',()=>{
  const request=buildUnifiedChatContext(input({images:[image()]})).request;
  let accessed=0;const getter=Object.defineProperty({...request},'messages',{get(){accessed++;return [];}});
  invalid(()=>validateUnifiedChatRequest(getter));assert.equal(accessed,0);
  invalid(()=>validateUnifiedChatRequest({...request,messages:new Array(1)}));
  invalid(()=>validateUnifiedChatRequest({...request,endpoint:'https://invalid.example'} as MultimodalRequest));
  const hidden=Object.defineProperty({...request},'extra',{value:true});invalid(()=>validateUnifiedChatRequest(hidden));
  const bad=structuredClone(request);const parts=bad.messages[0]!.content;
  assert.ok(Array.isArray(parts));parts[1]={type:'image_url',image_url:{url:'https://invalid.example/image.jpg'}};
  invalid(()=>validateUnifiedChatRequest(bad));
  invalid(()=>validateUnifiedChatRequest({...request,messages:[{role:'assistant',content:'q'}]}));
  const badInput=Object.defineProperty(input(),'history',{get(){accessed++;return [];}});invalid(()=>buildUnifiedChatContext(badInput));assert.equal(accessed,0);
});

test('clarifications replay delivered questions and answers in real roles with original attachments once',()=>{
  const oldImage=image(),oldFile=file(),oldSchematic=schematic();
  const clarifications:ChatClarification[]=[
    {questionId:'q_first',prompt:'What unit?',answer:'mA',delivered:true},
    {questionId:'q_pending',prompt:'Pending prompt stays private',answer:null,delivered:false},
    {questionId:'q_submitted',prompt:'Unacknowledged prompt stays private',answer:'unacknowledged answer',delivered:false},
    {questionId:'q_second',prompt:'What range?',answer:'1 to 3',delivered:true},
  ];
  const row={...turn('original question','final answer'),images:[oldImage],files:[oldFile],schematics:[oldSchematic],clarifications},original=structuredClone(row);
  const result=buildUnifiedChatContext(input({history:[row]})),messages=result.request.messages;
  assert.deepEqual(messages.map(m=>m.role),['user','assistant','user','assistant','user','assistant','user']);
  assert.deepEqual(messages.slice(1).map(m=>m.content),['What unit?','mA','What range?','1 to 3','final answer','current']);
  const parts=messages[0]!.content;assert.ok(Array.isArray(parts));assert.equal(parts.length,2);assert.equal(parts[0]!.type,'text');
  assert.ok(JSON.stringify(parts).includes(oldImage.data));assert.ok(JSON.stringify(parts).includes('fixture only'));assert.ok(JSON.stringify(parts).includes('synthetic-only'));
  assert.equal(multimodalBody(result.request).includes('unacknowledged'),false);assert.equal(multimodalBody(result.request).includes('stays private'),false);
  assert.deepEqual(result.historyTurnIds,[row.turnId]);assert.deepEqual(row,original);assert.equal(validateUnifiedChatRequest(result.request),result.request);
});

test('clarifications fingerprint binds every identity, prompt, answer and delivery state including unsent rows',()=>{
  const clarifications:ChatClarification[]=[{questionId:'q_delivered',prompt:'delivered question',answer:'delivered answer',delivered:true},{questionId:'q_submitted',prompt:'submitted question',answer:'submitted answer',delivered:false},{questionId:'q_pending',prompt:'pending question',answer:null,delivered:false}];
  const row={...turn(),clarifications},first=buildUnifiedChatContext(input({history:[row]}));
  const reordered=clarifications.map(c=>Object.fromEntries(Object.entries(c).reverse())) as ChatClarification[];
  assert.equal(buildUnifiedChatContext(input({history:[{...row,clarifications:reordered}]})).historyVersion,first.historyVersion);
  for(const change of [
    (a:ChatClarification[])=>{a.reverse();},
    (a:ChatClarification[])=>{a[1]={...a[1]!,questionId:'q_different'};},
    (a:ChatClarification[])=>{a[1]={...a[1]!,prompt:'different unacknowledged question'};},
    (a:ChatClarification[])=>{a[1]={...a[1]!,answer:'different unacknowledged answer'};},
    (a:ChatClarification[])=>{a[1]={...a[1]!,delivered:true};},
    (a:ChatClarification[])=>{a[2]={...a[2]!,answer:'now submitted'};},
  ]){const changed=structuredClone(clarifications);change(changed);assert.notEqual(buildUnifiedChatContext(input({history:[{...row,clarifications:changed}]})).historyVersion,first.historyVersion);}
  const changed=clarifications.map(c=>c.questionId==='q_submitted'?{...c,answer:'changed but still not delivered'}:c);
  assert.deepEqual(buildUnifiedChatContext(input({history:[{...row,clarifications:changed}]})).request,first.request);
  const empty=turn();assert.equal(buildUnifiedChatContext(input({history:[empty]})).historyVersion,buildUnifiedChatContext(input({history:[{...empty,clarifications:[]}]})).historyVersion);
});

test('clarifications obey the shared strict contract without disguising invalid rows as context limits',()=>{
  const clarification:ChatClarification={questionId:'q_1',prompt:'q',answer:'a',delivered:true};
  const withValue=(value:unknown)=>input({history:[{...turn(),clarifications:value as ChatClarification[]}]});
  const boundary='中'.repeat(1365)+'x';assert.equal(Buffer.byteLength(boundary),4096);
  assert.equal(buildUnifiedChatContext(withValue([{...clarification,prompt:boundary,answer:boundary}])).request.messages.length,5);
  assert.equal(buildUnifiedChatContext(withValue(Array.from({length:16},(_,i)=>({...clarification,questionId:'q_'+i})))).request.messages.length,35);
  for(const value of [null,{},new Array(1),[clarification,clarification],Array.from({length:17},(_,i)=>({...clarification,questionId:'q_'+i})),
    [{...clarification,questionId:'../invalid'}],[{...clarification,prompt:boundary+'x'}],[{...clarification,answer:boundary+'x'}],
    [{...clarification,answer:null}],[{...clarification,delivered:1}],[{...clarification,answer:''}],[{...clarification,prompt:'bad\ud800'}],[{...clarification,extra:true}],
  ])invalid(()=>buildUnifiedChatContext(withValue(value)));
  let accessed=0;const getter=Object.defineProperty({...clarification},'answer',{enumerable:true,get(){accessed++;return 'bad';}});
  invalid(()=>buildUnifiedChatContext(withValue([getter])));assert.equal(accessed,0);
});

test('clarifications remain in history beyond former message and aggregate text caps',()=>{
  const clarification:ChatClarification={questionId:'q_1',prompt:'q',answer:'a',delivered:true};
  const history=[{...turn(),clarifications:[clarification]},...Array.from({length:97},()=>turn())];
  assert.equal(buildUnifiedChatContext(input({history})).request.messages.length,199);
  assert.equal(buildUnifiedChatContext(input({history:[...history,turn()]})).request.messages.length,201);
  const textHistory=[{...turn('u','a'.repeat(MAX_REPLY_BYTES)),clarifications:[clarification]},turn('u','a'.repeat(262139))];
  const result=buildUnifiedChatContext(input({text:'u',history:textHistory}));
  assert.equal(result.request.messages.reduce((n,m)=>n+Buffer.byteLength(m.content as string),0),512*1024);
  assert.equal(buildUnifiedChatContext(input({text:'uu',history:textHistory})).request.messages.reduce((n,m)=>n+Buffer.byteLength(m.content as string),0),512*1024+1);
  const unsent=textHistory.map(row=>({...row,...('clarifications'in row?{clarifications:[{...clarification,answer:'x'.repeat(4096),delivered:false}]}:{})}));
  assert.equal(buildUnifiedChatContext(input({text:'u',history:unsent})).request.messages.length,5);
});

test('clarifications wire budget includes JSON escaping while preserving the whole supplied history',()=>{
  const history=[turn('u','\\'.repeat(260000)),turn('u','\\'.repeat(260000))];
  assert.ok(Buffer.byteLength(multimodalBody(buildUnifiedChatContext(input({text:'u',history})).request))<1024*1024);
  const clarifications:ChatClarification[]=[{questionId:'q_wire',prompt:'\\'.repeat(2100),answer:'\\'.repeat(2100),delivered:true}];
  const expanded=[{...history[0]!,clarifications},history[1]!],before=structuredClone(expanded);
  contextLimit(()=>buildUnifiedChatContext(input({text:'u',history:expanded})),'wire_bytes');assert.deepEqual(expanded,before);
});
