import {useEffect,useRef,useState} from 'react';
import {createProjectReadController,initialProjectReadState} from './project-read-controller';
import {projectReadEvents,projectRunLabels} from './project-read-presentation';
import {TaskCapacityPanel,TaskDeletionPreview} from './TaskCapacityPanel';
import {WslResultsSettings} from './WslResultsView';
import {ChatMarkdown} from './ChatMarkdown';
import {ProjectReadResults} from './ProjectReadResults';
import {chatToolLabels} from './ChatAgentParts';
import {WaveformResultsView} from './WaveformResultsView';
import {WorkCycleFilePreview,WorkCycleChangePreview,WorkCycleFiles} from './WorkCycleResults';
import {createWorkCycleInspectionController,workCycleInspectionPorts,initialWorkCycleInspectionState} from './work-cycle-controller';
import {createCommandExecutionController,commandExecutionPorts,initialCommandExecutionState} from './command-execution-controller';
import {CommandExecutionDetails,CommandEnvironmentResults,type CommandExecutionActions} from './CommandExecutionResults';
import {EnginePilotPanel} from './EnginePilotPanel';
import {commandOriginKey,commandPrimaryFailurePort} from './command-primary-failure';

export type ChatToolsSection='history'|'storage'|'diagnostics';
/** Explicit menu visit only. History has no start, answer, continuation or command launch control. */
export function ChatToolsDialog({section,projectId,onClose}:{section:ChatToolsSection;projectId:string;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),[state,setState]=useState(initialProjectReadState),[work,setWork]=useState(initialWorkCycleInspectionState),[commands,setCommands]=useState(initialCommandExecutionState),[legacy,setLegacy]=useState(false);
 const controller=useRef<ReturnType<typeof createProjectReadController>|null>(null),files=useRef<ReturnType<typeof createWorkCycleInspectionController>|null>(null),command=useRef<ReturnType<typeof createCommandExecutionController>|null>(null);
 const api=window.workbenchAgentProjectRead,run=state.selectedRun,projection=projectReadEvents(state.events);
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 useEffect(()=>{if(!api)return;const model=createProjectReadController(api),fileModel=createWorkCycleInspectionController(workCycleInspectionPorts(api)),commandModel=createCommandExecutionController({...commandExecutionPorts(api),primaryFailure:commandPrimaryFailurePort(window.workbenchSessions)});
  controller.current=model;files.current=fileModel;command.current=commandModel;
  const off=model.subscribe(()=>setState(model.snapshot())),offFiles=fileModel.subscribe(()=>setWork(fileModel.snapshot())),offCommands=commandModel.subscribe(()=>setCommands(commandModel.snapshot()));
  if(projectId)void model.setProject(projectId);else void model.refresh();if(section==='storage')void model.refreshCapacity();
  return()=>{off();offFiles();offCommands();model.dispose();fileModel.dispose();commandModel.dispose();};
 },[api,projectId,section]);
 useEffect(()=>{const scope=run?.workCycle?{runId:run.runId,workspaceId:run.workCycle.workspaceId,...(run.origin?{origin:run.origin}:{})}:null;files.current?.setScope(scope);command.current?.setScope(scope);if(scope){void files.current?.refresh();void command.current?.refreshHistory();}},[run?.runId,run?.workCycle?.workspaceId,commandOriginKey(run?.origin)]);
 useEffect(()=>{if(run?.workCycle)files.current?.register({runId:run.runId,workspaceId:run.workCycle.workspaceId},projection.workValues,state.events.length);},[run?.runId,state.events.length]);
 const actions:CommandExecutionActions={refresh:async(...args)=>command.current?.refresh(...args)??false,stop:async()=>false,readLog:async(...args)=>command.current?.readLog(...args)??false,readDiagnostics:async id=>command.current?.readDiagnostics(id)??false,copyDiagnostics:async id=>command.current?.copyDiagnostics(id)??false,openDiagnostics:async id=>command.current?.openDiagnostics(id)??false,refreshHistory:async()=>command.current?.refreshHistory()??false,inspectEnvironment:async()=>command.current?.inspectEnvironment()??false};
 return <dialog ref={dialog} className="chat-tools-dialog" onCancel={event=>{event.preventDefault();onClose();}} aria-label={section==='history'?'旧工具记录':section==='storage'?'存储用量':'诊断与环境'}>
  <header><h2>{section==='history'?'旧工具记录':section==='storage'?'存储用量':'诊断与环境'}</h2><button type="button" aria-label="关闭工具记录与设置" onClick={onClose}>×</button></header>
  {section==='storage'&&<><TaskCapacityPanel capacity={state.capacity} loading={state.capacityLoading} error={state.capacityError} onRefresh={()=>void controller.current?.refreshCapacity()} onClose={onClose}/><TaskDeletionPreview state={state} actions={{prepareDeletion:async id=>controller.current?.prepareDeletion(id)??false,cancelDeletion:()=>controller.current?.cancelDeletion(),deleteRun:async id=>controller.current?.deleteRun(id)??false,select:async id=>{await controller.current?.select(id);}}}/></>}
  {section==='diagnostics'&&<>
   {state.statusError&&<p role="alert">{state.statusError}</p>}<button type="button" disabled={state.loading} onClick={()=>void controller.current?.refresh()}>刷新状态</button>
   <WslResultsSettings state={state} actions={{refreshWslBinding:async()=>controller.current?.refreshWslBinding()??false,selectWslBinding:async path=>controller.current?.selectWslBinding(path)??false,clearWslBinding:async()=>controller.current?.clearWslBinding()??false}}/>
   <p>选择已有记录可核对其执行环境和保存的日志。</p>
   {run?.workCycle&&<><button type="button" disabled={commands.inspectingEnvironment} onClick={()=>void command.current?.inspectEnvironment()}>核对所选记录的命令环境</button>{commands.environments&&<CommandEnvironmentResults environments={commands.environments}/>} {commands.environmentError&&<p role="alert">{commands.environmentError}</p>}</>}
  </>}
  {!legacy&&<div className="chat-history-layout"><nav aria-label="已保存的工具记录">
   {state.loading&&<p>正在读取…</p>}{!state.loading&&!state.runs.length&&<p>暂无记录</p>}
   {state.runs.map(item=><div key={item.runId}><button type="button" aria-pressed={item.runId===run?.runId} onClick={()=>void controller.current?.select(item.runId)}>{item.goal}<small>{item.project.name} · {projectRunLabels[item.status]}</small></button>{section==='storage'&&<button type="button" disabled={!!state.pending} onClick={()=>void controller.current?.prepareDeletion(item.runId)}>查看删除范围</button>}</div>)}
   {state.nextBefore&&<button type="button" disabled={state.loading} onClick={()=>void controller.current?.older()}>较早记录</button>}
   {window.workbenchEnginePilot&&<button type="button" onClick={()=>setLegacy(true)}>早期计算记录</button>}
  </nav><div className="chat-history-content">
   {state.error&&<p role="alert">{state.error}</p>}{run&&<><h3>{run.goal}</h3><p>{run.project.name} · {projectRunLabels[run.status]}{run.cleanupState!=='idle'?' · 收尾尚未确认':''}</p>
    {run.workCycle&&(work.files.length>0||work.listing||work.listError)&&<section aria-label="已保存成果文件"><button type="button" disabled={work.listing} onClick={()=>void files.current?.refresh()}>核对已保存文件</button>{work.listing?<p role="status">正在核对成果…</p>:work.listError?<p role="status">{work.listError}</p>:<WorkCycleFiles files={work.files} onOpenFile={file=>void files.current?.openFile(file)}/>}</section>}
    {projection.timeline.map(item=><div key={item.key}>{item.kind==='text'?<ChatMarkdown text={item.text}/>:item.kind==='answer'?<><p>{item.prompt}</p><p>{item.answer}</p></>:<details><summary>{chatToolLabels[item.tool.call.toolName]} · {item.tool.result?'已返回':'未确认完成'}</summary>{item.tool.result&&<ProjectReadResults result={item.tool.result} toolName={item.tool.call.toolName} onCitation={id=>void controller.current?.openCitation(id)} onWorkFile={file=>void files.current?.openFile(file)} onWorkChange={id=>void files.current?.openChange(id)} currentFiles={work.files}/>}</details>}</div>)}
    {state.hasMore&&<p role="status">正在读取较早事件…</p>}
    {commands.entries.map(entry=><details key={entry.execution.executionId}><summary>已保存命令与日志</summary><CommandExecutionDetails readOnly entry={entry} actions={actions} files={work.files} onOpenFile={file=>void files.current?.openFile(file)}/></details>)}
    <details><summary>记录与用量详情</summary><p>{run.runId}</p><p>模型：{run.model.model} · 已保存事件：{run.eventCount} · 请求：{run.accounting.httpDispatches} · 工具尝试：{run.accounting.toolAttempts}</p></details>
   </>}
   {(state.citation||state.wslCitation||state.waveformCitation||state.citationLoading||state.citationError)&&<section aria-label="历史引用片段"><button type="button" onClick={()=>controller.current?.closeCitation()}>关闭引用</button>{state.citationLoading&&<p>正在读取…</p>}{state.citationError&&<p role="alert">{state.citationError}</p>}{state.citation&&<><h3>{state.citation.relativePath}</h3><small>版本：{state.citation.version}</small><pre>{state.citation.excerpt}</pre></>}{state.wslCitation&&<pre>{state.wslCitation.text}</pre>}{state.waveformCitation&&<WaveformResultsView value={state.waveformCitation}/>}</section>}
   {(work.preview||work.opening||work.previewError)&&<section aria-label="历史工作文件"><button type="button" onClick={()=>files.current?.closePreview()}>关闭文件</button>{work.opening&&<p>正在读取…</p>}{work.previewError&&<p role="alert">{work.previewError}</p>}{work.preview?.kind==='file'?<WorkCycleFilePreview content={work.preview.content}/>:work.preview?.kind==='change'?<WorkCycleChangePreview change={work.preview.change}/>:null}</section>}
  </div></div>}
  {legacy&&window.workbenchEnginePilot&&<><button type="button" onClick={()=>setLegacy(false)}>返回工具记录</button><EnginePilotPanel api={window.workbenchEnginePilot} mode="live" historyOnly/></>}
 </dialog>;
}
