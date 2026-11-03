import test from 'node:test';import assert from 'node:assert/strict';
import {runSessionOperation} from '../apps/desktop/src/renderer/agent/session-operations';
import type {SessionState} from '../apps/desktop/src/shared/agent/chat-sessions';
import {createWorkspaceController} from '../apps/desktop/src/renderer/agent/workspace-controller';
import {emptyWorkspace,newProject,projectForSession,DEFAULT_PROJECT,type WorkspaceDisk} from '../apps/desktop/src/shared/agent/project-workspace';
const session={id:'00000000-0000-4000-8000-000000000004',title:'Synthetic',provider:'deepseek' as const,createdAt:'2026-09-08T00:00:00.000Z',updatedAt:'2026-09-08T00:00:00.000Z'};
const state:SessionState={revision:1,selectedId:session.id,sessions:[session],selected:{...session,turns:[]},runningSessionId:null,storage:'saved',configured:{deepseek:true,kimi:false}};
test('created session survives project persistence failure as partial success without recreation',async()=>{
 let creates=0,confirmations=0,visible:SessionState|null=null;const result=await runSessionOperation(async()=>{creates++;return {ok:true,value:state};},value=>{visible=value;},async()=>{confirmations++;return false;});
 assert.equal(result.status,'partial');assert.equal((visible as SessionState|null)?.selectedId,session.id);assert.equal(creates,1);assert.equal(confirmations,1);
});
test('throwing project persistence is also partial, while reliable refusal does not assign',async()=>{
 let assigned=0;assert.equal((await runSessionOperation(async()=>({ok:true,value:state}),()=>{},async()=>{assigned++;throw Error('synthetic project ACK lost');})).status,'partial');
 for(const code of ['INVALID_REQUEST','CAPABILITY_DENIED','NOT_FOUND','BUSY','LIMIT','NOT_CONFIGURED'])assert.equal((await runSessionOperation(async()=>({ok:false,error:{code}}),()=>assert.fail(),async()=>{assigned++;return true;})).status,'rejected');assert.equal(assigned,1);
});
test('lost malformed or internal/storage ACK stays uncertain; no project write or automatic retry',async()=>{
 let calls=0;for(const invoke of [async()=>{throw Error('synthetic lost ACK');},async()=>({ok:true,value:{}}),async()=>({ok:false,error:{code:'INTERNAL'}}),async()=>({ok:false,error:{code:'STORAGE_ERROR'}})])assert.equal((await runSessionOperation(async()=>{calls++;return invoke();},()=>assert.fail(),async()=>assert.fail())).status,'uncertain');assert.equal(calls,4);
});
test('failed confirmed assignment keeps created session discoverable in default project',async()=>{
 const disk=emptyWorkspace(),project=newProject('00000000-0000-4000-8000-000000000005','Synthetic project');disk.projects.push(project);disk.activeId=project.id;let writes=0,creates=0,visible:SessionState|null=null;
 const workspace=createWorkspaceController({read:async()=>({ok:true,value:disk}),save:async()=>{writes++;return {ok:false,error:{code:'STORAGE_ERROR'}};}});await workspace.start();
 const result=await runSessionOperation(async()=>{creates++;return {ok:true,value:state};},value=>{visible=value;},()=>workspace.change(s=>({...s,projects:s.projects.map(p=>p.id===project.id?{...p,sessionIds:[session.id],selectedId:session.id}:p)}),true));
 assert.equal(result.status,'partial');assert.equal(projectForSession(workspace.snapshot().disk!,session.id),DEFAULT_PROJECT);assert.equal(workspace.snapshot().status,'error');assert.equal((visible as SessionState|null)?.selectedId,session.id);assert.equal(writes,1);assert.equal(creates,1);
 // Recovery navigation is a renderer-only view of the unchanged confirmed disk.
 const before=JSON.stringify(workspace.snapshot().disk),view:WorkspaceDisk={...workspace.snapshot().disk!,activeId:projectForSession(workspace.snapshot().disk!,session.id)};assert.equal(view.activeId,DEFAULT_PROJECT);assert.equal(JSON.stringify(workspace.snapshot().disk),before);
 assert.equal((await runSessionOperation(async()=>({ok:true,value:state}),value=>{visible=value;})).status,'accepted');assert.equal(writes,1);assert.equal(creates,1);
});
