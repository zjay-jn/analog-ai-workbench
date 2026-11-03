import { randomUUID } from 'node:crypto';
import { createAgentCallerFenceV1, type AgentCallerContextV1 } from '../agent/agent-caller-fence';
import { PILOT_LIMITS as limits, PILOT_RULES_REVISION, parsePilotDisk, parsePilotEvent, parsePilotRequest, parsePilotResult, parseSumArguments, pilotBytes, pilotEventState, pilotExact, pilotFailure, pilotId, pilotTerminal, pilotText, type PilotDisk, type PilotEvent, type PilotEventData, type PilotMethod, type PilotRun, type SumValue } from '../../shared/agent/engine-pilot';
import type { PilotEngine, EngineNotice } from './engine';
import type { PilotStore } from './store';
import { PILOT_RULES, pilotPrompt } from './prompt';
import { executePilotSum } from './tool';
import { LIVE_LIMITS } from '../../shared/agent/engine-pilot';

type Active = { runId:string; abort:AbortController; sessionId?:string; questionId?:string; timer?:ReturnType<typeof setTimeout>; elapsed:number; started:number; waiting:boolean; };
export function createPilotHost(options: Readonly<{ owner:AgentCallerContextV1; engine:PilotEngine; store:PilotStore; deadlineMs?:number; waitMs?:number }>) {
  const {engine,store}=options;
  const fence=createAgentCallerFenceV1({caller:options.owner,capabilities:['start_turn'],generation:1});
  const maximumDeadline=engine.liveStatus?LIVE_LIMITS.requestTimeoutMs*LIVE_LIMITS.requests:limits.deadlineMs;
  const configuredLimits=engine.executionLimits?.();
  const deadlineMs=options.deadlineMs??configuredLimits?.deadlineMs??(engine.liveStatus?LIVE_LIMITS.deadlineMs:limits.deadlineMs),waitMs=options.waitMs??configuredLimits?.waitMs??limits.waitMs;
  if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>maximumDeadline||!Number.isSafeInteger(waitMs)||waitMs<1||waitMs>limits.waitMs) throw new TypeError('Invalid pilot deadline');
  let disk:PilotDisk={version:1,runs:[]},active:Active|undefined,revoked=false,storageFailed=false,ready=false;
  const now=()=>new Date().toISOString();
  const find=(id:string)=>disk.runs.find(r=>r.runId===id);
  function stopEngine(id:string):void { void engine.stop(id).catch(()=>{ready=false;}); }
  function halt():void { const current=active; if(!current)return; active=undefined; if(current.timer)clearTimeout(current.timer); current.abort.abort(); stopEngine(current.runId); }
  function persist(next:PilotDisk):boolean {
    if(storageFailed)return false;
    try { const parsed=parsePilotDisk(next); store.save(parsed); disk=parsed; return true; }
    catch { storageFailed=true;ready=false;halt();return false; }
  }
  function make<K extends keyof PilotEventData>(run:PilotRun,type:K,data:PilotEventData[K]):PilotEvent { return parsePilotEvent({runId:run.runId,sequence:run.events.length+1,time:now(),type,data}); }
  function append(event:PilotEvent):boolean {
    const run=find(event.runId);if(!run||pilotTerminal(run.status))return false;
    const next={...run,updatedAt:event.time,status:pilotEventState(event)??run.status,events:[...run.events,event]};
    return persist({version:1,runs:disk.runs.map(r=>r.runId===run.runId?next:r)});
  }
  function finish<K extends 'run.failed'|'run.stopped'|'run.completed'|'run.interrupted'>(id:string,type:K,data:PilotEventData[K]):boolean {
    const run=find(id);if(!run||pilotTerminal(run.status)||storageFailed)return false;
    // Invalidate callbacks before either abort or a durable terminal can trigger follow-up work.
    halt();return append(make(run,type,data));
  }
  function fail(id:string,code:PilotEventData['run.failed']['code'],stage:PilotEventData['run.failed']['stage']):void { finish(id,'run.failed',{code,stage}); }
  function contextSize(run:PilotRun):number {
    return pilotBytes({rules:PILOT_RULES,goal:run.goal,constraint:run.constraint,records:run.events.filter(e=>['tool.started','tool.completed','question.asked','question.answered'].includes(e.type)).map(e=>e.data)});
  }
  function push(id:string,type:keyof PilotEventData,data:PilotEventData[keyof PilotEventData]):boolean {
    const run=find(id);if(!run||!active||active.runId!==id||pilotTerminal(run.status)||storageFailed||revoked)return false;
    if(run.events.length>=limits.events-1){fail(id,'LIMIT_EXCEEDED','engine');return false;}
    const event=make(run,type,data),next={...run,events:[...run.events,event]};
    if(pilotBytes(next)+16384>limits.runBytes||contextSize(next)>limits.contextBytes){fail(id,'LIMIT_EXCEEDED','context');return false;}
    return append(event);
  }
  function arm(current:Active,waiting:boolean):void {
    if(current.timer)clearTimeout(current.timer);
    if(!current.waiting)current.elapsed+=Date.now()-current.started;
    current.waiting=waiting;current.started=Date.now();
    const delay=waiting?waitMs:Math.max(1,deadlineMs-current.elapsed);
    current.timer=setTimeout(()=>{if(active!==current)return;if(waiting)finish(current.runId,'run.interrupted',{reason:'question_timeout'});else fail(current.runId,'LIMIT_EXCEEDED','deadline');},delay);
  }
  function notice(id:string,input:EngineNotice):void {
    if(!active||active.runId!==id||revoked||storageFailed)return;
    try {
      if(input.type==='started') {
        const e=pilotExact(input,['type','sessionId']);if(active.sessionId)throw Error(); const sessionId=pilotId(e.sessionId,'native');
        if(push(id,'engine.started',{sessionId}))active!.sessionId=sessionId;return;
      }
      if(!active.sessionId)throw Error();
      if(input.type==='step'){pilotExact(input,['type','step','usage']);if(active.questionId)throw Error();const run=find(id)!,steps=run.events.filter(e=>e.type==='model.step').length;if(input.step!==steps+1||input.step>(run.model?LIVE_LIMITS.steps:limits.steps)){fail(id,'LIMIT_EXCEEDED','engine');return;}push(id,'model.step',{step:input.step,usage:input.usage});}
      else if(input.type==='response'){pilotExact(input,['type','request','responseModel','usage']);push(id,'model.response',{request:input.request,responseModel:input.responseModel,usage:input.usage});}
      else if(input.type==='text') {
        pilotExact(input,['type','text']);if(active.questionId)throw Error();const text=pilotText(input.text,limits.outputBytes,false),run=find(id)!;
        const existing=run.events.filter(e=>e.type==='message.delta').map(e=>e.data.text).join('');if(new TextEncoder().encode(existing+text).length>limits.outputBytes){fail(id,'LIMIT_EXCEEDED','engine');return;}
        const parts:string[]=[];let part='',size=0;for(const point of text){const n=new TextEncoder().encode(point).length;if(size+n>2048){parts.push(part);part='';size=0;}part+=point;size+=n;}if(part)parts.push(part);
        if(run.events.length+parts.length+1>limits.events){fail(id,'LIMIT_EXCEEDED','engine');return;}
        for(const text of parts)if(!push(id,'message.delta',{text}))break;
      }
      else if(input.type==='question') {pilotExact(input,['type','questionId','prompt']);if(active.questionId)throw Error();if(find(id)!.events.filter(e=>e.type==='question.asked').length>=limits.questions){fail(id,'LIMIT_EXCEEDED','engine');return;}const questionId=pilotId(input.questionId,'native');if(find(id)!.events.some(e=>e.type==='question.asked'&&e.data.questionId===questionId))throw Error();if(push(id,'question.asked',{questionId,prompt:input.prompt})){active!.questionId=questionId;arm(active!,true);}}
      else if(input.type==='completed') {pilotExact(input,['type']);const run=find(id)!;if(active.questionId||!run.events.filter(e=>e.type==='message.delta').map(e=>e.data.text).join('').trim())throw Error();finish(id,'run.completed',{});}
      else if(input.type==='failed'){pilotExact(input,['type']);fail(id,'ENGINE_FAILED','engine');}
      else throw Error();
    } catch {fail(id,'PROTOCOL_ERROR','engine');}
  }
  async function tool(id:string,call:Parameters<Parameters<PilotEngine['start']>[0]['callbacks']['tool']>[0]):Promise<SumValue> {
    if(!active||active.runId!==id||!active.sessionId||revoked||storageFailed)throw new Error('Pilot tool unavailable');
    try {
      pilotExact(call,['sessionId','callId','toolName','arguments']);if(call.sessionId!==active.sessionId||call.toolName!=='pilot.sum.v1'||active.questionId)throw Error();
      const callId=pilotId(call.callId,'native'),args=parseSumArguments(call.arguments),run=find(id)!;
      const prior=run.events.find(e=>e.type==='tool.started'&&e.data.callId===callId);
      if(prior?.type==='tool.started') {if(JSON.stringify(prior.data.arguments)!==JSON.stringify(args))throw Error();const result=run.events.find(e=>e.type==='tool.completed'&&e.data.callId===callId);if(result?.type==='tool.completed')return result.data.result;throw Error();}
      const calls=run.events.filter(e=>e.type==='tool.started');if(calls.length>=limits.calls){fail(id,'LIMIT_EXCEEDED','tool');throw Error();}
      if(calls.slice(-2).length===2&&calls.slice(-2).every(e=>JSON.stringify(e.data.arguments)===JSON.stringify(args))){fail(id,'NO_PROGRESS','tool');throw Error();}
      if(run.events.length+3>limits.events){fail(id,'LIMIT_EXCEEDED','tool');throw Error();}
      if(!push(id,'tool.started',{callId,toolName:'pilot.sum.v1',arguments:args}))throw Error();
      const started=Date.now(),result=executePilotSum(args);if(Date.now()-started>1000)throw Error();
      if(!push(id,'tool.completed',{callId,result}))throw Error();return result;
    }catch{if(active?.runId===id)fail(id,'PROTOCOL_ERROR','tool');throw new Error('Pilot tool unavailable');}
  }
  try { disk=parsePilotDisk(store.load()); for(const run of [...disk.runs])if(!pilotTerminal(run.status)){const event=make(run,'run.interrupted',{reason:'restart'});if(!append(event))break;} }
  catch {storageFailed=true;}
  const initialization=Promise.resolve().then(()=>storageFailed?false:engine.health()).then(value=>{if(!revoked&&!storageFailed)ready=value===true;},()=>{ready=false;});
  async function invoke(method:PilotMethod,caller:unknown,input:unknown):Promise<unknown> {
    if(revoked||!fence.authorizeInvocation({caller,operation:'startTurn'}).allowed)return pilotFailure('CAPABILITY_DENIED');
    if(storageFailed)return pilotFailure('STORAGE_FAILED');
    try{parsePilotRequest(method,input);}catch{return pilotFailure('INVALID_REQUEST');}
    if(method==='getStatus'){await initialization;if(revoked)return pilotFailure('CAPABILITY_DENIED');const live=engine.liveStatus?.();return parsePilotResult(method,{ok:true,value:{engineKind:engine.kind,engineVersion:engine.version,ready:live?live.processState==='ready'&&live.canStart:ready,capabilities:['pilot.sum.v1'],maxRuns:32,...live}});}
    if(method==='listRuns')return parsePilotResult(method,{ok:true,value:{runs:disk.runs.map(({runId,goal,status,createdAt,updatedAt,engineKind,model})=>({runId,goal:Array.from(goal).slice(0,128).join(''),status,createdAt,updatedAt,engineKind,...(model?{model}:{})}))}});
    if(method==='startRun') {
      const request=parsePilotRequest('startRun',input);
      const prior=disk.runs.find(r=>r.clientRequestId===request.clientRequestId);if(prior)return prior.goal===request.goal&&prior.constraint===request.constraint&&JSON.stringify(prior.model)===JSON.stringify(request.model)?{ok:true,value:{runId:prior.runId}}:pilotFailure('INVALID_REQUEST');
      if(active)return pilotFailure('BUSY');if(disk.runs.length>=limits.runs)return pilotFailure('SESSION_LIMIT');if(engine.liveStatus?!engine.liveStatus().canStart:!ready)return pilotFailure('NOT_READY');
      const time=now(),runId=`pilot.${randomUUID()}`;let run:PilotRun;
      try {const model=engine.accept?.(runId,request.model);if(!engine.accept&&request.model)throw Error();const identity=model?{model}:{};const accepted=parsePilotEvent({runId,sequence:1,time,type:'run.accepted',data:{goal:request.goal,constraint:request.constraint,engineKind:engine.kind,engineVersion:engine.version,rulesRevision:PILOT_RULES_REVISION,...identity}});run={runId,clientRequestId:request.clientRequestId,goal:request.goal,constraint:request.constraint,status:'running',createdAt:time,updatedAt:time,engineKind:engine.kind,engineVersion:engine.version,...identity,events:[accepted]};parsePilotDisk({version:1,runs:[...disk.runs,run]});}catch{stopEngine(runId);return pilotFailure('INVALID_REQUEST');}
      if(!persist({version:1,runs:[...disk.runs,run]})){stopEngine(runId);return pilotFailure('STORAGE_FAILED');}
      const current:Active={runId,abort:new AbortController(),elapsed:0,started:Date.now(),waiting:false};active=current;arm(current,false);
      void Promise.resolve().then(async()=>{if(active!==current)return;try{await engine.start({runId,prompt:pilotPrompt(run.goal,run.constraint),signal:current.abort.signal,...(run.model?{model:run.model}:{}),callbacks:{notice:e=>notice(runId,e),tool:call=>tool(runId,call)}});if(active===current&&!current.questionId)fail(runId,'ENGINE_FAILED','engine');}catch{if(active===current)fail(runId,'ENGINE_FAILED','engine');}});
      return {ok:true,value:{runId}};
    }
    const selector=method==='readRun'?parsePilotRequest('readRun',input):method==='answerQuestion'?parsePilotRequest('answerQuestion',input):parsePilotRequest('stopRun',input);
    const run=find(selector.runId);if(!run)return pilotFailure('NOT_FOUND');
    if(method==='readRun'){const request=parsePilotRequest('readRun',input);if(request.afterSequence>run.events.length)return pilotFailure('INVALID_REQUEST');const events:PilotEvent[]=[];let nextSequence=request.afterSequence;for(const event of run.events.slice(nextSequence,nextSequence+32)){const candidate={ok:true,value:{runId:run.runId,events:[...events,event],nextSequence:event.sequence,terminal:pilotTerminal(run.status)&&event.sequence===run.events.length}};if(pilotBytes(candidate)>limits.batchBytes)break;events.push(event);nextSequence=event.sequence;}return parsePilotResult(method,{ok:true,value:{runId:run.runId,events,nextSequence,terminal:pilotTerminal(run.status)&&nextSequence===run.events.length}});}
    if(method==='stopRun'){if(pilotTerminal(run.status))return {ok:true,value:{status:'already_terminal'}};return finish(run.runId,'run.stopped',{reason:'user'})?{ok:true,value:{status:'stopped'}}:pilotFailure('STORAGE_FAILED');}
    if(method==='answerQuestion'){const request=parsePilotRequest('answerQuestion',input);const current=active;if(!current||current.runId!==run.runId||current.questionId!==request.questionId)return pilotFailure('STALE_QUESTION');if(!push(run.runId,'question.answered',{questionId:request.questionId,answer:request.answer}))return storageFailed?pilotFailure('STORAGE_FAILED'):pilotFailure('LIMIT_EXCEEDED');delete current.questionId;arm(current,false);void engine.answer(run.runId,request.questionId,request.answer).catch(()=>{if(active===current)fail(run.runId,'ENGINE_FAILED','engine');});return {ok:true,value:{accepted:true}};}
    return pilotFailure('INVALID_REQUEST');
  }
  return Object.freeze({ invoke, initialization, snapshot:()=>Object.freeze({ready,revoked,storageFailed,runs:disk.runs.length,active:active?.runId??null}), revoke(){if(revoked)return;if(active)finish(active.runId,'run.interrupted',{reason:'window'});revoked=true;ready=false;halt();engine.dispose();store.close();} });
}
