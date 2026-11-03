import test from 'node:test';
import assert from 'node:assert/strict';
import { PILOT_VERSION, PILOT_RULES_REVISION, parsePilotRequest, parsePilotResult, parsePilotDisk, parsePilotEvent, type PilotEvent, type PilotModel } from '../apps/desktop/src/shared/agent/engine-pilot';
import { mapOpenCodeQuestion } from '../apps/desktop/src/main/engine-pilot/opencode-client';
import { parseLiveQuestionArguments } from '../apps/desktop/src/main/engine-live/protocol';

const model: PilotModel = {provider:'deepseek',model:'deepseek-v4-flash'};
const runId='pilot.11111111-1111-4111-8111-111111111111',clientRequestId='22222222-2222-4222-8222-222222222222',time='2026-09-11T00:00:00.000Z';
const start={contractVersion:PILOT_VERSION,clientRequestId,goal:'请先问清单位，再把我给的整数相加。',constraint:'只报告工具实际返回的结果。'};
const baseStatus={engineKind:'opencode',engineVersion:'1.18.17',ready:false,capabilities:['pilot.sum.v1'],maxRuns:32};
function disk(live:boolean,steps:number,responses:number[]=[]){
  const events: PilotEvent[]=[];
  const add=(type:string,data:unknown)=>events.push(parsePilotEvent({runId,sequence:events.length+1,time,type,data}));
  add('run.accepted',{goal:start.goal,constraint:start.constraint,engineKind:'opencode',engineVersion:'1.18.17',rulesRevision:PILOT_RULES_REVISION,...(live?{model}:{})});
  add('engine.started',{sessionId:'session_1'});
  for(let step=1;step<=steps;step++)add('model.step',{step,usage:null});
  for(const request of responses)add('model.response',{request,responseModel:null,usage:null});
  add('message.delta',{text:'已完成。'});add('run.completed',{});
  return {version:1,runs:[{runId,clientRequestId,goal:start.goal,constraint:start.constraint,status:'completed',createdAt:time,updatedAt:time,engineKind:'opencode',engineVersion:'1.18.17',...(live?{model}:{}),events}]};
}

test('live contract separates first-start availability from native readiness and keeps legacy status valid',()=>{
  const idle={...baseStatus,model,canStart:true,processState:'idle',availability:'available'};
  const parsed=parsePilotResult('getStatus',{ok:true,value:idle});assert.ok(parsed.ok);
  if(parsed.ok){assert.equal(parsed.value.canStart,true);assert.equal(parsed.value.ready,false);assert.deepEqual(parsed.value.model,model);}
  assert.doesNotThrow(()=>parsePilotResult('getStatus',{ok:true,value:baseStatus}));
  for(const value of [{...idle,ready:true},{...idle,availability:'not_configured'},{...idle,canStart:false},{...idle,apiKey:'synthetic'}, {...idle,processState:'other'}])assert.throws(()=>parsePilotResult('getStatus',{ok:true,value}));
  const {model:omitted,...withoutModel}=idle;void omitted;
  assert.throws(()=>parsePilotResult('getStatus',{ok:true,value:withoutModel}));
  assert.doesNotThrow(()=>parsePilotResult('getStatus',{ok:true,value:{...baseStatus,canStart:false,processState:'idle',availability:'not_configured'}}));
});

test('live contract keeps free text exact and rejects unknown request fields or unapproved model identities',()=>{
  const parsed=parsePilotRequest('startRun',{...start,model});assert.deepEqual(parsed,{...start,model});
  assert.ok(Object.isFrozen(parsed.model));assert.doesNotThrow(()=>parsePilotRequest('startRun',start));
  for(const value of [{...start,model,apiKey:'synthetic'},{...start,model:{...model,baseURL:'https://example.invalid'}},{...start,model:{provider:'deepseek',model:'deepseek-flash'}},{...start,model:{provider:'kimi',model:'kimi-k3'}}])assert.throws(()=>parsePilotRequest('startRun',value));
  const answer='第一项用毫安；第二项保留负号。\n这是一段自然语言，不是 JSON。';
  assert.equal(parsePilotRequest('answerQuestion',{contractVersion:PILOT_VERSION,runId,questionId:'question_free_17',answer}).answer,answer);
  assert.throws(()=>parsePilotRequest('answerQuestion',{contractVersion:PILOT_VERSION,runId,questionId:'question_free_17',answer:'界'.repeat(1366)}));
});

test('live disk binds requested identity and accepts sparse HTTP ordinals through eight with unknown usage preserved',()=>{
  const parsed=parsePilotDisk(disk(true,8,[1,3,8]));
  assert.deepEqual(parsed.runs[0]!.model,model);
  assert.deepEqual(parsed.runs[0]!.events.filter(e=>e.type==='model.response').map(e=>e.data),[1,3,8].map(request=>({request,responseModel:null,usage:null})));
  assert.throws(()=>parsePilotDisk(disk(true,1,[3,3])));
  assert.throws(()=>parsePilotDisk(disk(true,1,[3,2])));
  assert.throws(()=>parsePilotDisk(disk(false,1,[1])));
  assert.throws(()=>parsePilotEvent({runId,sequence:1,time,type:'model.response',data:{request:9,responseModel:null,usage:null}}));
  assert.doesNotThrow(()=>parsePilotDisk(disk(false,4)));
  assert.throws(()=>parsePilotDisk(disk(false,5)));
  const mismatch=disk(true,1);delete (mismatch.runs[0] as {model?:PilotModel}).model;
  assert.throws(()=>parsePilotDisk(mismatch));
  const output=parsePilotEvent({runId,sequence:1,time,type:'model.response',data:{request:8,responseModel:'deepseek-v4.1-flash',usage:{inputTokens:13,outputTokens:21}}});
  assert.equal(output.type,'model.response');if(output.type==='model.response')assert.equal(output.data.responseModel,'deepseek-v4.1-flash');
});

test('live question schema accepts one arbitrary free-text question per call without silently dropping options or extra questions',()=>{
  const question={question:'请说明“损耗”是哪个量？\n可以直接用文字回答。',header:'补充信息',options:[],custom:true,multiple:false};
  const args=parseLiveQuestionArguments({questions:[question]});assert.deepEqual(args.questions,[question]);
  assert.deepEqual(mapOpenCodeQuestion({type:'question.asked',properties:{id:'qid_any_9',sessionID:'session_1',questions:args.questions,tool:{messageID:'message_1',callID:'call_any_93'}}},'session_1'),{type:'question',questionId:'qid_any_9',prompt:question.question});
  for(const questions of [[],[question,question],[{...question,options:[{label:'A',description:'fixed'}]}],[{...question,custom:false}],[{...question,multiple:true}],[{...question,path:'private'}]])assert.throws(()=>parseLiveQuestionArguments({questions}));
});
