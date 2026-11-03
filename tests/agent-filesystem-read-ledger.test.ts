import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {parseFileSystemToolArguments} from '../apps/desktop/src/shared/agent/agent-filesystem-read';
import {parseChatTurnExecution} from '../apps/desktop/src/shared/agent/chat-turns';
import {parseProjectReadEvent,parseProjectReadResult,parseProjectReadValue} from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import {parseProjectReadDisk,readProjectReadPage,projectReadDependents,type ProjectReadStoredRun} from '../apps/desktop/src/main/agent-project-read/store';
import {reconcileChatTurn,readChatTurnRun} from '../apps/desktop/src/main/cloud/unified-chat-ledger';
import type {SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';
import type * as C from '../apps/desktop/src/shared/agent/agent-project-read';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const time='2026-09-17T03:00:00.000Z',sid='00000000-0000-4000-8000-000000000001',tid='00000000-0000-4000-8000-000000000002',pid='00000000-0000-4000-8000-000000000003';
const model={provider:'kimi',model:'kimi-k3'} as const;
const root={projectId:pid,bindingId:'binding',root:'C:\\Synthetic',chain:[{dev:'1',ino:'1'},{dev:'1',ino:'2'}]};
const bound:C.BoundProjectReadRef={projectId:pid,bindingId:'binding',identity:hash('root'),name:'Organization',directoryName:'Synthetic',directorySegments:['C','Synthetic']};
const unbound:C.ProjectReadRef={projectId:pid,bindingId:null,identity:null,name:'Organization',directoryName:null,directorySegments:[]};
const budget:C.ProjectReadBudget={providerAttempts:24,httpDispatches:24,toolAttempts:64,physicalReadBytes:268435456,visitedCandidates:100000,contextBytes:196608,outputBytes:65536,maxOutputTokens:16384,deadlineMs:14400000,waitMs:1800000};
const zero={providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null};
function row(id:string,project:C.ProjectReadRef,late=false,parent:ProjectReadStoredRun|null=null):ProjectReadStoredRun{
 const origin={chatSessionId:sid,turnId:id==='parent'?'00000000-0000-4000-8000-000000000004':tid,executionId:id+'-execution',inputDigest:hash('input')};
 const workCycle=late?{workspaceId:id+'-work',...(parent?{continuation:{runId:parent.run.runId,workspaceId:parent.run.workCycle!.workspaceId,eventCount:parent.run.eventCount,baselineVersion:hash('baseline')}}:{})}:id==='parent'?{workspaceId:'parent-work'}:undefined;
 const events:C.ProjectReadEvent[]=[];
 const add=(type:keyof C.ProjectReadEventData,data:unknown)=>{const event=parseProjectReadEvent({runId:id,sequence:events.length+1,time,type,data});assert(event,type);events.push(event);};
 add('run.accepted',{project,model,continuedFrom:null,budget,origin,...(!late&&workCycle?{workCycle}:{})});
 add('run.started',{sessionId:'native',engine:'opencode',version:'1.18.17'});
 if(late){add('model.step',{step:1});for(let n=0;n<62;n++)add('message.delta',{messageId:'reply',step:1,text:'x'});add('work.prepared',{workCycle,continuedFrom:parent?.run.runId??null});}
 add('cleanup.started',{reason:'completed'});add('cleanup.completed',{outcome:'confirmed'});add('run.completed',{citations:[]});
 return {run:{runId:id,clientRequestId:id+'-request',project,model,goal:'synthetic',constraint:'',continuedFrom:parent?.run.runId??null,status:'completed',cleanupState:'idle',createdAt:time,updatedAt:time,accounting:zero,eventCount:events.length,continuation:null,events,origin,...(workCycle?{workCycle}:{})},root:project.bindingId===null?null:root,citations:[]};
}
test('filesystem arguments preserve exact issued target and reject ambiguous cursor or accessor input',()=>{
 const read={path:'C:\\Synthetic\\notes.log',fileId:null,version:null,start:{line:1,column:1},cursor:null};
 assert.deepEqual(parseFileSystemToolArguments('fs_read',read),read);
 assert.equal(parseFileSystemToolArguments('fs_read',{...read,fileId:'file'}),null);
 assert.equal(parseFileSystemToolArguments('fs_read',{...read,cursor:'cursor'}),null);
 const hidden=Object.defineProperty({column:1},'line',{value:1,enumerable:false});assert.equal(parseFileSystemToolArguments('fs_read',{...read,start:hidden}),null);
 const search={path:null,fileId:'issued-file',directoryId:null,cursor:'cursor',query:'literal',refresh:false};assert.deepEqual(parseFileSystemToolArguments('fs_search',search),search);
 assert.equal(parseFileSystemToolArguments('fs_search',{...search,directoryId:'other'}),null);
});
test('unbound read ledger cold parsing never touches sources and cannot carry work authority',t=>{
 const value=row('read',unbound),sourceRoot={root:'C:\\Synthetic',chain:root.chain};
 const disk={version:1,runs:[{...value,sources:[{root:sourceRoot,source:{kind:'windows_filesystem',sourceId:'source',rootPath:sourceRoot.root,rootIdentity:hash(JSON.stringify(sourceRoot))}}]}]};
 t.mock.method(fs,'lstatSync',()=>assert.fail('cold source stat'));t.mock.method(fs,'openSync',()=>assert.fail('cold source open'));
 assert(parseProjectReadDisk(disk));assert.equal(parseProjectReadDisk({...disk,runs:[{...disk.runs[0],run:{...value.run,workCycle:{workspaceId:'forged'}}}]}),null);
 assert.equal(parseProjectReadValue('listRuns',{runs:[(({origin:_,events:__,...summary})=>summary)(value.run)],nextBefore:null}),null);
});
test('late work receipt supplies exact cross-page proof and participates in the normal parent graph',()=>{
 const parent=row('parent',bound),child=row('child',bound,true,parent),disk={version:1 as const,runs:[parent,child]};
 assert(parseProjectReadDisk(disk));assert.deepEqual(projectReadDependents(disk,'parent'),['child']);
 const page=readProjectReadPage(disk,'child',0);assert(page.ok);assert.equal(page.value.events.length,64);assert(!page.value.events.some(e=>e.type==='work.prepared'));assert(page.value.workPreparation);assert.equal(page.value.workPreparation.data.continuedFrom,'parent');
 const {workPreparation:_,...missing}=page.value;assert.equal(parseProjectReadResult('readRun',{ok:true,value:missing}),null);
 assert.equal(parseProjectReadResult('readRun',{ok:true,value:{...page.value,workPreparation:{...page.value.workPreparation,data:{...page.value.workPreparation.data,continuedFrom:'other'}}}}),null);
 const forged=structuredClone(child);const receipt=forged.run.events.findIndex(e=>e.type==='work.prepared');
 (forged.run.events as C.ProjectReadEvent[])[receipt]={...forged.run.events[receipt]!,type:'message.delta',data:{messageId:'reply',step:1,text:'missing receipt'}} as C.ProjectReadEvent;
 assert.equal(parseProjectReadDisk({version:1,runs:[parent,forged]}),null);
});
test('cold reconciliation promotes only the exact bound run link backed by a work receipt',()=>{
 const stored=row('child',bound,true),run=stored.run;
 const execution=parseChatTurnExecution({executionId:run.origin!.executionId,version:1,requestDigest:hash('input'),acceptedContext:{projectId:pid,workspaceRevision:1,bindingId:bound.bindingId,bindingIdentity:bound.identity,...model,historyVersion:hash('history')},phase:'running',cleanupState:'idle',runLink:{runId:run.runId,workspaceId:null},readOnlyScope:true,parentTurnId:null,pendingInteraction:null});
 const turn:SessionTurn={id:tid,user:'synthetic',assistant:'',status:'running',error:'',...model,execution};const lookup={chatRun:()=>run,chatRuns:()=>[run]};
 assert.throws(()=>readChatTurnRun(lookup,sid,turn));const next=reconcileChatTurn(lookup,sid,turn);assert.equal(next.runLink!.workspaceId,'child-work');assert.equal(next.readOnlyScope,undefined);
 assert.throws(()=>reconcileChatTurn({...lookup,chatRun:()=>({...run,events:run.events.filter(e=>e.type!=='work.prepared')}),chatRuns:()=>[{...run,events:run.events.filter(e=>e.type!=='work.prepared')}]},sid,{...turn,assistant:''}));
 assert.throws(()=>parseChatTurnExecution({...execution,acceptedContext:{...execution.acceptedContext,bindingId:null,bindingIdentity:null},runLink:{runId:run.runId,workspaceId:'child-work'}}));
});
