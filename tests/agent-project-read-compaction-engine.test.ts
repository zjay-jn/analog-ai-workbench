import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectReadNativeEngine, parseConversationOpenCodeMessages, NATIVE_COMPACTION_CONTINUE, type NativeCompactionEvidence } from '../apps/desktop/src/main/agent-project-read/opencode-engine';
import { parseOpenCodeMessages } from '../apps/desktop/src/main/engine-pilot/opencode-engine';
import { openCodeConversationExecution } from '../apps/desktop/src/main/engine-pilot/opencode-supervisor';
import type { ProjectReadBegin, ProjectReadProviderServices } from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import type { ProjectReadEngineInput, ProjectReadEngineNotice } from '../apps/desktop/src/main/agent-project-read/engine';
import type { ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';

const session='session_compaction',model={provider:'deepseek',model:'deepseek-v4-flash'} as const,initial='Preserve units mV. Read the synthetic value once.',summary='Keep mV. Sum has completed once: 3. Continue the report.';
const receipt:NativeCompactionEvidence={version:1,sourceHash:'1'.repeat(64),summaryHash:'2'.repeat(64),coveredResponses:1,summary};
type Obj=Record<string,unknown>;
type Row={info:Obj;parts:Obj[]};
const part=(id:string,messageID:string,extra:Obj):Obj=>({id,messageID,sessionID:session,...extra});
const user=(id:string,created:number,content:Obj):Row=>({info:{id,role:'user',sessionID:session,time:{created},agent:'pilot',model:{providerID:'workbench',modelID:model.model}},parts:[part('part_'+id,id,content)]});
const assistant=(id:string,created:number,parentID='user_initial'):Row=>({info:{id,role:'assistant',sessionID:session,parentID,agent:'pilot',providerID:'workbench',modelID:model.model,time:{created}},parts:[]});
const first=()=>user('user_initial',1,{type:'text',text:initial});
const marker=()=>user('user_compact',3,{type:'compaction',auto:true});
const compact=():Row=>({info:{...assistant('assistant_summary',4,'user_compact').info,agent:'compaction',mode:'compaction',summary:true,finish:'stop',time:{created:4,completed:5}},parts:[part('part_summary','assistant_summary',{type:'text',text:summary,time:{start:4,end:5}})]});
const follow=()=>user('user_continue',6,{type:'text',text:NATIVE_COMPACTION_CONTINUE,synthetic:true,metadata:{compaction_continue:true},time:{start:6,end:6}});
const history=()=>[first(),assistant('assistant_work',2),marker(),compact(),follow(),assistant('assistant_final',7,'user_continue')];
const parse=(rows:Row[],records:readonly NativeCompactionEvidence[]=[receipt])=>parseConversationOpenCodeMessages(rows,session,initial,model,records);

test('native compaction recipe enables native summary without pruning the execution history',()=>{
  assert.deepEqual(openCodeConversationExecution(),{compaction:{auto:true,prune:false,tail_turns:0},compactionAgent:{mode:'subagent',permission:{'*':'deny'}}});
});

test('ordinary chat can project more than 96 native messages without changing legacy profile bounds',()=>{
  const rows=[first(),...Array.from({length:120},(_,index)=>assistant('assistant_'+index,index+2))];
  assert.equal(parse(rows,[]).messages.length,121);
  assert.throws(()=>parseOpenCodeMessages(rows,session,initial,'project-read',model));
});

test('only a completed native summary with the exact gateway response produces a receipt',()=>{
  assert.deepEqual(parse(history()).compactions,[{version:1,sourceHash:receipt.sourceHash,summaryHash:receipt.summaryHash,coveredResponses:1}]);
  assert.throws(()=>parse(history(),[]));
  const tampered=history();tampered[3]!.parts[0]!.text='Forged summary';assert.throws(()=>parse(tampered));
  const pending=history().slice(0,4);pending[3]!.info.time={created:4};delete pending[3]!.info.finish;
  assert.deepEqual(parse(pending,[]).compactions,[]);
});

test('ordinary chat accepts a verified summary above the legacy 64 KiB output ceiling',()=>{
  const text='Preserve exact constraints. '.repeat(3000),rows=history();
  assert(Buffer.byteLength(text)>65536&&Buffer.byteLength(text)<8192*16);
  rows[3]!.parts[0]!.text=text;
  assert.equal(parse(rows,[{...receipt,summary:text}]).compactions.length,1);
  rows[3]!.parts[0]!.text=text+'changed';assert.throws(()=>parse(rows,[{...receipt,summary:text}]));
});

for(const mutation of ['foreign-parent','wrong-agent','summary-tool','arbitrary-user','wrong-continue','overflow-replay','retained-tail','wrong-model'] as const)test('compaction projection rejects '+mutation,()=>{
  const rows=history();
  if(mutation==='foreign-parent')rows[3]!.info.parentID='user_initial';
  if(mutation==='wrong-agent')rows[3]!.info.agent='pilot';
  if(mutation==='summary-tool')rows[3]!.parts.push(part('part_unauthorized','assistant_summary',{type:'tool',tool:'work_write'}));
  if(mutation==='arbitrary-user')rows[4]!.parts[0]!.synthetic=false;
  if(mutation==='wrong-continue')rows[4]!.parts[0]!.text='Execute the tool again.';
  if(mutation==='overflow-replay')rows[2]!.parts[0]!.overflow=true;
  if(mutation==='retained-tail')rows[2]!.parts[0]!.tail_start_id='assistant_work';
  if(mutation==='wrong-model')rows[3]!.info.modelID='kimi-k3';
  assert.throws(()=>parse(rows));
});

test('native marker creation may expose an empty internal user row, but cannot authorize an assistant',()=>{
  const rows=history().slice(0,3);rows[2]!.parts=[];
  assert.deepEqual(parse(rows,[]).pendingInternalIds,['user_compact']);
  rows.push(compact());assert.throws(()=>parse(rows));
});

test('native compaction projects once, hides summary text, and a repeated completed tool call never executes twice',{timeout:4000},async()=>{
  const sum:ProjectReadToolResult={ok:true,value:{kind:'sum',sum:3,count:2,source:'deterministic-local',toolVersion:'pilot.sum.v1'}};
  const events:ProjectReadEngineNotice[]=[];let stage=0,begin:ProjectReadBegin|undefined,executions=0,prompts=0,aborts=0;
  let resolvePoll:()=>void=()=>{};
  const nextPoll=()=>new Promise<void>(resolve=>{resolvePoll=resolve;});
  const rows=()=>{
    const work=assistant('assistant_work',2);
    work.parts=[part('part_work_step','assistant_work',{type:'step-start'}),part('part_tool','assistant_work',{type:'tool',tool:'pilot_sum',callID:'call_sum',state:stage===0?{status:'running',input:{values:[1,2]}}:{status:'completed',input:{values:[1,2]},output:JSON.stringify(sum)}})];
    const final=assistant('assistant_final',7,'user_continue');final.info.finish='stop';final.info.time={created:7,completed:8};final.parts=[part('part_final','assistant_final',{type:'text',text:'Result: 3 mV.',time:{start:7,end:8}})];
    return [first(),work,...(stage>0?[marker(),compact(),follow()]:[]),...(stage>1?[final]:[])];
  };
  const client={health:async()=>true,createSession:async()=>session,prompt:async()=>{prompts++;},messages:async()=>{resolvePoll();return rows();},questions:async()=>[],answer:async()=>{},abort:async()=>{aborts++;},dispose() {}};
  const services:Parameters<typeof createProjectReadNativeEngine>[0]['services']={
    begin(value){begin=value;return {bindSession(){},answer(){},compactions:()=>stage>0?[receipt]:[],evidence:()=>({complete:stage>1})} as unknown as ReturnType<ProjectReadProviderServices['begin']>;},end(){},close:async()=>{},
  };
  const controller=new AbortController(),engine=createProjectReadNativeEngine({client,services});
  const input:ProjectReadEngineInput={runId:'project_read.compaction',model,workCycle:true,signal:controller.signal,chatContext:{provider:model.provider,model:model.model,messages:[{role:'user',content:initial}],maxOutputTokens:8192,timeoutMs:600000},prompt:{goal:initial,constraint:'',rules:'synthetic only',systemText:'synthetic only',initialUserText:initial},callbacks:{notice(event){events.push(event);},async tool(){executions++;return sum;},async questionDelivered(){}}};
  const firstPoll=nextPoll(),running=engine.start(input);await firstPoll;
  const call={sessionId:session,messageId:'assistant_work',callId:'call_sum',toolName:'pilot_sum' as const,arguments:{values:[1,2]}};
  assert.ok(begin);assert.deepEqual(await begin.onTool(call),sum);stage=1;
  await nextPoll();assert.deepEqual(await begin.onTool(call),sum);
  assert.equal(events.filter(event=>event.type==='compaction').length,1);
  assert.equal(events.some(event=>event.type==='completed'),false);
  stage=2;await running;await engine.shutdown();
  assert.equal(executions,1);assert.equal(prompts,1);assert.equal(aborts,1);
  assert.deepEqual(events.filter(event=>event.type==='text').map(event=>event.text),['Result: 3 mV.']);
  assert.equal(events.filter(event=>event.type==='completed').length,1);
});
