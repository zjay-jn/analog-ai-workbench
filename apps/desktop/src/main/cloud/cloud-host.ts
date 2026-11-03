import {randomUUID} from 'node:crypto';
import {parseCanonicalEventV1,type CanonicalEventV1,type CanonicalPayloadByTypeV1} from '../../../../../packages/agent-adapters/src/canonical-contract';
import {sha256CanonicalAawJsonV1} from '../../../../../packages/schematic-workbench/src/canonical-json';
import {CloudChatErrorV1,type CloudChatRequestV1} from '../../../../../packages/agent-adapters/src/cloud-chat-contract';
import {createAgentCallerFenceV1,type AgentCallerContextV1} from '../agent/agent-caller-fence';
import {buildCloudContextV2,splitCloudDeltaV2,type CloudHistoryPairV2} from './cloud-budget';
import {CLOUD_CHAT_API_VERSION_V2 as version,cloudFailureV2,parseCloudStatusRequestV2,parseCloudSubmitRequestV2,parseCloudReadRequestV2,parseCloudCancelRequestV2,type CloudProviderIdV2,type CloudSubmitRequestV2,type CloudStatusResultV2,type CloudSubmitResultV2,type CloudReadResultV2,type CloudCancelResultV2} from '../../shared/agent/cloud-chat-api';

