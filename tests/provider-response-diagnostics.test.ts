import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectReadSseParser,parseProjectReadSse,projectReadCanonicalSse,ProjectReadProtocolError} from '../apps/desktop/src/main/agent-project-read/protocol';
import {parseProviderResponseDiagnostic,parseProviderUsageDiagnostic,providerUsageDiagnostic,type ProviderResponseCode} from '../apps/desktop/src/shared/agent/provider-response-diagnostic';
const model={provider:'kimi',model:'kimi-k3'} as const;
const frame=(delta:unknown={},finish_reason:string|null=null,extra:object={})=>'data: '+JSON.stringify({id:'synthetic_completion',model:'kimi-k3',choices:[{index:0,delta,finish_reason}],...extra})+'\n\n';
const done='data: [DONE]\n\n';
const call=(args:string,name='command_status')=>frame({tool_calls:[{index:0,id:'synthetic_call',type:'function',function:{name,arguments:args}}]},'tool_calls')+done;
const capture=(wire:string)=>{try{parseProjectReadSse(wire,4096,model);assert.fail('expected validation failure');}catch(error){assert(error instanceof ProjectReadProtocolError);assert(error.responseFailure);return error.responseFailure;}};

test('parser reports fixed locations for malformed frames, identities, usage and finish without retaining values',()=>{
 const samples:[string,ProviderResponseCode][]=[
  ['data: private-untrusted-response\n\n','sse.json'],
  ['event: private-event\n\ndata: [DONE]\n\n','sse.frame.lines'],
  [frame({},null,{private_secret:'private-untrusted-response'}),'sse.frame.shape'],
  [frame({},null,{id:'invalid private identity'}),'sse.id'],
  [frame({},null,{usage:{prompt_tokens:10,completion_tokens:2,total_tokens:99}}),'sse.usage.total'],
  [frame({},null,{choices:[{index:1,delta:{}}]}),'sse.choice.index'],
  [frame({role:'private-role'}),'sse.delta.role'],
  [frame({private_secret:'private-untrusted-response'}),'sse.delta.shape'],
  [frame({},'length'),'sse.finish.reason'],
  [frame({content:'partial'}),'sse.final.incomplete'],
  [frame({},'stop')+done,'sse.final.consistency'],
  [done,'sse.done'],
  [frame({content:'ok'},'stop')+done+frame({content:'late'}),'sse.frame.order'],
 ];
 for(const [wire,code] of samples){const evidence=capture(wire);assert.equal(evidence.code,code);assert.equal(evidence.receivedBytes,Buffer.byteLength(wire));assert.deepEqual(parseProviderResponseDiagnostic(evidence),evidence);assert(!JSON.stringify(evidence).includes('private'));assert(Object.isFrozen(evidence));}
});

test('tool failures distinguish argument JSON, argument schema, unknown name and incomplete call',()=>{
 for(const [wire,code] of [
  [call('{private-invalid-json'), 'sse.tool.arguments_json'],
  [call(JSON.stringify({executionId:'synthetic',afterRevision:1,waitMs:25001})), 'sse.tool.arguments_schema'],
  [call('{}','private-unknown-tool'), 'sse.tool.name'],
  [frame({tool_calls:[{index:0,id:'synthetic_call',function:{name:'command_status',arguments:'{}'}}]},'tool_calls')+done,'sse.tool.complete'],
 ] as [string,ProviderResponseCode][]){const evidence=capture(wire);assert.equal(evidence.code,code);assert.equal(evidence.toolCalls,1);assert(!JSON.stringify(evidence).includes('private'));}
});

