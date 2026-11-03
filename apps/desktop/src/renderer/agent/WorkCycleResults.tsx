import type {WorkCycleChange,WorkCycleExecution,WorkCycleFile,WorkCycleFileContent,WorkCycleToolValue} from '../../shared/agent/agent-work-cycle';
import {TextDiff} from '../documents/TextDiff';
import {ChatMarkdown} from './ChatMarkdown';
import {workExecutionOutcome,workFileConfirmation} from './work-cycle-presentation';

type FileActions={onOpenFile:(file:WorkCycleFile,trigger:HTMLButtonElement)=>void};
export function WorkCycleFiles({files,onOpenFile}:{files:readonly WorkCycleFile[]}&FileActions){
 return files.length?<ul className="work-cycle-files" aria-label="工作文件">{files.map(file=><li key={`${file.fileId}:${file.version}`}>
  <button type="button" onClick={event=>onOpenFile(file,event.currentTarget)} title={file.confirmation==='confirmed'?'打开已核对的工作文件':'核对并打开工作文件'}>{file.relativePath}</button>
  <span>{workFileConfirmation(file)} · {file.bytes} 字节</span>
  {file.origin.kind==='continuation'&&<small>承接自原任务{file.relativePath.startsWith('artifacts/')?' · 原报告与产物只读':''}</small>}
  {file.origin.kind==='command'&&<small>命令产物 · 只读</small>}
  <details><summary>文件信息</summary><p>版本：{file.version}</p><p>{file.origin.kind==='execution'?'分析生成':file.origin.kind==='command'?'命令执行后独立保存':file.origin.kind==='import'?'从项目资料复制':file.origin.kind==='continuation'?'沿用原任务保存的文件版本':'工作文件修改'}</p>{file.origin.kind==='import'&&<><p>来源：{file.origin.source.relativePath}</p><p>来源版本：{file.origin.source.version}</p></>}{file.origin.kind==='continuation'&&<><p>来源任务：{file.origin.source.runId}</p><p>来源版本：{file.origin.source.version}</p></>}{file.origin.kind==='command'&&<p>执行副本内路径：{file.origin.sourceRelativePath}</p>}</details>
 </li>)}</ul>:<p>本次没有返回工作文件。</p>;
}
export function WorkCycleExecutionResult({execution,onOpenFile}:{execution:WorkCycleExecution}&FileActions){
 const outcome=workExecutionOutcome(execution),failed=outcome.kind==='failed';
 return <section className={`work-cycle-execution work-cycle-${outcome.kind}`} aria-label="分析结果">
  <p role="status"><strong>{outcome.label}</strong></p><p>{outcome.detail}</p>
  <p className="engine-pilot-muted">退出码：{execution.exitCode??'未确认'}{execution.signal!==null?` · 终止信号：${execution.signal}`:''} · {(execution.durationMs/1000).toFixed(1)} 秒</p>
  <details open={failed||execution.stdoutTruncated||execution.stderrTruncated}><summary>运行日志</summary>
   <section><h3>标准输出</h3>{execution.stdoutTruncated&&<p>输出已截断，以下不是完整日志。</p>}<pre>{execution.stdout||'（没有收到输出）'}</pre></section>
   <section><h3>错误输出</h3>{execution.stderrTruncated&&<p>错误输出已截断，以下不是完整日志。</p>}<pre>{execution.stderr||'（没有收到错误输出）'}</pre></section>
  </details>
  {execution.artifacts.length>0&&<><h3>本次产物</h3><WorkCycleFiles files={execution.artifacts} onOpenFile={onOpenFile}/></>}
  <details><summary>本次分析使用的文件</summary><ul>{execution.inputs.map(file=><li key={`${file.fileId}:${file.version}`}><span>{file.relativePath} · {file.bytes} 字节</span><p>版本：{file.version}</p></li>)}</ul></details>
 </section>;
}
export function WorkCycleResults({value,onOpenFile,onOpenChange}:{value:WorkCycleToolValue;onOpenChange:(changeId:string,file:WorkCycleFile,trigger:HTMLButtonElement)=>void}&FileActions){
 return <div className="work-cycle-results">{value.kind==='work_list'?<WorkCycleFiles files={value.files} onOpenFile={onOpenFile}/>:
  value.kind==='work_read'?<><p>{value.file.relativePath} · 返回的工作文件片段</p><pre>{value.text}</pre>{value.nextOffset!==null&&<p>文件尚未读完。</p>}<WorkCycleFiles files={[value.file]} onOpenFile={onOpenFile}/></>:
  value.kind==='work_write'||value.kind==='work_edit'||value.kind==='work_import'?<><p>{value.file.confirmation==='unconfirmed'?'文件写入结果待核对':value.kind==='work_import'?'项目资料已复制并核对':value.changed?(value.previousVersion===null?'已创建并核对工作文件':'工作文件修改已核对'):'工作文件内容未改变'} </p><WorkCycleFiles files={[value.file]} onOpenFile={onOpenFile}/><button type="button" onClick={event=>onOpenChange(value.changeId,value.file,event.currentTarget)}>查看差异</button></>:
  <WorkCycleExecutionResult execution={value.execution} onOpenFile={onOpenFile}/>}</div>;
}
export function WorkCycleFilePreview({content}:{content:WorkCycleFileContent}){
 return <section className="work-cycle-file-preview" aria-label="工作文件内容"><p className="engine-pilot-muted">{workFileConfirmation(content.file)} · {content.file.bytes} 字节</p>
  {/\.md$/iu.test(content.file.relativePath)?<ChatMarkdown text={content.text}/>:<pre>{content.text}</pre>}</section>;
}
export function WorkCycleChangePreview({change}:{change:WorkCycleChange}){
 return <section className="work-cycle-change-preview" aria-label="工作文件差异"><p>{change.before===null?'新建文件':change.changed?'文件修改':'内容未改变'} · {workFileConfirmation(change.file)}</p>
  <TextDiff before={change.before??''} after={change.after}/></section>;
}
