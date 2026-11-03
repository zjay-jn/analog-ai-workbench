import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { parseSumArguments, parseSumValue, pilotExact, pilotId, pilotText, type SumArguments, type SumValue } from '../../shared/agent/engine-pilot';
import { createPilotSecret, OpenCodePilotError } from './opencode-client';

type NativeTool = Readonly<{ sessionID:string; messageID:string; callID:string; toolName:'pilot_sum'; arguments:SumArguments }>;
type Begin = Readonly<{runId:string; goal:string; constraint:string; onTool:(call:NativeTool)=>Promise<SumValue>; onFailure:()=>void}>;
export const PILOT_NATIVE_QUESTION='请输入新的整数数组（JSON），它将成为下一次求和的实际参数。';
export const pilotNativeQuestionArguments=()=>({questions:[{question:PILOT_NATIVE_QUESTION,header:'求和参数',options:[],multiple:false}]});
/** Fixed v1.18.17 question.ts output; preserve the submitted answer byte for byte. */
export const pilotNativeQuestionResult=(answer:string)=>`User has answered your questions: "${PILOT_NATIVE_QUESTION}"="${answer}". You can now continue with the user's answers in mind.`;
/** Local provider fixture, not an LLM runtime. OpenCode owns every model/tool iteration. */
export function createPilotOracle(input:Begin) {
  const fixture=pilotExact(JSON.parse(input.goal),['scenario','values']);
  if(fixture.scenario!=='sum'&&fixture.scenario!=='question')throw new OpenCodePilotError();
  let args=parseSumArguments({values:fixture.values}),sessionID:string|undefined,answer:string|undefined;
  let phase:'initial'|'question'|'sum'|'final'='initial',attempts=0,closed=false,result:SumValue|undefined,toolBusy=false,resultMessageID:string|undefined;
  let questionResultSeen=false,sumResultSeen=false;const issued:string[]=[],tickets=new Set<number>(),calls=new Map<string,{name:string;arguments:string}>();
  const fail=():never=>{closed=true;input.onFailure();throw new OpenCodePilotError();};
  const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  const content=(value:unknown):string=>{
    if(typeof value==='string')return value;
    if(Array.isArray(value)&&value.every(v=>v&&v.type==='text'&&typeof v.text==='string'))return value.map(v=>v.text).join('');
    return fail();
  };
  const toolResult=(messages:Record<string,unknown>[],id:string):string=>{
    const found=messages.filter(m=>m.role==='tool'&&m.tool_call_id===id);
    if(found.length!==1)return fail();return content(found[0]!.content);
  };
  const validateTranscript=(messages:Record<string,unknown>[])=>{
    const started=new Set<string>(),finished=new Set<string>();let index=0;
    for(const message of messages){
      if(message.role==='assistant'&&message.tool_calls!==undefined){
        if(!Array.isArray(message.tool_calls)||message.tool_calls.length!==1)return fail();
        const call=message.tool_calls[0],expected=calls.get(call?.id);
        if(!expected||call.type!=='function'||call.id!==issued[index++]||started.has(call.id)||!call.function||call.function.name!==expected.name||typeof call.function.arguments!=='string')return fail();
        let actual:unknown,wanted:unknown;try{actual=JSON.parse(call.function.arguments);wanted=JSON.parse(expected.arguments);}catch{return fail();}
        if(!same(actual,wanted))return fail();started.add(call.id);
      }
      if(message.role==='tool'){const id=String(message.tool_call_id);if(!started.has(id)||finished.has(id))return fail();finished.add(id);}
    }
    if(started.size!==issued.length||finished.size!==issued.length)return fail();
  };
  const issue=(id:string,name:string,args:unknown)=>{const call={id,name,arguments:JSON.stringify(args)};issued.push(id);calls.set(id,call);return {call};};
  function admit():number {attempts++;if(closed||attempts>4)return fail();tickets.add(attempts);return attempts;}
  function completion(value:unknown,ticket=admit()):{call?:{id:string;name:string;arguments:string};text?:string} {
    if(closed||!tickets.delete(ticket))return fail();
    if(!value||typeof value!=='object'||Array.isArray(value))return fail();const body=value as Record<string,unknown>;
    if(body.model!=='mock'||body.stream!==true||!Array.isArray(body.messages)||body.messages.length>64||!Array.isArray(body.tools))return fail();
    const names=body.tools.map(t=>t?.type==='function'?t.function?.name:null).sort();
    if(!same(names,['pilot_sum','question']))return fail();
    const messages=body.messages as Record<string,unknown>[];
    if(messages.some(m=>!m||typeof m!=='object'||!['system','user','assistant','tool'].includes(String(m.role))))return fail();
    const users=messages.filter(m=>m.role==='user');
    if(users.length!==1||!content(users[0]!.content).includes(JSON.stringify({goal:input.goal,constraint:input.constraint})))return fail();
    validateTranscript(messages);
    if(phase==='initial') {
      if(messages.some(m=>m.role==='tool'))return fail();
      if(fixture.scenario==='question') {phase='question';return issue('call_pilot_question','question',pilotNativeQuestionArguments());}
    } else if(phase==='question') {
      if(answer===undefined||toolResult(messages,'call_pilot_question')!==pilotNativeQuestionResult(answer))return fail();questionResultSeen=true;
    } else if(phase==='sum') {
      if(!result)return fail();let seen:SumValue;try{seen=parseSumValue(JSON.parse(toolResult(messages,'call_pilot_sum')));}catch{return fail();}
      if(!same(seen,result))return fail();sumResultSeen=true;phase='final';
      return {text:`本地确定性工具已返回：${JSON.stringify(result)}。输入：${JSON.stringify(args.values)}。`};
    } else return fail();
    phase='sum';return issue('call_pilot_sum','pilot_sum',args);
  }
  return Object.freeze({
    bindSession(id:string){if(sessionID||closed)throw new OpenCodePilotError();sessionID=pilotId(id,'native');},
    answer(value:string){if(closed||phase!=='question'||answer!==undefined)throw new OpenCodePilotError();const parsed=parseSumArguments({values:JSON.parse(pilotText(value,4096))});answer=value;args=parsed;},
    completion,admit,
    async tool(value:unknown):Promise<SumValue>{
      if(closed||!sessionID||phase!=='sum'||toolBusy)return fail();
      const v=pilotExact(value,['sessionID','messageID','callID','toolName','arguments']);
      if(v.sessionID!==sessionID||v.callID!=='call_pilot_sum'||v.toolName!=='pilot_sum')return fail();
      const call:NativeTool={sessionID,messageID:pilotId(v.messageID,'native'),callID:pilotId(v.callID,'native'),toolName:'pilot_sum',arguments:parseSumArguments(v.arguments)};
      if(!same(call.arguments,args)||(resultMessageID!==undefined&&resultMessageID!==call.messageID))return fail();if(result)return result;
      resultMessageID=call.messageID;
      toolBusy=true;try{const persisted=parseSumValue(await input.onTool(call));if(closed)return fail();if(persisted.sum!==args.values.reduce((a,b)=>a+b,0)||persisted.count!==args.values.length)return fail();result=persisted;return result;}catch{return fail();}finally{toolBusy=false;}
    },
    evidence:()=>Object.freeze({attempts,issued:[...issued],questionResultSeen,sumResultSeen,result:result??null,values:[...args.values],complete:phase==='final'&&sumResultSeen&&!closed}),
    reject:fail,
    close(){closed=true;},
  });
}

