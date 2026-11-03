import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createProjectFolderHost,parseProjectFolderDisk,type ProjectFolderDisk} from '../apps/desktop/src/main/cloud/project-folder-host';
import {createWorkspaceHost} from '../apps/desktop/src/main/cloud/project-workspace-host';
import {emptyWorkspace,parseWorkspaceDisk,WORKSPACE_VERSION,type WorkspaceDisk} from '../apps/desktop/src/shared/agent/project-workspace';
import {PROJECT_FOLDERS_VERSION as F,parseProjectFolderRequest,parseProjectFolderResult} from '../apps/desktop/src/shared/agent/project-folders';
import {createUnifiedChatCoordinator} from '../apps/desktop/src/main/cloud/unified-chat-coordinator';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import {checkedFolderPath,folderPartAllowed,folderReadPartAllowed,captureFolderRoot} from '../apps/desktop/src/main/cloud/project-folder-files';
import {captureProjectReadFile,createProjectTextReader,createProjectReadIoBudget,createProjectReadOperation} from '../apps/desktop/src/main/cloud/project-read-files';
import {checkReviewedTarget} from '../apps/desktop/src/main/cloud/reviewed-save';
import {writeChatExport} from '../apps/desktop/src/main/cloud/chat-export';
import type {ProjectReadHost} from '../apps/desktop/src/main/agent-project-read/host';
import type {ProjectReadEngine,ProjectReadEngineInput} from '../apps/desktop/src/main/agent-project-read/engine';
import {SESSION_VERSION as S,parseSessionDisk,parseSessionMethodResult,type SessionDisk,type SessionMethod} from '../apps/desktop/src/shared/agent/chat-sessions';

// Only new synthetic directories under the product root; no real chat, source, key or API.
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'config',windowId:'window',webContentsId:1,workspaceId:'workspace',rootId:'root'};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(done:()=>boolean){for(let i=0;i<100;i++){if(done())return;await tick();}assert.fail('synthetic execution did not settle');}
function folders(){
 const product=path.resolve(process.cwd());assert.equal(product.toLowerCase(),'c:\\work\\analog_ai_workbench');
 const directory=fs.mkdtempSync(path.join(product,'.local','chat-config-author-')),root=path.join(directory,'source');fs.mkdirSync(root);
 let workspace=emptyWorkspace(),disk:ProjectFolderDisk={version:2,bindings:[],creation:null},writes=0,workspaceWrites=0,choices=0,selection:string|undefined=root,chooseHook:()=>void=()=>{};
 const workspaceHost=createWorkspaceHost({load:()=>structuredClone(workspace),save:value=>{workspace=parseWorkspaceDisk(value);workspaceWrites++;}});
 const host=createProjectFolderHost({store:{load:()=>structuredClone(disk),save:value=>{disk=parseProjectFolderDisk(value);writes++;}},workspace:workspaceHost,hasProject:workspaceHost.hasProject,
  chooseFolder:async()=>{choices++;chooseHook();return selection;}});
 const projectId=workspace.activeId,bind=()=>host.invoke('bindFolder',{contractVersion:F,projectId},()=>true);
 return {host,workspaceHost,projectId,directory,root,bind,disk:()=>structuredClone(disk),workspace:()=>structuredClone(workspace),writes:()=>writes,workspaceWrites:()=>workspaceWrites,choices:()=>choices,
  cancel(){selection=undefined;},select(target:string){assert(path.resolve(target).startsWith(directory+path.sep));selection=target;},duringChoose(hook:()=>void){chooseHook=hook;},replaceDisk(value:ProjectFolderDisk){disk=value;}};
}

