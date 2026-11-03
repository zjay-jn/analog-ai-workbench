import {parseAgentDesktopEventV1,type CanonicalEventV1} from './desktop-agent-api';
export const CLOUD_CHAT_API_VERSION_V2='workbench.cloud.chat.v2' as const;
export const CLOUD_READ_CHANNEL_V2='workbench.cloud.readRun.v2' as const;
export const CLOUD_CANCEL_CHANNEL_V2='workbench.cloud.cancelRun.v2' as const;
export const CLOUD_STATUS_CHANNEL_V2='workbench.cloud.getStatus.v2' as const;
export const CLOUD_SUBMIT_CHANNEL_V2='workbench.cloud.submitTextTurn.v2' as const;
export type CloudProviderIdV2='deepseek'|'kimi';
export type CloudFailureCodeV2='INVALID_REQUEST'|'CAPABILITY_DENIED'|'NOT_CONFIGURED'|'BUSY'|'SESSION_LIMIT'|'INTERNAL';
export type CloudFailureV2=Readonly<{ok:false;error:Readonly<{code:CloudFailureCodeV2}>}>;
export type CloudStatusRequestV2=Readonly<{contractVersion:typeof CLOUD_CHAT_API_VERSION_V2}>;
export type CloudSubmitRequestV2=Readonly<{contractVersion:typeof CLOUD_CHAT_API_VERSION_V2;providerId:CloudProviderIdV2;conversationId:string;clientRequestId:string;text:string}>;
export type CloudProviderStatusV2=Readonly<{providerId:CloudProviderIdV2;displayName:'DeepSeek'|'Kimi';modelId:string;configured:boolean;conversationId:string}>;
export type CloudStatusResultV2=CloudFailureV2|Readonly<{ok:true;value:Readonly<{contractVersion:typeof CLOUD_CHAT_API_VERSION_V2;providers:readonly CloudProviderStatusV2[]}>}>;
export type CloudSubmitResultV2=CloudFailureV2|Readonly<{ok:true;value:Readonly<{hostRunId:string}>}>;
export type CloudCancelRequestV2=Readonly<{contractVersion:typeof CLOUD_CHAT_API_VERSION_V2;hostRunId:string}>;
export type CloudReadRequestV2=CloudCancelRequestV2&Readonly<{afterSequence:number}>;
export type CloudCancelResultV2=CloudFailureV2|Readonly<{ok:true;value:Readonly<{status:'acknowledged'|'already_terminal'}>}>;
export type CloudReadResultV2=CloudFailureV2|Readonly<{ok:true;value:Readonly<{hostRunId:string;events:readonly CanonicalEventV1[];nextSequence:number;terminal:boolean}>}>;
export type WorkbenchCloudApiV2=Readonly<{getStatus:(request:CloudStatusRequestV2)=>Promise<CloudStatusResultV2>;submitTextTurn:(request:CloudSubmitRequestV2)=>Promise<CloudSubmitResultV2>;readRun:(request:CloudReadRequestV2)=>Promise<CloudReadResultV2>;cancelRun:(request:CloudCancelRequestV2)=>Promise<CloudCancelResultV2>}>;
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const clientId=new RegExp('^'+uuid+'$','u');const conversation=new RegExp('^conversation\\.cloud\\.'+uuid+'$','u');const hostRun=new RegExp('^host\\.'+uuid+'$','u');
function invalid():never{throw new TypeError('Invalid cloud chat contract');}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length)invalid();
  const out:Record<string,unknown>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)invalid();out[key]=d.value;}return out;
}
function provider(value:unknown):CloudProviderIdV2{if(value!=='deepseek'&&value!=='kimi')invalid();return value;}
function id(value:unknown,pattern:RegExp):string{if(typeof value!=='string'||!pattern.test(value))invalid();return value;}
function version(value:unknown):typeof CLOUD_CHAT_API_VERSION_V2{if(value!==CLOUD_CHAT_API_VERSION_V2)invalid();return value;}
function failure(value:unknown):CloudFailureV2{
  const input=exact(value,['ok','error']);const error=exact(input.error,['code']);if(input.ok!==false||!['INVALID_REQUEST','CAPABILITY_DENIED','NOT_CONFIGURED','BUSY','SESSION_LIMIT','INTERNAL'].includes(error.code as string))invalid();
  return Object.freeze({ok:false,error:Object.freeze({code:error.code as CloudFailureCodeV2})});
}
export function cloudFailureV2(code:CloudFailureCodeV2):CloudFailureV2{return failure({ok:false,error:{code}});}
export function parseCloudStatusRequestV2(value:unknown):CloudStatusRequestV2{return Object.freeze({contractVersion:version(exact(value,['contractVersion']).contractVersion)});}
export function parseCloudSubmitRequestV2(value:unknown):CloudSubmitRequestV2{
  const v=exact(value,['contractVersion','providerId','conversationId','clientRequestId','text']);
  if(typeof v.text!=='string'||!v.text.trim()||new TextEncoder().encode(v.text).length>16384||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v.text))invalid();
  return Object.freeze({contractVersion:version(v.contractVersion),providerId:provider(v.providerId),conversationId:id(v.conversationId,conversation),clientRequestId:id(v.clientRequestId,clientId),text:v.text});
}
export function parseCloudSubmitResultV2(value:unknown):CloudSubmitResultV2{
  if(value!==null&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'ok')?.value===false)return failure(value);
  const input=exact(value,['ok','value']);const result=exact(input.value,['hostRunId']);if(input.ok!==true)invalid();return Object.freeze({ok:true,value:Object.freeze({hostRunId:id(result.hostRunId,hostRun)})});
}
export function parseCloudStatusResultV2(value:unknown):CloudStatusResultV2{
  if(value!==null&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'ok')?.value===false)return failure(value);
  const input=exact(value,['ok','value']);const result=exact(input.value,['contractVersion','providers']);if(input.ok!==true)invalid();
  const values=result.providers;if(!Array.isArray(values)||Object.getPrototypeOf(values)!==Array.prototype||values.length>2||Reflect.ownKeys(values).length!==values.length+1)invalid();
  const providers:CloudProviderStatusV2[]=[];const seen=new Set<string>();
  for(let i=0;i<values.length;i++){
    const d=Object.getOwnPropertyDescriptor(values,String(i));if(!d||!('value'in d))invalid();
    const item=exact(d.value,['providerId','displayName','modelId','configured','conversationId']);const selected=provider(item.providerId);
    if(seen.has(selected)||item.displayName!==(selected==='deepseek'?'DeepSeek':'Kimi')||item.modelId!==(selected==='deepseek'?'deepseek-v4-flash':'kimi-k3')||typeof item.configured!=='boolean')invalid();seen.add(selected);
    providers.push(Object.freeze({providerId:selected,displayName:item.displayName as 'DeepSeek'|'Kimi',modelId:item.modelId as string,configured:item.configured,conversationId:id(item.conversationId,conversation)}));
  }
  return Object.freeze({ok:true,value:Object.freeze({contractVersion:version(result.contractVersion),providers:Object.freeze(providers)})});
}
function sequence(value:unknown):number {if(!Number.isSafeInteger(value)||Object.is(value,-0)||(value as number)<0||(value as number)>1024)invalid();return value as number;}
export function parseCloudCancelRequestV2(value:unknown):CloudCancelRequestV2 {
  const v=exact(value,['contractVersion','hostRunId']);return Object.freeze({contractVersion:version(v.contractVersion),hostRunId:id(v.hostRunId,hostRun)});
}
export function parseCloudReadRequestV2(value:unknown):CloudReadRequestV2 {
  const v=exact(value,['contractVersion','hostRunId','afterSequence']);return Object.freeze({contractVersion:version(v.contractVersion),hostRunId:id(v.hostRunId,hostRun),afterSequence:sequence(v.afterSequence)});
}
export function parseCloudCancelResultV2(value:unknown):CloudCancelResultV2 {
  if(value!==null&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'ok')?.value===false)return failure(value);
  const v=exact(value,['ok','value']);const result=exact(v.value,['status']);if(v.ok!==true||(result.status!=='acknowledged'&&result.status!=='already_terminal'))invalid();
  return Object.freeze({ok:true,value:Object.freeze({status:result.status})});
}
export function parseCloudReadResultV2(value:unknown):CloudReadResultV2 {
  if(value!==null&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'ok')?.value===false)return failure(value);
  const v=exact(value,['ok','value']);const r=exact(v.value,['hostRunId','events','nextSequence','terminal']);
  if(v.ok!==true||typeof r.terminal!=='boolean')invalid();const run=id(r.hostRunId,hostRun),next=sequence(r.nextSequence);
  const values=r.events;if(!Array.isArray(values)||Object.getPrototypeOf(values)!==Array.prototype||values.length>32||Reflect.ownKeys(values).length!==values.length+1)invalid();
  const events:CanonicalEventV1[]=[];
  for(let i=0;i<values.length;i++){
    const d=Object.getOwnPropertyDescriptor(values,String(i));if(!d||!('value'in d))invalid();const event=parseAgentDesktopEventV1(d.value);
    if(event.hostRunId!==run||event.hostSequence!==next-values.length+i+1||event.hostSequence>1024||event.type==='citation.declared')invalid();events.push(event);
  }
  const result=Object.freeze({ok:true as const,value:Object.freeze({hostRunId:run,events:Object.freeze(events),nextSequence:next,terminal:r.terminal})});
  if(new TextEncoder().encode(JSON.stringify(result)).length>262144)invalid();return result;
}
