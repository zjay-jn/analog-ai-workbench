import type {WorkCycleExecution,WorkCycleFile} from '../../shared/agent/agent-work-cycle';
import type {WorkCycleToolValue} from '../../shared/agent/agent-work-cycle';
import type {ProjectReadToolValue} from '../../shared/agent/agent-project-read';

export const isWorkCycleValue=(value:ProjectReadToolValue):value is WorkCycleToolValue=>['work_list','work_read','work_write','work_edit','work_import','work_run'].includes(value.kind);

/** Execution completion is deliberately narrower than a model's claim that its goal is done. */
export function workExecutionOutcome(execution:WorkCycleExecution):{kind:'verified'|'pending'|'failed';label:string;detail:string}{
 if(execution.termination==='cancelled')return {kind:'failed',label:'分析已停止',detail:'保留已收到的日志与工作文件；未确认产物不作为交付结果。'};
 if(execution.termination==='timed_out')return {kind:'failed',label:'分析超时',detail:'可结合日志缩小分析范围，修改程序后再运行。'};
 if(execution.termination==='limit')return {kind:'failed',label:'分析达到运行限制',detail:'可结合日志减少输出或工作量，修改程序后再运行。'};
 if(execution.termination==='isolation_failed')return {kind:'failed',label:'分析环境不可用',detail:'尚不能确认程序运行成功。工作文件与已有记录仍可查看。'};
 if(execution.exitCode===null)return {kind:'pending',label:'退出结果未确认',detail:'尚未收到可靠退出码，不能确认分析成功。'};
 if(execution.exitCode!==0)return {kind:'failed',label:'分析执行失败',detail:'可结合错误日志和工作文件差异，修改程序后再运行。'};
 if(execution.signal!==null)return {kind:'pending',label:'退出结果待核对',detail:'记录包含终止信号，尚不能标记正常交付。'};
 if(!execution.cleanupConfirmed)return {kind:'pending',label:'执行资源释放待确认',detail:'请等待或核对收尾结果，尚不能标记交付完成。'};
 if(!execution.verified)return {kind:'pending',label:'程序已退出，结果待核对',detail:'退出码为0；产物尚未完成实际回读核验。'};
 if(!execution.artifacts.length)return {kind:'pending',label:'程序已退出，未交付文件',detail:'退出码为0，但本次没有已核对的文件产物。'};
 if(!execution.artifacts.every(file=>file.confirmation==='confirmed'&&file.origin.kind==='execution'&&file.origin.executionId===execution.executionId))return {kind:'pending',label:'产物尚未全部核对',detail:'存在尚未确认或不属于本次执行的文件，不能标记交付完成。'};
 return {kind:'verified',label:'产物已生成并核对',detail:'程序正常退出，以下产物已完成回读核验。是否满足任务要求仍需结合内容判断。'};
}
export const workFileConfirmation=(file:WorkCycleFile)=>file.confirmation==='confirmed'?'已核对':'写入结果待核对';
export const workExecutionActiveLabel=(stopping:boolean,ended:boolean)=>stopping?'已请求停止，等待实际退出。':ended?'尚无已确认的分析结果；保留工作文件，未自动重新执行。':'正在准备或运行分析…';

/** Historical tool events cannot override a later workspace read or recovery downgrade. */
export function reconcileWorkValue(value:WorkCycleToolValue,current:readonly WorkCycleFile[]):WorkCycleToolValue{
 const reconcile=(file:WorkCycleFile):WorkCycleFile=>{
  const latest=current.find(item=>item.fileId===file.fileId&&item.version===file.version&&item.relativePath===file.relativePath&&item.bytes===file.bytes&&JSON.stringify(item.origin)===JSON.stringify(file.origin));
  return {...file,confirmation:latest?.confirmation??'unconfirmed'};
 };
 if(value.kind==='work_list')return {...value,files:value.files.map(reconcile)};
 if(value.kind==='work_run')return {...value,execution:{...value.execution,artifacts:value.execution.artifacts.map(reconcile)}};
 return {...value,file:reconcile(value.file)};
}
