import test from 'node:test';
import assert from 'node:assert/strict';
import { PILOT_VERSION, PILOT_RULES_REVISION, parsePilotRequest, parsePilotResult, parsePilotDisk, parseSumArguments, type PilotDisk } from '../apps/desktop/src/shared/agent/engine-pilot';
import { executePilotSum } from '../apps/desktop/src/main/engine-pilot/tool';
import { createPilotHost } from '../apps/desktop/src/main/engine-pilot/host';
import type { EngineCallbacks, PilotEngine } from '../apps/desktop/src/main/engine-pilot/engine';
import type { PilotStore } from '../apps/desktop/src/main/engine-pilot/store';
import { createOpenCodePilotClient, mapOpenCodeQuestion, OpenCodePilotError } from '../apps/desktop/src/main/engine-pilot/opencode-client';
import { createPilotOracle, createPilotLoopbackServices } from '../apps/desktop/src/main/engine-pilot/loopback-services';
import { request as httpRequest } from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { startOpenCodeSupervisor, OPENCODE_SUPERVISOR_IDENTITY, OpenCodeSupervisorError } from '../apps/desktop/src/main/engine-pilot/opencode-supervisor';
import { createOpenCodePilotEngine } from '../apps/desktop/src/main/engine-pilot/opencode-engine';
import { pilotPrompt } from '../apps/desktop/src/main/engine-pilot/prompt';
import type { PilotLoopbackServices } from '../apps/desktop/src/main/engine-pilot/loopback-services';

const runId='pilot.00000000-0000-4000-8000-000000000001';
const clientRequestId='00000000-0000-4000-8000-000000000002';
const time='2026-09-10T00:00:00.000Z';

test('pilot independent native integration security: real prompt metadata is projected before the exact client boundary',async()=>{
  const prompt=pilotPrompt('{"scenario":"sum","values":[9,-4,12]}','A05 isolated deterministic oracle'),controller=new AbortController(),bodies:unknown[]=[];
  let aborted=false,cleanupQuestionReads=0;
  let signalPrompt!:()=>void;const submitted=new Promise<void>(resolve=>{signalPrompt=resolve;});
  const client=createOpenCodePilotClient({port:43210,password:'e'.repeat(64),directory:'C:/work/analog_ai_workbench/.local/agent-engine-pilot/security-memory-only',fetchImpl:async(url,init)=>{
    const route=new URL(url).pathname;
    if(route==='/session')return Response.json({id:'session-integration'});
    if(route==='/session/session-integration/prompt_async'){bodies.push(JSON.parse(String(init.body)));signalPrompt();return new Response(null,{status:204});}
    if(route==='/session/session-integration/message')return Response.json([]);
    if(route==='/session/session-integration/abort'){aborted=true;return Response.json(true);}
    if(route==='/question'){assert.equal(aborted,true,'An unbound user cannot cause a projection question read');cleanupQuestionReads++;return Response.json([]);}
    throw Error('Unexpected synthetic route');
  }});
  const services:PilotLoopbackServices={port:43211,providerToken:'a'.repeat(64),toolToken:'b'.repeat(64),begin:input=>createPilotOracle(input),end(){},evidence:()=>null,traffic:()=>({totalProviderAttempts:0,unboundProviderAttempts:0,poisoned:false}),async close(){}};
  const engine=createOpenCodePilotEngine({client,services}),notices:string[]=[];
  const running=engine.start({runId,prompt,signal:controller.signal,callbacks:{notice:event=>{notices.push(event.type);},tool:async()=>{throw Error('No tool requested in transport fixture');}}});
  try{
    assert.equal(await Promise.race([submitted.then(()=>true),running.then(()=>false)]),true);
    assert.equal(bodies.length,1);const body=bodies[0] as {system:string;parts:Array<{type:string;text:string}>};
    assert.equal(body.system,prompt.rules);assert.deepEqual(body.parts,[{type:'text',text:JSON.stringify({goal:prompt.goal,constraint:prompt.constraint})}]);
    assert.ok(!notices.includes('failed'));assert.equal(prompt.rulesRevision,'pilot-rules-1');
    // Four-field internal metadata remains forbidden if passed directly to the three-field HTTP API.
    await assert.rejects(client.prompt('session-integration',prompt));assert.equal(bodies.length,1);
  }finally{controller.abort();try{await running;assert.equal(cleanupQuestionReads,1,'Stop checks the empty pending list once');}finally{engine.dispose();}}
});

