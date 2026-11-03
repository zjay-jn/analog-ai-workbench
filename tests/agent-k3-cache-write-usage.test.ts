import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseProjectReadSse, projectReadCanonicalSse, ProjectReadProtocolError} from '../apps/desktop/src/main/agent-project-read/protocol';
import {PROJECT_READ_LIMITS as L, type ProjectReadModel} from '../apps/desktop/src/shared/agent/agent-project-read';

const kimi:ProjectReadModel={provider:'kimi',model:'kimi-k3'};
const counters={prompt_tokens:144,completion_tokens:50,total_tokens:194,completion_tokens_details:{reasoning_tokens:34}};
const done='data: [DONE]\n\n';
const frame=(choices:unknown[],usage?:unknown)=>'data: '+JSON.stringify({id:'synthetic_cache_write',model:'kimi-k3',choices,...(usage===undefined?{}:{usage})})+'\n\n';
const choice=(delta:unknown,finish_reason:string|null=null,usage?:unknown)=>({index:0,delta,finish_reason,...(usage===undefined?{}:{usage})});
const wire=(first:unknown,second:unknown=first)=>frame([choice({role:'assistant',content:'synthetic answer'})])+frame([choice({},'stop',first)])+frame([],second)+done;
const parse=(value:string)=>parseProjectReadSse(value,L.maxOutputTokens,kimi);
const rejects=(value:string)=>assert.throws(()=>parse(value),ProjectReadProtocolError);

test('K3 captured synthetic stop response accepts cache_write_tokens without cached_tokens',()=>{
  // Captured 2026-10-27 from an isolated synthetic probe, with all provider text,
  // completion ID and timestamp replaced. Frame order, field shapes and usage remain exact.
  const captured=readFileSync(resolve('tests/fixtures/k3-cache-write-20261027.sse'),'utf8');
  const result=parse(captured);
  assert.equal(result.id,'synthetic_k3_cache_write');
  assert.equal(result.finish,'stop');
  assert.equal(result.text,'xxx');
  assert.equal(result.calls.length,0);
  assert.deepEqual(result.usage,{inputTokens:144,outputTokens:50});
  const canonical=projectReadCanonicalSse(result,kimi);
  assert.deepEqual(parse(canonical).usage,result.usage);
  assert.equal(parse(canonical).text,result.text);
  assert.equal(canonical.includes('cache_write_tokens'),false);
  assert.equal(canonical.includes('reasoning_content'),false);
});

test('K3 cache write and cached counts remain independent bounded metadata with one public summary',()=>{
  for(const cache_write_tokens of [0,1,144]) {
    const onlyWrite={...counters,prompt_tokens_details:{cache_write_tokens}};
    assert.deepEqual(parse(wire(onlyWrite)).usage,{inputTokens:144,outputTokens:50});
    const both={...counters,cached_tokens:20,prompt_tokens_details:{cached_tokens:20,cache_write_tokens}};
    assert.deepEqual(parse(wire(both)).usage,{inputTokens:144,outputTokens:50});
    assert.deepEqual(parse(wire(onlyWrite,both)).usage,{inputTokens:144,outputTokens:50});
    assert.deepEqual(parse(wire(both,onlyWrite)).usage,{inputTokens:144,outputTokens:50});
  }
});

test('K3 rejects invalid cache write counts in choice and top-level usage',()=>{
  const valid={...counters,prompt_tokens_details:{cache_write_tokens:0}};
  for(const count of [-1,0.5,145,Number.MAX_SAFE_INTEGER+1,'0',null,true,{},[]]) {
    const invalid={...counters,prompt_tokens_details:{cache_write_tokens:count}};
    rejects(wire(invalid,valid));
    rejects(wire(valid,invalid));
  }
  rejects(wire(valid).replace('"cache_write_tokens":0','"cache_write_tokens":-0'));
});

test('K3 cache write extension still rejects empty or unknown detail shapes and invalid cached counts',()=>{
  for(const details of [{},[],0,'details',true,{cache_write_tokens:0,unknown:0},
    ...[-1,0.5,145,Number.MAX_SAFE_INTEGER+1,'0',null].map(cached_tokens=>({cache_write_tokens:0,cached_tokens}))]) {
    rejects(wire({...counters,prompt_tokens_details:details}));
  }
  rejects(wire({...counters,cached_tokens:1,prompt_tokens_details:{cache_write_tokens:0,cached_tokens:2}}));
  rejects(wire({...counters,total_tokens:195,prompt_tokens_details:{cache_write_tokens:0}}));
});

test('K3 repeated cache write metadata must agree, including when absent from an intermediate summary',()=>{
  const first={...counters,prompt_tokens_details:{cached_tokens:20,cache_write_tokens:1}};
  const changed={...counters,prompt_tokens_details:{cached_tokens:20,cache_write_tokens:2}};
  const withoutWrite={...counters,prompt_tokens_details:{cached_tokens:20}};
  rejects(wire(first,changed));
  rejects(frame([choice({content:'answer'})])+frame([choice({},'stop',first)])+frame([],withoutWrite)+frame([],changed)+done);
  assert.deepEqual(parse(wire(first,withoutWrite)).usage,{inputTokens:144,outputTokens:50});
});

test('K3 cache write compatibility does not extend the DeepSeek response schema or tool authorization',()=>{
  const usage={...counters,prompt_tokens_details:{cache_write_tokens:0}};
  const topOnly=frame([choice({content:'answer'})])+frame([choice({},'stop')])+frame([],usage)+done;
  assert.throws(()=>parseProjectReadSse(topOnly),ProjectReadProtocolError);
  const toolWire=(name:string,args:string)=>frame([choice({tool_calls:[{index:0,id:'call_synthetic',type:'function',function:{name,arguments:args}}]})])+frame([choice({},'tool_calls',usage)])+frame([],usage)+done;
  assert.equal(parse(toolWire('project_list','{"directoryId":null,"cursor":null,"refresh":false}')).calls.length,1);
  rejects(toolWire('unknown_tool','{}'));
  rejects(toolWire('project_list','{"directoryId":null,"cursor":null,"refresh":"false"}'));
});
