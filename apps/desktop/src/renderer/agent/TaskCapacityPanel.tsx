import type {TaskCapacity,TaskCapacityBytes,TaskCapacityEntry} from '../../shared/agent/agent-task-capacity';
import type {ProjectReadController,ProjectReadViewState} from './project-read-controller';

export function capacityBytes(value:number){
  if(value<1024)return `${value} B`;
  const units=['KiB','MiB','GiB','TiB'];let amount=value/1024,index=0;
  while(amount>=1024&&index<units.length-1){amount/=1024;index++;}
  return `${amount.toFixed(1)} ${units[index]}`;
}
function CapacityBreakdown({bytes}:{bytes:TaskCapacityBytes}){
  return <dl className="task-capacity-breakdown">{([
    ['任务记录与引用',bytes.taskBytes],['命令日志',bytes.logBytes],['工作文件',bytes.workspaceBytes],['合计',bytes.totalBytes],
  ] as const).map(([label,value])=><div key={label}><dt>{label}</dt><dd title={`${value} 字节`}>{capacityBytes(value)}</dd></div>)}</dl>;
}
export function capacityBlock(entry:TaskCapacityEntry){
  const reasons={active:'任务仍在运行，暂不能删除。',cleanup_unconfirmed:'执行资源收尾尚未确认，暂不能删除。',referenced:'仍有其他任务引用这些记录或成果，暂不能删除。',storage_unknown:'存储状态尚未确认，暂不能删除。',storage_changed:'存储内容已变化，请重新核对。'};
  if(entry.blockedReason)return reasons[entry.blockedReason];
  if(!entry.complete)return '统计不完整，暂不能确认删除范围。';
  if(!entry.canDelete)return '当前尚不具备删除条件，请刷新核对。';
  return '';
}
export function TaskCapacityPanel({capacity,loading,error,onRefresh,onClose}:{capacity:TaskCapacity|null;loading:boolean;error:string|null;onRefresh:()=>void;onClose:()=>void}){
  return <section className="project-read-inspection task-capacity-panel" aria-label="工具任务存储用量">
    <header><strong>存储用量</strong><div><button type="button" disabled={loading} onClick={onRefresh}>重新统计</button><button type="button" onClick={onClose}>收起</button></div></header>
    <p className="engine-pilot-muted">全部项目的工具任务 · 文件逻辑字节，非磁盘实际占用；不含原项目文件。</p>
    <p className="engine-pilot-muted">统计范围：工具任务主记录、独占工作文件、命令日志和执行副本。不含共享引擎缓存，其中可能保留会话副本。</p>
    {loading&&<p role="status">正在统计…</p>}{error&&<p role="alert">{error}</p>}
    {capacity&&<><p>{capacity.runs.length} 个任务{!capacity.complete?' · 统计不完整，仅显示已确认部分':''}</p><CapacityBreakdown bytes={capacity.totals}/>
      <p className="engine-pilot-muted">统计时间：{capacity.measuredAt}。从任务的管理菜单查看删除影响。</p></>}
  </section>;
}
type DeleteActions=Pick<ProjectReadController,'prepareDeletion'|'cancelDeletion'|'deleteRun'|'select'>;
export function TaskDeletionPreview({state,actions}:{state:ProjectReadViewState;actions:DeleteActions}){
  const target=state.deletionTarget,entry=state.deletionPreview;
  if(!target)return state.deletionNotice?<p role="status">{state.deletionNotice}</p>:null;
  const blocked=entry?capacityBlock(entry):'',busy=!!state.pending||state.capacityLoading;
  const dependencies=[...new Set([...(entry?.dependentRunIds??[]),...state.deleteDependents])];
  return <section className="project-read-inspection task-capacity-panel" role="group" aria-label="删除影响预览">
    <header><strong>删除“{target.goal}”</strong></header><p>项目：{target.project.name}</p>
    <p>删除范围：此工具任务的主记录、独占工作文件、命令日志和执行副本；原项目文件保留。不含共享引擎缓存，其中可能保留会话副本。</p>
    {state.capacityLoading&&<p role="status">正在核对容量与引用关系…</p>}
    {state.capacityError&&<p role="alert">{state.capacityError}</p>}{state.deletionNotice&&<p role="status">{state.deletionNotice}</p>}
    {entry&&<><CapacityBreakdown bytes={entry}/><p className="engine-pilot-muted">{entry.complete?'以上为待处理文件的逻辑大小，不代表实际磁盘释放量。':'统计不完整，仅显示已确认部分；无法确定可回收大小。'}</p>
      {entry.deletionState!=='none'&&<p>此前删除未完成。请核对本次剩余数据与状态后，再决定是否重试。</p>}{blocked&&<p role="status">{blocked}</p>}</>}
    {dependencies.length>0&&<div role="group" aria-label="引用此任务的后续任务"><p>引用此任务的后续任务：</p>{dependencies.map(id=><button type="button" key={id} disabled={!!state.pending} onClick={()=>{actions.cancelDeletion();void actions.select(id);}}>{state.runs.find(run=>run.runId===id)?.goal??id}</button>)}</div>}
    {!entry&&!state.capacityLoading&&<p>请核对删除影响后再确认。</p>}
    {(state.workContinuation||state.startUnconfirmed)&&<p>请先完成未确认的开始请求或退出续接草稿。</p>}
    <div className="project-read-scope-actions"><button type="button" disabled={busy} onClick={()=>void actions.prepareDeletion(target.runId)}>重新核对</button>
      <button type="button" disabled={busy||!entry||!!blocked||!!state.workContinuation||state.startUnconfirmed} onClick={()=>void actions.deleteRun(target.runId)}>{state.pending==='delete'?'正在删除…':'确认删除'}</button>
      <button type="button" disabled={state.pending==='delete'} onClick={()=>actions.cancelDeletion()}>取消</button></div>
  </section>;
}
