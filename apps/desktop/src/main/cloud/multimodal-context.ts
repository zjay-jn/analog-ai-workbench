import {parseCloudChatRequestV1,cloudProviderProfileV1,CloudChatErrorV1,type CloudProviderV1} from '../../../../../packages/agent-adapters/src/cloud-chat-contract';
import {modelOption} from '../../shared/agent/model-options';import {parseImages,imageDimensions,imageDataUrl,type ImageAttachment} from '../../shared/agent/image-attachment';
import type {FileContext} from '../../shared/agent/file-context';
import {schematicContextPrompt} from '../../shared/schematic/schematic-context';
import type {SchematicContext} from '../../shared/schematic/reviewed-schematic';
import {parseReplyLimits,LEGACY_REPLY_LIMITS,MAX_REPLY_BYTES,type ReplyLimits} from '../../shared/agent/reply-limits';
export type MultimodalMessage={role:'user'|'assistant';content:string|({type:'text';text:string}|{type:'image_url';image_url:{url:string}})[]};
export type MultimodalRequest={provider:CloudProviderV1;model:string;maxOutputTokens:number;timeoutMs?:number;messages:MultimodalMessage[]};
export type MultimodalExecutor=(request:MultimodalRequest,options:{signal:AbortSignal;onText:(text:string)=>void})=>Promise<{text:string}>;
export const VISION_REQUEST_BYTES=1024*1024;
function validateTextMessages(messages:{role:string;content:string}[]){
 if(!messages.length||messages.length>17||messages.length%2!==1)throw new CloudChatErrorV1('INVALID_REQUEST');let total=0;
 for(const [i,m] of messages.entries()){if(m.role!==(i%2?'assistant':'user')||typeof m.content!=='string'||!m.content.trim()||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(m.content))throw new CloudChatErrorV1('INVALID_REQUEST');const bytes=Buffer.byteLength(m.content);total+=bytes;if(bytes>(i%2?MAX_REPLY_BYTES:16384)||total>512*1024)throw new CloudChatErrorV1('INVALID_REQUEST');}
}
export const multimodalBody=(request:MultimodalRequest)=>JSON.stringify({model:request.model,messages:request.messages,max_tokens:request.maxOutputTokens,stream:true,...(request.provider==='deepseek'?{thinking:{type:'disabled'}}:{reasoning_effort:'low'})});
export type MultimodalHistoryEntry={user:string;assistant:string;images?:ImageAttachment[];files?:FileContext[];schematics?:SchematicContext[]};
/** Shared candidate selection keeps reference revalidation and actual prompt filtering in the same order. */
export function selectMultimodalHistory(provider:CloudProviderV1,model:string,history:readonly MultimodalHistoryEntry[]){
 const option=modelOption(provider,model);return history.map(t=>({...t,user:schematicContextPrompt(t.user,t.files??[],t.schematics??[],true),images:option.vision?t.images:[]})).filter(t=>Buffer.byteLength(t.user)<=16384&&Buffer.byteLength(t.assistant)<=MAX_REPLY_BYTES).slice(-8);
}
export function buildMultimodalContext(provider:CloudProviderV1,model:string,text:string,images:ImageAttachment[],history:readonly {user:string;assistant:string;images?:ImageAttachment[];files?:FileContext[];schematics?:SchematicContext[]}[],files:FileContext[]=[],replyLimits:ReplyLimits=LEGACY_REPLY_LIMITS,schematics:SchematicContext[]=[]):MultimodalRequest{
 const option=modelOption(provider,model),attachments=parseImages(images),budget=parseReplyLimits(replyLimits.maxOutputTokens,replyLimits.timeoutMs);if(attachments.length&&!option.vision)throw new CloudChatErrorV1('INVALID_REQUEST');
 text=schematicContextPrompt(text,files,schematics);
 const pairs=selectMultimodalHistory(provider,model,history);
 for(;;){try{
  validateTextMessages([...pairs.flatMap(p=>[{role:'user',content:p.user},{role:'assistant',content:p.assistant}]),{role:'user',content:text}]);
  let count=0;const user=(content:string,values:ImageAttachment[]):MultimodalMessage=>{const parsed=parseImages(values);count+=parsed.length;if(count>2||(!option.vision&&parsed.length))throw Error();return {role:'user',content:parsed.length?[{type:'text',text:content},...parsed.map(image=>({type:'image_url' as const,image_url:{url:imageDataUrl(image)}}))]:content};};
  const request:MultimodalRequest={provider,model,...budget,messages:[...pairs.flatMap(p=>[user(p.user,p.images??[]),{role:'assistant' as const,content:p.assistant}]),user(text,attachments)]};
  if(Buffer.byteLength(multimodalBody(request))>VISION_REQUEST_BYTES)throw Error();return request;
 }catch{if(!pairs.length)throw new CloudChatErrorV1('INVALID_REQUEST');pairs.shift();}}
}
/** Revalidate the exact main-owned wire envelope before any fetch. */
export function validateMultimodalRequest(value:MultimodalRequest):MultimodalRequest{
 if(!value||Buffer.byteLength(JSON.stringify(value))>VISION_REQUEST_BYTES||Object.keys(value).sort().join(',')!==('timeoutMs'in value?'maxOutputTokens,messages,model,provider,timeoutMs':'maxOutputTokens,messages,model,provider'))throw new CloudChatErrorV1('INVALID_REQUEST');modelOption(value.provider,value.model);parseReplyLimits(value.maxOutputTokens,value.timeoutMs??30000);
 const textMessages:{role:'user'|'assistant';content:string}[]=[],images:ImageAttachment[]=[];
 for(const message of value.messages){
  if(Object.keys(message).sort().join(',')!=='content,role')throw new CloudChatErrorV1('INVALID_REQUEST');
  if(typeof message.content==='string'){textMessages.push({role:message.role,content:message.content});continue;}
  if(message.role!=='user'||!Array.isArray(message.content)||message.content.length<2||message.content.length>3)throw new CloudChatErrorV1('INVALID_REQUEST');
  let content='';for(let i=0;i<message.content.length;i++){const part=message.content[i]!;
   if(i===0){if(part.type!=='text'||Object.keys(part).sort().join(',')!=='text,type'||typeof part.text!=='string')throw new CloudChatErrorV1('INVALID_REQUEST');content=part.text;}
   else{if(part.type!=='image_url'||Object.keys(part).sort().join(',')!=='image_url,type'||Object.keys(part.image_url).join(',')!=='url'||!part.image_url.url.startsWith('data:image/jpeg;base64,'))throw new CloudChatErrorV1('INVALID_REQUEST');
    const data=part.image_url.url.slice(23);const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const dimensions=imageDimensions(bytes,'jpeg');images.push(...parseImages([{id:'00000000-0000-4000-8000-000000000000',name:'image.jpg',data,...dimensions}]));
   }
  }textMessages.push({role:'user',content});
 }
 if(images.length>2||(!modelOption(value.provider,value.model).vision&&images.length))throw new CloudChatErrorV1('INVALID_REQUEST');
 validateTextMessages(textMessages);if(Buffer.byteLength(multimodalBody(value))>VISION_REQUEST_BYTES)throw new CloudChatErrorV1('INVALID_REQUEST');return value;
}
