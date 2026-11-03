import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AGENT_PROJECT_READ_VERSION as V,type WorkbenchAgentProjectReadApi,type ProjectReadEvent,type ProjectReadSummary,type ProjectReadRequests} from '../apps/desktop/src/shared/agent/agent-project-read';
import {WSL_RESULTS_VERSION} from '../apps/desktop/src/shared/agent/wsl-results';
import {WAVEFORM_RESULTS_VERSION,WAVEFORM_CONVERTER,AC_METRICS_ALGORITHM_VERSION,parseWaveformResultsToolValue,type WaveformSource,type WaveformTrace,type WaveformReadValue,type WaveformMetricsValue,type AcMetricsComputed,type AcThresholdEvent,type WaveformListValue} from '../apps/desktop/src/shared/agent/waveform-results';
import {WaveformResultsView,WaveformCitationContext} from '../apps/desktop/src/renderer/agent/WaveformResultsView';
import {ProjectReadResults} from '../apps/desktop/src/renderer/agent/ProjectReadResults';
import {ProjectReadView} from '../apps/desktop/src/renderer/agent/ProjectReadPanel';
import {createProjectReadController} from '../apps/desktop/src/renderer/agent/project-read-controller';
import {projectReadEvents,projectMessageCitations} from '../apps/desktop/src/renderer/agent/project-read-presentation';

const time='2026-09-15T00:00:00.000Z';
const source:WaveformSource={binding:{distro:'ROCKY9_LLM_LAB',user:'maxwell',rootPath:'/home/maxwell/simulation/wave-fixture',id:'wsl-binding-a',rootIdentity:'1:10',readerVersion:WSL_RESULTS_VERSION,selectedAt:time},readerVersion:WAVEFORM_RESULTS_VERSION,format:'psfbin-1.1',analysis:'ac',sourceVersion:'a'.repeat(64),files:[{relativePath:'ac.ac',fileIdentity:'1:2',version:'1:2:120:3:4',bytes:120,rawSha256:'b'.repeat(64)}],converter:WAVEFORM_CONVERTER};
const trace=(name:string,id:string):WaveformTrace=>({traceId:id,signalName:name,unit:'V',sampleType:'complex',frequencyUnit:'Hz',totalPoints:3});
const traces=[trace('VOUT','wave-vout'),trace('VIP','wave-vip'),trace('VIN','wave-vin')];
const first={index:0,frequencyHz:100,gainDb:20,phaseWrappedDeg:-10,phaseUnwrappedDeg:-10};
const middle={index:1,frequencyHz:1000,gainDb:17,phaseWrappedDeg:-50,phaseUnwrappedDeg:-50};
const last={index:2,frequencyHz:10000,gainDb:-3,phaseWrappedDeg:-100,phaseUnwrappedDeg:-100};
const bandwidth:AcThresholdEvent={kind:'sample_crossing',direction:'falling',frequencyHz:1000,phaseUnwrappedDeg:-50,screening180PlusPhaseDeg:130,bracket:{lower:middle,upper:middle,fraction:0,method:'exact_sample'}};
const unity:AcThresholdEvent={kind:'interpolated_crossing',direction:'falling',frequencyHz:7079.45784384138,phaseUnwrappedDeg:-92.5,screening180PlusPhaseDeg:87.5,bracket:{lower:middle,upper:last,fraction:0.85,method:'linear_db_and_unwrapped_phase_in_log10_hz'}};
const metrics:AcMetricsComputed={algorithmVersion:AC_METRICS_ALGORITHM_VERSION,status:'ok',definition:{analysis:'ac',frequencyUnit:'Hz',gainUnit:'dB',phaseUnit:'deg',transfer:'numerator_voltage_difference_over_denominator_voltage_difference',numerator:{positiveSignal:'VOUT',negativeSignal:'0',unit:'V'},denominator:{positiveSignal:'VIP',negativeSignal:'VIN',unit:'V'},phaseInterpretation:'ac_screening_only_not_stb_or_stability_proof'},sampleCount:3,frequencyRangeHz:{first:100,last:10000},firstFrequencyPoint:first,lastFrequencyPoint:last,gainTrend:'non_increasing',phaseUnwrap:{method:'first_principal_phase_then_shortest_steps_in_minus180_to_180',exact180StepIndices:[],samplingCaveat:'phase_turns_between_samples_cannot_be_recovered'},
 bandwidth:{definition:'first_falling_crossing_3db_below_first_frequency_gain',referenceGainDb:20,targetGainDb:17,status:'found',firstFallingCrossing:bandwidth,threshold:{status:'single_crossing',targetGainDb:17,crossings:[bandwidth],contacts:[]}},
 unityGain:{status:'single_crossing',targetGainDb:0,crossings:[unity],contacts:[]}};
