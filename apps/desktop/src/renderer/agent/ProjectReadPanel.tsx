import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {WorkbenchAgentProjectReadApi,ProjectReadStatus,ProjectReadToolName} from '../../shared/agent/agent-project-read';
import {AGENT_SKILL_TOOL_NAMES} from '../../shared/agent/agent-skills';
import {COMMAND_TOOL_NAMES} from '../../shared/agent/agent-command';
import {CommandExecutionDetails,type CommandExecutionActions} from './CommandExecutionResults';
import {createCommandExecutionController,commandExecutionPorts,initialCommandExecutionState,type CommandExecutionController,type CommandExecutionViewState} from './command-execution-controller';
import type {EnginePilotApi} from '../../shared/agent/engine-pilot';
import {ProjectTaskScope,type ToolProjectChoices} from './ProjectTaskScope';
import {ProjectReadResults,ProjectReadCoverageView} from './ProjectReadResults';
import {ProjectCitationViewer} from './ProjectCitationViewer';
import {ChatMarkdown} from './ChatMarkdown';
import {EnginePilotPanel} from './EnginePilotPanel';
import {ModelSettingsDialog} from './ModelSettingsDialog';
import {createProjectReadController,initialProjectReadState,projectCanStart,type ProjectReadController,type ProjectReadViewState} from './project-read-controller';
import {projectMessageCitations,projectReadError,projectReadEvents,projectRunLabels,projectRunTerminal,projectUsesWslTools} from './project-read-presentation';
import type {WorkCycleFile} from '../../shared/agent/agent-work-cycle';
import {createWorkCycleInspectionController,initialWorkCycleInspectionState,workCycleInspectionPorts,type WorkCycleInspectionController,type WorkCycleInspectionState} from './work-cycle-controller';
import {WorkCycleFiles,WorkCycleFilePreview,WorkCycleChangePreview} from './WorkCycleResults';
import {workExecutionActiveLabel} from './work-cycle-presentation';
import {TaskCapacityPanel,TaskDeletionPreview} from './TaskCapacityPanel';
import {WslResultsSettings,WslSource,WslCitationContext} from './WslResultsView';
import {WaveformResultsView,WaveformCitationContext} from './WaveformResultsView';
import {PROJECT_READ_MODELS} from '../../shared/agent/agent-project-model';
import {modelOption} from '../../shared/agent/model-options';

