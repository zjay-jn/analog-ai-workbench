import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { startOpenCodeSupervisor, OPENCODE_SUPERVISOR_IDENTITY, PROJECT_READ_NATIVE_TOOL_IDENTITY } from '../apps/desktop/src/main/engine-pilot/opencode-supervisor';
import { ENGINE_GUARDIAN_IDENTITY } from '../apps/desktop/src/main/engine-pilot/engine-guardian';
const guardianModule=require('../apps/desktop/src/main/engine-pilot/engine-guardian') as typeof import('../apps/desktop/src/main/engine-pilot/engine-guardian');

// These tests replace filesystem, process, port allocation and HTTP. They never launch OpenCode.
const services = {port:43123,providerToken:'a'.repeat(64),toolToken:'b'.repeat(64)};
type FixtureOptions = {hashMismatch?:boolean; toolHashMismatch?:boolean; extraTool?:boolean; hardLinked?:boolean; linked?:boolean; reparse?:boolean; health?:'ready'|'wrong-version'|'hang'; killExits?:boolean; spawnError?:boolean};
function fixture(t:TestContext, options:FixtureOptions={}) {
  const files=new Map<string,string>(),directories=new Set<string>(),kills:number[]=[],requests:Array<{url:string;init:RequestInit}>=[];
  const launches:Array<{file:string;args:readonly string[];options:childProcess.SpawnOptions}>=[];
  const child:EventEmitter & {pid:number|undefined;exitCode:number|null;signalCode:string|null;stdout:EventEmitter;stderr:EventEmitter;kill():boolean}=Object.assign(new EventEmitter(),{pid:options.spawnError?undefined:45678,exitCode:null,signalCode:null,stdout:new EventEmitter(),stderr:new EventEmitter(),kill(){if(child.pid!==undefined)kills.push(child.pid);if(options.killExits!==false){child.signalCode='SIGTERM';queueMicrotask(()=>child.emit('exit',null,'SIGTERM'));}return true;}});
  t.after(()=>{child.emit('exit',0,null);});
  const normalize=(value:unknown)=>path.resolve(String(value));
  const candidate=normalize(OPENCODE_SUPERVISOR_IDENTITY.executable),tool=normalize(OPENCODE_SUPERVISOR_IDENTITY.toolSource),projectTool=normalize(PROJECT_READ_NATIVE_TOOL_IDENTITY.source);
  const stats=(value:unknown)=>{
    const name=normalize(value),regular=name===candidate||name===tool||name===projectTool||files.has(name);
    return {isFile:()=>regular,isDirectory:()=>!regular,isSymbolicLink:()=>!!options.linked&&name===candidate,nlink:options.hardLinked&&name===candidate?2:1,size:name===candidate?OPENCODE_SUPERVISOR_IDENTITY.executableBytes:name===projectTool||files.get(name)==='MOCK_PROJECT_TOOL'?PROJECT_READ_NATIVE_TOOL_IDENTITY.bytes:name===tool||files.get(name)==='MOCK_TOOL'?OPENCODE_SUPERVISOR_IDENTITY.toolBytes:Buffer.byteLength(files.get(name)??''),dev:1,ino:regular?name:0,mtimeMs:1,ctimeMs:1};
  };
  t.mock.method(fs,'lstatSync',(value:unknown)=>stats(value));
  t.mock.method(fs,'realpathSync',(value:unknown)=>options.reparse&&normalize(value)===candidate?candidate+'.redirect':normalize(value));
  t.mock.method(fs,'mkdirSync',(value:unknown,settings?:{recursive?:boolean})=>{const name=normalize(value);if(directories.has(name)&&!settings?.recursive)throw Object.assign(Error(),{code:'EEXIST'});directories.add(name);});
  t.mock.method(fs,'writeFileSync',(value:unknown,contents:unknown,settings?:{flag?:string})=>{const name=normalize(value);if(files.has(name)&&settings?.flag==='wx')throw Error();files.set(name,String(contents));});
  t.mock.method(fs,'readFileSync',(value:unknown)=>Buffer.from(normalize(value)===candidate?'MOCK_EXE':normalize(value)===tool?'MOCK_TOOL':normalize(value)===projectTool?'MOCK_PROJECT_TOOL':files.get(normalize(value))??''));
  t.mock.method(fs,'readdirSync',(value:unknown)=>{const prefix=normalize(value)+path.sep;const names=[...new Set([...directories,...files.keys()].filter(p=>p.startsWith(prefix)).map(p=>p.slice(prefix.length).split(path.sep)[0]))];return options.extraTool&&path.basename(normalize(value))==='tools'?[...names,'unreviewed.js']:names;});
  t.mock.method(crypto,'createHash',()=>{let text='';const hash={update(value:Uint8Array){text+=Buffer.from(value).toString();return hash;},digest(){return options.hashMismatch||(options.toolHashMismatch&&text==='MOCK_TOOL')?'0'.repeat(64):text==='MOCK_EXE'?OPENCODE_SUPERVISOR_IDENTITY.executableSha256:text==='MOCK_PROJECT_TOOL'?PROJECT_READ_NATIVE_TOOL_IDENTITY.sha256:OPENCODE_SUPERVISOR_IDENTITY.toolSha256;}};return hash;});
  t.mock.method(childProcess,'spawn',(file:string,args:readonly string[],settings:childProcess.SpawnOptions)=>{launches.push({file,args,options:settings});if(options.spawnError)queueMicrotask(()=>child.emit('error',new Error('private raw spawn detail')));return child;});
  t.mock.method(guardianModule,'startEngineGuardian',(plan:Parameters<typeof guardianModule.startEngineGuardian>[0])=>{
    childProcess.spawn(plan.identity.binary.path,[plan.root,String(plan.port)],{cwd:path.join(plan.root,'cwd'),env:plan.env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    const exited=new Promise<{exited:boolean;code:number|null;signal:string|null}>(resolve=>{child.once('exit',(code:number|null,signal:string|null)=>resolve({exited:true,code:signal?125:code,signal:null}));child.once('error',()=>{if(child.pid===undefined)resolve({exited:true,code:null,signal:null});});});
    return {child:child as never,ready:options.spawnError?Promise.reject(Error('synthetic spawn failure')):Promise.resolve({pid:56789,creationTime100ns:'134000000000000000',image:plan.identity.engine.path,sha256:plan.identity.engine.sha256}),exited,async stop(){child.kill();let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([exited,new Promise<{exited:boolean;code:null;signal:null}>(resolve=>{timer=setTimeout(()=>resolve({exited:false,code:null,signal:null}),3000);})]);}finally{if(timer)clearTimeout(timer);}}};
  });
  t.mock.method(net,'createServer',()=>{const server=Object.assign(new EventEmitter(),{listen(_port:number,_host:string,callback:()=>void){queueMicrotask(callback);return server;},address(){return {port:43124,address:'127.0.0.1',family:'IPv4'};},close(callback:()=>void){queueMicrotask(callback);return server;}});return server;});
  t.mock.method(globalThis,'fetch',(url:string,init:RequestInit)=>{requests.push({url,init});if(options.health==='hang')return new Promise<Response>(()=>{});return Promise.resolve(new Response(JSON.stringify({healthy:true,version:options.health==='wrong-version'?'0.0.0':'1.18.17'}),{headers:{'content-type':'application/json'}}));});
  return {files,directories,launches,kills,requests,child};
}

test('supervisor uses pinned candidate, fresh product layout, clean environment and hidden owned process',async t=>{
  const f=fixture(t),old=process.env['OPENAI_API_KEY'];process.env['OPENAI_API_KEY']='must-not-inherit';
  try {
    const supervisor=await startOpenCodeSupervisor({services});
    assert.equal(f.launches.length,1);const launch=f.launches[0]!,env=launch.options.env!;
    assert.equal(launch.file,ENGINE_GUARDIAN_IDENTITY.binary.path);assert.equal(supervisor.pid,56789);
    assert.deepEqual(launch.args,[path.dirname(supervisor.directory),'43124']);
    assert.equal(launch.options.windowsHide,true);assert.equal(launch.options.shell,false);assert.deepEqual(launch.options.stdio,['pipe','pipe','pipe']);
    assert.equal(env['OPENAI_API_KEY'],undefined);assert.equal(env['NODE_OPTIONS'],undefined);assert.equal(env['HTTP_PROXY'],undefined);
    assert.equal(env['npm_config_offline'],'true');assert.equal(env['npm_config_audit'],'false');assert.equal(env['npm_config_registry'],'http://127.0.0.1:9');
    assert.equal(f.files.get(env['npm_config_userconfig']!),'');assert.equal(f.files.get(env['npm_config_globalconfig']!),'');
    assert.equal(f.files.get(path.join(supervisor.directory,'.npmrc')),'offline=true\naudit=false\nregistry=http://127.0.0.1:9\n');
    assert.match(supervisor.directory,/agent-engine-pilot[\\/]native[\\/][0-9a-f-]{36}[\\/]cwd$/u);
    for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','OPENCODE_CONFIG_DIR','OPENCODE_MODELS_PATH'])assert.ok(env[key]?.startsWith(path.dirname(supervisor.directory)+path.sep),key);
    assert.equal(f.files.get(path.join(supervisor.directory,'package.json')),'{}\n');assert.equal(f.files.get(path.join(supervisor.directory,'tsconfig.json')),'{}\n');
    assert.equal(f.files.get(env['OPENCODE_MODELS_PATH']!),'{}\n');
    const config=JSON.parse(env['OPENCODE_CONFIG_CONTENT']!);
    assert.deepEqual(config.enabled_providers,['pilot']);assert.equal(config.provider.pilot.npm,'@ai-sdk/openai-compatible');
    assert.equal(config.provider.pilot.options.baseURL,'http://127.0.0.1:43123/v1');assert.equal(config.provider.pilot.options.apiKey,services.providerToken);
    assert.equal(config.snapshot,false);assert.equal(config.lsp,false);assert.equal(config.formatter,false);assert.deepEqual(config.compaction,{auto:false,prune:false});assert.deepEqual(config.skills,{paths:[],urls:[]});
    assert.deepEqual(config.provider.pilot.env,[]);assert.equal(config.provider.pilot.options.timeout,10000);assert.equal(config.agent.pilot.model,'pilot/mock');
    assert.deepEqual(config.permission,{'*':'deny',pilot_sum:'allow',question:'allow'});
    assert.equal(config.default_agent,'pilot');assert.deepEqual(config.agent.pilot.permission,{'*':'deny',pilot_sum:'allow',question:'allow'});
    assert.ok([...f.files.values()].every(content=>!content.includes(services.providerToken)&&!content.includes(services.toolToken)&&!content.includes(supervisor.password)));
    assert.match(supervisor.password,/^[0-9a-f]{64}$/u);assert.notEqual(supervisor.password,services.providerToken);
    assert.equal(new Headers(f.requests[0]!.init.headers).get('Authorization'),`Basic ${Buffer.from('opencode:'+supervisor.password).toString('base64')}`);
    assert.equal(f.requests[0]!.url,'http://127.0.0.1:43124/global/health');assert.equal(f.requests[0]!.init.redirect,'error');
    assert.deepEqual(await supervisor.stop(),{exited:true,code:125,signal:null});assert.deepEqual(f.kills,[45678]);
    await supervisor.stop();assert.equal(f.kills.length,1);
  } finally {if(old===undefined)delete process.env['OPENAI_API_KEY'];else process.env['OPENAI_API_KEY']=old;}
});

for(const [name,options] of [['hash mismatch',{hashMismatch:true}],['link',{linked:true}],['hard link',{hardLinked:true}],['resolved path change',{reparse:true}],['tool hash mismatch',{toolHashMismatch:true}],['additional tool module',{extraTool:true}]] as const) {
  test(`supervisor refuses candidate ${name} before spawn`,async t=>{const f=fixture(t,options);await assert.rejects(startOpenCodeSupervisor({services}),/OpenCode supervisor unavailable/u);assert.equal(f.launches.length,0);});
}

test('supervisor rejects additional startup inputs and token reuse without spawning',async t=>{
  const f=fixture(t);
  await assert.rejects(startOpenCodeSupervisor({services,executable:'E:/OpenCode/bin/opencode.exe'} as never));
  await assert.rejects(startOpenCodeSupervisor({services:{...services,toolToken:services.providerToken}}));assert.equal(f.launches.length,0);
});

test('supervisor bounds an unresponsive health request and confirms owned exit',async t=>{
  const f=fixture(t,{health:'hang'});t.mock.timers.enable({apis:['setTimeout','Date']});
  const started=startOpenCodeSupervisor({services});const rejected=assert.rejects(started,/OpenCode supervisor unavailable/u);
  await setImmediate();t.mock.timers.tick(30001);await setImmediate();await rejected;assert.deepEqual(f.kills,[45678]);
});

test('wrong-version health cannot mark the candidate ready',async t=>{
  const f=fixture(t,{health:'wrong-version'});t.mock.timers.enable({apis:['setTimeout','Date']});
  const rejected=assert.rejects(startOpenCodeSupervisor({services}));await setImmediate();t.mock.timers.tick(30001);await setImmediate();await rejected;assert.deepEqual(f.kills,[45678]);
});

test('supervisor reports unconfirmed stop honestly and never targets another PID',async t=>{
  const f=fixture(t,{killExits:false}),supervisor=await startOpenCodeSupervisor({services});
  t.mock.timers.enable({apis:['setTimeout','Date']});const stopping=supervisor.stop();t.mock.timers.tick(3001);
  assert.deepEqual(await stopping,{exited:false,code:null,signal:null});assert.deepEqual(f.kills,[45678]);
  f.child.emit('exit',7,null);assert.deepEqual(await supervisor.exited,{exited:true,code:7,signal:null});
  assert.equal(await supervisor.health(),false);await supervisor.stop();assert.deepEqual(f.kills,[45678]);
});

test('owned process exit before ready rejects startup and does not kill a reused PID',async t=>{
  const f=fixture(t,{health:'hang'}),rejected=assert.rejects(startOpenCodeSupervisor({services}));
  await setImmediate();f.child.emit('exit',23,null);await rejected;assert.deepEqual(f.kills,[]);
});

test('spawn error without a PID is not misreported as an unconfirmed exit or retained ownership',async t=>{
  const f=fixture(t,{spawnError:true});
  for(let i=0;i<2;i++)await assert.rejects(startOpenCodeSupervisor({services}),(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='START_FAILED');
  assert.equal(f.launches.length,2);assert.deepEqual(f.kills,[]);
});

test('child output only exposes safe bounded diagnostics and excessive output stops the owned child',async t=>{
  const f=fixture(t),supervisor=await startOpenCodeSupervisor({services});
  f.child.stderr.emit('data',Buffer.from(`ENOTCACHED private ${services.toolToken} ${supervisor.password}`));
  const view=supervisor.diagnostics();assert.deepEqual(view.markers,['npm_offline_cache_miss']);
  assert.ok(!JSON.stringify(view).includes(services.toolToken));assert.ok(!JSON.stringify(view).includes(supervisor.password));
  f.child.stdout.emit('data',Buffer.alloc(8193));await supervisor.exited;
  assert.equal(supervisor.diagnostics().outputLimitExceeded,true);assert.deepEqual(f.kills,[45678]);
});

test('startup failures preserve safe diagnostic enums without raw child output',async t=>{
  const f=fixture(t,{health:'hang'}),settled=startOpenCodeSupervisor({services}).then(()=>null,error=>error);
  await setImmediate();f.child.stderr.emit('data',Buffer.from(`ConfigInvalidError private ${services.providerToken}`));f.child.emit('exit',1,null);
  const failure=await settled;assert.equal(failure.code,'START_FAILED');assert.deepEqual(failure.diagnostics.markers,['configuration_error']);
  assert.ok(!JSON.stringify(failure).includes(services.providerToken));assert.deepEqual(f.kills,[]);
});

test('live supervisor recipe fixes gateway model steps and budgets while preserving the default mock recipe',async t=>{
  const f=fixture(t),live=await startOpenCodeSupervisor({services,profile:'live-deepseek'});
  const launch=f.launches[0]!,env=launch.options.env!,config=JSON.parse(env['OPENCODE_CONFIG_CONTENT']!);
  assert.deepEqual(config.enabled_providers,['workbench']);assert.deepEqual(Object.keys(config.provider),['workbench']);
  assert.equal(config.provider.workbench.npm,'@ai-sdk/openai-compatible');assert.deepEqual(config.provider.workbench.env,[]);
  assert.deepEqual(config.provider.workbench.options,{baseURL:'http://127.0.0.1:43123/v1',apiKey:services.providerToken,timeout:600000});
  assert.deepEqual(Object.keys(config.provider.workbench.models),['deepseek-v4-flash']);
  assert.deepEqual(config.provider.workbench.models['deepseek-v4-flash'].limit,{context:65536,output:16384});
  assert.equal(config.provider.workbench.models['deepseek-v4-flash'].reasoning,false);
  assert.equal(config.agent.pilot.model,'workbench/deepseek-v4-flash');assert.equal(config.agent.pilot.steps,8);
  assert.deepEqual(config.permission,{'*':'deny',pilot_sum:'allow',question:'allow'});assert.deepEqual(config.agent.pilot.permission,config.permission);
  assert.equal(launch.options.windowsHide,true);assert.equal(launch.options.shell,false);
  assert.ok(!JSON.stringify({config,args:launch.args}).includes('api.deepseek.com'));
  assert.ok([...f.files.values()].every(content=>!content.includes(services.providerToken)&&!content.includes(services.toolToken)&&!content.includes(live.password)));
  assert.equal(await live.health(),true);await live.stop();
  f.child.exitCode=null;f.child.signalCode=null;
  const mock=await startOpenCodeSupervisor({services});
  const mockConfig=JSON.parse(f.launches[1]!.options.env!['OPENCODE_CONFIG_CONTENT']!);
  assert.deepEqual(mockConfig.enabled_providers,['pilot']);assert.equal(mockConfig.agent.pilot.model,'pilot/mock');assert.equal(mockConfig.agent.pilot.steps,4);
  assert.equal(mockConfig.provider.pilot.options.timeout,10000);assert.deepEqual(mockConfig.provider.pilot.models.mock.limit,{context:32768,output:2048});
  await mock.stop();assert.equal(f.launches.length,2);
});

test('conversation supervisor omits the optional positive-only chunk deadline in actual launch configuration',async t=>{
  const f=fixture(t),supervisor=await startOpenCodeSupervisor({services,profile:'work-cycle',conversation:true});
  try{
    const config=JSON.parse(f.launches[0]!.options.env!['OPENCODE_CONFIG_CONTENT']!);
    assert.deepEqual(config.provider.workbench.options,{baseURL:'http://127.0.0.1:43123/v1',apiKey:services.providerToken,timeout:930000,headerTimeout:false});
    assert.equal(Object.hasOwn(config.provider.workbench.options,'chunkTimeout'),false);
    assert.equal(config.model,'workbench/kimi-k3');assert.equal(f.launches.length,1);
  }finally{await supervisor.stop();}
});

test('live supervisor rejects dynamic destination model budgets and key inputs before any process launch',async t=>{
  const f=fixture(t);
  for(const extra of [{model:'deepseek-flash'},{provider:'deepseek'},{baseURL:'https://api.deepseek.com'},{apiKey:'sk-synthetic-not-a-real-key'},{steps:16},{timeout:300000}])await assert.rejects(startOpenCodeSupervisor({services,profile:'live-deepseek',...extra} as never));
  await assert.rejects(startOpenCodeSupervisor({services,profile:'live-kimi'} as never));
  assert.equal(f.launches.length,0);assert.equal(f.requests.length,0);
});
