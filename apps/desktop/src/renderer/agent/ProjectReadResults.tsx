import {useState} from 'react';
import type {ProjectReadCitationPreview,ProjectReadCoverage,ProjectReadToolCall,ProjectReadToolResult} from '../../shared/agent/agent-project-read';
import {describeToolOutput} from '../../shared/agent/tool-output';
import {ToolOutputSummary} from './ToolOutputSummary';
import type {CommandLogPage} from '../../shared/agent/agent-command';
import type {AgentSkillMetadataStatus} from '../../shared/agent/agent-skills';
import {projectReadToolError,projectCitationPath,projectEntryPath} from './project-read-presentation';
import type {WorkCycleFile} from '../../shared/agent/agent-work-cycle';
import {WorkCycleResults} from './WorkCycleResults';
import {isWorkCycleValue,reconcileWorkValue} from './work-cycle-presentation';
import {CommandEnvironmentResults,CommandExecutionDetails,CommandExecutionView,CommandLogPageView,type CommandExecutionActions} from './CommandExecutionResults';
import type {CommandExecutionEntry,CommandExecutionViewState} from './command-execution-controller';
import {WslResultsView} from './WslResultsView';
import {wslResultsError} from './wsl-results-presentation';
import {isWaveformResultsToolName} from '../../shared/agent/waveform-results';
import {WaveformResultsView} from './WaveformResultsView';
import {waveformResultsError} from './waveform-results-presentation';
import type {SchematicReference} from '../../shared/schematic/reviewed-schematic';
import {OaReadResults} from './OaReadResults';

const limits={page:'本次返回数量',slice:'本次扫描数量',time:'本次扫描时间',scope:'可访问范围',bytes:'读取字节数',context:'上下文容量',rules:'规则容量',citations:'引用容量'} as const;
const skillMetadataLabels:Record<AgentSkillMetadataStatus,string>={ready:'',missing_frontmatter:'未提供技能信息。',invalid_frontmatter:'技能信息格式无法识别。',header_too_large:'技能信息超过读取上限。',unsupported_encoding:'技能信息编码不支持。'};
/** The model's saved page is immutable. Further pages are local, explicit inspection only. */
export function CommandLogResult({page,entry,actions}:{page:CommandLogPage;entry?:CommandExecutionEntry;actions?:CommandExecutionActions}){
  const [browsing,setBrowsing]=useState(false),log=entry?.execution.executionId===page.executionId?entry.logs[page.stream]:undefined,shown=browsing&&log?.page?log.page:page;
  const read=(mode:'next'|'latest')=>{if(!actions||!log||log.reading)return;setBrowsing(true);void actions.readLog(page.executionId,page.stream,mode,shown);};
  return <><p className="engine-pilot-muted">{browsing?'后续读取仅供本地查看，未发送给模型。':'工具当时返回的日志片段。'}</p>
   <CommandLogPageView page={shown} reading={!!log?.reading} {...(actions&&log?{onNext:()=>read('next'),onLatest:()=>read('latest')}:{})}/>
   {log?.reading&&<p role="status">正在读取日志页…</p>}{browsing&&log?.error&&<p role="alert">{log.error}</p>}
   {browsing&&<button type="button" onClick={()=>setBrowsing(false)}>查看工具原始片段</button>}
  </>;
}
/** Reports this tool result only; neither a terminal run nor a cursor proves task completion. */
export function ProjectReadCoverageView({coverage}:{coverage:ProjectReadCoverage}){
  const skipped=Object.values(coverage.skipped).reduce((sum,count)=>sum+count,0);
  return <div className="project-read-coverage">
    <p>{coverage.complete?'本次范围扫描结束':'本次范围尚未查完'}{skipped>0?'，有跳过的条目':''} · {coverage.scope.kind==='windows_filesystem'?coverage.scope.absoluteDirectory:coverage.scope.relativeDirectory||'项目根目录'}</p>
    <p>已检查 {coverage.scannedCandidates} 个条目、{coverage.scannedFiles} 个文件 · 已读取 {coverage.scannedBytes} 字节 · 本次返回 {coverage.returned} 项</p>
    {skipped>0&&<p>跳过：访问限制 {coverage.skipped.policy}，格式不支持 {coverage.skipped.unsupported}，文件超限 {coverage.skipped.fileLimit}，无法访问 {coverage.skipped.unavailable}。</p>}
    {!coverage.complete&&<p>尚余目录：{coverage.remaining.directories??'未知'}；文件：{coverage.remaining.files??'未知'}。{coverage.remaining.position&&`后续位置：第 ${coverage.remaining.position.line} 行，第 ${coverage.remaining.position.column} 列。`}</p>}
    {coverage.limitReason&&<p>达到{limits[coverage.limitReason]}限制。</p>}
  </div>;
}

