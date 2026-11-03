import {PILOT_VERSION, parsePilotRequest, parsePilotResult, pilotEventState, pilotTerminal,
  type EnginePilotApi, type PilotEvent, type PilotMethod, type PilotRequests, type PilotState,
  type PilotStatus, type PilotSummary, type PilotUsage, type SumArguments, type SumValue} from '../../shared/agent/engine-pilot';

export const pilotStateLabels: Record<PilotState, string> = {running:'运行中',waiting_user:'等待回答',completed:'已完成',failed:'失败',stopped:'已停止',interrupted:'已中断'};
export type PilotToolRow = {callId:string; name:string; arguments:SumArguments; result:SumValue|null};
export type PilotTranscriptItem={kind:'text';key:number;text:string}|{kind:'tool';key:number;tool:PilotToolRow}|{kind:'answer';key:number;prompt:string;answer:string};
export const pilotCanStart=(engine:PilotStatus|null):boolean=>!!engine&&(engine.canStart===undefined?engine.ready:engine.canStart&&!!engine.model);
export function projectPilotEvents(events:readonly PilotEvent[]) {
  let status:PilotState|null=null, action='正在读取记录', text='', goal='', constraint='', engineVersion='';
  let engineKind:'fake'|'opencode'|null=null, question:{questionId:string;prompt:string}|null=null;
  let usage:PilotUsage=null;
  let model:PilotStatus['model'];
  let response:Extract<PilotEvent,{type:'model.response'}>['data']|null=null;
  const responses:Extract<PilotEvent,{type:'model.response'}>['data'][]=[];
  const tools:PilotToolRow[]=[], notes:{key:number;text:string}[]=[];
  const transcript:PilotTranscriptItem[]=[];let textBlock:Extract<PilotTranscriptItem,{kind:'text'}>|null=null;
  for(const event of events){
    status=pilotEventState(event)??status;
    switch(event.type){
      case 'run.accepted': goal=event.data.goal;constraint=event.data.constraint;engineKind=event.data.engineKind;engineVersion=event.data.engineVersion;model=event.data.model;action='已接受目标';break;
      case 'engine.started':action='引擎已启动';break;
      case 'model.step':textBlock=null;action=`处理第 ${event.data.step} 步`;if(!model)usage=event.data.usage;break;
      case 'model.response':if(model){response=event.data;responses.push(response);usage=event.data.usage;}break;
      case 'message.delta':text+=event.data.text;if(!textBlock){textBlock={kind:'text',key:event.sequence,text:''};transcript.push(textBlock);}textBlock.text+=event.data.text;break;
      case 'tool.started':{textBlock=null;const tool={callId:event.data.callId,name:event.data.toolName,arguments:event.data.arguments,result:null};tools.push(tool);transcript.push({kind:'tool',key:event.sequence,tool});action='正在执行本地求和';break;}
      case 'tool.completed':{textBlock=null;const row=tools.find(t=>t.callId===event.data.callId);if(row)row.result=event.data.result;action='工具结果已返回';break;}
      case 'question.asked':textBlock=null;question=event.data;action='等待你的回答';break;
      case 'question.answered':textBlock=null;transcript.push({kind:'answer',key:event.sequence,prompt:question?.questionId===event.data.questionId?question.prompt:'',answer:event.data.answer});if(question?.questionId===event.data.questionId)question=null;notes.push({key:event.sequence,text:`已回答：${event.data.answer}`});action='回答已记录，继续处理';break;
      case 'run.completed':action='运行已完成';question=null;break;
      case 'run.failed':action=`运行失败 · ${event.data.stage} / ${event.data.code}`;question=null;break;
      case 'run.stopped':action='已停止后续执行';question=null;break;
      case 'run.interrupted':action=`运行已中断 · ${event.data.reason}`;question=null;break;
    }
  }
  return {status,action,text,goal,constraint,engineKind,engineVersion,model,question,usage,response,responses,tools,notes,transcript};
}

export type EnginePilotViewState = Readonly<{engine:PilotStatus|null;runs:readonly PilotSummary[];selectedRunId:string|null;
  events:readonly PilotEvent[];loading:boolean;reading:boolean;pending:'start'|'answer'|'stop'|null;
  answeredQuestion:string|null;answerUnconfirmed:boolean;stopAck:'stopped'|'already_terminal'|null;terminal:boolean;error:string|null}>;
