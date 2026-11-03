import {useEffect,useMemo,useRef,useState} from 'react';
import type {ChatTurnActivity} from '../../shared/agent/chat-turns';
import type {WorkbenchAgentProjectReadApi} from '../../shared/agent/agent-project-read';
import type {WorkCycleFile} from '../../shared/agent/agent-work-cycle';
import {ChatSearch} from './ChatSearch';
import {chatActivityProjection,chatToolLabels,type ChatResultTarget} from './ChatAgentParts';
import {ProjectReadResults} from './ProjectReadResults';
import {projectCitationPath} from './project-read-presentation';
import {WorkCycleFiles,WorkCycleFilePreview,WorkCycleChangePreview} from './WorkCycleResults';
import {WaveformResultsView} from './WaveformResultsView';
import {createWorkCycleInspectionController,workCycleInspectionPorts,initialWorkCycleInspectionState} from './work-cycle-controller';
import {createCommandExecutionController,commandExecutionPorts,initialCommandExecutionState} from './command-execution-controller';
import {CommandExecutionDetails,type CommandExecutionActions} from './CommandExecutionResults';
import {commandOriginKey} from './command-primary-failure';
import type {SchematicReference} from '../../shared/schematic/reviewed-schematic';

export type ChatResultRequest={sessionId:string;turnId:string;executionId:string;runId:string;workspaceId:string|null;activity:ChatTurnActivity;target:ChatResultTarget};
export function chatResultIdentity(request:ChatResultRequest){return JSON.stringify([request.sessionId,request.turnId,request.executionId,request.runId,request.workspaceId]);}
/** Uses saved event/citation identities and the existing version-checked file/log readers. */
export function ChatAgentResults({request,activity,api,active=true,onSchematic}:{request:ChatResultRequest;activity:ChatTurnActivity;api:WorkbenchAgentProjectReadApi|undefined;active?:boolean;onSchematic?:(reference:SchematicReference)=>void}){
 const root=useRef<HTMLDivElement>(null),projection=useMemo(()=>chatActivityProjection(activity),[activity]);
 const [citationId,setCitationId]=useState(request.target.kind==='citation'?request.target.citationId:''),[previewOpen,setPreviewOpen]=useState(false);
 const [work,setWork]=useState(initialWorkCycleInspectionState),[commands,setCommands]=useState(initialCommandExecutionState);
 const workController=useRef<ReturnType<typeof createWorkCycleInspectionController>|null>(null),commandController=useRef<ReturnType<typeof createCommandExecutionController>|null>(null);
 const currentActivity=useRef(activity);currentActivity.current=activity;
 useEffect(()=>{setCitationId(request.target.kind==='citation'?request.target.citationId:'');setPreviewOpen(false);},[request]);
 useEffect(()=>{
  if(!api||!request.workspaceId)return;const scope={runId:request.runId,workspaceId:request.workspaceId,...(activity.run?.origin?{origin:activity.run.origin}:{})};
  const files=createWorkCycleInspectionController(workCycleInspectionPorts(api)),command=createCommandExecutionController({...commandExecutionPorts(api),primaryFailure:async()=>currentActivity.current});
  workController.current=files;commandController.current=command;
  const offFiles=files.subscribe(()=>setWork(files.snapshot())),offCommand=command.subscribe(()=>setCommands(command.snapshot()));
  files.setScope(scope);files.register(scope,projection.workValues,activity.nextSequence);void files.refresh();
  command.setScope(scope);command.watch(active);void command.refreshHistory();
  return()=>{offFiles();offCommand();files.dispose();command.dispose();workController.current=null;commandController.current=null;};
 },[api,request.runId,request.workspaceId,request.sessionId,request.turnId,request.executionId,commandOriginKey(activity.run?.origin)]);
 useEffect(()=>{commandController.current?.watch(active);},[active]);
 useEffect(()=>{
  if(!request.workspaceId)return;workController.current?.register({runId:request.runId,workspaceId:request.workspaceId},projection.workValues,activity.nextSequence);
  commandController.current?.register(projection.commandValues.flatMap(value=>value.kind==='command_start'||value.kind==='command_status'||value.kind==='command_stop'?[value.execution]:[]));
 },[activity.nextSequence]);
 const artifactRevision=JSON.stringify(commands.entries.map(({execution})=>[execution.executionId,execution.phase,execution.changes.manifestVersion,execution.artifacts]));
 useEffect(()=>{if(commands.entries.some(entry=>entry.execution.artifacts.length))void workController.current?.refresh();},[artifactRevision]);
 const scoped=activity.sessionId===request.sessionId&&activity.turnId===request.turnId&&activity.execution?.executionId===request.executionId&&activity.execution.runLink?.runId===request.runId&&(activity.execution.runLink.workspaceId??null)===request.workspaceId;
 const openFile=(file:WorkCycleFile)=>{setCitationId('');setPreviewOpen(true);void workController.current?.openFile(file);};
 const openChange=(changeId:string)=>{setCitationId('');setPreviewOpen(true);void workController.current?.openChange(changeId);};
 const cite=(citationId:string)=>{setPreviewOpen(false);setCitationId(citationId);};
 const actions:CommandExecutionActions={refresh:async(...args)=>commandController.current?.refresh(...args)??false,stop:async id=>commandController.current?.stop(id)??false,readLog:async(...args)=>commandController.current?.readLog(...args)??false,readDiagnostics:async id=>commandController.current?.readDiagnostics(id)??false,copyDiagnostics:async id=>commandController.current?.copyDiagnostics(id)??false,openDiagnostics:async id=>commandController.current?.openDiagnostics(id)??false,refreshHistory:async()=>commandController.current?.refreshHistory()??false,inspectEnvironment:async()=>commandController.current?.inspectEnvironment()??false};
 const citation=projection.citations.get(citationId),wsl=projection.wslCitations.get(citationId),waveform=projection.waveformCitations.get(citationId);
 const tools=projection.timeline.filter(item=>item.kind==='tool'&&(request.target.kind!=='tool'||item.tool.call.callId===request.target.callId));
 return <div className="agent-result-document">
  <ChatSearch transcript={root} sessionId={chatResultIdentity(request)} scope="result" onNavigate={()=>{}}/>
  <div className="agent-result-source" ref={root} tabIndex={0} aria-label="本轮工具结果">
   {!scoped?<p role="alert">结果归属已变化，请从原聊天轮次重新打开。</p>:<>
    <p className="agent-result-path">所属项目：{activity.run?.project.name}{activity.run?.workCycle?' · 任务工作区':''}</p>
    {(citationId||previewOpen)&&<button type="button" className="chat-result-link" onClick={()=>{setCitationId('');setPreviewOpen(false);}}>返回本轮结果</button>}
    {citationId?<>{citation?<><h3>{projectCitationPath(citation)}</h3>{!citation.location&&<p className="agent-result-path">项目来源：{activity.run?.project.directorySegments.join(' > ')}</p>}<p>第 {citation.range.start.line} 行，第 {citation.range.start.column} 列 — 第 {citation.range.end.line} 行，第 {citation.range.end.column} 列（终点不含） · 读取时保存的片段</p><small>版本：{citation.version}</small><pre>{citation.excerpt}</pre></>:wsl?<><h3>{wsl.source.relativePath}</h3><p>第 {wsl.startLine}–{wsl.endLine} 行 · 读取时保存的片段</p><pre>{wsl.text}</pre></>:waveform?<WaveformResultsView value={waveform}/>:<p role="alert">本轮已保存记录中没有这条引用。</p>}</>:previewOpen?<>
     {work.opening&&<p role="status">正在核对文件版本…</p>}{work.previewError&&<p role="alert">{work.previewError}</p>}
     {work.preview?.kind==='file'?<WorkCycleFilePreview content={work.preview.content}/>:work.preview?.kind==='change'?<WorkCycleChangePreview change={work.preview.change}/>:null}
    </>:<>
     {request.workspaceId&&(work.files.length>0||work.listing||work.listError)&&<section aria-label="本轮成果文件"><div className="agent-result-heading"><h3>成果文件</h3><button type="button" disabled={work.listing||!api} onClick={()=>void workController.current?.refresh()}>核对文件</button></div>
      {work.listing?<p role="status">正在核对成果…</p>:work.listError?<p role="alert">{work.listError}</p>:<WorkCycleFiles files={work.files} onOpenFile={openFile}/>}
     </section>}
     {tools.map(item=>item.kind==='tool'&&<details key={item.key} open={request.target.kind==='tool'}><summary>{chatToolLabels[item.tool.call.toolName]}</summary>
      {item.tool.result?<ProjectReadResults result={item.tool.result} toolName={item.tool.call.toolName} runId={request.runId} call={item.tool.call} onCitation={cite} {...(onSchematic?{onSchematic}:{})} {...(request.workspaceId&&api?{onWorkFile:openFile,onWorkChange:openChange,currentFiles:work.files,commandState:commands,commandActions:actions}: {})}/>:<p>尚无已确认结果。</p>}
     </details>)}
     {commands.entries.map(entry=><details key={entry.execution.executionId}><summary>命令日志 · {entry.execution.environment.displayName}</summary><CommandExecutionDetails entry={entry} actions={actions} files={work.files} onOpenFile={openFile}/></details>)}
     {commands.error&&<p role="alert">{commands.error}</p>}
     {!!projection.citations.size&&<details><summary>文件依据</summary>{[...projection.citations.values()].map(c=><p key={c.citationId}><button type="button" onClick={()=>cite(c.citationId)}>{projectCitationPath(c)} · 第 {c.range.start.line} 行</button></p>)}</details>}
     {!!projection.wslCitations.size&&<details><summary>WSL 依据</summary>{[...projection.wslCitations.values()].map(c=><p key={c.citationId}><button type="button" onClick={()=>cite(c.citationId)}>{c.source.relativePath}</button></p>)}</details>}
     {!!projection.waveformCitations.size&&<details><summary>波形与指标</summary>{[...projection.waveformCitations.values()].map(c=><p key={c.citationId}><button type="button" onClick={()=>cite(c.citationId)}>{c.kind==='wsl_waveform_read'?'波形':'指标'} · {c.source.files[0]?.relativePath}</button></p>)}</details>}
    </>}
   </>}
  </div>
 </div>;
}
