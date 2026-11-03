import type {ProjectReadCode} from '../../shared/agent/agent-project-read';
import type {WaveformMetricsValue,WaveformReadValue,WaveformVoltageSelection} from '../../shared/agent/waveform-results';
import {wslResultsError} from './wsl-results-presentation';
export type WaveformCitation=WaveformReadValue|WaveformMetricsValue;
const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,ordered(item)])):value;
/** Compare every validated source, selection, sample, result and digest field, independent of object key order. */
export const waveformCitationIdentity=(value:WaveformCitation)=>JSON.stringify(ordered(value));
export const waveNumber=(value:number|null)=>value===null?'未确定':Number.isFinite(value)?Number(value.toPrecision(7)).toString():'无效';
export function waveformPort(value:WaveformMetricsValue,port:WaveformVoltageSelection,explicitGround=false){
 const name=(id:string)=>value.traces.find(trace=>trace.traceId===id)?.signalName??'未确认信号';
 return port.negativeTraceId===null?(explicitGround?`${name(port.positiveTraceId)} − 0`:name(port.positiveTraceId)):`(${name(port.positiveTraceId)} − ${name(port.negativeTraceId)})`;
}
export const waveformTransfer=(value:WaveformMetricsValue)=>`H(f) = ${waveformPort(value,value.numerator)} / ${waveformPort(value,value.denominator)}`;
export function waveformResultsError(code:ProjectReadCode){
 const messages:Partial<Record<string,string>>={
  UNSUPPORTED_FORMAT:'此结果格式尚不支持波形读取。',
  UNSUPPORTED_ANALYSIS:'当前波形读取仅支持 AC 分析。',
  UNSUPPORTED_UNIT:'信号或频率单位不支持此计算。',
  UNSUPPORTED_WAVEFORM:'此波形结构尚不支持读取。',
  TRACE_UNAVAILABLE:'所选信号不可用，请重新查询信号。',
  AXIS_MISMATCH:'输入与输出的频率轴不一致，未计算指标。',
  CONVERTER_UNAVAILABLE:'波形读取器不可用，未读取或计算结果。',
  METRIC_INPUT_INVALID:'输入不满足指标计算条件，未生成有效指标。',
  SOURCE_CHANGED:'波形来源已变化，已保存结果保留；新计算需要重新核对来源。',
 };
 return messages[code]??wslResultsError(code);
}