type Actions=Pick<ProjectReadController,'setProject'|'start'|'answer'|'stop'|'refresh'|'select'|'older'|'openCitation'|'closeCitation'|'continueRun'|'deleteRun'|'revalidate'|'browse'|'checkCitation'|'cancelInspection'>&Partial<Pick<ProjectReadController,'startWork'|'prepareWorkContinuation'|'continueWork'|'cancelWorkContinuation'|'refreshCapacity'|'prepareDeletion'|'cancelDeletion'|'refreshWslBinding'|'selectWslBinding'|'clearWslBinding'|'selectModel'>>;
type WorkActions=Pick<WorkCycleInspectionController,'refresh'|'openFile'|'openChange'|'closePreview'>;
const toolNames={fs_list:'列出目录',fs_find:'查找文件名',fs_search:'搜索内容',fs_read:'读取片段',project_list:'列出目录',project_find:'查找文件名',project_search:'搜索内容',project_read:'读取片段',skill_discover:'发现技能',skill_load:'加载技能',skill_read_reference:'读取技能资料',pilot_sum:'计算求和',work_list:'查看工作文件',work_read:'读取工作文件',work_write:'创建或修改工作文件',work_edit:'局部修改工作文件',work_import:'复制项目资料',work_run:'运行分析',command_environment:'查看命令环境',command_start:'执行命令',command_status:'查询命令状态',command_log:'读取命令日志',command_stop:'请求停止命令',wsl_results_list:'查询 WSL 结果目录',wsl_results_read:'读取 WSL 结果',wsl_waveform_list:'查询 AC 信号',wsl_waveform_read:'读取复数波形',wsl_waveform_metrics:'计算 AC 指标',oa_open_design:'打开电路副本',oa_inspect_design:'查看原理图',oa_query_instances:'查询器件',oa_query_nets:'查询网络',oa_describe_device:'查看器件详情'} as const satisfies Record<ProjectReadToolName,string>;
function availability(status:ProjectReadStatus|null){
  if(!status)return '项目工具能力当前不可用。';
  if(status.reason)return projectReadError(status.reason);
  if(status.availability==='unchecked')return '开始任务时自动核对项目目录。';
  if(status.availability==='not_configured'||status.availability==='unsupported_model')return '请配置所选模型的服务，工具任务支持 Kimi K3 和 DeepSeek V4 Flash。';
  if(status.availability==='not_bound')return projectReadError('NOT_BOUND');
  if(status.availability==='creation_pending')return projectReadError('CREATION_PENDING');
  if(status.availability==='root_changed')return projectReadError('ROOT_CHANGED');
  if(status.availability==='root_unavailable')return projectReadError('ROOT_UNAVAILABLE');
  return status.canStart?'':status.availability==='busy'?projectReadError('BUSY'):'项目工具暂时不可用，请刷新核对。';
}
export function ProjectReadView({state,choices,actions,onCreate,onSettings,onLegacy,workState=initialWorkCycleInspectionState,workActions,commandState=initialCommandExecutionState,commandActions}:{state:ProjectReadViewState;choices:ToolProjectChoices;actions:Actions;onCreate:()=>void;onSettings?:()=>void;onLegacy?:()=>void;workState?:WorkCycleInspectionState;workActions?:WorkActions;commandState?:CommandExecutionViewState;commandActions?:CommandExecutionActions}){
  const [goal,setGoal]=useState(''),[constraint,setConstraint]=useState(''),[answer,setAnswer]=useState(''),[citationOpen,setCitationOpen]=useState(false);
  const [capacityOpen,setCapacityOpen]=useState(false);
  const [workMode,setWorkMode]=useState(false),[workOpen,setWorkOpen]=useState(false);
  const [followupGoal,setFollowupGoal]=useState(''),[followupConstraint,setFollowupConstraint]=useState('');
  const goalInput=useRef<HTMLTextAreaElement|null>(null),draftParent=useRef<string|null>(null);
  const draft=state.workContinuation,formGoal=draft?followupGoal:goal,formConstraint=draft?followupConstraint:constraint,formWork=workMode||!!draft;
  const trigger=useRef<HTMLElement|null>(null),goalId=useId(),answerId=useId();
  const run=state.selectedRun,projection=projectReadEvents(state.events),question=projection.question;
  const readonlyWsl=!!run&&!run.workCycle&&projectUsesWslTools(state.events);
  const currentFiles=workState.scope?.runId===run?.runId&&workState.scope?.workspaceId===run?.workCycle?.workspaceId&&workState.revision===state.events.length?workState.files:[];
  const commandScoped=!!run?.workCycle&&commandState.scope?.runId===run.runId&&commandState.scope.workspaceId===run.workCycle.workspaceId;
  const commandEntries=commandScoped?commandState.entries:[],commandRows=new Map<string,number>();
  for(const item of projection.timeline){if(item.kind!=='tool'||!item.tool.result?.ok)continue;const value=item.tool.result.value;
    if((value.kind==='command_start'||value.kind==='command_status'||value.kind==='command_stop')&&!commandRows.has(value.execution.executionId))commandRows.set(value.execution.executionId,item.key);}
  const commandEntryProps=(key:number)=>{const entry=commandEntries.find(item=>commandRows.get(item.execution.executionId)===key);return entry?{commandEntry:entry}:{};};
  useEffect(()=>{setAnswer('');},[run?.runId,question?.questionId]);
  useEffect(()=>{setCitationOpen(false);setWorkOpen(false);},[run?.runId]);
  useEffect(()=>{if(draft&&draftParent.current!==draft.parent.runId){draftParent.current=draft.parent.runId;setFollowupGoal('');setFollowupConstraint('');}if(draft)goalInput.current?.focus();},[draft?.parent.runId]);
  const cite=(id:string,element:HTMLButtonElement)=>{trigger.current=element;setWorkOpen(false);workActions?.closePreview();setCitationOpen(true);void actions.openCitation(id);};
  const close=()=>{actions.closeCitation();setCitationOpen(false);};
  const openWork=(file:WorkCycleFile,element:HTMLButtonElement)=>{if(!workActions)return;trigger.current=element;close();setWorkOpen(true);void workActions.openFile(file);};
  const openChange=(id:string,_file:WorkCycleFile,element:HTMLButtonElement)=>{if(!workActions)return;trigger.current=element;close();setWorkOpen(true);void workActions.openChange(id);};
  const closeWork=()=>{workActions?.closePreview();setWorkOpen(false);};
  const submit=(event:FormEvent)=>{event.preventDefault();if(projectCanStart(state)&&formGoal.trim())void (draft?actions.continueWork?.(formGoal,formConstraint):workMode?actions.startWork?.(formGoal,formConstraint):actions.start(formGoal,formConstraint));};
  return <section className="engine-pilot-panel project-read-panel" aria-label="项目工具任务" data-project-read="true">
    <header className="engine-pilot-heading"><h1>工具任务</h1><div className="engine-pilot-heading-actions">
      {actions.refreshCapacity&&<button type="button" aria-expanded={capacityOpen} disabled={state.pending==='delete'} onClick={()=>{setCapacityOpen(!capacityOpen);if(!capacityOpen)void actions.refreshCapacity?.();}}>存储用量</button>}
      {onSettings&&<button type="button" onClick={onSettings}>模型设置</button>}<button type="button" disabled={state.loading||!!state.pending} onClick={()=>void actions.refresh()}>刷新记录</button>
    </div></header>
    <div className={`engine-pilot-body project-read-body${citationOpen||workOpen?' project-read-has-citation':''}`}>
      <aside className="engine-pilot-history" aria-label="工具任务记录"><h2>任务记录</h2>
        {!state.runs.length&&state.loading&&<p>正在读取…</p>}
        {state.runs.map(item=><div key={item.runId} className="project-read-history-item" onContextMenu={event=>{if(actions.prepareDeletion){event.preventDefault();void actions.prepareDeletion(item.runId);}}}>
          <button type="button" aria-pressed={item.runId===run?.runId} disabled={!!state.pending} onClick={()=>void actions.select(item.runId)}><span>{item.goal}</span><small>{item.project.name} · {projectRunLabels[item.status]}</small></button>
          {actions.prepareDeletion&&<details><summary aria-label={`管理任务：${item.goal}`}>···</summary><button type="button" disabled={!!state.pending} onClick={()=>void actions.prepareDeletion?.(item.runId)}>查看容量与删除</button></details>}
        </div>)}
        {state.nextBefore&&<button type="button" disabled={state.loading} onClick={()=>void actions.older()}>较早任务记录</button>}
        {onLegacy&&<button type="button" className="project-read-legacy-link" onClick={onLegacy}>早期计算任务记录</button>}
      </aside>
      <main className="engine-pilot-main">
        {capacityOpen&&<TaskCapacityPanel capacity={state.capacity} loading={state.capacityLoading} error={state.capacityError} onRefresh={()=>void actions.refreshCapacity?.()} onClose={()=>setCapacityOpen(false)}/>}
        {actions.prepareDeletion&&actions.cancelDeletion&&<TaskDeletionPreview state={state} actions={{prepareDeletion:actions.prepareDeletion,cancelDeletion:actions.cancelDeletion,deleteRun:actions.deleteRun,select:actions.select}}/>}
        <ProjectTaskScope choices={choices} selectedId={state.projectId} onSelect={id=>void actions.setProject(id)} onCreate={onCreate} createLabel={state.status?.availability==='creation_pending'?'核对项目创建':'新建项目'} disabled={!!state.pending||state.startUnconfirmed||!!draft}>
          {state.status?.project&&<p data-next-project={state.status.project.projectId}>{state.status.project.directorySegments.join(' > ')||state.status.project.directoryName}</p>}
          {actions.selectModel?<label>下次任务模型<select aria-label="下次任务模型" value={state.status?.model?.model??''} disabled={!state.status||state.modelSelecting||!!state.pending||state.startUnconfirmed}
            onChange={event=>{const model=PROJECT_READ_MODELS.find(item=>item.model===event.target.value);if(model)void actions.selectModel?.(model);}}>
            {!state.status?.model&&<option value="" disabled>尚未确定</option>}{PROJECT_READ_MODELS.map(model=><option key={model.model} value={model.model}>{modelOption(model.provider,model.model).label}</option>)}
          </select></label>:<p>下次任务模型：{state.status?.model?modelOption(state.status.model.provider,state.status.model.model).label:'尚未确定'}</p>}
          {state.modelSelecting&&<p role="status">正在保存模型选择…</p>}{state.modelSelectionError&&<p role="alert">{state.modelSelectionError}</p>}
          {actions.refreshWslBinding&&actions.selectWslBinding&&actions.clearWslBinding&&<WslResultsSettings state={state} actions={{refreshWslBinding:actions.refreshWslBinding,selectWslBinding:actions.selectWslBinding,clearWslBinding:actions.clearWslBinding}}/>}
          <div className="project-read-scope-actions"><button type="button" disabled={!state.status?.project||state.inspecting||!!state.pending} onClick={()=>void actions.browse()}>查看目录</button>
            {['root_unavailable','root_changed','unavailable'].includes(state.status?.availability??'')&&<button type="button" disabled={!state.status?.project||state.inspecting||!!state.pending} onClick={()=>void actions.revalidate()}>核对原目录</button>}</div>
        </ProjectTaskScope>
        <form className="engine-pilot-goal" onSubmit={submit}>
          {actions.startWork&&<fieldset className="work-cycle-mode" disabled={!!state.pending||state.startUnconfirmed||!!draft}><legend>任务范围</legend>
            <label><input type="radio" name={`${goalId}-mode`} checked={!formWork} onChange={()=>setWorkMode(false)}/>只读资料</label>
            <label><input type="radio" name={`${goalId}-mode`} checked={formWork} onChange={()=>setWorkMode(true)}/>创建文件与分析</label>
          </fieldset>}
          {formWork&&<p className="engine-pilot-muted">可读取本项目资料，在独立任务工作区创建文件并运行分析。原项目文件保持只读。</p>}
          {draft&&<div className="project-read-continuation" role="group" aria-label="后续工作草稿"><p>继续工作：{draft.parent.goal}</p>
            <p className="engine-pilot-muted">继承上次保存的工作文件，不会自动同步项目目录。填写本次后续目标并提交后，才开始新任务。</p>
            <p role="status">{state.pending==='continue'?'正在核对原任务记录、文件与执行收尾…':draft.preview?`已核对 ${draft.preview.fileCount} 个文件，共 ${draft.preview.bytes} 字节。`:'核定依据与文件基线尚未确认，后续要求仍保留。'}</p>
            {draft.preview?.baseline.recovery&&<div role="status"><p>已核定控制进程收尾及 {draft.preview.baseline.recovery.commands.length} 次命令记录，仅承接已确认文件。</p>
              <p>原任务仍为{projectRunLabels[draft.parent.status]}，原记录和日志保留。填写本次目标后显式开始新任务，不会自动重跑旧命令。</p>
              {!state.pending&&!projectCanStart(state)&&<p>核对已通过，当前任务启动条件尚未满足，请核对上方可用状态。</p>}
            </div>}
            <button type="button" disabled={!!state.pending||state.modelSelecting||state.loading||state.startUnconfirmed} onClick={()=>void actions.prepareWorkContinuation?.(draft.parent.runId)}>重新核对</button>
            <button type="button" disabled={!!state.pending} onClick={()=>void actions.select(draft.parent.runId)}>查看原任务</button>
            <button type="button" disabled={!!state.pending||state.startUnconfirmed} onClick={()=>{actions.cancelWorkContinuation?.();}}>返回普通新建（不继承文件）</button>
          </div>}
          <label htmlFor={goalId}>{draft?'本次后续目标':'任务目标'}</label><textarea ref={goalInput} id={goalId} value={formGoal} rows={2} disabled={state.pending==='start'||state.startUnconfirmed} onChange={event=>(draft?setFollowupGoal:setGoal)(event.target.value)} placeholder={draft?'例如：沿用已有分析，将倍率改为 3 并更新报告。':formWork?'例如：读取项目中的 CSV，分析数据并生成结果报告。':'例如：找到项目里有关采样时钟的说明，比较配置并引用依据。'}/>
          <details><summary>补充要求</summary><textarea aria-label="补充要求" value={formConstraint} rows={2} disabled={state.pending==='start'||state.startUnconfirmed} onChange={event=>(draft?setFollowupConstraint:setConstraint)(event.target.value)}/></details>
          <button type="submit" disabled={!projectCanStart(state)||!formGoal.trim()||!!draft&&!draft.preview}>{state.pending==='start'?'正在开始…':state.startUnconfirmed?'核对并重试原任务':draft?'开始后续工作':'开始任务'}</button>
          <p className="engine-pilot-muted">已提交任务会保存。未提交的输入仅在本次窗口保留。</p>
        </form>
        {state.statusError&&<p role="alert">{state.statusError}</p>}{availability(state.status)&&<p className="engine-pilot-muted" role="status">{state.loading?'正在读取状态…':availability(state.status)}</p>}
        {state.error&&<p role="alert" className="engine-pilot-error">{state.error}</p>}
        {state.wslBindingError&&<p role="alert">{state.wslBindingError} 请在上方“实验 WSL 结果”中核对保存状态。</p>}
        {state.inspectionError&&<p role="alert">{state.inspectionError}</p>}
        {(state.inspection||state.inspecting||state.inspectionError)&&<section className="project-read-inspection" aria-label="独立资料核验"><header><strong>{state.inspection?'目录浏览':'资料核验'}</strong><button type="button" onClick={()=>void actions.cancelInspection()}>{state.inspecting?'取消核验':'关闭浏览'}</button></header>
          {state.inspecting&&<p role="status">正在核对资料…</p>}
          {state.inspection&&<><p>{state.inspection.project.name} · {state.inspection.relativeDirectory||'项目根目录'} · 第 {state.inspection.page} 页 · 已显示 {state.inspection.returnedTotal} 项</p>
            <p className="engine-pilot-muted">目录元数据浏览；这些页面不代表模型已读取文件内容。</p>
            <ul>{state.inspection.value.entries.map(entry=><li key={entry.relativePath}>{entry.kind==='directory'?<button type="button" disabled={state.inspecting} onClick={()=>void actions.browse(entry.directoryId,entry.relativePath)}>{entry.name} /</button>:<span>{entry.name} · {entry.bytes} 字节</span>}</li>)}</ul>
            <ProjectReadCoverageView coverage={state.inspection.value.coverage}/><div className="project-read-inspection-actions"><button type="button" disabled={state.inspecting} onClick={()=>void actions.browse()}>返回项目根目录</button>
              {state.inspection.value.coverage.nextCursor&&<button type="button" disabled={state.inspecting} onClick={()=>void actions.browse(null,'',true)}>下一页目录</button>}</div>
          </>}
        </section>}
        {state.status?.activeTask&&state.status.activeTask.runId!==run?.runId&&<p>当前占用：{state.status.activeTask.project?.name??'计算任务'} · {projectRunLabels[state.status.activeTask.status]}。
          {state.status.activeTask.mode==='project_read'?<button type="button" onClick={()=>void actions.select(state.status!.activeTask!.runId)}>查看运行任务</button>:onLegacy&&<button type="button" onClick={onLegacy}>查看计算任务</button>}</p>}
        {run&&<section className="engine-pilot-run" aria-label="当前项目任务" data-run-id={run.runId} data-run-state={run.status}>
          <div className="engine-pilot-current"><div role="status"><strong>{projectRunLabels[run.status]}</strong><p>{state.stopAccepted&&!projectRunTerminal(run.status)?'停止请求已接受，等待任务停止和资源释放。':projection.action}</p>
            {run.cleanupState!=='idle'&&<p>{run.cleanupState==='pending'?'正在释放执行资源。':'执行资源释放尚未确认。'}</p>}</div>
            <button type="button" disabled={!!state.pending||projectRunTerminal(run.status)||state.stopAccepted} onClick={()=>void actions.stop()}>停止</button></div>
          <h2>{run.goal}</h2><p className="engine-pilot-muted" data-run-project={run.project.projectId}>本次项目：{run.project.name} · {run.project.directorySegments.join(' > ')||run.project.directoryName}</p>
          <p className="engine-pilot-muted">本次模型：{modelOption(run.model.provider,run.model.model).label}</p>
          {run.wslResultsBinding&&<WslSource binding={run.wslResultsBinding} label="本任务的 WSL 来源"/>}
          {run.workCycle?.continuation&&<p className="engine-pilot-muted">继续自：<button type="button" disabled={!!state.pending} onClick={()=>void actions.select(run.workCycle!.continuation!.runId)}>{state.runs.find(item=>item.runId===run.workCycle!.continuation!.runId)?.goal??'查看原任务'}</button> · 原任务及其文件、差异记录仍可查看。</p>}
          {run.workCycle&&workActions&&(currentFiles.length>0||workState.listing||workState.listError)&&<section className="work-cycle-inventory" aria-label="任务工作文件"><header><strong>工作文件</strong><button type="button" disabled={workState.listing} onClick={()=>void workActions.refresh()}>核对文件</button></header>
            <p className="engine-pilot-muted">文件保存在本次任务工作区。点击文件名查看正文，展开写入记录查看差异。</p>
            {workState.listing?<p role="status">正在核对工作文件…</p>:workState.listError?<p role="alert">{workState.listError}</p>:<WorkCycleFiles files={currentFiles} onOpenFile={openWork}/>}
          </section>}
          {run.continuation&&<p className="engine-pilot-muted">从已保存任务接续：继承 {run.continuation.evidenceCount} 份依据、{run.continuation.confirmedQuestions} 个已确认回答；恢复 {run.continuation.resumedFilePositions} 处读取位置，重新查询 {run.continuation.restartedQueries} 项。</p>}
          {run.constraint&&<details><summary>本次补充要求</summary><p className="engine-pilot-text">{run.constraint}</p></details>}
          <ol className="engine-task-timeline" aria-label="任务过程">{projection.timeline.map(item=><li key={item.key} className={`engine-task-${item.kind}`} data-message-event={item.key}>
            {item.kind==='text'?<><ChatMarkdown text={item.text}/>{projectMessageCitations(item.text,projection.citations).map(citation=><button type="button" key={citation.citationId} onClick={event=>cite(citation.citationId,event.currentTarget)}>查看依据：{citation.relativePath} · 第 {citation.range.start.line} 行</button>)}{projectMessageCitations(item.text,projection.wslCitations).map(citation=><button type="button" key={citation.citationId} onClick={event=>cite(citation.citationId,event.currentTarget)}>查看 WSL 依据：{citation.source.relativePath} · 第 {citation.startLine} 行</button>)}{projectMessageCitations(item.text,projection.waveformCitations).map(citation=><button type="button" key={citation.citationId} onClick={event=>cite(citation.citationId,event.currentTarget)}>查看{citation.kind==='wsl_waveform_read'?'波形':'计算'}依据：{citation.source.files[0]?.relativePath}</button>)}</>:
              item.kind==='tool'?<details><summary>{toolNames[item.tool.call.toolName]} · {item.tool.result?'已返回':projectRunTerminal(run.status)?'未确认完成':'进行中'}</summary>
                {item.tool.result?<ProjectReadResults result={item.tool.result} toolName={item.tool.call.toolName} runId={run.runId} call={item.tool.call} onCitation={cite} {...(run.workCycle&&workActions?{onWorkFile:openWork,onWorkChange:openChange,currentFiles}:{})}
                  {...(commandScoped&&commandActions?{commandState,commandActions}:{})}
                  {...commandEntryProps(item.key)}/>:<p>{item.tool.call.toolName==='work_run'?workExecutionActiveLabel(state.stopAccepted,projectRunTerminal(run.status)):item.tool.call.toolName==='command_start'?'正在确认命令启动，尚未收到已确认执行身份。':'尚无已确认结果。'}</p>}
                {!AGENT_SKILL_TOOL_NAMES.some(name=>name===item.tool.call.toolName)&&!COMMAND_TOOL_NAMES.some(name=>name===item.tool.call.toolName)&&<details><summary>调用参数</summary><pre>{JSON.stringify(item.tool.call.arguments,null,2)}</pre></details>}</details>:
              <><p>{item.prompt}</p><p><strong>你的回答：</strong>{item.answer}</p><small>{item.delivered?'交付已确认':'已记录，交付尚未确认'}</small></>}
          </li>)}{commandActions&&commandEntries.filter(entry=>!commandRows.has(entry.execution.executionId)).map(entry=><li key={entry.execution.executionId} className="engine-task-tool"><details><summary>已保存的命令执行</summary><CommandExecutionDetails entry={entry} actions={commandActions} files={currentFiles} {...(workActions?{onOpenFile:openWork}:{})}/></details></li>)}</ol>
          {commandScoped&&commandState.error&&<p role="alert">{commandState.error}</p>}
          {question&&!question.delivered&&!projectRunTerminal(run.status)&&<form className="engine-pilot-question" onSubmit={event=>{event.preventDefault();if(answer.trim())void actions.answer(question.questionId,answer);}}>
            <label htmlFor={answerId}>{question.prompt}</label><textarea id={answerId} value={answer} rows={2} onChange={event=>setAnswer(event.target.value)} disabled={!!state.pending||state.hasMore||question.answered||state.answerUnconfirmed||state.answerSubmitted===question.questionId}/>
            <button type="submit" disabled={!answer.trim()||!!state.pending||state.hasMore||question.answered||state.answerUnconfirmed||state.answerSubmitted===question.questionId}>{state.hasMore?'正在核对后续记录':question.answered?'回答已记录':state.answerUnconfirmed?'提交未确认':state.answerSubmitted===question.questionId?'回答已提交':'提交回答'}</button></form>}
          {state.hasMore&&<p role="status">正在读取更多已保存事件…</p>}
          {projection.citations.size>0&&<details><summary>已读取依据（{projection.citations.size}）</summary><ul>{[...projection.citations.values()].map(citation=><li key={citation.citationId}><button type="button" onClick={event=>cite(citation.citationId,event.currentTarget)}>{citation.relativePath} · 第 {citation.range.start.line} 行</button></li>)}</ul></details>}
          {projection.wslCitations.size>0&&<details><summary>已读取 WSL 依据（{projection.wslCitations.size}）</summary><ul>{[...projection.wslCitations.values()].map(citation=><li key={citation.citationId}><button type="button" onClick={event=>cite(citation.citationId,event.currentTarget)}>{citation.source.relativePath} · 第 {citation.startLine} 行</button></li>)}</ul></details>}
          {projection.waveformCitations.size>0&&<details><summary>波形与计算依据（{projection.waveformCitations.size}）</summary><ul>{[...projection.waveformCitations.values()].map(citation=><li key={citation.citationId}><button type="button" onClick={event=>cite(citation.citationId,event.currentTarget)}>{citation.source.files[0]?.relativePath} · {citation.kind==='wsl_waveform_read'?citation.trace.signalName:'AC 指标'}</button></li>)}</ul></details>}
          {(projection.rules.length>0||projection.ruleChunks.length>0)&&<details><summary>本次规则来源</summary><p className="engine-pilot-muted">优先顺序：产品访问边界、本次任务要求、较近目录的适用规则、上级与根目录规则。普通资料正文不作为规则。</p>{projection.rules.map((rule,index)=><div key={index}><p>{rule.source} · {rule.state==='loaded'?'已加载':'不存在'} · {rule.relativeDirectory||'项目根目录'}</p>{rule.version&&<small>版本：{rule.version}</small>}{rule.text&&<pre>{rule.text}</pre>}</div>)}
            {projection.ruleChunks.map((rule,index)=><div key={`chunk-${index}`}><p>{rule.source} · {rule.relativeDirectory||'项目根目录'} · 已收到字节片段 {rule.offsetBytes}–{rule.endBytes} / {rule.totalBytes}</p><small>版本：{rule.version}</small><pre>{rule.text}</pre></div>)}</details>}
          {projectRunTerminal(run.status)&&run.cleanupState==='idle'&&!run.workCycle&&!readonlyWsl&&<div className="project-read-continuation"><p className="engine-pilot-muted">后续任务会重新核对原项目、文件版本与规则，再继承可用的已确认记录。</p><button type="button" disabled={!!state.pending||state.modelSelecting||state.loading||state.inspecting} onClick={()=>void actions.continueRun()}>开始后续任务</button></div>}
          {projectRunTerminal(run.status)&&readonlyWsl&&<p className="engine-pilot-muted">该任务使用了 WSL 结果，请新建任务重新读取当前来源。</p>}
          {projectRunTerminal(run.status)&&run.workCycle&&<div className="project-read-continuation"><p className="engine-pilot-muted">{run.status==='interrupted'||run.cleanupState!=='idle'?'原任务保留中断或收尾未确认记录。先核对已保存成果与执行收尾；依据不足时暂不能继续，文件和日志仍可查看。':'本次任务已结束，工作文件与日志仍可查看。继续工作会先核对已保存文件，再由你填写后续目标。'}</p>
            {actions.prepareWorkContinuation&&<button type="button" disabled={!!state.pending||state.modelSelecting||state.loading||state.reading||state.hasMore||state.startUnconfirmed||!!draft} onClick={()=>void actions.prepareWorkContinuation?.(run.runId)}>{run.status==='interrupted'||run.cleanupState!=='idle'?'核对后继续':'继续工作'}</button>}
          </div>}
          {projectRunTerminal(run.status)&&run.cleanupState==='failed'&&!run.workCycle&&<p className="engine-pilot-muted">本条记录的资源释放未确认，可查看或申请删除；仍被占用时会拒绝删除。本条记录不能接续。若当前窗口仍提示资源未释放，请重新打开软件，再在上方“任务目标”输入要求并点击“开始任务”重新读取。历史容量已满时，可先删除不再需要的已结束记录。</p>}
          <details className="engine-pilot-diagnostics"><summary>任务与用量详情</summary><p>任务：{run.runId}</p><p>已读取 {state.events.length} / {run.eventCount} 个事件</p>
            <p>实际请求 {run.accounting.httpDispatches} 次 · 工具尝试 {run.accounting.toolAttempts} 次 · 物理读取 {run.accounting.physicalReadBytes} 字节</p>
            <p>上下文大小：{run.accounting.contextBytes??'未知'}{run.accounting.contextBytes!==null?' 字节':''}</p>
            <div className="engine-response-usage"><p>仅列已收到并验证的响应，不代表全部请求或总费用。</p><table><thead><tr><th>请求</th><th>响应模型</th><th>输入 tokens</th><th>输出 tokens</th></tr></thead><tbody>{projection.responses.map(response=><tr key={response.request}><td>{response.request}</td><td>{response.responseModel??'未知'}</td><td>{response.usage?.inputTokens??'未知'}</td><td>{response.usage?.outputTokens??'未知'}</td></tr>)}</tbody></table></div>
          </details>
        </section>}
      </main>
      {citationOpen&&<ProjectCitationViewer title={state.waveformCitation?.source.files[0]?.relativePath??state.wslCitation?.source.relativePath??state.citation?.relativePath??'引用片段'} onClose={close} restoreFocus={trigger.current} context={state.waveformCitation?<WaveformCitationContext state={state} onCheck={()=>void actions.checkCitation()}/>:state.wslCitation?<WslCitationContext value={state.wslCitation} state={state} onCheck={()=>void actions.checkCitation()}/>:state.citation?<>
        <p>任务时版本 · {state.citation.project.name} · {state.citation.project.directorySegments.join(' > ')||state.citation.project.directoryName}</p>
        <p>第 {state.citation.range.start.line} 行，第 {state.citation.range.start.column} 列 — 第 {state.citation.range.end.line} 行，第 {state.citation.range.end.column} 列（终点不含）</p>
        <p>文件版本：{state.citation.version}</p><p>此处显示任务时保存的片段。</p>{state.citation.origin&&<p>继承自任务：{state.citation.origin.runId}</p>}
        <button type="button" disabled={state.inspecting||!!state.pending} onClick={()=>void actions.checkCitation()}>核对当前文件版本</button>
        {state.citationCheck?<p role="status">{state.citationCheck.state==='current'?'核对时文件版本一致。':state.citationCheck.state==='changed'?'文件已变化，继续显示任务时片段。':'当前文件无法核对，保留任务时片段。'}</p>:<p>尚未核对当前文件。</p>}</>:<p>正在解析本次任务保存的引用。</p>}>
        {state.citationLoading&&<p role="status">正在读取已保存片段…</p>}{state.citationError&&<p role="alert">{state.citationError}</p>}{state.citation&&<pre>{state.citation.excerpt}</pre>}
        {state.wslCitation&&<pre>{state.wslCitation.text}</pre>}
        {state.waveformCitation&&<WaveformResultsView value={state.waveformCitation}/>}
      </ProjectCitationViewer>}
      {workOpen&&<ProjectCitationViewer title={workState.preview?.kind==='file'?workState.preview.content.file.relativePath:workState.preview?.kind==='change'?workState.preview.change.file.relativePath:'工作文件'} onClose={closeWork} restoreFocus={trigger.current} closeLabel="关闭工作文件" contentLabel="工作文件预览" context={<p>独立任务工作区 · 显示最近一次成功读取的版本；核对失败时保留先前预览。</p>}>
        {workState.opening&&<p role="status">正在读取并核对文件…</p>}{workState.previewError&&<p role="alert">{workState.previewError}</p>}
        {workState.preview?.kind==='file'?<WorkCycleFilePreview content={workState.preview.content}/>:workState.preview?.kind==='change'?<WorkCycleChangePreview change={workState.preview.change}/>:null}
      </ProjectCitationViewer>}
    </div>
  </section>;
}
export function ProjectReadPanel({api,legacyApi,choices,onCreate}:{api?:WorkbenchAgentProjectReadApi|undefined;legacyApi?:EnginePilotApi|undefined;choices:ToolProjectChoices;onCreate:()=>void}){
  const [state,setState]=useState(initialProjectReadState),controller=useRef<ProjectReadController|null>(null),currentChoices=useRef(choices);
  const [workState,setWorkState]=useState(initialWorkCycleInspectionState),workController=useRef<WorkCycleInspectionController|null>(null);
  const [commandState,setCommandState]=useState(initialCommandExecutionState),commandController=useRef<CommandExecutionController|null>(null);
  const commandArtifactRevision=JSON.stringify(commandState.entries.filter(entry=>entry.execution.artifacts.length>0).map(({execution})=>[execution.executionId,execution.phase,execution.changes.manifestVersion,execution.artifacts]));
  const [legacy,setLegacy]=useState(false),[legacyVisited,setLegacyVisited]=useState(false),[settings,setSettings]=useState(false);currentChoices.current=choices;
  const settingsApi=typeof window==='undefined'?undefined:window.workbenchModelSettings;
  useEffect(()=>{if(!api){setState({...initialProjectReadState,projectId:currentChoices.current.activeId,statusError:'项目工具能力尚未接通，当前不能开始项目任务。'});return;}
    const model=createProjectReadController(api);controller.current=model;const off=model.subscribe(()=>setState(model.snapshot()));
    if(currentChoices.current.activeId)void model.setProject(currentChoices.current.activeId);else void model.refresh();
    return()=>{off();model.dispose();if(controller.current===model)controller.current=null;};},[api]);
  useEffect(()=>{if(controller.current)void controller.current.setProject(choices.activeId);},[choices.activeId]);
  useEffect(()=>{if(!api)return;const model=createWorkCycleInspectionController(workCycleInspectionPorts(api));workController.current=model;
    const off=model.subscribe(()=>setWorkState(model.snapshot()));return()=>{off();model.dispose();if(workController.current===model)workController.current=null;};},[api]);
  useEffect(()=>{const model=workController.current,run=state.selectedRun;if(!model)return;
    const scope=run?.workCycle?{runId:run.runId,workspaceId:run.workCycle.workspaceId}:null;model.setScope(scope);
    if(scope){model.register(scope,projectReadEvents(state.events).workValues,state.events.length);void model.refresh();}
  },[api,state.selectedRun?.runId,state.selectedRun?.workCycle?.workspaceId,state.selectedRun?.status,state.selectedRun?.cleanupState,state.events.length]);
  useEffect(()=>{if(!api)return;const model=createCommandExecutionController(commandExecutionPorts(api));commandController.current=model;
    const off=model.subscribe(()=>setCommandState(model.snapshot()));return()=>{off();model.dispose();if(commandController.current===model)commandController.current=null;};},[api]);
  useEffect(()=>{const model=commandController.current,run=state.selectedRun;if(!model)return;
    model.setScope(run?.workCycle?{runId:run.runId,workspaceId:run.workCycle.workspaceId}:null);model.watch(!legacy);
    if(run?.workCycle&&!legacy)void model.refreshHistory();
  },[api,state.selectedRun?.runId,state.selectedRun?.workCycle?.workspaceId,legacy]);
  useEffect(()=>{const model=commandController.current,run=state.selectedRun;if(!model||!run?.workCycle||model.snapshot().scope?.runId!==run.runId)return;
    model.register(projectReadEvents(state.events).commandValues.flatMap(value=>value.kind==='command_start'||value.kind==='command_status'||value.kind==='command_stop'?[value.execution]:[]));
  },[api,state.selectedRun?.runId,state.selectedRun?.workCycle?.workspaceId,state.events.length]);
  useEffect(()=>{const model=workController.current,run=state.selectedRun;if(!model||!run?.workCycle||commandState.scope?.runId!==run.runId||commandState.scope.workspaceId!==run.workCycle.workspaceId||model.snapshot().scope?.runId!==run.runId||commandArtifactRevision==='[]')return;
    void model.refresh();
  },[api,state.selectedRun?.runId,state.selectedRun?.workCycle?.workspaceId,commandState.scope?.runId,commandArtifactRevision]);
  const actions:Actions={setProject:async id=>{await controller.current?.setProject(id);},start:async(...args)=>controller.current?.start(...args)??false,answer:async(...args)=>controller.current?.answer(...args)??false,
    stop:async()=>{await controller.current?.stop();},refresh:async()=>{await controller.current?.refresh();await Promise.all([workController.current?.refresh(),commandController.current?.refreshHistory()]);},select:async id=>{await controller.current?.select(id);},older:async()=>{await controller.current?.older();},openCitation:async id=>{await controller.current?.openCitation(id);},closeCitation:()=>controller.current?.closeCitation(),
    startWork:async(...args)=>controller.current?.startWork(...args)??false,selectModel:async model=>controller.current?.selectModel(model)??false,
    refreshCapacity:async()=>controller.current?.refreshCapacity()??null,prepareDeletion:async id=>controller.current?.prepareDeletion(id)??false,cancelDeletion:()=>controller.current?.cancelDeletion(),
    refreshWslBinding:async()=>controller.current?.refreshWslBinding()??false,selectWslBinding:async path=>controller.current?.selectWslBinding(path)??false,clearWslBinding:async()=>controller.current?.clearWslBinding()??false,
    prepareWorkContinuation:async runId=>controller.current?.prepareWorkContinuation(runId)??false,continueWork:async(...args)=>controller.current?.continueWork(...args)??false,cancelWorkContinuation:()=>controller.current?.cancelWorkContinuation()??false,
    continueRun:async()=>controller.current?.continueRun()??false,deleteRun:async id=>controller.current?.deleteRun(id)??false,revalidate:async()=>{await controller.current?.revalidate();},browse:async(...args)=>{await controller.current?.browse(...args);},checkCitation:async()=>{await controller.current?.checkCitation();},cancelInspection:async()=>controller.current?.cancelInspection()??false};
  const workActions:WorkActions={refresh:async()=>{await workController.current?.refresh();},openFile:async file=>workController.current?.openFile(file)??false,openChange:async id=>workController.current?.openChange(id)??false,closePreview:()=>workController.current?.closePreview()};
  const commandActions:CommandExecutionActions={refresh:async(...args)=>commandController.current?.refresh(...args)??false,stop:async id=>commandController.current?.stop(id)??false,
    readLog:async(...args)=>commandController.current?.readLog(...args)??false,readDiagnostics:async id=>commandController.current?.readDiagnostics(id)??false,copyDiagnostics:async id=>commandController.current?.copyDiagnostics(id)??false,openDiagnostics:async id=>commandController.current?.openDiagnostics(id)??false,refreshHistory:async()=>commandController.current?.refreshHistory()??false,inspectEnvironment:async()=>commandController.current?.inspectEnvironment()??false};
  return <div className="project-read-workspace">
    <div className="project-read-current-view" data-workspace-view="project-tools" hidden={legacy} inert={legacy}><ProjectReadView state={state} choices={choices} actions={actions} onCreate={onCreate} workState={workState} workActions={workActions} commandState={commandState} commandActions={commandActions}
      {...(settingsApi?{onSettings:()=>setSettings(true)}:{})} {...(legacyApi?{onLegacy:()=>{setLegacyVisited(true);setLegacy(true);}}:{})}/></div>
    {legacyVisited&&legacyApi&&<div className="project-read-legacy-view" data-workspace-view="calculation-history" hidden={!legacy} inert={!legacy}><button type="button" onClick={()=>{setLegacy(false);void actions.refresh();}}>返回项目任务</button><EnginePilotPanel api={legacyApi} mode="live" historyOnly/></div>}
    {settings&&settingsApi&&<ModelSettingsDialog api={settingsApi} running={false} purpose="tools" initialProvider={state.status?.model?.provider??'kimi'} onClose={()=>setSettings(false)} onSaved={()=>void actions.refresh()}/>} 
  </div>;
}
