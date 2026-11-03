import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createOaReadRuntimeForTests, foldedCopyCaptureBinding } from '../apps/desktop/src/main/oa-read/runtime';
import { OaCaptureError, type OaReadAdapter } from '../apps/desktop/src/main/oa-read/adapter';
import { attachOaDisplayReferences } from '../apps/desktop/src/main/oa-read/reviewed-mapping';
import { oaDigest } from '../apps/desktop/src/main/oa-read/snapshot';
import type { OaReadToolResult, OaReadToolValue, OaSnapshotEnvelope } from '../apps/desktop/src/shared/agent/oa-read';

const projectId='11111111-1111-4111-8111-111111111111';
function value(r:OaReadToolResult):OaReadToolValue{assert.equal(r.ok,true);if(!r.ok)throw Error('expected value');return r.value;}
function fixture(){
  let captures=0,closed=0;
  const adapter:OaReadAdapter={
    async capture({requestId,binding}){
      captures++;
      const files=[{relativePath:'master.tag',bytes:35,sha256:'1'.repeat(64)},{relativePath:'sch.oa',bytes:50,sha256:String(captures).repeat(64)}];
      const savedRevision='sha256:'+createHash('sha256').update(JSON.stringify(files)).digest('hex');
      const envelope:OaSnapshotEnvelope={schema:'aaw.oa-saved-read.snapshot.v1',requestId,
        source:{sourceKind:'saved_oa',environmentBindingId:binding.environmentBindingId,libraryMappingIdentity:binding.libraryMappingIdentity,lcv:binding.lcv,
          capturedAt:'2026-10-28T00:00:00.000Z',readMode:'fresh_process_read_only',savedRevision,revisionMethod:'copied-file-manifest-sha256-v1',files,
          sourceObservation:{beforeDigest:savedRevision,afterDigest:savedRevision,copiedDigest:savedRevision,state:'observed_unchanged',transactionLock:false},dirty:{status:'unknown',reason:'not_observed'}},
        metadata:{adapterVersion:binding.adapterVersion,parameterEncoding:'skill_stored_value_serialization',coverage:{instances:'complete',nets:'complete',ports:'complete',parameters:'complete',terminals:'complete',netMembers:'complete',hierarchy:'not_read',masterContents:'not_read',cdf:'not_read'}},
        facts:{instances:[{id:'i1',name:'TEST',master:{library:'synthetic',cell:'test',view:'symbol'},parameters:[{name:'w',valueType:'string',valueText:`"${captures}u"`}],terminals:[{id:'t1',name:null,role:'unknown',netId:'n1'}]}],nets:[{id:'n1',name:'TEST_OUT',members:[{kind:'instance_terminal',instanceId:'i1',terminalId:'t1'}]}],ports:[]}};
      return {envelopeJson:JSON.stringify(envelope),closure:{requestId,windowsProcessClosed:true,readerStarted:true,linuxProcessGroupClosed:true,receiptSha256:'a'.repeat(64)}};
    },async close(){closed++;}
  };
  const runtime=createOaReadRuntimeForTests({runId:'run-synthetic',projectId,loadReviewed(){throw Error('not installed in synthetic fixture');},adapter});
  return {runtime,adapter,get captures(){return captures;},get closed(){return closed;}};
}
const open={toolName:'oa_open_design',arguments:{designId:'folded-cascode-copy',refresh:false}} as const;
test('OA runtime opens lazily, reuses current capture, preserves old snapshot after refresh and rejects unknown handles',async()=>{
  const f=fixture(),signal=new AbortController().signal;
  assert.equal(f.captures,0);
  assert.deepEqual(await f.runtime.execute({...open,arguments:{...open.arguments,designId:'other'}},signal),{ok:false,error:{code:'NOT_BOUND'},coverage:null});
  const a=value(await f.runtime.execute(open,signal));
  assert.equal(a.source.designId,'folded-cascode-copy');assert.equal(a.source.dirty.status,'unknown');
  assert.equal(a.displayReferences,undefined);assert.equal(f.captures,1);
  assert.equal(value(await f.runtime.execute(open,signal)).source.snapshotId,a.source.snapshotId);assert.equal(f.captures,1);
  const b=value(await f.runtime.execute({...open,arguments:{...open.arguments,refresh:true}},signal));assert.equal(f.captures,2);
  assert.notEqual(a.source.designHandle,b.source.designHandle);assert.notEqual(a.source.savedRevision,b.source.savedRevision);
  const query=(source:typeof a.source)=>({toolName:'oa_describe_device' as const,arguments:{designHandle:source.designHandle,savedRevision:source.savedRevision,instanceId:'i1',section:'parameters' as const,cursor:null}});
  const old=value(await f.runtime.execute(query(a.source),signal));assert.equal(old.data.kind,'device_parameters');
  if(old.data.kind==='device_parameters')assert.equal(old.data.items[0]?.valueText,'"1u"');
  const mixed=await f.runtime.execute(query({...a.source,savedRevision:b.source.savedRevision}),signal);assert.deepEqual(mixed,{ok:false,error:{code:'SOURCE_CHANGED'},coverage:null});
  assert.deepEqual(await f.runtime.execute(query({...a.source,designHandle:'invented'}),signal),{ok:false,error:{code:'NOT_BOUND'},coverage:null});
  await f.runtime.close();assert.equal(f.closed,1);assert.deepEqual(await f.runtime.execute(open,signal),{ok:false,error:{code:'CANCELLED'},coverage:null});
});
test('OA runtime propagates unconfirmed closure and never publishes a failed capture',async()=>{
  const runtime=createOaReadRuntimeForTests({runId:'failed',projectId,loadReviewed(){throw Error('unused');},adapter:{async capture(){throw new OaCaptureError('CLEANUP_FAILED');},async close(){}}});
  await assert.rejects(runtime.execute(open,new AbortController().signal),e=>e instanceof OaCaptureError&&e.code==='CLEANUP_FAILED');
  await runtime.close();
});
test('OA runtime pre-cancel does not capture and source binding is the retained copy',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();
  assert.deepEqual(await f.runtime.execute(open,abort.signal),{ok:false,error:{code:'CANCELLED'},coverage:null});assert.equal(f.captures,0);
  assert.equal(foldedCopyCaptureBinding('fixture').environmentBindingId,'rocky9-llm-lab:folded-copy:v1');await f.runtime.close();
});
test('mapping unavailable adds no bytes to a near-limit query result',async()=>{
  const f=fixture(),v=value(await f.runtime.execute(open,new AbortController().signal));
  const large={...v,data:{kind:'device_parameters' as const,instanceId:'i1',encoding:'skill_stored_value_serialization' as const,items:[{name:'note',valueType:'string',valueText:'x'.repeat(9000)}]}};
  large.data.items[0]!.valueText += 'x'.repeat(12288-Buffer.byteLength(JSON.stringify({ok:true,value:large})));
  const {resultDigest:_,...body}=large;const signed={...body,resultDigest:oaDigest(body)};
  assert.deepEqual(attachOaDisplayReferences(signed,null),signed);
  assert.equal(Buffer.byteLength(JSON.stringify({ok:true,value:attachOaDisplayReferences(signed,null)})),Buffer.byteLength(JSON.stringify({ok:true,value:signed})));await f.runtime.close();
});
