import {CloudChatErrorV1,CLOUD_CHAT_LIMITS_V1 as limits,cloudProviderProfileV1,parseCloudChatRequestV1} from '../../../../../packages/agent-adapters/src/cloud-chat-contract';
import {createCloudChatStreamParserV1,type CloudChatStreamResultV1} from '../../../../../packages/agent-adapters/src/cloud-chat-stream';
import {validateMultimodalRequest,multimodalBody,type MultimodalRequest} from './multimodal-context';
import {validateUnifiedChatRequest,UnifiedChatContextError} from './unified-chat-context';
import {REPLY_EVENT_COUNT,replyBodyBytes,replyWireBytes,REPLY_FIRST_MS,REPLY_IDLE_MS} from '../../shared/agent/reply-limits';

export type CloudFetchV1=(url:string,init:RequestInit)=>Promise<Response>;
export type CloudTransportOptionsV1=Readonly<{apiKey:string;signal?:AbortSignal;fetchImpl?:CloudFetchV1;timeoutMs?:number}>;
type RequestScope=Readonly<{signal:AbortSignal;race:<T>(promise:Promise<T>)=>Promise<T>;assertActive:()=>void;progress:()=>void}>;
function cancelBody(response:Response):void{try{void response.body?.cancel().catch(()=>{});}catch{}}
function configured(key:unknown):asserts key is string{if(typeof key!=='string'||!/^sk-[A-Za-z0-9_-]{8,512}$/u.test(key))throw new CloudChatErrorV1('NOT_CONFIGURED');}

async function bounded<T>(options:CloudTransportOptionsV1,operation:(scope:RequestScope)=>Promise<T>,maxTimeout:number=limits.timeoutMs,progressWait?:{firstMs:number;idleMs:number}):Promise<T>{
  configured(options.apiKey);
  const timeout=options.timeoutMs??limits.timeoutMs;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>maxTimeout)throw new CloudChatErrorV1('INVALID_REQUEST');
  if(options.signal?.aborted)throw new CloudChatErrorV1('CANCELLED');
  const controller=new AbortController();let reason:CloudChatErrorV1|undefined;let settled=false;
  let rejectAbort!:(error:CloudChatErrorV1)=>void;
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});void aborted.catch(()=>{});
  const stop=(code:'CANCELLED'|'TIMEOUT'|'FIRST_RESPONSE_TIMEOUT'|'IDLE_TIMEOUT')=>{if(settled||reason)return;reason=new CloudChatErrorV1(code);controller.abort();rejectAbort(reason);};
  const onAbort=()=>stop('CANCELLED');
  options.signal?.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>stop('TIMEOUT'),timeout);
  let progressTimer:ReturnType<typeof setTimeout>|undefined=progressWait?setTimeout(()=>stop('FIRST_RESPONSE_TIMEOUT'),progressWait.firstMs):undefined;
  const progress=()=>{if(!progressWait)return;if(progressTimer)clearTimeout(progressTimer);progressTimer=setTimeout(()=>stop('IDLE_TIMEOUT'),progressWait.idleMs);};
  const assertActive=()=>{if(reason)throw reason;if(options.signal?.aborted){stop('CANCELLED');throw reason!;}};
  try{
    assertActive();
    const result=await operation({signal:controller.signal,progress,race:<U>(promise:Promise<U>)=>Promise.race([promise,aborted]),assertActive});
    assertActive();settled=true;return result;
  }catch(error){
    settled=true;
    if(reason)throw reason;
    throw error instanceof CloudChatErrorV1?error:new CloudChatErrorV1('UPSTREAM_UNAVAILABLE');
  }finally{clearTimeout(timer);if(progressTimer)clearTimeout(progressTimer);options.signal?.removeEventListener('abort',onAbort);controller.abort();}
}

async function fetchResponse(url:string,init:RequestInit,options:CloudTransportOptionsV1,scope:RequestScope,mime:string):Promise<Response>{
  scope.assertActive();
  const fetchImpl=options.fetchImpl??((target,config)=>fetch(target,config));
  const pending=Promise.resolve().then(()=>{scope.assertActive();return fetchImpl(url,{...init,redirect:'error',signal:scope.signal,headers:{'Authorization':`Bearer ${options.apiKey}`,'Accept':mime,...(init.method==='POST'?{'Content-Type':'application/json'}:{})}});});
  void pending.then(response=>{if(scope.signal.aborted)cancelBody(response);},()=>{});
  const response=await scope.race(pending);scope.assertActive();
  if(response.redirected||(response.url&&response.url!==url)){cancelBody(response);throw new CloudChatErrorV1('PROTOCOL_ERROR');}
  if(!response.ok){cancelBody(response);throw new CloudChatErrorV1(response.status===401||response.status===403?'AUTHENTICATION_FAILED':response.status===429?'RATE_LIMITED':'UPSTREAM_UNAVAILABLE');}
  if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!==mime||!response.body){cancelBody(response);throw new CloudChatErrorV1('PROTOCOL_ERROR');}
  return response;
}