test('pilot independent snapshot security: incomplete user identity cannot disappear, change, authorize an assistant or renew its grace',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});
  const prompt=pilotPrompt('{"scenario":"sum","values":[9,-4,12]}','snapshot security fixture');
  const user={info:{id:'user-security',sessionID:'session-security',role:'user',time:{created:1}},parts:[{id:'part-user-security',sessionID:'session-security',messageID:'user-security',type:'text',text:JSON.stringify({goal:prompt.goal,constraint:prompt.constraint})}]};
  for(const mode of ['disappears','changed-complete-id','early-assistant','renewed-grace'] as const){
    let reads=0,projectionQuestionReads=0,cleanupQuestionReads=0,toolCalls=0,aborted=false;const notices:string[]=[],controller=new AbortController();
    const client={health:async()=>true,createSession:async()=>'session-security',prompt:async()=>{},answer:async()=>{},abort:async()=>{aborted=true;},dispose(){},questions:async()=>{if(aborted)cleanupQuestionReads++;else projectionQuestionReads++;return [];},messages:async()=>{
      reads++;if(reads===1)return [{...user,parts:[]}];
      if(mode==='disappears')return [];
      if(mode==='changed-complete-id')return [{info:{...user.info,id:'changed-user'},parts:[{...user.parts[0],messageID:'changed-user'}]}];
      if(mode==='early-assistant')return [{...user,parts:[]},{info:{id:'assistant-security',sessionID:'session-security',role:'assistant',parentID:user.info.id,agent:'pilot',providerID:'pilot',modelID:'mock',time:{created:2}},parts:[{id:'part-step-security',sessionID:'session-security',messageID:'assistant-security',type:'step-start'}]}];
      if(reads>3)throw Error('Unexpected grace renewal');
      t.mock.timers.tick(reads===2?1500:600);return [{...user,parts:[]}];
    }};
    const services:PilotLoopbackServices={port:43211,providerToken:'a'.repeat(64),toolToken:'b'.repeat(64),begin:input=>createPilotOracle(input),end(){},evidence:()=>null,traffic:()=>({totalProviderAttempts:0,unboundProviderAttempts:0,poisoned:false}),async close(){}};
    const engine=createOpenCodePilotEngine({client,services});
    try{
      await engine.start({runId,prompt,signal:controller.signal,callbacks:{notice:event=>notices.push(event.type),tool:async()=>{toolCalls++;throw Error('Unbound user cannot authorize a tool');}}});
      assert.equal(reads,mode==='renewed-grace'?3:2,mode);assert.deepEqual(notices,['started','failed'],mode);assert.equal(projectionQuestionReads,0,mode);assert.equal(cleanupQuestionReads,1,mode);assert.equal(toolCalls,0,mode);
    }finally{controller.abort();engine.dispose();}
  }
});

