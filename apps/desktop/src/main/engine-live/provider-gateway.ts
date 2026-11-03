import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { parseSumArguments, parseSumValue, pilotExact, pilotId, pilotText, type SumArguments, type SumValue, type PilotUsage } from '../../shared/agent/engine-pilot';
import { createPilotSecret } from '../engine-pilot/opencode-client';
import { LIVE_ENDPOINT, LIVE_LIMITS, LIVE_MODEL, LIVE_RULES, liveCanonicalSse, liveKeys, liveObject, liveQuestionResult, liveReject, liveTools, liveUserText, parseLiveQuestionArguments, parseLiveSse, validateNativeTools, type LiveCall, type LiveCompletion } from './protocol';

export type LiveNativeTool = Readonly<{sessionID:string;messageID:string;callID:string;toolName:'pilot_sum';arguments:SumArguments}>;
export type LiveBegin = Readonly<{runId:string;goal:string;constraint:string;onTool:(call:LiveNativeTool)=>Promise<SumValue>;onFailure:()=>void}>;
export type LiveQuestionBinding = Readonly<{questionID:string;messageID:string;callID:string;prompt:string;arguments:unknown}>;
export type LiveProviderOptions = Readonly<{
  fetchImpl:(url:string,init:RequestInit)=>Promise<Response>;
  getRunCredentials:(runId:string)=>{apiKey:string;maxRequests:number;maxOutputTokens:number;requestTimeoutMs:number};
  onResponse:(runId:string,value:{request:number;responseModel:string|null;usage:PilotUsage})=>void;
  onTraffic?:(value:unknown)=>void;
  /** Main-only lower timing ceilings for isolated transports; never supplied by IPC. */
  timeouts?:Readonly<{firstByteTimeoutMs:number;idleTimeoutMs:number}>;
}>;
type Row=Record<string,unknown>;
type CallState={call:LiveCall;messageID?:string;questionID?:string;answer?:string;answerDelivery?:Promise<void>;answerDelivered?:true;result?:SumValue;promise?:Promise<SumValue>};
type TrafficReason='admitted'|'unbound'|'route'|'budget'|'protocol'|'dispatch'|'response'|'answer_pending'|'cancelled'|'request_timeout'|'first_byte_timeout'|'idle_timeout'|'tool';
type TrafficEntry=Readonly<{kind:'provider'|'http'|'tool';runId:string|null;attempt:number;reason:TrafficReason}>;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const textContent=(value:unknown):string=>{if(value===undefined||value===null)return '';if(typeof value==='string')return pilotText(value,LIVE_LIMITS.contextBytes,false);if(!Array.isArray(value)||value.some(v=>{const row=liveObject(v);return row.type!=='text'||typeof row.text!=='string'||Object.keys(row).some(k=>k!=='type'&&k!=='text');}))return liveReject();return pilotText(value.map(v=>liveObject(v).text).join(''),LIVE_LIMITS.contextBytes,false);};
const secret=(actual:string|undefined,expected:string)=>{if(typeof actual!=='string')return false;const received=Buffer.from(actual),wanted=Buffer.from(expected);return received.byteLength===wanted.byteLength&&timingSafeEqual(received,wanted);};
const reply=(response:ServerResponse,status:number)=>{if(response.destroyed)return;response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close'});response.end('{"error":"LIVE_UNAVAILABLE"}');};
async function readBody(request:IncomingMessage):Promise<unknown>{const chunks:Buffer[]=[];let size=0;for await(const chunk of request){const data=Buffer.from(chunk);size+=data.length;if(size>LIVE_LIMITS.contextBytes)return liveReject();chunks.push(data);}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return liveReject();}}
function credentials(value:ReturnType<LiveProviderOptions['getRunCredentials']>){
  const v=pilotExact(value,['apiKey','maxRequests','maxOutputTokens','requestTimeoutMs']);const apiKey=pilotText(v.apiKey,8192);if(/[\r\n\u0000]/u.test(apiKey))return liveReject();
  for(const [key,max] of [['maxRequests',LIVE_LIMITS.requests],['maxOutputTokens',LIVE_LIMITS.outputTokens],['requestTimeoutMs',LIVE_LIMITS.requestTimeoutMs]] as const){if(!Number.isSafeInteger(v[key])||(v[key] as number)<1||(v[key] as number)>max)return liveReject();}
  return Object.freeze({apiKey,maxRequests:v.maxRequests as number,maxOutputTokens:v.maxOutputTokens as number,requestTimeoutMs:v.requestTimeoutMs as number});
}

