import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkCycleBroker} from '../apps/desktop/src/main/agent-work-cycle/broker';
import {WorkCycleError,type WorkCycleWorkspace,type WorkCycleRunner} from '../apps/desktop/src/main/agent-work-cycle/types';
import {PROJECT_READ_LIMITS as L,type ProjectReadToolCall,type ProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read';

const unexpected=():never=>{throw Error('Read-only listing must not invoke mutation or execution');};
function fixture(unbounded:boolean){
  let lists=0,published=0,workspaceCloses=0,runnerCloses=0;
  const workspace:WorkCycleWorkspace={
    ref:{workspaceId:'work-unbounded'},list:()=>{lists++;return [];},close:async()=>{workspaceCloses++;},
    exportConfirmedBase:unexpected,confirmSeed:unexpected,read:unexpected,change:unexpected,write:unexpected,edit:unexpected,
    importFile:unexpected,snapshot:unexpected,acceptExecution:unexpected,publishCommandArtifacts:unexpected,confirmCommandArtifacts:unexpected,confirm:unexpected,
  };
  const runner:WorkCycleRunner={available:unexpected,run:unexpected,close:async()=>{runnerCloses++;}};
  const broker=createWorkCycleBroker({workspace,runner,signal:new AbortController().signal,...(unbounded?{maxToolCalls:null}:{}),
    authorize:()=>true,canDeliver:()=>true,remainingToolBytes:()=>L.runBytes,publish:async()=>{published++;},importSource:unexpected});
  return {broker,counts:()=>({lists,published,workspaceCloses,runnerCloses})};
}
const call=(id:number):ProjectReadToolCall=>({sessionId:'session',messageId:'message',callId:`call_${id}`,toolName:'work_list',arguments:{}});

test('ordinary chat work_list exceeds 64 calls and preserves pending/completed call-id idempotency',async()=>{
  const f=fixture(true);let last:ProjectReadToolResult|undefined;
  try{
    const first=f.broker.execute(call(0));assert.strictEqual(f.broker.execute(call(0)),first);last=await first;
    for(let i=1;i<70;i++){last=await f.broker.execute(call(i));assert.deepEqual(last,{ok:true,value:{kind:'work_list',files:[]}});}
    assert.deepEqual(await f.broker.execute(call(69)),last);
    assert.deepEqual(f.counts(),{lists:70,published:70,workspaceCloses:0,runnerCloses:0});
    await assert.rejects(f.broker.execute({...call(69),messageId:'different'}),e=>e instanceof WorkCycleError&&e.code==='CONFLICT');
    assert.equal(f.counts().published,70);
  }finally{await f.broker.close();}
  assert.deepEqual(f.counts(),{lists:70,published:70,workspaceCloses:1,runnerCloses:1});
});

test('legacy work broker denies its 65th distinct call but still serves an existing call receipt',async()=>{
  const f=fixture(false);let last:ProjectReadToolResult|undefined;
  try{
    for(let i=0;i<L.toolCalls;i++)last=await f.broker.execute(call(i));
    await assert.rejects(f.broker.execute(call(L.toolCalls)),e=>e instanceof WorkCycleError&&e.code==='BUDGET_EXCEEDED');
    assert.deepEqual(await f.broker.execute(call(L.toolCalls-1)),last);
    assert.deepEqual(f.counts(),{lists:64,published:64,workspaceCloses:0,runnerCloses:0});
  }finally{await f.broker.close();}
});
