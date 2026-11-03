import {useEffect,useState} from 'react';
import type {WslResultsBinding,WslResultsToolValue,WslResultsReadValue} from '../../shared/agent/wsl-results';
import {WSL_RESULTS_ENVIRONMENT} from '../../shared/agent/wsl-results';
import type {ProjectReadController,ProjectReadViewState} from './project-read-controller';
import {wslResultsError} from './wsl-results-presentation';

export function WslSource({binding,label}:{binding:WslResultsBinding;label:string}){
 return <div className="wsl-results-source"><p>{label} · {binding.distro} / {binding.user} · 只读</p><p>{binding.rootPath}</p></div>;
}
type BindingActions=Pick<ProjectReadController,'refreshWslBinding'|'selectWslBinding'|'clearWslBinding'>;
export function WslResultsSettings({state,actions}:{state:ProjectReadViewState;actions:BindingActions}){
 const [path,setPath]=useState('');
 const binding=state.wslProjectId===state.projectId?state.wslBinding:null,known=state.wslProjectId===state.projectId&&state.wslBindingKnown;
 useEffect(()=>setPath(binding?.rootPath??''),[state.projectId,binding?.id]);
 const disabled=!!state.pending||state.wslBindingLoading||!known||state.startUnconfirmed||!!state.workContinuation;
 return <details className="wsl-results-settings"><summary>实验 WSL 结果 · {known?binding?'已保存连接':'未连接':'保存状态待核对'}</summary>
  {binding&&<WslSource binding={binding} label={known?'后续任务来源':'上次读取的保存来源（待核对）'}/>}
  <p className="engine-pilot-muted">连接 {WSL_RESULTS_ENVIRONMENT.distro} / {WSL_RESULTS_ENVIRONMENT.user} 中已有的文本、日志及支持的 AC 波形。新任务按需读取或计算，历史任务保留各自来源。</p>
  <label>结果目录<input type="text" aria-label="WSL 结果目录" value={path} disabled={disabled} onChange={event=>setPath(event.target.value)} placeholder="/home/maxwell/simulation/实验结果目录" spellCheck={false}/></label>
  <div className="project-read-scope-actions"><button type="button" disabled={disabled||!path.trim()} onClick={()=>void actions.selectWslBinding(path)}>连接结果目录</button>
   {binding&&<button type="button" disabled={disabled} onClick={()=>void actions.clearWslBinding()}>取消连接</button>}
   <button type="button" disabled={!!state.pending||state.wslBindingLoading||!state.projectId} onClick={()=>void actions.refreshWslBinding()}>核对保存状态</button></div>
  {state.wslBindingLoading&&<p role="status">正在读取保存的来源…</p>}{state.pending==='wsl'&&<p role="status">正在处理连接…</p>}
  {state.wslBindingError&&<p role="alert">{state.wslBindingError}</p>}{state.wslBindingNotice&&<p role="status">{state.wslBindingNotice}</p>}
 </details>;
}
export function WslResultsView({value,onCitation}:{value:WslResultsToolValue;onCitation:(id:string,trigger:HTMLButtonElement)=>void}){
 const binding=value.kind==='wsl_results_list'?value.binding:value.source;
 return <div className="project-read-results wsl-results-view"><WslSource binding={binding} label="本次工具来源"/>
  {value.kind==='wsl_results_list'?<>
   <p>目录：{value.relativeDirectory||'结果根目录'} · {value.complete?'本次目录查询结束':'本次目录查询尚未结束'} · 返回 {value.entries.length} 项</p>
   <ul>{value.entries.map(entry=><li key={entry.relativePath}>{entry.relativePath} · {entry.kind==='directory'?'文件夹':`${entry.bytes} 字节`}
    {entry.readability==='binary_result'?' · 二进制结果，仅列出文件信息，尚未读取波形':entry.readability==='unsupported'?' · 不支持读取':entry.readability==='file_limit'?' · 超出读取限制':''}</li>)}</ul>
   <p className="engine-pilot-muted">本次仅查询目录信息，未读取文件正文。</p>
  </>:<>
   <button type="button" onClick={event=>onCitation(value.citationId,event.currentTarget)}>{value.source.relativePath} · {value.totalLines?`第 ${value.startLine}–${value.endLine} 行 / ${value.totalLines} 行`:'空文件'} · 查看历史依据</button>
   <p>{value.complete?'本片段已到文件末尾。':`本片段尚未到文件末尾，后续从第 ${value.nextLine} 行读取。`}{value.startLine>1&&'本片段不包含此前各行。'}</p>
   <pre>{value.text}</pre><p className="engine-pilot-muted">历史结果与日志，不代表本次执行了仿真。</p>
  </>}
 </div>;
}
export function WslCitationContext({value,state,onCheck}:{value:WslResultsReadValue;state:ProjectReadViewState;onCheck:()=>void}){
 return <><WslSource binding={value.source} label="任务时保存的来源"/><p>{value.source.absolutePath}</p>
  <p>{value.totalLines?`第 ${value.startLine}–${value.endLine} 行 / ${value.totalLines} 行`:'空文件'} · 文件版本：{value.version}</p>
  <p>此处显示已保存片段。打开历史引用不会访问 WSL 源文件。</p>
  <button type="button" disabled={state.inspecting||!!state.pending} onClick={onCheck}>核对当前 WSL 文件</button>
  {state.inspecting&&<p role="status">正在核对当前 WSL 文件…</p>}
  {state.citationCheck?<p role="status">{state.citationCheck.state==='current'?'核对时文件版本一致。':state.citationCheck.state==='changed'?'源文件已变化，保留任务时片段。':'当前文件无法核对，保留任务时片段。'}{state.citationCheck.reason&&wslResultsError(state.citationCheck.reason)}</p>:<p>尚未核对当前文件。</p>}
  <details><summary>来源版本详情</summary><p>文件 SHA-256：{value.rawSha256}</p><p>片段 SHA-256：{value.excerptSha256}</p></details>
 </>;
}
