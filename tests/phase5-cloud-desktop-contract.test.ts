import test from 'node:test';import assert from 'node:assert/strict';
import {parseCloudStatusRequestV2,parseCloudSubmitRequestV2,parseCloudStatusResultV2,parseCloudSubmitResultV2,parseCloudReadRequestV2,parseCloudReadResultV2,parseCloudCancelRequestV2,parseCloudCancelResultV2,CLOUD_CHAT_API_VERSION_V2} from '../apps/desktop/src/shared/agent/cloud-chat-api';
const conversationId='conversation.cloud.11111111-1111-4111-8111-111111111111';
const clientRequestId='22222222-2222-4222-8222-222222222222';
const request=()=>({contractVersion:CLOUD_CHAT_API_VERSION_V2,providerId:'deepseek',conversationId,clientRequestId,text:'你好'});
test('P5-B new text contract carries text explicitly and rejects v1 identity abuse',()=>{
  const parsed=parseCloudSubmitRequestV2(request());assert.equal(parsed.text,'你好');assert.ok(Object.isFrozen(parsed));
  for(const value of [{...request(),inputRefs:['text']},{...request(),history:[]},{...request(),modelId:'arbitrary'},{...request(),apiKey:'FAKE'},{...request(),contractVersion:'workbench.agent.startTurn.v1'}])assert.throws(()=>parseCloudSubmitRequestV2(value));
});
test('P5-B request identity, UTF8 size, unknown fields and accessors fail closed',()=>{
  assert.equal(parseCloudSubmitRequestV2({...request(),text:'x'.repeat(16384)}).text.length,16384);
  let read=0;const value={...request()};Object.defineProperty(value,'text',{enumerable:true,get(){read++;return 'secret';}});
  for(const input of [value,{...request(),text:'x'.repeat(16385)},{...request(),text:'\ud800'},{...request(),text:'   '},{...request(),clientRequestId:'not-uuid'},{...request(),conversationId:'latest'},{...request(),providerId:'other'}])assert.throws(()=>parseCloudSubmitRequestV2(input));
  assert.equal(read,0);
});
test('P5-B status requires only version and publishes no endpoint or credential',()=>{
  assert.ok(Object.isFrozen(parseCloudStatusRequestV2({contractVersion:CLOUD_CHAT_API_VERSION_V2})));
  assert.throws(()=>parseCloudStatusRequestV2({contractVersion:CLOUD_CHAT_API_VERSION_V2,path:'D:/api.txt'}));
  const value={ok:true,value:{contractVersion:CLOUD_CHAT_API_VERSION_V2,providers:[{providerId:'deepseek',displayName:'DeepSeek',modelId:'deepseek-v4-flash',configured:true,conversationId}]}};
  assert.equal(parseCloudStatusResultV2(value).ok,true);
  for(const extra of [{apiKey:'FAKE_SECRET'},{endpoint:'https://example.invalid'},{credentialPath:'private'}])assert.throws(()=>parseCloudStatusResultV2({...value,value:{...value.value,providers:[{...value.value.providers[0],...extra}]}}));
});
test('P5-B result parser rejects raw error text and requires main-generated run ID',()=>{
  assert.deepEqual(parseCloudSubmitResultV2({ok:false,error:{code:'BUSY'}}),{ok:false,error:{code:'BUSY'}});
  assert.throws(()=>parseCloudSubmitResultV2({ok:false,error:{code:'INTERNAL',message:'raw secret'}}));
  assert.throws(()=>parseCloudSubmitResultV2({ok:true,value:{hostRunId:'latest'}}));
  assert.equal(parseCloudSubmitResultV2({ok:true,value:{hostRunId:'host.33333333-3333-4333-8333-333333333333'}}).ok,true);
});
test('P5-B pull and cancel enforce exact bounded selectors and safe results',()=>{
  const base={contractVersion:CLOUD_CHAT_API_VERSION_V2,hostRunId:'host.33333333-3333-4333-8333-333333333333'};
  assert.equal(parseCloudReadRequestV2({...base,afterSequence:1024}).afterSequence,1024);
  for(const cursor of [-0,-1,1025,1.1,NaN])assert.throws(()=>parseCloudReadRequestV2({...base,afterSequence:cursor}));
  assert.throws(()=>parseCloudCancelRequestV2({...base,afterSequence:0}));
  assert.equal(parseCloudCancelResultV2({ok:true,value:{status:'acknowledged'}}).ok,true);
  assert.equal(parseCloudReadResultV2({ok:true,value:{hostRunId:base.hostRunId,events:[],nextSequence:0,terminal:false}}).ok,true);
  assert.throws(()=>parseCloudReadResultV2({ok:true,value:{hostRunId:base.hostRunId,events:Array(33).fill({}),nextSequence:33,terminal:false}}));
  for(const client of [clientRequestId.toUpperCase().replace('22222222','AAAAAAAA'),clientRequestId.replace('-4222-','-1222-'),clientRequestId.replace('-8222-','-7222-')])assert.throws(()=>parseCloudSubmitRequestV2({...request(),clientRequestId:client}));
});
