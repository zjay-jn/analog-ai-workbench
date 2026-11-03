import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {cloudExtensionV2} from '../apps/desktop/src/main/cloud/register-cloud-ipc';
import {CLOUD_CHAT_API_VERSION_V2 as contractVersion,CLOUD_STATUS_CHANNEL_V2,CLOUD_SUBMIT_CHANNEL_V2,CLOUD_READ_CHANNEL_V2,CLOUD_CANCEL_CHANNEL_V2,parseCloudStatusResultV2,parseCloudSubmitResultV2,parseCloudReadResultV2,parseCloudCancelResultV2} from '../apps/desktop/src/shared/agent/cloud-chat-api';
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'s',windowId:'w',webContentsId:1,workspaceId:'ws',rootId:'r'};
function setup(configured=true){
  const handlers=new Map<string,(event:unknown,value:unknown)=>unknown>();let cleared=0,calls=0;
  const register=cloudExtensionV2({configured:{deepseek:configured,kimi:true},execute:async(_r,o)=>{calls++;o.onText('OK');return {text:'OK'};},clearCredentials(){cleared++;}});
  const fake={ipcMain:{removeHandler:(channel:string)=>handlers.delete(channel),handle:(channel:string,handler:(event:unknown,value:unknown)=>unknown)=>handlers.set(channel,handler)},owner,deriveCallerContext:(event:unknown)=>event===owner?owner:null} as unknown as Parameters<typeof register>[0];
  const runtime=register(fake);return {invoke:(channel:string,value:unknown,event:unknown=owner)=>handlers.get(channel)!(event,value),runtime,handlers,stats:()=>({cleared,calls})};
}
test('P5-B main exact-parses its own response before crossing IPC',()=>{
  const s=setup('invalid-configuration' as unknown as boolean);
  assert.deepEqual(s.invoke(CLOUD_STATUS_CHANNEL_V2,{contractVersion}),{ok:false,error:{code:'INTERNAL'}});s.runtime.dispose();
});
test('P5-B four actual handlers validate responses, reject owner mismatch and permanently dispose',async()=>{
  const s=setup();assert.equal(s.handlers.size,4);
  const status=parseCloudStatusResultV2(s.invoke(CLOUD_STATUS_CHANNEL_V2,{contractVersion}));assert.equal(status.ok,true);if(!status.ok)throw Error();
  const request={contractVersion,providerId:'deepseek',conversationId:status.value.providers[0]!.conversationId,clientRequestId:randomUUID(),text:'hello'};
  assert.deepEqual(s.invoke(CLOUD_SUBMIT_CHANNEL_V2,request,null),{ok:false,error:{code:'CAPABILITY_DENIED'}});
  const start=parseCloudSubmitResultV2(s.invoke(CLOUD_SUBMIT_CHANNEL_V2,request));assert.equal(start.ok,true);if(!start.ok)throw Error();const hostRunId=start.value.hostRunId;
  assert.equal(parseCloudReadResultV2(s.invoke(CLOUD_READ_CHANNEL_V2,{contractVersion,hostRunId,afterSequence:0})).ok,true);
  assert.equal(parseCloudCancelResultV2(s.invoke(CLOUD_CANCEL_CHANNEL_V2,{contractVersion,hostRunId})).ok,true);
  await new Promise(r=>setImmediate(r));assert.equal(s.stats().calls,0);
  s.runtime.revoke();assert.deepEqual(s.invoke(CLOUD_STATUS_CHANNEL_V2,{contractVersion}),{ok:false,error:{code:'CAPABILITY_DENIED'}});s.runtime.dispose();assert.equal(s.handlers.size,0);
});
