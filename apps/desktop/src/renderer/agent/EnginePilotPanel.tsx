import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {EnginePilotApi,PilotStatus} from '../../shared/agent/engine-pilot';
import {ModelSettingsDialog} from './ModelSettingsDialog';
import {ChatMarkdown} from './ChatMarkdown';
import {createEnginePilotController,initialEnginePilotState,pilotCanStart,pilotStateLabels,projectPilotEvents,type EnginePilotController,type EnginePilotViewState,type PilotToolRow} from './engine-pilot-controller';

type Actions=Pick<EnginePilotController,'start'|'answer'|'stop'|'select'|'refresh'>;
const kindLabel=(kind:'fake'|'opencode'|null|undefined)=>kind==='fake'?'本地模拟 provider':kind==='opencode'?'OpenCode 引擎':'正在核对引擎';
const modelLabel=(model:NonNullable<PilotStatus['model']>)=>`DeepSeek · ${model.model}`;
function availabilityText(engine:PilotStatus|null){
  if(!engine)return '';
  if(engine.availability==='not_configured')return '尚未配置 DeepSeek，可打开模型设置；已有任务记录仍可查看。';
  if(engine.availability==='unsupported_model')return '当前工具任务仅支持 DeepSeek V4 Flash，请在模型设置中选择该模型；已有记录仍可查看。';
  if(engine.availability==='unavailable'||engine.processState==='failed')return '工具引擎当前不可用，已有记录仍可查看。';
  if(engine.processState==='starting')return '正在启动工具引擎…';
  if(engine.processState==='idle'&&pilotCanStart(engine))return '开始任务时启动引擎。';
  if(engine.canStart!==undefined&&!engine.model)return '尚未确认可用模型，请刷新状态或检查模型设置。';
  return !engine.ready?'引擎尚未就绪，运行记录仍可查看。':'';
}
export function EnginePilotView({state,actions,mode='pilot',onOpenSettings,historyOnly=false}:{state:EnginePilotViewState;actions:Actions;mode?:'pilot'|'live';onOpenSettings?:()=>void;historyOnly?:boolean}){
  const [goal,setGoal]=useState(''),[constraint,setConstraint]=useState(''),[answer,setAnswer]=useState('');
  const run=projectPilotEvents(state.events),question=run.question;
  useEffect(()=>setAnswer(''),[state.selectedRunId,question?.questionId]);
  const occupied=state.runs.some(r=>r.status==='running'||r.status==='waiting_user')||!!state.selectedRunId&&!state.terminal;
  const startDisabled=state.loading||!!state.pending||!pilotCanStart(state.engine)||occupied||!goal.trim();
  const submit=(event:FormEvent)=>{event.preventDefault();if(!startDisabled)void actions.start(goal,constraint);};
  const sendAnswer=(event:FormEvent)=>{event.preventDefault();if(question&&answer.trim())void actions.answer(question.questionId,answer);};
  const toolDetails=(tool:PilotToolRow)=><details><summary>{tool.name} · {tool.result?'已返回':state.terminal?'未确认完成':'执行中'}</summary>
    <small>调用 ID：{tool.callId}</small><h3>参数</h3><pre>{JSON.stringify(tool.arguments,null,2)}</pre><h3>结果</h3>
    {tool.result?<pre>{JSON.stringify(tool.result,null,2)}</pre>:<p>尚无已确认结果。</p>}</details>;
  return <section className="engine-pilot-panel" aria-label={mode==='live'?'工具任务':'工具执行试点'} data-engine-pilot="true" data-engine-mode={mode}>
    <header className="engine-pilot-heading"><div><h1>{historyOnly?'早期计算任务记录':mode==='live'?'工具任务':'工具执行试点'}</h1>
      {mode==='live'&&!historyOnly&&<p className="engine-pilot-muted" data-next-model={state.engine?.model?.model??'unknown'}>下次任务：{state.engine?.model?modelLabel(state.engine.model):'尚未确定可用模型'}</p>}
      <span data-pilot-engine={state.engine?.engineKind??'unknown'}>{kindLabel(state.engine?.engineKind)}{state.engine?` · ${state.engine.engineVersion}`:''}</span></div>
      <div className="engine-pilot-heading-actions">{onOpenSettings&&<button type="button" onClick={onOpenSettings}>模型设置</button>}
      <button type="button" disabled={state.loading||!!state.pending} onClick={()=>void actions.refresh()}>刷新记录</button></div></header>
    <div className="engine-pilot-body"><aside className="engine-pilot-history" aria-label="工具任务记录"><h2>运行记录</h2>
      {!state.runs.length&&<p>{state.loading?'正在读取…':'暂无记录'}</p>}
      {state.runs.map(item=><button type="button" key={item.runId} aria-pressed={item.runId===state.selectedRunId} disabled={!!state.pending}
        onClick={()=>void actions.select(item.runId)}><span>{item.goal}</span><small>{pilotStateLabels[item.status]} · {item.model?modelLabel(item.model):kindLabel(item.engineKind)}</small></button>)}
    </aside><main className="engine-pilot-main">
      {!historyOnly&&<form className="engine-pilot-goal" onSubmit={submit}><label htmlFor="pilot-goal">任务目标</label>
        <textarea id="pilot-goal" value={goal} onChange={event=>setGoal(event.target.value)} placeholder={mode==='live'?'例如：用工具计算 18、-7 和 4 的和，再解释结果。':'输入本次试点目标'} rows={2} disabled={state.pending==='start'}/>
        <details><summary>补充约束（可选）</summary><textarea aria-label="补充约束" value={constraint} onChange={event=>setConstraint(event.target.value)} rows={2} disabled={state.pending==='start'}/></details>
        <button type="submit" disabled={startDisabled}>{state.pending==='start'?'正在开始…':'开始新任务'}</button>
      </form>}
      {state.error&&<p role="alert" className="engine-pilot-error">{state.error}</p>}
      {availabilityText(state.engine)&&<p className="engine-pilot-muted" role="status">{availabilityText(state.engine)}</p>}
      {state.selectedRunId?<section className="engine-pilot-run" aria-label="当前试点运行" data-run-id={state.selectedRunId} data-run-state={run.status??'loading'}>
        <div className="engine-pilot-current"><div role="status"><strong>{run.status?pilotStateLabels[run.status]:'正在读取'}</strong>
          <p>{state.pending==='stop'?'正在请求停止…':state.stopAck&&!state.terminal?(state.stopAck==='stopped'?'主进程已确认停止，正在核对记录…':'任务已结束，正在核对记录…'):run.action}</p></div>
          <button type="button" onClick={()=>void actions.stop()} disabled={state.terminal||!!state.pending||!!state.stopAck}>{state.pending==='stop'?'正在停止…':'停止'}</button></div>
        {run.goal&&<h2>{run.goal}</h2>}
        {run.engineKind&&<p className="engine-pilot-muted" data-run-model={run.model?.model??'unrecorded'}>{run.model?`本次模型：${modelLabel(run.model)} · `:''}{kindLabel(run.engineKind)} · {run.engineVersion}</p>}
        {run.constraint&&<details><summary>本次约束</summary><p className="engine-pilot-text">{run.constraint}</p></details>}
        {mode!=='live'&&run.tools.length>0&&<ol className="engine-pilot-tools" aria-label="工具调用">{run.tools.map(tool=><li key={tool.callId} data-call-id={tool.callId}>{toolDetails(tool)}</li>)}</ol>}
        {mode==='live'&&run.transcript.length>0&&<ol className="engine-task-timeline" aria-label="任务过程">{run.transcript.map(item=><li key={item.key}
          className={`engine-task-${item.kind}`} data-message-event={item.key} {...(item.kind==='tool'?{'data-call-id':item.tool.callId}:{})}>
          {item.kind==='text'?<ChatMarkdown text={item.text}/>:item.kind==='tool'?toolDetails(item.tool):<>
            {item.prompt&&<p className="engine-pilot-text">{item.prompt}</p>}<p className="engine-pilot-text"><strong>你的回答：</strong>{item.answer}</p></>}
        </li>)}</ol>}
        {question&&!state.terminal&&<form className="engine-pilot-question" onSubmit={sendAnswer} data-question-id={question.questionId}>
          <label htmlFor="pilot-answer">{question.prompt}</label><textarea id="pilot-answer" value={answer} rows={2} onChange={event=>setAnswer(event.target.value)}
            disabled={!!state.pending||state.answeredQuestion===question.questionId}/>
          <button type="submit" disabled={!answer.trim()||!!state.pending||state.answeredQuestion===question.questionId}>{state.answeredQuestion===question.questionId?(state.answerUnconfirmed?'提交未确认，请核对记录':'回答已提交'):state.pending==='answer'?'正在提交…':'提交回答'}</button></form>}
        {mode!=='live'&&run.notes.map(note=><p key={note.key} className="engine-pilot-muted engine-pilot-text">{note.text}</p>)}
        {mode!=='live'&&run.text&&<div className="engine-pilot-output engine-pilot-text" aria-label="引擎输出">{run.text}</div>}
        {run.status==='interrupted'&&<p className="engine-pilot-muted">本次运行已中断，未自动重放。可查看记录或手动开始新任务。</p>}
        <details className="engine-pilot-diagnostics"><summary>运行信息</summary><p>运行 ID：{state.selectedRunId}</p><p>已读取事件：{state.events.length}</p>
          <p>{run.model?'最近已验证响应用量':'最近模型步骤用量'}：{run.usage?`输入 ${run.usage.inputTokens} / 输出 ${run.usage.outputTokens} tokens`:'未知'}</p>
          {run.model&&<><p>响应模型：{run.response?.responseModel??'未知'}</p>{run.response&&<p>对应请求序号：{run.response.request}</p>}</>}
          {run.responses.length>0&&<details className="engine-response-usage"><summary>已验证响应明细</summary>
            <p className="engine-pilot-muted">仅列已收到并验证的响应，不代表全部请求或总费用。</p>
            <table><thead><tr><th scope="col">请求</th><th scope="col">响应模型</th><th scope="col">输入 tokens</th><th scope="col">输出 tokens</th></tr></thead>
              <tbody>{run.responses.map(item=><tr key={item.request} data-response-request={item.request}><td>{item.request}</td><td>{item.responseModel??'未知'}</td><td>{item.usage?.inputTokens??'未知'}</td><td>{item.usage?.outputTokens??'未知'}</td></tr>)}</tbody></table>
          </details>}
          <p>工具能力：pilot.sum.v1</p></details>
      </section>:<p className="engine-pilot-empty">输入目标开始，或从左侧查看运行记录。</p>}
    </main></div>
  </section>;
}

