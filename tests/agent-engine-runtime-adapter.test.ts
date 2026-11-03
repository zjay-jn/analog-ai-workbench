import test from 'node:test';import assert from 'node:assert/strict';
import {createOpenCodePilotClient,createPilotSecret,mapOpenCodeQuestion,createUnreadyOpenCodePilotEngine} from '../apps/desktop/src/main/engine-pilot/opencode-client';
test('pilot OpenCode client restricts endpoints/auth and binds returned native session before prompt',async()=>{
  const calls:Array<{url:string;init:RequestInit}>=[],password=createPilotSecret();
  const client=createOpenCodePilotClient({port:43123,password,directory:'C:/work/analog_ai_workbench/.local/agent-engine-pilot/native/cwd',fetchImpl:async(url,init)=>{calls.push({url,init});return url.endsWith('/session')?new Response(JSON.stringify({id:'ses_native'}),{headers:{'content-type':'application/json'}}):new Response(null,{status:204});}});
  try{await assert.rejects(client.prompt('ses_other',{rules:'rules',goal:'goal',constraint:''}));assert.equal(calls.length,0);const id=await client.createSession();await client.prompt(id,{rules:'fixed',goal:'goal',constraint:''});assert.equal(calls.length,2);assert.ok(calls.every(c=>c.url.startsWith('http://127.0.0.1:43123/')&&c.init.redirect==='error'));assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'),`Basic ${Buffer.from('opencode:'+password).toString('base64')}`);}finally{client.dispose();}
  assert.notEqual(createPilotSecret(),password);assert.equal(await createUnreadyOpenCodePilotEngine().health(),false);
});
test('pilot adapter rejects multi-question native messages instead of dropping user questions',()=>{
  const event={id:'evt_1',type:'question.asked',properties:{id:'q_1',sessionID:'ses_1',questions:[{question:'Clarify?',header:'Task',options:[],custom:true}]}};
  assert.deepEqual(mapOpenCodeQuestion(event,'ses_1'),{type:'question',questionId:'q_1',prompt:'Clarify?'});
  assert.throws(()=>mapOpenCodeQuestion({...event,properties:{...event.properties,questions:[...event.properties.questions,...event.properties.questions]}},'ses_1'));
  assert.throws(()=>mapOpenCodeQuestion(event,'ses_2'));
});
test('pilot native question reject is a fixed main-only POST with no body and requires true acknowledgement',async()=>{
  const calls:Array<{url:string;init:RequestInit}>=[];let answer:unknown=true;
  const client=createOpenCodePilotClient({port:43123,password:createPilotSecret(),directory:'C:/work/analog_ai_workbench/.local/agent-engine-pilot/native/cwd',fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(url.endsWith('/session')?{id:'ses_1'}:answer),{headers:{'content-type':'application/json'}});}});
  try{await assert.rejects(client.reject('ses_foreign','que_1'));assert.equal(calls.length,0);await client.createSession();await assert.rejects(client.reject('ses_1','../reply'));assert.equal(calls.length,1);await client.reject('ses_1','que_1');const call=calls.at(-1)!;assert.equal(call.url,'http://127.0.0.1:43123/question/que_1/reject');assert.equal(call.init.method,'POST');assert.equal(call.init.body,undefined);assert.equal(call.init.redirect,'error');answer=false;await assert.rejects(client.reject('ses_1','que_2'));answer={ok:true};await assert.rejects(client.reject('ses_1','que_3'));}finally{client.dispose();}
});
