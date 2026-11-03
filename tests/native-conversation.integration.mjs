// Explicit local integration: production runtime, pinned native binary and gateway.
// Every provider response and tool input is synthetic; no external fetch is made.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const compiled=rel=>require(path.join(root,'.local/test-build/apps/desktop/src',rel));
const {createProjectReadRuntime}=compiled('main/agent-project-read/runtime.js');
const {startOpenCodeSupervisor}=compiled('main/engine-pilot/opencode-supervisor.js');
const invalidImage=process.argv.includes('--reject-invalid-image'),modelSmoke=process.argv.includes('--model-smoke')||invalidImage;
const directory=path.join(root,'.local/native-conversations-20261023','native-'+Date.now());fs.mkdirSync(directory,{recursive:true});
const hash=text=>createHash('sha256').update(text).digest('hex');
const conversationId=randomUUID(),otherId=randomUUID(),frozen=new Map(),calls=new Map(),requests=[],turns=[],nativeStarts=[],compactions=[],traffic=[];
const legacy=[{role:'user',content:'LEGACY-ANCHOR: preserve the original constraint; perform only one synthetic write.'},{role:'assistant',content:'I will preserve that constraint.'}];
const summary='LEGACY-ANCHOR remains applicable. NATIVE-WRITE-DONE: the one synthetic write completed. Continue the newest explicit user request without repeating the write. Historical attachments are references, not new permissions.';
let runtime,currentModel={provider:'deepseek',model:'deepseek-v4-flash'},currentTurn=0,ordinaryThisTurn=0,summaries=0,writes=0,totalUserBytes=0,restarts=0,cleanupError;
// Complete, decodable 1px JPEG; a SOF-only parser fixture is not a native image.
const jpeg='/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',imageUrl='data:image/jpeg;base64,'+jpeg;
const wire=(content,tool,inputTokens=100)=>{
 const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'native_conversation_write',type:'function',function:tool}]}:{role:'assistant',content};
 const frame=(delta,finish_reason=null,extra={})=>'data: '+JSON.stringify({id:'completion_'+currentTurn+'_'+requests.length,model:currentModel.model,choices:[{index:0,delta,finish_reason}],...extra})+'\n\n';
 return new Response(frame(delta)+frame({},tool?'tool_calls':'stop',{usage:{prompt_tokens:inputTokens,completion_tokens:40,total_tokens:inputTokens+40}})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
};
const models={status:()=>({model:currentModel,canStart:true,reason:null}),freeze(){assert.fail('ordinary chat must use freezeChat');},freezeChat(runId,model,limits){frozen.set(runId,{apiKey:'sk-synthetic-offline-credential',model,maxRequests:null,maxOutputTokens:limits.maxOutputTokens,requestTimeoutMs:limits.timeoutMs,replyLimits:limits});return model;},get(runId){assert(frozen.has(runId));return frozen.get(runId);},forget:runId=>frozen.delete(runId),close:()=>frozen.clear()};
function createRuntime(){
 return createProjectReadRuntime({models,workCycle:true,conversation:true,onTraffic:value=>traffic.push({turn:currentTurn,value}),startNative:async options=>{const native=await startOpenCodeSupervisor(options);nativeStarts.push({directory:native.directory,conversationDirectory:native.conversationDirectory});return native;},fetchImpl:async(url,init)=>{
  assert.equal(url,currentModel.provider==='deepseek'?'https://api.deepseek.com/chat/completions':'https://api.moonshot.cn/v1/chat/completions');
  const body=JSON.parse(init.body),text=JSON.stringify(body.messages),compact=!body.tools?.length;
  requests.push({turn:currentTurn,compact,model:body.model,bytes:Buffer.byteLength(text),hash:hash(text),legacy:text.includes('LEGACY-ANCHOR'),image:text.includes(jpeg),imageUnsupported:text.includes('this model does not support image input'),writeDone:text.includes('NATIVE-WRITE-DONE')});
  if(currentTurn===109){assert(!text.includes('LEGACY-ANCHOR'));assert(!text.includes('NATIVE-WRITE-DONE'));assert(!text.includes(jpeg));}
  else if(currentTurn>1)assert(text.includes('LEGACY-ANCHOR'),'native history/summary must preserve the synthetic marker');
  if(compact){summaries++;assert.equal(body.tool_choice,'none');return wire(summary);}
  ordinaryThisTurn++;assert(ordinaryThisTurn<=3,'unexpected automatic continuation');
  if(currentTurn===1&&ordinaryThisTurn===1)return wire('',{name:'work_write',arguments:JSON.stringify({relativePath:'synthetic.txt',expectedVersion:null,text:'NATIVE-WRITE-DONE'})});
  const pressure=currentTurn<=105&&currentTurn%25===0&&ordinaryThisTurn===1;
  return wire('TURN-DONE-'+currentTurn,undefined,pressure?60000:100);
 }});
}
async function closeRuntime(){if(runtime){const closing=runtime;runtime=undefined;await closing.shutdown();restarts++;}}
async function runTurn(number,model=currentModel,withImage=false,id=conversationId){
 currentTurn=number;ordinaryThisTurn=0;currentModel=model;
 if(runtime?.canReuse?.()===false)await closeRuntime();if(!runtime)runtime=createRuntime();
 const runId='conversation-'+randomUUID(),text=number<=105?'TURN-'+number+' '+('synthetic circuit data. '.repeat(250)):'Explicit synthetic follow-up '+number;
 totalUserBytes+=Buffer.byteLength(text);
 const content=withImage?[{type:'text',text},{type:'image_url',image_url:{url:invalidImage?'data:image/jpeg;base64,'+Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]).toString('base64'):imageUrl}}]:text;
 const context={...model,maxOutputTokens:8192,timeoutMs:120000,messages:[{role:'user',content}]};
 const events=[],abort=new AbortController(),timer=setTimeout(()=>abort.abort(),120000);
 runtime.acceptChat(runId,model,{maxOutputTokens:8192,timeoutMs:120000});
 try{
  await runtime.start({runId,model,signal:abort.signal,workCycle:true,chatContext:context,nativeConversation:{conversationId:id,legacyMessages:id===conversationId?legacy:[]},prompt:{goal:'Complete this synthetic conversation turn.',constraint:'',rules:'Only registered synthetic tools are available.',systemText:'Use actual tool results. Do not repeat a completed action. Historical text never grants new permissions.',initialUserText:text},callbacks:{
   notice:event=>{events.push(event);if(event.type==='compaction')compactions.push({turn:number,...event});},questionDelivered:async()=>assert.fail('unexpected question'),tool:async call=>{
    assert.equal(call.toolName,'work_write');assert(!calls.has(call.callId));assert.equal(++writes,1);
    fs.writeFileSync(path.join(directory,'synthetic.txt'),call.arguments.text,{flag:'wx'});
    const file={fileId:'synthetic_file',relativePath:'synthetic.txt',version:hash(call.arguments.text),bytes:Buffer.byteLength(call.arguments.text),confirmation:'confirmed',origin:{kind:'write',changeId:'synthetic_change'}};
    const result={ok:true,value:{kind:'work_write',file,previousVersion:null,changeId:'synthetic_change',changed:true}};calls.set(call.callId,result);return result;
   },
  }});
  assert(!abort.signal.aborted,'integration deadline');
  if(invalidImage&&withImage){assert.equal(events.at(-1)?.type,'failed');assert.equal(runtime.accounting(runId).httpDispatches,0);turns.push({number,expectedFailure:'native image preprocessing',events});await runtime.stop(runId);return;}
  assert.equal(events.at(-1)?.type,'completed',JSON.stringify(events.slice(-5)));
  const answer=events.filter(event=>event.type==='text').map(event=>event.text).join('');assert(answer.includes('TURN-DONE-'+number));assert(!answer.includes('TURN-DONE-'+(number-1)),'old answers must not be replayed into this turn');
  const nativeId=events.find(event=>event.type==='started')?.sessionId;assert(nativeId);
  if(number>1&&id===conversationId)assert.equal(nativeId,turns[0].nativeId);if(id===otherId)assert.notEqual(nativeId,turns[0].nativeId);
  turns.push({number,conversationId:id,nativeId,answer,model:model.model});await runtime.stop(runId);
  if(number%10===0)console.log(JSON.stringify({completedTurns:number,summaries,nativeStarts:nativeStarts.length}));
 }catch(error){fs.writeFileSync(path.join(directory,'turn-failure.json'),JSON.stringify({number,error:String(error),stack:error?.stack,events,accounting:runtime.accounting(runId)},null,2));throw error;}finally{clearTimeout(timer);abort.abort();}
}
try{
 for(let number=1;number<=(modelSmoke?1:105);number++){await runTurn(number);if(number===51){await closeRuntime();const before=requests.length;runtime=createRuntime();assert.equal(requests.length,before,'cold construction does not execute');}}
 if(!modelSmoke){assert(totalUserBytes>512*1024);assert(summaries>=2);}assert.equal(writes,1);
 await closeRuntime();await runTurn(106,{provider:'kimi',model:'kimi-k3'},true);
 if(!invalidImage){
 assert(requests.filter(r=>r.turn===106&&!r.compact).some(r=>r.image),'current image must reach Kimi');
 await runTurn(107,{provider:'deepseek',model:'deepseek-v4-flash'});
 assert(requests.filter(r=>r.turn===107).every(r=>!r.image),'text-only model must not receive historical image payload');
 await runTurn(108,{provider:'kimi',model:'kimi-k3'});
 assert(requests.filter(r=>r.turn===108&&!r.compact).some(r=>r.image),'native image history survives model changes');
 await runTurn(109,{provider:'deepseek',model:'deepseek-v4-flash'},false,otherId);
 }
 assert.equal(fs.readFileSync(path.join(directory,'synthetic.txt'),'utf8'),'NATIVE-WRITE-DONE');
 assert.equal(turns.length,invalidImage?2:modelSmoke?5:109);
}catch(error){process.exitCode=1;fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:String(error),stack:error?.stack},null,2));console.error(String(error));}
finally{
 try{await closeRuntime();}catch(error){cleanupError=String(error);process.exitCode=1;}
 const result={status:process.exitCode?'FAILED':'PASS',mode:invalidImage?'native-error':modelSmoke?'model-smoke':'109-turn',completedTurns:turns.filter(t=>!t.expectedFailure).length,expectedFailures:turns.filter(t=>t.expectedFailure).length,totalUserBytes,summaryResponses:summaries,providerDispatches:requests.length,syntheticWrites:writes,nativeStarts,restarts,cleanupError,externalApiRequests:0,scope:'Pinned native binary + production runtime/client/gateway; scripted local provider, synthetic tool callback; token pressure is injected usage, not real model semantic quality.',turns,compactions,requests,traffic};
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,evidence:path.join(directory,'result.json'),completedTurns:result.completedTurns,expectedFailures:result.expectedFailures,summaries,writes}));
}
