import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';
import {performCloudChatV2,type CloudFetchV1} from '../apps/desktop/src/main/cloud/cloud-transport';
import {buildUnifiedChatContext} from '../apps/desktop/src/main/cloud/unified-chat-context';
import {sessionExtension} from '../apps/desktop/src/main/cloud/register-session-ipc';
import {createInitializationShutdown} from '../apps/desktop/src/main/engine-live/shutdown';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import {SESSION_VERSION,sessionChannel,parseSessionDisk,parseSessionResult,type SessionDisk} from '../apps/desktop/src/shared/agent/chat-sessions';
import {DEFAULT_REPLY_LIMITS} from '../apps/desktop/src/shared/agent/reply-limits';
import {emptyWorkspace} from '../apps/desktop/src/shared/agent/project-workspace';
import type {ImageAttachment} from '../apps/desktop/src/shared/agent/image-attachment';
import type {UnifiedChatService} from '../apps/desktop/src/main/cloud/unified-chat-service';
import type {createUnifiedChatCoordinator} from '../apps/desktop/src/main/cloud/unified-chat-coordinator';
import type {CloudDesktopDependencies} from '../apps/desktop/src/main/engine-live/cloud-bootstrap';
import type {projectReadExtension} from '../apps/desktop/src/main/agent-project-read/register-ipc';
import type {ModelSettingsHost} from '../apps/desktop/src/main/cloud/model-settings-host';

const KEY='sk-synthetic_unified_bootstrap_only',MODEL='deepseek-v4-flash-vision-exp';
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'bootstrap.qa',windowId:'bootstrap.qa',webContentsId:1,workspaceId:'bootstrap.qa',rootId:'bootstrap.qa'};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const wire='data: {"choices":[{"index":0,"delta":{"content":"VISION_OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const response=()=>new Response(wire,{headers:{'content-type':'text/event-stream'}});
function visionRequest(pairs=12){
  const image:ImageAttachment={id:randomUUID(),name:'synthetic.jpg',data:Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]).toString('base64'),width:1,height:1};
  return buildUnifiedChatContext({provider:'deepseek',model:MODEL,text:'current exact question',images:[image],files:[],schematics:[],replyLimits:DEFAULT_REPLY_LIMITS,
    history:Array.from({length:pairs},(_,index)=>({turnId:randomUUID(),user:'old question '+index,assistant:'old answer '+index,...(index===0?{images:[{...image,id:randomUUID(),name:'old.jpg'}]}:{})}))}).request;
}

test('main unified Vision transport keeps more than seventeen messages and exact historical image bytes',async()=>{
  const input=visionRequest(),before=structuredClone(input),chunks:string[]=[];let calls=0;
  const fetchImpl:CloudFetchV1=async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+KEY);
    const body=JSON.parse(String(init.body));assert.equal(body.model,MODEL);assert.equal(body.messages.length,25);assert.deepEqual(body.messages,input.messages);assert.equal(body.unifiedContext,undefined);assert.equal(body.tools,undefined);return response();};
  const result=await performCloudChatV2(input,{apiKey:KEY,unifiedContext:true,fetchImpl,onText:text=>chunks.push(text)});
  assert.equal(result.text,'VISION_OK');assert.deepEqual(chunks,['VISION_OK']);assert.equal(calls,1);assert.deepEqual(input,before);
});

test('legacy V2 still rejects more than seventeen messages before mock fetch and accepts its original boundary',async()=>{
  let calls=0;const fetchImpl:CloudFetchV1=async()=>{calls++;return response();};
  await assert.rejects(performCloudChatV2(visionRequest(),{apiKey:KEY,fetchImpl,onText:()=>assert.fail('rejected request delivered text')}),error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='INVALID_REQUEST');
  assert.equal(calls,0);const input=visionRequest(8);assert.equal(input.messages.length,17);
  assert.equal((await performCloudChatV2(input,{apiKey:KEY,fetchImpl,onText:()=>{}})).text,'VISION_OK');assert.equal(calls,1);
});

