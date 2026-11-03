import type {CommandEnvironment,CommandExecution,CommandLogPage,CommandStream} from '../../shared/agent/agent-command';
import type {CommandExecutionEntry,CommandExecutionController} from './command-execution-controller';
import type {WorkCycleFile} from '../../shared/agent/agent-work-cycle';
import {WorkCycleFiles} from './WorkCycleResults';

export type CommandExecutionActions=Pick<CommandExecutionController,'refresh'|'stop'|'readLog'|'refreshHistory'|'inspectEnvironment'>&Partial<Pick<CommandExecutionController,'readDiagnostics'|'copyDiagnostics'|'openDiagnostics'>>;
/** One live detail per execution; historical status/log tool results remain snapshots. */
export function CommandExecutionArtifacts({execution,files,onOpenFile}:{execution:CommandExecution;files:readonly WorkCycleFile[];onOpenFile?:(file:WorkCycleFile,trigger:HTMLButtonElement)=>void}){
 const artifacts=execution.artifacts.flatMap(ref=>files.filter(file=>file.fileId===ref.fileId&&file.version===ref.version&&file.origin.kind==='command'&&file.origin.executionId===execution.executionId&&file.origin.manifestVersion===execution.changes.manifestVersion));
 return execution.artifacts.length?<section aria-label="命令产物"><h3>本次产物</h3><p>独立保存的只读文件；原工作文件改动尚未承接。</p>
  {artifacts.length>0&&onOpenFile&&<WorkCycleFiles files={artifacts} onOpenFile={onOpenFile}/>}
  {artifacts.length!==execution.artifacts.length&&<p>部分产物的文件信息尚待核对，可在工作文件区域点击“核对文件”。</p>}
 </section>:null;
}
export function CommandExecutionDetails({entry,actions,files=[],onOpenFile,readOnly=false}:{entry:CommandExecutionEntry;actions:CommandExecutionActions;files?:readonly WorkCycleFile[];onOpenFile?:(file:WorkCycleFile,trigger:HTMLButtonElement)=>void;readOnly?:boolean}){
 const id=entry.execution.executionId;
 return <div className="command-execution-detail"><CommandExecutionView execution={entry.execution} refreshing={entry.refreshing} stopping={entry.stopping} stopUnconfirmed={entry.stopUnconfirmed}
    readingStreams={(['stdout','stderr'] as const).filter(stream=>entry.logs[stream].reading)} onRefresh={()=>void actions.refresh(id)} {...(!readOnly?{onStop:()=>void actions.stop(id)}:{})} onReadLog={stream=>void actions.readLog(id,stream)}/>
  {entry.error&&<p role="status">{entry.error}</p>}
  <CommandExecutionArtifacts execution={entry.execution} files={files} {...(onOpenFile?{onOpenFile}:{})}/>
  {(['stdout','stderr'] as const).map(stream=><div key={stream}>{entry.logs[stream].reading&&<p role="status">正在读取{streamLabels[stream]}…</p>}
   {entry.logs[stream].error&&<p role="alert">{entry.logs[stream].error}</p>}{entry.logs[stream].page&&<CommandLogPageView page={entry.logs[stream].page!} reading={entry.logs[stream].reading}
    onNext={()=>void actions.readLog(id,stream,'next')} onLatest={()=>void actions.readLog(id,stream,'latest')}/>}</div>)}
  {actions.readDiagnostics&&<section aria-label="执行诊断日志">
   <div className="command-detail-actions">
    <button type="button" disabled={entry.diagnosticsLoading} onClick={()=>void actions.readDiagnostics?.(id)}>{entry.diagnosticsLoading?'正在读取诊断…':'诊断日志'}</button>
    {actions.copyDiagnostics&&<button type="button" disabled={entry.diagnosticsLoading||entry.diagnosticsCopying} onClick={()=>void actions.copyDiagnostics?.(id)}>{entry.diagnosticsCopying?'正在复制…':'复制诊断信息'}</button>}
    {actions.openDiagnostics&&<button type="button" disabled={entry.diagnosticsOpening} onClick={()=>void actions.openDiagnostics?.(id)}>{entry.diagnosticsOpening?'正在打开…':'打开日志位置'}</button>}
   </div>
   {entry.diagnosticsError&&<p role="status">{entry.diagnosticsError}</p>}
   {entry.diagnosticsActionStatus&&<p role="status">{entry.diagnosticsActionStatus}</p>}
   {entry.diagnostics&&<>
    {entry.diagnostics.unavailable&&<p>诊断记录暂时无法完整读取，以下仅显示已核对的部分。</p>}
    {entry.diagnostics.truncated&&<p>仅显示此执行最近保留的诊断，较早记录可能已轮转。</p>}
    {!entry.diagnostics.records.length&&<p>此执行没有保留可用诊断（可能早于记录功能或已轮转）。</p>}
    {entry.diagnostics.records.map(record=><details key={record.id}><summary><time dateTime={record.time}>{record.time.replace('T',' ').replace('Z',' UTC')}</time> · {record.operation} · {record.causeCode}</summary>
     <p>组件：{record.component} · 应用版本：{record.appVersion}{record.nativeCode!==null?` · 系统码：${record.nativeCode}`:''}</p>
     {record.stack.length>0?<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{record.stack.join('\n')}</pre>:<p>此记录未保留调用位置。</p>}
    </details>)}
   </>}
  </section>}
 </div>;
}

