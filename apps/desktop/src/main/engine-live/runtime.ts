import { parsePilotModel, pilotId, LIVE_LIMITS, type PilotLiveStatus, type PilotModel } from '../../shared/agent/engine-pilot';
import type { ModelSettingsHost } from '../cloud/model-settings-host';
import type { PilotEngine } from '../engine-pilot/engine';
import { createOpenCodePilotClient, OPENCODE_PILOT_VERSION, OpenCodePilotError } from '../engine-pilot/opencode-client';
import { createOpenCodePilotEngine } from '../engine-pilot/opencode-engine';
import type { startOpenCodeSupervisor, OpenCodeSupervisor } from '../engine-pilot/opencode-supervisor';
import { createLiveProviderServices } from './provider-gateway';

type FetchLike=(url:string,init:RequestInit)=>Promise<Response>;
export type LiveRuntimeBudget=Readonly<{maxRequests:number;maxOutputTokens:number;requestTimeoutMs:number;deadlineMs:number;waitMs:number}>;
export type LiveRuntimeOptions=Readonly<{
  settings:Pick<ModelSettingsHost,'key'|'defaultModel'|'read'>;
  fetchImpl:FetchLike;
  startNative:typeof startOpenCodeSupervisor;
  budget?:LiveRuntimeBudget;
  onTraffic?:(value:unknown)=>void;
}>;
type FrozenRun={apiKey:string;model:PilotModel;maxRequests:number;maxOutputTokens:number;requestTimeoutMs:number};
/** Construction/status/history have no native or provider I/O. Only accepted explicit start initializes native. */
export function createLiveRuntime(options:LiveRuntimeOptions):PilotEngine {
  if(typeof options.fetchImpl!=='function'||typeof options.startNative!=='function'||!options.settings)throw new OpenCodePilotError();
  const budget=Object.freeze({...options.budget??{maxRequests:LIVE_LIMITS.requests,maxOutputTokens:LIVE_LIMITS.maxOutputTokens,requestTimeoutMs:LIVE_LIMITS.requestTimeoutMs,deadlineMs:LIVE_LIMITS.deadlineMs,waitMs:1800000}});
  if(Reflect.ownKeys(budget).length!==5)throw new OpenCodePilotError();
  for(const [key,max] of [['maxRequests',8],['maxOutputTokens',16384],['requestTimeoutMs',600000],['deadlineMs',4800000],['waitMs',1800000]] as const)if(!Number.isSafeInteger(budget[key])||budget[key]<1||budget[key]>max)throw new OpenCodePilotError();
  let state:PilotLiveStatus['processState']='idle',disposed=false,engine:PilotEngine|undefined,supervisor:OpenCodeSupervisor|undefined;
  let services:Awaited<ReturnType<typeof createLiveProviderServices>>|undefined,startup:Promise<void>|undefined,shutdown:Promise<void>|undefined;
  let disposeFailed=false;
  let current:Parameters<PilotEngine['start']>[0]|undefined;
  let execution:Promise<void>|undefined;
  const stops=new Map<string,Promise<void>>();
  const snapshots=new Map<string,FrozenRun>();
  function liveStatus():PilotLiveStatus {
    if(disposed||state==='failed')return {canStart:false,processState:state==='idle'?'idle':'failed',availability:'unavailable'};
    try{
      const view=options.settings.read();
      if(!view.ok||view.value.storage!=='ready')return {canStart:false,processState:state,availability:'unavailable'};
      if(options.settings.defaultModel('deepseek')!=='deepseek-v4-flash')return {canStart:false,processState:state,availability:'unsupported_model'};
      const model=parsePilotModel({provider:'deepseek',model:'deepseek-v4-flash'});
      if(!view.value.providers.find(p=>p.provider==='deepseek')?.configured)return {model,canStart:false,processState:state,availability:'not_configured'};
      return {model,canStart:true,processState:state,availability:'available'};
    }catch{return {canStart:false,processState:state,availability:'unavailable'};}
  }
  const forget=(runId:string)=>{const saved=snapshots.get(runId);if(saved)saved.apiKey='';snapshots.delete(runId);};
  function initialize():Promise<void>{
    if(startup)return startup;state='starting';
    startup=(async()=>{
      services=await createLiveProviderServices({fetchImpl:options.fetchImpl,getRunCredentials:runId=>{
        const saved=snapshots.get(runId);if(disposed||!saved||current?.runId!==runId||current.signal.aborted)throw new OpenCodePilotError();
        return {apiKey:saved.apiKey,maxRequests:saved.maxRequests,maxOutputTokens:saved.maxOutputTokens,requestTimeoutMs:saved.requestTimeoutMs};
      },onResponse:(runId,response)=>{if(!disposed&&current?.runId===runId&&!current.signal.aborted)current.callbacks.notice({type:'response',...response});},...(options.onTraffic?{onTraffic:options.onTraffic}:{})});
      if(disposed){await services.close();return;}
      supervisor=await options.startNative({services:{port:services.port,providerToken:services.providerToken,toolToken:services.toolToken},profile:'live-deepseek'});
      if(disposed){await services.close();const exit=await supervisor.stop();if(!exit.exited)throw new OpenCodePilotError();return;}
      engine=createOpenCodePilotEngine({client:createOpenCodePilotClient({port:supervisor.port,password:supervisor.password,directory:supervisor.directory,profile:'live-deepseek'}),services,profile:'live-deepseek'});
      state='ready';
      void supervisor.exited.then(()=>{if(!disposed){state='failed';try{if(current&&!current.signal.aborted)current.callbacks.notice({type:'failed'});}catch{disposeFailed=true;}finally{dispose();void services?.close().catch(()=>{disposeFailed=true;});}}}).catch(()=>{state='failed';dispose();});
    })().catch(async()=>{state='failed';try{await services?.close();}catch{}try{await supervisor?.stop();}catch{}throw new OpenCodePilotError();});
    void startup.catch(()=>{});return startup;
  }
  function stop(runId:string):Promise<void>{
    const prior=stops.get(runId);if(prior)return prior;
    if(current?.runId!==runId){forget(runId);const result=engine?.stop(runId)??Promise.resolve();stops.set(runId,result);return result;}
    let revokeFailed=false;try{services?.end(runId);}catch{revokeFailed=true;state='failed';}
    const result=(startup??Promise.resolve()).then(async()=>{await engine?.stop(runId);if(revokeFailed)throw new OpenCodePilotError();}).catch(()=>{state='failed';throw new OpenCodePilotError();}).finally(()=>forget(runId));stops.set(runId,result);return result;
  }
  function dispose():void{
    if(disposed)return;disposed=true;
    try{if(current)services?.end(current.runId);}catch{disposeFailed=true;state='failed';}
    try{engine?.dispose();}catch{disposeFailed=true;state='failed';}
    finally{for(const id of snapshots.keys())forget(id);}
  }
  return {
    kind:'opencode',version:OPENCODE_PILOT_VERSION,liveStatus,health:async()=>liveStatus().canStart,executionLimits:()=>({deadlineMs:budget.deadlineMs,waitMs:budget.waitMs}),
    accept(runId,requested){pilotId(runId,'run');if(!liveStatus().canStart||snapshots.has(runId)||snapshots.size>=32)throw new OpenCodePilotError();
      const model=parsePilotModel(requested),apiKey=options.settings.key(model.provider);
      if(options.settings.defaultModel(model.provider)!==model.model||!apiKey||!/^sk-[A-Za-z0-9_-]{8,512}$/u.test(apiKey))throw new OpenCodePilotError();
      snapshots.set(runId,{apiKey,model,maxRequests:budget.maxRequests,maxOutputTokens:budget.maxOutputTokens,requestTimeoutMs:budget.requestTimeoutMs});return model;
    },
    start(input){
      if(disposed||state==='failed'||(current&&!current.signal.aborted)||!snapshots.has(input.runId)||input.signal.aborted)throw new OpenCodePilotError();
      if(JSON.stringify(snapshots.get(input.runId)!.model)!==JSON.stringify(input.model))throw new OpenCodePilotError();
      const previous=execution??Promise.resolve();
      const operation=previous.catch(()=>{}).then(async()=>{
      if(disposed||state==='failed'||input.signal.aborted||!snapshots.has(input.runId)){forget(input.runId);return;}
      current=input;
      try{await initialize();if(disposed||input.signal.aborted)return;if(!engine)throw new OpenCodePilotError();await engine.start(input);}
      catch{if(!disposed&&!input.signal.aborted){state='failed';input.callbacks.notice({type:'failed'});}throw new OpenCodePilotError();}
      finally{if(current===input)current=undefined;forget(input.runId);}
      });execution=operation;return operation;
    },
    async answer(runId,questionId,answer){if(disposed||current?.runId!==runId||current.signal.aborted||!engine)throw new OpenCodePilotError();await engine.answer(runId,questionId,answer);},
    stop,dispose,
    shutdown(){if(shutdown)return shutdown;shutdown=Promise.resolve().then(async()=>{let failed=disposeFailed;try{await startup;}catch{failed=true;}try{await engine?.shutdown?.();}catch{failed=true;}try{await services?.close();}catch{failed=true;}try{const result=await supervisor?.stop();if(result&&!result.exited)failed=true;}catch{failed=true;}if(failed||disposeFailed)throw new OpenCodePilotError();});dispose();return shutdown;},
  };
}
