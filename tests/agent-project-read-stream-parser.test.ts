import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectReadSseParser,parseProjectReadSse,projectReadCanonicalSse,projectReadCanonicalTextSse,ProjectReadProtocolError,type ProjectReadTextDelta} from '../apps/desktop/src/main/agent-project-read/protocol';
import type {ProjectReadModel} from '../apps/desktop/src/shared/agent/agent-project-read';

const kimi:ProjectReadModel={provider:'kimi',model:'kimi-k3'};
const frame=(delta:unknown,finish_reason:string|null=null,extra:object={})=>'data: '+JSON.stringify({id:'stream_parser',choices:[{index:0,delta,finish_reason}],...extra})+'\r\n\r\n';
const ending=frame({},'stop')+'data: [DONE]\r\n\r\n';

test('incremental parser emits only complete validated text frames before finish, across CRLF boundaries',()=>{
  const deltas:ProjectReadTextDelta[]=[],parser=createProjectReadSseParser(8192,kimi,undefined,value=>deltas.push(value));
  const first=frame({role:'assistant',content:'第一段'});
  parser.push(first.slice(0,-1));assert.equal(deltas.length,0);
  parser.push(first.slice(-1));assert.deepEqual(deltas.map(value=>value.text),['第一段']);
  parser.push(frame({content:'第二段'})+ending);
  assert.deepEqual(deltas.map(value=>value.text),['第一段','第二段']);
  assert.equal(parser.finish().text,'第一段第二段');
  assert.throws(()=>parser.push(''),ProjectReadProtocolError);
});

test('incremental and complete parser agree when UTF8 transport splits multibyte characters',()=>{
  const wire=frame({content:'电路🌲'})+ending,bytes=new TextEncoder().encode(wire),decoder=new TextDecoder('utf-8',{fatal:true});
  const deltas:string[]=[],parser=createProjectReadSseParser(8192,kimi,undefined,value=>deltas.push(value.text));
  for(const byte of bytes)parser.push(decoder.decode(new Uint8Array([byte]),{stream:true}));
  parser.push(decoder.decode());assert.deepEqual(parser.finish(),parseProjectReadSse(wire,8192,kimi));assert.equal(deltas.join(''),'电路🌲');
});

test('incremental parser validates every field in a frame before exposing that frame text',()=>{
  const emitted:string[]=[],parser=createProjectReadSseParser(8192,kimi,undefined,value=>emitted.push(value.text));
  assert.throws(()=>parser.push(frame({content:'never shown',tool_calls:[{index:0,type:'function',function:{name:'unknown_tool'}}]})),ProjectReadProtocolError);
  assert.deepEqual(emitted,[]);assert.throws(()=>parser.finish(),ProjectReadProtocolError);
});

test('incremental parser keeps prior text provisional and rejects truncated or malicious suffixes',()=>{
  for(const suffix of ['',frame({},'stop'),'data: [DONE]\n\n',ending+frame({content:'after done'})]){
    const emitted:string[]=[],parser=createProjectReadSseParser(8192,kimi,undefined,value=>emitted.push(value.text));
    parser.push(frame({content:'visible prefix'}));assert.deepEqual(emitted,['visible prefix']);
    assert.throws(()=>{parser.push(suffix);parser.finish();},ProjectReadProtocolError);
  }
});

test('incremental parser never emits reasoning or pending tool arguments',()=>{
  const emitted:string[]=[],parser=createProjectReadSseParser(8192,kimi,undefined,value=>emitted.push(value.text));
  parser.push(frame({reasoning_content:'private',tool_calls:[{index:0,id:'call',type:'function',function:{name:'project_list',arguments:'{"directoryId":null,'}}]}));
  assert.deepEqual(emitted,[]);
  parser.push(frame({tool_calls:[{index:0,function:{arguments:'"cursor":null,"refresh":false}'}}]})+frame({},'tool_calls')+'data: [DONE]\n\n');
  const result=parser.finish();assert.equal(result.calls.length,1);assert.deepEqual(emitted,[]);
});

test('canonical streamed prefix and final suffix form one equivalent validated response without duplicate text',()=>{
  const result=parseProjectReadSse(frame({content:'first second'})+ending,8192,kimi);
  const prefix=projectReadCanonicalTextSse({id:result.id,responseModel:null,text:'first'},kimi);
  const tail=projectReadCanonicalSse(result,kimi,undefined,'first');
  assert.equal(parseProjectReadSse(prefix+tail,8192,kimi).text,'first second');
  const wholePrefix=projectReadCanonicalTextSse({id:result.id,responseModel:null,text:result.text},kimi);
  assert.equal(parseProjectReadSse(wholePrefix+projectReadCanonicalSse(result,kimi,undefined,result.text),8192,kimi).text,result.text);
  assert.throws(()=>projectReadCanonicalSse(result,kimi,undefined,'wrong'),ProjectReadProtocolError);
});
