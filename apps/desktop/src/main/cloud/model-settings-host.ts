import {createAtomicJsonStore} from './session-store';import {sessionExact} from '../../shared/agent/chat-sessions';
import {DEFAULT_REPLY_LIMITS,DEFAULT_CHAT_REPLY_LIMITS,resolveChatTurnLimits,parseTurnTimeoutMs,type ChatReplyLimits} from '../../shared/agent/reply-limits';
import {defaultModel,modelOption,serviceAddress} from '../../shared/agent/model-options';import {parseSettingsSave,parseSettingsResult,type SettingsResult,type SettingsView} from '../../shared/agent/model-settings';import type {CloudProviderIdV2} from '../../shared/agent/cloud-chat-api';
type ProviderConfig={model:string;source:'file'|'encrypted'|'disabled';ciphertext:string;maxOutputTokens?:number;timeoutMs?:number;requestTimeoutMs?:number;turnTimeoutMs?:number|null};
type Config={version:1|2|3|4;deepseek:ProviderConfig;kimi:ProviderConfig};
export type KeyEncryption={available:()=>boolean;encrypt:(text:string)=>string;decrypt:(ciphertext:string)=>string};
function parse(value:unknown):Config{
  const v=sessionExact(value,['version','deepseek','kimi']);if(v.version!==1&&v.version!==2&&v.version!==3&&v.version!==4)throw Error('Invalid settings');
 const config={version:v.version===4?4:v.version===3?3:2} as Config;
 for(const provider of ['deepseek','kimi'] as const){
  const raw=v[provider],hasRequest=typeof raw==='object'&&raw!==null&&Object.hasOwn(raw,'requestTimeoutMs'),hasTurn=typeof raw==='object'&&raw!==null&&Object.hasOwn(raw,'turnTimeoutMs');
  const item=sessionExact(raw,['model','source','ciphertext',...(v.version!==1?['maxOutputTokens','timeoutMs']:[]),...((v.version===3||v.version===4)&&hasRequest?['requestTimeoutMs']:[]),...(v.version===4&&hasTurn?['turnTimeoutMs']:[])]);
  if(typeof item.model!=='string'||!['file','encrypted','disabled'].includes(item.source as string)||typeof item.ciphertext!=='string'||item.ciphertext.length>8192||(item.source==='encrypted'?!/^[A-Za-z0-9+/]+={0,2}$/u.test(item.ciphertext):item.ciphertext!==''))throw Error('Invalid settings');
  modelOption(provider,item.model);
  const limits=v.version===1?DEFAULT_REPLY_LIMITS:{maxOutputTokens:item.maxOutputTokens,timeoutMs:item.timeoutMs,...(hasRequest?{requestTimeoutMs:item.requestTimeoutMs}:{}),...(hasTurn?{turnTimeoutMs:item.turnTimeoutMs}:{})};
  if(hasRequest&&typeof item.requestTimeoutMs!=='number'||hasTurn&&(!hasRequest||item.timeoutMs!==item.requestTimeoutMs))throw Error('Invalid settings');
  parseTurnTimeoutMs(limits.timeoutMs);resolveChatTurnLimits(limits as ChatReplyLimits);config[provider]={...item,...limits} as ProviderConfig;
 }return config;
}
export function createModelSettings(options:{root:string;directory:string;legacyKeys:Partial<Record<CloudProviderIdV2,string>>;encryption:KeyEncryption;store?:{load:()=>Config;save:(value:Config)=>void}}){
 const empty=():Config=>({version:4,deepseek:{model:defaultModel('deepseek'),source:'file',ciphertext:'',...DEFAULT_CHAT_REPLY_LIMITS},kimi:{model:defaultModel('kimi'),source:'file',ciphertext:'',...DEFAULT_CHAT_REPLY_LIMITS}});
 const store=options.store??createAtomicJsonStore(options.root,options.directory,'model-settings.json',parse,32768,empty);let config=empty(),failed=false;let decrypted:Partial<Record<CloudProviderIdV2,string>>={};
 const validKey=(key:string)=>/^sk-[A-Za-z0-9_-]{8,512}$/u.test(key);
 try{config=parse(store.load());for(const provider of ['deepseek','kimi'] as const)if(config[provider].source==='encrypted'){
  if(!options.encryption.available())throw Error();const key=options.encryption.decrypt(config[provider].ciphertext);if(!validKey(key))throw Error();decrypted[provider]=key;
 }}catch{failed=true;decrypted={};}
 const key=(provider:CloudProviderIdV2)=>failed?undefined:config[provider].source==='encrypted'?decrypted[provider]:config[provider].source==='file'?options.legacyKeys[provider]:undefined;
 const replyLimits=(provider:CloudProviderIdV2):Required<ChatReplyLimits>=>{
  const p=config[provider],resolved=resolveChatTurnLimits({maxOutputTokens:p.maxOutputTokens??DEFAULT_REPLY_LIMITS.maxOutputTokens,timeoutMs:p.timeoutMs??DEFAULT_REPLY_LIMITS.timeoutMs,...(p.requestTimeoutMs!==undefined?{requestTimeoutMs:p.requestTimeoutMs}:{}),...(Object.hasOwn(p,'turnTimeoutMs')?{turnTimeoutMs:p.turnTimeoutMs}:{})});
  return {maxOutputTokens:resolved.maxOutputTokens,timeoutMs:resolved.requestTimeoutMs,requestTimeoutMs:resolved.requestTimeoutMs,turnTimeoutMs:resolved.turnTimeoutMs};
 };
 const view=():SettingsView=>({storage:failed?'error':'ready',encryptionAvailable:options.encryption.available(),providers:(['deepseek','kimi'] as const).map(provider=>({provider,address:serviceAddress(provider),model:config[provider].model,configured:!!key(provider),source:config[provider].source==='file'&&!key(provider)?'none':config[provider].source,...replyLimits(provider)}))});
 return {
  key,replyLimits,defaultModel:(provider:CloudProviderIdV2)=>config[provider].model,read:():SettingsResult=>parseSettingsResult({ok:true,value:view()}),configured:()=>({deepseek:!!key('deepseek'),kimi:!!key('kimi')}),
  save(value:unknown):SettingsResult{
   let request;try{request=parseSettingsSave(value);}catch{return {ok:false,error:{code:'INVALID_REQUEST'}};}if(failed)return {ok:false,error:{code:'STORAGE_ERROR'}};
   const previous=config[request.provider],current=replyLimits(request.provider);
   const requested=request.maxOutputTokens!==undefined?resolveChatTurnLimits({maxOutputTokens:request.maxOutputTokens,timeoutMs:request.timeoutMs!,...(request.requestTimeoutMs!==undefined?{requestTimeoutMs:request.requestTimeoutMs}:{}),turnTimeoutMs:Object.hasOwn(request,'turnTimeoutMs')?(request.turnTimeoutMs??null):current.turnTimeoutMs}):resolveChatTurnLimits(current);
   const next={...previous,model:request.model,maxOutputTokens:requested.maxOutputTokens,timeoutMs:requested.requestTimeoutMs,requestTimeoutMs:requested.requestTimeoutMs,turnTimeoutMs:requested.turnTimeoutMs};let plaintext=decrypted[request.provider];
   if(request.keyAction==='replace'){
    if(!options.encryption.available())return {ok:false,error:{code:'ENCRYPTION_UNAVAILABLE'}};
    try{next.ciphertext=options.encryption.encrypt(request.apiKey);next.source='encrypted';plaintext=request.apiKey;}catch{return {ok:false,error:{code:'ENCRYPTION_UNAVAILABLE'}};}
   }else if(request.keyAction==='disable'||request.keyAction==='file'){next.source=request.keyAction==='disable'?'disabled':'file';next.ciphertext='';plaintext=undefined;}
   try{const candidate=parse({...config,version:4,[request.provider]:next});store.save(candidate);config=candidate;if(plaintext===undefined)delete decrypted[request.provider];else decrypted[request.provider]=plaintext;return {ok:true,value:view()};}catch{return {ok:false,error:{code:'STORAGE_ERROR'}};}
  },
  dispose(){decrypted={};failed=true;},
 };
}
export type ModelSettingsHost=ReturnType<typeof createModelSettings>;