test('real bootstrap composition forwards turns and live ownership closures without acquiring product resources',async()=>{
  // Execute the real composition body in memory with explicit inert constructors.
  // Real register-session-ipc/session-host/transport are retained; no Electron,
  // filesystem store, credential loader, project engine or native is loaded.
  const productRoot=path.resolve('C:/work/analog_ai_workbench'),source=path.join(productRoot,'apps/desktop/src/main/engine-live/cloud-bootstrap.ts');
  let disk:SessionDisk={version:6,selectedId:null,sessions:[]},coordinator:Parameters<typeof createUnifiedChatCoordinator>[0]|undefined;
  let projectOptions:Parameters<typeof projectReadExtension>[0]|undefined,sessionOptions:Parameters<typeof sessionExtension>[0]|undefined;
  let sessions:ReturnType<ReturnType<typeof sessionExtension>>|undefined,workspaceAvailable=true;
  let activeSessionId:(()=>string|null)|undefined,execution:Parameters<UnifiedChatService['execute']>[0]|undefined,finish:()=>void=()=>assert.fail('execution not started');
  const engineOptions:Record<string,unknown>[]=[],workspace=emptyWorkspace(),calls={credentials:0,cloud:0,native:0};
  const noop=()=>{},forbidden=():never=>assert.fail('resource acquisition outside the bootstrap seam');
  const participant=()=>({revoke:noop,dispose:noop,shutdown:async()=>{}});
  const service:UnifiedChatService={capture:input=>({projectId:workspace.activeId,workspaceRevision:workspace.revision,bindingId:'bootstrap-binding',bindingIdentity:'a'.repeat(64),provider:input.provider,model:input.model,historyVersion:input.historyVersion}),
    execute:input=>{execution=input;return new Promise<void>(resolve=>{finish=resolve;});},answer:async()=>forbidden(),activity:forbidden,reconcile:(_id,turn)=>turn.execution!,forget:noop,busy:()=>false};
  const settings:ModelSettingsHost={configured:()=>({deepseek:true,kimi:true}),key:()=>KEY,defaultModel:()=>MODEL,replyLimits:()=>({...DEFAULT_REPLY_LIMITS,requestTimeoutMs:DEFAULT_REPLY_LIMITS.timeoutMs,turnTimeoutMs:null}),dispose:noop,read:forbidden,save:forbidden};
  const dependencies:CloudDesktopDependencies={credentials:()=>{calls.credentials++;return {deepseek:KEY};},encryption:{available:()=>false,encrypt:forbidden,decrypt:forbidden},chatV1:async()=>forbidden(),
    chatV2:(request,options)=>{calls.cloud++;return performCloudChatV2(request,{...options,fetchImpl:async()=>response()});},providerFetch:async()=>forbidden(),nativeFactory:async()=>{calls.native++;return forbidden();},
    liveBudget:{maxRequests:1,maxOutputTokens:8192,requestTimeoutMs:30000,deadlineMs:120000,waitMs:60000},loadReviewed:forbidden,loadSynthetic:forbidden};
  const modules:Record<string,unknown>={
    'node:path':path,
    '../cloud/model-settings-host':{createModelSettings:()=>settings},
    './shutdown':{createInitializationShutdown},
    '../agent-project-read/runtime-arbiter':{createAgentRuntimeArbiter},
    '../agent-project-read/calculation-runtime':{createArbitratedCalculationRuntime:participant},
    '../engine-pilot/store':{createPilotStore:()=>({load:forbidden,save:forbidden,close:noop})},
    '../engine-pilot/register-ipc':{pilotExtension:()=>participant},
    '../cloud/register-workspace':{workspaceExtension:(options:{activeSessionId:()=>string|null})=>{activeSessionId=options.activeSessionId;assert.equal(activeSessionId(),null);return ()=>({...participant(),hasProject:()=>true,creationSnapshot:()=>workspaceAvailable?{ok:true,value:workspace}:{ok:false,error:{code:'STORAGE_ERROR'}},projectForSession:()=>workspace.activeId});}},
    '../schematic/register-reviewed-schematic':{reviewedSchematicExtension:()=>()=>({...participant(),validateContextsForProject:noop})},
    '../cloud/register-reviewed-save':{reviewedSaveExtension:()=>participant},
    '../cloud/register-display-paths':{displayPathExtension:()=>participant},
    '../cloud/register-project-folders':{projectFolderExtension:()=>participant},
    '../agent-project-read/runtime':{createProjectReadModelSnapshots:()=>({close:noop}),createProjectReadRuntime:(options:Record<string,unknown>)=>{engineOptions.push(options);return {}; }},
    '../agent-project-read/model-selection':{createProjectReadModelSelection:()=>({})},
    '../agent-project-read/store':{createProjectReadStore:()=>({load:forbidden,save:forbidden,close:noop})},
    '../agent-command/registered-profile':{registeredCommandDrivers:()=>[]},
    '../wsl-results/settings':{createWslResultsSettings:()=>({})},
    '../agent-project-read/register-ipc':{projectReadExtension:(options:Parameters<typeof projectReadExtension>[0])=>{projectOptions=options;assert.throws(()=>options.chatReferences!());return ()=>({...participant(),host:{}});}},
    '../cloud/unified-chat-coordinator':{createUnifiedChatCoordinator:(options:Parameters<typeof createUnifiedChatCoordinator>[0])=>{coordinator=options;return service;}},
    '../cloud/register-session-ipc':{sessionExtension:(options:Parameters<typeof sessionExtension>[0])=>{sessionOptions=options;assert.equal(options.turns,service);const {draftDirectory:_,chooseExportFile:__,...memoryOptions}=options;
      return (context:Parameters<ReturnType<typeof sessionExtension>>[0])=>{sessions=sessionExtension({...memoryOptions,store:{load:()=>structuredClone(disk),save:value=>{disk=parseSessionDisk(value);}}})(context);return sessions;};}},
    '../schematic/cloud-synthetic-schematic':{cloudSchematicExtension:()=>participant},
  };
  for(const name of ['../schematic/reviewed-artifact-registry','../agent/empty-agent-backend','../cloud/credential-file','../cloud/cloud-transport','../schematic/reviewed-source-loader','../engine-pilot/opencode-client','../engine-pilot/opencode-supervisor','./runtime','../wsl-results/service','../waveform-results/service','../agent-project-read/waveform-directory','../agent-work-cycle/workspace','../agent-work-cycle/runner'])modules[name]={};
  const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const requireStub=(name:string)=>{assert(Object.hasOwn(modules,name),'Unexpected bootstrap dependency '+name);return modules[name];};
  vm.runInThisContext('(function(require,module,exports){'+code+'\n})',{filename:source})(requireStub,module,module.exports);
  const entry=module.exports as typeof import('../apps/desktop/src/main/engine-live/cloud-bootstrap'),dataRoot=path.join(productRoot,'.local/agent-engine-live-tests',randomUUID());
  const options=entry.createCloudDesktopOptions({mode:'qa',applicationRoot:productRoot,dataRoot,profileRoot:path.join(dataRoot,'profile'),dependencies});assert.deepEqual(calls,{credentials:0,cloud:0,native:0});
  const handlers=new Map<string,(event:unknown,value:unknown)=>unknown>(),ipcMain={handle:(name:string,fn:(event:unknown,value:unknown)=>unknown)=>handlers.set(name,fn),removeHandler:(name:string)=>handlers.delete(name)};
  type Context=Parameters<NonNullable<typeof options.registerExtension>>[0];
  const extension=options.registerExtension!({owner,deriveCallerContext:()=>owner,ipcMain:ipcMain as unknown as Context['ipcMain']});
  const invoke=(method:'createSession'|'sendMessage',fields:Record<string,unknown>)=>{const result=parseSessionResult(handlers.get(sessionChannel(method))!({}, {contractVersion:SESSION_VERSION,...fields}));assert(result.ok);return result.value;};
  try{
    assert(coordinator&&projectOptions&&sessionOptions&&sessions&&activeSessionId);assert.equal(coordinator.workspace(),workspace);workspaceAvailable=false;assert.throws(()=>coordinator!.workspace());workspaceAvailable=true;
    assert.deepEqual(projectOptions.chatReferences!(),new Set());
    projectOptions.createEngine(false,false);projectOptions.createEngine(true,false);projectOptions.createEngine(true,true);
    assert.deepEqual(engineOptions.map(value=>[value.workCycle,value.conversation]),[[false,false],[true,false],[true,true]]);assert(engineOptions.every(value=>value.fetchImpl===dependencies.providerFetch&&value.startNative===dependencies.nativeFactory));
    const plain=await coordinator.plain(visionRequest(),{signal:new AbortController().signal,onText:()=>{}});assert.equal(plain.text,'VISION_OK');assert.equal(calls.cloud,1);
    const created=invoke('createSession',{provider:'deepseek',model:MODEL,title:'Synthetic bootstrap'}),sessionId=created.selected!.id;assert.equal(coordinator.getSession(sessionId)!.id,sessionId);
    invoke('sendMessage',{sessionId,requestId:randomUUID(),text:'Synthetic accepted turn'});assert.equal(activeSessionId(),sessionId);await tick();assert(execution);assert.equal(execution.context.model,MODEL);assert.equal(calls.cloud,1,'turns must own dispatch instead of falling through legacy transport');
    const candidate=execution.turn.execution!.executionId+'.tools';assert.deepEqual(projectOptions.chatReferences!(),new Set([candidate]));
    execution.onExecution({phase:'running',cleanupState:'idle',runLink:{runId:'bootstrap-linked-run',workspaceId:null},pendingInteraction:null,toolScopeRequested:true});assert.deepEqual(projectOptions.chatReferences!(),new Set([candidate,'bootstrap-linked-run']));
    execution.onText('synthetic completed');execution.onExecution({phase:'completed',cleanupState:'idle',runLink:{runId:'bootstrap-linked-run',workspaceId:null},pendingInteraction:null});finish();await tick();assert.equal(activeSessionId(),null);
    assert.deepEqual(calls,{credentials:1,cloud:1,native:0});assert.equal(sessionOptions.turns,service);
    await extension.shutdown!();assert.throws(()=>projectOptions!.chatReferences!());assert.equal(handlers.size,0);
  }finally{finish();await extension.shutdown?.();}
});
