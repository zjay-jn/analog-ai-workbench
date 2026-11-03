import {CLOUD_CHAT_LIMITS_V1 as limits,CloudChatErrorV1} from './cloud-chat-contract';

type Usage=Readonly<{promptTokens:number;completionTokens:number;totalTokens:number}>;
export type CloudChatStreamResultV1=Readonly<{text:string;finishReason:'stop';usage?:Usage}>;
function protocol():never{throw new CloudChatErrorV1('PROTOCOL_ERROR');}
function object(value:unknown):Record<string,unknown>{if(value===null||typeof value!=='object'||Array.isArray(value))protocol();return value as Record<string,unknown>;}

export function createCloudChatStreamParserV1(onText:(text:string)=>void,receive?:Readonly<{responseBytes:number;eventCount:number;outputBytes?:number;onProgress?:()=>void}>) {
  const modern=receive?.outputBytes!==undefined,bodyLimit=receive?.outputBytes??limits.outputBytes,lineLimit=modern?bodyLimit*6+4096:limits.lineBytes,eventLimit=modern?lineLimit:limits.eventBytes;
  const responseBytes=receive?.responseBytes??limits.responseBytes,maxEvents=receive?.eventCount??limits.eventCount;
  if(!Number.isSafeInteger(responseBytes)||responseBytes<1||responseBytes>16*1024*1024||!Number.isSafeInteger(bodyLimit)||bodyLimit<1||bodyLimit>262144||!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>32768)throw new CloudChatErrorV1('INVALID_REQUEST');
  const decoder=new TextDecoder('utf-8',{fatal:true});const encoder=new TextEncoder();
  let buffer='',data:string[]=[],eventBytes=0,lineBytes=0,totalBytes=0,chunkCount=0,outputBytes=0,eventCount=0,text='';
  let stopped=false,done=false,failed=false,closed=false;let usage:Usage|undefined;
  let wireLineBytes=0,wireEventBytes=0,previousByte=-1;
  const bounded=(value:number,max:number)=>{if(value>max)throw new CloudChatErrorV1('RESPONSE_LIMIT');};
  function dispatch():void {
    if(data.length===0){eventBytes=0;return;}
    const raw=data.join('\n');data=[];eventBytes=0;
    if(!modern)bounded(++eventCount,maxEvents);
    if(done)protocol();
    if(raw==='[DONE]'){if(!stopped)protocol();done=true;return;}
    let parsed:unknown;try{parsed=JSON.parse(raw);}catch{protocol();}
    const frame=object(parsed);
    if('error'in frame||!Array.isArray(frame.choices)||frame.choices.length>1)protocol();
    if(frame.usage!==undefined&&frame.usage!==null){
      const u=object(frame.usage);const counts=[u.prompt_tokens,u.completion_tokens,u.total_tokens];
      if(!counts.every(n=>Number.isSafeInteger(n)&&(n as number)>=0&&(n as number)<=Number.MAX_SAFE_INTEGER))protocol();
      usage=Object.freeze({promptTokens:u.prompt_tokens as number,completionTokens:u.completion_tokens as number,totalTokens:u.total_tokens as number});
    }
    if(frame.choices.length===0){if(!stopped||frame.usage==null||Object.keys(frame).some(key=>!['choices','usage','id','object','created','model','system_fingerprint'].includes(key)))protocol();return;}
    const choice=object(frame.choices[0]);if(choice.index!==0)protocol();
    const delta=object(choice.delta);
    if(Object.keys(delta).some(k=>!['role','content','reasoning_content'].includes(k)))protocol();
    if(delta.role!==undefined&&delta.role!=='assistant')protocol();
    for(const key of ['content','reasoning_content'])if(delta[key]!==undefined&&delta[key]!==null&&typeof delta[key]!=='string')protocol();
    if(stopped)protocol();
    if((typeof delta.content==='string'&&delta.content.length)||(typeof delta.reasoning_content==='string'&&delta.reasoning_content.length))receive?.onProgress?.();
    if(typeof delta.content==='string'&&delta.content.length>0){
      if(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(delta.content))protocol();
      outputBytes+=encoder.encode(delta.content).length;bounded(outputBytes,bodyLimit);
      text+=delta.content;onText(delta.content);
    }
    const finish=choice.finish_reason;
    if(finish==='length')throw new CloudChatErrorV1('OUTPUT_LIMIT');
    if(finish!==null&&finish!==undefined){if(finish!=='stop')protocol();stopped=true;}
  }
  function consume(chunk:string):void {
    let offset=0;
    while(offset<chunk.length){
      const end=chunk.indexOf('\n',offset);const newline=end>=0;
      const piece=chunk.slice(offset,newline?end:chunk.length);
      const bytes=encoder.encode(piece).length+(newline?1:0);
      bounded(lineBytes+bytes,lineLimit);bounded(eventBytes+lineBytes+bytes,eventLimit);
      buffer+=piece;lineBytes+=bytes;offset=newline?end+1:chunk.length;
      if(!newline)break;
      let line=buffer;buffer='';eventBytes+=lineBytes;lineBytes=0;if(line.endsWith('\r'))line=line.slice(0,-1);
      if(line===''){dispatch();continue;}
      if(line.startsWith(':'))continue;
      if(done)protocol();
      if(line.startsWith('data:')){let value=line.slice(5);if(value.startsWith(' '))value=value.slice(1);data.push(value);}
      else if(line==='data')data.push('');
      else if(!/^(event|id|retry):/u.test(line))protocol();
    }
  }
  return Object.freeze({
    push(bytes:Uint8Array):void {
      if(failed||closed)protocol();
      try{
        if(!modern){bounded(++chunkCount,receive?65536:limits.chunkCount);bounded(bytes.byteLength,limits.chunkBytes);}totalBytes+=bytes.byteLength;bounded(totalBytes,responseBytes);
        // Count raw wire bytes too: TextDecoder may retain an incomplete UTF8 prefix.
        for(const byte of bytes){
          bounded(++wireLineBytes,lineLimit);bounded(++wireEventBytes,eventLimit);
          if(byte===10){if(wireLineBytes===1||(wireLineBytes===2&&previousByte===13))wireEventBytes=0;wireLineBytes=0;}
          previousByte=byte;
        }
        let decoded:string;try{decoded=decoder.decode(bytes,{stream:true});}catch{protocol();}consume(decoded);
      }catch(error){failed=true;throw error instanceof CloudChatErrorV1?error:new CloudChatErrorV1('PROTOCOL_ERROR');}
    },
    finish():CloudChatStreamResultV1 {
      if(failed||closed)protocol();closed=true;
      try{consume(decoder.decode());if((buffer.length>0&&!buffer.startsWith(':'))||data.length||!done||!stopped||!text.trim())protocol();return Object.freeze({text,finishReason:'stop' as const,...(usage?{usage}:{})});}catch(error){failed=true;throw error instanceof CloudChatErrorV1?error:new CloudChatErrorV1('PROTOCOL_ERROR');}
    },
  });
}
