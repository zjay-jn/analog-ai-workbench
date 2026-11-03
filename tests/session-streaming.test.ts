import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';import {performCloudChatV2} from '../apps/desktop/src/main/cloud/cloud-transport';
import {SESSION_VERSION,parseSessionDisk,type SessionDisk} from '../apps/desktop/src/shared/agent/chat-sessions';
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'s',windowId:'w',webContentsId:1,workspaceId:'ws',rootId:'r'};
const event=(content:string,finish:string|null=null)=>'data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:finish}]})+'\n\n';
async function runFrames(frames:string[]){
 let disk:SessionDisk={version:3,selectedId:null,sessions:[]},calls=0;
 const host=createSessionHost({owner,configured:{deepseek:true,kimi:true},store:{load:()=>disk,save:value=>{disk=parseSessionDisk(value);}},execute:async()=>{throw Error('legacy not expected');},executeMultimodal:(request,options)=>performCloudChatV2(request,{...options,apiKey:'sk-SYNTHETIC_STREAM_ONLY_123456',fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(JSON.parse(init.body as string).max_tokens,2048);let index=0;
  return new Response(new ReadableStream<Uint8Array>({pull(controller){if(index<frames.length)controller.enqueue(new TextEncoder().encode(frames[index++]!));else controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
 }})});
 const created=host.invoke(owner,'createSession',{contractVersion:SESSION_VERSION,provider:'deepseek',title:'stream'});assert.ok(created.ok);if(!created.ok)throw Error();
 assert.equal(host.invoke(owner,'sendMessage',{contractVersion:SESSION_VERSION,sessionId:created.value.selectedId!,requestId:randomUUID(),text:'如何测试一个sar-adc'}).ok,true);
 for(let i=0;i<500&&host.isRunning();i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(host.isRunning(),false);const turn=disk.sessions[0]!.turns[0]!;host.revoke();return {turn,calls};
}
test('normal DeepSeek reply with 1400 small SSE deltas completes without the old 1022-fragment cutoff',async()=>{
 const result=await runFrames([...Array.from({length:1400},()=>event('测')),event('','stop'),'data: [DONE]\n\n']);
 assert.equal(result.calls,1);assert.equal(result.turn.status,'completed');assert.equal(result.turn.assistant,'测'.repeat(1400));assert.equal(result.turn.error,'');
});
test('upstream length cutoff is distinct from incomplete stream and preserves received text',async()=>{
 const length=await runFrames([event('已收到的方案'),event('','length'),'data: [DONE]\n\n']);
 assert.equal(length.turn.status,'failed');assert.equal(length.turn.assistant,'已收到的方案');assert.match(length.turn.error,/2048/);
 const incomplete=await runFrames([event('未完整方案')]);assert.equal(incomplete.turn.status,'failed');assert.equal(incomplete.turn.assistant,'未完整方案');assert.match(incomplete.turn.error,/结束标记/);assert.notEqual(length.turn.error,incomplete.turn.error);
});
test('receive byte budget still fails closed with a distinct resource-limit explanation',async()=>{
 const received=await runFrames([event('a'.repeat(32000)),event('b'.repeat(32000)),event('c'.repeat(2000)),event('','stop'),'data: [DONE]\n\n']);
 assert.equal(received.turn.status,'failed');assert.equal(received.turn.assistant.length,64000);assert.match(received.turn.error,/软件接收限制/);assert.equal(received.calls,1);
});
