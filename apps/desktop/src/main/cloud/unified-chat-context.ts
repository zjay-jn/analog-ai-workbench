import {createHash} from 'node:crypto';
import {CloudChatErrorV1} from '../../../../../packages/agent-adapters/src/cloud-chat-contract';
import type {CloudProviderIdV2} from '../../shared/agent/cloud-chat-api';
import {parseChatClarifications,type ChatClarification} from '../../shared/agent/chat-turns';
import {modelOption} from '../../shared/agent/model-options';
import {IMAGE_BYTES,IMAGE_COUNT,parseImages,parseImageAttachment,imageDimensions,imageDataUrl,type ImageAttachment} from '../../shared/agent/image-attachment';
import {parseFileContexts,type FileContext} from '../../shared/agent/file-context';
import {parseSchematicContexts,schematicCanonical,type SchematicContext} from '../../shared/schematic/reviewed-schematic';
import {messageTextDefault,schematicContextPrompt} from '../../shared/schematic/schematic-context';
import {parseReplyLimits,MAX_REPLY_BYTES,type ReplyLimits} from '../../shared/agent/reply-limits';
import {multimodalBody,VISION_REQUEST_BYTES,type MultimodalHistoryEntry,type MultimodalMessage,type MultimodalRequest} from './multimodal-context';

export type UnifiedChatContextInput={
  provider:CloudProviderIdV2;model:string;text:string;images:ImageAttachment[];
  files:FileContext[];schematics:SchematicContext[];
  history:readonly (MultimodalHistoryEntry & {turnId:string;clarifications?:readonly ChatClarification[]})[];replyLimits:ReplyLimits;
};

const MAX_USER_BYTES=16384;
const OMITTED_HISTORY_IMAGES='\n\n[历史图片未发送：当前模型仅支持文字；本轮保留原历史正文与文字附件。]';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BAD_SURROGATE=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export class UnifiedChatContextError extends Error {
  readonly code='CONTEXT_LIMIT' as const;
  constructor(readonly limit:'turns'|'user_bytes'|'reply_bytes'|'text_bytes'|'images'|'wire_bytes'){
    super(`Unified chat context exceeds ${limit}; no history was removed.`);
    this.name='UnifiedChatContextError';
  }
}
function invalid():never{throw new CloudChatErrorV1('INVALID_REQUEST');}
function limit(kind:UnifiedChatContextError['limit']):never{throw new UnifiedChatContextError(kind);}
function exact(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)invalid();
  const keys=Reflect.ownKeys(value),allowed=new Set([...required,...optional]),result:Record<string,unknown>={};
  if(keys.some(key=>typeof key!=='string'||!allowed.has(key))||required.some(key=>!Object.hasOwn(value,key)))invalid();
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!descriptor||!('value'in descriptor)||!descriptor.enumerable)invalid();result[key]=descriptor.value;}
  return result;
}
function dense(value:unknown):unknown[]{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||Reflect.ownKeys(value).length!==value.length+1)invalid();
  return Array.from({length:value.length},(_,index)=>{const descriptor=Object.getOwnPropertyDescriptor(value,String(index));if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)invalid();return descriptor.value;});
}
function text(value:unknown,allowEmpty=false):string{
  if(typeof value!=='string'||(!allowEmpty&&!value.trim())||BAD_SURROGATE.test(value))invalid();
  return value;
}
function images(value:unknown):ImageAttachment[]{
  const values=dense(value);
  // Validate malformed attachments before classifying a valid oversized set as a limit.
  if(values.length>IMAGE_COUNT){const parsed=values.map(parseImageAttachment);if(new Set(parsed.map(image=>image.id)).size!==parsed.length)invalid();limit('images');}
  return parseImages(values);
}
function userMessage(content:string,attachments:ImageAttachment[]):MultimodalMessage{
  return {role:'user',content:attachments.length?[{type:'text',text:content},...attachments.map(image=>({type:'image_url' as const,image_url:{url:imageDataUrl(image)}}))]:content};
}
function sha(value:string):string{return createHash('sha256').update(value).digest('hex');}