export function EnginePilotPanel({api,mode='pilot',historyOnly=false}:{api:EnginePilotApi;mode?:'pilot'|'live';historyOnly?:boolean}){
  const [state,setState]=useState(initialEnginePilotState),controller=useRef<EnginePilotController|null>(null);
  const [settingsOpen,setSettingsOpen]=useState(false),settingsApi=mode==='live'&&typeof window!=='undefined'?window.workbenchModelSettings:undefined;
  useEffect(()=>{const model=createEnginePilotController(api);controller.current=model;
    const off=model.subscribe(()=>setState(model.snapshot()));setState(model.snapshot());void model.load();
    return()=>{off();model.dispose();if(controller.current===model)controller.current=null;};},[api]);
  const actions:Actions={start:async(...args)=>controller.current?.start(...args)??false,answer:async(...args)=>controller.current?.answer(...args)??false,
    stop:async()=>{await controller.current?.stop();},select:async id=>{await controller.current?.select(id);},refresh:async()=>{await controller.current?.refresh();}};
  return <><EnginePilotView state={state} actions={actions} mode={mode} historyOnly={historyOnly} {...(settingsApi&&!historyOnly?{onOpenSettings:()=>setSettingsOpen(true)}:{})}/>
    {settingsOpen&&settingsApi&&<ModelSettingsDialog api={settingsApi} running={false} purpose="tools" onClose={()=>setSettingsOpen(false)} onSaved={()=>void actions.refresh()}/>}</>;
}
