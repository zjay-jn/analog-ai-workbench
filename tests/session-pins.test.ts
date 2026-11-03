import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_PROJECT,WORKSPACE_VERSION,emptyWorkspace,newProject,parseWorkspaceDisk,projectForSession} from '../apps/desktop/src/shared/agent/project-workspace';
import {createWorkspaceHost,createWorkspaceStore} from '../apps/desktop/src/main/cloud/project-workspace-host';
import {createWorkspaceController} from '../apps/desktop/src/renderer/agent/workspace-controller';
import {setSessionPinned,reconcileSessionPins} from '../apps/desktop/src/renderer/agent/session-pins';

test('older workspace data remains unchanged and pins accept only a bounded unique UUID list',()=>{
 const old=emptyWorkspace(),id=randomUUID();
 assert.deepEqual(parseWorkspaceDisk(old),old);assert(!Object.hasOwn(parseWorkspaceDisk(old),'pinnedSessionIds'));
 assert.deepEqual(parseWorkspaceDisk({...old,pinnedSessionIds:[id]}).pinnedSessionIds,[id]);
 const getter=[id];Object.defineProperty(getter,'0',{get(){throw new Error('Untrusted getter must not run');},enumerable:true,configurable:true});
 for(const value of [undefined,null,'pinned',{},[id,id],['not-a-uuid'],[id.toUpperCase()],Array.from({length:51},()=>randomUUID()),new Array(1),getter]){
  assert.throws(()=>parseWorkspaceDisk({...old,pinnedSessionIds:value}));
 }
 assert.throws(()=>parseWorkspaceDisk({...old,pinnedSessionIds:[],unknown:true}));
});

test('pin and unpin preserve manual order, selection and project ownership without redundant updates',()=>{
 const original=emptyWorkspace(),first=randomUUID(),second=randomUUID();
 original.projects[0]!.sessionIds=[first,second];original.projects[0]!.selectedId=second;
 assert.equal(setSessionPinned(original,first,false),original);
 const one=setSessionPinned(original,first,true),two=setSessionPinned(one,second,true);
 assert.deepEqual(two.pinnedSessionIds,[first,second]);assert.equal(setSessionPinned(two,first,true),two);
 assert.equal(two.projects,original.projects);assert.equal(two.activeId,original.activeId);
 const removed=setSessionPinned(two,first,false),repinned=setSessionPinned(removed,first,true);
 assert.deepEqual(removed.pinnedSessionIds,[second]);assert.deepEqual(repinned.pinnedSessionIds,[second,first]);
 assert(!Object.hasOwn(original,'pinnedSessionIds'));
});

test('pins survive project moves and stale deleted IDs reconcile against confirmed chat IDs',()=>{
 const first=randomUUID(),second=randomUUID(),third=randomUUID(),state=setSessionPinned(setSessionPinned(setSessionPinned(emptyWorkspace(),first,true),second,true),third,true);
 state.projects[0]!.sessionIds=[first,second,third];
 const destination=newProject(randomUUID(),'Synthetic destination');destination.sessionIds=[first];
 const moved=parseWorkspaceDisk({...state,projects:[{...state.projects[0]!,sessionIds:[second,third]},destination]});
 assert.deepEqual(moved.pinnedSessionIds,[first,second,third]);assert.equal(projectForSession(moved,first),destination.id);
 assert.equal(reconcileSessionPins(moved,[third,first,second]),moved);
 const afterDelete=reconcileSessionPins({...moved,projects:moved.projects.map(p=>({...p,sessionIds:p.sessionIds.filter(id=>id!==second)}))},[first,third]);
 assert.deepEqual(parseWorkspaceDisk(afterDelete).pinnedSessionIds,[first,third]);
 // Missing project membership still resolves to the default project while the
 // confirmed chat survives; pin reconciliation must not treat it as deletion.
 const unassigned=setSessionPinned(emptyWorkspace(),first,true);
 assert.equal(projectForSession(unassigned,first),DEFAULT_PROJECT);assert.equal(reconcileSessionPins(unassigned,[first]),unassigned);
 assert.deepEqual(reconcileSessionPins(afterDelete,[]).pinnedSessionIds,[]);
});

test('pins round-trip through the real atomic workspace store and revision guarded host',()=>{
 const root=path.resolve('.local/sidebar-pins-20261027/unit'),directory=path.join(root,randomUUID());fs.mkdirSync(root,{recursive:true});
 const store=createWorkspaceStore(root,directory),host=createWorkspaceHost(store),first=randomUUID(),second=randomUUID();
 const loaded=host.invoke('read',{contractVersion:WORKSPACE_VERSION},true);assert(loaded.ok);
 const next=setSessionPinned(setSessionPinned(loaded.value,first,true),second,true);
 const request={contractVersion:WORKSPACE_VERSION,expectedRevision:loaded.value.revision,state:next};
 assert.deepEqual(host.invoke('save',request,false),{ok:false,error:{code:'CAPABILITY_DENIED'}});
 const saved=host.invoke('save',request,true);assert(saved.ok);assert.equal(saved.value.revision,1);
 assert.deepEqual(host.invoke('save',request,true),{ok:false,error:{code:'CONFLICT'}});
 const reopened=createWorkspaceHost(createWorkspaceStore(root,directory)),cold=reopened.invoke('read',{contractVersion:WORKSPACE_VERSION},true);assert(cold.ok);
 assert.deepEqual(cold.value.pinnedSessionIds,[first,second]);assert.equal(cold.value.revision,1);
 cold.value.pinnedSessionIds!.reverse();const readAgain=reopened.invoke('read',{contractVersion:WORKSPACE_VERSION},true);assert(readAgain.ok);assert.deepEqual(readAgain.value.pinnedSessionIds,[first,second]);
});

test('confirmed pin changes wait for persistence and failures retain the prior visible pin state',async()=>{
 let disk=emptyWorkspace(),release:()=>void=()=>{},fail=false;
 const controller=createWorkspaceController({read:async()=>({ok:true,value:disk}),save:async request=>{await new Promise<void>(resolve=>release=resolve);if(fail)return {ok:false,error:{code:'STORAGE_ERROR'}};disk=parseWorkspaceDisk({...request.state,revision:disk.revision+1});return {ok:true,value:disk};}});
 await controller.start();const id=randomUUID(),pin=controller.change(state=>setSessionPinned(state,id,true),true);await Promise.resolve();
 assert.deepEqual(controller.snapshot().disk!.pinnedSessionIds??[],[]);release();assert.equal(await pin,true);assert.deepEqual(controller.snapshot().disk!.pinnedSessionIds,[id]);
 fail=true;const unpin=controller.change(state=>setSessionPinned(state,id,false),true);await Promise.resolve();
 assert.deepEqual(controller.snapshot().disk!.pinnedSessionIds,[id]);release();assert.equal(await unpin,false);
 assert.deepEqual(controller.snapshot().disk!.pinnedSessionIds,[id]);assert.deepEqual(disk.pinnedSessionIds,[id]);assert.equal(controller.snapshot().status,'error');
});
