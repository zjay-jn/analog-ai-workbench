import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCloudChatRequestV1, cloudProviderProfileV1, CloudChatErrorV1 } from '../packages/agent-adapters/src/cloud-chat-contract';
import { createCloudChatStreamParserV1 } from '../packages/agent-adapters/src/cloud-chat-stream';

const request = () => ({ provider: 'deepseek', model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '你好' }], maxOutputTokens: 64 });
const wire = (text: string) => new TextEncoder().encode(text);
const event = (delta: Record<string, unknown>, finish_reason: unknown = null) => `data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`;
const done = 'data: [DONE]\n\n';
function expectCode(action: () => unknown, code: string) { assert.throws(action, (error: unknown) => error instanceof CloudChatErrorV1 && error.code === code); }

test('P5 cloud request fixes destination/model and freezes bounded plain messages', () => {
  const parsed = parseCloudChatRequestV1(request());
  assert.equal(parsed.messages[0]?.content, '你好');
  assert.equal(cloudProviderProfileV1(parsed.provider).chatUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(cloudProviderProfileV1('kimi').chatUrl, 'https://api.moonshot.cn/v1/chat/completions');
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.messages) && Object.isFrozen(parsed.messages[0]));
  assert.equal(parseCloudChatRequestV1({...request(),provider:'kimi',model:'kimi-k3'}).model,'kimi-k3');
});

test('P5 rejects arbitrary endpoints, tool/system fields and provider/model confusion', () => {
  for (const value of [
    {...request(), endpoint:'https://example.invalid'}, {...request(), apiKey:'FAKE-SECRET'},
    {...request(), tools:[]}, {...request(), model:'kimi-k3'}, {...request(),provider:'other'},
    {...request(),messages:[{role:'system',content:'elevate'}]},
    {...request(),messages:[{role:'user',content:'x',tool_calls:[]}]},
    {...request(),messages:[{role:'assistant',content:'unowned'}]},
    {...request(),messages:[{role:'user',content:'x'},{role:'user',content:'y'}]},
  ]) expectCode(() => parseCloudChatRequestV1(value),'INVALID_REQUEST');
});

test('P5 rejects input, output, and accessor abuse without evaluating getters', () => {
  let invoked=0;
  const accessor={...request()}; Object.defineProperty(accessor,'model',{get(){invoked++;return 'deepseek-v4-flash';},enumerable:true});
  for(const value of [accessor,{...request(),maxOutputTokens:2049},{...request(),maxOutputTokens:0},{...request(),maxOutputTokens:1.5},{...request(),messages:[{role:'user',content:' '.repeat(100)}]},{...request(),messages:[{role:'user',content:'中'.repeat(6000)}]},{...request(),messages:[{role:'user',content:'\ud800'}]}]) expectCode(()=>parseCloudChatRequestV1(value),'INVALID_REQUEST');
  assert.equal(invoked,0);
});

test('P5 safe errors never echo secrets or provider bodies', () => {
  const error=new CloudChatErrorV1('AUTHENTICATION_FAILED');
  assert.equal(error.message,'Cloud chat failed: AUTHENTICATION_FAILED');
  expectCode(()=>parseCloudChatRequestV1({...request(),apiKey:'SYNTHETIC-PRIVATE-VALUE'}),'INVALID_REQUEST');
});

test('P5 SSE handles Chinese split at every byte and a normal final event', () => {
  const received:string[]=[]; const parser=createCloudChatStreamParserV1(text=>received.push(text));
  const raw=wire(event({role:'assistant',content:''})+event({content:'你好🙂'})+event({},'stop')+done);
  for(const byte of raw)parser.push(new Uint8Array([byte]));
  assert.deepEqual(parser.finish(),{text:'你好🙂',finishReason:'stop'});
  assert.equal(received.join(''),'你好🙂');
});

test('P5 SSE supports CRLF, comments and multiline data with optional usage-only event', () => {
  const parser=createCloudChatStreamParserV1(()=>{});
  parser.push(wire(': heartbeat\r\n\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\r\n\r\n'+event({},'stop')+'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n'+done));
  assert.equal(parser.finish().text,'OK');
});

test('P5 SSE ignores bounded reasoning but requires final answer content', () => {
  const chunks:string[]=[];const parser=createCloudChatStreamParserV1(text=>chunks.push(text));
  parser.push(wire(event({reasoning_content:'private intermediate reasoning'})+event({content:'Answer'})+event({},'stop')+done));
  assert.equal(parser.finish().text,'Answer'); assert.deepEqual(chunks,['Answer']);
  const reasoningOnly=createCloudChatStreamParserV1(()=>{});
  reasoningOnly.push(wire(event({reasoning_content:'only reasoning'})+event({},'stop')+done));
  expectCode(()=>reasoningOnly.finish(),'PROTOCOL_ERROR');
});

test('P5 SSE requires finish marker and DONE, rejects truncation and malformed UTF8', () => {
  for(const raw of [event({content:'partial'}),event({content:'partial'})+done,event({content:'partial'})+event({},'stop')]) {
    const p=createCloudChatStreamParserV1(()=>{});expectCode(()=>{p.push(wire(raw));p.finish();},'PROTOCOL_ERROR');
  }
  const p=createCloudChatStreamParserV1(()=>{});expectCode(()=>p.push(new Uint8Array([0xff])),'PROTOCOL_ERROR');
});