const streamLabels:Record<CommandStream,string>={stdout:'标准输出',stderr:'错误输出'};
const phaseLabels:Record<CommandExecution['phase'],string>={intent:'启动意图已记录',starting:'正在启动命令',running:'命令运行中',settling:'正在核对执行结果',terminal:'命令已结束',reconciliation_required:'执行状态待核对'};
const stageLabels:Record<NonNullable<CommandExecution['error']>['stage'],string>={prepare:'准备',start:'启动',run:'运行',log:'日志保存',cleanup:'资源收尾',recovery:'状态核对'};
const stopLabels:Record<NonNullable<CommandExecution['stopRequested']>['reason'],string>={user:'用户请求',deadline:'运行超时',log_limit:'日志达到上限',shutdown:'应用关闭',model_finished:'模型任务结束',storage_failure:'记录保存失败',engine_failure:'软件异常后自动停止'};

export function commandExecutionReason(execution:CommandExecution):string|null{
 if(!execution.error)return null;
 const cleanupReconciled=execution.phase==='terminal'&&execution.cleanup.state==='confirmed'&&!!execution.cleanup.proofSha256&&execution.job.activeProcesses===0&&execution.job.emptyConfirmed&&execution.logs.stdout.closed&&execution.logs.stderr.closed;
 if(cleanupReconciled&&['WSL_CLEANUP_UNCONFIRMED','NATIVE_CLEANUP_TIMEOUT'].includes(execution.error.code))return '此前未能确认收尾，现已通过状态核对确认结束。';
 const reasons:Record<string,string>={RESULT_ADOPTION_CANCELLED:execution.cleanup.state==='confirmed'?'任务已停止，文件变更未接收；进程收尾已确认。':'任务已停止接收文件变更，进程收尾尚未确认。',DRIVER_EVIDENCE_FAILED:'执行结果未能完成核对。',RECONCILIATION_REQUIRED:'现有记录不足以确认执行结果。',LOG_INCOMPLETE:'部分输出未完整保存。',STOP_DELIVERY_FAILED:'停止请求尚未确认送达。',WSL_BRIDGE_FAILED:'命令运行环境连接异常。',WSL_RESULT_MISSING:'未收到命令运行环境的最终结果。',WSL_PROCESS_EXIT:'命令运行环境意外退出。',WSL_CLEANUP_UNCONFIRMED:'命令运行环境的收尾尚未确认。',NATIVE_CLEANUP_TIMEOUT:'等待进程收尾超时，仍需核对状态。',NATIVE_RESULT_MISSING:'未收到执行程序的最终结果。',ARTIFACTS_UNAVAILABLE:'执行产生的文件暂时无法读取。',STORAGE_FAILED:'执行记录未能完整保存。',PREPARATION_FAILED:'命令启动准备未完成。',PREPARATION_DEADLINE:'命令启动准备超时。',ENGINE_FAILED:'软件处理执行结果时发生异常。'};
 return reasons[execution.error.code]??`${stageLabels[execution.error.stage]}阶段发生异常，可查看日志。`;
}

