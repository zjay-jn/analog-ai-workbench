import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createCloudControllerV2,cloudEnterSendsV2} from '../apps/desktop/src/renderer/agent/cloud-controller';
import {createCloudHostV2} from '../apps/desktop/src/main/cloud/cloud-host';
import type {WorkbenchCloudApiV2} from '../apps/desktop/src/shared/agent/cloud-chat-api';
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'s',windowId:'w',webContentsId:1,workspaceId:'ws',rootId:'r'};
const tick=()=>new Promise<void>(r=>setImmediate(r));
test('P5-C controller reads single flight, stops at terminal and restores provider transcripts',async()=>{
  const jobs:Array<()=>void>=[];let callback!:(text:string)=>void,resolve!:(value:{text:string})=>void,reads=0;
  const host=createCloudHostV2({owner,cloudEnabled:true,configured:{deepseek:true,kimi:true},execute:async(_r,o)=>{callback=o.onText;return new Promise(r=>{resolve=r;});}});
  const api:WorkbenchCloudApiV2={getStatus:async r=>host.getStatus(owner,r),submitTextTurn:async r=>host.submitTextTurn(owner,r),readRun:async r=>{reads++;return host.readRun(owner,r);},cancelRun:async r=>host.cancelRun(owner,r)};
  const controller=createCloudControllerV2(api,()=>{},{schedule(fn,ms){assert.equal(ms,250);jobs.push(fn);return fn;},clear(){jobs.length=0;},uuid:randomUUID});
  await controller.initialize();assert.equal(await controller.send('hello'),true);assert.equal(await controller.send('duplicate'),false);controller.select('kimi');assert.equal(controller.snapshot().selected,'deepseek');
  await tick();assert.equal(jobs.length,1);assert.equal(reads,1);callback('response');resolve({text:'response'});await tick();jobs.shift()!();await tick();
  assert.equal(controller.snapshot().turns.deepseek[0]!.assistant,'response');assert.equal(controller.snapshot().turns.deepseek[0]!.status,'completed');assert.equal(jobs.length,0);
  controller.select('kimi');assert.equal(controller.snapshot().turns.kimi.length,0);controller.select('deepseek');assert.equal(controller.snapshot().turns.deepseek.length,1);controller.dispose();host.revoke();
});
test('P5-C late read on unmount cannot update UI or create another timer',async()=>{
  let release!:(value:unknown)=>void,changes=0,timers=0;
  const conversationId='conversation.cloud.11111111-1111-4111-8111-111111111111',hostRunId='host.22222222-2222-4222-8222-222222222222';
  const api:WorkbenchCloudApiV2={getStatus:async r=>({ok:true,value:{...r,providers:[{providerId:'deepseek',displayName:'DeepSeek',modelId:'deepseek-v4-flash',configured:true,conversationId}]}}),submitTextTurn:async()=>({ok:true,value:{hostRunId}}),readRun:()=>new Promise(r=>{release=r as typeof release;}),cancelRun:async()=>({ok:true,value:{status:'acknowledged'}})};
  const controller=createCloudControllerV2(api,()=>{changes++;},{schedule(){timers++;return 1;},clear(){},uuid:randomUUID});await controller.initialize();await controller.send('hello');controller.dispose();const before=changes;
  release({ok:true,value:{hostRunId,events:[],nextSequence:0,terminal:false}});await tick();assert.equal(changes,before);assert.equal(timers,0);
});
test('P5-C Enter supports newline and never submits an IME composition',()=>{
  assert.equal(cloudEnterSendsV2({key:'Enter',shiftKey:false,isComposing:false}),true);
  for(const event of [{key:'Enter',shiftKey:true,isComposing:false},{key:'Enter',shiftKey:false,isComposing:true},{key:'Enter',shiftKey:false,isComposing:false,keyCode:229},{key:'a',shiftKey:false,isComposing:false}])assert.equal(cloudEnterSendsV2(event),false);
});
