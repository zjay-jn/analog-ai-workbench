import type {ToolOutputDescriptor} from '../../shared/agent/tool-output';

/** These labels describe returned content, never the outcome of the enclosing task. */
export function toolOutputLabel(output:ToolOutputDescriptor|null){
 if(!output||output.state==='complete')return '已返回';
 return output.state==='pending'?'暂无新增内容':output.state==='limited'?'已返回 · 保存不完整':'已返回部分内容';
}

export function ToolOutputSummary({output}:{output:ToolOutputDescriptor}){
 const stored=output.source.retention==='stored_work_file';
 return <div className="engine-pilot-muted" aria-label="工具返回范围">
  <p>工具当时返回 {output.returnedBytes} 字节{output.range?`，范围 ${output.range.start}–${output.range.end}（终点不含）`:''}{output.totalBytes!==null?`；来源共 ${output.totalBytes} 字节`:''}。</p>
  <p>{stored?'工作文件保存在本地；点击下方文件名核对并查看完整文件。':output.source.kind==='filesystem'?'已保存本次结果与来源位置；未另存完整源文件。':'已保存引用片段；完整内容仍来自源文件，未另存整份文件。'}</p>
  {!stored&&output.continuation&&<p>尚有后续内容；模型可在原任务运行期间从已记录的位置继续读取。</p>}
 </div>;
}
