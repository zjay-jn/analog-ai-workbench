import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import fs from 'node:fs';import path from 'node:path';
import {WORKSPACE_VERSION,DEFAULT_PROJECT,emptyWorkspace,newProject,parseWorkspaceDisk,projectForSession} from '../apps/desktop/src/shared/agent/project-workspace';
import {createWorkspaceHost,createWorkspaceStore} from '../apps/desktop/src/main/cloud/project-workspace-host';
import {createWorkspaceController} from '../apps/desktop/src/renderer/agent/workspace-controller';
import {workspaceExtension} from '../apps/desktop/src/main/cloud/register-workspace';
import {workspaceChannel} from '../apps/desktop/src/shared/agent/project-workspace';
const read={contractVersion:WORKSPACE_VERSION},save=(state:ReturnType<typeof emptyWorkspace>)=>({...read,expectedRevision:state.revision,state});
test('old and unassigned sessions remain in default project; grouping is unique and selected belongs to project',()=>{
 const state=emptyWorkspace(),session=randomUUID(),project=newProject(randomUUID(),'SAR ADC');assert.equal(projectForSession(state,session),DEFAULT_PROJECT);project.sessionIds=[session];project.selectedId=session;state.projects.push(project);state.activeId=project.id;assert.equal(projectForSession(parseWorkspaceDisk(state),session),project.id);
 assert.throws(()=>parseWorkspaceDisk({...state,projects:[{...state.projects[0],sessionIds:[session]},project]}));assert.throws(()=>parseWorkspaceDisk({...state,projects:[{...project,selectedId:randomUUID()},state.projects[0]]}));
});
test('workspace accepts bounded ordinary snapshots and reviewed proposals, rejects paths, forged excerpts and oversized data',()=>{
 const state=emptyWorkspace(),document={id:randomUUID(),name:'fixture.txt',text:'before\nline',startLine:1,endLine:2,totalLines:2},job={id:randomUUID(),sessionId:randomUUID(),document,excerpt:{...document,id:randomUUID(),text:'before',endLine:1},status:'accepted',after:'after\nline'};
 state.projects[0]!.files={documents:[document],active:document.id,start:1,end:1};state.projects[0]!.jobs=[job as never];assert.equal(parseWorkspaceDisk(state).projects[0]!.jobs[0]!.status,'accepted');
 for(const bad of [{...document,path:'C:/secret.txt'},{...document,name:'api.txt'},{...document,text:'x'.repeat(262145),endLine:1,totalLines:1},{...document,text:'a\u0000b'},{...document,totalLines:10001}])assert.throws(()=>parseWorkspaceDisk({...state,projects:[{...state.projects[0],files:{...state.projects[0]!.files,documents:[bad]}}]}));
 for(const bad of [{...job,excerpt:{...job.excerpt,text:'forged'}},{...job,after:undefined},{...job,status:'saving'},{...job,status:'executed'}])assert.throws(()=>parseWorkspaceDisk({...state,projects:[{...state.projects[0],jobs:[bad]}]}));
 assert.throws(()=>parseWorkspaceDisk({...state,projects:Array.from({length:13},()=>newProject(randomUUID(),'too many'))}));
});
test('revision CAS and caller denial leave stored state intact; responses are detached',()=>{
 let disk=emptyWorkspace(),writes=0;const host=createWorkspaceHost({load:()=>disk,save:v=>{disk=v;writes++;}}),request=save(disk);request.state.projects[0]!.name='Changed';
 assert.equal(host.invoke('save',request,false).ok,false);assert.equal(writes,0);assert.ok(host.invoke('save',request,true).ok);assert.equal(disk.revision,1);assert.deepEqual(host.invoke('save',request,true),{ok:false,error:{code:'CONFLICT'}});assert.equal(writes,1);
 const response=host.invoke('read',read,true);if(!response.ok)throw Error();response.value.projects[0]!.name='forged';assert.equal(disk.projects[0]!.name,'Changed');host.revoke();assert.equal(host.invoke('read',read,true).ok,false);
});
test('failed load or write does not reset or retry storage',()=>{
 let writes=0;const broken=createWorkspaceHost({load:()=>{throw Error();},save:()=>{writes++;}});assert.equal(broken.invoke('save',save(emptyWorkspace()),true).ok,false);assert.equal(writes,0);
 const host=createWorkspaceHost({load:emptyWorkspace,save:()=>{writes++;throw Error();}});assert.deepEqual(host.invoke('save',save(emptyWorkspace()),true),{ok:false,error:{code:'STORAGE_ERROR'}});host.invoke('save',save(emptyWorkspace()),true);assert.equal(writes,1);
});
test('workspace atomic store restores snapshots and uncertain edits, detects external changes without replacement',()=>{
 const root=path.resolve('.local/workspace-tests'),folder=path.join(root,randomUUID());fs.mkdirSync(root,{recursive:true});const store=createWorkspaceStore(root,folder),state=store.load(),document={id:randomUUID(),name:'synthetic.txt',text:'before',startLine:1,endLine:1,totalLines:1};
 state.projects[0]!.files={documents:[document],active:document.id,start:1,end:1};state.projects[0]!.jobs=[{id:randomUUID(),sessionId:randomUUID(),document,excerpt:{...document,id:randomUUID()},status:'uncertain',after:'after'}];store.save(state);
 assert.deepEqual(createWorkspaceStore(root,folder).load(),state);const target=path.join(folder,'workspace.json');fs.writeFileSync(target,'external change');assert.throws(()=>store.save(state));assert.equal(fs.readFileSync(target,'utf8'),'external change');assert.throws(()=>createWorkspaceStore(root,folder).load());
});
test('ordered renderer writes preserve newer edits after an older acknowledgement',async()=>{
 let disk=emptyWorkspace(),release:()=>void=()=>{},calls=0;const controller=createWorkspaceController({read:async()=>({ok:true,value:disk}),save:async request=>{calls++;if(calls===1)await new Promise<void>(r=>release=r);assert.equal(request.expectedRevision,disk.revision);disk=parseWorkspaceDisk({...request.state,revision:disk.revision+1});return {ok:true,value:disk};}});await controller.start();
 const first=controller.change(s=>({...s,projects:[{...s.projects[0]!,name:'first'}]})),second=controller.change(s=>({...s,projects:[{...s.projects[0]!,name:'second'}]}));await Promise.resolve();assert.equal(controller.snapshot().disk!.projects[0]!.name,'second');release();assert.ok(await first);assert.ok(await second);assert.equal(disk.projects[0]!.name,'second');assert.equal(disk.revision,2);
});
test('confirmed proposal states are not displayed before persistence; final write failure retains uncertainty',async()=>{
 let disk=emptyWorkspace(),release:()=>void=()=>{},fail=false;const controller=createWorkspaceController({read:async()=>({ok:true,value:disk}),save:async request=>{await new Promise<void>(r=>release=r);if(fail)return {ok:false,error:{code:'STORAGE_ERROR'}};disk=parseWorkspaceDisk({...request.state,revision:disk.revision+1});return {ok:true,value:disk};}});await controller.start();
 const marker=controller.change(s=>({...s,projects:[{...s.projects[0]!,name:'uncertain'}]}),true);await Promise.resolve();assert.equal(controller.snapshot().disk!.projects[0]!.name,'默认项目');release();assert.ok(await marker);assert.equal(controller.snapshot().disk!.projects[0]!.name,'uncertain');
 fail=true;const final=controller.change(s=>({...s,projects:[{...s.projects[0]!,name:'saved'}]}),true);await Promise.resolve();assert.equal(controller.snapshot().disk!.projects[0]!.name,'uncertain');release();assert.equal(await final,false);assert.equal(controller.snapshot().disk!.projects[0]!.name,'uncertain');assert.equal(disk.projects[0]!.name,'uncertain');assert.equal(controller.snapshot().status,'error');
});
test('edits arriving during a confirmed state change execute afterwards without loss',async()=>{
 let disk=emptyWorkspace(),release:()=>void=()=>{},calls=0;const controller=createWorkspaceController({read:async()=>({ok:true,value:disk}),save:async request=>{if(++calls===1)await new Promise<void>(r=>release=r);disk=parseWorkspaceDisk({...request.state,revision:disk.revision+1});return {ok:true,value:disk};}});await controller.start();
 const first=controller.change(s=>({...s,projects:[...s.projects,newProject(randomUUID(),'new')]}),true),second=controller.change(s=>({...s,projects:s.projects.map(p=>p.id===DEFAULT_PROJECT?{...p,name:'renamed'}:p)}));await Promise.resolve();release();assert.ok(await first);assert.ok(await second);assert.equal(disk.projects.length,2);assert.equal(disk.projects[0]!.name,'renamed');
});
test('both workspace IPC methods fence their exact window owner and reject after revocation',()=>{
 const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'s',windowId:'w',webContentsId:1,workspaceId:'ws',rootId:'r'},handlers=new Map<string,(event:unknown,value:unknown)=>unknown>();let caller:unknown=owner,writes=0;
 const register=workspaceExtension({root:path.resolve('.'),directory:path.resolve('.local/workspace-ipc'),store:{load:emptyWorkspace,save:()=>{writes++;}}}),extension=register({owner,deriveCallerContext:()=>caller,ipcMain:{handle:(key:string,fn:(event:unknown,value:unknown)=>unknown)=>handlers.set(key,fn),removeHandler:(key:string)=>handlers.delete(key)}} as unknown as Parameters<typeof register>[0]);
 assert.deepEqual([...handlers.keys()],[workspaceChannel('read'),workspaceChannel('save')]);
 for(const foreign of [null,{...owner,isTopFrame:false},{...owner,webContentsId:2},{...owner,navigationEpoch:2},{...owner,workspaceId:'elsewhere'}]){caller=foreign;for(const method of ['read','save'] as const)assert.deepEqual(handlers.get(workspaceChannel(method))!({},method==='read'?read:save(emptyWorkspace())),{ok:false,error:{code:'CAPABILITY_DENIED'}});}
 assert.equal(writes,0);caller=owner;assert.equal((handlers.get(workspaceChannel('read'))!({},read) as {ok:boolean}).ok,true);extension.revoke();for(const method of ['read','save'] as const)assert.deepEqual(handlers.get(workspaceChannel(method))!({},method==='read'?read:save(emptyWorkspace())),{ok:false,error:{code:'CAPABILITY_DENIED'}});extension.dispose();assert.equal(handlers.size,0);
});