const calculated:WaveformMetricsValue={kind:'wsl_waveform_metrics',source,numerator:{positiveTraceId:'wave-vout',negativeTraceId:null},denominator:{positiveTraceId:'wave-vip',negativeTraceId:'wave-vin'},traces,metrics,citationId:'wave-metric-a',excerptSha256:'c'.repeat(64),physicalReadBytes:360,scannedCandidates:3};
const read:WaveformReadValue={kind:'wsl_waveform_read',source,trace:traces[0]!,startPoint:1,endPoint:2,points:[{frequencyHz:1000,real:1.2345678901234567,imag:-0.75},{frequencyHz:10000,real:0.25,imag:-0.1}],nextPoint:null,complete:true,citationId:'wave-page-a',excerptSha256:'d'.repeat(64),physicalReadBytes:120,scannedCandidates:1};
const show=(value:Parameters<typeof WaveformResultsView>[0]['value'])=>renderToStaticMarkup(createElement(WaveformResultsView,{value}));

test('WFUI signal units and one-based inclusive sample ranges preserve partial-page meaning and raw numbers',()=>{
 const list:WaveformListValue={kind:'wsl_waveform_list',source,relativePath:'ac.ac',nameQuery:'',traces:[traces[0]!,{...trace('I0','wave-i0'),unit:'A'}],nextCursor:'wave-page-next',complete:false,physicalReadBytes:120,scannedCandidates:2};
 assert(parseWaveformResultsToolValue(list));assert(parseWaveformResultsToolValue(read));
 const html=show(list);assert.match(html,/本次信号查询尚未结束/);assert.match(html,/V（复数）/);assert.match(html,/A（复数）/);assert.match(html,/Hz/);
 const page=show(read);assert.match(page,/样点 2–3 \/ 3/);assert.match(page,/本页不包含此前样点/);assert.match(page,/1.2345678901234567/);assert.match(page,/虚部 \/ V/);assert.match(page,/ROCKY9_LLM_LAB/);assert.match(page,/wave-fixture/);assert.doesNotMatch(page,/全部波形已读取/);
});

test('WFUI metrics show the selected transfer first-frequency reference thresholds method and AC-only phase',()=>{
 assert(parseWaveformResultsToolValue(calculated));const html=show(calculated);
 assert.match(html,/H\(f\) = VOUT \/ \(VIP − VIN\)/);assert.match(html,/分子：VOUT − 0 V/);assert.match(html,/20 dB @ 100 Hz/);assert.match(html,/相对 −3 dB 带宽/);assert.match(html,/1000 Hz · 已找到/);assert.match(html,/7079.458 Hz/);
 assert.match(html,/阈值 17 dB/);assert.match(html,/log10\(Hz\)/);assert.match(html,/0.85/);assert.match(html,/87.5°（仅 AC 筛查）/);assert.match(html,/不是环路相位裕度、STB 或稳定性证明/);assert.match(html,/首频点不等同于 DC/);assert.match(html,/派生计算结果/);assert.match(html,/aaw.ac-metrics\/v1/);
});

