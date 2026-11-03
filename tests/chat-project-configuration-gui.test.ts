import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChatProjectConfiguration,chatProjectHasBinding} from '../apps/desktop/src/renderer/agent/ChatProjectConfiguration';
import {ChatInteractionDock,emptyChatInteractionMemory} from '../apps/desktop/src/renderer/agent/ChatInteractionDock';
import {createChatProjectBindingController} from '../apps/desktop/src/renderer/agent/chat-project-binding-controller';
import {createProjectFolderTitleReader,type FolderTitleState} from '../apps/desktop/src/renderer/agent/use-project-folder-titles';
import {restoreBlockedChatDraft} from '../apps/desktop/src/renderer/agent/chat-agent-controller';
import type {ChatTurnInteraction} from '../apps/desktop/src/shared/agent/chat-turns';
import type {ProjectFolderBinding,ProjectFolderBindingResult,ProjectFolderResults} from '../apps/desktop/src/shared/agent/project-folders';
import type {SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';

const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333';
const no=()=>{},projects=[{id:a,name:'当前项目'},{id:b,name:'已关联项目'},{id:c,name:'其他未关联项目'}];
const binding=(id:string,name='fixtures'):ProjectFolderBinding=>({projectId:id,bindingId:c,name,segments:['C','synthetic',name]});
const config:ChatTurnInteraction={kind:'configuration',interactionId:'config-a',required:'project_directory',action:'select_project',message:'本轮需要项目目录。'};
const detail=(states:Record<string,FolderTitleState>)=>createElement(ChatProjectConfiguration,{projectId:a,projects,states,disabled:false,onSelect:no,onBind:no,onRefresh:no});
const dock=(states:Record<string,FolderTitleState>,interaction:ChatTurnInteraction=config)=>renderToStaticMarkup(createElement(ChatInteractionDock,{interaction,configurationTools:detail(states),configurationRetryDisabled:interaction.kind==='configuration'&&interaction.required==='project_directory'&&!chatProjectHasBinding(a,states),onSubmit:async()=>({status:'uncertain' as const}),onConfigure:no,onStop:no,stopping:false,canStop:false}));
const success=(id=a):Extract<ProjectFolderResults['bindFolder'],{ok:true}>=>({ok:true,projectId:id,binding:binding(id)});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

test('unbound project shows its name and explicit first association, never enabling retry or another unbound choice',()=>{
 const states:Record<string,FolderTitleState>={[a]:{status:'ready',binding:null},[b]:{status:'ready',binding:binding(b)},[c]:{status:'ready',binding:null}};
 const html=dock(states);assert.match(html,/当前项目：当前项目/);assert.match(html,/项目目录：未关联目录/);assert.match(html,/为当前项目选择目录/);
 assert.match(html,/<button[^>]*disabled[^>]*>配置后继续/);assert.match(html,/已关联项目<\/option>/);assert.doesNotMatch(html,/其他未关联项目<\/option>/);
 assert(!chatProjectHasBinding(a,states));
});
test('loading and failed metadata remain distinct from unbound and cannot retry or bind',()=>{
 for(const state of [undefined,{status:'loading' as const,binding:null},{status:'error' as const,binding:null}]){
  const html=dock(state?{[a]:state}:{});assert.match(html,/<button[^>]*disabled[^>]*>配置后继续/);assert.doesNotMatch(html,/为当前项目选择目录|项目目录：未关联目录/);
  assert.match(html,state?.status==='error'?/目录关联读取失败/:/正在读取目录关联/);
 }
});
test('bound directory shows exact current path and permits explicit retry without offering replacement',()=>{
 const states:Record<string,FolderTitleState>={[a]:{status:'ready',binding:binding(a)}};const html=dock(states);
 assert.match(html,/C:\\synthetic\\fixtures/);assert.match(html,/<button type="button">配置后继续/);assert.doesNotMatch(html,/为当前项目选择目录/);
 assert(!chatProjectHasBinding(a,{[a]:{status:'ready',binding:binding(b)}}));
});
test('directory guard does not disable unrelated model configuration and uncertain receipt keeps original recovery',()=>{
 const interaction:ChatTurnInteraction={kind:'configuration',interactionId:'model-a',required:'supported_model',action:'select_model',message:'请选择模型。'};
 assert.match(dock({},interaction),/<button type="button">配置后继续/);
 const memory=emptyChatInteractionMemory();memory.uncertain=true;memory.attempt={requestId:c,decision:{kind:'configuration',decision:'retry'}};
 const html=renderToStaticMarkup(createElement(ChatInteractionDock,{interaction:config,memory,configurationTools:detail({}),configurationRetryDisabled:true,onSubmit:async()=>({status:'uncertain' as const}),onConfigure:no,onStop:no,stopping:false,canStop:false}));
 assert.match(html,/<fieldset[^>]*disabled/);assert.match(html,/<button type="button">核对同一次提交/);assert.equal(memory.attempt.requestId,c);
});
test('binding is explicit, single flight, refreshes metadata once and does not touch question attachments or newer draft',async()=>{
 const response=deferred<ProjectFolderResults['bindFolder']>(),calls:string[]=[];let refreshed=0;
 const controller=createChatProjectBindingController({bindFolder:async request=>{calls.push(request.projectId);return response.promise;}},()=>refreshed++);
 const original:SessionTurn={id:c,user:'请分析文件',assistant:'',status:'failed',error:'',images:[{id:'image-a',name:'sample.png',data:'',width:2,height:2}],files:[{id:a,name:'sample.md',text:'sample',startLine:1,endLine:1,totalLines:1}]};
 const draft={text:'下一条草稿',images:[],files:[],revision:7},before=JSON.stringify({original,draft});
 assert.equal(calls.length,0);const pending=controller.bind(a);assert(controller.snapshot().busy);await controller.bind(b);assert.deepEqual(calls,[a]);
 response.resolve(success());await pending;assert.equal(refreshed,1);assert.equal(controller.snapshot().projectId,a);assert.match(controller.snapshot().notice,/请点击“配置后继续”/);
 assert.equal(restoreBlockedChatDraft(draft,original),draft);assert.equal(JSON.stringify({original,draft}),before);
 const restored=restoreBlockedChatDraft({text:'',images:[],files:[],revision:0},original);assert.deepEqual(restored.images,original.images);assert.deepEqual(restored.files,original.files);assert.equal(restored.text,original.user);
});
test('cancelling native picker leaves association untouched with no refresh or retry',async()=>{
 let calls=0,refreshes=0;const controller=createChatProjectBindingController({bindFolder:async()=>{calls++;return {ok:false,error:{code:'CANCELLED'}};}},()=>refreshes++);
 await controller.bind(a);assert.equal(calls,1);assert.equal(refreshes,0);assert.equal(controller.snapshot().notice,'');assert.equal(controller.snapshot().busy,false);
});
test('lost, unsupported or conflicting binding result never claims success or silently retries',async()=>{
 const cases:Array<()=>Promise<ProjectFolderResults['bindFolder']>>=[async()=>{throw Error('lost response');},async()=>({ok:false,error:{code:'UNSUPPORTED_FILE'}}),async()=>({ok:false,error:{code:'CONFLICT'}}),async()=>success(b)];
 for(const result of cases){let calls=0,refreshes=0;const controller=createChatProjectBindingController({bindFolder:async()=>{calls++;return result();}},()=>refreshes++);await controller.bind(a);assert.equal(calls,1);assert.equal(refreshes,1);assert(!controller.snapshot().busy);assert.doesNotMatch(controller.snapshot().notice,/目录已关联/);assert(controller.snapshot().notice);}
});
test('stale metadata cannot enable retry after a newer failed check or after scope disposal',async()=>{
 const old=deferred<ProjectFolderBindingResult>();let calls=0,states:Record<string,FolderTitleState>={};
 const reader=createProjectFolderTitleReader({readBinding:async()=>++calls===1?old.promise:{ok:false,error:{code:'IO_ERROR'}}});
 const first=reader.read([a],value=>states=value);await reader.read([a],value=>states=value);old.resolve(success());await first;
 assert.equal(states[a]?.status,'error');assert(!chatProjectHasBinding(a,states));
 const later=deferred<ProjectFolderBindingResult>(),reader2=createProjectFolderTitleReader({readBinding:async()=>later.promise});
 const pending=reader2.read([a],value=>states=value);reader2.cancel();later.resolve(success());await pending;assert(!chatProjectHasBinding(a,states));
});
