import { createHash } from 'node:crypto';
import { WSL_RESULTS_VERSION, type WslResultsBinding, type WslResultsListValue } from '../../apps/desktop/src/shared/agent/wsl-results';
import { WAVEFORM_CONVERTER, WAVEFORM_RESULTS_VERSION, waveformSourceFingerprintPayload, waveformExcerptPayload,
  type WaveformSource, type WaveformTrace, type WaveformListValue, type WaveformReadValue, type WaveformMetricsValue } from '../../apps/desktop/src/shared/agent/waveform-results';
import { calculateAcMetrics } from '../../apps/desktop/src/main/waveform-results/ac-metrics';

export const waveHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const waveBinding: WslResultsBinding = { distro:'ROCKY9_LLM_LAB',user:'maxwell',rootPath:'/home/maxwell/simulation/synthetic/results',id:'wsl-binding-wave-test',rootIdentity:'1:2',readerVersion:WSL_RESULTS_VERSION,selectedAt:'2026-09-15T00:00:00.000Z' };
export const waveRawBytes = 256;
const sourceBase = { binding:waveBinding,readerVersion:WAVEFORM_RESULTS_VERSION,format:'psfbin-1.1' as const,analysis:'ac' as const,
  files:[{relativePath:'ac.ac',fileIdentity:'10:20',version:'10:20:256:1:1',bytes:waveRawBytes,rawSha256:waveHash('synthetic binary fixture identity')}],converter:WAVEFORM_CONVERTER };
export const waveSource: WaveformSource = {...sourceBase,sourceVersion:waveHash(waveformSourceFingerprintPayload(sourceBase))};
export const waveTraces: readonly WaveformTrace[] = [
  {traceId:'wave-trace-out',signalName:'VOUT',unit:'V',sampleType:'complex',frequencyUnit:'Hz',totalPoints:3},
  {traceId:'wave-trace-in',signalName:'VIN',unit:'V',sampleType:'complex',frequencyUnit:'Hz',totalPoints:3},
];
export const waveArguments = {
  wsl_waveform_list:{bindingId:waveBinding.id,relativePath:'ac.ac',analysis:'ac' as const,nameQuery:'',cursor:null},
  wsl_waveform_read:{bindingId:waveBinding.id,traceId:waveTraces[0]!.traceId,sourceVersion:waveSource.sourceVersion,startPoint:0,maxPoints:128},
  wsl_waveform_metrics:{bindingId:waveBinding.id,sourceVersion:waveSource.sourceVersion,numerator:{positiveTraceId:waveTraces[0]!.traceId,negativeTraceId:null},denominator:{positiveTraceId:waveTraces[1]!.traceId,negativeTraceId:null}},
};
export const waveDiscovery: WslResultsListValue = {kind:'wsl_results_list',binding:waveBinding,relativeDirectory:'',entries:[{name:'ac.ac',relativePath:'ac.ac',kind:'file',readability:'binary_result',bytes:waveRawBytes,fileId:null,version:null}],nextCursor:null,complete:true,physicalReadBytes:0,scannedCandidates:1};
export const waveList: WaveformListValue = {kind:'wsl_waveform_list',source:waveSource,relativePath:'ac.ac',nameQuery:'',traces:waveTraces,nextCursor:null,complete:true,physicalReadBytes:waveRawBytes*3,scannedCandidates:1};
const points = [{frequencyHz:1,real:10,imag:0},{frequencyHz:10,real:5,imag:-5},{frequencyHz:100,real:0.1,imag:-0.5}];
const readBase: WaveformReadValue = {kind:'wsl_waveform_read',source:waveSource,trace:waveTraces[0]!,startPoint:0,endPoint:2,points,nextPoint:null,complete:true,citationId:'wave-cite-read',excerptSha256:'',physicalReadBytes:waveRawBytes*3,scannedCandidates:1};
export const waveRead: WaveformReadValue = {...readBase,excerptSha256:waveHash(waveformExcerptPayload(readBase))};
const metricsBase: WaveformMetricsValue = {kind:'wsl_waveform_metrics',source:waveSource,numerator:waveArguments.wsl_waveform_metrics.numerator,denominator:waveArguments.wsl_waveform_metrics.denominator,traces:waveTraces,
  metrics:calculateAcMetrics({analysis:'ac',frequencyUnit:'Hz',numerator:{positiveSignal:'VOUT',negativeSignal:'0',unit:'V'},denominator:{positiveSignal:'VIN',negativeSignal:'0',unit:'V'},samples:points.map(p=>({frequencyHz:p.frequencyHz,numerator:{real:p.real,imag:p.imag},denominator:{real:1,imag:0}}))}),
  citationId:'wave-cite-metrics',excerptSha256:'',physicalReadBytes:waveRawBytes*3,scannedCandidates:1};
export const waveMetrics: WaveformMetricsValue = {...metricsBase,excerptSha256:waveHash(waveformExcerptPayload(metricsBase))};
export const waveValues = {wsl_waveform_list:waveList,wsl_waveform_read:waveRead,wsl_waveform_metrics:waveMetrics};