test('first-binding bridge admits only a project identity and requires a non-null success binding',()=>{
 const request={contractVersion:F,projectId:randomUUID()};assert.deepEqual(parseProjectFolderRequest('bindFolder',request),request);
 assert.throws(()=>parseProjectFolderRequest('bindFolder',{...request,path:'C:\\untrusted'}));
 assert.throws(()=>parseProjectFolderResult('bindFolder',{ok:true,projectId:request.projectId,binding:null}));
 for(const code of ['CONFIGURATION_REQUIRED','CONFIGURATION_UNAVAILABLE'])assert.deepEqual(parseSessionMethodResult('answerInteraction',{ok:false,error:{code}}),{ok:false,error:{code}});
});
test('first binding writes one folder record without changing the project; rebinding is refused before picker',async()=>{
 const f=folders(),before=f.workspace();const result=await f.bind();assert(result.ok);assert.equal(result.projectId,f.projectId);assert.equal(f.writes(),1);assert.equal(f.workspaceWrites(),0);assert.deepEqual(f.workspace(),before);assert.equal(f.disk().bindings[0]!.root,f.root);
 assert.deepEqual(await f.bind(),{ok:false,error:{code:'CONFLICT'}});assert.equal(f.choices(),1);assert.equal(f.writes(),1);
});
test('cancelled first-binding picker preserves all metadata',async()=>{
 const f=folders();f.cancel();const before=f.disk();assert.deepEqual(await f.bind(),{ok:false,error:{code:'CANCELLED'}});assert.deepEqual(f.disk(),before);assert.equal(f.writes(),0);assert.equal(f.workspaceWrites(),0);
});
test('project mutation while picker is open refuses stale binding without any folder write',async()=>{
 const f=folders();f.duringChoose(()=>{const state=f.workspace();state.projects[0]!.name='changed while picking';assert(f.workspaceHost.invoke('save',{contractVersion:WORKSPACE_VERSION,expectedRevision:state.revision,state},true).ok);});
 assert.deepEqual(await f.bind(),{ok:false,error:{code:'CONFLICT'}});assert.equal(f.writes(),0);assert.equal(f.disk().bindings.length,0);
});
test('caller revocation or changed folder-store ownership cannot commit a picker result',async()=>{
 const revoked=folders();revoked.duringChoose(()=>revoked.host.revoke());assert.deepEqual(await revoked.bind(),{ok:false,error:{code:'CAPABILITY_DENIED'}});assert.equal(revoked.writes(),0);
 const changed=folders();changed.duringChoose(()=>changed.replaceDisk({version:2,bindings:[],creation:{unexpected:true} as never}));assert.deepEqual(await changed.bind(),{ok:false,error:{code:'STORAGE_ERROR'}});assert.equal(changed.writes(),0);
});