/** A stop request or a shell exit alone cannot establish that this execution has stopped. */
export function commandExecutionState(execution:CommandExecution):{label:string;detail:string;canStop:boolean}{
 const canStop=!execution.stopRequested&&['intent','starting','running','settling'].includes(execution.phase);
 if(execution.phase==='reconciliation_required'||execution.cleanup.state==='failed')return{label:'执行状态待核对',detail:'执行收尾尚未确认。可核对状态、查看已保存日志；不会自动重跑命令。',canStop:false};
 if(execution.exit?.termination==='failed_start')return{label:'命令启动失败',detail:'启动阶段未完成；请查看失败原因与已保存记录。',canStop:false};
 const exitConfirmed=execution.exit?.shellExited===true||execution.exit?.termination==='stopped'&&execution.exit.shellExited===false&&execution.exit.shellExitCode===null;
 const closed=execution.phase==='terminal'&&exitConfirmed&&execution.job.activeProcesses===0&&execution.job.emptyConfirmed
   &&execution.cleanup.state==='confirmed'&&!!execution.cleanup.proofSha256&&execution.logs.stdout.closed&&execution.logs.stderr.closed;
 if(!closed){
  if(execution.stopRequested)return{label:execution.stopRequested.reason==='engine_failure'?'软件异常后正在停止':'已请求停止',detail:'等待实际退出、进程树归零、日志关闭和资源收尾确认。',canStop:false};
  return{label:execution.phase==='terminal'?'执行收尾待确认':phaseLabels[execution.phase],detail:execution.exit?.shellExited?'入口进程已退出，后代进程和资源收尾仍需核对。':'执行状态依据实际记录更新。',canStop};
 }
 const termination=execution.exit!.termination;
 if(termination==='stopped')return{label:execution.stopRequested?.reason==='engine_failure'?'软件异常后已停止':'命令已停止',detail:execution.exit!.shellExited?'实际退出和资源收尾已确认，已产生的文件不会因停止而撤销。':'进程与资源收尾已确认，未获得入口进程退出码。',canStop:false};
 if(termination==='timed_out')return{label:'命令已超时',detail:'超时后已确认退出与收尾；可查看保留的日志。',canStop:false};
 if(termination==='log_limit')return{label:'命令达到日志上限',detail:'已确认退出与收尾；日志完整性以各输出流的保存状态为准。',canStop:false};
 if(termination==='fault')return{label:'命令执行异常',detail:'已确认退出与收尾，请结合错误阶段及日志核对结果。',canStop:false};
 if(execution.exit!.shellExitCode===null)return{label:'退出码未确认',detail:'退出与收尾已记录，但入口进程退出码尚未确认。',canStop:false};
 if(execution.exit!.shellExitCode!==0)return{label:'命令非零退出',detail:'请结合错误日志修正任务；本次失败记录仍保留。',canStop:false};
 return{label:'命令已退出',detail:'入口进程退出码为 0；这不单独证明每条子命令成功，仍需核对日志和产物。',canStop:false};
}

export function CommandEnvironmentResults({environments}:{environments:readonly CommandEnvironment[]}){
 return <div className="project-read-results">{environments.length?<ul aria-label="命令执行环境">{environments.map(environment=><li key={environment.environmentId}>
  <strong>{environment.displayName}</strong><p>{environment.availability==='ready'?'可用':'尚未就绪'}{environment.reason?`：${environment.reason}`:''}</p>
  <p>{environment.shell.kind==='bash'?'Bash':'PowerShell'} {environment.shell.version} · 非交互执行</p>
  {environment.platform==='wsl'&&<><p>WSL：{environment.wsl.distribution} · {environment.wsl.user}</p>
   <details><summary>目录与访问范围</summary><p>执行工作区：{environment.wsl.executionRoot}</p>
    <p>使用 WSL 用户权限，网络沿用 WSL 环境。</p>
    {environment.wsl.sourceRoots.length>0&&<ul aria-label="WSL 来源目录">{environment.wsl.sourceRoots.map((source,index)=><li key={index}>{source.path} · {source.access==='read_only'?'只读':'可写'}（{source.enforcement==='os_read_only'?'系统只读映射':'授权约定'}）</li>)}</ul>}
   </details></>}
  {environment.tools.length>0&&<p>环境工具：{environment.tools.map(tool=>`${tool.name} ${tool.version}`).join('、')}</p>}
  <p>工作目录：本次执行工作副本。运行上限：{environment.limits.maxTimeoutMs/1000} 秒；{environment.limits.processes===null?'不按进程数量终止':`最多 ${environment.limits.processes} 个进程`}。</p>
 </li>)}</ul>:<p>当前没有已准入的命令执行环境。</p>}</div>;
}

export function CommandLogPageView({page,onNext,onLatest,reading=false}:{page:CommandLogPage;onNext?:()=>void;onLatest?:()=>void;reading?:boolean}){
 const coverage=page.coverage==='complete'?(page.streamClosed?'日志已完整保存':'本次读取范围已完整保存'):page.coverage==='partial_at_limit'?'日志达到保存上限，存在未保存内容':page.coverage==='incomplete'?'日志保存不完整':'读取时日志仍在写入';
 return <section className="project-read-results" aria-label={`${streamLabels[page.stream]}日志页`}>
  <h3>{streamLabels[page.stream]}</h3><p>{coverage}。本页字节范围：{page.offset}–{page.endOffset}（终点不含），本次读取范围共 {page.snapshotBytes} 字节。</p>
  {page.format==='base64'&&<p>本页无法完整按 UTF-8 显示，以下为保留原始字节的 Base64 内容。</p>}
  <pre>{page.data||'（本页没有已保存内容）'}</pre>
  {page.nextCursor&&<p>本页仅显示部分内容，还有后续日志。</p>}
  {!page.nextCursor&&<p>本页已到当前读取范围末尾；不代表此前全部内容已经显示。</p>}
  {!page.nextCursor&&!page.streamClosed&&<p>{page.coverage==='open'?'日志仍在写入':'当前日志关闭状态尚未确认'}；读到当前末尾不表示命令已结束。</p>}
  {page.hasNewerBytes&&<p>已有新增日志，读完当前范围后可检查新增内容。</p>}
  {page.nextCursor&&onNext&&<button type="button" disabled={reading} onClick={onNext}>下一页</button>}
  {onLatest&&!page.nextCursor&&(!page.streamClosed||page.hasNewerBytes)&&<button type="button" disabled={reading} onClick={onLatest}>检查新增日志</button>}
 </section>;
}