test('pilot independent native cleanup security: complete verified tuples and the whole list are required before reject',{timeout:5000},async()=>{
  for(const mode of ['owned','foreign-tail','unverified-tail','duplicate-id','changed-message','changed-call','changed-questions','malformed-tail','over-limit'] as const){
    const prompt=pilotPrompt('{"scenario":"question","values":[40,2]}','independent tuple boundary'),sessionID='session-tuple-security',messageID='assistant-tuple-security',questionID='que_tuple_security';
    const questions=[{question:'请输入新的整数数组（JSON），它将成为下一次求和的实际参数。',header:'求和参数',options:[],multiple:false}];
    const known={id:questionID,sessionID,questions,tool:{messageID,callID:'call_pilot_question'}};
    let pending:unknown[]=[structuredClone(known)],created=0,aborts=0,questionReads=0;
    const rejected:Array<{sessionID:string;questionID:string}>=[],notices:string[]=[],controller=new AbortController();
    let signalQuestion!:()=>void;const questionSeen=new Promise<void>(resolve=>{signalQuestion=resolve;});
    const client={health:async()=>true,createSession:async()=>{created++;return sessionID;},prompt:async()=>{},answer:async()=>{throw Error('No answer is authorized in this fixture');},
      messages:async()=>[
        {info:{id:'user-tuple-security',sessionID,role:'user',time:{created:1}},parts:[{id:'part-user-tuple-security',sessionID,messageID:'user-tuple-security',type:'text',text:JSON.stringify({goal:prompt.goal,constraint:prompt.constraint})}]},
        {info:{id:messageID,sessionID,role:'assistant',parentID:'user-tuple-security',agent:'pilot',providerID:'pilot',modelID:'mock',time:{created:2}},parts:[{id:'part-question-tuple-security',sessionID,messageID,type:'tool',tool:'question',callID:'call_pilot_question',state:{status:'running',input:{questions}}}]},
      ],questions:async()=>{questionReads++;return structuredClone(pending);},abort:async()=>{aborts++;},
      reject:async(s:string,q:string)=>{rejected.push({sessionID:s,questionID:q});pending=[];},dispose(){}};
    const services:PilotLoopbackServices={port:43211,providerToken:'a'.repeat(64),toolToken:'b'.repeat(64),begin:input=>createPilotOracle(input),end(){},evidence:()=>null,traffic:()=>({totalProviderAttempts:0,unboundProviderAttempts:0,poisoned:false}),async close(){}};
    const engine=createOpenCodePilotEngine({client,services});
    const input={runId,prompt,signal:controller.signal,callbacks:{notice:(event:Parameters<EngineCallbacks['notice']>[0])=>{notices.push(event.type);if(event.type==='question')signalQuestion();},tool:async()=>{throw Error('Cleanup cannot execute a sum');}}};
    const running=engine.start(input),settled=running.then(()=>({ok:true as const}),error=>({ok:false as const,error: error as unknown}));
    try{
      await Promise.race([questionSeen,settled.then(()=>{throw Error('Fixture ended before a verified question');})]);
      assert.deepEqual(notices,['started','question'],mode);assert.equal(questionReads,1,mode);
      if(mode==='foreign-tail')pending=[known,{...known,id:'que_foreign',sessionID:'session-foreign'}];
      else if(mode==='unverified-tail')pending=[known,{...known,id:'que_unverified'}];
      else if(mode==='duplicate-id')pending=[known,structuredClone(known)];
      else if(mode==='changed-message')pending=[{...known,tool:{...known.tool,messageID:'assistant-other'}}];
      else if(mode==='changed-call')pending=[{...known,tool:{...known.tool,callID:'call_other'}}];
      else if(mode==='changed-questions')pending=[{...known,questions:[{...questions[0]!,question:'Changed prompt'}]}];
      else if(mode==='malformed-tail')pending=[known,{id:'que_malformed',sessionID,questions}];
      else if(mode==='over-limit')pending=[known,...Array.from({length:4},(_,i)=>({...known,id:'que_extra_'+i}))];
      controller.abort();
      if(mode==='owned'){
        await engine.stop(runId);assert.equal((await settled).ok,true);
        assert.deepEqual(rejected,[{sessionID,questionID}]);assert.equal(questionReads,3,'Projection, cleanup list, then empty-list confirmation');assert.equal(await engine.health(),true);
      }else{
        await assert.rejects(engine.stop(runId),error=>error instanceof OpenCodePilotError&&(error as {code?:string}).code==='NATIVE_CLEANUP_FAILED');
        assert.equal((await settled).ok,false);assert.deepEqual(rejected,[],'No prefix of an invalid list may be rejected');assert.equal(questionReads,2,mode);
        assert.equal(await engine.health(),false);await assert.rejects(engine.start({...input,runId:'pilot.00000000-0000-4000-8000-000000000003',signal:new AbortController().signal}));assert.equal(created,1);
      }
      assert.equal(aborts,1,mode);assert.deepEqual(notices,['started','question'],mode);
    }finally{controller.abort();await engine.stop(runId).catch(()=>{});await settled;engine.dispose();}
  }
});

test('pilot independent native reject security: fixed bodyless transport and strict acknowledgement cannot expand authority',async()=>{
  const calls:Array<{url:string;init:RequestInit}>=[];let status=200,response:unknown=true;
  const password='d'.repeat(64),client=createOpenCodePilotClient({port:43210,password,directory:'C:/work/analog_ai_workbench/.local/agent-engine-pilot/security-memory-only',fetchImpl:async(url,init)=>{
    calls.push({url,init});return url.endsWith('/session')?Response.json({id:'session-reject-security'}):Response.json(response,{status});
  }});
  try{
    await assert.rejects(client.reject('session-reject-security','que_security'));assert.equal(calls.length,0);
    const session=await client.createSession();
    for(const id of ['../reply','que%2fother','que?redirect=x','que\nheader','问题','x'.repeat(129)])await assert.rejects(client.reject(session,id));
    await assert.rejects(client.reject('foreign-session','que_security'));assert.equal(calls.length,1);
    await client.reject(session,'que_security');const actual=calls.at(-1)!;
    assert.equal(actual.url,'http://127.0.0.1:43210/question/que_security/reject');assert.equal(actual.init.method,'POST');assert.equal(actual.init.body,undefined);assert.equal(actual.init.redirect,'error');
    const headers=new Headers(actual.init.headers);assert.equal(headers.has('Content-Type'),false);assert.equal(headers.get('Authorization'),`Basic ${Buffer.from('opencode:'+password).toString('base64')}`);
    for(const value of [false,1,'true',null,{ok:true}]){response=value;await assert.rejects(client.reject(session,'que_security'),OpenCodePilotError);}
    response=true;status=404;await assert.rejects(client.reject(session,'que_security'),OpenCodePilotError);
    const count=calls.length;client.dispose();await assert.rejects(client.reject(session,'que_security'));assert.equal(calls.length,count);
  }finally{client.dispose();}
});