/** Consume the host's complete, explicitly selected history; never select or evict turns here. */
export function buildUnifiedChatContext(input:UnifiedChatContextInput,options:{nativeHistory?:true}={}):{request:MultimodalRequest;historyVersion:string;historyTurnIds:readonly string[]}{
  const value=exact(input,['provider','model','text','images','files','schematics','history','replyLimits']);
  const provider=value.provider as CloudProviderIdV2,model=text(value.model),option=modelOption(provider,model);
  const reply=exact(value.replyLimits,['maxOutputTokens','timeoutMs']),replyLimits=parseReplyLimits(reply.maxOutputTokens,reply.timeoutMs);
  const currentImages=images(value.images),currentFiles=parseFileContexts(value.files),currentSchematics=parseSchematicContexts(value.schematics);
  if(currentImages.length&&!option.vision)invalid();
  const currentText=text(value.text,true);
  if(!currentText.trim()&&!currentImages.length&&!currentFiles.length&&!currentSchematics.length)invalid();
  const history=dense(value.history);
  const turns=history.map(entry=>{
    const row=exact(entry,['turnId','user','assistant'],['images','files','schematics','clarifications']);
    if(typeof row.turnId!=='string'||!UUID.test(row.turnId))invalid();
    return {turnId:row.turnId,user:text(row.user),assistant:text(row.assistant),images:images(row.images===undefined?[]:row.images),files:parseFileContexts(row.files===undefined?[]:row.files),schematics:parseSchematicContexts(row.schematics===undefined?[]:row.schematics),clarifications:parseChatClarifications(Object.hasOwn(row,'clarifications')?row.clarifications:[])};
  });
  const historyTurnIds=turns.map(turn=>turn.turnId);
  if(new Set(historyTurnIds).size!==historyTurnIds.length)invalid();
  const messages:MultimodalMessage[]=[];
  for(const turn of turns){
    const user=schematicContextPrompt(turn.user,turn.files,turn.schematics,true)+(turn.images.length&&!option.vision&&!options.nativeHistory?OMITTED_HISTORY_IMAGES:'');
    messages.push(userMessage(user,option.vision||options.nativeHistory?turn.images:[]));
    for(const clarification of turn.clarifications){
      // A submitted answer is not proof of delivery to this turn's model.
      if(clarification.delivered&&clarification.answer!==null)messages.push({role:'assistant',content:clarification.prompt},{role:'user',content:clarification.answer});
    }
    messages.push({role:'assistant',content:turn.assistant});
  }
  messages.push(userMessage(schematicContextPrompt(messageTextDefault(currentText,currentFiles,currentSchematics),currentFiles,currentSchematics),currentImages));
  const request=validateUnifiedChatRequest({provider,model,...replyLimits,messages},options);
  // Normalize optional empty collections and property order. Bind even image identities
  // omitted for a text-only model, without retaining a second full base64 history string.
  const version=createHash('sha256').update('aaw.unified-chat-history.v1[');
  turns.forEach((turn,index)=>{
    if(index)version.update(',');
    version.update(JSON.stringify({turnId:turn.turnId,user:turn.user,assistant:turn.assistant,images:turn.images.map(({id,name,data,width,height})=>({id,name,width,height,dataSha256:sha(data)})),files:turn.files,schematics:turn.schematics.map(schematicCanonical),...(turn.clarifications.length?{clarifications:turn.clarifications}:{})}));
  });
  const historyVersion=version.update(']').digest('hex');
  return {request,historyVersion,historyTurnIds:Object.freeze(historyTurnIds)};
}

/** Native history is a migration/reference envelope, not a provider request.
 * Native owns the active context; the gateway still bounds every actual wire request. */
export function validateUnifiedChatRequest(request:MultimodalRequest,options:{nativeHistory?:true}={}):MultimodalRequest{
  const value=exact(request,['provider','model','maxOutputTokens','messages'],['timeoutMs']);
  const option=modelOption(value.provider as CloudProviderIdV2,text(value.model));
  parseReplyLimits(value.maxOutputTokens,Object.hasOwn(value,'timeoutMs')?value.timeoutMs:30000);
  const messages=dense(value.messages);
  if(!messages.length||messages.length%2!==1)invalid();
  let imageCount=0;
  for(const [index,item] of messages.entries()){
    const message=exact(item,['role','content']);
    if(message.role!==(index%2?'assistant':'user'))invalid();
    let content:string;
    if(typeof message.content==='string')content=text(message.content);
    else{
      if(message.role!=='user')invalid();
      if(!option.vision&&(!options.nativeHistory||index===messages.length-1))invalid();
      const parts=dense(message.content);if(parts.length<2)invalid();
      if(options.nativeHistory&&parts.length-1>IMAGE_COUNT)limit('images');
      const first=exact(parts[0],['type','text']);if(first.type!=='text')invalid();content=text(first.text);
      for(const raw of parts.slice(1)){
        const part=exact(raw,['type','image_url']),image=exact(part.image_url,['url']);
        if(part.type!=='image_url'||typeof image.url!=='string'||!image.url.startsWith('data:image/jpeg;base64,'))invalid();
        const data=image.url.slice(23);
        // parseImageAttachment owns canonical base64, byte, JPEG and dimension checks.
        // Bound before decode, as the legacy attachment parser does.
        if(data.length>Math.ceil(IMAGE_BYTES/3)*4)throw new TypeError('Invalid image attachment');
        const dimensions=imageDimensions(Uint8Array.from(atob(data),character=>character.charCodeAt(0)),'jpeg');
        parseImages([{id:'00000000-0000-4000-8000-000000000000',name:'image.jpg',data,...dimensions}]);
        imageCount++;
      }
    }
    const bytes=Buffer.byteLength(content);
    if(bytes>(index%2?MAX_REPLY_BYTES:MAX_USER_BYTES))limit(index%2?'reply_bytes':'user_bytes');
  }
  if(imageCount&&!option.vision&&!options.nativeHistory)invalid();
  if(!options.nativeHistory&&imageCount>IMAGE_COUNT)limit('images');
  const transported=options.nativeHistory?{...request,messages:[request.messages.at(-1)!]}:request;
  if(Buffer.byteLength(multimodalBody(transported))>VISION_REQUEST_BYTES)limit('wire_bytes');
  return request;
}