/** Transport admission only: OpenCode, not this service, chooses and schedules model calls. */
export async function createLiveProviderServices(options:LiveProviderOptions) {
  if(typeof options.fetchImpl!=='function'||typeof options.getRunCredentials!=='function'||typeof options.onResponse!=='function')return liveReject();
  const timing=options.timeouts===undefined?{firstByteTimeoutMs:LIVE_LIMITS.firstByteTimeoutMs,idleTimeoutMs:LIVE_LIMITS.idleTimeoutMs}:pilotExact(options.timeouts,['firstByteTimeoutMs','idleTimeoutMs']);
  for(const key of ['firstByteTimeoutMs','idleTimeoutMs'] as const)if(!Number.isSafeInteger(timing[key])||(timing[key] as number)<1||(timing[key] as number)>LIVE_LIMITS[key])return liveReject();
  const firstByteTimeoutMs=timing.firstByteTimeoutMs as number,idleTimeoutMs=timing.idleTimeoutMs as number;
  const providerToken=createPilotSecret(),toolToken=createPilotSecret(),sockets=new Set<Socket>(),receipts=new Map<string,ReturnType<Run['evidence']>>();
  let closed=false,poisoned=false,totalProviderAttempts=0,unboundProviderAttempts=0,totalHttpRequests=0,totalToolAttempts=0,active:Run|undefined,closePromise:Promise<void>|undefined;
  const entries:TrafficEntry[]=[];let droppedTrafficEntries=0;
  const traffic=()=>Object.freeze({totalProviderAttempts,unboundProviderAttempts,totalHttpRequests,totalToolAttempts,poisoned,droppedTrafficEntries,entries:Object.freeze([...entries])});
  function record(kind:TrafficEntry['kind'],runId:string|null,attempt:number,reason:TrafficReason){const entry=Object.freeze({kind,runId,attempt,reason});if(entries.length<512)entries.push(entry);else droppedTrafficEntries++;try{options.onTraffic?.(entry);}catch{/* Observers cannot grant or widen admission. */}}
  class Run {
    readonly input:LiveBegin;readonly config:ReturnType<typeof credentials>;readonly userText:string;sessionID:string|undefined;
    attempts=0;httpRequests=0;toolAttempts=0;questionCount=0;failed=false;ended=false;complete=false;busy=false;
    readonly responses:LiveCompletion[]=[];readonly calls=new Map<string,CallState>();readonly controllers=new Set<AbortController>();
    constructor(input:LiveBegin){this.input={...input,runId:pilotId(input.runId,'run'),goal:pilotText(input.goal,4096),constraint:pilotText(input.constraint,4096,false)};this.userText=liveUserText(input.goal,input.constraint);this.config=credentials(options.getRunCredentials(this.input.runId));}
    alive(){if(closed||this.failed||this.ended||active!==this)return liveReject();}
    fail(reason:TrafficReason='protocol'):never {if(!this.failed&&!this.ended){this.failed=true;this.complete=false;for(const controller of this.controllers)controller.abort();record('provider',this.input.runId,this.attempts,reason);try{this.input.onFailure();}catch{}}return liveReject();}
    bindSession(id:string){this.alive();if(this.sessionID)return this.fail();this.sessionID=pilotId(id,'native');}
    admit(){this.attempts++;if(this.attempts>this.config.maxRequests)return this.fail('budget');this.alive();if(!this.sessionID||this.busy||this.complete)return this.fail();this.busy=true;record('provider',this.input.runId,this.attempts,'admitted');return this.attempts;}
    expectedResult(state:CallState):string {if(state.call.name==='pilot_sum'){if(!state.result)return this.fail();return JSON.stringify(state.result);}if(state.answer===undefined||!state.questionID||!state.answerDelivered)return this.fail();return liveQuestionResult(parseLiveQuestionArguments(state.call.arguments).questions[0].question,state.answer);}
    transcript(raw:unknown):Row[] {
      if(!Array.isArray(raw)||raw.length>64)return this.fail();const native:Row[]=[];
      for(const item of raw){const message=liveObject(item);if(message.role==='system'){liveKeys(message,['role','content']);textContent(message.content);continue;}native.push(message);}
      const first=native.shift();if(!first)return this.fail();liveKeys(first,['role','content']);if(first.role!=='user'||textContent(first.content)!==this.userText)return this.fail();
      const canonical:Row[]=[{role:'system',content:LIVE_RULES},{role:'user',content:this.userText}];
      for(const response of this.responses){const assistant=native.shift();if(!assistant)return this.fail();liveKeys(assistant,['role'],['content','tool_calls','reasoning_content']);if(assistant.role!=='assistant'||textContent(assistant.content)!==response.text||(assistant.reasoning_content!==undefined&&assistant.reasoning_content!==''&&assistant.reasoning_content!==null))return this.fail();
        const rawCalls=assistant.tool_calls??[];if(!Array.isArray(rawCalls)||rawCalls.length!==response.calls.length)return this.fail();
        for(let i=0;i<rawCalls.length;i++){const rawCall=liveKeys(rawCalls[i],['id','type','function']),fn=liveKeys(rawCall.function,['name','arguments']),call=response.calls[i]!;if(rawCall.id!==call.id||rawCall.type!=='function'||fn.name!==call.name)return this.fail();let args:unknown;try{args=JSON.parse(pilotText(fn.arguments,16384));}catch{return this.fail();}const normalized=call.name==='pilot_sum'?parseSumArguments(args):parseLiveQuestionArguments(args);if(!same(normalized,call.arguments))return this.fail();}
        canonical.push({role:'assistant',content:response.text||null,...(response.calls.length?{tool_calls:response.calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}: {})});
        const resultIds=new Set<string>();for(let i=0;i<response.calls.length;i++){const result=native.shift();if(!result)return this.fail();liveKeys(result,['role','tool_call_id','content']);if(result.role!=='tool'||typeof result.tool_call_id!=='string'||resultIds.has(result.tool_call_id)||!response.calls.some(c=>c.id===result.tool_call_id))return this.fail();const state=this.calls.get(result.tool_call_id);if(!state||textContent(result.content)!==this.expectedResult(state))return this.fail();resultIds.add(result.tool_call_id);}
        for(const call of response.calls)canonical.push({role:'tool',tool_call_id:call.id,content:this.expectedResult(this.calls.get(call.id)!)});
      }
      if(native.length)return this.fail();return canonical;
    }
    outgoing(raw:unknown):string {
      const body=liveKeys(raw,['model','messages','tools','stream'],['max_tokens','max_completion_tokens','temperature','top_p','stream_options','tool_choice','parallel_tool_calls','reasoning_content','thinking','frequency_penalty','presence_penalty','seed','stop']);
      if(body.model!==LIVE_MODEL.model||body.stream!==true||(body.tool_choice!==undefined&&body.tool_choice!=='auto')||(body.parallel_tool_calls!==undefined&&typeof body.parallel_tool_calls!=='boolean'))return this.fail();
      if(body.thinking!==undefined||body.reasoning_content!==undefined||body.stop!==undefined)return this.fail();
      for(const key of ['max_tokens','max_completion_tokens'])if(body[key]!==undefined&&(!Number.isSafeInteger(body[key])||(body[key] as number)<1||(body[key] as number)>this.config.maxOutputTokens))return this.fail('budget');
      if(body.stream_options!==undefined){const stream=liveKeys(body.stream_options,['include_usage']);if(stream.include_usage!==true)return this.fail();}
      for(const key of ['temperature','top_p','frequency_penalty','presence_penalty','seed'])if(body[key]!==undefined&&(typeof body[key]!=='number'||!Number.isFinite(body[key])))return this.fail();
      validateNativeTools(body.tools);const messages=this.transcript(body.messages);
      const outgoing=JSON.stringify({model:LIVE_MODEL.model,messages,tools:liveTools(),tool_choice:'auto',stream:true,stream_options:{include_usage:true},max_tokens:this.config.maxOutputTokens,thinking:{type:'disabled'}});
      if(Buffer.byteLength(outgoing,'utf8')>LIVE_LIMITS.contextBytes)return this.fail('budget');if(this.containsKey(outgoing))return this.fail();return outgoing;
    }
    containsKey(value:string){return value.includes(this.config.apiKey)||value.includes(JSON.stringify(this.config.apiKey).slice(1,-1));}
    async completion(raw:unknown,request:number):Promise<string> {
      this.alive();const controller=new AbortController();this.controllers.add(controller);
      let totalTimer:ReturnType<typeof setTimeout>|undefined,firstByteTimer:ReturnType<typeof setTimeout>|undefined,idleTimer:ReturnType<typeof setTimeout>|undefined,hasBodyBytes=false,bodyComplete=false,timeoutReason:TrafficReason|undefined,startedAt=0,lastProgressAt=0;
      const expire=(reason:'request_timeout'|'first_byte_timeout'|'idle_timeout')=>{if(!controller.signal.aborted){timeoutReason=reason;controller.abort();}};
      const cancelled=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new Error('LIVE_CANCELLED')),{once:true});});
      void cancelled.catch(()=>{});
      // All timers begin at actual dispatch. Only received nonempty body bytes count as progress.
      const checkTime=()=>{const totalAt=startedAt+this.config.requestTimeoutMs,phaseAt=bodyComplete?Infinity:hasBodyBytes?lastProgressAt+idleTimeoutMs:startedAt+firstByteTimeoutMs;if(performance.now()>=Math.min(totalAt,phaseAt)){expire(totalAt<=phaseAt?'request_timeout':hasBodyBytes?'idle_timeout':'first_byte_timeout');return liveReject();}};
      const progress=()=>{checkTime();lastProgressAt=performance.now();if(!hasBodyBytes){hasBodyBytes=true;if(firstByteTimer)clearTimeout(firstByteTimer);}if(idleTimer)clearTimeout(idleTimer);idleTimer=setTimeout(()=>expire('idle_timeout'),idleTimeoutMs);};
      try {
        // Native can continue before reply HTTP acknowledgement arrives. Count admission, but
        // never forward an uncertain answer or dispatch after a stop while waiting for its ack.
        const deliveries=[...this.calls.values()].filter(state=>state.answer!==undefined).map(state=>{if(!state.answerDelivery)return this.fail();return state.answerDelivery;});
        if([...this.calls.values()].some(state=>state.answer!==undefined&&!state.answerDelivered))record('provider',this.input.runId,this.attempts,'answer_pending');
        if(deliveries.length)await Promise.race([Promise.all(deliveries),cancelled]);this.alive();if(controller.signal.aborted)return this.fail('cancelled');
        const body=this.outgoing(raw);
        this.alive();if(this.httpRequests>=this.config.maxRequests)return this.fail('budget');this.httpRequests++;totalHttpRequests++;record('http',this.input.runId,this.httpRequests,'dispatch');
        startedAt=performance.now();totalTimer=setTimeout(()=>expire('request_timeout'),this.config.requestTimeoutMs);firstByteTimer=setTimeout(()=>expire('first_byte_timeout'),firstByteTimeoutMs);
        const work=(async()=>{const response=await options.fetchImpl(LIVE_ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${this.config.apiKey}`,'Content-Type':'application/json',Accept:'text/event-stream'},body,redirect:'error',signal:controller.signal});
          if(controller.signal.aborted||closed||this.failed||this.ended||active!==this){void response.body?.cancel().catch(()=>{});return liveReject();}
          try{checkTime();}catch{void response.body?.cancel().catch(()=>{});return liveReject();}
          if(response.status!==200||response.redirected||(response.url!==''&&response.url!==LIVE_ENDPOINT)||response.headers.get('content-type')?.split(';')[0]?.trim()!=='text/event-stream'||!response.body){void response.body?.cancel().catch(()=>{});return this.fail();}
          const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let wire='',bytes=0;const abort=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
          try{while(true){const chunk=await Promise.race([reader.read(),cancelled]);this.alive();if(controller.signal.aborted)return liveReject();checkTime();if(chunk.done){bodyComplete=true;if(firstByteTimer)clearTimeout(firstByteTimer);if(idleTimer)clearTimeout(idleTimer);break;}if(chunk.value.byteLength>0)progress();bytes+=chunk.value.byteLength;if(bytes>LIVE_LIMITS.wireBytes)return this.fail('budget');wire+=decoder.decode(chunk.value,{stream:true});}wire+=decoder.decode();}
          finally{controller.signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});reader.releaseLock();}
          if(this.containsKey(wire))return this.fail();const parsed=parseLiveSse(wire,this.config.maxOutputTokens);if(this.containsKey(JSON.stringify(parsed)))return this.fail();checkTime();return parsed;
        })();
        const result=await Promise.race([work,cancelled]);this.alive();if(controller.signal.aborted)return this.fail(timeoutReason??'cancelled');checkTime();
        if([...this.calls.values()].filter(c=>c.call.name==='pilot_sum').length+result.calls.filter(c=>c.name==='pilot_sum').length>LIVE_LIMITS.calls)return this.fail('budget');
        for(const call of result.calls){if(this.calls.has(call.id))return this.fail();if(call.name==='question'&&++this.questionCount>LIVE_LIMITS.questions)return this.fail('budget');}
        for(const call of result.calls)this.calls.set(call.id,{call});this.responses.push(result);this.complete=result.finish==='stop';
        options.onResponse(this.input.runId,{request:this.httpRequests,responseModel:result.responseModel,usage:result.usage});this.alive();record('http',this.input.runId,this.httpRequests,'response');return liveCanonicalSse(result);
      }catch{return this.fail(timeoutReason??(controller.signal.aborted?'cancelled':'protocol'));}
      finally{if(totalTimer)clearTimeout(totalTimer);if(firstByteTimer)clearTimeout(firstByteTimer);if(idleTimer)clearTimeout(idleTimer);this.controllers.delete(controller);this.busy=false;}
    }
    question(binding:LiveQuestionBinding){this.alive();if(!this.sessionID||this.busy||this.complete)return this.fail();const row=pilotExact(binding,['questionID','messageID','callID','prompt','arguments']),state=this.calls.get(pilotId(row.callID,'native'));
      if(!state||state.call.name!=='question'||state.answer!==undefined)return this.fail();const args=parseLiveQuestionArguments(row.arguments),questionID=pilotId(row.questionID,'native'),messageID=pilotId(row.messageID,'native');
      if(!same(args,state.call.arguments)||row.prompt!==args.questions[0].question||(state.messageID!==undefined&&state.messageID!==messageID)||(state.questionID!==undefined&&state.questionID!==questionID)||[...this.calls.values()].some(c=>c!==state&&c.questionID===questionID))return this.fail();state.messageID=messageID;state.questionID=questionID;
    }
    answer(value:string,questionId?:string){this.alive();if(!questionId||this.busy||this.complete)return this.fail();const states=[...this.calls.values()].filter(c=>c.questionID===questionId);if(states.length!==1||states[0]!.answer!==undefined)return this.fail();states[0]!.answer=pilotText(value,4096);}
    answerDelivery(questionId:string,delivery:Promise<void>):void {this.alive();const states=[...this.calls.values()].filter(state=>state.questionID===questionId);if(states.length!==1||states[0]!.answer===undefined||states[0]!.answerDelivery)return this.fail();const state=states[0]!;
      state.answerDelivery=Promise.resolve(delivery).then(()=>{this.alive();state.answerDelivered=true;},()=>this.fail());
      // Observe immediately even when no continuation arrives. Never turn rejection into success.
      void state.answerDelivery.catch(()=>{});
    }
    async tool(raw:unknown):Promise<SumValue>{this.alive();if(!this.sessionID||this.busy||this.complete)return this.fail();const value=pilotExact(raw,['sessionID','messageID','callID','toolName','arguments']),callID=pilotId(value.callID,'native'),state=this.calls.get(callID),messageID=pilotId(value.messageID,'native'),args=parseSumArguments(value.arguments);
      if(value.sessionID!==this.sessionID||value.toolName!=='pilot_sum'||!state||state.call.name!=='pilot_sum'||!same(args,state.call.arguments)||(state.messageID!==undefined&&state.messageID!==messageID))return this.fail();
      state.messageID=messageID;if(state.promise)return state.promise;
      state.promise=(async()=>{try{const result=parseSumValue(await this.input.onTool({sessionID:this.sessionID!,messageID,callID,toolName:'pilot_sum',arguments:args}));this.alive();if(result.sum!==args.values.reduce((a,b)=>a+b,0)||result.count!==args.values.length)return this.fail();state.result=result;return result;}catch{return this.fail();}})();return state.promise;
    }
    evidence(){return Object.freeze({complete:this.complete&&!this.failed,attempts:this.attempts,httpRequests:this.httpRequests,toolAttempts:this.toolAttempts,failed:this.failed,ended:this.ended,responseModels:Object.freeze(this.responses.map(r=>r.responseModel)),responses:this.responses.length,issued:Object.freeze([...this.calls.keys()]),resolvedCalls:[...this.calls.values()].filter(c=>c.result!==undefined||c.answerDelivered===true).length,pendingAnswerDeliveries:[...this.calls.values()].filter(c=>c.answer!==undefined&&!c.answerDelivered).length});}
    close(){this.ended=true;for(const controller of this.controllers)controller.abort();}
  }
  const server=createServer(async(request,response)=>{
    const current=active,providerAuth=secret(request.headers.authorization,`Bearer ${providerToken}`),toolAuth=secret(request.headers.authorization,`Bearer ${toolToken}`);let ticket:number|undefined;
    if(providerAuth){totalProviderAttempts++;if(!current){unboundProviderAttempts++;poisoned=true;record('provider',null,totalProviderAttempts,'unbound');reply(response,409);return;}try{ticket=current.admit();}catch{reply(response,429);return;}}
    if(toolAuth){totalToolAttempts++;if(current)current.toolAttempts++;record('tool',current?.input.runId??null,totalToolAttempts,'tool');}
    const provider=request.url==='/v1/chat/completions',tool=request.url==='/tool';
    if(closed||request.socket.remoteAddress!=='127.0.0.1'||request.method!=='POST'||request.headers.origin!==undefined||(!provider&&!tool)||!(provider?providerAuth:toolAuth)){
      if((providerAuth||toolAuth)&&current)try{current.fail('route');}catch{}reply(response,403);return;
    }
    if(!current){reply(response,409);return;}
    const disconnected=()=>{if(!response.writableEnded)try{current.fail('cancelled');}catch{}};response.once('close',disconnected);
    try{if(request.headers['content-type']?.split(';')[0]?.trim()!=='application/json')return current.fail();const parsed=await readBody(request);current.alive();
      if(tool){if(current.toolAttempts>16)return current.fail('budget');const value=await current.tool(parsed);current.alive();response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close'});response.end(JSON.stringify(value));}
      else {const wire=await current.completion(parsed,ticket!);current.alive();response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'close'});response.end(wire);}
    }catch{try{current.fail();}catch{}if(!response.headersSent)reply(response,400);else response.destroy();}
    finally{response.off('close',disconnected);}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.timeout=LIVE_LIMITS.requestTimeoutMs+1000;server.maxHeadersCount=32;server.maxConnections=8;
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')return liveReject();
  return Object.freeze({port:address.port,providerToken,toolToken,
    begin(input:LiveBegin){if(closed||poisoned||active||receipts.size>=32||receipts.has(input.runId))return liveReject();const run=new Run(input);active=run;return Object.freeze({bindSession:(id:string)=>run.bindSession(id),question:(binding:LiveQuestionBinding)=>run.question(binding),answer:(value:string,questionId?:string)=>run.answer(value,questionId),answerDelivery:(questionId:string,delivery:Promise<void>)=>run.answerDelivery(questionId,delivery),evidence:()=>run.evidence()});},
    end(runId:string){if(active?.input.runId!==runId)return;const run=active;run.close();receipts.set(runId,run.evidence());active=undefined;},
    evidence(runId:string){return active?.input.runId===runId?active.evidence():receipts.get(runId)??null;},traffic,
    close():Promise<void>{if(closePromise)return closePromise;closed=true;if(active){active.close();receipts.set(active.input.runId,active.evidence());active=undefined;}for(const socket of sockets)socket.destroy();closePromise=new Promise<void>(resolve=>server.close(()=>resolve()));return closePromise;},
  });
}
export type LiveProviderServices = Awaited<ReturnType<typeof createLiveProviderServices>>;