test('WFUI absent multiple and plateau crossings remain distinct without zero placeholders',()=>{
 const contact:AcThresholdEvent={...bandwidth,kind:'threshold_plateau',direction:'indeterminate',frequencyHz:null,phaseUnwrappedDeg:null,screening180PlusPhaseDeg:null,bracket:{lower:middle,upper:{...last,gainDb:17},fraction:null,method:'threshold_interval'}};
 const cases=[
  {status:'not_found_in_sweep' as const,firstFallingCrossing:null,threshold:{status:'no_crossing' as const,targetGainDb:17,crossings:[],contacts:[]},label:'扫描范围内未找到'},
  {status:'multiple_falling_crossings' as const,firstFallingCrossing:bandwidth,threshold:{status:'multiple_crossings' as const,targetGainDb:17,crossings:[bandwidth,{...bandwidth,frequencyHz:5000}],contacts:[]},label:'多个下降交点，按定义取首个'},
  {status:'indeterminate_contact' as const,firstFallingCrossing:null,threshold:{status:'indeterminate_contact' as const,targetGainDb:17,crossings:[],contacts:[contact]},label:'接触或平台，带宽未确定'},
 ];
 for(const entry of cases){const {label,...fields}=entry;const html=show({...calculated,metrics:{...metrics,bandwidth:{...metrics.bandwidth,...fields},unityGain:{status:'no_crossing',targetGainDb:0,crossings:[],contacts:[]}}});assert(html.includes(label));assert.match(html,/扫描范围内无穿越交点/);assert.doesNotMatch(html,/>0 Hz/);if(entry.status==='indeterminate_contact'){assert.match(html,/1000–10000 Hz（区间）/);assert.match(html,/无唯一交点/);}}
});

test('WFUI insufficient and invalid metrics cannot look like valid bandwidth or phase results',()=>{
 const insufficient:AcMetricsComputed={...metrics,status:'insufficient_samples',sampleCount:1,frequencyRangeHz:{first:100,last:100},lastFrequencyPoint:first,bandwidth:{...metrics.bandwidth,status:'insufficient_samples',firstFallingCrossing:null,threshold:null,targetGainDb:null,referenceGainDb:null},unityGain:{status:'insufficient_samples',targetGainDb:0,crossings:[],contacts:[]}};
 assert.match(show({...calculated,metrics:insufficient}),/样点不足，部分指标未确定/);
 const invalid=show({...calculated,metrics:{algorithmVersion:AC_METRICS_ALGORITHM_VERSION,status:'invalid_input',issue:{code:'zero_denominator',sampleIndex:0,field:'denominator'}}});
 assert.match(invalid,/输入差分电压为零（样点 1）/);assert.doesNotMatch(invalid,/首频点增益|相对 −3 dB 带宽|NaN|Infinity/);
 for(const code of ['AXIS_MISMATCH','UNSUPPORTED_FORMAT','TRACE_UNAVAILABLE'] as const){const html=renderToStaticMarkup(createElement(ProjectReadResults,{toolName:'wsl_waveform_metrics',result:{ok:false,error:{code},coverage:null},onCitation:()=>{}}));assert.doesNotMatch(html,/AC 指标（确定性计算）/);assert.match(html,/不一致|格式尚不支持|信号不可用/);}
 const textError=renderToStaticMarkup(createElement(ProjectReadResults,{toolName:'wsl_results_read',result:{ok:false,error:{code:'UNSUPPORTED_TEXT'},coverage:null},onCitation:()=>{}}));assert.match(textError,/不是可读取的文本结果/);assert.doesNotMatch(textError,/二进制波形暂不可解析/);
});

