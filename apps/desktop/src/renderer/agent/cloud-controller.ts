import {CLOUD_CHAT_API_VERSION_V2 as contractVersion,parseCloudStatusResultV2,parseCloudReadResultV2,type WorkbenchCloudApiV2,type CloudProviderStatusV2,type CloudProviderIdV2} from '../../shared/agent/cloud-chat-api';
export type CloudTurnViewV2=Readonly<{id:string;user:string;assistant:string;status:'running'|'completed'|'failed'|'cancelled';error:string;elapsedMs?:number}>;
export type CloudViewV2=Readonly<{ready:boolean;providers:readonly CloudProviderStatusV2[];selected:CloudProviderIdV2;busy:boolean;error:string;turns:Readonly<Record<CloudProviderIdV2,readonly CloudTurnViewV2[]>>}>;
export const initialCloudViewV2=():CloudViewV2=>({ready:false,providers:[],selected:'deepseek',busy:false,error:'',turns:{deepseek:[],kimi:[]}});
export function cloudErrorTextV2(code:string):string {
  const messages:Record<string,string>={INVALID_REQUEST:'消息格式或长度超出限制，请缩短后发送。',CAPABILITY_DENIED:'当前会话已失效，请重新打开软件。',NOT_CONFIGURED:'模型服务未配置或凭据不可用。',BUSY:'上一条请求仍在运行，请稍后再发送。',SESSION_LIMIT:'本次会话已达到 32 次请求上限，请重新打开软件。',RATE_LIMITED:'服务请求频率受限，请稍后手动发送。',UPSTREAM_TIMEOUT:'服务响应超时，已保留收到的内容。',STREAM_INTERRUPTED:'回复未完整结束，已保留收到的内容。',ADAPTER_UNAVAILABLE:'暂时无法连接模型服务。',INTERNAL:'读取回复失败，请稍后手动发送。'};
  return messages[code]??messages.INTERNAL!;
}
export function createCloudControllerV2(api:WorkbenchCloudApiV2,onChange:(view:CloudViewV2)=>void,timing:Readonly<{schedule:(fn:()=>void,ms:number)=>unknown;clear:(handle:unknown)=>void;uuid:()=>string}>={schedule:(fn,ms)=>setTimeout(fn,ms),clear:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>),uuid:()=>crypto.randomUUID()}) {
  let state=initialCloudViewV2(),disposed=false,generation=0,timer:unknown,runId:string|undefined,cursor=0,startedAt=0;
  const update=(next:Partial<CloudViewV2>)=>{if(disposed)return;state=Object.freeze({...state,...next});onChange(state);};
  function turnUpdate(id:string,patch:Partial<CloudTurnViewV2>):void{const provider=state.selected;update({turns:{...state.turns,[provider]:state.turns[provider].map(turn=>turn.id===id?Object.freeze({...turn,...patch}):turn)}});}
  function error(code:string,id?:string):void {if(id)turnUpdate(id,{status:'failed',error:cloudErrorTextV2(code),elapsedMs:Math.max(0,Math.round(performance.now()-startedAt))});update({busy:false,error:cloudErrorTextV2(code)});runId=undefined;}
  async function poll(epoch:number,id:string):Promise<void> {
    if(disposed||epoch!==generation||!runId)return;
    try{
      const target=runId;const result=parseCloudReadResultV2(await api.readRun({contractVersion,hostRunId:target,afterSequence:cursor}));
      if(disposed||epoch!==generation)return;if(!result.ok){error(result.error.code,id);return;}
      const batch=result.value;if(batch.hostRunId!==target||batch.nextSequence!==cursor+batch.events.length)throw Error();
      let assistant=state.turns[state.selected].find(t=>t.id===id)!.assistant;let terminal:CloudTurnViewV2['status']|undefined,reason='';
      for(const event of batch.events){
        if(terminal)throw Error();
        if(event.type==='run.accepted'){
          if(event.hostSequence!==1||event.payload.turnId!==`turn.${id}`||event.payload.conversationId!==state.providers.find(p=>p.providerId===state.selected)!.conversationId)throw Error();
        } else if(event.hostSequence===1)throw Error();
        else if(event.type==='message.delta'){assistant+=event.payload.text;if(new TextEncoder().encode(assistant).length>65536)throw Error();}
        else if(event.type==='run.completed')terminal='completed';
        else if(event.type==='run.cancelled')terminal='cancelled';
        else if(event.type==='run.failed'){terminal='failed';reason=cloudErrorTextV2(event.payload.errorCode);}
        else throw Error();
      }
      if(Boolean(terminal)!==batch.terminal)throw Error();cursor=batch.nextSequence;
      turnUpdate(id,{assistant,...(terminal?{status:terminal,error:reason,elapsedMs:Math.max(0,Math.round(performance.now()-startedAt))}:{})});
      if(terminal){runId=undefined;update({busy:false,error:reason});return;}
      timer=timing.schedule(()=>{void poll(epoch,id);},250);
    }catch{if(!disposed&&epoch===generation)error('INTERNAL',id);}
  }
  return Object.freeze({
    snapshot:()=>state,
    async initialize(){try{const result=parseCloudStatusResultV2(await api.getStatus({contractVersion}));if(disposed)return;if(!result.ok){error(result.error.code);return;}update({ready:true,providers:result.value.providers,selected:result.value.providers.find(p=>p.configured)?.providerId??'deepseek'});}catch{error('INTERNAL');}},
    select(provider:CloudProviderIdV2){if(!state.busy&&state.providers.some(p=>p.providerId===provider))update({selected:provider,error:''});},
    async send(text:string):Promise<boolean>{
      if(disposed||state.busy||!state.ready||!text.trim())return false;
      const selected=state.providers.find(p=>p.providerId===state.selected);if(!selected?.configured){error('NOT_CONFIGURED');return false;}
      const id=timing.uuid(),epoch=++generation;startedAt=performance.now();update({busy:true,error:''});
      try{
        const result=await api.submitTextTurn({contractVersion,providerId:state.selected,conversationId:selected.conversationId,clientRequestId:id,text});
        if(disposed||epoch!==generation)return false;if(!result.ok){error(result.error.code);return false;}
        runId=result.value.hostRunId;cursor=0;update({turns:{...state.turns,[state.selected]:[...state.turns[state.selected],Object.freeze({id,user:text,assistant:'',status:'running' as const,error:''})]}});
        void poll(epoch,id);return true;
      }catch{if(!disposed&&epoch===generation)error('INTERNAL');return false;}
    },
    async cancel(){if(!runId||disposed)return;const target=runId,epoch=generation;try{const result=await api.cancelRun({contractVersion,hostRunId:target});if(!disposed&&epoch===generation&&!result.ok)update({error:cloudErrorTextV2(result.error.code)});}catch{if(!disposed&&epoch===generation)update({error:cloudErrorTextV2('INTERNAL')});}},
    dispose(){disposed=true;generation++;if(timer!==undefined)timing.clear(timer);runId=undefined;},
  });
}
export function cloudEnterSendsV2(input:Readonly<{key:string;shiftKey:boolean;isComposing:boolean;keyCode?:number}>):boolean{return input.key==='Enter'&&!input.shiftKey&&!input.isComposing&&input.keyCode!==229;}