export async function createPilotLoopbackServices() {
  const providerToken=createPilotSecret(),toolToken=createPilotSecret();let active:{id:string;oracle:ReturnType<typeof createPilotOracle>}|undefined,closed=false,inflight=0,poisoned=false,totalProviderAttempts=0,unboundProviderAttempts=0;
  const sockets=new Set<Socket>(),receipts=new Map<string,ReturnType<ReturnType<typeof createPilotOracle>['evidence']>>();
  const secret=(actual:string|undefined,expected:string)=>{if(typeof actual!=='string')return false;const received=Buffer.from(actual),wanted=Buffer.from(expected);return received.byteLength===wanted.byteLength&&timingSafeEqual(received,wanted);};
  const reply=(response:ServerResponse,status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close'});response.end(JSON.stringify(value));};
  async function body(request:IncomingMessage):Promise<unknown>{const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>262144)throw new OpenCodePilotError();chunks.push(buffer);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
  const server=createServer(async(request,response)=>{
    const current=active,provider=request.url==='/v1/chat/completions',tool=request.url==='/tool';
    const providerAuth=secret(request.headers.authorization,`Bearer ${providerToken}`),toolAuth=secret(request.headers.authorization,`Bearer ${toolToken}`);let ticket:number|undefined;
    // All authenticated provider traffic counts before route/method/body/concurrency checks.
    if(providerAuth){totalProviderAttempts++;if(!current){unboundProviderAttempts++;poisoned=true;reply(response,409,{error:'PILOT_UNAVAILABLE'});return;}try{ticket=current.oracle.admit();}catch{reply(response,429,{error:'PILOT_UNAVAILABLE'});return;}}
    if(closed||request.socket.remoteAddress!=='127.0.0.1'||request.method!=='POST'||(!provider&&!tool)||request.headers.origin!==undefined||!(provider?providerAuth:toolAuth)){if(providerAuth&&current)try{current.oracle.reject();}catch{}reply(response,403,{error:'PILOT_UNAVAILABLE'});return;}
    if(!current){reply(response,409,{error:'PILOT_UNAVAILABLE'});return;}
    try{if(inflight>=4)current.oracle.reject();}catch{reply(response,429,{error:'PILOT_UNAVAILABLE'});return;}inflight++;
    try {
      // Admission already counted the attempt, even if body decoding or validation fails.
      let parsed:unknown;try{if(request.headers['content-type']?.split(';')[0]?.trim()!=='application/json')throw Error();parsed=await body(request);}catch{throw new OpenCodePilotError();}
      if(active!==current||closed)throw new OpenCodePilotError();
      if(tool){const result=await current.oracle.tool(parsed);if(active!==current||closed)throw new OpenCodePilotError();reply(response,200,result);return;}
      const result=current.oracle.completion(parsed,ticket),id=`chatcmpl-pilot-${current.oracle.evidence().attempts}`;
      response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'close'});
      const emit=(delta:unknown,finish_reason:string|null)=>response.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created:0,model:'mock',choices:[{index:0,delta,finish_reason}]})}\n\n`);
      emit({role:'assistant'},null);
      if(result.call)emit({tool_calls:[{index:0,id:result.call.id,type:'function',function:{name:result.call.name,arguments:result.call.arguments}}]},null);
      else emit({content:result.text},null);
      emit({},result.call?'tool_calls':'stop');response.end('data: [DONE]\n\n');
    }catch{try{current.oracle.reject();}catch{}if(!response.headersSent)reply(response,400,{error:'PILOT_UNAVAILABLE'});else response.destroy();}
    finally{inflight--;}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.timeout=10000;server.maxHeadersCount=32;server.maxConnections=8;
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new OpenCodePilotError();
  return Object.freeze({port:address.port,providerToken,toolToken,
    begin(input:Begin){if(closed||poisoned||active||receipts.size>=32)throw new OpenCodePilotError();const oracle=createPilotOracle(input);active={id:input.runId,oracle};return oracle;},
    end(runId:string){if(active?.id!==runId)return;receipts.set(runId,active.oracle.evidence());active.oracle.close();active=undefined;},
    evidence(runId:string){return active?.id===runId?active.oracle.evidence():receipts.get(runId)??null;},
    traffic:()=>Object.freeze({totalProviderAttempts,unboundProviderAttempts,poisoned}),
    async close(){closed=true;if(active){receipts.set(active.id,active.oracle.evidence());active.oracle.close();active=undefined;}for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));},
  });
}
export type PilotLoopbackServices=Awaited<ReturnType<typeof createPilotLoopbackServices>>;
