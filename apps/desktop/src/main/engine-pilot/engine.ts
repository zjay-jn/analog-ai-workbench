import type { PilotKind, PilotUsage, SumValue, PilotModel, PilotLiveStatus } from '../../shared/agent/engine-pilot';
import type { pilotPrompt } from './prompt';
export type EngineNotice =
  | Readonly<{ type:'started'; sessionId:string }>
  | Readonly<{ type:'step'; step:number; usage:PilotUsage }>
  | Readonly<{ type:'response'; request:number; responseModel:string|null; usage:PilotUsage }>
  | Readonly<{ type:'text'; text:string }>
  | Readonly<{ type:'question'; questionId:string; prompt:string }>
  | Readonly<{ type:'completed' }>
  | Readonly<{ type:'failed' }>;
export type EngineCallbacks = Readonly<{
  notice:(event:EngineNotice)=>void;
  tool:(call:Readonly<{ sessionId:string; callId:string; toolName:string; arguments:unknown }>)=>Promise<SumValue>;
}>;
/** Projection adapter only. OpenCode, not this host, owns the model loop. */
export interface PilotEngine {
  readonly kind:PilotKind;
  readonly version:string;
  health():Promise<boolean>;
  liveStatus?():PilotLiveStatus;
  executionLimits?():Readonly<{deadlineMs:number;waitMs:number}>;
  /** Synchronous acceptance freezes model/key/budget before persistence and any later settings change. */
  accept?(runId:string,model:PilotModel|undefined):PilotModel;
  start(input:Readonly<{runId:string;prompt:ReturnType<typeof pilotPrompt>;signal:AbortSignal;callbacks:EngineCallbacks;model?:PilotModel}>):Promise<void>;
  answer(runId:string,questionId:string,answer:string):Promise<void>;
  stop(runId:string):Promise<void>;
  dispose():void;
  shutdown?():Promise<void>;
}
