import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {OA_READ_TOOL_NAMES} from '../apps/desktop/src/shared/agent/oa-read';

test('OA native wrappers transport oa_read values and allow capture plus confirmed closure time',async()=>{
  const source=fs.readFileSync('tools/agent-project-read-tools.mjs','utf8'),requests:unknown[]=[],timeouts:number[]=[];
  const expected={ok:true,value:{kind:'oa_read',marker:'transport-only; strict contents are validated by main'}};
  const context={TextEncoder,TextDecoder,AbortController,AbortSignal,Object,Array,Reflect,JSON,Number,String,Boolean,RegExp,Set,Map,Promise,performance,
    process:{env:{AAW_PILOT_TOOL_PORT:'43129',AAW_PILOT_TOOL_TOKEN:'a'.repeat(64)}},
    fetch:async(url:string,init:RequestInit)=>{assert.equal(url,'http://127.0.0.1:43129/tool');requests.push(JSON.parse(String(init.body)));return new Response(JSON.stringify(expected),{headers:{'content-type':'application/json'}});},
    setTimeout:(_fn:unknown,ms:number)=>{timeouts.push(ms);return 1;},clearTimeout:()=>{}};
  const create=vm.runInNewContext(source.replace(/^export function createProjectReadNativeTool\(/mu,'function createProjectReadNativeTool(')+'\ncreateProjectReadNativeTool;',context) as (name:string)=>{execute(args:unknown,ctx:unknown):Promise<string>};
  const bound={designHandle:'design-test',savedRevision:'sha256:'+'1'.repeat(64)};
  for(const name of OA_READ_TOOL_NAMES){
    const args=name==='oa_open_design'?{designId:'folded-cascode-copy',refresh:false}:name==='oa_inspect_design'?bound
      :name==='oa_describe_device'?{...bound,instanceId:'i1',section:'parameters',cursor:null}
      :{...bound,selector:{kind:'exact_name',name:'M1'},...(name==='oa_query_nets'?{section:'summary'}:{}),cursor:null};
    const result=await create(name).execute(args,{sessionID:'session',messageID:'message',callID:'call-'+name,abort:new AbortController().signal});
    assert.deepEqual(JSON.parse(result),expected);
  }
  assert.equal(requests.length,5);assert.equal(timeouts[0],135000);assert.deepEqual(timeouts.slice(1),[12000,12000,12000,12000]);
});
