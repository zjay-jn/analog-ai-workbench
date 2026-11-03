import test from 'node:test';import assert from 'node:assert/strict';
import {buildCloudContextV2,splitCloudDeltaV2,cloudRequestBodyV2} from '../apps/desktop/src/main/cloud/cloud-budget';
import {performCloudChatV1} from '../apps/desktop/src/main/cloud/cloud-transport';
test('P5-B context excludes entire oversized assistant pairs at the exact boundary',()=>{
  assert.equal(buildCloudContextV2('kimi','next',[{user:'old',assistant:'x'.repeat(16384)}]).messages.length,3);
  assert.deepEqual(buildCloudContextV2('kimi','next',[{user:'old',assistant:'x'.repeat(16385)}]).messages,[{role:'user',content:'next'}]);
});
test('P5-B context preserves recent complete pairs within count, content and escaped body budgets',()=>{
  const pairs=Array.from({length:10},(_,i)=>({user:`u${i}`,assistant:`a${i}`}));
  const full=buildCloudContextV2('deepseek','next',pairs);assert.equal(full.messages.length,17);assert.equal(full.messages[0]!.content,'u2');
  const large=buildCloudContextV2('kimi','x'.repeat(16384),Array.from({length:8},()=>({user:'u'.repeat(16384),assistant:'a'.repeat(16384)})));
  assert.equal(large.messages.length,3);
  assert.throws(()=>buildCloudContextV2('deepseek','x'+'\u0000'.repeat(16383),[]));
  const escaped=buildCloudContextV2('kimi','next',[{user:'\u0001'.repeat(16000),assistant:'a'}]);assert.equal(escaped.messages.length,1);
});
test('P5-B canonical splitting preserves code points, whitespace and all bytes',()=>{
  for(const source of ['x'.repeat(4095),'x'.repeat(4096),'x'.repeat(4097),'x'.repeat(4095)+'😀中文\n','😀'.repeat(16384)]){
    const parts=splitCloudDeltaV2(source);assert.equal(parts.join(''),source);assert.ok(parts.every(p=>Buffer.byteLength(p)<=4096));
  }
  assert.throws(()=>splitCloudDeltaV2('\ud800'));
});
test('P5-B context body budgets use exact reviewed transport serialization for both providers',async()=>{
  for(const provider of ['deepseek','kimi'] as const){
    const request=buildCloudContextV2(provider,'hello\n\u0001',[]);let body:unknown;
    await assert.rejects(performCloudChatV1(request,{apiKey:'sk-FAKE_TEST_ONLY',onText(){},fetchImpl:async(_url,init)=>{body=init.body;return new Response('',{status:401});}}));
    assert.equal(body,cloudRequestBodyV2(request));
  }
});