function fixture(value:WaveformReadValue|WaveformMetricsValue=calculated){
 const project={projectId:'project-a',bindingId:'binding-a',identity:'identity-a',name:'合成项目',directoryName:'synthetic',directorySegments:['C','synthetic']},model={provider:'deepseek',model:'deepseek-v4-flash'} as const;
 const budget={providerAttempts:24,httpDispatches:24,toolAttempts:64,physicalReadBytes:268435456,visitedCandidates:100000,contextBytes:196608,outputBytes:65536,maxOutputTokens:16384,deadlineMs:600000,waitMs:600000};
 const run:ProjectReadSummary={runId:'wave-run',clientRequestId:'client-wave',project,model,goal:'合成 AC 波形结果',constraint:'',continuedFrom:null,status:'completed',cleanupState:'idle',createdAt:time,updatedAt:time,accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:1,physicalReadBytes:120,visitedCandidates:1,contextBytes:null},eventCount:5,continuation:null,wslResultsBinding:source.binding};
 const base={sessionId:'session-a',messageId:'message-a',callId:'call-a'};
 const call=value.kind==='wsl_waveform_metrics'?{...base,toolName:value.kind,arguments:{bindingId:source.binding.id,sourceVersion:source.sourceVersion,numerator:value.numerator,denominator:value.denominator}}:{...base,toolName:value.kind,arguments:{bindingId:source.binding.id,traceId:value.trace.traceId,sourceVersion:source.sourceVersion,startPoint:value.startPoint,maxPoints:128}};
 const events:ProjectReadEvent[]=[{runId:run.runId,sequence:1,time,type:'run.accepted',data:{project,model,continuedFrom:null,budget,wslResultsBinding:source.binding}},
  {runId:run.runId,sequence:2,time,type:'tool.started',data:call},{runId:run.runId,sequence:3,time,type:'tool.completed',data:{...call,result:{ok:true,value}}},
  {runId:run.runId,sequence:4,time,type:'message.delta',data:{messageId:'answer-a',step:1,text:'依据 [资料:'+value.citationId+']'}},{runId:run.runId,sequence:5,time,type:'run.completed',data:{citations:[value.citationId]}}];
 const resolves:ProjectReadRequests['resolveWaveformCitation'][]=[],checks:ProjectReadRequests['checkWaveformCitation'][]=[];
 const control={resolved:value,resolveGate:null as Promise<void>|null,state:'current' as 'current'|'changed'|'unavailable',wrongCheck:false};
 const ports:Partial<WorkbenchAgentProjectReadApi>={
  getStatus:async()=>({ok:true,value:{project,model,availability:'available',canStart:true,processState:'idle',cleanupState:'idle',reason:null,activeTask:null}}),
  getWslResultsBinding:async()=>({ok:true,value:{binding:source.binding}}),
  listRuns:async()=>({ok:true,value:{runs:[run],nextBefore:null}}),
  readRun:async input=>({ok:true,value:{run,events:events.slice(input.after),nextAfter:5,hasMore:false}}),
  resolveWaveformCitation:async input=>{resolves.push(input);const result=structuredClone(control.resolved);if(control.resolveGate)await control.resolveGate;return{ok:true,value:result};},
  checkWaveformCitation:async input=>{checks.push(input);return{ok:true,value:{citationId:control.wrongCheck?'wave-other':input.citationId,state:control.state,reason:control.state==='current'?null:control.state==='changed'?'SOURCE_CHANGED':'ROOT_UNAVAILABLE'}};},
 };
 const api=new Proxy(ports,{get:(target,key)=>target[key as keyof typeof target]??(()=>{throw Error('Unexpected bridge: '+String(key));})}) as WorkbenchAgentProjectReadApi;
 return {controller:createProjectReadController(api,{set:()=>0,clear:()=>{}}),api,control,resolves,checks,run,events,value};
}

test('WFUI both waveform and derived history resolve stored data and only explicit check touches the source bridge',async()=>{
 for(const value of [read,calculated]){const f=fixture(value);try{await f.controller.setProject('project-a');assert.equal(f.checks.length,0);const projected=projectReadEvents(f.controller.snapshot().events);assert.equal(projectMessageCitations('[资料:'+value.citationId+'] [资料:wave-invented]',projected.waveformCitations).length,1);
  await f.controller.openCitation(value.citationId);assert.deepEqual(f.resolves,[{contractVersion:V,runId:'wave-run',citationId:value.citationId}]);assert.equal(f.checks.length,0);assert.deepEqual(f.controller.snapshot().waveformCitation,value);
  for(const state of ['current','changed','unavailable'] as const){f.control.state=state;await f.controller.checkCitation();assert.equal(f.controller.snapshot().citationCheck?.state,state);assert.deepEqual(f.controller.snapshot().waveformCitation,value);const html=renderToStaticMarkup(createElement(WaveformCitationContext,{state:f.controller.snapshot(),onCheck:()=>{}}));assert.match(html,/打开历史不会读取 WSL 或重新计算/);assert(html.includes(state==='current'?'来源版本一致':state==='changed'?'来源已变化':'当前来源无法核对'));}
  assert.equal(f.resolves.length,1);f.controller.closeCitation();assert.equal(f.controller.snapshot().waveformCitation,null);
 }finally{f.controller.dispose();}}
});

