import test from 'node:test';import assert from 'node:assert/strict';
import {createPilotOracle,createPilotLoopbackServices,pilotNativeQuestionResult,pilotNativeQuestionArguments} from '../apps/desktop/src/main/engine-pilot/loopback-services';
import {parseOpenCodeMessages,createOpenCodePilotEngine} from '../apps/desktop/src/main/engine-pilot/opencode-engine';
import {pilotPrompt} from '../apps/desktop/src/main/engine-pilot/prompt';
import {createOpenCodePilotClient,createPilotSecret} from '../apps/desktop/src/main/engine-pilot/opencode-client';
import type {EngineNotice} from '../apps/desktop/src/main/engine-pilot/engine';
import {executePilotSum} from '../apps/desktop/src/main/engine-pilot/tool';
const body=(goal:string,messages:unknown[]=[])=>({model:'mock',stream:true,tools:['pilot_sum','question'].map(name=>({type:'function',function:{name}})),messages:[{role:'user',content:JSON.stringify({goal,constraint:''})},...messages]});
const assistant=(call:{id:string;name:string;arguments:string})=>({role:'assistant',tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}]});
test('native provider oracle uses variable actual tool values and requires exact result plus call identity before final',async()=>{
  for(const values of [[9,-4,12],[100,-20,-3,8]]){
    const goal=JSON.stringify({scenario:'sum',values});let calls=0;
    const oracle=createPilotOracle({runId:'run',goal,constraint:'',onFailure:()=>{},onTool:async call=>{calls++;return executePilotSum(call.arguments);}});oracle.bindSession('ses_1');
    const issued=oracle.completion(body(goal)).call!;assert.deepEqual(JSON.parse(issued.arguments),{values});
    const result=await oracle.tool({sessionID:'ses_1',messageID:'msg_1',callID:issued.id,toolName:'pilot_sum',arguments:{values}});
    assert.equal(calls,1);assert.equal(result.sum,values.reduce((a,b)=>a+b,0));
    const final=oracle.completion(body(goal,[assistant(issued),{role:'tool',tool_call_id:issued.id,content:JSON.stringify(result)}]));
    assert.ok(final.text?.includes(JSON.stringify(result)));assert.equal(oracle.evidence().sumResultSeen,true);assert.equal(oracle.evidence().attempts,2);
  }
});
test('native question answer changes next tool parameters and must occur in native tool response',async()=>{
  const goal=JSON.stringify({scenario:'question',values:[1,2,3]}),oracle=createPilotOracle({runId:'run',goal,constraint:'',onFailure:()=>{},onTool:async call=>executePilotSum(call.arguments)});oracle.bindSession('ses_1');
  const questionCall=oracle.completion(body(goal)).call!;assert.equal(questionCall.name,'question');oracle.answer('[20,-7,2]');
  const questionResult={role:'tool',tool_call_id:'call_pilot_question',content:pilotNativeQuestionResult('[20,-7,2]')};
  const issued=oracle.completion(body(goal,[assistant(questionCall),questionResult])).call!;assert.deepEqual(JSON.parse(issued.arguments),{values:[20,-7,2]});
  const result=await oracle.tool({sessionID:'ses_1',messageID:'msg_1',callID:issued.id,toolName:'pilot_sum',arguments:JSON.parse(issued.arguments)});
  oracle.completion(body(goal,[assistant(questionCall),questionResult,assistant(issued),{role:'tool',tool_call_id:issued.id,content:JSON.stringify(result)}]));assert.equal(result.sum,15);assert.equal(oracle.evidence().complete,true);assert.equal(oracle.evidence().questionResultSeen,true);
});
test('native oracle rejects invented result, wrong session, missing answer, and attempts over four before body processing',async()=>{
  const goal=JSON.stringify({scenario:'sum',values:[8]}),make=()=>createPilotOracle({runId:'run',goal,constraint:'',onFailure:()=>{},onTool:async call=>executePilotSum(call.arguments)});
  const noTool=make(),unexecuted=noTool.completion(body(goal)).call!;assert.throws(()=>noTool.completion(body(goal,[assistant(unexecuted),{role:'tool',tool_call_id:'call_pilot_sum',content:JSON.stringify(executePilotSum({values:[8]}))}])));
  const altered=make();altered.bindSession('ses_1');const alteredCall=altered.completion(body(goal)).call!;await altered.tool({sessionID:'ses_1',messageID:'msg_1',callID:alteredCall.id,toolName:'pilot_sum',arguments:{values:[8]}});assert.throws(()=>altered.completion(body(goal,[assistant(alteredCall),{role:'tool',tool_call_id:alteredCall.id,content:JSON.stringify(executePilotSum({values:[9]}))}])));
  const foreign=make();foreign.bindSession('ses_1');foreign.completion(body(goal));await assert.rejects(foreign.tool({sessionID:'ses_2',messageID:'msg_1',callID:'call_pilot_sum',toolName:'pilot_sum',arguments:{values:[8]}}));
  const budget=make();for(let i=1;i<=4;i++)assert.equal(budget.admit(),i);assert.throws(()=>budget.admit());assert.equal(budget.evidence().attempts,5);
  const questionGoal=JSON.stringify({scenario:'question',values:[1]}),question=createPilotOracle({runId:'run',goal:questionGoal,constraint:'',onFailure:()=>{},onTool:async call=>executePilotSum(call.arguments)});question.completion(body(questionGoal));question.answer('[2]');assert.throws(()=>question.completion(body(questionGoal,[{role:'tool',tool_call_id:'call_pilot_question',content:'invented answer'}])));
});
test('native snapshot establishes user/assistant/part/session identity and rejects foreign parent or altered user text',()=>{
  const text='fixture',value=[{info:{id:'msg_u',sessionID:'ses_1',role:'user',time:{created:1}},parts:[{id:'prt_u',sessionID:'ses_1',messageID:'msg_u',type:'text',text}]},{info:{id:'msg_a',sessionID:'ses_1',role:'assistant',parentID:'msg_u',agent:'pilot',providerID:'pilot',modelID:'mock',time:{created:2}},parts:[]}];
  assert.equal(parseOpenCodeMessages(value,'ses_1',text).userId,'msg_u');assert.throws(()=>parseOpenCodeMessages(value,'ses_2',text));assert.throws(()=>parseOpenCodeMessages(value,'ses_1','changed'));assert.throws(()=>parseOpenCodeMessages([value[0],{...value[1],info:{...value[1]!.info,parentID:'msg_foreign'}}],'ses_1',text));
});
test('loopback services reject wrong secrets and unknown routes; malformed authenticated provider attempt counts and closes the run',async()=>{
  const service=await createPilotLoopbackServices();let failures=0;const goal=JSON.stringify({scenario:'sum',values:[1]});
  try{
    const oracle=service.begin({runId:'run',goal,constraint:'',onFailure:()=>{failures++;},onTool:async call=>executePilotSum(call.arguments)});
    const base=`http://127.0.0.1:${service.port}`,request=(route:string,token:string,data:string)=>fetch(base+route,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:data});
    assert.equal((await request('/tool','invalid','{}')).status,403);assert.equal((await request('/other',service.toolToken,'{}')).status,403);assert.equal(oracle.evidence().attempts,0);
    assert.equal((await request('/v1/chat/completions',service.providerToken,'{')).status,400);assert.equal(oracle.evidence().attempts,1);assert.ok(failures>0);
  }finally{await service.close();}
});
test('native oracle rejects missing, reordered or altered assistant tool calls and question output with embedded old answer',async()=>{
  for(const mode of ['missing','reordered','altered']){
    const goal=JSON.stringify({scenario:'sum',values:[8]}),oracle=createPilotOracle({runId:'run',goal,constraint:'',onFailure:()=>{},onTool:async call=>executePilotSum(call.arguments)});oracle.bindSession('ses_1');const call=oracle.completion(body(goal)).call!;
    const result=await oracle.tool({sessionID:'ses_1',messageID:'msg_1',callID:call.id,toolName:'pilot_sum',arguments:{values:[8]}}),resultMessage={role:'tool',tool_call_id:call.id,content:JSON.stringify(result)};
    const messages=mode==='missing'?[resultMessage]:mode==='reordered'?[resultMessage,assistant(call)]:[assistant({...call,arguments:'{"values":[9]}'}),resultMessage];assert.throws(()=>oracle.completion(body(goal,messages)));
  }
  const goal=JSON.stringify({scenario:'question',values:[1]}),oracle=createPilotOracle({runId:'run',goal,constraint:'',onFailure:()=>{},onTool:async call=>executePilotSum(call.arguments)});const call=oracle.completion(body(goal)).call!;oracle.answer('[2]');assert.throws(()=>oracle.completion(body(goal,[assistant(call),{role:'tool',tool_call_id:call.id,content:pilotNativeQuestionResult('[999]')+' old answer [2]'}])));
});
test('all authenticated provider routes and methods count before rejection; unbound activity poisons admission',async()=>{
  for(const method of ['GET','POST']){
    const service=await createPilotLoopbackServices();let failures=0;try{const oracle=service.begin({runId:'run',goal:'{"scenario":"sum","values":[1]}',constraint:'',onFailure:()=>{failures++;},onTool:async call=>executePilotSum(call.arguments)});const response=await fetch(`http://127.0.0.1:${service.port}/auxiliary`,{method,headers:{Authorization:`Bearer ${service.providerToken}`}});assert.equal(response.status,403);assert.equal(oracle.evidence().attempts,1);assert.equal(service.traffic().totalProviderAttempts,1);assert.ok(failures>0);}finally{await service.close();}
  }
  const service=await createPilotLoopbackServices();try{await fetch(`http://127.0.0.1:${service.port}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${service.providerToken}`}});assert.equal(service.traffic().unboundProviderAttempts,1);assert.throws(()=>service.begin({runId:'run',goal:'{"scenario":"sum","values":[1]}',constraint:'',onFailure:()=>{},onTool:async call=>executePilotSum(call.arguments)}));}finally{await service.close();}
});
test('native adapter binds tool execution to snapshot and projects terminal only after observed provider result',async()=>{
  const services=await createPilotLoopbackServices(),goal='{"scenario":"sum","values":[31,-8,2]}',events:EngineNotice[]=[];let snapshot:unknown[]=[],toolCalls=0;
  const post=async(route:string,token:string,value:unknown)=>fetch(`http://127.0.0.1:${services.port}${route}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(value)});
  const client={health:async()=>true,createSession:async()=>'ses_1',questions:async()=>[],messages:async()=>JSON.parse(JSON.stringify(snapshot)),answer:async()=>{},abort:async()=>{},dispose(){},
    async prompt(){
      const response=await post('/v1/chat/completions',services.providerToken,body(goal));assert.equal(response.status,200);
      const chunks=(await response.text()).split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
      const call=chunks.flatMap(chunk=>chunk.choices[0].delta.tool_calls??[])[0],args=JSON.parse(call.function.arguments);
      const user={info:{id:'msg_u',sessionID:'ses_1',role:'user',time:{created:1}},parts:[{id:'prt_u',sessionID:'ses_1',messageID:'msg_u',type:'text',text:JSON.stringify({goal,constraint:''})}]};
      const assistantInfo={id:'msg_a',sessionID:'ses_1',role:'assistant',parentID:'msg_u',agent:'pilot',providerID:'pilot',modelID:'mock',time:{created:2}};
      const tool={id:'prt_tool',sessionID:'ses_1',messageID:'msg_a',type:'tool',tool:'pilot_sum',callID:call.id,state:{status:'running',input:args}};
      snapshot=[user,{info:assistantInfo,parts:[{id:'prt_step1',sessionID:'ses_1',messageID:'msg_a',type:'step-start'},tool]}];
      const toolResponse=await post('/tool',services.toolToken,{sessionID:'ses_1',messageID:'msg_a',callID:call.id,toolName:'pilot_sum',arguments:args});assert.equal(toolResponse.status,200);const result=await toolResponse.json();
      const finalResponse=await post('/v1/chat/completions',services.providerToken,body(goal,[{role:'assistant',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:JSON.stringify(result)}]));assert.equal(finalResponse.status,200);await finalResponse.text();
      snapshot=[user,{info:{...assistantInfo,finish:'tool-calls',time:{created:2,completed:3}},parts:[{id:'prt_step1',sessionID:'ses_1',messageID:'msg_a',type:'step-start'},{...tool,state:{status:'completed',input:args,output:JSON.stringify(result)}}]},{info:{...assistantInfo,id:'msg_final',finish:'stop',time:{created:4,completed:5}},parts:[{id:'prt_step2',sessionID:'ses_1',messageID:'msg_final',type:'step-start'},{id:'prt_final',sessionID:'ses_1',messageID:'msg_final',type:'text',text:'Tool sum = 25'}]}];
    },
  };
  const engine=createOpenCodePilotEngine({client,services});
  try{assert.equal(await engine.health(),true);await engine.start({runId:'run',prompt:pilotPrompt(goal,''),signal:new AbortController().signal,callbacks:{notice:event=>events.push(event),tool:async call=>{assert.equal(events[0]?.type,'started');toolCalls++;return executePilotSum(call.arguments);}}});assert.equal(toolCalls,1);assert.deepEqual(events.map(e=>e.type),['started','step','step','text','completed']);assert.equal(services.evidence('run')?.sumResultSeen,true);}finally{engine.dispose();await services.close();}
});
test('native real prompt projection tolerates initial empty user parts and repeated step snapshots without duplicate events',async()=>{
  const services=await createPilotLoopbackServices(),controller=new AbortController(),goal='{"scenario":"sum","values":[7]}',events:EngineNotice[]=[];let snapshots=0,promptCount=0,questionReads=0;
  const user={info:{id:'msg_u',sessionID:'ses_1',role:'user',time:{created:1}},parts:[{id:'prt_u',sessionID:'ses_1',messageID:'msg_u',type:'text',text:JSON.stringify({goal,constraint:''})}]};
  const row={info:{id:'msg_a',sessionID:'ses_1',role:'assistant',parentID:'msg_u',agent:'pilot',providerID:'pilot',modelID:'mock',time:{created:2}},parts:[{id:'prt_step',sessionID:'ses_1',messageID:'msg_a',type:'step-start'}]};
  const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  const client=createOpenCodePilotClient({port:43123,password:createPilotSecret(),directory:'C:/work/analog_ai_workbench/.local/agent-engine-pilot/native/cwd',fetchImpl:async(url,init)=>{
    if(url.endsWith('/session'))return json({id:'ses_1'});
    if(url.endsWith('/prompt_async')){promptCount++;const request=JSON.parse(String(init.body));assert.deepEqual(Object.keys(request).sort(),['agent','model','parts','system']);assert.equal(request.system,pilotPrompt(goal,'').rules);assert.equal(request.parts[0].text,user.parts[0]!.text);return new Response(null,{status:204});}
    if(url.endsWith('/message')){snapshots++;if(snapshots===1){assert.deepEqual(events.map(e=>e.type),['started']);return json([{...user,parts:[]}]);}if(snapshots===4)controller.abort();return json([user,row]);}
    if(url.endsWith('/question')){questionReads++;return json([]);}
    if(url.endsWith('/abort'))return json(true);
    throw Error('Unexpected test route');
  }});
  const engine=createOpenCodePilotEngine({client,services});
  try{await engine.start({runId:'run',prompt:pilotPrompt(goal,''),signal:controller.signal,callbacks:{notice:e=>events.push(e),tool:async()=>{throw Error('No tool expected');}}});assert.equal(promptCount,1);assert.equal(snapshots,4);assert.equal(questionReads,3);assert.deepEqual(events.map(e=>e.type),['started','step']);}finally{engine.dispose();await services.close();}
});
test('native initial user part grace expires and never admits changed text, changed identity or a regressed bound message',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});
  const goal='{"scenario":"sum","values":[7]}',user={info:{id:'msg_u',sessionID:'ses_1',role:'user',time:{created:1}},parts:[{id:'prt_u',sessionID:'ses_1',messageID:'msg_u',type:'text',text:JSON.stringify({goal,constraint:''})}]};
  for(const mode of ['timeout','changed-text','changed-id','regressed']){
    const services=await createPilotLoopbackServices(),events:EngineNotice[]=[];let snapshots=0;
    const client={health:async()=>true,createSession:async()=>'ses_1',prompt:async()=>{},questions:async()=>[],answer:async()=>{},abort:async()=>{},dispose(){},messages:async()=>{
      snapshots++;if(snapshots===1)return [mode==='regressed'?user:{...user,parts:[]}];
      if(mode==='timeout'){t.mock.timers.tick(2000);return [{...user,parts:[]}];}
      if(mode==='changed-id')return [{info:{...user.info,id:'msg_other'},parts:[]}];
      if(mode==='changed-text')return [{...user,parts:[{...user.parts[0],text:'altered'}]}];
      return [{...user,parts:[]}];
    }};
    const engine=createOpenCodePilotEngine({client,services});try{await engine.start({runId:'run',prompt:pilotPrompt(goal,''),signal:new AbortController().signal,callbacks:{notice:e=>events.push(e),tool:async()=>{throw Error('No tool expected');}}});assert.equal(snapshots,2);assert.deepEqual(events.map(e=>e.type),['started','failed']);}finally{engine.dispose();await services.close();}
  }
});

const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
/** Synthetic native server: abort ends the session but deliberately retains its question Deferred. */
async function stopQuestionFixture(){
  const services=await createPilotLoopbackServices(),pending=new Map<string,any>(),rows=new Map<string,unknown[]>(),calls:Array<{route:string;sessionId?:string;questionId?:string}>=[];
  const control:{abortGate?:Promise<void>;abortStatus?:number;rejectStatus?:number;answerStatus?:number;retainRejected?:boolean;onMessage?:(sessionId:string,value:unknown[])=>Promise<unknown[]>}={};
  let sessions=0,oracle:ReturnType<typeof createPilotOracle>|undefined;
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const client=createOpenCodePilotClient({port:43123,password:createPilotSecret(),directory:'C:/work/analog_ai_workbench/.local/agent-engine-pilot/native/cwd',fetchImpl:async(url,init)=>{
    const route=new URL(url).pathname;
    if(route==='/global/health')return json({healthy:true,version:'1.18.17'});
    if(route==='/session'){calls.push({route:'create'});return json({id:`ses_${++sessions}`});}
    const match=/^\/session\/(ses_\d+)\/(prompt_async|message|abort)$/.exec(route);
    if(match){const sessionId=match[1]!;calls.push({route:match[2]!,sessionId});
      if(match[2]==='prompt_async'){
        const request=JSON.parse(String(init.body)),task=JSON.parse(request.parts[0].text),nativeCall=oracle!.completion(body(task.goal)).call!,userId=`msg_user_${sessionId}`,messageID=`msg_assistant_${sessionId}`,questionId=`que_${sessionId}`;
        rows.set(sessionId,[{info:{id:userId,sessionID:sessionId,role:'user',time:{created:1}},parts:[{id:`prt_user_${sessionId}`,sessionID:sessionId,messageID:userId,type:'text',text:request.parts[0].text}]},{info:{id:messageID,sessionID:sessionId,role:'assistant',parentID:userId,agent:'pilot',providerID:'pilot',modelID:'mock',time:{created:2}},parts:[{id:`prt_step_${sessionId}`,sessionID:sessionId,messageID,type:'step-start'},{id:`prt_tool_${sessionId}`,sessionID:sessionId,messageID,type:'tool',callID:nativeCall.id,tool:'question',state:{status:'running',input:JSON.parse(nativeCall.arguments)}}]}]);
        pending.set(questionId,{id:questionId,sessionID:sessionId,questions:pilotNativeQuestionArguments().questions,tool:{messageID,callID:nativeCall.id}});return new Response(null,{status:204});
      }
      if(match[2]==='message'){const value=rows.get(sessionId)??[];return json(control.onMessage?await control.onMessage(sessionId,value):value);}
      if(control.abortGate)await control.abortGate;return json(true,control.abortStatus??200); // Abort deliberately leaves pending intact.
    }
    if(route==='/question'){calls.push({route:'questions'});return json([...pending.values()]);}
    const reply=/^\/question\/(que_ses_\d+)\/reply$/.exec(route);if(reply){calls.push({route:'answer',questionId:reply[1]!});if(control.answerStatus!==undefined)return json(false,control.answerStatus);pending.delete(reply[1]!);return json(true);}
    const reject=/^\/question\/(que_ses_\d+)\/reject$/.exec(route);if(reject){calls.push({route:'reject',questionId:reject[1]!});assert.equal(init.method,'POST');assert.equal(init.body,undefined);if(control.rejectStatus!==undefined)return json(false,control.rejectStatus);if(!control.retainRejected)pending.delete(reject[1]!);return json(true);}
    throw Error('Unexpected native fixture route');
  }});
  const engine=createOpenCodePilotEngine({client,services:{...services,begin:input=>{oracle=services.begin(input);return oracle;}}});
  const start=(id:string)=>{const controller=new AbortController(),events:EngineNotice[]=[],question=deferred<EngineNotice>();const done=engine.start({runId:id,prompt:pilotPrompt('{"scenario":"question","values":[1,2]}',''),signal:controller.signal,callbacks:{notice:event=>{events.push(event);if(event.type==='question'||event.type==='failed')question.resolve(event);},tool:async()=>{throw Error('Question fixture has no sum tool');}}});void done.catch(error=>question.reject(error));void question.promise.catch(()=>{});return {controller,events,question:question.promise,done};};
  return {engine,client,services,pending,calls,control,start,async close(){engine.dispose();await services.close();}};
}
test('native stop question regression: abort200 residual is rejected and same-process next question can start',{timeout:5000},async()=>{
  const fixture=await stopQuestionFixture();try{
    const first=fixture.start('run_1');assert.equal((await first.question).type,'question');first.controller.abort();await fixture.engine.stop('run_1');await first.done;
    const second=fixture.start('run_2');const outcome=await second.question;second.controller.abort();await second.done;
    assert.equal(outcome.type,'question');assert.equal(fixture.pending.size,0);assert.deepEqual(fixture.calls.filter(c=>c.route==='reject').map(c=>c.questionId),['que_ses_1','que_ses_2']);
  }finally{await fixture.close();}
});
test('native cleanup is one shared stop promise and blocks new session/prompt until abort reject confirmation finishes',{timeout:5000},async()=>{
  const fixture=await stopQuestionFixture(),gate=deferred<void>();try{
    const first=fixture.start('run_1');await first.question;fixture.control.abortGate=gate.promise;first.controller.abort();
    const one=fixture.engine.stop('run_1'),two=fixture.engine.stop('run_1');assert.equal(one,two);
    const next=fixture.start('run_2');await new Promise(r=>setTimeout(r,30));assert.equal(fixture.calls.filter(c=>c.route==='prompt_async').length,1);assert.equal(fixture.calls.filter(c=>c.route==='create').length,1);assert.equal(fixture.calls.filter(c=>c.route==='abort').length,1);assert.deepEqual(next.events,[]);
    gate.resolve();await one;await first.done;assert.equal((await next.question).type,'question');
    const rejectIndex=fixture.calls.findIndex(c=>c.route==='reject'),nextCreate=fixture.calls.findIndex((c,i)=>i>0&&c.route==='create');assert.ok(rejectIndex>=0&&nextCreate>rejectIndex);assert.equal(fixture.calls[nextCreate-1]?.route,'questions');
    next.controller.abort();await next.done;
  }finally{gate.resolve();await fixture.close();}
});
test('native cleanup errors poison readiness, surface on stop/start, and never retry or reopen',{timeout:5000},async()=>{
  for(const mode of ['abort-failed','reject-failed','reject-not-found','still-pending']){
    const fixture=await stopQuestionFixture();try{
      const first=fixture.start('run_1');await first.question;
      if(mode==='abort-failed')fixture.control.abortStatus=500;else if(mode==='reject-failed')fixture.control.rejectStatus=500;else if(mode==='reject-not-found')fixture.control.rejectStatus=404;else fixture.control.retainRejected=true;
      first.controller.abort();await assert.rejects(fixture.engine.stop('run_1'),error=>(error as {code?:string}).code==='NATIVE_CLEANUP_FAILED');await assert.rejects(first.done);
      assert.equal(await fixture.engine.health(),false);await assert.rejects(fixture.start('run_2').done);await assert.rejects(fixture.engine.stop('run_1'));
      assert.equal(fixture.calls.filter(c=>c.route==='create').length,1);assert.equal(fixture.calls.filter(c=>c.route==='prompt_async').length,1);assert.equal(fixture.calls.filter(c=>c.route==='abort').length,1);assert.equal(fixture.calls.filter(c=>c.route==='reject').length,mode==='abort-failed'?0:1);
    }finally{await fixture.close();}
  }
});
test('native cleanup validates all identities before any reject and never adopts foreign or unverified own-session questions',{timeout:5000},async()=>{
  for(const mode of ['foreign','unverified-own','changed-message']){
    const fixture=await stopQuestionFixture();try{
      const first=fixture.start('run_1');await first.question;const original=fixture.pending.get('que_ses_1');
      if(mode==='changed-message')fixture.pending.set(original.id,{...original,tool:{...original.tool,messageID:'msg_unverified'}});
      else fixture.pending.set('que_unknown',{...original,id:'que_unknown',sessionID:mode==='foreign'?'ses_foreign':original.sessionID});
      first.controller.abort();await assert.rejects(fixture.engine.stop('run_1'));await assert.rejects(first.done);await assert.rejects(fixture.start('run_2').done);
      assert.equal(fixture.calls.filter(c=>c.route==='reject').length,0);assert.equal(fixture.calls.filter(c=>c.route==='create').length,1);assert.equal(await fixture.engine.health(),false);
    }finally{await fixture.close();}
  }
});
test('native late snapshot from a stopped run cannot deliver into or clear the next run',{timeout:5000},async()=>{
  const fixture=await stopQuestionFixture(),entered=deferred<void>(),late=deferred<unknown[]>();try{
    const first=fixture.start('run_1');await first.question;
    fixture.control.onMessage=async(sessionId,value)=>{if(sessionId==='ses_1'){entered.resolve();return late.promise;}return value;};await entered.promise;
    first.controller.abort();await fixture.engine.stop('run_1');const next=fixture.start('run_2');assert.equal((await next.question).type,'question');
    late.resolve([{info:{role:'assistant'},parts:[{type:'text',text:'late old payload'}]}]);await first.done;
    assert.deepEqual(first.events.map(e=>e.type),['started','step','question']);assert.deepEqual(next.events.map(e=>e.type),['started','step','question']);
    next.controller.abort();await next.done;assert.equal(fixture.pending.size,0);
  }finally{late.resolve([]);await fixture.close();}
});
test('native stop before question tuple verification does not acquire cleanup authority',{timeout:5000},async()=>{
  const fixture=await stopQuestionFixture(),entered=deferred<void>(),late=deferred<unknown[]>();try{
    fixture.control.onMessage=async()=>{entered.resolve();return late.promise;};const first=fixture.start('run_1');await entered.promise;
    first.controller.abort();await assert.rejects(fixture.engine.stop('run_1'));late.resolve([]);await assert.rejects(first.done);
    assert.deepEqual(first.events.map(e=>e.type),['started']);assert.equal(fixture.calls.filter(c=>c.route==='reject').length,0);await assert.rejects(fixture.start('run_2').done);
  }finally{late.resolve([]);await fixture.close();}
});
test('native cleanup deadline blocks further native requests and late abort completion cannot restore readiness',{timeout:5000},async t=>{
  const fixture=await stopQuestionFixture(),gate=deferred<void>();try{
    const first=fixture.start('run_1');await first.question;fixture.control.abortGate=gate.promise;t.mock.timers.enable({apis:['setTimeout']});
    first.controller.abort();const stopping=fixture.engine.stop('run_1');for(let i=0;i<30;i++)await Promise.resolve();assert.equal(fixture.calls.filter(c=>c.route==='abort').length,1);const before=fixture.calls.filter(c=>c.route==='questions').length;
    t.mock.timers.tick(10000);await assert.rejects(stopping,error=>(error as {code?:string}).code==='NATIVE_CLEANUP_FAILED');await assert.rejects(first.done);await assert.rejects(fixture.start('run_2').done);
    gate.resolve();for(let i=0;i<20;i++)await Promise.resolve();assert.equal(fixture.calls.filter(c=>c.route==='questions').length,before);assert.equal(fixture.calls.filter(c=>c.route==='reject').length,0);assert.equal(await fixture.engine.health(),false);
  }finally{gate.resolve();t.mock.timers.reset();await fixture.close();}
});
test('native cleanup never rejects an answered or uncertain-answer question and does not resend its answer',{timeout:5000},async()=>{
  for(const failed of [false,true]){
    const fixture=await stopQuestionFixture();try{
      const first=fixture.start('run_1'),question=await first.question;assert.ok(question.type==='question');if(question.type!=='question')throw Error();
      if(failed)fixture.control.answerStatus=500;const answer=fixture.engine.answer('run_1',question.questionId,'[9]');if(failed)await assert.rejects(answer);else await answer;
      first.controller.abort();if(failed){await assert.rejects(fixture.engine.stop('run_1'));await assert.rejects(first.done);await assert.rejects(fixture.start('run_2').done);}else{await fixture.engine.stop('run_1');await first.done;const next=fixture.start('run_2');assert.equal((await next.question).type,'question');next.controller.abort();await next.done;}
      assert.equal(fixture.calls.filter(c=>c.route==='answer').length,1);assert.equal(fixture.calls.filter(c=>c.route==='reject'&&c.questionId==='que_ses_1').length,0);
    }finally{await fixture.close();}
  }
});