type ResultProps={result:ProjectReadToolResult;toolName?:string;runId?:string;call?:ProjectReadToolCall;onCitation:(citationId:string,trigger:HTMLButtonElement)=>void;onSchematic?:(reference:SchematicReference)=>void;onWorkFile?:(file:WorkCycleFile,trigger:HTMLButtonElement)=>void;onWorkChange?:(changeId:string,file:WorkCycleFile,trigger:HTMLButtonElement)=>void;currentFiles?:readonly WorkCycleFile[];commandEntry?:CommandExecutionEntry;commandState?:CommandExecutionViewState;commandActions?:CommandExecutionActions};
export function ProjectReadResults(props:ResultProps){
 const output=props.runId&&props.call?describeToolOutput({runId:props.runId,call:props.call,result:props.result}):null;
 return <>{output&&output.source.kind!=='command_log'&&<ToolOutputSummary output={output}/>}<ProjectReadResultBody {...props}/></>;
}
function ProjectReadResultBody({result,toolName,onCitation,onSchematic,onWorkFile,onWorkChange,currentFiles=[],commandEntry,commandState,commandActions}:ResultProps){
  if(!result.ok)return <div className="project-read-results"><p>{isWaveformResultsToolName(toolName)?waveformResultsError(result.error.code):toolName==='wsl_results_list'||toolName==='wsl_results_read'?wslResultsError(result.error.code):projectReadToolError(result.error)}</p>{result.coverage&&<ProjectReadCoverageView coverage={result.coverage}/>}</div>;
  const {value}=result;
  if(value.kind==='oa_read')return <OaReadResults value={value} {...(onSchematic?{onLocate:onSchematic}:{})}/>;
  if(value.kind==='wsl_waveform_list'||value.kind==='wsl_waveform_read'||value.kind==='wsl_waveform_metrics')return <WaveformResultsView value={value} onCitation={onCitation}/>;
  if(value.kind==='wsl_results_list'||value.kind==='wsl_results_read')return <WslResultsView value={value} onCitation={onCitation}/>;
  if(value.kind==='command_environment')return <><CommandEnvironmentResults environments={value.environments}/>{commandActions&&<details><summary>核对当前命令环境</summary>
    <button type="button" disabled={commandState?.inspectingEnvironment} onClick={()=>void commandActions.inspectEnvironment()}>核对环境</button>
    {commandState?.environmentError&&<p role="alert">{commandState.environmentError}</p>}{commandState?.environments&&<><p>最近一次核对结果：</p><CommandEnvironmentResults environments={commandState.environments}/></>}
  </details>}</>;
  if(value.kind==='command_log'){
    const entry=commandState?.entries.find(entry=>entry.execution.executionId===value.page.executionId);
    return <CommandLogResult key={`${value.page.executionId}:${value.page.stream}:${value.page.prefixVersion}:${value.page.offset}`} page={value.page}
      {...(entry?{entry}:{})} {...(commandActions?{actions:commandActions}:{})}/>;
  }
  if(isWorkCycleValue(value))return onWorkFile&&onWorkChange?<WorkCycleResults value={reconcileWorkValue(value,currentFiles)} onOpenFile={onWorkFile} onOpenChange={onWorkChange}/>:<p>工作文件查看入口尚未接通。</p>;
  if('execution' in value)return commandEntry&&commandActions&&commandEntry.execution.executionId===value.execution.executionId
    ?<CommandExecutionDetails entry={commandEntry} actions={commandActions} files={currentFiles} {...(onWorkFile?{onOpenFile:onWorkFile}:{})}/>:<><p>本次工具返回时的执行状态：</p><CommandExecutionView execution={value.execution}/></>;
  if(value.kind==='sum')return <p>求和结果：{value.sum}（{value.count} 个数）</p>;
  const skipped=Object.values(value.coverage.skipped).some(count=>count>0);
  const reference=(citation:ProjectReadCitationPreview)=><button type="button" onClick={event=>onCitation(citation.citationId,event.currentTarget)}>
    {projectCitationPath(citation)} · 第 {citation.range.start.line} 行，第 {citation.range.start.column} 列 — 第 {citation.range.end.line} 行，第 {citation.range.end.column} 列（终点不含）
  </button>;
  return <div className="project-read-results">
    {value.phase!=='data'&&<p>{value.phase==='rules'?'正在准备本次范围的规则。':'正在扫描本次范围。'}本次尚未返回内容结果。</p>}
    {value.kind==='skills'&&value.phase==='data'&&(value.entries.length?<>
      <p>当前项目中的技能</p><ul aria-label="本次发现的技能">{value.entries.map(entry=><li key={entry.skillId}>
        {entry.name&&<strong>{entry.name}</strong>}<p>{entry.entryRelativePath}</p>
        {entry.description&&<p>{entry.description}</p>}{entry.metadataStatus!=='ready'&&<p>{skillMetadataLabels[entry.metadataStatus]}</p>}
      </li>)}</ul></>:<p>{value.coverage.complete&&!skipped?'本次范围内未发现技能。':'已检查的范围内未发现技能；尚有未检查或跳过的条目。'}</p>)}
    {value.kind==='read'&&value.skill&&<>
      <p>技能入口：{value.skill.entryRelativePath}</p>
      <p>{value.skill.entryComplete?'技能入口已完整加载。':'技能入口尚未完整加载。'}</p>
      {value.skill.resourceRole==='reference'&&<><p>技能资料：{value.skill.resourceRelativePath}</p><p>{value.phase==='data'&&value.coverage.complete&&value.next===null?'本次资料读取已到文件末尾。':'技能资料尚未读完。'}</p></>}
    </>}
    {(value.kind==='list'||value.kind==='find')&&<ul aria-label="本次目录结果">{value.entries.map(entry=><li key={JSON.stringify([value.source?.sourceId??null,entry.kind,entry.fileId??entry.directoryId,entry.relativePath])}>
      <span>{projectEntryPath(entry.relativePath,value.source)}</span>{entry.kind==='directory'?' · 文件夹':` · ${entry.bytes} 字节`}
      {entry.readability==='unsupported'?' · 格式不支持':entry.readability==='file_limit'?' · 超出读取限制':''}
    </li>)}</ul>}
    {value.kind==='search'&&value.phase==='data'&&(value.matches.length?<ul aria-label="本次匹配结果">{value.matches.map(match=><li key={match.citation.citationId}>{reference(match.citation)}<pre>{match.citation.excerpt}</pre></li>)}</ul>:
      <p>{value.coverage.complete&&!skipped?'本次搜索范围内没有匹配。':'已检查的内容中没有匹配；未覆盖或跳过的内容尚不能判断。'}</p>)}
    {value.kind==='read'&&value.phase==='data'&&(value.citation?<div>{reference(value.citation)}<pre>{value.citation.excerpt}</pre></div>:<p>{value.empty?'本次读取为空。':'本次没有返回可引用片段。'}</p>)}
    <ProjectReadCoverageView coverage={value.coverage}/>
  </div>;
}