test('P5 SSE rejects tool calls, invalid JSON, wrong choice and late content', () => {
  const cases=[event({tool_calls:[{function:{name:'write_file'}}]}), 'data: {bad json}\n\n',event({content:12}), 'data: {"choices":[{"index":1,"delta":{"content":"x"},"finish_reason":null}]}\n\n',event({content:'x'})+event({},'stop')+event({content:'late'}), event({content:'x'})+event({},'stop')+done+event({content:'late'})];
  for(const raw of cases){const p=createCloudChatStreamParserV1(()=>{});expectCode(()=>{p.push(wire(raw));p.finish();},'PROTOCOL_ERROR');}
});

test('P5 SSE reports token cutoff as output limit rather than success', () => {
  const p=createCloudChatStreamParserV1(()=>{});
  expectCode(()=>p.push(wire(event({content:'partial'})+event({},'length')+done)),'OUTPUT_LIMIT');
});

test('P5 SSE rejects incomplete usage metadata', () => {
  const p=createCloudChatStreamParserV1(()=>{});
  expectCode(()=>p.push(wire(event({content:'OK'})+event({},'stop')+'data: {"choices":[],"usage":{"total_tokens":3}}\n\n'+done)),'PROTOCOL_ERROR');
});

test('P5 SSE bounds event bytes and total decoded output', () => {
  const p=createCloudChatStreamParserV1(()=>{});expectCode(()=>p.push(wire('data: '+ 'x'.repeat(65537))),'RESPONSE_LIMIT');
  const q=createCloudChatStreamParserV1(()=>{});expectCode(()=>{for(let i=0;i<5;i++)q.push(wire(event({content:'x'.repeat(16000)})));},'RESPONSE_LIMIT');
});

test('P5 SSE permits comment-only tail, rejects fields and usage after DONE',()=>{
  const raw=event({content:'OK'})+event({},'stop')+done;
  const p=createCloudChatStreamParserV1(()=>{});p.push(wire(raw+': tail heartbeat\n\n'));assert.equal(p.finish().text,'OK');
  for(const tail of ['id: late\n\n','data: {"choices":[]}\n\n',done]){const q=createCloudChatStreamParserV1(()=>{});expectCode(()=>{q.push(wire(raw+tail));q.finish();},'PROTOCOL_ERROR');}
});

test('P5 SSE exact event limit and one-byte overflow, in one or split chunks',()=>{
  const prefix='data: '+JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:null}],padding:''});
  const sized=(n:number)=>prefix.slice(0,-2)+'x'.repeat(n-wire(prefix+'\n\n').length)+prefix.slice(-2)+'\n\n';
  for(const split of [false,true]){
    const p=createCloudChatStreamParserV1(()=>{});const raw=wire(sized(65536));
    if(split){p.push(raw.subarray(0,32768));p.push(raw.subarray(32768));}else p.push(raw);
    p.push(wire(event({},'stop')+done));assert.equal(p.finish().text,'OK');
    const q=createCloudChatStreamParserV1(()=>{});const over=wire(sized(65537));
    expectCode(()=>{q.push(over.subarray(0,32768));q.push(over.subarray(32768));},'RESPONSE_LIMIT');
  }
});

test('P5 SSE rejects chunk count overflow and invalid escaped Unicode',()=>{
  const p=createCloudChatStreamParserV1(()=>{});for(let i=0;i<16384;i++)p.push(new Uint8Array());
  expectCode(()=>p.push(new Uint8Array()),'RESPONSE_LIMIT');
  const q=createCloudChatStreamParserV1(()=>{});expectCode(()=>q.push(wire(event({content:'\ud800'}))),'PROTOCOL_ERROR');
});

test('P5 SSE total response byte and content limits are inclusive',()=>{
  const base=event({content:'OK'})+event({},'stop')+done;
  const sized=(n:number)=>{let tail='';let remaining=n-wire(base).length;while(remaining>0){const length=Math.min(60000,remaining);tail+=':'+'x'.repeat(length-3)+'\n\n';remaining-=length;}return wire(base+tail);};
  for(const n of [524288,524289]){const p=createCloudChatStreamParserV1(()=>{});const bytes=sized(n);const run=()=>{for(let i=0;i<bytes.length;i+=32768)p.push(bytes.subarray(i,i+32768));return p.finish();};if(n===524288)assert.equal(run().text,'OK');else expectCode(run,'RESPONSE_LIMIT');}
  for(const extra of [false,true]){const p=createCloudChatStreamParserV1(()=>{});for(let i=0;i<4;i++)p.push(wire(event({content:'x'.repeat(16384)})));if(extra)expectCode(()=>p.push(wire(event({content:'x'}))),'RESPONSE_LIMIT');else{p.push(wire(event({},'stop')+done));assert.equal(p.finish().text.length,65536);}}
});

test('P5 malformed EOF whitespace tails follow the same rules as completed lines',()=>{
  const base=event({content:'OK'})+event({},'stop')+done;
  for(const tail of [' ','\t','\u00a0','\ufeff'])for(const ending of ['','\n'])for(const split of [false,true]){
    const p=createCloudChatStreamParserV1(()=>{});expectCode(()=>{if(split){p.push(wire(base));const bytes=wire(tail+ending);for(const byte of bytes)p.push(new Uint8Array([byte]));}else p.push(wire(base+tail+ending));p.finish();},'PROTOCOL_ERROR');
  }
  for(const tail of ['', '\r\n', ': heartbeat\n\n',': EOF comment']){const p=createCloudChatStreamParserV1(()=>{});p.push(wire(base+tail));assert.equal(p.finish().text,'OK');}
});

test('P5 pending UTF8 bytes count toward the residual wire-line budget before decoding',()=>{
  const p=createCloudChatStreamParserV1(()=>{});const bytes=wire(':'+'x'.repeat(65535));p.push(bytes.subarray(0,32768));p.push(bytes.subarray(32768));
  expectCode(()=>p.push(new Uint8Array([0xe4])),'RESPONSE_LIMIT');
});
