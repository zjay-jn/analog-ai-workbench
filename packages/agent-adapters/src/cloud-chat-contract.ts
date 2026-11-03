export type CloudProviderV1 = 'deepseek' | 'kimi';
export type CloudChatErrorCodeV1 = 'INVALID_REQUEST' | 'NOT_CONFIGURED' | 'AUTHENTICATION_FAILED' | 'RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED' | 'PROTOCOL_ERROR' | 'RESPONSE_LIMIT' | 'OUTPUT_LIMIT' | 'FIRST_RESPONSE_TIMEOUT' | 'IDLE_TIMEOUT';
export class CloudChatErrorV1 extends Error {
  constructor(readonly code: CloudChatErrorCodeV1) { super(`Cloud chat failed: ${code}`); this.name='CloudChatErrorV1'; }
}
export const CLOUD_CHAT_LIMITS_V1=Object.freeze({messageBytes:16384,totalInputBytes:65536,messageCount:17,maxOutputTokens:2048,requestBytes:73728,responseBytes:524288,eventBytes:65536,lineBytes:65536,chunkBytes:65536,chunkCount:16384,modelsBytes:65536,modelCount:512,outputBytes:65536,eventCount:10000,timeoutMs:30000});
const profiles=Object.freeze({
  deepseek:Object.freeze({provider:'deepseek' as const,model:'deepseek-v4-flash',modelsUrl:'https://api.deepseek.com/models',chatUrl:'https://api.deepseek.com/chat/completions'}),
  kimi:Object.freeze({provider:'kimi' as const,model:'kimi-k3',modelsUrl:'https://api.moonshot.cn/v1/models',chatUrl:'https://api.moonshot.cn/v1/chat/completions'}),
});
export function cloudProviderProfileV1(provider:unknown) {
  if(provider!=='deepseek'&&provider!=='kimi')throw new CloudChatErrorV1('INVALID_REQUEST');
  return profiles[provider];
}
export type CloudChatMessageV1=Readonly<{role:'user'|'assistant';content:string}>;
export type CloudChatRequestV1=Readonly<{provider:CloudProviderV1;model:string;messages:readonly CloudChatMessageV1[];maxOutputTokens:number}>;
function invalid():never{throw new CloudChatErrorV1('INVALID_REQUEST');}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).length!==keys.length)invalid();
  const out:Record<string,unknown>={};
  for(const key of keys){const d=descriptors[key];if(d===undefined||!('value'in d)||!d.enumerable)invalid();out[key]=d.value;}
  return out;
}
function wellFormed(text:string):boolean {
  for(let i=0;i<text.length;i++){const n=text.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(n>=0xdc00&&n<=0xdfff)return false;}
  return true;
}
export function parseCloudChatRequestV1(value:unknown):CloudChatRequestV1 {
  const input=exact(value,['provider','model','messages','maxOutputTokens']);
  const profile=cloudProviderProfileV1(input.provider);
  if(input.model!==profile.model||!Number.isSafeInteger(input.maxOutputTokens)||(input.maxOutputTokens as number)<1||(input.maxOutputTokens as number)>CLOUD_CHAT_LIMITS_V1.maxOutputTokens)invalid();
  const values=input.messages;
  if(!Array.isArray(values)||Object.getPrototypeOf(values)!==Array.prototype||values.length<1||values.length>CLOUD_CHAT_LIMITS_V1.messageCount||values.length%2!==1||Reflect.ownKeys(values).length!==values.length+1)invalid();
  let total=0;const encoder=new TextEncoder();const messages:CloudChatMessageV1[]=[];
  for(let i=0;i<values.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(values,String(i));if(!descriptor||!('value'in descriptor))invalid();
    const message=exact(descriptor.value,['role','content']);
    if(message.role!==(i%2===0?'user':'assistant')||typeof message.content!=='string'||!message.content.trim()||!wellFormed(message.content))invalid();
    const bytes=encoder.encode(message.content).length;total+=bytes;
    if(bytes>CLOUD_CHAT_LIMITS_V1.messageBytes||total>CLOUD_CHAT_LIMITS_V1.totalInputBytes)invalid();
    messages.push(Object.freeze({role:message.role as 'user'|'assistant',content:message.content}));
  }
  return Object.freeze({provider:profile.provider,model:profile.model,messages:Object.freeze(messages),maxOutputTokens:input.maxOutputTokens as number});
}