// Synthetic IO for lifecycle/admission faults; no file creation, socket binding, candidate execution or hash claim.
function independentSupervisorFixture(t:TestContext,options:{noPidError?:boolean;extraTool?:boolean;hardLinkedTool?:boolean}={}){
  const identity=OPENCODE_SUPERVISOR_IDENTITY,files=new Map<string,string>(),directories=new Set<string>();let spawns=0,kills=0;
  const key=(value:unknown)=>path.resolve(String(value));
  const child=Object.assign(new EventEmitter(),{pid:options.noPidError?undefined:54321,exitCode:null as number|null,signalCode:null as string|null,kill(){kills++;queueMicrotask(()=>child.emit('exit',null,'SIGTERM'));return true;}});
  t.mock.method(fs,'lstatSync',(value:unknown)=>{const name=key(value),regular=name===identity.executable||name===identity.toolSource||files.has(name);return {isFile:()=>regular,isDirectory:()=>!regular,isSymbolicLink:()=>false,nlink:options.hardLinkedTool&&name===identity.toolSource?2:1,size:name===identity.executable?identity.executableBytes:name===identity.toolSource||files.get(name)==='synthetic-tool'?identity.toolBytes:Buffer.byteLength(files.get(name)??''),dev:1,ino:name,mtimeMs:1,ctimeMs:1};});
  t.mock.method(fs,'realpathSync',key);
  t.mock.method(fs,'mkdirSync',(value:unknown)=>{const name=key(value);if(directories.has(name))throw Object.assign(Error(),{code:'EEXIST'});directories.add(name);});
  t.mock.method(fs,'writeFileSync',(value:unknown,contents:unknown)=>{files.set(key(value),String(contents));});
  t.mock.method(fs,'readFileSync',(value:unknown)=>Buffer.from(key(value)===identity.executable?'synthetic-exe':key(value)===identity.toolSource?'synthetic-tool':files.get(key(value))??''));
  t.mock.method(fs,'readdirSync',(value:unknown)=>{const prefix=key(value)+path.sep,names=[...new Set([...directories,...files.keys()].filter(p=>p.startsWith(prefix)).map(p=>p.slice(prefix.length).split(path.sep)[0]))];if(options.extraTool&&path.basename(key(value))==='tools')names.push('unreviewed.js');return names;});
  t.mock.method(crypto,'createHash',()=>{let content='';const hash={update(value:Uint8Array){content+=Buffer.from(value).toString();return hash;},digest(){return content==='synthetic-exe'?identity.executableSha256:identity.toolSha256;}};return hash;});
  t.mock.method(net,'createServer',()=>{const server=Object.assign(new EventEmitter(),{listen(_port:number,_host:string,callback:()=>void){queueMicrotask(callback);return server;},address(){return {port:43212,address:'127.0.0.1',family:'IPv4'};},close(callback:()=>void){queueMicrotask(callback);return server;}});return server;});
  t.mock.method(childProcess,'spawn',()=>{spawns++;if(options.noPidError)queueMicrotask(()=>{child.emit('error',Error('synthetic spawn failed'));child.emit('close',-4058,null);});return child;});
  t.mock.method(globalThis,'fetch',async()=>Response.json({healthy:true,version:identity.version}));
  return {child,counts:()=>({spawns,kills})};
}
const syntheticServices={port:43211,providerToken:'c'.repeat(64),toolToken:'d'.repeat(64)};

test('pilot independent supervisor security: failed spawn without a PID is not an unconfirmed live process',async t=>{
  const f=independentSupervisorFixture(t,{noPidError:true});t.mock.timers.enable({apis:['setTimeout','Date']});
  try{
    const attempt=startOpenCodeSupervisor({services:syntheticServices}).then(()=>null,error=>error as unknown);
    await setImmediate();t.mock.timers.tick(3001);await setImmediate();const error=await attempt;
    assert.ok(error instanceof OpenCodeSupervisorError);assert.equal(error.code,'START_FAILED');assert.equal(f.counts().kills,0);
    const second=startOpenCodeSupervisor({services:syntheticServices}).then(()=>null,error=>error as unknown);
    await setImmediate();t.mock.timers.tick(3001);await setImmediate();const next=await second;
    assert.ok(next instanceof OpenCodeSupervisorError);assert.equal(next.code,'START_FAILED');assert.equal(f.counts().spawns,2);
  }finally{f.child.emit('exit',-4058,null);}
});