test('WFUI source signal sample or metric changes are rejected and late history replies stay closed',async()=>{
 const f=fixture();let release!:()=>void;try{await f.controller.setProject('project-a');
  for(const changed of [{...calculated,source:{...source,sourceVersion:'e'.repeat(64)}},{...calculated,traces:[{...traces[0]!,signalName:'OTHER'},...traces.slice(1)]},{...calculated,metrics:{...metrics,firstFrequencyPoint:{...first,gainDb:19}}}]){f.control.resolved=changed;await f.controller.openCitation(calculated.citationId);assert.equal(f.controller.snapshot().waveformCitation,null);assert.match(f.controller.snapshot().citationError??'',/来源、样点或计算版本无法确认/);}
  f.control.resolved=calculated;f.control.resolveGate=new Promise<void>(resolve=>{release=resolve;});const old=f.controller.openCitation(calculated.citationId);f.controller.closeCitation();release();await old;assert.equal(f.controller.snapshot().waveformCitation,null);
  f.control.resolveGate=null;await f.controller.openCitation(calculated.citationId);f.control.wrongCheck=true;await f.controller.checkCitation();assert.equal(f.controller.snapshot().citationCheck,null);assert.deepEqual(f.controller.snapshot().waveformCitation,calculated);
 }finally{release?.();f.controller.dispose();}
 const page=fixture(read);try{await page.controller.setProject('project-a');page.control.resolved={...read,points:[{...read.points[0]!,real:99},read.points[1]!]};await page.controller.openCitation(read.citationId);assert.equal(page.controller.snapshot().waveformCitation,null);}finally{page.controller.dispose();}
});

test('WFUI current entry links validated calculations and cold history does not replay reading or metrics',async()=>{
 const f=fixture();try{await f.controller.setProject('project-a');
  const html=renderToStaticMarkup(createElement(ProjectReadView,{state:f.controller.snapshot(),choices:{activeId:'project-a',projects:[{id:'project-a',name:'合成项目'}]},actions:f.controller,onCreate:()=>{}}));
  assert.match(html,/计算 AC 指标/);assert.match(html,/查看计算依据：ac.ac/);assert.match(html,/波形与计算依据/);assert.match(html,/请新建任务重新读取当前来源/);assert.equal(await f.controller.continueRun(),false);
  const reopened=createProjectReadController(f.api,{set:()=>0,clear:()=>{}});try{await reopened.setProject('project-a');assert.equal(f.resolves.length,0);assert.equal(f.checks.length,0);assert.equal(reopened.snapshot().waveformCitation,null);await reopened.openCitation(calculated.citationId);assert.equal(f.resolves.length,1);assert.equal(f.checks.length,0);}finally{reopened.dispose();}
 }finally{f.controller.dispose();}
});

test('WFUI tool data from another WSL binding is rejected before entering the timeline',async()=>{
 const f=fixture();try{const event=f.events[2]!;assert.equal(event.type,'tool.completed');if(event.type!=='tool.completed')throw Error('fixture');
  f.events[2]={...event,data:{...event.data,result:{ok:true,value:{...calculated,source:{...source,binding:{...source.binding,id:'wsl-other'}}}}}};
  await f.controller.setProject('project-a');assert.equal(f.controller.snapshot().events.length,0);assert.match(f.controller.snapshot().error??'',/身份\/顺序异常/);assert.equal(f.resolves.length,0);
 }finally{f.controller.dispose();}
});