async function readBody(response:Response,scope:RequestScope,maxBytes:number,onChunk:(bytes:Uint8Array)=>void,modern=false):Promise<void>{
  const reader=response.body!.getReader();let bytes=0,chunks=0;
  try{
    while(true){
      scope.assertActive();const item=await scope.race(reader.read());scope.assertActive();
      if(item.done)return;
      if(!(item.value instanceof Uint8Array))throw new CloudChatErrorV1('PROTOCOL_ERROR');
      chunks++;bytes+=item.value.byteLength;
      if((!modern&&(chunks>(maxBytes>limits.responseBytes?65536:limits.chunkCount)||item.value.byteLength>limits.chunkBytes))||bytes>maxBytes)throw new CloudChatErrorV1('RESPONSE_LIMIT');
      onChunk(item.value);scope.assertActive();
    }
  }finally{try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
}

export async function performCloudChatV1(value:unknown,options:CloudTransportOptionsV1&Readonly<{onText:(text:string)=>void}>):Promise<CloudChatStreamResultV1>{
  const input=parseCloudChatRequestV1(value);const profile=cloudProviderProfileV1(input.provider);
  const body=JSON.stringify({model:input.model,messages:input.messages,max_tokens:input.maxOutputTokens,stream:true,...(input.provider==='deepseek'?{thinking:{type:'disabled'}}:{reasoning_effort:'low'})});
  if(new TextEncoder().encode(body).length>limits.requestBytes)throw new CloudChatErrorV1('INVALID_REQUEST');
  return bounded(options,async scope=>{
    const parser=createCloudChatStreamParserV1(text=>{scope.assertActive();options.onText(text);scope.assertActive();});
    const response=await fetchResponse(profile.chatUrl,{method:'POST',body},options,scope,'text/event-stream');
    await readBody(response,scope,limits.responseBytes,bytes=>parser.push(bytes));scope.assertActive();return parser.finish();
  });
}

export async function listCloudModelsV1(provider:unknown,options:CloudTransportOptionsV1):Promise<readonly string[]>{
  const profile=cloudProviderProfileV1(provider);
  return bounded(options,async scope=>{
    const response=await fetchResponse(profile.modelsUrl,{method:'GET'},options,scope,'application/json');
    const decoder=new TextDecoder('utf-8',{fatal:true});let text='';
    try{
      await readBody(response,scope,limits.modelsBytes,bytes=>{text+=decoder.decode(bytes,{stream:true});});text+=decoder.decode();
      const value:unknown=JSON.parse(text);
      if(value===null||typeof value!=='object'||!('data'in value)||!Array.isArray(value.data))throw new CloudChatErrorV1('PROTOCOL_ERROR');
      if(value.data.length>limits.modelCount)throw new CloudChatErrorV1('RESPONSE_LIMIT');
      const ids=value.data.map((item:unknown)=>{
        if(item===null||typeof item!=='object'||!('id'in item)||typeof item.id!=='string'||!/^(?!sk-)[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(item.id))throw new CloudChatErrorV1('PROTOCOL_ERROR');
        return item.id;
      });return Object.freeze([...new Set(ids)]);
    }catch(error){throw error instanceof CloudChatErrorV1?error:new CloudChatErrorV1('PROTOCOL_ERROR');}
  });
}

export async function performCloudChatV2(value:MultimodalRequest,options:CloudTransportOptionsV1&Readonly<{onText:(text:string)=>void;unifiedContext?:true}>):Promise<CloudChatStreamResultV1>{
 // This flag is supplied by the main-owned coordinator, never by a renderer request.
 let input:MultimodalRequest;try{input=options.unifiedContext===true?validateUnifiedChatRequest(value):validateMultimodalRequest(value);}catch(error){if(error instanceof UnifiedChatContextError)throw error;throw new CloudChatErrorV1('INVALID_REQUEST');}
 const profile=cloudProviderProfileV1(input.provider),body=multimodalBody(input);
 return bounded({...options,timeoutMs:input.timeoutMs??30000},async scope=>{
  const parser=createCloudChatStreamParserV1(text=>{scope.assertActive();options.onText(text);scope.assertActive();},{responseBytes:replyWireBytes(input.maxOutputTokens),eventCount:REPLY_EVENT_COUNT,outputBytes:replyBodyBytes(input.maxOutputTokens),onProgress:scope.progress});
  const response=await fetchResponse(profile.chatUrl,{method:'POST',body},options,scope,'text/event-stream');await readBody(response,scope,replyWireBytes(input.maxOutputTokens),bytes=>parser.push(bytes),true);scope.assertActive();return parser.finish();
 },900000,{firstMs:REPLY_FIRST_MS,idleMs:REPLY_IDLE_MS});
}