test('usage disagreements have their own first cause, unchanged after another parser call',()=>{
 const parser=createProjectReadSseParser(4096,model);
 const wire=frame({content:'ok'},'stop',{usage:{prompt_tokens:4,completion_tokens:1}})+'data: '+JSON.stringify({id:'synthetic_completion',choices:[],usage:{prompt_tokens:4,completion_tokens:2}})+'\n\n';
 let first:unknown;try{parser.push(wire);}catch(error){assert(error instanceof ProjectReadProtocolError);first=error.responseFailure;assert.equal(error.responseFailure?.code,'sse.usage.conflict');assert.equal(error.responseFailure?.frame,2);}
 assert(first);assert.throws(()=>parser.finish(),error=>error instanceof ProjectReadProtocolError&&JSON.stringify(error.responseFailure)===JSON.stringify(first));
});

test('valid fragmented text and tool responses keep the same completion and do not create failures',()=>{
 for(const wire of [frame({content:'合成测试'},'stop')+done,call(JSON.stringify({executionId:'synthetic',afterRevision:1,waitMs:25000}))]){
  const expected=parseProjectReadSse(wire,4096,model),parser=createProjectReadSseParser(4096,model);
  for(let offset=0;offset<wire.length;offset+=7)parser.push(wire.slice(offset,offset+7));
  assert.deepEqual(parser.finish(),expected);assert.equal(parser.diagnostic().done,true);
 }
});

test('persisted response evidence rejects unknown fields, strings, getters and invalid counts',()=>{
 const safe=capture('data: invalid\n\n');
 for(const patch of [{code:'private-provider-message'},{frame:-1},{textBytes:NaN},{toolCalls:1.5},{receivedBytes:-0},{done:'true'},{finish:'private'},{message:'private'}])assert.throws(()=>parseProviderResponseDiagnostic({...safe,...patch}));
 let read=false;const getter=Object.defineProperty({...safe},'code',{enumerable:true,get(){read=true;return 'sse.json';}});assert.throws(()=>parseProviderResponseDiagnostic(getter));assert.equal(read,false);
});

test('choice usage diagnostics separate finish gating from every known counter and shape check',()=>{
 const valid={prompt_tokens:10,completion_tokens:2,total_tokens:12};
 const choice=(usage:unknown,finish_reason:unknown='tool_calls')=>frame({},null,{choices:[{index:0,delta:{},finish_reason,usage}]});
 for(const [input,code] of [
  [choice(valid,null),'sse.choice.usage.finish'],
  [choice({...valid,private_field:'private-value'}),'sse.usage.shape'],
  [choice({...valid,completion_tokens:8193}),'sse.usage.counts'],
  [choice({...valid,total_tokens:13}),'sse.usage.total'],
  [choice({...valid,completion_tokens_details:{private_field:2}}),'sse.usage.completion_details'],
  [choice({...valid,completion_tokens_details:{reasoning_tokens:3}}),'sse.usage.reasoning'],
  [choice({...valid,prompt_cache_hit_tokens:11}),'sse.usage.cache_hit'],
  [choice({...valid,prompt_cache_miss_tokens:11}),'sse.usage.cache_miss'],
  [choice({...valid,prompt_tokens_details:{}}),'sse.usage.prompt_details'],
  [choice({...valid,cached_tokens:11}),'sse.usage.cached'],
  [choice({...valid,prompt_tokens_details:{cache_write_tokens:11}}),'sse.usage.cache_write'],
  [choice({...valid,cached_tokens:2,prompt_tokens_details:{cached_tokens:3}}),'sse.usage.cached_conflict'],
  [choice({...valid,prompt_cache_hit_tokens:9,prompt_cache_miss_tokens:2}),'sse.usage.cache_total'],
 ] as [string,ProviderResponseCode][]){const evidence=capture(input);assert.equal(evidence.code,code);assert(evidence.usage);assert.equal(evidence.usage.scope,'choice');assert.deepEqual(parseProviderResponseDiagnostic(evidence),evidence);assert(!JSON.stringify(evidence).includes('private'));}
 const diagnostic=capture(choice(valid,null));assert.equal(diagnostic.usage?.finishReason,'null');assert.equal(diagnostic.usage?.fields.find(field=>field.field==='prompt_tokens')?.value,10);
});