for(const [name,options] of [['additional module',{extraTool:true}],['hard-linked source module',{hardLinkedTool:true}]] as const){
  test(`pilot independent supervisor security: ${name} is rejected before spawn`,async t=>{
    const f=independentSupervisorFixture(t,options);
    await assert.rejects(startOpenCodeSupervisor({services:syntheticServices}),error=>error instanceof OpenCodeSupervisorError&&error.code==='IDENTITY_MISMATCH');
    assert.equal(f.counts().spawns,0);
  });
}

test('pilot independent loopback authentication security: non-ASCII equal-character-length authorization is safely rejected',async()=>{
  const services=await createPilotLoopbackServices();
  const send=(authorization:string)=>new Promise<number>((resolve,reject)=>{
    const request=httpRequest({hostname:'127.0.0.1',port:services.port,path:'/tool',method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode??0));});
    request.on('error',reject);request.setTimeout(1500,()=>request.destroy(Error('Synthetic request timed out')));request.end('{}');
  });
  try{
    assert.equal(await send(`Bearer ${'é'.repeat(64)}`),403);
    assert.equal(await send('Bearer wrong'),403);
  }finally{await services.close();}
});

test('pilot independent native oracle security: cached tool result remains bound to its original message',async()=>{
  const goal=JSON.stringify({scenario:'sum',values:[2,3]});let calls=0,failures=0;
  const oracle=createPilotOracle({runId,goal,constraint:'',onTool:async call=>{calls++;return executePilotSum(call.arguments);},onFailure:()=>{failures++;}});
  try{
    oracle.bindSession('session-1');
    oracle.completion({model:'mock',stream:true,messages:[{role:'user',content:JSON.stringify({goal,constraint:''})}],tools:['pilot_sum','question'].map(name=>({type:'function',function:{name}}))});
    const request={sessionID:'session-1',messageID:'message-1',callID:'call_pilot_sum',toolName:'pilot_sum',arguments:{values:[2,3]}};
    assert.equal((await oracle.tool(request)).sum,5);assert.equal((await oracle.tool(request)).sum,5);assert.equal(calls,1);
    await assert.rejects(oracle.tool({...request,messageID:'foreign-message'}));assert.equal(calls,1);assert.ok(failures>0);
  }finally{oracle.close();}
});

test('pilot independent native client security: concurrent admission rejects request 33 before transport',async()=>{
  let calls=0;const releases:Array<()=>void>=[];
  const client=createOpenCodePilotClient({port:32123,password:'a'.repeat(64),directory:'C:/work/analog_ai_workbench/.local/agent-engine-pilot/security-memory-only',
    fetchImpl:async()=>{const id=`session-${++calls}`;await new Promise<void>(resolve=>releases.push(resolve));return Response.json({id});}});
  try{
    const pending=Array.from({length:32},()=>client.createSession());
    await assert.rejects(client.createSession(),OpenCodePilotError);assert.equal(calls,32);
    releases.forEach(release=>release());assert.equal(new Set(await Promise.all(pending)).size,32);
    await assert.rejects(client.createSession(),OpenCodePilotError);assert.equal(calls,32);
    client.dispose();await assert.rejects(client.createSession(),OpenCodePilotError);assert.equal(calls,32);
  }finally{releases.forEach(release=>release());client.dispose();}
});