export function CommandExecutionView({execution,onRefresh,onStop,onReadLog,refreshing=false,stopping=false,stopUnconfirmed=false,readingStreams=[]}:{execution:CommandExecution;onRefresh?:()=>void;onStop?:()=>void;onReadLog?:(stream:CommandStream)=>void;refreshing?:boolean;stopping?:boolean;stopUnconfirmed?:boolean;readingStreams?:readonly CommandStream[]}){
 const state=commandExecutionState(execution),changes=execution.changes,reason=commandExecutionReason(execution);
 return <section className="project-read-results command-execution-summary" aria-label="命令执行详情" data-execution-id={execution.executionId}>
  <p role="status"><strong>{state.label}</strong></p><p>{reason??state.detail}</p>
  {reason&&execution.error?.code!=='RESULT_ADOPTION_CANCELLED'&&<p className="command-detail-note">{state.detail}</p>}
  {(['stdout','stderr'] as const).filter(stream=>['incomplete','partial_at_limit'].includes(execution.logs[stream].coverage)||execution.logs[stream].observedBytes>execution.logs[stream].persistedBytes).map(stream=><p key={stream} className="command-detail-note">{streamLabels[stream]}保存不完整，可查看已保留日志。</p>)}
  <div className="command-detail-actions">
   {onRefresh&&<button type="button" disabled={refreshing} onClick={onRefresh}>核对执行状态</button>}
   {onStop&&(state.canStop||stopping||stopUnconfirmed||execution.stopRequested&&execution.phase!=='terminal')&&<button type="button" disabled={stopping||!state.canStop} onClick={onStop}>{stopping?'正在请求停止…':stopUnconfirmed?'核对并重试停止':'停止这次执行'}</button>}
  </div>
  <details><summary>技术详情</summary>
   <p>环境：{execution.environment.displayName}</p><p>工作目录（本次执行副本）：{execution.cwdRelativePath||'根目录'}</p>
   {execution.runtime?<><p>WSL：{execution.runtime.distribution} · {execution.runtime.user}</p><p>实际工作目录：{execution.runtime.cwd}</p></>
    :execution.runtime===null&&<p>实际 WSL 工作目录尚未确认。</p>}
   <pre>{execution.commandText}</pre>
   {execution.stopRequested&&<p>停止原因：{stopLabels[execution.stopRequested.reason]}。</p>}
   {execution.exit&&<p>入口进程退出码：{execution.exit.shellExitCode??'未确认'}。</p>}
   {execution.error&&<p>诊断码：{execution.error.code} · {stageLabels[execution.error.stage]}{execution.error.nativeCode!==null?` · 系统码 ${execution.error.nativeCode}`:''}</p>}
   <p>{changes.state==='verified'?`工作副本变更已核对${changes.count?`，共 ${changes.count} 项`:''}。`:changes.state==='pending'?'工作副本变更待核对。':'工作副本变更暂时无法核对。'}
    {changes.acceptance==='confirmed'?'任务文件承接已确认。':changes.acceptance==='conflict'?'任务文件承接发生版本冲突。':changes.acceptance==='pending'?'任务文件承接待确认。':'尚未承接为任务文件。'}</p>
   {!!execution.artifactCollection?.skippedEntries&&<p>成果回传已省略 {execution.artifactCollection.skippedEntries} 个文件或目录条目，仅包含限额内的文本文件。目录按一个条目计数，不代表整个外部实验目录的全部成果。</p>}
  </details>
  <details><summary>运行日志</summary>{(['stdout','stderr'] as const).map(stream=><p key={stream}>{streamLabels[stream]}：已保存 {execution.logs[stream].persistedBytes} 字节
   {execution.logs[stream].observedBytes>execution.logs[stream].persistedBytes?`，另有 ${execution.logs[stream].observedBytes-execution.logs[stream].persistedBytes} 字节未保存`:''}。
   {onReadLog&&<button type="button" disabled={readingStreams.includes(stream)} onClick={()=>onReadLog(stream)}>读取{streamLabels[stream]}</button>}
  </p>)}</details>
 </section>;
}