function chat(f:ReturnType<typeof folders>){
 let disk:SessionDisk={version:6,selectedId:null,sessions:[]},starts=0;const inputs:ProjectReadEngineInput[]=[];
 const engine:ProjectReadEngine={dispose(){},shutdown:async()=>{},health:async()=>true,status:()=>({model:{provider:'kimi',model:'kimi-k3'},canStart:true,processState:'ready',reason:null}),accept:(_id,m)=>m,acceptChat:(_id,m)=>m,canDeliver:()=>true,accounting:()=>({providerAttempts:0,httpDispatches:0,contextBytes:0}),answer:async()=>{},stop:async()=>{},
  start:async input=>{inputs.push(input);input.callbacks.notice({type:'started',sessionId:'native-'+(++starts)});if(starts===1){await input.callbacks.tool({sessionId:'native-1',messageId:'message-1',callId:'call-1',toolName:'pilot_sum',arguments:{values:[1]}});return;}input.callbacks.notice({type:'text',messageId:'answer',step:1,text:'synthetic completed'});input.callbacks.notice({type:'completed'});}};
 const forbidden=():never=>{throw Error('unexpected project execution');};
 const project={captureChat:(projectId:string)=>{const binding=f.host.snapshotBinding(projectId);let scope=null;if(binding.ok){const root=binding.value.folder;scope={root,project:{projectId,bindingId:root.bindingId,identity:createHash('sha256').update(JSON.stringify(root)).digest('hex'),name:'synthetic',directoryName:'source',directorySegments:['C','synthetic','source']}};}return {projectId,scope,wsl:Promise.resolve(null),commandEnvironmentVersion:'a'.repeat(64)};},createChatEngine:()=>engine,chatRun:()=>null,chatRuns:()=>[],attachChat:forbidden,finishChat:forbidden,answerChat:forbidden} as unknown as ProjectReadHost;
 let host:ReturnType<typeof createSessionHost>;const arbiter=createAgentRuntimeArbiter(),service=createUnifiedChatCoordinator({project,arbiter,workspace:()=>f.workspace(),getSession:id=>host.getSession(id),plain:forbidden});
 host=createSessionHost({owner,store:{load:()=>structuredClone(disk),save:value=>{disk=parseSessionDisk(structuredClone(value));}},configured:{kimi:true,deepseek:true},execute:forbidden,executeMultimodal:forbidden,turns:service});
 const invoke=<M extends SessionMethod>(method:M,args:object={})=>host.invoke(owner,method,{contractVersion:S,...args});
 const state=()=>{const result=invoke('readState');assert(result.ok);return result.value;};assert(invoke('createSession',{provider:'kimi',title:'synthetic'}).ok);const sessionId=state().selectedId!;
 const requestId=randomUUID(),file={id:randomUUID(),name:'request.txt',text:'synthetic attachment',startLine:1,endLine:1,totalLines:1};
 return {host,invoke,state,service,sessionId,requestId,inputs,starts:()=>starts,durable:()=>structuredClone(disk),begin(){assert(invoke('sendMessage',{sessionId,requestId,text:'Read my selected project',files:[file]}).ok);},retry(){const old=state().selected!.turns[0]!;return {sessionId,turnId:old.id,interactionId:old.execution!.pendingInteraction!.interactionId,requestId:randomUUID(),decision:{kind:'configuration',decision:'retry'}};},async close(){host.revoke();await tick();await arbiter.close();}};
}
test('filesystem capability permits explicit retry without binding and preserves the original question, attachments and receipt identity',async()=>{
 const f=folders(),c=chat(f);try{
  c.begin();await until(()=>!c.host.isRunning());const before=c.durable(),retry=c.retry();assert.equal(c.starts(),1);
  assert.equal(c.state().capabilities?.filesystemRead,true);assert(c.invoke('answerInteraction',retry).ok);await until(()=>!c.host.isRunning());
  const [original,next]=c.state().selected!.turns;assert.equal(c.starts(),2);assert.equal(original!.status,before.sessions[0]!.turns[0]!.status);assert.equal(original!.execution!.phase,'needs_configuration');assert.equal(original!.execution!.interactionReceipts!.length,1);assert.equal(original!.execution!.pendingInteraction,null);assert.equal(original!.execution!.acceptedContext.bindingId,null);assert.equal(next!.execution!.acceptedContext.bindingId,null);assert.equal(next!.user,original!.user);assert.deepEqual(next!.files,original!.files);assert.equal(next!.id,retry.requestId);assert.equal(f.choices(),0);
  const saved=c.durable();assert(c.invoke('answerInteraction',retry).ok);await tick();assert.equal(c.starts(),2);assert.deepEqual(c.durable(),saved);
 }finally{await c.close();}
});
test('a lost organizational directory does not preempt the model on explicit filesystem retry',async()=>{
 const f=folders(),c=chat(f);try{
  c.begin();await until(()=>!c.host.isRunning());assert((await f.bind()).ok);const before=c.durable(),moved=path.join(f.directory,'source-moved');
  assert.equal(path.dirname(path.resolve(f.root)),f.directory);assert.equal(path.dirname(path.resolve(moved)),f.directory);fs.renameSync(f.root,moved);
  assert(c.invoke('answerInteraction',c.retry()).ok);await until(()=>!c.host.isRunning());assert.equal(c.starts(),2);const original=c.durable().sessions[0]!.turns[0]!;assert.equal(original.status,'failed');assert.deepEqual(original.execution!.acceptedContext,before.sessions[0]!.turns[0]!.execution!.acceptedContext);assert.equal(original.execution!.interactionReceipts!.length,1);assert.equal(c.durable().sessions[0]!.turns[1]!.status,'completed');
 }finally{await c.close();}
});

