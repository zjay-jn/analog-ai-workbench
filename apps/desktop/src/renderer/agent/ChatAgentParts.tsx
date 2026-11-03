import type {SessionTurn} from '../../shared/agent/chat-sessions';
import {nativeChatFailureMessage,type ChatTurnActivity} from '../../shared/agent/chat-turns';
import type {ProjectReadToolName,ProjectReadToolCall,ProjectReadToolResult} from '../../shared/agent/agent-project-read';
import {StreamingReply} from './StreamingReply';
import {ChatToolDisclosure,type ChatToolIcon} from './ChatAgentTurn';
import {chatExecutionLabel,chatTurnActive} from './chat-agent-controller';
import {projectReadEvents,projectReadError,projectReadToolError,projectMessageCitations,projectCitationPath} from './project-read-presentation';
import {describeToolOutput} from '../../shared/agent/tool-output';
import {toolOutputLabel} from './ToolOutputSummary';
import type {SchematicReference} from '../../shared/schematic/reviewed-schematic';
import {oaDisplayReferences,schematicAnswerReferences,schematicAnswerText} from '../schematic/schematic-query-links';

export const chatToolLabels:Record<ProjectReadToolName,string>={fs_list:'查看目录',fs_find:'查找文件',fs_search:'搜索内容',fs_read:'读取文件',project_list:'查看目录',project_find:'查找文件',project_search:'搜索内容',project_read:'读取文件',skill_discover:'发现技能',skill_load:'加载技能',skill_read_reference:'读取技能资料',pilot_sum:'计算',work_list:'查看工作文件',work_read:'读取工作文件',work_write:'写入工作文件',work_edit:'修改工作文件',work_import:'复制资料',work_run:'运行分析',command_environment:'核对命令环境',command_start:'执行命令',command_status:'查询命令状态',command_log:'读取命令日志',command_stop:'停止命令',wsl_results_list:'查看 WSL 结果',wsl_results_read:'读取 WSL 结果',wsl_waveform_list:'查看波形信号',wsl_waveform_read:'读取波形',wsl_waveform_metrics:'计算波形指标',oa_open_design:'打开电路副本',oa_inspect_design:'查看原理图',oa_query_instances:'查询器件',oa_query_nets:'查询网络',oa_describe_device:'查看器件详情'};
export type ChatResultTarget={kind:'tool';callId:string}|{kind:'citation';citationId:string}|{kind:'run'};
export function chatToolDurations(activity:ChatTurnActivity|null):Map<string,number>{
 const starts=new Map<string,number>(),elapsed=new Map<string,number>();
 for(const part of activity?.parts??[]){
  if(part.kind!=='run_event'||part.runId!==part.event.runId)continue;
  const event=part.event;if(event.type!=='tool.started'&&event.type!=='tool.completed')continue;
  const key=JSON.stringify([event.runId,event.data.callId]),time=Date.parse(event.time);if(!Number.isFinite(time))continue;
  if(event.type==='tool.started'){if(!starts.has(key))starts.set(key,time);}
  else {const start=starts.get(key);if(start!==undefined&&time>=start)elapsed.set(key,time-start);}
 }
 return elapsed;
}
export function chatToolSummarySubject(call:ProjectReadToolCall,subject:string):string{
 return ['fs_read','project_read','skill_load','skill_read_reference','work_read','work_write','work_edit','work_import'].includes(call.toolName)
  ?subject.split(/[\\/]/u).at(-1)||subject:subject;
}
/** Project only existing display fields. Never stringify arguments, bodies or opaque IDs. */
export function chatToolSubject(call:ProjectReadToolCall,result:ProjectReadToolResult|null):string{
 let subject='';
 if(result?.ok&&result.value.kind==='read'&&result.value.citation)subject=projectCitationPath(result.value.citation);
 else if(result?.ok&&['work_read','work_write','work_edit','work_import'].includes(result.value.kind)&&'file' in result.value)subject=result.value.file.relativePath;
 else if(result?.ok&&result.value.kind==='command_environment')subject=result.value.environments.map(environment=>environment.displayName).join('、');
 else if(result?.ok&&['command_start','command_status','command_stop'].includes(result.value.kind)&&'execution' in result.value&&'commandText' in result.value.execution)subject=result.value.execution.commandText;
 else if(result?.ok&&result.value.kind==='oa_read'){
  const value=result.value;
  switch(call.toolName){
   case 'oa_open_design':case 'oa_inspect_design':subject=value.source.lcv.cell;break;
   case 'oa_query_instances':case 'oa_query_nets':
    subject=call.arguments.selector.kind==='exact_name'?call.arguments.selector.name
     :call.arguments.selector.kind==='all'?(call.toolName==='oa_query_instances'?'全部器件':'全部网络')
     :oaDisplayReferences(value).find(display=>display.objectRef.kind===(call.toolName==='oa_query_nets'?'net':'instance')
      &&display.objectRef.objectId===(call.arguments.selector.kind==='id'?call.arguments.selector.objectId:'')&&display.label!==display.objectRef.objectId)?.label
      ??(value.data.kind==='instances'||value.data.kind==='nets'?value.data.items[0]?.name:'')??'';
    break;
   case 'oa_describe_device':subject=oaDisplayReferences(value).find(display=>display.objectRef.kind==='instance'
    &&display.objectRef.objectId===call.arguments.instanceId&&display.label!==display.objectRef.objectId)?.label??'';break;
  }
 }
 else switch(call.toolName){
  case 'fs_read':case 'fs_list':subject=call.arguments.path??'';break;
  case 'fs_find':case 'fs_search':subject=[call.arguments.query,call.arguments.path].filter(Boolean).join(' · ');break;
  case 'project_find':case 'project_search':subject=call.arguments.query;break;
  case 'command_start':subject=call.arguments.commandText;break;
  case 'command_log':subject=call.arguments.stream;break;
  case 'oa_query_instances':case 'oa_query_nets':subject=call.arguments.selector.kind==='exact_name'?call.arguments.selector.name
   :call.arguments.selector.kind==='all'?(call.toolName==='oa_query_instances'?'全部器件':'全部网络'):'';break;
  case 'work_write':case 'work_import':subject=call.arguments.relativePath;break;
 }
 return subject.replace(/[\u0000-\u001f\u007f-\u009f]/gu,' ').trim();
}
function editsFile(name:ProjectReadToolName){return name==='work_write'||name==='work_edit'||name==='work_import';}
function chatToolIcon(name:ProjectReadToolName):ChatToolIcon{return editsFile(name)?'edit':'command';}
export function chatToolOperation(call:ProjectReadToolCall,subject:string):string{
 if(editsFile(call.toolName)||call.toolName==='command_start')return subject;
 const section=call.toolName==='oa_query_nets'||call.toolName==='oa_describe_device'?`section=${call.arguments.section}`:'';
 return [call.toolName,subject,section].filter(Boolean).join(' ');
}
/** A returned command-start is a launch receipt, never proof that the command finished. */
export function chatToolActivityLabel(call:ProjectReadToolCall,result:ProjectReadToolResult|null,inFlight:boolean):string{
 const label=editsFile(call.toolName)?'编辑文件':call.toolName==='command_start'?'执行命令':'执行操作';
 if(!result)return inFlight?'正在'+label:label;
 if(!result.ok)return label;
 if(result.value.kind==='work_write'||result.value.kind==='work_edit'||result.value.kind==='work_import'){
  if(result.value.file.confirmation==='unconfirmed')return '文件变更待核对';
  if(!result.value.changed)return '文件内容未变';
 }
 if(call.toolName==='command_start'&&result.value.kind==='command_start'){
  const e=result.value.execution;
  if(e.phase==='terminal'&&e.exit?.termination==='exited'&&e.cleanup.state==='confirmed')return '运行了命令';
  if(e.startedAt)return '启动了命令';
 }
 return editsFile(call.toolName)?'编辑了文件':call.toolName==='command_start'?'发起了命令':'执行了';
}
export function chatActivityProjection(activity:ChatTurnActivity){
 const events=activity.parts.flatMap(part=>part.kind==='run_event'?[part.event]:[]),projection=projectReadEvents(events);
 const sequence=new Map(activity.parts.flatMap(part=>part.kind==='run_event'?[[part.event.sequence,part.sequence] as const]:[]));
 const ordered=[...projection.timeline.map(item=>({...item,key:sequence.get(item.key)??item.key})),...activity.parts.flatMap(part=>part.kind==='text'?[{kind:'text' as const,key:part.sequence,messageId:part.partId,step:0,text:part.text}]:[])].sort((a,b)=>a.key-b.key);
 const timeline:typeof ordered=[];
 for(const item of ordered){const previous=timeline.at(-1);if(item.kind==='text'&&item.step===0&&previous?.kind==='text'&&previous.step===0)previous.text+=item.text;else timeline.push({...item});}
 return {...projection,timeline};
}
export function ChatAgentParts({turn,activity,error,reading,onRetry,onOpen,onAdvance,onSchematic}:{turn:SessionTurn;activity:ChatTurnActivity|null;error?:string|null;reading?:boolean;onRetry:()=>void;onOpen:(target:ChatResultTarget)=>void;onAdvance:()=>void;onSchematic?:(reference:SchematicReference)=>void}){
 const projection=activity?chatActivityProjection(activity):null,execution=activity?.execution&&activity.execution.version>=(turn.execution?.version??0)?activity.execution:turn.execution;
 const hasText=projection?.timeline.some(item=>item.kind==='text'&&!!item.text);
 const oaRows=projection?.timeline.flatMap(item=>item.kind==='tool'&&item.tool.result?.ok&&item.tool.result.value.kind==='oa_read'?[{value:item.tool.result.value,callId:item.tool.call.callId}]:[])??[];
 const oaValues=oaRows.map(row=>row.value);
 const answerText=hasText?projection!.timeline.flatMap(item=>item.kind==='text'?[item.text]:[]).join('\n'):turn.assistant;
 // Keep one exact cited destination at the end of the answer.
 const schematicLocation=schematicAnswerReferences(answerText,oaValues)[0];
 const toolDurations=chatToolDurations(activity);
 const finalFailure=execution?.phase==='failed'&&activity?.run?.status==='failed'&&execution.runLink?.runId===activity.run.runId?projection?.failure:null;
 const terminal=!!execution&&['failed','cancelled','interrupted'].includes(execution.phase);
 const failureMessage=execution?.phase==='failed'?(turn.error|| (execution.failureDiagnostic?.nativeFailure?nativeChatFailureMessage(execution.failureDiagnostic.nativeFailure):finalFailure?projectReadError(finalFailure):'回复未完成。')):null;
 const cleanupMessage=terminal&&execution.cleanupState!=='idle'?(execution.cleanupState==='pending'?'正在核对执行收尾，暂时不能继续。':'执行收尾尚未确认，暂时不能继续。'):null;
 const statusMessage=failureMessage||(terminal?(execution?.phase==='cancelled'?(execution.cleanupState==='idle'?'已停止。':'已请求停止。'):'上次执行已中断。'):execution&&!chatTurnActive(execution)&&execution.phase!=='completed'?chatExecutionLabel(execution):null);
 return <div className="chat-agent-parts">
  {execution&&!terminal&&execution.phase!=='running'&&chatTurnActive(execution)&&<p className="chat-execution-state" role="status">{chatExecutionLabel(execution)}</p>}
  {execution?.compaction&&<p className="settings-note" data-context-compaction={execution.compaction.version}>已压缩上下文 {execution.compaction.version} 次 · 原始聊天记录保留</p>}
  {!execution?.runLink&&execution?.clarifications?.filter(question=>question.answer!==null||execution.pendingInteraction?.kind!=='question'||execution.pendingInteraction.questionId!==question.questionId).map(question=><div key={question.questionId} className="chat-question-record" data-question-id={question.questionId}>
   <p>{question.prompt}</p>{question.answer!==null&&<p><strong>你的回答：</strong>{question.answer}</p>}
   <small>{question.answer===null?'尚未回答':question.delivered?'回答已交付':'回答已记录，交付尚未确认'}</small>
  </div>)}
  {projection?.timeline.map(item=>item.kind==='text'?<div key={item.key} className="chat-narrative"><StreamingReply text={schematicAnswerText(item.text,oaValues)} status={turn.status} onAdvance={onAdvance}/>{[
   ...projectMessageCitations(item.text,projection?.citations??new Map()).map(c=>({id:c.citationId,label:projectCitationPath(c)})),
   ...projectMessageCitations(item.text,projection?.wslCitations??new Map()).map(c=>({id:c.citationId,label:c.source.relativePath})),
   ...projectMessageCitations(item.text,projection?.waveformCitations??new Map()).map(c=>({id:c.citationId,label:c.kind==='wsl_waveform_read'?'波形依据':'指标依据'})),
  ].map(c=><button type="button" className="chat-result-link" key={c.id} onClick={()=>onOpen({kind:'citation',citationId:c.id})}>{c.label}</button>)}</div>:item.kind==='tool'?(()=>{
   const {call,result}=item.tool,output=result?.ok?describeToolOutput({runId:activity?.run?.runId??'',call,result}):null;
   const subject=chatToolSubject(call,result),durationMs=toolDurations.get(JSON.stringify([activity?.run?.runId,call.callId]));
   const inFlight=!!execution&&execution.phase==='running'&&execution.cleanupState==='idle';
   const state=result?(result.ok?toolOutputLabel(output):'失败'):inFlight?'进行中':'未确认完成';
   const tone=result?(result.ok?(output&&output.state!=='complete'?'attention':'neutral'):'error'):inFlight?'running':'attention';
   return <div key={item.key} className="chat-tool-row" data-tool-call={call.callId}>
    <ChatToolDisclosure label={chatToolActivityLabel(call,result,inFlight)} state={state} subject={chatToolOperation(call,subject)}
     summarySubject={chatToolOperation(call,chatToolSummarySubject(call,subject))} {...(durationMs===undefined?{}:{durationMs})} icon={chatToolIcon(call.toolName)} tone={tone}>
     {result&&!result.ok&&<p className="chat-tool-failure">{call.toolName} 未完成：{projectReadToolError(result.error)}</p>}
    </ChatToolDisclosure>
   </div>;
  })():<div key={item.key} className="chat-question-record"><p>{item.prompt}</p><p>{item.answer}</p><small>{item.delivered?'回答已交付':'回答已记录，交付尚未确认'}</small></div>)}
  {!hasText&&<StreamingReply text={schematicAnswerText(turn.assistant,oaValues)} status={turn.status} onAdvance={onAdvance}/>}
  {schematicLocation&&<button type="button" className="chat-result-link" disabled={!onSchematic}
   title={`定位到 ${schematicLocation.label} 所在的原理图版本`} onClick={()=>onSchematic?.(schematicLocation.reference)}>查看原理图</button>}
  {statusMessage&&<div className="chat-outcome"><div className="chat-outcome-line"><p role={failureMessage?'alert':'status'} {...(finalFailure?{'data-run-failure':finalFailure}:{})}>{statusMessage}</p>{activity?.run&&<button type="button" className="chat-result-link" title="在右侧查看执行详情与日志" onClick={()=>onOpen({kind:'run'})}>详情</button>}</div>{cleanupMessage&&<p className="chat-cleanup-note" role="status">{cleanupMessage}</p>}</div>}
  {reading&&activity?.hasMore&&<p className="settings-note">正在读取较早的过程记录…</p>}
  {error&&<p role="alert">{error} <button type="button" onClick={onRetry}>重新核对</button></p>}
 </div>;
}