export type CloudExecutorV2=(request:CloudChatRequestV1,options:Readonly<{signal:AbortSignal;onText:(text:string)=>void}>)=>Promise<Readonly<{text:string}>>;
type Run={id:string;request:CloudSubmitRequestV2;events:CanonicalEventV1[];bytes:number;text:string;settled:boolean;abort:AbortController};
const byteLength=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
export function createCloudHostV2(options:Readonly<{owner:AgentCallerContextV1;cloudEnabled:boolean;configured:Readonly<Record<CloudProviderIdV2,boolean>>;execute:CloudExecutorV2;maxOutputTokens?:Readonly<Record<CloudProviderIdV2,number>>}>) {
  const fence=createAgentCallerFenceV1({caller:options.owner,capabilities:options.cloudEnabled?['start_turn','subscribe_run','cancel_run']:[],generation:1});
  let revoked=false,active:Run|undefined,execute:CloudExecutorV2|undefined=options.execute;
  const conversations={deepseek:`conversation.cloud.${randomUUID()}`,kimi:`conversation.cloud.${randomUUID()}`};
  const history:Record<CloudProviderIdV2,CloudHistoryPairV2[]>={deepseek:[],kimi:[]};
  const runs=new Map<string,Run>(),requests=new Map<string,Run>();
  const allowed=(caller:unknown,operation:'startTurn'|'subscribeRun'|'cancelRun')=>!revoked&&fence.authorizeInvocation({caller,operation}).allowed;
  function event<T extends keyof CanonicalPayloadByTypeV1>(run:Run,type:T,payload:CanonicalPayloadByTypeV1[T],offset=1):CanonicalEventV1 {
    return parseCanonicalEventV1({hostRunId:run.id,eventId:`event.${randomUUID()}`,hostSequence:run.events.length+offset,acceptedAt:new Date().toISOString(),canonicalPayloadDigest:sha256CanonicalAawJsonV1(payload),type,payload});
  }
  const append=(run:Run,value:CanonicalEventV1)=>{run.events.push(value);run.bytes+=byteLength(value);};
  function terminal(run:Run,type:'run.completed'|'run.failed'|'run.cancelled',payload:CanonicalPayloadByTypeV1[typeof type]):void {
    if(revoked||run.settled)return;
    run.settled=true;append(run,event(run,type,payload));if(active===run)active=undefined;
  }
  function fail(run:Run,error:unknown):void {
    const code=error instanceof CloudChatErrorV1?error.code:'UPSTREAM_UNAVAILABLE';
    const errorCode=code==='AUTHENTICATION_FAILED'||code==='NOT_CONFIGURED'?'NOT_CONFIGURED':code==='RATE_LIMITED'?'RATE_LIMITED':code==='TIMEOUT'?'UPSTREAM_TIMEOUT':['OUTPUT_LIMIT','RESPONSE_LIMIT','PROTOCOL_ERROR'].includes(code)?'STREAM_INTERRUPTED':'ADAPTER_UNAVAILABLE';
    terminal(run,'run.failed',{errorCode,retryability:'never',recoveryAction:errorCode==='NOT_CONFIGURED'?'reconfigure':'start_new_run'});
    run.abort.abort();
  }
  function onText(run:Run,text:string):void {
    if(revoked||run.settled)return;
    try {
      if(Buffer.byteLength(run.text)+Buffer.byteLength(text)>65536)throw new CloudChatErrorV1('OUTPUT_LIMIT');
      const parts=splitCloudDeltaV2(text);
      if(run.events.length+parts.length+1>1024)throw new CloudChatErrorV1('RESPONSE_LIMIT');
      const events=parts.map((part,index)=>event(run,'message.delta',{text:part},index+1));
      if(run.bytes+events.reduce((total,item)=>total+byteLength(item),0)+4096>8388608)throw new CloudChatErrorV1('RESPONSE_LIMIT');
      for(const item of events)append(run,item);run.text+=text;
    } catch(error){fail(run,error);}
  }
  return Object.freeze({
    getStatus(caller:unknown,value:unknown):CloudStatusResultV2 {
      if(!allowed(caller,'startTurn'))return cloudFailureV2('CAPABILITY_DENIED');
      try{parseCloudStatusRequestV2(value);}catch{return cloudFailureV2('INVALID_REQUEST');}
      return Object.freeze({ok:true,value:Object.freeze({contractVersion:version,providers:Object.freeze((['deepseek','kimi'] as const).map(providerId=>Object.freeze({providerId,displayName:providerId==='deepseek'?'DeepSeek' as const:'Kimi' as const,modelId:providerId==='deepseek'?'deepseek-v4-flash':'kimi-k3',configured:options.configured[providerId],conversationId:conversations[providerId]})))})});
    },
    submitTextTurn(caller:unknown,value:unknown):CloudSubmitResultV2 {
      if(!allowed(caller,'startTurn'))return cloudFailureV2('CAPABILITY_DENIED');
      let request:CloudSubmitRequestV2;try{request=parseCloudSubmitRequestV2(value);}catch{return cloudFailureV2('INVALID_REQUEST');}
      if(conversations[request.providerId]!==request.conversationId)return cloudFailureV2('CAPABILITY_DENIED');
      const prior=requests.get(request.clientRequestId);
      if(prior)return prior.request.providerId===request.providerId&&prior.request.conversationId===request.conversationId&&prior.request.text===request.text?Object.freeze({ok:true,value:Object.freeze({hostRunId:prior.id})}):cloudFailureV2('INVALID_REQUEST');
      if(active)return cloudFailureV2('BUSY');if(runs.size>=32)return cloudFailureV2('SESSION_LIMIT');if(!options.configured[request.providerId])return cloudFailureV2('NOT_CONFIGURED');
      let context:CloudChatRequestV1;try{context=buildCloudContextV2(request.providerId,request.text,history[request.providerId],options.maxOutputTokens?.[request.providerId]??2048);}catch{return cloudFailureV2('INVALID_REQUEST');}
      const run:Run={id:`host.${randomUUID()}`,request,events:[],bytes:0,text:'',settled:false,abort:new AbortController()};
      append(run,event(run,'run.accepted',{conversationId:request.conversationId,turnId:`turn.${request.clientRequestId}`,adapterProfileId:`profile.cloud.${request.providerId}`,adapterProfileRevision:'rev-1'}));
      runs.set(run.id,run);requests.set(request.clientRequestId,run);active=run;
      void Promise.resolve().then(async()=>{
        if(revoked||run.settled||!execute)return;
        try {
          const result=await execute(context,{signal:run.abort.signal,onText:text=>onText(run,text)});
          if(revoked||run.settled)return;
          if(!run.text.trim()||result.text!==run.text){fail(run,new CloudChatErrorV1('PROTOCOL_ERROR'));return;}
          terminal(run,'run.completed',{finishReason:'completed'});
          if(Buffer.byteLength(run.text)<=16384){history[request.providerId].push(Object.freeze({user:request.text,assistant:run.text}));history[request.providerId]=history[request.providerId].slice(-8);}
        } catch(error){fail(run,error);}
      });
      return Object.freeze({ok:true,value:Object.freeze({hostRunId:run.id})});
    },
    readRun(caller:unknown,value:unknown):CloudReadResultV2 {
      if(!allowed(caller,'subscribeRun'))return cloudFailureV2('CAPABILITY_DENIED');
      let request;try{request=parseCloudReadRequestV2(value);}catch{return cloudFailureV2('INVALID_REQUEST');}
      const run=runs.get(request.hostRunId);if(!run)return cloudFailureV2('CAPABILITY_DENIED');
      if(request.afterSequence>run.events.length)return cloudFailureV2('INVALID_REQUEST');
      const events:CanonicalEventV1[]=[];let nextSequence=request.afterSequence;
      for(const item of run.events.slice(request.afterSequence,request.afterSequence+32)){
        const candidate={ok:true,value:{hostRunId:run.id,events:[...events,item],nextSequence:item.hostSequence,terminal:run.settled&&item.hostSequence===run.events.length}};
        if(byteLength(candidate)>262144)break;events.push(item);nextSequence=item.hostSequence;
      }
      return Object.freeze({ok:true,value:Object.freeze({hostRunId:run.id,events:Object.freeze(events),nextSequence,terminal:run.settled&&nextSequence===run.events.length})});
    },
    cancelRun(caller:unknown,value:unknown):CloudCancelResultV2 {
      if(!allowed(caller,'cancelRun'))return cloudFailureV2('CAPABILITY_DENIED');
      let request;try{request=parseCloudCancelRequestV2(value);}catch{return cloudFailureV2('INVALID_REQUEST');}
      const run=runs.get(request.hostRunId);if(!run)return cloudFailureV2('CAPABILITY_DENIED');
      if(run.settled)return Object.freeze({ok:true,value:Object.freeze({status:'already_terminal'})});
      terminal(run,'run.cancelled',{reason:'cancelled'});run.abort.abort();return Object.freeze({ok:true,value:Object.freeze({status:'acknowledged'})});
    },
    revoke():void {if(revoked)return;revoked=true;for(const run of runs.values()){run.settled=true;run.abort.abort();run.events.length=0;run.text='';}runs.clear();requests.clear();history.deepseek=[];history.kimi=[];active=undefined;execute=undefined;},
    snapshot(){return Object.freeze({revoked,runs:runs.size,requests:requests.size,running:active?1:0,subscriptions:0});},
  });
}
