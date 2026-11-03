import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyWorkspace,newProject,parseWorkspaceDisk,type WorkspaceDisk} from '../apps/desktop/src/shared/agent/project-workspace';
import type {WorkbenchProjectFoldersApi,ProjectFolderCreation,ProjectFolderSelection} from '../apps/desktop/src/shared/agent/project-folders';
import {createWorkspaceController} from '../apps/desktop/src/renderer/agent/workspace-controller';
import {createProjectCreationController} from '../apps/desktop/src/renderer/agent/project-creation-controller';
test('initial workspace read cannot admit child effect writes before creation recovery checks',async()=>{
 const disk=emptyWorkspace();let saves=0;const c=createWorkspaceController({read:async()=>({ok:true,value:disk}),save:async()=>{saves++;return {ok:true,value:disk};}},{requireInitialExternal:true});
 await c.start();assert.equal(await c.change(s=>({...s,projects:[{...s.projects[0]!,name:'early effect'}]})),false);assert.equal(saves,0);
 assert.ok(await c.runExternal(async()=>({ok:true,creation:null,workspace:disk})));assert.equal(c.snapshot().status,'saved');assert.equal(await c.change(s=>s),true);
});
type MutableApi={-readonly [M in keyof WorkbenchProjectFoldersApi]:WorkbenchProjectFoldersApi[M]};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function fixture(){
 let disk=emptyWorkspace(),creation:ProjectFolderCreation|null=null,saves=0,browses=0,cancels=0,complete=0;
 const projectId=randomUUID(),selection:ProjectFolderSelection={ticketId:randomUUID(),creationId:randomUUID(),projectId,binding:{projectId,bindingId:randomUUID(),name:'synthetic',segments:['C','synthetic']}};
 const workspace=createWorkspaceController({read:async()=>({ok:true,value:disk}),save:async request=>{disk=parseWorkspaceDisk({...request.state,revision:disk.revision+1});return {ok:true,value:disk};}});
 const api:MutableApi={
  chooseFolder:async()=>{browses++;return {ok:true,selection};},
  cancelSelection:async()=>{cancels++;return {ok:true};},
  bindFolder:async()=>assert.fail('creation does not bind an existing project'),
  readCreation:async()=>({ok:true,creation,workspace:disk}),
  saveCreation:async request=>{saves++;assert.equal(request.expectedRevision,disk.revision);assert.equal(request.creationId,selection.creationId);assert.equal(request.name,'新项目');
   if(!disk.projects.some(p=>p.id===projectId))disk={...disk,revision:disk.revision+1,activeId:projectId,projects:[...disk.projects,newProject(projectId,request.name)]};
   creation={creationId:selection.creationId,projectId,name:request.name,status:'complete',binding:selection.binding};return {ok:true,creation,workspace:disk};},
  readBinding:async()=>({ok:true,projectId,binding:selection.binding}),list:async()=>({ok:false,error:{code:'NOT_BOUND'}}),open:async()=>({ok:false,error:{code:'NOT_BOUND'}}),
 };
 const controller=createProjectCreationController(api,workspace.runExternal,()=>complete++);
 return {api,workspace,controller,selection,disk:()=>disk,counts:()=>({saves,browses,cancels,complete}),setCreation:(value:ProjectFolderCreation|null)=>{creation=value;}};
}
test('browsing and cancelling new project never creates an empty project',async()=>{
 const f=fixture();await f.workspace.start();await f.controller.start();await f.controller.begin();await f.controller.save();assert.equal(f.counts().saves,0);
 await f.controller.browse();assert.equal(f.disk().projects.length,1);await f.controller.cancel();assert.equal(f.disk().projects.length,1);assert.deepEqual(f.counts(),{saves:0,browses:1,cancels:1,complete:0});assert.equal(f.controller.snapshot().open,false);
});
test('native browser cancellation retains previous choice and repeated browse preserves creation identity',async()=>{
 const f=fixture();await f.workspace.start();await f.controller.start();await f.controller.begin();await f.controller.browse();
 f.api.chooseFolder=async request=>{assert.equal(request.creationId,f.selection.creationId);return {ok:false,error:{code:'CANCELLED'}};};
 await f.controller.browse();assert.equal(f.controller.snapshot().selection?.ticketId,f.selection.ticketId);assert.equal(f.controller.snapshot().error,'');assert.equal(f.counts().saves,0);
});
test('save adopts main workspace once and next normal write uses its revision',async()=>{
 const f=fixture();await f.workspace.start();await f.controller.start();await f.controller.begin();await f.controller.browse();await f.controller.save();
 assert.equal(f.disk().projects.length,2);assert.equal(f.workspace.snapshot().disk?.activeId,f.selection.projectId);assert.equal(f.counts().complete,1);
 await f.workspace.change(s=>({...s,projects:s.projects.map(p=>p.id===f.selection.projectId?{...p,name:'renamed'}:p)}));assert.equal(f.disk().revision,2);assert.equal(f.disk().projects[1]?.name,'renamed');
});
test('duplicate save while original is pending does not issue another request',async()=>{
 const f=fixture();await f.workspace.start();await f.controller.start();await f.controller.begin();await f.controller.browse();const hold=deferred<void>(),save=f.api.saveCreation;let calls=0;
 f.api.saveCreation=async request=>{calls++;await hold.promise;return save(request);};const first=f.controller.save();await f.controller.save();hold.resolve();await first;assert.equal(calls,1);assert.equal(f.disk().projects.length,2);
});
test('lost accepted save acknowledgement locks writes until explicit healthy read recovers same project',async()=>{
 const f=fixture();await f.workspace.start();await f.controller.start();await f.controller.begin();await f.controller.browse();const save=f.api.saveCreation;
 f.api.saveCreation=async request=>{await save(request);throw Error('lost acknowledgement');};await f.controller.save();assert.equal(f.controller.snapshot().uncertain,true);
 assert.equal(await f.workspace.change(s=>({...s,activeId:s.projects[0]!.id})),false);assert.equal(f.counts().saves,1);await f.controller.inspect();
 assert.equal(f.controller.snapshot().open,false);assert.equal(f.disk().projects.length,2);assert.equal(f.workspace.snapshot().disk?.activeId,f.selection.projectId);assert.equal(f.counts().saves,1);assert.equal(f.counts().complete,1);
});
test('restart pending only reads state and locks unrelated changes until explicit continue',async()=>{
 const f=fixture();f.setCreation({creationId:f.selection.creationId,projectId:f.selection.projectId,name:'新项目',status:'pending',binding:f.selection.binding});
 await f.workspace.start();await f.controller.start();assert.equal(f.controller.snapshot().open,true);assert.equal(f.controller.snapshot().creation?.status,'pending');assert.equal(f.counts().saves,0);
 assert.equal(await f.workspace.change(s=>({...s,projects:s.projects.map(p=>({...p,name:'forbidden'}))})),false);await f.controller.cancel();assert.equal(f.controller.snapshot().open,false);
 assert.equal(await f.workspace.change(s=>s),false);await f.controller.inspect();await f.controller.save();assert.equal(f.counts().saves,1);assert.equal(f.workspace.snapshot().status,'saved');
});
test('unreadable creation state never unlocks workspace or silently repeats save',async()=>{
 const f=fixture();await f.workspace.start();f.api.readCreation=async()=>({ok:false,error:{code:'STORAGE_ERROR'}});await f.controller.start();
 assert.equal(f.controller.snapshot().uncertain,true);assert.equal(await f.workspace.change(s=>s),false);await f.controller.save();assert.equal(f.counts().saves,0);await f.controller.inspect();assert.equal(f.controller.snapshot().uncertain,true);
});
test('external creation drains confirmed and already waiting workspace edits while rejecting newly arriving edits',async()=>{
 let disk=emptyWorkspace(),calls=0;const hold=deferred<void>(),events:string[]=[];
 const c=createWorkspaceController({read:async()=>({ok:true,value:disk}),save:async request=>{calls++;if(calls===1)await hold.promise;disk={...request.state,revision:disk.revision+1};events.push(disk.projects[0]!.name);return {ok:true,value:disk};}});await c.start();
 const first=c.change(s=>({...s,projects:[{...s.projects[0]!,name:'first'}]}),true);
 const second=c.change(s=>({...s,projects:[{...s.projects[0]!,name:'second'}]}));
 const external=c.runExternal(async revision=>{assert.equal(revision,2);events.push('external');return {ok:true,workspace:disk};});
 assert.equal(await c.change(s=>({...s,projects:[{...s.projects[0]!,name:'too late'}]})),false);hold.resolve();
 assert.ok(await first);assert.ok(await second);assert.ok(await external);assert.deepEqual(events,['first','second','external']);assert.equal(c.snapshot().disk?.projects[0]?.name,'second');
});
test('ordinary workspace storage failure cannot be bypassed by external snapshot adoption',async()=>{
 const c=createWorkspaceController({read:async()=>({ok:true,value:emptyWorkspace()}),save:async()=>({ok:false,error:{code:'STORAGE_ERROR'}})});await c.start();assert.equal(await c.change(s=>({...s,projects:[{...s.projects[0]!,name:'unsaved'}]})),false);let calls=0;
 assert.equal(await c.runExternal(async()=>{calls++;return {ok:true,workspace:emptyWorkspace()};}),undefined);assert.equal(calls,0);assert.equal(c.snapshot().disk?.projects[0]?.name,'unsaved');
});
test('stale or malformed external workspace retains current state and requires explicit reconciliation',async()=>{
 const f=fixture();await f.workspace.start();await f.workspace.change(s=>({...s,projects:[{...s.projects[0]!,name:'current'}]}));
 assert.equal(await f.workspace.runExternal(async()=>({ok:true,workspace:emptyWorkspace()})),undefined);assert.equal(f.workspace.snapshot().disk?.projects[0]?.name,'current');assert.equal(await f.workspace.change(s=>s),false);
 assert.ok(await f.workspace.runExternal(async()=>({ok:true,workspace:f.disk()})));assert.equal(await f.workspace.change(s=>s),true);
});
