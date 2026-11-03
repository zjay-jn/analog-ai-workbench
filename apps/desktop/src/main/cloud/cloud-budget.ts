import {CLOUD_CHAT_LIMITS_V1 as limits, cloudProviderProfileV1, parseCloudChatRequestV1, CloudChatErrorV1, type CloudChatRequestV1, type CloudProviderV1} from '../../../../../packages/agent-adapters/src/cloud-chat-contract';

export type CloudHistoryPairV2=Readonly<{user:string;assistant:string}>;
const bytes=(text:string)=>new TextEncoder().encode(text).length;
// This serializer mirrors the reviewed P5-A transport; parity is tested through fake fetch.
export function cloudRequestBodyV2(input:CloudChatRequestV1):string {
  return JSON.stringify({model:input.model,messages:input.messages,max_tokens:input.maxOutputTokens,stream:true,...(input.provider==='deepseek'?{thinking:{type:'disabled'}}:{reasoning_effort:'low'})});
}
export function buildCloudContextV2(provider:CloudProviderV1,text:string,history:readonly CloudHistoryPairV2[],maxOutputTokens=2048):CloudChatRequestV1 {
  const pairs=history.filter(pair=>bytes(pair.user)<=limits.messageBytes&&bytes(pair.assistant)<=limits.messageBytes).slice(-8);
  for(;;){
    try {
      const request=parseCloudChatRequestV1({provider,model:cloudProviderProfileV1(provider).model,maxOutputTokens,messages:[...pairs.flatMap(pair=>[{role:'user',content:pair.user},{role:'assistant',content:pair.assistant}]),{role:'user',content:text}]});
      if(bytes(cloudRequestBodyV2(request))<=limits.requestBytes)return request;
    } catch(error) {if(!(error instanceof CloudChatErrorV1))throw error;}
    if(!pairs.length)throw new CloudChatErrorV1('INVALID_REQUEST');
    pairs.shift();
  }
}
export function splitCloudDeltaV2(text:string):readonly string[] {
  const parts:string[]=[];let part='',size=0;
  for(const point of text){
    const value=point.codePointAt(0)!;
    if(value>=0xd800&&value<=0xdfff)throw new CloudChatErrorV1('PROTOCOL_ERROR');
    const count=bytes(point);
    if(size+count>4096){parts.push(part);part='';size=0;}
    part+=point;size+=count;
  }
  if(part)parts.push(part);
  return Object.freeze(parts);
}
