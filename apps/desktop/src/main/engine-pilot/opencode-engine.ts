import { pilotId, pilotText, parseSumArguments, parseSumValue, type SumValue } from '../../shared/agent/engine-pilot';
import type { PilotEngine } from './engine';
import { createOpenCodePilotClient, mapOpenCodeQuestion, OPENCODE_PILOT_VERSION, OpenCodePilotError, LIVE_NATIVE_IDENTITY, liveNativeUserText } from './opencode-client';
import { PILOT_NATIVE_QUESTION, pilotNativeQuestionArguments, pilotNativeQuestionResult, type PilotLoopbackServices } from './loopback-services';
import { parseLiveQuestionArguments, liveQuestionResult } from '../engine-live/protocol';
import { parseProjectReadModel, type ProjectReadModel } from '../../shared/agent/agent-project-model';

type Obj=Record<string,unknown>;
const object=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new OpenCodePilotError();return v as Obj;};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
type NativeMessage={info:Obj;parts:Obj[]};
const USER_PART_GRACE_MS=2000;
const CLEANUP_DEADLINE_MS=10000;
type NativeClient=Omit<ReturnType<typeof createOpenCodePilotClient>,'reject'|'openSession'|'seed'|'isIdle'|'watchSessionErrors'> & Partial<Pick<ReturnType<typeof createOpenCodePilotClient>,'reject'>>;
type QuestionBinding=Readonly<{runId:string;sessionID:string;questionID:string;messageID:string;callID:string;prompt?:string;arguments?:unknown}>;
type BeginInput=Parameters<PilotLoopbackServices['begin']>[0];
export type OpenCodeEngineServices=Readonly<{
  begin(input:BeginInput):{bindSession(id:string):void;answer(answer:string,questionId?:string):void;answerDelivery?(questionId:string,delivery:Promise<void>):void;question?(binding:{questionID:string;messageID:string;callID:string;prompt:string;arguments:unknown}):void;evidence():{complete:boolean}};
  end(runId:string):void;close():Promise<void>;
}>;
export class PilotNativeCleanupError extends OpenCodePilotError {readonly code='NATIVE_CLEANUP_FAILED';}
/** Snapshot projection is cumulative and bounded. No SSE replay or native idle == success assumption. */
export function parseOpenCodeMessages(value:unknown,sessionID:string,userText:string,profile?:'live-deepseek'|'project-read',model?:ProjectReadModel):{userId:string|null;pendingUserId:string|null;messages:NativeMessage[]} {
  if(model!==undefined&&(profile!=='project-read'||!parseProjectReadModel(model)))throw new OpenCodePilotError();
  if(!Array.isArray(value)||value.length>(profile==='project-read'?96:64))throw new OpenCodePilotError();const ids=new Set<string>();let userId:string|null=null,pendingUserId:string|null=null;
  const messages=value.map(item=>{
    const row=object(item),info=object(row.info),id=pilotId(info.id,'native');
    if(ids.has(id)||info.sessionID!==sessionID||!['user','assistant'].includes(String(info.role))||!Array.isArray(row.parts)||row.parts.length>128)throw new OpenCodePilotError();ids.add(id);
    const time=object(info.time);if(typeof time.created!=='number'||!Number.isFinite(time.created))throw new OpenCodePilotError();
    const parts:Obj[]=row.parts.map(part=>{const p=object(part),partId=pilotId(p.id,'native');if(ids.has(partId)||p.sessionID!==sessionID||p.messageID!==id)throw new OpenCodePilotError();ids.add(partId);return p;});
    if(info.role==='user'){
      if(userId||pendingUserId)throw new OpenCodePilotError();
      // Native createUserMessage persists info, then each part in a separate update.
      // Only this exact empty-parts state may wait; present but altered text still fails.
      if(parts.length===0)pendingUserId=id;
      else {if(parts.length!==1||parts[0]!.type!=='text'||parts[0]!.text!==userText)throw new OpenCodePilotError();userId=id;}
    }
    return {info,parts};
  });
  const identity=profile?{...LIVE_NATIVE_IDENTITY,modelID:model?.model??LIVE_NATIVE_IDENTITY.modelID}:{agent:'pilot',providerID:'pilot',modelID:'mock'};
  for(const {info} of messages)if(info.role==='assistant'&&(!userId||info.parentID!==userId||info.summary===true||info.agent!==identity.agent||info.providerID!==identity.providerID||info.modelID!==identity.modelID))throw new OpenCodePilotError();
  messages.sort((a,b)=>(object(a.info.time).created as number)-(object(b.info.time).created as number)||String(a.info.id).localeCompare(String(b.info.id)));
  return {userId,pendingUserId,messages};
}