export const initialEnginePilotState:EnginePilotViewState={engine:null,runs:[],selectedRunId:null,events:[],loading:true,reading:false,pending:null,answeredQuestion:null,answerUnconfirmed:false,stopAck:null,terminal:false,error:null};
type Clock={set:(fn:()=>void)=>unknown;clear:(handle:unknown)=>void};
const defaultClock:Clock={set:fn=>setTimeout(fn,250),clear:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)};
const errorText=(code:string)=>({BUSY:'已有任务在运行。',NOT_READY:'执行引擎尚未就绪。',STALE_QUESTION:'问题已失效，请刷新运行记录。',STORAGE_FAILED:'运行记录保存失败，请核对后再继续。',SESSION_LIMIT:'试点运行记录已达到上限。',LIMIT_EXCEEDED:'输入或运行预算超过限制。',CAPABILITY_DENIED:'当前入口没有执行权限。',INVALID_REQUEST:'输入格式或长度不符合要求。',NOT_FOUND:'运行记录不可用。'}[code]??'引擎请求失败，请刷新记录后核对。');

export function createEnginePilotController(api:EnginePilotApi, clock:Clock=defaultClock, uuid:()=>string=()=>crypto.randomUUID()){
  let state=initialEnginePilotState,disposed=false,generation=0,readBusy=false,timer:unknown=null,loadBusy=false;
  let request:{goal:string;constraint:string;id:string;model?:PilotStatus['model']}|null=null;
  const listeners=new Set<()=>void>();
  const update=(patch:Partial<EnginePilotViewState>)=>{if(disposed)return;state={...state,...patch};listeners.forEach(fn=>fn());};
  const clearTimer=()=>{if(timer!==null){clock.clear(timer);timer=null;}};
  const schedule=()=>{clearTimer();if(!disposed&&state.selectedRunId&&!state.terminal&&!state.error)timer=clock.set(()=>{timer=null;void poll();});};
  async function call<K extends PilotMethod>(method:K,input:PilotRequests[K]){
    return parsePilotResult(method,await api[method](parsePilotRequest(method,input) as never));
  }
  async function poll(){
    if(disposed||readBusy||!state.selectedRunId||state.terminal)return;
    clearTimer();readBusy=true;const epoch=generation,runId=state.selectedRunId,afterSequence=state.events.length;update({reading:true});
    try{
      const result=await call('readRun',{contractVersion:PILOT_VERSION,runId,afterSequence});
      if(disposed||epoch!==generation)return;
      if(!result.ok){update({error:errorText(result.error.code)});return;}
      const batch=result.value;
      if(batch.runId!==runId||batch.nextSequence!==afterSequence+batch.events.length||batch.events.some((e,i)=>e.sequence!==afterSequence+i+1))throw new Error('Sequence');
      const events=[...state.events,...batch.events],projection=projectPilotEvents(events);
      if(events.length>512||(events.length>0&&events[0]?.type!=='run.accepted')||batch.terminal!==(projection.status!==null&&pilotTerminal(projection.status)))throw new Error('State');
      const accepted=events[0];
      let runs=state.runs;
      if(accepted?.type==='run.accepted'&&projection.status){
        const summary:PilotSummary={runId,goal:accepted.data.goal,status:projection.status,createdAt:accepted.time,updatedAt:events.at(-1)!.time,engineKind:accepted.data.engineKind,...(accepted.data.model?{model:accepted.data.model}:{})};
        runs=[summary,...runs.filter(r=>r.runId!==runId)];
      }
      update({events,runs,terminal:batch.terminal,error:null});
    }catch{if(!disposed&&epoch===generation)update({error:'运行记录读取失败或顺序异常，请刷新核对。'});}
    finally{readBusy=false;if(!disposed){if(epoch===generation)update({reading:false});schedule();}}
  }
  async function select(runId:string){
    if(disposed||state.pending)return;generation++;clearTimer();update({selectedRunId:runId,events:[],terminal:false,reading:false,answeredQuestion:null,answerUnconfirmed:false,stopAck:null,error:null});await poll();
  }
  async function load(){
    if(disposed||loadBusy)return;loadBusy=true;update({loading:true,error:null});
    try{
      const [engineResult,runsResult]=await Promise.allSettled([call('getStatus',{contractVersion:PILOT_VERSION}),call('listRuns',{contractVersion:PILOT_VERSION})]);
      if(disposed)return;
      const engine=engineResult.status==='fulfilled'?engineResult.value:null,runs=runsResult.status==='fulfilled'?runsResult.value:null;
      const statusError=!engine?'无法读取引擎状态，仍可查看运行记录。':!engine.ok?errorText(engine.error.code):null;
      update({engine:engine?.ok?engine.value:null});
      if(!runs?.ok){update({error:runs?errorText(runs.error.code):'无法读取运行记录，请刷新核对。'});return;}
      const current=state.runs.find(r=>r.runId===state.selectedRunId);
      const merged=runs.value.runs.map(r=>r.runId===current?.runId&&state.events.length>0&&current.updatedAt>=r.updatedAt?current:r);
      update({runs:merged});
      if(!state.selectedRunId){const first=runs.value.runs.find(r=>!pilotTerminal(r.status))??runs.value.runs[0];if(first)await select(first.runId);}
      else if(!state.terminal)await poll();
      if(statusError)update({error:statusError});
    }catch{update({error:'无法连接试点引擎，请重试。'});}finally{loadBusy=false;update({loading:false});}
  }
  async function start(goal:string,constraint:string){
    if(disposed||state.pending||state.loading||!pilotCanStart(state.engine)||state.runs.some(r=>!pilotTerminal(r.status))||state.selectedRunId&&!state.terminal)return false;
    const model=state.engine?.model;
    if(!request||request.goal!==goal||request.constraint!==constraint||request.model?.provider!==model?.provider||request.model?.model!==model?.model)request={goal,constraint,id:uuid(),...(model?{model}:{})};
    const input={contractVersion:PILOT_VERSION,clientRequestId:request.id,goal,constraint,...(request.model?{model:request.model}:{})};
    try{parsePilotRequest('startRun',input);}
    catch{update({error:'目标不能为空；目标和约束各最多 4096 UTF-8 字节。'});return false;}
    update({pending:'start',error:null});let runId:string|null=null;
    try{const result=await call('startRun',input);if(disposed)return false;
      if(!result.ok){update({error:errorText(result.error.code)});return false;}runId=result.value.runId;request=null;
    }catch{update({error:'开始请求未确认；再次开始会核对同一次请求。'});}finally{update({pending:null});}
    if(runId&&!disposed){await select(runId);return true;}return false;
  }
  async function answer(questionId:string,answer:string){
    const projection=projectPilotEvents(state.events),runId=state.selectedRunId;
    if(disposed||state.pending||!runId||state.terminal||projection.question?.questionId!==questionId||state.answeredQuestion===questionId)return false;
    try{parsePilotRequest('answerQuestion',{contractVersion:PILOT_VERSION,runId,questionId,answer});}
    catch{update({error:'回答不能为空，且最多 4096 UTF-8 字节。'});return false;}
    const epoch=generation;update({pending:'answer',error:null});
    try{const result=await call('answerQuestion',{contractVersion:PILOT_VERSION,runId,questionId,answer});if(disposed||epoch!==generation)return false;
      if(!result.ok){update({error:errorText(result.error.code)});return false;}update({answeredQuestion:questionId,answerUnconfirmed:false});return true;
    }catch{if(epoch===generation)update({answeredQuestion:questionId,answerUnconfirmed:true,error:'回答提交未确认，请重新打开该运行记录核对，不要重复提交。'});return false;}
    finally{if(epoch===generation){update({pending:null});schedule();}}
  }
  async function stop(){
    const runId=state.selectedRunId;if(disposed||state.pending||!runId||state.terminal||state.stopAck)return;
    const epoch=generation;update({pending:'stop',error:null});
    try{const result=await call('stopRun',{contractVersion:PILOT_VERSION,runId});if(disposed||epoch!==generation)return;
      if(!result.ok){update({error:errorText(result.error.code)});return;}update({stopAck:result.value.status});
    }catch{if(epoch===generation)update({error:'停止尚未确认，请刷新运行记录核对。'});}
    finally{if(epoch===generation){update({pending:null});schedule();}}
  }
  return {snapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},load,select,start,answer,stop,poll,
    refresh:async()=>{update({error:null});await load();},dispose:()=>{disposed=true;generation++;clearTimer();listeners.clear();}};
}
export type EnginePilotController=ReturnType<typeof createEnginePilotController>;
