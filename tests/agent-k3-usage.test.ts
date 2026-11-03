import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectReadSse, projectReadCanonicalSse, ProjectReadProtocolError } from '../apps/desktop/src/main/agent-project-read/protocol';
import { PROJECT_READ_LIMITS as L, type ProjectReadModel } from '../apps/desktop/src/shared/agent/agent-project-read';

const kimi:ProjectReadModel={provider:'kimi',model:'kimi-k3'};
const counters={prompt_tokens:8282,completion_tokens:112,total_tokens:8394,completion_tokens_details:{reasoning_tokens:15}};
const done='data: [DONE]\n\n';
const frame=(choices:unknown[],usage?:unknown)=>'data: '+JSON.stringify({id:'synthetic_k3_usage',model:'kimi-k3',choices,...(usage===undefined?{}:{usage})})+'\n\n';
const choice=(delta:unknown,finish_reason:string|null=null,usage?:unknown)=>({index:0,delta,finish_reason,...(usage===undefined?{}:{usage})});
const prefix=frame([choice({role:'assistant',reasoning_content:'synthetic private fixture'})])+frame([choice({tool_calls:[
  {index:0,id:'call_list',type:'function',function:{name:'project_list',arguments:' { "refresh":false,"cursor":null,"directoryId":null } '}},
  {index:1,id:'call_env',type:'function',function:{name:'command_environment',arguments:'{}'}},
]})]);
const wire=(choiceUsage:unknown=counters,topUsage:unknown=counters)=>prefix+frame([choice({},'tool_calls',choiceUsage)])+(topUsage===undefined?'':frame([],topUsage))+done;
const parse=(value:string,max:number=L.maxOutputTokens)=>parseProjectReadSse(value,max,kimi);
const rejects=(value:string)=>assert.throws(()=>parse(value),ProjectReadProtocolError);

test('K3 terminal choice and top-level usage are one consistent summary including bounded reasoning details', () => {
  const result=parse(wire()); assert.deepEqual(result.usage,{inputTokens:8282,outputTokens:112});
  assert.deepEqual(result.calls.map(call=>call.name),['project_list','command_environment']);
  const canonical=projectReadCanonicalSse(result,kimi); assert.equal(canonical.includes('reasoning_content'),false);
  assert.deepEqual(parse(canonical).usage,result.usage); assert.deepEqual(parse(canonical).calls,result.calls);
  assert.equal(result.providerArguments?.[0],' { "refresh":false,"cursor":null,"directoryId":null } ');
  const onlyChoice=prefix+frame([choice({},'tool_calls',counters)])+done;
  assert.deepEqual(parse(onlyChoice).usage,result.usage);
  assert.deepEqual(parse(wire(null,counters)).usage,result.usage);
  assert.equal(parse(prefix+frame([choice({},'tool_calls',null)])+done).usage,null);
  // Empty Kimi completion details report no reasoning count; do not invent zero or conflict with a later known value.
  const unknownReasoning={...counters,completion_tokens_details:{}};
  assert.deepEqual(parse(wire(unknownReasoning,counters)).usage,result.usage);
  assert.deepEqual(parse(wire(counters,unknownReasoning)).usage,result.usage);
  assert.throws(()=>parseProjectReadSse(onlyChoice.replace('synthetic private fixture','')),ProjectReadProtocolError);
});

test('K3 usage rejects unknown fields, malformed detail objects and invalid or excessive counts', () => {
  const invalid:unknown[]=[[],{},'usage', {...counters,unknown:0}, {...counters,completion_tokens_details:{reasoning_tokens:15,unknown:0}},
    {...counters,completion_tokens_details:[]},
    ...[-1,1.5,113,Number.MAX_SAFE_INTEGER+1,'15',null].map(reasoning_tokens=>({...counters,completion_tokens_details:{reasoning_tokens}})),
    {...counters,prompt_tokens:-1}, {...counters,completion_tokens:L.maxOutputTokens+1}, {...counters,total_tokens:8395},
    {...counters,prompt_cache_hit_tokens:8283}, {...counters,prompt_cache_hit_tokens:5000,prompt_cache_miss_tokens:5000},
  ];
  for(const value of invalid){rejects(wire(value,counters));rejects(wire(counters,value));}
  rejects(wire().replace('"reasoning_tokens":15','"reasoning_tokens":-0'));
  assert.throws(()=>parse(wire(),111),ProjectReadProtocolError);
});

test('K3 duplicate usage must agree on counts and reasoning; terminal position, model, DONE and tool validation remain enforced', () => {
  rejects(wire(counters,{...counters,completion_tokens:113,total_tokens:8395}));
  rejects(wire(counters,{...counters,completion_tokens_details:{reasoning_tokens:16}}));
  rejects(frame([choice({content:'text'},null,counters)])+frame([choice({},'stop')])+done);
  rejects(wire().replace(done,'')); rejects(wire().replace('"model":"kimi-k3"','"model":"changed"'));
  rejects(wire().replace('"finish_reason":"tool_calls"','"finish_reason":"length"'));
  rejects(wire().replace('command_environment','unknown_tool'));
  rejects(prefix+frame([{...choice({},'tool_calls',counters),unexpected:true}])+frame([],counters)+done);
  rejects(wire().replace('false','123'));
});

test('K3 observed direct and nested cache counters agree and preserve one public token summary', () => {
  const cached={prompt_tokens:9032,completion_tokens:83,total_tokens:9115,cached_tokens:8192,prompt_tokens_details:{cached_tokens:8192},completion_tokens_details:{reasoning_tokens:1}};
  assert.deepEqual(parse(wire(cached,cached)).usage,{inputTokens:9032,outputTokens:83});
  for(const count of [0,9032]) {
    const value={...cached,cached_tokens:count,prompt_tokens_details:{cached_tokens:count}};
    assert.deepEqual(parse(wire(value,value)).usage,{inputTokens:9032,outputTokens:83});
  }
  const {prompt_tokens_details,...direct}=cached, {cached_tokens,...nested}=cached;
  assert.deepEqual(parse(wire(direct,nested)).usage,{inputTokens:9032,outputTokens:83});
  assert.deepEqual(parse(wire({...direct,prompt_tokens_details:null},cached)).usage,{inputTokens:9032,outputTokens:83});
});

test('K3 cache aliases reject malformed objects, excessive counts, unknown fields and conflicting repeated statistics', () => {
  const cached={...counters,cached_tokens:100,prompt_tokens_details:{cached_tokens:100}};
  for(const count of [-1,1.5,8283,Number.MAX_SAFE_INTEGER+1,'100',null]) {
    rejects(wire({...cached,cached_tokens:count},cached));
    rejects(wire({...cached,prompt_tokens_details:{cached_tokens:count}},cached));
  }
  for(const details of [{},[],100,{cached_tokens:100,unknown:0},{cached_tokens:101}])rejects(wire({...cached,prompt_tokens_details:details},cached));
  rejects(wire(cached,{...cached,cached_tokens:101,prompt_tokens_details:{cached_tokens:101}}));
  const {prompt_tokens_details,...direct}=cached, {cached_tokens,...nested}=cached;
  rejects(wire(direct,{...nested,prompt_tokens_details:{cached_tokens:101}}));
  rejects(wire(cached,cached).replace('"cached_tokens":100','"cached_tokens":-0'));
});