export function createOpenCodePilotEngine(options:Readonly<{client:NativeClient;services:OpenCodeEngineServices;profile?:'live-deepseek'}>):PilotEngine {
  const {client,services}=options;let disposed=false,blocked=false,admitting=false;
  const live=options.profile==='live-deepseek';
  type Input=Parameters<PilotEngine['start']>[0];
  type Active={input:Input;sessionID?:string;userId?:string;pendingUser?:{id:string;since:number};oracle:ReturnType<OpenCodeEngineServices['begin']>;texts:Map<string,string>;steps:Set<string>;questions:Map<string,QuestionBinding>;answered:Set<string>;pendingQuestion?:string;answers:Map<string,string>;results:Map<string,{messageID:string;args:unknown;result:SumValue}>;closed:boolean;creation?:Promise<string>;submission?:Promise<void>;answerDeliveries:Map<string,Promise<void>>;cleanup?:Promise<void>;cleanupExpired?:boolean};
  let active:Active|undefined;
  let barrier:Promise<void>=Promise.resolve(),finalization:Promise<void>|undefined;const cleanups=new Map<string,Promise<void>>();
  const alive=(run:Active)=>!disposed&&!blocked&&!run.closed&&active===run&&!run.input.signal.aborted;
  async function snapshot(run:Active){
    if(!alive(run)||!run.sessionID)throw new OpenCodePilotError();const value=await client.messages(run.sessionID);if(!alive(run))throw new OpenCodePilotError();
    const view=parseOpenCodeMessages(value,run.sessionID,live?liveNativeUserText(run.input.prompt.goal,run.input.prompt.constraint):JSON.stringify({goal:run.input.prompt.goal,constraint:run.input.prompt.constraint}),options.profile);
    if(view.pendingUserId){
      if(run.userId||(run.pendingUser&&run.pendingUser.id!==view.pendingUserId))throw new OpenCodePilotError();
      run.pendingUser??={id:view.pendingUserId,since:Date.now()};
      if(Date.now()-run.pendingUser.since>=USER_PART_GRACE_MS)throw new OpenCodePilotError();
    }else if(view.userId){
      if((run.userId&&run.userId!==view.userId)||(run.pendingUser&&run.pendingUser.id!==view.userId))throw new OpenCodePilotError();
      run.userId=view.userId;delete run.pendingUser;
    }else if(run.userId||run.pendingUser)throw new OpenCodePilotError();
    return view;
  }
  function boundQuestion(run:Active,question:Obj):QuestionBinding {
    const ref=object(question.tool),binding:QuestionBinding={runId:run.input.runId,sessionID:pilotId(question.sessionID,'native'),questionID:pilotId(question.id,'native'),messageID:pilotId(ref.messageID,'native'),callID:pilotId(ref.callID,'native')};
    if(binding.sessionID!==run.sessionID)throw new OpenCodePilotError();
    if(live){const args=parseLiveQuestionArguments({questions:question.questions});return Object.freeze({...binding,prompt:args.questions[0]!.question,arguments:args});}
    if(binding.callID!=='call_pilot_question'||!same(question.questions,pilotNativeQuestionArguments().questions))throw new OpenCodePilotError();return Object.freeze(binding);
  }
  function questionList(value:unknown):Obj[]{if(!Array.isArray(value)||value.length>4)throw new OpenCodePilotError();const ids=new Set<string>();return value.map(item=>{const q=object(item),id=pilotId(q.id,'native');if(ids.has(id))throw new OpenCodePilotError();ids.add(id);return q;});}
  async function cleanupNative(run:Active):Promise<void>{
    const check=()=>{if(run.cleanupExpired)throw new PilotNativeCleanupError();};let uncertain=false;
    // A late create/prompt/reply must settle before abort, so it cannot revive work after cleanup.
    if(run.creation)await run.creation;check();if(!run.sessionID)return;
    for(const delivery of [run.submission,...run.answerDeliveries.values()])if(delivery){try{await delivery;}catch{uncertain=true;}check();}
    await client.abort(run.sessionID);check();
    const pending=questionList(await client.questions(run.sessionID));check();
    // Validate the whole list before any reject. Unknown or merely same-session IDs confer no authority.
    const owned=pending.map(question=>{
      const binding=boundQuestion(run,question),verified=run.questions.get(binding.questionID);
      if(!verified||!same(verified,binding)||run.answered.has(binding.questionID)||run.answerDeliveries.has(binding.questionID))throw new PilotNativeCleanupError();
      return binding;
    });
    for(const binding of owned){check();if(!client.reject)throw new PilotNativeCleanupError();await client.reject(binding.sessionID,binding.questionID);check();}
    if(owned.length){const remaining=questionList(await client.questions(run.sessionID));check();if(remaining.length)throw new PilotNativeCleanupError();}
    if(uncertain)throw new PilotNativeCleanupError();
  }
  function close(run:Active):Promise<void>{
    if(run.cleanup)return run.cleanup;
    run.closed=true;services.end(run.input.runId);if(active===run)active=undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{run.cleanupExpired=true;reject(new PilotNativeCleanupError());},CLEANUP_DEADLINE_MS);});
    run.cleanup=Promise.race([Promise.resolve().then(()=>cleanupNative(run)),timeout]).catch(()=>{blocked=true;throw new PilotNativeCleanupError();}).finally(()=>{if(timer)clearTimeout(timer);});
    barrier=run.cleanup;cleanups.set(run.input.runId,run.cleanup);
    // Rejections remain observable through start/stop/health; observe event-triggered cleanup immediately.
    void run.cleanup.catch(()=>{});return run.cleanup;
  }
  function failed(run:Active){if(alive(run))run.input.callbacks.notice({type:'failed'});void close(run);}
  function finalize():Promise<void>{
    if(finalization)return finalization;
    finalization=Promise.resolve().then(async()=>{let failure=false;try{await barrier;}catch{failure=true;}try{client.dispose();}catch{failure=true;}try{await services.close();}catch{failure=true;}if(failure){blocked=true;throw new PilotNativeCleanupError();}});
    void finalization.catch(()=>{});return finalization;
  }
  async function project(run:Active):Promise<void>{
    const view=await snapshot(run);if(!view.userId)return;
    let pendingTools=false;const assistants=view.messages.filter(m=>m.info.role==='assistant');
    for(const row of assistants){
      if(row.info.error)throw new OpenCodePilotError();
      for(const part of row.parts){
        if(!alive(run))return;const id=part.id as string;
        if(part.type==='step-start'){if(!run.steps.has(id)){run.steps.add(id);run.input.callbacks.notice({type:'step',step:run.steps.size,usage:null});}}
        else if(part.type==='text'){
          if(part.ignored===true||part.synthetic===true)continue;const text=pilotText(part.text,65536,false),prior=run.texts.get(id)??'';
          if(!text.startsWith(prior))throw new OpenCodePilotError();run.texts.set(id,text);if(text.length>prior.length)run.input.callbacks.notice({type:'text',text:text.slice(prior.length)});
        } else if(part.type==='tool'){
          const callID=pilotId(part.callID,'native'),state=object(part.state);
          if(part.tool!=='pilot_sum'&&part.tool!=='question')throw new OpenCodePilotError();
          if(part.tool==='question'&&state.status!=='pending'){if(live)parseLiveQuestionArguments(state.input);else if(callID!=='call_pilot_question'||!same(state.input,pilotNativeQuestionArguments()))throw new OpenCodePilotError();}
          if(state.status==='pending'||state.status==='running')pendingTools=true;
          else if(state.status==='error')throw new OpenCodePilotError();
          else if(state.status==='completed'){
            if(part.tool==='pilot_sum'){const saved=run.results.get(callID);if(!saved||saved.messageID!==row.info.id||!same(parseSumArguments(state.input),saved.args)||!same(parseSumValue(JSON.parse(pilotText(state.output,1024))),saved.result))throw new OpenCodePilotError();}
            else {const binding=[...run.questions.values()].find(q=>q.callID===callID&&q.messageID===row.info.id);const answer=binding?run.answers.get(binding.questionID):undefined;if(!binding||answer===undefined||state.output!==(live?liveQuestionResult(binding.prompt!,answer):pilotNativeQuestionResult(answer))||!same(object(state.metadata).answers,[[answer]])||(live&&!same(parseLiveQuestionArguments(state.input),binding.arguments)))throw new OpenCodePilotError();if(!run.answered.has(binding.questionID)){if(!run.answerDeliveries.has(binding.questionID))throw new OpenCodePilotError();pendingTools=true;}}
          }else throw new OpenCodePilotError();
        } else if(!['step-finish','reasoning','patch','snapshot','agent','retry'].includes(String(part.type)))throw new OpenCodePilotError();
      }
    }
    if(!alive(run))return;
    const response=await client.questions(run.sessionID!);if(!alive(run))return;const questions=questionList(response);
    const matching=questions.filter(q=>q.sessionID===run.sessionID);
    // A foreign session indicates unexpected activity inside this isolated process.
    if(matching.length!==questions.length||matching.length>1)throw new OpenCodePilotError();
    for(const question of matching){
      const ref=object(question.tool),messageID=pilotId(ref.messageID,'native'),callID=pilotId(ref.callID,'native');
      const row=assistants.find(m=>m.info.id===messageID),part=row?.parts.find(p=>p.type==='tool'&&p.tool==='question'&&p.callID===callID);
      // Request and snapshot are separate native reads. Wait for the next bounded poll on races.
      if(!part)continue;
      const notice=mapOpenCodeQuestion({type:'question.asked',properties:question},run.sessionID!);if(notice.type!=='question'||(!live&&(notice.prompt!==PILOT_NATIVE_QUESTION||callID!=='call_pilot_question')))throw new OpenCodePilotError();
      const binding=boundQuestion(run,question),prior=run.questions.get(binding.questionID);
      if(prior&&!same(prior,binding))throw new OpenCodePilotError();
      if(run.answered.has(notice.questionId))continue;
      if(!prior){if(run.pendingQuestion||run.questions.size>=4||object(part.state).status!=='running'||!same(live?parseLiveQuestionArguments(object(part.state).input):object(part.state).input,live?binding.arguments:pilotNativeQuestionArguments())||[...run.questions.values()].some(q=>q.callID===callID))throw new OpenCodePilotError();if(live)run.oracle.question?.({questionID:binding.questionID,messageID,callID,prompt:notice.prompt,arguments:binding.arguments});run.questions.set(notice.questionId,binding);run.pendingQuestion=notice.questionId;run.input.callbacks.notice(notice);}
    }
    if(!alive(run))return;
    const last=assistants.at(-1);if(!last||pendingTools||matching.length||run.pendingQuestion)return;
    const time=object(last.info.time);
    if(time.completed!==undefined&&last.info.finish==='stop'){
      if(typeof time.completed!=='number'||!Number.isFinite(time.completed)||!last.parts.some(p=>p.type==='text'&&typeof p.text==='string'&&p.text.trim()&&p.ignored!==true&&p.synthetic!==true)||!run.oracle.evidence().complete)throw new OpenCodePilotError();
      if(live){await close(run);if(!disposed&&!blocked&&!run.input.signal.aborted)run.input.callbacks.notice({type:'completed'});}
      else {run.input.callbacks.notice({type:'completed'});void close(run);}
    }
  }
  return {kind:'opencode',version:OPENCODE_PILOT_VERSION,
    async health(){if(disposed||blocked)return false;try{const healthy=await client.health();return !disposed&&!blocked&&healthy;}catch{return false;}},
    async start(input){
      if(disposed||blocked||active||admitting||input.signal.aborted||cleanups.has(input.runId)||cleanups.size>=32)throw new OpenCodePilotError();
      admitting=true;try{await barrier;if(disposed||blocked||input.signal.aborted)throw new OpenCodePilotError();}finally{admitting=false;}
      let run:Active;
      const oracle=services.begin({runId:input.runId,goal:input.prompt.goal,constraint:input.prompt.constraint,onFailure:()=>{if(run)failed(run);},onTool:async call=>{
        if(!run||!alive(run)||call.sessionID!==run.sessionID)throw new OpenCodePilotError();
        const view=await snapshot(run),row=view.messages.find(m=>m.info.id===call.messageID&&m.info.role==='assistant');
        const part=row?.parts.find(p=>p.type==='tool'&&p.tool==='pilot_sum'&&p.callID===call.callID);
        if(!part||!['running','completed'].includes(String(object(part.state).status))||!same(parseSumArguments(object(part.state).input),call.arguments))throw new OpenCodePilotError();
        const prior=run.results.get(call.callID);if(prior){if(prior.messageID!==call.messageID||!same(prior.args,call.arguments))throw new OpenCodePilotError();return prior.result;}
        const result=await input.callbacks.tool({sessionId:call.sessionID,callId:call.callID,toolName:'pilot.sum.v1',arguments:call.arguments});
        if(!alive(run))throw new OpenCodePilotError();run.results.set(call.callID,{messageID:call.messageID,args:call.arguments,result});return result;
      }});
      run={input,oracle,texts:new Map(),steps:new Set(),questions:new Map(),answered:new Set(),answers:new Map(),answerDeliveries:new Map(),results:new Map(),closed:false};active=run;
      const onAbort=()=>{void close(run);};input.signal.addEventListener('abort',onAbort,{once:true});
      try{
        run.creation=client.createSession().then(id=>{run.sessionID=id;return id;});await run.creation;if(!alive(run))return;
        input.callbacks.notice({type:'started',sessionId:run.sessionID!});if(!alive(run))return;
        oracle.bindSession(run.sessionID!);run.submission=client.prompt(run.sessionID!,{rules:input.prompt.rules,goal:input.prompt.goal,constraint:input.prompt.constraint});await run.submission;
        while(alive(run)){await project(run);if(!alive(run))break;await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);input.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,250);input.signal.addEventListener('abort',done,{once:true});if(input.signal.aborted)done();});}
      }catch{failed(run);}finally{input.signal.removeEventListener('abort',onAbort);await close(run);}
    },
    async answer(runId,questionId,answer){const run=active;if(!run||!alive(run)||run.input.runId!==runId||run.pendingQuestion!==questionId||!run.sessionID||!run.questions.has(questionId)||run.answerDeliveries.has(questionId))throw new OpenCodePilotError();run.oracle.answer(answer,questionId);run.answers.set(questionId,answer);delete run.pendingQuestion;const delivery=client.answer(run.sessionID,questionId,answer).then(()=>{run.answered.add(questionId);});run.answerDeliveries.set(questionId,delivery);if(live)run.oracle.answerDelivery?.(questionId,delivery);await delivery;},
    stop(runId){const run=active;return run?.input.runId===runId?close(run):cleanups.get(runId)??Promise.resolve();},
    dispose(){if(disposed)return;disposed=true;if(active)void close(active);void finalize();},
    shutdown(){if(!disposed){disposed=true;if(active)void close(active);}return finalize();},
  };
}