test('usage observations are bounded fixed metadata even when valid and observer exceptions do not affect acceptance',()=>{
 const observations:unknown[]=[];const parser=createProjectReadSseParser(4096,model,undefined,undefined,(value,frame)=>{observations.push({value,frame});throw Error('private-observer-error');});
 parser.push(frame({content:'ok'},'stop',{usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})+done);assert.equal(parser.finish().text,'ok');assert.equal(observations.length,1);
 const safe=providerUsageDiagnostic({prompt_tokens:1,completion_tokens:'private-secret',private_key:'private-secret',prompt_tokens_details:{private_detail:'private-secret'}},'choice','private-finish');assert.equal(safe.finishReason,'other');assert.equal(safe.unknownFields,1);assert.equal(safe.promptUnknownFields,1);assert(!JSON.stringify(safe).includes('private'));assert.deepEqual(parseProviderUsageDiagnostic(safe),safe);
 let read=false;const getter=Object.defineProperty({...safe},'scope',{enumerable:true,get(){read=true;return 'choice';}});assert.throws(()=>parseProviderUsageDiagnostic(getter));assert.equal(read,false);
 for(const patch of [{fields:[...safe.fields,{field:'private_key',kind:'integer',value:1}]},{unknownFields:-1},{finishReason:'private-value'},{message:'private-value'}])assert.throws(()=>parseProviderUsageDiagnostic({...safe,...patch}));
});

test('real Kimi empty completion details preserve primary counts across fragmented tool SSE and canonical native output',()=>{
 const usage={prompt_tokens:9936,completion_tokens:105,total_tokens:10041,completion_tokens_details:{},prompt_tokens_details:{cache_write_tokens:9728}};
 const wire=frame({tool_calls:[{index:0,id:'synthetic_status',type:'function',function:{name:'command_status',arguments:JSON.stringify({executionId:'cmd-00000000-0000-4000-8000-000000000001',afterRevision:1,waitMs:25000})}}]})+frame({},null,{choices:[{index:0,delta:{},finish_reason:'tool_calls',usage}]})+done;
 const observations:ReturnType<typeof providerUsageDiagnostic>[]=[];
 const parser=createProjectReadSseParser(4096,model,undefined,undefined,value=>observations.push(value));
 for(let offset=0;offset<wire.length;offset+=11)parser.push(wire.slice(offset,offset+11));const parsed=parser.finish();
 assert.deepEqual(parsed.usage,{inputTokens:9936,outputTokens:105});assert.equal(parsed.calls[0]?.name,'command_status');assert.equal(observations[0]?.fields.find(field=>field.field==='completion_tokens_details.reasoning_tokens')?.kind,'missing');
 const canonical=projectReadCanonicalSse(parsed,model);assert.deepEqual(parseProjectReadSse(canonical,4096,model).usage,parsed.usage);assert(!canonical.includes('reasoning_tokens'));
});

test('Kimi details compatibility keeps reasoning values strict and leaves DeepSeek empty-details semantics unchanged',()=>{
 const response=(details:unknown)=>frame({content:'ok'},'stop',{usage:{prompt_tokens:9936,completion_tokens:105,total_tokens:10041,completion_tokens_details:details}})+done;
 assert.deepEqual(parseProjectReadSse(response({}),4096,model).usage,{inputTokens:9936,outputTokens:105});
 for(const reasoning_tokens of [0,105])assert(parseProjectReadSse(response({reasoning_tokens}),4096,model));
 for(const details of [{reasoning_tokens:-1},{reasoning_tokens:106},{reasoning_tokens:1.5},{reasoning_tokens:null},{unrecognized:0}])assert.throws(()=>parseProjectReadSse(response(details),4096,model),ProjectReadProtocolError);
 assert.throws(()=>parseProjectReadSse(response({}),4096,{provider:'deepseek',model:'deepseek-v4-flash'}),ProjectReadProtocolError);
});