test('explicitly selected synthetic Lab source supports bounded read while sensitive roots, escapes and write names remain denied',async()=>{
 const f=folders(),root=path.join(f.directory,'analog_ai_lab','evaluation','harness_benchmark');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'README.txt'),'synthetic Lab contents');
 for(const name of ['.git','pdk','credentials']){fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,'hidden.txt'),'must stay filtered');}
 const outside=path.join(f.directory,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'outside.txt'),'not in selected root');const link=path.join(root,'linked-outside');fs.symlinkSync(outside,link,'junction');
 f.select(root);const bound=await f.bind();assert(bound.ok);assert.equal(f.disk().bindings[0]!.root,root);assert(folderReadPartAllowed('analog_ai_lab'));assert.equal(folderPartAllowed('analog_ai_lab'),false,'work-copy/runner relative-name policy remains unchanged');
 const listed=await f.host.invoke('list',{contractVersion:F,projectId:f.projectId,bindingId:bound.binding.bindingId},()=>true);assert(listed.ok);assert.deepEqual(listed.entries.map(e=>e.name),['README.txt']);
 const entry=listed.entries[0]!,opened=await f.host.invoke('open',{contractVersion:F,projectId:f.projectId,bindingId:bound.binding.bindingId,treeId:listed.treeId,nodeId:entry.nodeId},()=>true);assert(opened.ok);assert.equal(opened.file.text,'synthetic Lab contents');
 const frozen=f.disk().bindings[0]!,file=captureProjectReadFile(frozen,'README.txt'),abort=new AbortController(),reader=createProjectTextReader({root:frozen,file,expectedVersion:null,signal:abort.signal,budget:createProjectReadIoBudget()});
 try{const read=await reader.step(createProjectReadOperation(abort.signal));assert.equal(read.kind,'complete');}finally{await reader.close();}
 for(const relative of ['../outside/outside.txt','linked-outside/outside.txt','pdk/hidden.txt','credentials/hidden.txt','.git/hidden.txt'])assert.throws(()=>captureProjectReadFile(frozen,relative));
 assert.throws(()=>captureFolderRoot(f.projectId,randomUUID(),link));
 for(const name of ['analog_gpt','pdk','pdks','oa','license','model-settings','api-keys'])assert.throws(()=>checkedFolderPath(path.join(root,name)));
 assert.throws(()=>checkReviewedTarget(path.join(root,'README.txt'),'README.txt'),/UNSUPPORTED_FILE/);
 const exported=path.join(root,'export.md');assert.throws(()=>writeChatExport(exported,'must not write',()=>true),/UNSUPPORTED_FILE/);assert.equal(fs.existsSync(exported),false);assert.equal(fs.readFileSync(path.join(root,'README.txt'),'utf8'),'synthetic Lab contents');
});

test('model configuration retry without a directory is accepted exactly once by the real host and coordinator',async()=>{
 const f=folders(),c=chat(f);try{
  // A supported-model card is main-owned. Exercise its admission without inventing a project requirement.
  const context=c.service.capture({sessionId:c.sessionId,executionId:'model-config-probe',provider:'kimi',model:'kimi-k3',historyVersion:'a'.repeat(64),retryConfiguration:{kind:'configuration',interactionId:'model-config',required:'supported_model',action:'select_model',message:'select a supported model'}});
  assert.equal(context.bindingId,null);c.service.forget('model-config-probe');
  const initial=c.durable(),turnId=randomUUID(),e={executionId:'prior-model-config',version:1,requestDigest:'a'.repeat(64),acceptedContext:context,phase:'needs_configuration' as const,cleanupState:'idle' as const,runLink:null,parentTurnId:null,pendingInteraction:{kind:'configuration' as const,interactionId:'model-config',required:'supported_model' as const,action:'select_model' as const,message:'select a supported model'},toolScopeRequested:false};
  initial.sessions[0]!.turns.push({id:turnId,user:'ordinary model question',assistant:'',status:'failed',error:'',provider:'kimi',model:'kimi-k3',execution:e});
  let disk=parseSessionDisk(initial),dispatches=0;const service={...c.service,execute:async(input:Parameters<typeof c.service.execute>[0])=>{dispatches++;input.onText('synthetic answer');input.onExecution({phase:'completed',cleanupState:'idle',runLink:null,pendingInteraction:null});}};
  const host=createSessionHost({owner,store:{load:()=>structuredClone(disk),save:next=>{disk=parseSessionDisk(next);}},configured:{kimi:true,deepseek:true},execute:async()=>{throw Error('legacy');},turns:service});
  try{const request={contractVersion:S,sessionId:c.sessionId,turnId,interactionId:'model-config',requestId:randomUUID(),decision:{kind:'configuration',decision:'retry'}};assert(host.invoke(owner,'answerInteraction',request).ok);await until(()=>!host.isRunning());assert.equal(dispatches,1);assert(host.invoke(owner,'answerInteraction',request).ok);await tick();assert.equal(dispatches,1);assert.equal(disk.sessions[0]!.turns.length,2);}finally{host.revoke();}
 }finally{await c.close();}
});