test('pilot independent native client security: fixed routes and credentials never become an arbitrary request API',async()=>{
  const requests:Array<{url:string;init:RequestInit}>=[];let fail=false;
  const password='b'.repeat(64),directory='C:/work/analog_ai_workbench/.local/agent-engine-pilot/security-memory-only';
  const client=createOpenCodePilotClient({port:32123,password,directory,fetchImpl:async(url,init)=>{
    requests.push({url,init});if(fail)throw Error(`untrusted error ${password}`);
    return url.endsWith('/prompt_async')?new Response(null,{status:204}):Response.json({id:'session-1'});
  }});
  try{
    await assert.rejects(client.messages('foreign-session'));await assert.rejects(client.answer('foreign-session','q-1','yes'));assert.equal(requests.length,0);
    const id=await client.createSession();await client.prompt(id,{rules:'synthetic rule',goal:'sum',constraint:''});
    assert.deepEqual(requests.map(r=>r.url),['http://127.0.0.1:32123/session','http://127.0.0.1:32123/session/session-1/prompt_async']);
    for(const request of requests){assert.equal(request.init.redirect,'error');assert.equal(new Headers(request.init.headers).get('Authorization'),`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);assert.ok(!request.url.includes(password));}
    assert.deepEqual(JSON.parse(String(requests[1]!.init.body)).model,{providerID:'pilot',modelID:'mock'});
    fail=true;await assert.rejects(client.messages(id),(error:unknown)=>error instanceof OpenCodePilotError&&error.message==='OpenCode pilot unavailable'&&!error.message.includes(password));
    client.dispose();const count=requests.length;await assert.rejects(client.messages(id));assert.equal(requests.length,count);
  }finally{client.dispose();}
});

test('pilot independent native client security: questions preserve identity and reject unsupported meaning',()=>{
  const question={question:'Continue?',options:[],custom:true,multiple:false};
  const event={type:'question.asked',properties:{id:'q-1',sessionID:'session-1',questions:[question]}};
  assert.deepEqual(mapOpenCodeQuestion(event,'session-1'),{type:'question',questionId:'q-1',prompt:'Continue?'});
  assert.throws(()=>mapOpenCodeQuestion(event,'foreign-session'));
  for(const questions of [[question,question],[{...question,multiple:true}],[{...question,custom:false}],[{...question,options:[{label:'yes',description:'continue'}]}]])assert.throws(()=>mapOpenCodeQuestion({...event,properties:{...event.properties,questions}},'session-1'));
});

test('pilot independent security: requests reject executable properties and identity extensions without invocation',()=>{
  let invoked=0;
  const request={contractVersion:PILOT_VERSION,clientRequestId,goal:'sum fixture',constraint:''};
  assert.deepEqual(parsePilotRequest('startRun',request),request);
  const accessor={...request};
  Object.defineProperty(accessor,'goal',{enumerable:true,get(){invoked++;return 'sum fixture';}});
  assert.throws(()=>parsePilotRequest('startRun',accessor));
  assert.equal(invoked,0);
  assert.throws(()=>parsePilotRequest('startRun',{...request,[Symbol('extra')]:true}));
  assert.throws(()=>parsePilotRequest('startRun',Object.assign(Object.create({authority:'allow'}),request)));
  assert.throws(()=>parsePilotRequest('readRun',{contractVersion:PILOT_VERSION,runId,afterSequence:-0}));
  assert.throws(()=>parsePilotRequest('startRun',{...request,goal:'\uD800'}));
});

test('pilot independent security: capability validation rejects toJSON hooks without executing them',()=>{
  let invoked=0;
  const result={ok:true,value:{engineKind:'fake',engineVersion:'test',ready:true,capabilities:['pilot.sum.v1'],maxRuns:32}};
  assert.equal(parsePilotResult('getStatus',result).ok,true);
  const hostile={...result,value:{...result.value,capabilities:[{toJSON(){invoked++;return 'pilot.sum.v1';}}]}};
  assert.throws(()=>parsePilotResult('getStatus',hostile));
  assert.equal(invoked,0,'Parsing a capability must never run data-supplied serialization code');
});

test('pilot independent security: deterministic tool cannot accept executable arrays or expanded capabilities',()=>{
  assert.deepEqual(executePilotSum({values:[1000000,-1000000,4]}),{sum:4,count:3,source:'deterministic-local',toolVersion:'pilot.sum.v1'});
  let invoked=0;
  const values:number[]=[];
  Object.defineProperty(values,'0',{enumerable:true,get(){invoked++;return 1;}});
  assert.throws(()=>executePilotSum({values}));
  assert.equal(invoked,0);
  for(const bad of [{values:[1],path:'fixture'},{values:[]},{values:[NaN]},{values:[Infinity]},{values:[-0]},{values:[1000001]},{values:new Array(33).fill(1)},{values:[1.5]}]) assert.throws(()=>executePilotSum(bad));
  const input={values:[2,3]};const parsed=parseSumArguments(input);input.values[0]=100;
  assert.deepEqual(parsed.values,[2,3]);
  assert.ok(Object.isFrozen(parsed.values));
});

test('pilot independent security: persisted success cannot fabricate tool result or hide pending work',()=>{
  const events=(rows:readonly {type:string;data:unknown}[])=>rows.map((row,i)=>({runId,sequence:i+1,time,...row}));
  const base=[
    {type:'run.accepted',data:{goal:'sum fixture',constraint:'',engineKind:'fake',engineVersion:'test',rulesRevision:PILOT_RULES_REVISION}},
    {type:'engine.started',data:{sessionId:'session-1'}},
    {type:'model.step',data:{step:1,usage:null}},
    {type:'tool.started',data:{callId:'call-1',toolName:'pilot.sum.v1',arguments:{values:[2,3]}}},
  ];
  const result={type:'tool.completed',data:{callId:'call-1',result:{sum:5,count:2,source:'deterministic-local',toolVersion:'pilot.sum.v1'}}};
  const finish=[{type:'message.delta',data:{text:'Result: 5'}},{type:'run.completed',data:{}}];
  const disk=(rows:readonly {type:string;data:unknown}[])=>({version:1,runs:[{runId,clientRequestId,goal:'sum fixture',constraint:'',status:'completed',createdAt:time,updatedAt:time,engineKind:'fake',engineVersion:'test',events:events(rows)}]});
  assert.equal(parsePilotDisk(disk([...base,result,...finish])).runs[0]?.status,'completed');
  assert.throws(()=>parsePilotDisk(disk([...base,{...result,data:{...result.data,result:{...result.data.result,sum:6}}},...finish])));
  assert.throws(()=>parsePilotDisk(disk([...base,...finish])));
  assert.throws(()=>parsePilotDisk(disk([...base,result,{type:'question.asked',data:{questionId:'q-1',prompt:'continue?'}},...finish])));
  assert.throws(()=>parsePilotDisk(disk([...base,result,...finish,{type:'message.delta',data:{text:'late'}}])));
});

const owner={senderId:1,isTopFrame:true,appOrigin:'app://pilot',navigationEpoch:1,appSessionId:'security-session',windowId:'security-window',webContentsId:1,workspaceId:'synthetic',rootId:'synthetic'};
function hostFixture(initial: PilotDisk={version:1,runs:[]},deadlineMs=120000) {
  let disk=parsePilotDisk(initial), callbacks:EngineCallbacks|undefined, settle:(()=>void)|undefined;
  let failType:string|undefined,starts=0,answers=0,acceptedBeforeStart=false,resultSavedBeforeReturn=false;
  const store:PilotStore={load:()=>disk,save(value){if(value.runs.some(r=>r.events.at(-1)?.type===failType))throw new Error('synthetic storage failure');disk=parsePilotDisk(value);},close(){}};
  const engine:PilotEngine={kind:'fake',version:'security-controlled',health:async()=>true,
    start(input){starts++;acceptedBeforeStart=disk.runs.some(r=>r.runId===input.runId&&r.events[0]?.type==='run.accepted');callbacks=input.callbacks;callbacks.notice({type:'started',sessionId:'native-session'});return new Promise<void>(resolve=>{settle=resolve;});},
    async answer(){answers++;assert.equal(disk.runs.at(-1)?.events.at(-1)?.type,'question.answered');},
    async stop(){settle?.();},dispose(){settle?.();},
  };
  const host=createPilotHost({owner,engine,store,deadlineMs,waitMs:1000});
  return {host,disk:()=>disk,setFailure:(type:string)=>{failType=type;},counts:()=>({starts,answers,acceptedBeforeStart,resultSavedBeforeReturn}),callbacks:()=>{assert.ok(callbacks);return callbacks;},
    async start(){await host.initialization;const response=parsePilotResult('startRun',await host.invoke('startRun',owner,{contractVersion:PILOT_VERSION,clientRequestId,goal:'sum fixture',constraint:''}));assert.ok(response.ok);await Promise.resolve();return response.value.runId;},
    async sum(callId:string,values:readonly number[]=[2,3]){const result=await this.callbacks().tool({sessionId:'native-session',callId,toolName:'pilot.sum.v1',arguments:{values}});resultSavedBeforeReturn=disk.runs.at(-1)!.events.some(e=>e.type==='tool.completed'&&e.data.callId===callId);return result;},
  };
}

test('pilot independent host security: durable acceptance and results precede dispatch, replay is scoped',async()=>{
  const f=hostFixture();try{
    const id=await f.start();assert.ok(f.counts().acceptedBeforeStart);
    const replay=await f.host.invoke('startRun',owner,{contractVersion:PILOT_VERSION,clientRequestId,goal:'sum fixture',constraint:''});
    assert.deepEqual(replay,{ok:true,value:{runId:id}});assert.equal(f.counts().starts,1);
    assert.deepEqual(await f.host.invoke('readRun',{...owner,windowId:'foreign'},{contractVersion:PILOT_VERSION,runId:id,afterSequence:0}),{ok:false,error:{code:'CAPABILITY_DENIED'}});
    assert.equal((await f.sum('call-1')).sum,5);assert.ok(f.counts().resultSavedBeforeReturn);
    const count=f.disk().runs[0]!.events.length;assert.equal((await f.sum('call-1')).sum,5);assert.equal(f.disk().runs[0]!.events.length,count);
    await assert.rejects(f.sum('call-1',[100]));assert.equal(f.disk().runs[0]!.status,'failed');
  }finally{f.host.revoke();}
});

test('pilot independent host security: persistence failures prohibit start, answer and result delivery',async()=>{
  const first=hostFixture();try{
    first.setFailure('run.accepted');await first.host.initialization;
    assert.deepEqual(await first.host.invoke('startRun',owner,{contractVersion:PILOT_VERSION,clientRequestId,goal:'sum fixture',constraint:''}),{ok:false,error:{code:'STORAGE_FAILED'}});
    assert.equal(first.counts().starts,0);
  }finally{first.host.revoke();}
  const second=hostFixture();try{
    const id=await second.start();second.callbacks().notice({type:'question',questionId:'q-1',prompt:'Continue?'});second.setFailure('question.answered');
    assert.deepEqual(await second.host.invoke('answerQuestion',owner,{contractVersion:PILOT_VERSION,runId:id,questionId:'q-1',answer:'yes'}),{ok:false,error:{code:'STORAGE_FAILED'}});
    assert.equal(second.counts().answers,0);assert.equal(second.host.snapshot().active,null);
  }finally{second.host.revoke();}
  const third=hostFixture();try{
    await third.start();third.setFailure('tool.completed');await assert.rejects(third.sum('call-1'));
    assert.ok(third.host.snapshot().storageFailed);assert.equal(third.counts().resultSavedBeforeReturn,false);
  }finally{third.host.revoke();}
});

test('pilot independent host security: stop rejects late callbacks and restart never replays',async()=>{
  const f=hostFixture();let interruptedInput:PilotDisk;
  try{
    const id=await f.start();interruptedInput=f.disk();const callbacks=f.callbacks();
    assert.deepEqual(await f.host.invoke('stopRun',owner,{contractVersion:PILOT_VERSION,runId:id}),{ok:true,value:{status:'stopped'}});
    const before=JSON.stringify(f.disk());callbacks.notice({type:'text',text:'late success'});callbacks.notice({type:'completed'});
    await assert.rejects(callbacks.tool({sessionId:'native-session',callId:'late',toolName:'pilot.sum.v1',arguments:{values:[1]}}));
    assert.equal(JSON.stringify(f.disk()),before);
    f.host.revoke();assert.deepEqual(await f.host.invoke('getStatus',owner,{contractVersion:PILOT_VERSION}),{ok:false,error:{code:'CAPABILITY_DENIED'}});
  }finally{f.host.revoke();}
  const restarted=hostFixture(interruptedInput!);try{
    await restarted.host.initialization;assert.equal(restarted.disk().runs[0]!.status,'interrupted');assert.equal(restarted.disk().runs[0]!.events.at(-1)?.type,'run.interrupted');assert.equal(restarted.counts().starts,0);
  }finally{restarted.host.revoke();}
});

test('pilot independent host security: user wait pauses active time, repeated calls cannot reset budgets',async(t)=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse(time)});
  const f=hostFixture(undefined,10);try{
    const id=await f.start();t.mock.timers.tick(5);f.callbacks().notice({type:'question',questionId:'q-1',prompt:'Continue?'});
    t.mock.timers.tick(100);assert.equal(f.disk().runs[0]!.status,'waiting_user');
    assert.deepEqual(await f.host.invoke('answerQuestion',owner,{contractVersion:PILOT_VERSION,runId:id,questionId:'q-1',answer:'yes'}),{ok:true,value:{accepted:true}});
    t.mock.timers.tick(6);assert.equal(f.disk().runs[0]!.status,'failed');
    const terminal=f.disk().runs[0]!.events.at(-1);assert.equal(terminal?.type,'run.failed');if(terminal?.type==='run.failed')assert.equal(terminal.data.stage,'deadline');
  }finally{f.host.revoke();}
  const repeated=hostFixture();try{
    await repeated.start();await repeated.sum('call-1');await repeated.sum('call-2');await assert.rejects(repeated.sum('call-3'));
    const terminal=repeated.disk().runs[0]!.events.at(-1);assert.equal(terminal?.type,'run.failed');if(terminal?.type==='run.failed')assert.equal(terminal.data.code,'NO_PROGRESS');
  }finally{repeated.host.revoke();}
});
