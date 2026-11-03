import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createCloudHostV2,type CloudExecutorV2} from '../apps/desktop/src/main/cloud/cloud-host';
import {CLOUD_CHAT_API_VERSION_V2 as contractVersion,parseCloudReadResultV2,type CloudProviderIdV2} from '../apps/desktop/src/shared/agent/cloud-chat-api';
import {CloudChatErrorV1,type CloudChatRequestV1} from '../packages/agent-adapters/src/cloud-chat-contract';
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'s',windowId:'w',webContentsId:1,workspaceId:'workspace',rootId:'root'};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup(execute:CloudExecutorV2){
  const host=createCloudHostV2({owner,cloudEnabled:true,configured:{deepseek:true,kimi:true},execute});
  function request(text='hello',providerId:CloudProviderIdV2='deepseek',clientRequestId=randomUUID()){
    const status=host.getStatus(owner,{contractVersion});assert.equal(status.ok,true);if(!status.ok)throw Error();
    return {contractVersion,providerId,conversationId:status.value.providers.find(p=>p.providerId===providerId)!.conversationId,clientRequestId,text};
  }
  function submit(value=request()){const result=host.submitTextTurn(owner,value);assert.equal(result.ok,true);if(!result.ok)throw Error();return result.value.hostRunId;}
  function read(hostRunId:string,afterSequence=0){const result=host.readRun(owner,{contractVersion,hostRunId,afterSequence});assert.equal(result.ok,true);if(!result.ok)throw Error();assert.deepEqual(parseCloudReadResultV2(result),result);return result.value;}
  return {host,request,submit,read};
}
test('P5-B host actual time, canonical digest, byte-safe deltas and repeatable cursor replay',async()=>{
  const text='x'.repeat(4095)+'😀中文';const s=setup(async(_r,o)=>{o.onText(text);return {text};});const id=s.submit();await tick();
  const first=s.read(id);assert.deepEqual(first.events.map(e=>e.type),['run.accepted','message.delta','message.delta','run.completed']);
  assert.equal(first.events.filter(e=>e.type==='message.delta').map(e=>e.payload.text).join(''),text);assert.equal(first.terminal,true);
  assert.ok(Math.abs(Date.now()-Date.parse(first.events[0]!.acceptedAt))<5000);assert.deepEqual(s.read(id),first);assert.equal(s.read(id,4).events.length,0);
  assert.equal(s.host.readRun(owner,{contractVersion,hostRunId:id,afterSequence:5}).ok,false);
});
test('P5-B host acceptance is atomic and owner precedes idempotency; cancel ignores late callbacks',async()=>{
  let calls=0,late!:(text:string)=>void,resolve!:(value:{text:string})=>void,signal!:AbortSignal;
  const s=setup(async(_r,o)=>{calls++;late=o.onText;signal=o.signal;return new Promise(r=>{resolve=r;});});const request=s.request();const id=s.submit(request);
  assert.equal(s.host.submitTextTurn(owner,s.request()).ok,false);assert.deepEqual(s.host.submitTextTurn(owner,request),{ok:true,value:{hostRunId:id}});
  assert.equal(s.host.submitTextTurn({...owner,navigationEpoch:2},request).ok,false);assert.equal(s.host.submitTextTurn(owner,{...request,text:'different'}).ok,false);
  await tick();late('partial');assert.equal(s.host.cancelRun(owner,{contractVersion,hostRunId:id}).ok,true);assert.equal(signal.aborted,true);late('late');resolve({text:'partiallate'});await tick();
  assert.deepEqual(s.read(id).events.map(e=>e.type),['run.accepted','message.delta','run.cancelled']);assert.equal(calls,1);assert.equal(s.read(id).terminal,true);
});
test('P5-B provider contexts isolate success and exclude failed, cancelled and oversized assistant',async()=>{
  const inputs:CloudChatRequestV1[]=[];const s=setup(async(r,o)=>{inputs.push(r);const text=r.messages.at(-1)!.content==='long'?'x'.repeat(16385):'answer';o.onText(text);return {text};});
  s.submit(s.request('one'));await tick();s.submit(s.request('two','kimi'));await tick();s.submit(s.request('three'));await tick();
  assert.equal(inputs[1]!.messages.length,1);assert.deepEqual(inputs[2]!.messages.map(m=>m.content),['one','answer','three']);
  s.submit(s.request('long','kimi'));await tick();s.submit(s.request('after','kimi'));await tick();assert.deepEqual(inputs[4]!.messages.map(m=>m.content),['two','answer','after']);
});
test('P5-B context body rejection costs no run and session cap still permits existing idempotency',async()=>{
  let calls=0;const s=setup(async(_r,o)=>{calls++;o.onText('OK');return {text:'OK'};});
  assert.equal(s.host.submitTextTurn(owner,s.request('x'+'\u0001'.repeat(16383))).ok,false);assert.equal(s.host.snapshot().runs,0);
  const first=s.request();const id=s.submit(first);await tick();for(let i=1;i<32;i++){s.submit();await tick();}
  assert.deepEqual(s.host.submitTextTurn(owner,s.request()),{ok:false,error:{code:'SESSION_LIMIT'}});assert.deepEqual(s.host.submitTextTurn(owner,first),{ok:true,value:{hostRunId:id}});assert.equal(calls,32);
});
test('P5-B event slot overflow aborts and reserves exactly one readable terminal',async()=>{
  let signal!:AbortSignal;const s=setup(async(_r,o)=>{signal=o.signal;for(let i=0;i<1100;i++)o.onText('x');return {text:'x'.repeat(1100)};});const id=s.submit();await tick();
  let cursor=0;const all=[];for(;;){const batch=s.read(id,cursor);all.push(...batch.events);assert.ok(batch.events.length<=32);cursor=batch.nextSequence;if(batch.terminal)break;}
  assert.equal(all.length,1024);assert.equal(all.filter(e=>e.type==='run.failed').length,1);assert.equal(all.at(-1)!.type,'run.failed');assert.equal(signal.aborted,true);
});
test('P5-B escaped JSON read batches stay bounded and advance without subscribers',async()=>{
  const text='\u0001'.repeat(65536);const s=setup(async(_r,o)=>{o.onText(text);return {text};});const id=s.submit();await tick();
  const first=s.read(id);assert.ok(first.events.length<18);assert.ok(Buffer.byteLength(JSON.stringify({ok:true,value:first}))<=262144);assert.equal(first.terminal,false);
  const second=s.read(id,first.nextSequence);assert.equal(second.terminal,true);assert.equal([...first.events,...second.events].filter(e=>e.type==='message.delta').map(e=>e.payload.text).join(''),text);
  for(let i=0;i<100;i++)s.read(id);assert.equal(s.host.snapshot().subscriptions,0);
});
test('P5-B permanent revocation blocks all methods, erases logs and rejects late transport',async()=>{
  let callback!:(text:string)=>void;const s=setup(async(_r,o)=>{callback=o.onText;return new Promise(()=>{});});const req=s.request(),id=s.submit(req);await tick();s.host.revoke();callback('late');
  assert.deepEqual(s.host.snapshot(),{revoked:true,runs:0,requests:0,running:0,subscriptions:0});
  for(const result of [s.host.getStatus(owner,{contractVersion}),s.host.submitTextTurn(owner,req),s.host.readRun(owner,{contractVersion,hostRunId:id,afterSequence:0}),s.host.cancelRun(owner,{contractVersion,hostRunId:id})])assert.deepEqual(result,{ok:false,error:{code:'CAPABILITY_DENIED'}});
});
test('P5-B fixed provider failure mapping never includes raw error text',async()=>{
  for(const [code,expected] of [['AUTHENTICATION_FAILED','NOT_CONFIGURED'],['RATE_LIMITED','RATE_LIMITED'],['TIMEOUT','UPSTREAM_TIMEOUT'],['PROTOCOL_ERROR','STREAM_INTERRUPTED'],['UPSTREAM_UNAVAILABLE','ADAPTER_UNAVAILABLE']] as const){
    const s=setup(async()=>{throw new CloudChatErrorV1(code);});const id=s.submit();await tick();const end=s.read(id).events.at(-1)!;assert.equal(end.type,'run.failed');if(end.type==='run.failed')assert.equal(end.payload.errorCode,expected);
  }
});
