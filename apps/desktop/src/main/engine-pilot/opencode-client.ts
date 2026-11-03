import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pilotExact, pilotId, pilotText } from '../../shared/agent/engine-pilot';
import type { PilotEngine, EngineNotice } from './engine';
import { PROJECT_READ_LIMITS } from '../../shared/agent/agent-project-read';
import { WORK_CYCLE_TOOL_NAMES } from '../../shared/agent/agent-work-cycle';
import { OA_READ_TOOL_NAMES } from '../../shared/agent/oa-read';
import { COMMAND_TOOL_NAMES } from '../../shared/agent/agent-command';
import { AGENT_SKILL_TOOL_NAMES } from '../../shared/agent/agent-skills';
import {FILESYSTEM_TOOL_NAMES} from '../../shared/agent/agent-filesystem-read';
import { parseProjectReadModel, type ProjectReadModel } from '../../shared/agent/agent-project-model';
import {parseNativeEngineFailure,type NativeEngineFailure,type NativeEngineFailureStage,type NativeEngineFailureReason} from '../../shared/agent/native-engine-failure';

export const OPENCODE_PILOT_VERSION = '1.18.17';
export const OPENCODE_PILOT_COMMIT = '02546dfc2e4515a4f90aaf9ceb3890df2ac2b479';
export const createPilotSecret = ():string => randomBytes(32).toString('hex');
export class OpenCodePilotError extends Error {
  readonly nativeFailure?:NativeEngineFailure;
  constructor(nativeFailure?:NativeEngineFailure){super('OpenCode pilot unavailable');const parsed=parseNativeEngineFailure(nativeFailure);if(parsed)this.nativeFailure=parsed;}
}
export function nativeFailureOf(error:unknown,fallback:NativeEngineFailure):NativeEngineFailure {
  // Never inspect arbitrary error text, causes, response bodies or inherited getters.
  let value:unknown;try{value=error instanceof OpenCodePilotError?Object.getOwnPropertyDescriptor(error,'nativeFailure')?.value:undefined;}catch{}
  return parseNativeEngineFailure(value)??parseNativeEngineFailure(fallback)??Object.freeze({origin:'native_adapter',stage:'engine_start',reason:'unknown'});
}
const clientError=(stage:NativeEngineFailureStage,reason:NativeEngineFailureReason)=>new OpenCodePilotError({origin:'native_client',stage,reason});
export type NativeTextSnapshot=Readonly<{messageId:string;partId:string;text:string}>;
type FetchLike=(url:string,init:RequestInit)=>Promise<Response>;
export const LIVE_NATIVE_IDENTITY = Object.freeze({agent:'pilot',providerID:'workbench',modelID:'deepseek-v4-flash'} as const);
export const liveNativeUserText=(goal:string,constraint:string):string=>`Task:\n${pilotText(goal,4096)}\n\nConstraints:\n${pilotText(constraint,4096,false)}`;
/** Narrow native V1 client. No arbitrary method/path/header or renderer-supplied URL. */
export function createOpenCodePilotClient(options:Readonly<{port:number;password:string;directory:string;fetchImpl?:FetchLike;profile?:'live-deepseek'|'project-read'|'work-cycle';conversation?:boolean}>) {
  if(options.conversation!==undefined&&typeof options.conversation!=='boolean'||options.conversation===true&&options.profile!=='work-cycle')throw new OpenCodePilotError();
  const responseBytes=options.conversation===true?4*1024*1024:1048576;
  if(!Number.isSafeInteger(options.port)||options.port<1024||options.port>65535||!/^[0-9a-f]{64}$/u.test(options.password))throw new OpenCodePilotError();
  const directory=path.resolve(options.directory),parent=path.resolve('C:/work/analog_ai_workbench/.local/agent-engine-pilot');
  if(!directory.startsWith(parent+path.sep))throw new OpenCodePilotError();
  const origin=`http://127.0.0.1:${options.port}`,nativeSessions=new Set<string>();let closed=false,acceptedSessions=0;
  const controllers=new Set<AbortController>();
  async function request(stage:NativeEngineFailureStage,route:string,method:'GET'|'POST',body:unknown,status=200,onHeaders?:(headers:Headers)=>void):Promise<unknown> {
    if(closed)throw clientError(stage,'unexpected_state');const text=body===undefined?undefined:JSON.stringify(body);if(text!==undefined&&Buffer.byteLength(text)>(options.conversation?1024*1024:options.profile==='project-read'||options.profile==='work-cycle'?PROJECT_READ_LIMITS.contextBytes:65536))throw clientError(stage,'invalid_payload');
    const controller=new AbortController();controllers.add(controller);let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(clientError(stage,'timeout'));},10000);});
    let reason:NativeEngineFailureReason='transport';
    const operation=(async()=>{
      const response=await (options.fetchImpl??fetch)(origin+route,{method,redirect:'error',signal:controller.signal,headers:{Authorization:`Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`,'x-opencode-directory':directory,Accept:'application/json',...(text===undefined?{}:{'Content-Type':'application/json'})},...(text===undefined?{}:{body:text})});
      if(closed||controller.signal.aborted||response.redirected||(response.url&&response.url!==origin+route)||response.status!==status){void response.body?.cancel().catch(()=>{});throw clientError(stage,closed||controller.signal.aborted?'unexpected_state':response.status!==status?'http_status':'response_identity');}
      if(status===204){void response.body?.cancel().catch(()=>{});return null;}
      reason='response_format';
      onHeaders?.(response.headers);
      if(response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json'||!response.body){void response.body?.cancel().catch(()=>{});throw clientError(stage,'response_format');}
      const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,output='';
      try{for(;;){reason='transport';const chunk=await reader.read();if(closed||controller.signal.aborted)throw clientError(stage,'unexpected_state');if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>responseBytes)throw clientError(stage,'response_size');reason='response_format';output+=decoder.decode(chunk.value,{stream:true});}reason='response_format';output+=decoder.decode();return JSON.parse(output);}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
    })();
    try{return await Promise.race([operation,timeout]);}catch(error){throw new OpenCodePilotError(nativeFailureOf(error,{origin:'native_client',stage,reason}));}finally{if(timer)clearTimeout(timer);controller.abort();controllers.delete(controller);}
  }
  const session=(value:string)=>{const id=pilotId(value,'native');if(!nativeSessions.has(id))throw new OpenCodePilotError();return id;};
  const images=(urls:readonly string[]=[])=>{if(!options.conversation&&urls.length||urls.length>2||urls.some(url=>typeof url!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/u.test(url)))throw new OpenCodePilotError();return urls.map(url=>({type:'file',mime:'image/jpeg',url}));};
  return Object.freeze({
    async health():Promise<boolean>{const value=pilotExact(await request('health','/global/health','GET',undefined),['healthy','version']);return value.healthy===true&&value.version===OPENCODE_PILOT_VERSION;},
    async createSession():Promise<string> {
      if(closed||!options.conversation&&acceptedSessions>=32)throw new OpenCodePilotError();acceptedSessions++;
      const allowed=options.profile==='project-read'||options.profile==='work-cycle'?['pilot_sum','question','project_list','project_find','project_search','project_read','wsl_results_list','wsl_results_read','wsl_waveform_list','wsl_waveform_read','wsl_waveform_metrics',...OA_READ_TOOL_NAMES,...AGENT_SKILL_TOOL_NAMES,...FILESYSTEM_TOOL_NAMES,...(options.profile==='work-cycle'?[...WORK_CYCLE_TOOL_NAMES,...COMMAND_TOOL_NAMES]:[])]:['pilot_sum','question'];
      const value=await request('session_create','/session','POST',{title:'Workbench isolated engine pilot',permission:[{permission:'*',pattern:'*',action:'deny'},...allowed.map(permission=>({permission,pattern:'*',action:'allow'}))]});
      if(!value||typeof value!=='object'||Array.isArray(value))throw clientError('session_create','response_format');
      const id=pilotId((value as Record<string,unknown>).id,'native');if(!options.conversation&&nativeSessions.size>=32||nativeSessions.has(id))throw new OpenCodePilotError();nativeSessions.add(id);return id;
    },
    /** Existing bindings are read back explicitly. A missing session is never replaced. */
    async openSession(sessionId:string):Promise<string>{
      if(!options.conversation)throw new OpenCodePilotError();const id=pilotId(sessionId,'native'),value=await request('session_open',`/session/${encodeURIComponent(id)}`,'GET',undefined);
      if(!value||typeof value!=='object'||Array.isArray(value)||(value as Record<string,unknown>).id!==id||typeof (value as Record<string,unknown>).directory!=='string'||path.resolve(String((value as Record<string,unknown>).directory)).toLowerCase()!==directory.toLowerCase())throw clientError('session_open','response_identity');
      nativeSessions.add(id);return id;
    },
    /** Official noReply import: reference text only, without a model call or tool execution. */
    async seed(sessionId:string,text:string,model:ProjectReadModel,imageUrls:readonly string[]=[]):Promise<void>{
      if(!options.conversation||!parseProjectReadModel(model))throw new OpenCodePilotError();const id=session(sessionId),content=pilotText(text,131072);
      const files=images(imageUrls),value=await request('history_seed',`/session/${encodeURIComponent(id)}/message`,'POST',{agent:'pilot',model:{providerID:'workbench',modelID:model.model},noReply:true,parts:[{type:'text',text:content},...files]});
      if(!value||typeof value!=='object'||Array.isArray(value))throw clientError('history_seed','response_format');const row=value as Record<string,unknown>,info=row.info as Record<string,unknown>|undefined;
      if(!info||info.sessionID!==id||info.role!=='user'||!Array.isArray(row.parts)||row.parts.length!==1+files.length||(row.parts[0] as Record<string,unknown>).type!=='text'||(row.parts[0] as Record<string,unknown>).text!==content||files.some((file,index)=>{const saved=(row.parts as Record<string,unknown>[])[index+1];return saved?.type!=='file'||saved.mime!==file.mime||saved.url!==file.url;}))throw clientError('history_seed','response_identity');
    },
    async prompt(sessionId:string,input:Readonly<{rules:string;goal:string;constraint:string;initialUserText?:string;model?:ProjectReadModel;imageUrls?:readonly string[]}>):Promise<void> {
      const id=session(sessionId);pilotExact(input,['rules','goal','constraint',...(Object.hasOwn(input,'initialUserText')?['initialUserText']:[]),...(Object.hasOwn(input,'model')?['model']:[]),...(Object.hasOwn(input,'imageUrls')?['imageUrls']:[])]);
      const projectModel=input.model===undefined?null:parseProjectReadModel(input.model);
      if(input.model!==undefined&&(!projectModel||options.profile!=='project-read'&&options.profile!=='work-cycle'))throw new OpenCodePilotError();
      if(input.initialUserText!==undefined&&options.profile!=='project-read'&&options.profile!=='work-cycle')throw new OpenCodePilotError();
      const userText=input.initialUserText===undefined?(options.profile?liveNativeUserText(input.goal,input.constraint):JSON.stringify({goal:pilotText(input.goal,4096),constraint:pilotText(input.constraint,4096,false)})):pilotText(input.initialUserText,PROJECT_READ_LIMITS.contextBytes);
      await request('prompt_submit',`/session/${encodeURIComponent(id)}/prompt_async`,'POST',{agent:'pilot',model:options.profile?{providerID:LIVE_NATIVE_IDENTITY.providerID,modelID:projectModel?.model??LIVE_NATIVE_IDENTITY.modelID}:{providerID:'pilot',modelID:'mock'},system:pilotText(input.rules,16384),parts:[{type:'text',text:userText},...images(input.imageUrls)]},204);
    },
    async messages(sessionId:string):Promise<unknown>{
      const id=session(sessionId);if(!options.conversation)return request('message_read',`/session/${encodeURIComponent(id)}/message`,'GET',undefined);
      const rows:unknown[]=[],seen=new Set<string>();let cursor:string|undefined;
      // Bound individual responses, not the total age or size of a conversation.
      do {let next:string|undefined;const page=await request('message_read',`/session/${encodeURIComponent(id)}/message?limit=8${cursor?'&before='+encodeURIComponent(cursor):''}`,'GET',undefined,200,headers=>{next=headers.get('x-next-cursor')??undefined;});
        if(!Array.isArray(page)||page.length>8)throw clientError('message_read','response_format');rows.unshift(...page);
        if(next&&(!/^[A-Za-z0-9_=-]{1,2048}$/u.test(next)||seen.has(next)||!page.length))throw clientError('message_read','invalid_payload');if(next)seen.add(next);cursor=next;
      }while(cursor);return rows;
    },
    /** Completion belongs to the native loop, including any automatic compaction. */
    async isIdle(sessionId:string):Promise<boolean>{
      if(!options.conversation)throw new OpenCodePilotError();const id=session(sessionId),value=await request('status_read','/session/status','GET',undefined);
      if(!value||typeof value!=='object'||Array.isArray(value))throw clientError('status_read','response_format');
      const status=(value as Record<string,unknown>)[id];if(status===undefined)return true;
      if(!status||typeof status!=='object'||Array.isArray(status))throw clientError('status_read','response_format');
      const type=(status as Record<string,unknown>).type;if(!['idle','busy','retry'].includes(String(type)))throw clientError('status_read','unexpected_state');return type==='idle';
    },
    /** Observe native failures and optional assistant text on one official event stream.
     * Wait for its handshake before prompting; arbitrary errors/reasoning stay private. */
    async watchSessionErrors(sessionId:string,onError:(error?:unknown)=>void,signal:AbortSignal,textObserver?:Readonly<{model:ProjectReadModel;onText:(value:NativeTextSnapshot)=>void}>):Promise<{close():Promise<void>}>{
      if(textObserver&&(!parseProjectReadModel(textObserver.model)||typeof textObserver.onText!=='function'))throw new OpenCodePilotError();
      if(!options.conversation||closed||signal.aborted)throw new OpenCodePilotError();const id=session(sessionId),controller=new AbortController();controllers.add(controller);
      let stopped=false,connected=false,reported=false,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
      let failureStage:NativeEngineFailureStage='event_connect',failureReason:NativeEngineFailureReason='transport';
      const messages=new Map<string,boolean>(),parts=new Map<string,{messageId:string;text:string;eligible:boolean;ended:boolean}>();
      const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new OpenCodePilotError();return value as Record<string,unknown>;};
      const publish=(partId:string,part:{messageId:string;text:string;eligible:boolean})=>{if(!reported&&!stopped&&!closed&&!signal.aborted&&part.eligible&&part.text)textObserver!.onText(Object.freeze({messageId:part.messageId,partId,text:part.text}));};
      const textEvent=(type:string,value:unknown):void=>{
        if(!textObserver||reported||stopped||closed||signal.aborted)return;
        failureStage=type==='message.updated'?'event_message':'event_text';failureReason='invalid_payload';
        const properties=record(value);if(properties.sessionID!==id)return;if(!connected)throw clientError(failureStage,'unexpected_state');
        if(type==='message.updated'){
          const info=record(properties.info);if(info.sessionID!==id)throw clientError(failureStage,'invalid_identity');const messageId=pilotId(info.id,'native');
          if(info.summary!==undefined&&typeof info.summary!=='boolean')throw new OpenCodePilotError();
          const eligible=info.role==='assistant'&&info.summary!==true;
          if(eligible&&(info.agent!=='pilot'||info.providerID!=='workbench'||info.modelID!==textObserver.model.model))throw clientError(failureStage,'invalid_identity');
          if(eligible)pilotId(info.parentID,'native');
          if(messages.has(messageId)&&messages.get(messageId)!==eligible)throw clientError(failureStage,'invalid_identity');messages.set(messageId,eligible);return;
        }
        if(type==='message.part.updated'){
          const part=record(properties.part);if(part.sessionID!==id)throw clientError(failureStage,'invalid_identity');
          const messageId=pilotId(part.messageID,'native'),partId=pilotId(part.id,'native');if(!messages.has(messageId))throw clientError(failureStage,'invalid_identity');
          if(part.ignored!==undefined&&typeof part.ignored!=='boolean'||part.synthetic!==undefined&&typeof part.synthetic!=='boolean')throw new OpenCodePilotError();
          const eligible=messages.get(messageId)===true&&part.type==='text'&&part.ignored!==true&&part.synthetic!==true;
          const old=parts.get(partId);if(old&&(old.messageId!==messageId||old.eligible!==eligible))throw clientError(failureStage,'invalid_identity');
          if(!eligible){parts.set(partId,{messageId,text:'',eligible:false,ended:false});return;}
          const text=pilotText(part.text,responseBytes,false),time=record(part.time),ended=time.end!==undefined;
          if(typeof time.start!=='number'||!Number.isFinite(time.start)||ended&&(typeof time.end!=='number'||!Number.isFinite(time.end)))throw new OpenCodePilotError();
          if(old&&!text.startsWith(old.text))throw clientError(failureStage,'text_regression');
          if(old?.ended&&(!ended||text!==old.text))throw clientError(failureStage,'text_after_end');
          const next={messageId,text,eligible,ended};parts.set(partId,next);if(!old||old.text!==text)publish(partId,next);return;
        }
        const row=pilotExact(properties,['sessionID','messageID','partID','field','delta']),messageId=pilotId(row.messageID,'native'),partId=pilotId(row.partID,'native'),part=parts.get(partId);
        if(!part||part.messageId!==messageId||typeof row.field!=='string')throw clientError(failureStage,'invalid_identity');if(!part.eligible||row.field!=='text')return;
        if(part.ended)throw clientError(failureStage,'text_after_end');const delta=pilotText(row.delta,responseBytes,false);if(!delta)return;
        part.text=pilotText(part.text+delta,responseBytes,false);publish(partId,part);
      };
      let readyResolve!:()=>void,readyReject!:(error:Error)=>void;
      const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>{});
      const abort=()=>{controller.abort();readyReject(new OpenCodePilotError());void reader?.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
      const failure=(error:unknown)=>{if(reported||stopped||closed||signal.aborted)return;reported=true;readyReject(new OpenCodePilotError(nativeFailureOf(error,{origin:'native_client',stage:failureStage,reason:failureReason})));controller.abort();if(connected)onError(error);};
      let finished:Promise<void>=Promise.resolve();
      try{
        const response=await (options.fetchImpl??fetch)(origin+'/event',{method:'GET',redirect:'error',signal:controller.signal,headers:{Authorization:`Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`,'x-opencode-directory':directory,Accept:'text/event-stream'}});
        failureReason='response_format';
        if(closed||signal.aborted||response.redirected||(response.url&&response.url!==origin+'/event')||response.status!==200||response.headers.get('content-type')?.split(';')[0]?.trim()!=='text/event-stream'||!response.body){void response.body?.cancel().catch(()=>{});throw clientError('event_connect',closed||signal.aborted?'unexpected_state':response.status!==200?'http_status':response.redirected||(response.url&&response.url!==origin+'/event')?'response_identity':'response_format');}
        reader=response.body.getReader();
        finished=(async()=>{
          const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',data:string[]=[],dataBytes=0;
          const event=()=>{if(!data.length)return;failureStage='event_decode';failureReason='response_format';const value=JSON.parse(data.join('\n'));data=[];dataBytes=0;if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.type!=='string')throw new OpenCodePilotError();
            if(value.type==='server.connected'){if(connected)throw clientError('event_connect','unexpected_state');connected=true;readyResolve();}
            else if(value.type==='message.updated'||value.type==='message.part.updated'||value.type==='message.part.delta')textEvent(value.type,value.properties);
            else if(value.type==='session.error'){const properties=value.properties;if(!properties||typeof properties!=='object'||Array.isArray(properties))throw new OpenCodePilotError();if(properties.sessionID===id){
                // Preserve only the gateway's exact terminal classification, not
                // arbitrary native messages, paths, provider text or credentials.
                const error=properties.error,data=error?.data,body=data?.responseBody;
                const known=error?.name==='APIError'&&((data?.statusCode===504&&body==='{"error":{"message":"Upstream request timed out"}}')||(data?.statusCode===503&&body==='{"error":{"message":"Upstream temporarily unavailable"}}'));
                failure(known?{name:'APIError',data:{statusCode:data.statusCode,responseBody:body}}:clientError('event_message','native_session_error'));
              }}
            else if(value.type==='server.instance.disposed')failure(clientError('event_connect','native_disposed'));
          };
          try{for(;;){failureStage='event_connect';failureReason='transport';const chunk=await reader!.read();if(chunk.done)break;if(stopped||closed||signal.aborted)break;failureStage='event_decode';failureReason='response_format';pending+=decoder.decode(chunk.value,{stream:true});
              let end:number;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end).replace(/\r$/u,'');pending=pending.slice(end+1);
                if(!line)event();else if(line.startsWith('data:')){const text=line.slice(5).replace(/^ /u,'');dataBytes+=Buffer.byteLength(text);if(dataBytes>responseBytes)throw clientError('event_decode','response_size');data.push(text);}}
              if(Buffer.byteLength(pending)>responseBytes)throw clientError('event_decode','response_size');
            }
            if(!stopped&&!closed&&!signal.aborted)failure(clientError('event_connect','stream_closed'));
          }catch(error){failure(new OpenCodePilotError(nativeFailureOf(error,{origin:'native_client',stage:failureStage,reason:failureReason})));}
          finally{readyReject(new OpenCodePilotError());signal.removeEventListener('abort',abort);controllers.delete(controller);void reader!.cancel().catch(()=>{});reader!.releaseLock();}
        })();
        await ready;return {async close(){stopped=true;controller.abort();await reader?.cancel().catch(()=>{});await finished;}};
      }catch(error){stopped=true;controller.abort();signal.removeEventListener('abort',abort);controllers.delete(controller);await finished;throw new OpenCodePilotError(nativeFailureOf(error,{origin:'native_client',stage:failureStage,reason:failureReason}));}
    },
    async questions(sessionId:string):Promise<unknown>{session(sessionId);return request('question_read','/question','GET',undefined);},
    async answer(sessionId:string,questionId:string,answer:string):Promise<void>{session(sessionId);if(await request('question_answer',`/question/${encodeURIComponent(pilotId(questionId,'native'))}/reply`,'POST',{answers:[[pilotText(answer,4096)]]})!==true)throw clientError('question_answer','response_format');},
    /** Main-only cleanup. The engine must already own the complete verified question tuple. */
    async reject(sessionId:string,questionId:string):Promise<void>{session(sessionId);if(await request('question_reject',`/question/${encodeURIComponent(pilotId(questionId,'native'))}/reject`,'POST',undefined)!==true)throw clientError('question_reject','response_format');},
    async abort(sessionId:string):Promise<void>{if(await request('session_abort',`/session/${encodeURIComponent(session(sessionId))}/abort`,'POST',{})!==true)throw clientError('session_abort','response_format');},
    dispose(){closed=true;for(const controller of controllers)controller.abort();controllers.clear();nativeSessions.clear();},
  });
}
/** Known native question subset only; multiple native questions/options cannot be silently discarded. */
export function mapOpenCodeQuestion(value:unknown,sessionId:string):EngineNotice {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new OpenCodePilotError();const envelope=value as Record<string,unknown>;
  if(envelope.type!=='question.asked'||!envelope.properties||typeof envelope.properties!=='object')throw new OpenCodePilotError();
  const data=envelope.properties as Record<string,unknown>;
  if(data.sessionID!==sessionId||!Array.isArray(data.questions)||data.questions.length!==1)throw new OpenCodePilotError();
  const question=data.questions[0];if(!question||typeof question!=='object'||question.multiple===true||question.custom===false||!Array.isArray(question.options)||question.options.length!==0)throw new OpenCodePilotError();
  return {type:'question',questionId:pilotId(data.id,'native'),prompt:pilotText(question.question,4096)};
}
/** Do not turn static native-route coverage into an unverified execution capability. */
export function createUnreadyOpenCodePilotEngine():PilotEngine {
  return {kind:'opencode',version:OPENCODE_PILOT_VERSION,health:async()=>false,start:async()=>{throw new OpenCodePilotError();},answer:async()=>{throw new OpenCodePilotError();},stop:async()=>{},dispose(){}};
}
