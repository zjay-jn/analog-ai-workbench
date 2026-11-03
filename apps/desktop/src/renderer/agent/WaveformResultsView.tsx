import type {AcMetricsComputed,AcMetricIssue,AcThresholdEvent,AcCrossingSummary,WaveformSource,WaveformMetricsValue,WaveformResultsToolValue} from '../../shared/agent/waveform-results';
import type {ProjectReadViewState} from './project-read-controller';
import {WslSource} from './WslResultsView';
import {waveNumber,waveformPort,waveformTransfer,waveformResultsError} from './waveform-results-presentation';

function WaveSource({source}:{source:WaveformSource}){
 return <><WslSource binding={source.binding} label="历史 AC 结果来源"/>
  <p>{source.files.map(file=>file.relativePath).join('、')}</p>
  <details><summary>来源与版本</summary><p>格式：{source.format} · 分析：{source.analysis.toUpperCase()}</p>
   {source.files.map(file=><div key={file.relativePath}><p>{source.binding.rootPath}/{file.relativePath} · {file.bytes} 字节</p><p>文件版本：{file.version}</p><p>原文件 SHA-256：{file.rawSha256}</p></div>)}
   <p>来源版本：{source.sourceVersion}</p><p>读取版本：{source.readerVersion} · 转换：Cadence PSF · 精度：{source.converter.precision}</p>
   <p>转换器 SHA-256：{source.converter.executableSha256}</p>
  </details></>;
}
const directions={rising:'上升穿越',falling:'下降穿越',indeterminate:'方向未确定'};
const kinds={interpolated_crossing:'插值交点',sample_crossing:'样点交点',boundary_contact:'边界接触',tangent_contact:'相切接触',threshold_plateau:'阈值平台'};
const methods={linear_db_and_unwrapped_phase_in_log10_hz:'在 log10(Hz) 轴上线性插值增益 dB 与展开相位',exact_sample:'恰好命中原样点',threshold_interval:'阈值区间，无唯一交点'};
function ThresholdEvent({event}:{event:AcThresholdEvent}){
 const {lower,upper}=event.bracket;
 return <div className="waveform-threshold"><p>{kinds[event.kind]} · {directions[event.direction]} · {event.frequencyHz===null?`${waveNumber(lower.frequencyHz)}–${waveNumber(upper.frequencyHz)} Hz（区间）`:`${waveNumber(event.frequencyHz)} Hz`}</p>
  <p>AC 展开相位：{event.phaseUnwrappedDeg===null?'未确定':`${waveNumber(event.phaseUnwrappedDeg)}°`}{event.screening180PlusPhaseDeg!==null&&` · 180° + 相位：${waveNumber(event.screening180PlusPhaseDeg)}°（仅 AC 筛查）`}</p>
  <details><summary>样点与插值依据</summary><p>{methods[event.bracket.method]}{event.bracket.fraction!==null?` · 插值比例 ${event.bracket.fraction}`:''}</p>
   <table><thead><tr><th>样点</th><th>频率 / Hz</th><th>增益 / dB</th><th>展开相位 / °</th></tr></thead><tbody>{(lower.index===upper.index?[lower]:[lower,upper]).map(point=><tr key={point.index}><td>{point.index+1}</td><td>{point.frequencyHz}</td><td>{point.gainDb}</td><td>{point.phaseUnwrappedDeg}</td></tr>)}</tbody></table>
  </details>
 </div>;
}
const crossingStatus:Record<AcCrossingSummary['status'],string>={insufficient_samples:'样点不足',no_crossing:'扫描范围内无穿越交点',single_crossing:'一个穿越交点',multiple_crossings:'多个穿越交点',indeterminate_contact:'只有接触或平台，未确定穿越'};
function Crossings({summary}:{summary:AcCrossingSummary}){
 return <><p>{crossingStatus[summary.status]} · 阈值 {waveNumber(summary.targetGainDb)} dB</p>
  {summary.crossings.map((event,index)=><ThresholdEvent key={`crossing-${index}`} event={event}/>)}
  {summary.contacts.length>0&&<details><summary>接触与平台（{summary.contacts.length}）</summary>{summary.contacts.map((event,index)=><ThresholdEvent key={index} event={event}/>)}</details>}
 </>;
}
const bandwidthStatus:Record<AcMetricsComputed['bandwidth']['status'],string>={insufficient_samples:'样点不足',not_found_in_sweep:'扫描范围内未找到',found:'已找到',multiple_falling_crossings:'多个下降交点，按定义取首个',indeterminate_contact:'接触或平台，带宽未确定'};
const issueLabels:Record<AcMetricIssue['code'],string>={invalid_shape:'数据结构不完整',unsupported_analysis:'分析类型不支持',invalid_unit:'单位不支持',invalid_port:'输入输出定义无效',sample_limit:'样点数超过计算限制',invalid_frequency:'频率无效',frequency_not_increasing:'频率未严格递增',invalid_complex:'复数样点无效',zero_denominator:'输入差分电压为零',zero_numerator:'输出差分电压为零，对数或相位不定义',numeric_range:'数值超出可计算范围'};
function Metrics({value}:{value:WaveformMetricsValue}){
 const result=value.metrics;
 return <><h3>AC 指标（确定性计算）</h3><p className="waveform-transfer">{waveformTransfer(value)}</p>
  <p>分子：{waveformPort(value,value.numerator,true)} V；分母：{waveformPort(value,value.denominator,true)} V。0 表示参考地。</p>
  {result.status==='invalid_input'?<p role="status">无法计算：{issueLabels[result.issue.code]}{result.issue.sampleIndex!==null?`（样点 ${result.issue.sampleIndex+1}）`:''}。</p>:<>
   <p>{result.sampleCount} 个样点 · {result.frequencyRangeHz?`${waveNumber(result.frequencyRangeHz.first)}–${waveNumber(result.frequencyRangeHz.last)} Hz`:'频率范围未确定'}{result.status==='insufficient_samples'?' · 样点不足，部分指标未确定':''}</p>
   <dl className="waveform-metrics-summary"><div><dt>首频点增益</dt><dd title={result.firstFrequencyPoint?String(result.firstFrequencyPoint.gainDb):undefined}>{result.firstFrequencyPoint?`${waveNumber(result.firstFrequencyPoint.gainDb)} dB @ ${waveNumber(result.firstFrequencyPoint.frequencyHz)} Hz`:'未确定'}</dd></div>
    <div><dt>相对 −3 dB 带宽</dt><dd>{result.bandwidth.firstFallingCrossing?.frequencyHz!=null?`${waveNumber(result.bandwidth.firstFallingCrossing.frequencyHz)} Hz · `:''}{bandwidthStatus[result.bandwidth.status]}</dd></div></dl>
   <p className="engine-pilot-muted">带宽以首频点增益减 3 dB 为阈值，取首个下降交点；首频点不等同于 DC，带宽不直接代表主极点。</p>
   <details><summary>−3 dB 交点与依据</summary>{result.bandwidth.threshold?<Crossings summary={result.bandwidth.threshold}/>:<p>样点不足，阈值尚未确定。</p>}</details>
   <section aria-label="0 dB 交点"><h4>0 dB 交点</h4><Crossings summary={result.unityGain}/></section>
   <details><summary>计算方法</summary><p>增益：20 · log10(|H(f)|)。插值使用 log10(频率) 轴上的增益 dB 与展开相位，不向扫描范围之外外推。</p>
    <p>相位从首点主值起，按相邻最短相位变化展开；样点间额外相位圈数无法恢复。</p>
    {result.phaseUnwrap.exact180StepIndices.length>0&&<p>相邻相位差恰为 180° 的样点：{result.phaseUnwrap.exact180StepIndices.map(index=>index+1).join('、')}；展开依赖固定规则。</p>}
    {result.gainTrend==='has_rising_steps'&&<p>增益包含上升段，带宽仍按首个下降交点定义。</p>}
   </details>
  </>}
  <p className="engine-pilot-muted">相位与 180° + 相位仅用于此传递函数的 AC 筛查，不是环路相位裕度、STB 或稳定性证明。此为历史波形的派生计算结果。</p>
  <details><summary>算法版本</summary><p>{result.algorithmVersion}</p></details>
 </>;
}
export function WaveformResultsView({value,onCitation}:{value:WaveformResultsToolValue;onCitation?:(id:string,trigger:HTMLButtonElement)=>void}){
 return <div className="project-read-results waveform-results"><WaveSource source={value.source}/>
  {value.kind==='wsl_waveform_list'?<>
   <h3>AC 信号</h3><p>{value.complete?'本次信号查询结束':'本次信号查询尚未结束'}{value.nameQuery?` · 名称包含“${value.nameQuery}”`:''}</p>
   {value.traces.length?<table><thead><tr><th>信号</th><th>单位</th><th>频率轴</th><th>样点数</th></tr></thead><tbody>{value.traces.map(trace=><tr key={trace.traceId}><td>{trace.signalName}</td><td>{trace.unit}（复数）</td><td>{trace.frequencyUnit}</td><td>{trace.totalPoints}</td></tr>)}</tbody></table>:<p>本页未返回匹配信号。</p>}
  </>:value.kind==='wsl_waveform_read'?<>
   <h3>{value.trace.signalName} · 复数波形 / {value.trace.unit}</h3>
   <p>样点 {value.startPoint+1}–{value.endPoint+1} / {value.trace.totalPoints} · {value.complete?'本页已到末尾':'本页尚未到末尾'}{value.startPoint>0?'；本页不包含此前样点':''}</p>
   <p>本页频率：{waveNumber(value.points[0]!.frequencyHz)}–{waveNumber(value.points[value.points.length-1]!.frequencyHz)} Hz</p>
   <details><summary>查看本页复数样点（{value.points.length}）</summary><table><thead><tr><th>样点</th><th>频率 / Hz</th><th>实部 / {value.trace.unit}</th><th>虚部 / {value.trace.unit}</th></tr></thead><tbody>{value.points.map((point,index)=><tr key={value.startPoint+index}><td>{value.startPoint+index+1}</td><td>{point.frequencyHz}</td><td>{point.real}</td><td>{point.imag}</td></tr>)}</tbody></table></details>
  </>:<Metrics value={value}/>}
  {value.kind!=='wsl_waveform_list'&&onCitation&&<button type="button" onClick={event=>onCitation(value.citationId,event.currentTarget)}>查看已保存{value.kind==='wsl_waveform_read'?'波形':'计算'}依据</button>}
 </div>;
}
export function WaveformCitationContext({state,onCheck}:{state:ProjectReadViewState;onCheck:()=>void}){
 return <><p>显示任务时保存的波形或计算结果；打开历史不会读取 WSL 或重新计算。</p>
  <button type="button" disabled={state.inspecting||!!state.pending} onClick={onCheck}>核对当前波形来源</button>
  {state.inspecting&&<p role="status">正在核对来源…</p>}
  {state.citationCheck?<p role="status">{state.citationCheck.state==='current'?'核对时来源版本一致。':state.citationCheck.state==='changed'?'来源已变化，已保存结果保留。':'当前来源无法核对，已保存结果保留。'}{state.citationCheck.reason&&waveformResultsError(state.citationCheck.reason)}</p>:<p>尚未核对当前来源。</p>}
 </>;
}

