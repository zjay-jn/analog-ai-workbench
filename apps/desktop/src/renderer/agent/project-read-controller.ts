import {AGENT_PROJECT_READ_VERSION as V,type WorkbenchAgentProjectReadApi,type ProjectReadStatus,type ProjectReadSummary,type ProjectReadEvent,type ProjectReadCitation,type ProjectReadRequests,type ProjectReadMethod,type ProjectReadValues,type ProjectReadRef} from '../../shared/agent/agent-project-read';
import {parseProjectReadRequest,parseProjectReadResult,PROJECT_READ_LIMITS} from '../../shared/agent/agent-project-read-validation';
import {projectReadError,projectReadEvents,projectRunTerminal,workContinuationError,projectUsesWslTools} from './project-read-presentation';
import type {WorkCycleContinuationPreview,WorkCycleWorkspaceRef,WorkCycleRecovery} from '../../shared/agent/agent-work-cycle';
import type {TaskCapacity,TaskCapacityEntry} from '../../shared/agent/agent-task-capacity';
import {WSL_RESULTS_ENVIRONMENT,parseWslResultsSelection,type WslResultsBinding,type WslResultsReadValue} from '../../shared/agent/wsl-results';
import {wslBindingIdentity,wslCitationIdentity,wslResultsError} from './wsl-results-presentation';
import {waveformCitationIdentity,waveformResultsError,type WaveformCitation} from './waveform-results-presentation';
import type {ProjectReadModel} from '../../shared/agent/agent-project-model';

type WorkContinuationDraft=Readonly<{parent:ProjectReadSummary;preview:WorkCycleContinuationPreview|null}>;
type StartRequest=ProjectReadRequests['startRun']|ProjectReadRequests['startWorkRun'];
const startKey=(input:StartRequest)=>JSON.stringify([input.projectId,input.bindingId,input.model.provider,input.model.model,input.goal,input.constraint,input.continuedFrom,'expectedEventCount' in input?input.expectedEventCount:null,'baselineVersion' in input?input.baselineVersion:null,'recoveryVersion' in input?input.recoveryVersion:null]);
const recoveryIdentity=(recovery:WorkCycleRecovery|undefined)=>recovery?JSON.stringify([recovery.version,recovery.parentEventsSha256,recovery.controller.guardianId,recovery.controller.guardianPid,recovery.controller.enginePid,recovery.controller.intentVersion,recovery.controller.readyVersion,recovery.controller.resultVersion,
  recovery.commands.map(command=>[command.executionId,command.requestId,command.signature,command.revision,command.recordVersion,command.cleanupProofSha256,command.termination,command.shellExitCode])]):null;
const workIdentity=(work:WorkCycleWorkspaceRef|undefined)=>JSON.stringify([work?.workspaceId,work?.continuation?.runId,work?.continuation?.workspaceId,work?.continuation?.eventCount,work?.continuation?.baselineVersion,recoveryIdentity(work?.continuation?.recovery)]);

export type ProjectReadViewState=Readonly<{
  projectId:string;status:ProjectReadStatus|null;runs:readonly ProjectReadSummary[];nextBefore:string|null;selectedRun:ProjectReadSummary|null;
  events:readonly ProjectReadEvent[];hasMore:boolean;loading:boolean;reading:boolean;pending:'start'|'answer'|'stop'|'delete'|'continue'|'wsl'|null;
  stopAccepted:boolean;answerSubmitted:string|null;answerUnconfirmed:boolean;startUnconfirmed:boolean;error:string|null;statusError:string|null;
  citation:ProjectReadCitation|null;citationLoading:boolean;citationError:string|null;
  citationCheck:ProjectReadValues['checkCitation']|null;inspection:Readonly<{project:ProjectReadRef;directoryId:string|null;relativeDirectory:string;page:number;returnedTotal:number;value:ProjectReadValues['browseProject']}>|null;
  inspecting:boolean;inspectionError:string|null;deleteDependents:readonly string[];workContinuation:WorkContinuationDraft|null;
  capacity:TaskCapacity|null;capacityLoading:boolean;capacityError:string|null;
  deletionTarget:ProjectReadSummary|null;deletionPreview:TaskCapacityEntry|null;deletionNotice:string|null;
  wslProjectId:string|null;wslBinding:WslResultsBinding|null;wslBindingKnown:boolean;wslBindingLoading:boolean;wslBindingError:string|null;wslBindingNotice:string|null;wslCitation:WslResultsReadValue|null;
  waveformCitation:WaveformCitation|null;
  modelSelecting:boolean;modelSelectionError:string|null;
}>;
export const initialProjectReadState:ProjectReadViewState={projectId:'',status:null,runs:[],nextBefore:null,selectedRun:null,events:[],hasMore:false,loading:false,reading:false,pending:null,
  stopAccepted:false,answerSubmitted:null,answerUnconfirmed:false,startUnconfirmed:false,error:null,statusError:null,citation:null,citationLoading:false,citationError:null,
  citationCheck:null,inspection:null,inspecting:false,inspectionError:null,deleteDependents:[],workContinuation:null,
  capacity:null,capacityLoading:false,capacityError:null,deletionTarget:null,deletionPreview:null,deletionNotice:null,
  wslProjectId:null,wslBinding:null,wslBindingKnown:false,wslBindingLoading:false,wslBindingError:null,wslBindingNotice:null,wslCitation:null,waveformCitation:null,modelSelecting:false,modelSelectionError:null};
type Clock={set:(fn:()=>void)=>unknown;clear:(handle:unknown)=>void};
const defaultClock:Clock={set:fn=>setTimeout(fn,350),clear:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)};
export const projectCanStart=(state:ProjectReadViewState)=>!!state.status?.canStart&&!!state.status.model&&!!state.status.project&&state.status.project.bindingId!==null&&state.status.project.projectId===state.projectId
  &&state.wslProjectId===state.projectId&&state.wslBindingKnown&&!state.wslBindingLoading
  &&!state.loading&&!state.pending&&!state.modelSelecting&&!state.inspecting&&!state.status.activeTask&&state.status.cleanupState==='idle'&&!state.runs.some(run=>!projectRunTerminal(run.status)||run.cleanupState==='pending');

export function createProjectReadController(api:WorkbenchAgentProjectReadApi,clock:Clock=defaultClock,uuid:()=>string=()=>crypto.randomUUID()){
  let state=initialProjectReadState,disposed=false,scopeEpoch=0,viewEpoch=0,citationEpoch=0,capacityEpoch=0,readBusy=false,timer:unknown=null;
  let wslBindingEpoch=0,statusEpoch=0;
  let startRequest:StartRequest|null=null,startMethod:'startRun'|'startWorkRun'='startRun',inspectionEpoch=0,inspectionProject:ProjectReadRef|null=null;const uncertainAnswers=new Set<string>(),listeners=new Set<()=>void>();
  const update=(patch:Partial<ProjectReadViewState>)=>{if(disposed)return;state={...state,...patch};listeners.forEach(fn=>fn());};
  const clearTimer=()=>{if(timer!==null){clock.clear(timer);timer=null;}};
  const shouldPoll=()=>!!state.selectedRun&&(state.hasMore||!projectRunTerminal(state.selectedRun.status)||state.selectedRun.cleanupState==='pending');
  const schedule=()=>{clearTimer();if(!disposed&&shouldPoll()&&!state.error)timer=clock.set(()=>{timer=null;void poll();});};
  const mergeRun=(run:ProjectReadSummary)=>[run,...state.runs.filter(item=>item.runId!==run.runId)];
  async function call<K extends ProjectReadMethod>(method:K,input:ProjectReadRequests[K]){
    const request=parseProjectReadRequest(method,input);if(!request)throw Error('Invalid request');
    const result=parseProjectReadResult(method,await api[method](request as never));if(!result)throw Error('Invalid response');return result;
  }
  async function poll(){
    if(disposed||readBusy||!state.selectedRun)return;readBusy=true;clearTimer();const epoch=viewEpoch,runId=state.selectedRun.runId,after=state.events.length;update({reading:true});
    try{
      const result=await call('readRun',{contractVersion:V,runId,after});if(disposed||epoch!==viewEpoch)return;
      if(!result.ok){update({error:projectReadError(result.error.code)});return;}
      const batch=result.value,previous=state.selectedRun;
      if(previous&&wslBindingIdentity(previous.wslResultsBinding)!==wslBindingIdentity(batch.run.wslResultsBinding))throw Error('WSL run binding changed');
      for(const event of batch.events){
        if(event.type==='run.accepted'&&wslBindingIdentity(event.data.wslResultsBinding)!==wslBindingIdentity(batch.run.wslResultsBinding))throw Error('WSL acceptance changed');
        if(event.type==='tool.completed'&&event.data.result.ok){const value=event.data.result.value;
          if((value.kind==='wsl_waveform_list'||value.kind==='wsl_waveform_read'||value.kind==='wsl_waveform_metrics')&&wslBindingIdentity(value.source.binding)!==wslBindingIdentity(batch.run.wslResultsBinding))throw Error('Waveform source binding mismatch');
          if((value.kind==='wsl_results_list'||value.kind==='wsl_results_read')&&wslBindingIdentity(value.kind==='wsl_results_list'?value.binding:value.source)!==wslBindingIdentity(batch.run.wslResultsBinding))throw Error('WSL source mismatch');}
      }
      if(batch.run.runId!==runId||batch.nextAfter!==after+batch.events.length||batch.nextAfter>PROJECT_READ_LIMITS.events||batch.run.eventCount<batch.nextAfter||batch.hasMore!==(batch.run.eventCount>batch.nextAfter)
        ||batch.events.some((event,index)=>event.runId!==runId||event.sequence!==after+index+1)
        ||previous&&(previous.project.projectId!==batch.run.project.projectId||previous.project.bindingId!==batch.run.project.bindingId||previous.project.identity!==batch.run.project.identity||previous.continuedFrom!==batch.run.continuedFrom||workIdentity(previous.workCycle)!==workIdentity(batch.run.workCycle)))throw Error('Invalid run page');
      const events=[...state.events,...batch.events];if(events.length&&events[0]?.type!=='run.accepted')throw Error('Missing acceptance');
      const accepted=events[0];if(accepted?.type==='run.accepted'&&(accepted.data.project.projectId!==batch.run.project.projectId||accepted.data.project.bindingId!==batch.run.project.bindingId||accepted.data.project.identity!==batch.run.project.identity||accepted.data.continuedFrom!==batch.run.continuedFrom||workIdentity(accepted.data.workCycle)!==workIdentity(batch.run.workCycle)))throw Error('Project changed');
      const wasActive=previous&&(!projectRunTerminal(previous.status)||previous.cleanupState==='pending');
      const question=projectReadEvents(events).question;
      update({selectedRun:batch.run,runs:mergeRun(batch.run),events,hasMore:batch.hasMore,answerSubmitted:question&&uncertainAnswers.has(`${runId}:${question.questionId}`)?question.questionId:null});
      if(wasActive&&projectRunTerminal(batch.run.status)&&batch.run.cleanupState!=='pending')void refreshStatus();
    }catch{if(epoch===viewEpoch)update({error:'任务记录读取失败或身份/顺序异常，请刷新核对。'});}
    finally{readBusy=false;if(epoch===viewEpoch)update({reading:false});schedule();}
  }
  async function refreshStatus(){
    const projectId=state.projectId,epoch=scopeEpoch,requestEpoch=++statusEpoch;if(!projectId||disposed)return;
    try{const result=await call('getStatus',{contractVersion:V,projectId});if(disposed||epoch!==scopeEpoch||requestEpoch!==statusEpoch)return;
      if(result.ok&&result.value.project&&result.value.project.projectId!==projectId)throw Error('Wrong project');
      update({status:result.ok?result.value:null,statusError:result.ok?null:projectReadError(result.error.code)});
    }catch{if(epoch===scopeEpoch&&requestEpoch===statusEpoch)update({status:null,statusError:'项目工具能力当前不可用，请刷新核对。'});}
  }
  async function selectModel(model:ProjectReadModel){
    if(disposed||state.modelSelecting||state.pending||state.startUnconfirmed)return false;
    update({modelSelecting:true,modelSelectionError:null});let saved=false;
    try{
      const result=await call('selectModel',{contractVersion:V,model});if(disposed)return false;
      if(!result.ok)update({modelSelectionError:projectReadError(result.error.code)});
      else if(result.value.model.provider!==model.provider||result.value.model.model!==model.model)throw Error('Model selection mismatch');
      else saved=true;
    }catch{update({modelSelectionError:'模型选择的保存响应未确认，请核对重新读取的当前选择。'});}
    finally{
      await refreshStatus();
      if(saved&&(state.status?.model?.provider!==model.provider||state.status.model.model!==model.model)){
        saved=false;update({modelSelectionError:'无法确认当前模型选择，请刷新核对后再开始任务。'});
      }
      update({modelSelecting:false});
    }
    return saved&&!disposed;
  }
  async function refresh(){
    if(disposed)return;const epoch=++scopeEpoch;update({loading:true,error:null});
    const statusTask=refreshStatus();
    const capacityTask=state.capacity||state.deletionTarget?refreshCapacity():null;
    const wslTask=refreshWslBinding();
    try{
      const result=await call('listRuns',{contractVersion:V,projectId:null,before:null});if(disposed||epoch!==scopeEpoch)return;
      if(!result.ok){update({error:projectReadError(result.error.code)});return;}
      const current=state.selectedRun,runs=result.value.runs.map(run=>run.runId===current?.runId&&current.eventCount>run.eventCount?current:run);
      update({runs,nextBefore:result.value.nextBefore});
      if(state.startUnconfirmed&&startRequest){const known=runs.find(run=>run.clientRequestId===startRequest!.clientRequestId);if(known){
        const baseline=known.workCycle?.continuation;
        const knownKey=JSON.stringify([known.project.projectId,known.project.bindingId,known.model.provider,known.model.model,known.goal,known.constraint,known.continuedFrom,baseline?.eventCount??null,baseline?.baselineVersion??null,baseline?.recovery?.version??null]);
        if(knownKey!==startKey(startRequest)||!!known.workCycle!==(startMethod==='startWorkRun')||baseline&&(baseline.workspaceId!==state.workContinuation?.preview?.baseline.workspaceId||recoveryIdentity(baseline.recovery)!==recoveryIdentity(state.workContinuation?.preview?.baseline.recovery)))throw Error('Start identity changed');
        startRequest=null;update({startUnconfirmed:false,workContinuation:null});await select(known.runId);
      }}
      if(!state.selectedRun){const first=runs.find(run=>!projectRunTerminal(run.status))??runs.find(run=>run.project.projectId===state.projectId);if(first)await select(first.runId);}
      else await poll();
    }catch{if(epoch===scopeEpoch)update({error:'无法读取工具任务历史，请刷新核对。'});}
    finally{await statusTask;await capacityTask;await wslTask;if(epoch===scopeEpoch)update({loading:false});}
  }
  async function setProject(projectId:string){if(disposed||state.pending||projectId===state.projectId)return;if(state.workContinuation||state.startUnconfirmed){update({error:'请先核对未确认请求或取消续接，再切换任务项目。'});return;}if(inspectionProject&&!await cancelInspection())return;scopeEpoch++;update({projectId,status:null,statusError:null});await refresh();}
  async function select(runId:string){
    if(disposed||state.pending)return;let known=state.runs.find(run=>run.runId===runId);const cursors=new Set<string>();
    while(!known&&state.nextBefore&&!cursors.has(state.nextBefore)&&cursors.size<PROJECT_READ_LIMITS.runs){cursors.add(state.nextBefore);await older();known=state.runs.find(run=>run.runId===runId);}
    if(!known||disposed||state.pending)return;
    viewEpoch++;citationEpoch++;clearTimer();update({selectedRun:known,events:[],hasMore:known.eventCount>0,reading:false,error:null,stopAccepted:false,answerSubmitted:null,answerUnconfirmed:false,citation:null,wslCitation:null,waveformCitation:null,citationLoading:false,citationError:null,citationCheck:null,deleteDependents:[]});await poll();
  }
  async function start(goal:string,constraint:string,continuedFrom:string|null=null,work=false,preview?:WorkCycleContinuationPreview){
    if(inspectionProject&&!await cancelInspection())return false;
    if(disposed||!projectCanStart(state))return false;
    const project=state.status!.project!,model=state.status!.model!;
    if(project.bindingId===null)return false;
    if(!goal.trim()){update({error:'请填写任务目标。'});return false;}
    const method=work?'startWorkRun':'startRun';
    const draft=state.workContinuation;
    if(draft&&(!work||continuedFrom!==draft.parent.runId)||work&&continuedFrom!==null&&(!preview||preview!==draft?.preview||draft.parent.project.projectId!==project.projectId||draft.parent.project.bindingId!==project.bindingId||draft.parent.project.identity!==project.identity))return false;
    const candidate:StartRequest={contractVersion:V,clientRequestId:startRequest?.clientRequestId??uuid(),projectId:project.projectId,bindingId:project.bindingId,model,goal,constraint,continuedFrom,...(preview?{expectedEventCount:preview.baseline.eventCount,baselineVersion:preview.baseline.baselineVersion,...(preview.baseline.recovery?{recoveryVersion:preview.baseline.recovery.version}:{})}:{})};
    if(state.startUnconfirmed&&startRequest&&(startMethod!==method||startKey(startRequest)!==startKey(candidate))){
      update({error:'前一次开始请求尚未确认，请刷新记录核对，或保留原项目和输入重试同一次请求。'});return false;
    }
    startRequest??=candidate;
    startMethod=method;
    const input=startRequest;if(!parseProjectReadRequest(method,input)){startRequest=null;update({error:`任务目标不能为空；目标与补充要求各最多 ${PROJECT_READ_LIMITS.goalBytes} UTF-8 字节。`});return false;}
    update({pending:'start',error:null});let accepted:string|null=null;
    try{const result=await (work?call('startWorkRun',input as ProjectReadRequests['startWorkRun']):call('startRun',input));if(disposed)return false;if(!result.ok){startRequest=null;update({startUnconfirmed:false,error:preview?workContinuationError(result.error.code,!!preview.baseline.recovery):projectReadError(result.error.code),...(preview&&(result.error.code==='CONFLICT'||preview.baseline.recovery&&result.error.code==='CLEANUP_FAILED')&&draft?{workContinuation:{...draft,preview:null}}:{})});void refreshStatus();return false;}
      accepted=result.value.runId;startRequest=null;update({startUnconfirmed:false,workContinuation:null});
    }catch{update({startUnconfirmed:true,error:'开始请求尚未确认，请刷新记录核对。再次提交原输入会核对同一次请求。'});}
    finally{update({pending:null});}
    if(accepted&&!disposed){await refresh();if(state.runs.some(run=>run.runId===accepted))await select(accepted);else update({error:'任务已接受，历史记录尚未读取成功，请刷新核对。'});return true;}return false;
  }
  /** Main may persist recovery evidence. Only continueWork submits a new run with the reviewed baseline. */
  async function prepareWorkContinuation(runId=state.workContinuation?.parent.runId??state.selectedRun?.runId){
    const run=state.runs.find(item=>item.runId===runId);
    if(disposed||state.pending||state.modelSelecting||state.loading||state.startUnconfirmed||!run?.workCycle||run.project.bindingId===null||!projectRunTerminal(run.status))return false;
    if(inspectionProject&&!await cancelInspection())return false;
    const recovering=run.cleanupState!=='idle';
    const epoch=++scopeEpoch;update({pending:'continue',error:null,workContinuation:{parent:run,preview:null},projectId:run.project.projectId,status:null,statusError:null});
    try{
      const checked=await call('getStatus',{contractVersion:V,projectId:run.project.projectId});if(disposed||epoch!==scopeEpoch)return false;
      if(!checked.ok){update({error:workContinuationError(checked.error.code,recovering)});return false;}
      const status=checked.value;update({status});
      if(status.project?.projectId!==run.project.projectId||status.project.bindingId!==run.project.bindingId||status.project.identity!==run.project.identity){update({error:workContinuationError('ROOT_CHANGED')});return false;}
      const result=await call('prepareWorkContinuation',{contractVersion:V,runId:run.runId,projectId:run.project.projectId,bindingId:run.project.bindingId,expectedEventCount:run.eventCount});if(disposed||epoch!==scopeEpoch)return false;
      if(!result.ok){update({error:workContinuationError(result.error.code,recovering)});return false;}
      const preview=result.value,baseline=preview.baseline;
      if(baseline.runId!==run.runId||baseline.workspaceId!==run.workCycle.workspaceId||baseline.eventCount!==run.eventCount||recovering&&!baseline.recovery)throw Error('Wrong continuation baseline or missing recovery evidence');
      await refreshStatus();await refreshWslBinding();if(disposed||epoch!==scopeEpoch)return false;
      const current=state.status?.project;
      if(current&&(current.projectId!==run.project.projectId||current.bindingId!==run.project.bindingId||current.identity!==run.project.identity))throw Error('Project changed during review');
      update({workContinuation:{parent:run,preview}});return true;
    }catch{if(epoch===scopeEpoch)update({error:'原任务的核定依据或文件基线未能确认，请重新核对。后续要求仍保留，尚未创建新任务。'});return false;}
    finally{update({pending:null});}
  }
  function cancelWorkContinuation(){if(disposed||state.pending||state.startUnconfirmed)return false;update({workContinuation:null,error:null});return true;}
  async function continueWork(goal:string,constraint:string){const draft=state.workContinuation;if(!draft?.preview)return false;return start(goal,constraint,draft.parent.runId,true,draft.preview);}
  async function answer(questionId:string,answer:string){
    const run=state.selectedRun,question=projectReadEvents(state.events).question;if(disposed||state.pending||state.hasMore||!run||projectRunTerminal(run.status)||question?.questionId!==questionId||question.answered||!answer.trim())return false;
    const key=`${run.runId}:${questionId}`;if(uncertainAnswers.has(key)){update({answerUnconfirmed:true,error:'此回答提交尚未确认，请刷新记录核对，不要重复提交。'});return false;}
    if(!parseProjectReadRequest('answerQuestion',{contractVersion:V,runId:run.runId,questionId,answer})){update({error:`回答不能为空，且最多 ${PROJECT_READ_LIMITS.answerBytes} UTF-8 字节。`});return false;}
    const epoch=viewEpoch;update({pending:'answer',error:null});
    try{const result=await call('answerQuestion',{contractVersion:V,runId:run.runId,questionId,answer});if(disposed||epoch!==viewEpoch)return false;
      if(!result.ok){update({error:projectReadError(result.error.code)});return false;}uncertainAnswers.add(key);update({answerSubmitted:questionId});return true;
    }catch{uncertainAnswers.add(key);if(epoch===viewEpoch)update({answerUnconfirmed:true,error:'回答提交尚未确认，请刷新记录核对，不要重复提交。'});return false;}
    finally{if(epoch===viewEpoch){update({pending:null});void poll();}}
  }
  async function stop(){
    const run=state.selectedRun;if(disposed||state.pending||!run||projectRunTerminal(run.status)||state.stopAccepted)return;
    const epoch=viewEpoch;update({pending:'stop',error:null});try{const result=await call('stopRun',{contractVersion:V,runId:run.runId});if(disposed||epoch!==viewEpoch)return;
      update(result.ok?{stopAccepted:true}:{error:projectReadError(result.error.code)});
    }catch{if(epoch===viewEpoch)update({error:'停止请求尚未确认，请刷新记录核对。'});}finally{if(epoch===viewEpoch){update({pending:null});void poll();}}
  }
  async function openCitation(citationId:string){
    const waveformPreview=projectReadEvents(state.events).waveformCitations.get(citationId);if(waveformPreview){await openWaveformCitation(waveformPreview);return;}
    const wslPreview=projectReadEvents(state.events).wslCitations.get(citationId);if(wslPreview){await openWslCitation(wslPreview);return;}
    const run=state.selectedRun,preview=projectReadEvents(state.events).citations.get(citationId);if(disposed||!run||!preview)return;
    const epoch=++citationEpoch,view=viewEpoch;update({citation:null,wslCitation:null,waveformCitation:null,citationLoading:true,citationError:null,citationCheck:null});
    try{const result=await call('resolveCitation',{contractVersion:V,runId:run.runId,citationId});if(disposed||epoch!==citationEpoch||view!==viewEpoch)return;
      if(!result.ok){update({citationError:projectReadError(result.error.code)});return;}const citation=result.value;
      if(citation.runId!==run.runId||citation.citationId!==citationId||citation.project.projectId!==run.project.projectId||citation.project.bindingId!==run.project.bindingId||citation.project.identity!==run.project.identity
        ||citation.version!==preview.version||citation.normalizedSha256!==preview.normalizedSha256||citation.fileId!==preview.fileId||citation.relativePath!==preview.relativePath||citation.excerpt!==preview.excerpt||citation.excerptSha256!==preview.excerptSha256||JSON.stringify(citation.range)!==JSON.stringify(preview.range))throw Error('Citation identity');
      update({citation});
    }catch{if(epoch===citationEpoch&&view===viewEpoch)update({citationError:'引用身份或版本无法确认，未打开其他文件。'});}
    finally{if(epoch===citationEpoch&&view===viewEpoch)update({citationLoading:false});}
  }
  async function older(){
    const before=state.nextBefore;if(disposed||state.loading||!before)return;const epoch=scopeEpoch;update({loading:true});
    try{const result=await call('listRuns',{contractVersion:V,projectId:null,before});if(disposed||epoch!==scopeEpoch)return;
      if(!result.ok){update({error:projectReadError(result.error.code)});return;}const ids=new Set(state.runs.map(run=>run.runId));update({runs:[...state.runs,...result.value.runs.filter(run=>!ids.has(run.runId))],nextBefore:result.value.nextBefore});
    }catch{if(epoch===scopeEpoch)update({error:'较早记录读取失败，请重试。'});}finally{if(epoch===scopeEpoch)update({loading:false});}
  }
  async function continueRun(){
    if(state.selectedRun&&!state.selectedRun.workCycle&&projectUsesWslTools(state.events)){update({error:'该任务使用了 WSL 结果，请新建任务重新读取当前来源。'});return false;}
    const run=state.selectedRun,shownModel=state.status?.model;if(disposed||state.pending||state.modelSelecting||!run||run.workCycle||!projectRunTerminal(run.status)||run.cleanupState!=='idle')return false;
    if(inspectionProject&&!await cancelInspection())return false;
    update({pending:'continue',error:null});
    try{
      const result=await call('getStatus',{contractVersion:V,projectId:run.project.projectId});if(disposed)return false;
      if(!result.ok){update({error:projectReadError(result.error.code)});return false;}
      const status=result.value;if(status.project?.projectId!==run.project.projectId||status.project.bindingId!==run.project.bindingId||status.project.identity!==run.project.identity){update({error:projectReadError('ROOT_CHANGED')});return false;}
      scopeEpoch++;update({projectId:run.project.projectId,status,loading:false});await refreshWslBinding();
      if(!status.model||shownModel&&status.model.model!==shownModel.model){update({error:'模型设置已改变，请核对显示的模型后再次开始后续任务。'});return false;}
    }catch{update({error:'无法核对后续任务的原项目和模型，请刷新后重试。'});return false;}finally{update({pending:null});}
    return start(run.goal,run.constraint,run.runId);
  }
  async function refreshWslBinding(settling=false){
    if(disposed||!state.projectId||state.pending==='wsl'&&!settling)return false;
    const projectId=state.projectId,epoch=++wslBindingEpoch;
    update({wslBindingLoading:true,wslBindingKnown:false,wslBindingError:null,...(state.wslProjectId!==projectId?{wslBinding:null,wslProjectId:projectId,wslBindingNotice:null}:{})});
    try{const result=await call('getWslResultsBinding',{contractVersion:V,projectId});if(disposed||epoch!==wslBindingEpoch||state.projectId!==projectId)return false;
      if(!result.ok){update({wslBindingError:wslResultsError(result.error.code)});return false;}
      update({wslBinding:result.value.binding,wslBindingKnown:true});return true;
    }catch{if(epoch===wslBindingEpoch&&state.projectId===projectId)update({wslBindingError:'WSL 来源保存状态尚未确认，请重新核对后开始任务。'});return false;}
    finally{if(epoch===wslBindingEpoch)update({wslBindingLoading:false});}
  }
  async function selectWslBinding(rootPath:string){
    if(disposed||state.pending||state.startUnconfirmed||state.workContinuation||!state.projectId||state.wslBindingLoading||!state.wslBindingKnown)return false;
    const selection=parseWslResultsSelection({...WSL_RESULTS_ENVIRONMENT,rootPath:rootPath.trim()});
    if(!selection){update({wslBindingNotice:'请输入实验 WSL 的受支持结果目录，例如 /home/maxwell/simulation/ 下的实验结果子目录。'});return false;}
    const projectId=state.projectId,epoch=++wslBindingEpoch;update({pending:'wsl',wslBindingKnown:false,wslBindingNotice:null,wslBindingError:null});
    try{const result=await call('selectWslResultsBinding',{contractVersion:V,projectId,selection});if(disposed||epoch!==wslBindingEpoch||state.projectId!==projectId)return false;
      if(!result.ok){update({wslBindingNotice:wslResultsError(result.error.code)});await refreshWslBinding(true);return false;}
      const binding=result.value.binding;if(binding.rootPath!==selection.rootPath||binding.distro!==selection.distro||binding.user!==selection.user)throw Error('Wrong WSL selection');
      update({wslBinding:binding,wslBindingKnown:true,wslProjectId:projectId,wslBindingNotice:'结果目录已连接，将用于后续任务。'});return true;
    }catch{if(state.projectId===projectId){update({wslBindingNotice:'连接结果尚未确认，正在核对保存状态；没有自动重试。'});await refreshWslBinding(true);}return false;}
    finally{update({pending:null});}
  }
  async function clearWslBinding(){
    const binding=state.wslBinding;if(disposed||state.pending||state.startUnconfirmed||state.workContinuation||state.wslBindingLoading||!state.wslBindingKnown||!binding||state.wslProjectId!==state.projectId)return false;
    const projectId=state.projectId,epoch=++wslBindingEpoch;update({pending:'wsl',wslBindingKnown:false,wslBindingNotice:null,wslBindingError:null});
    try{const result=await call('clearWslResultsBinding',{contractVersion:V,projectId,expectedBindingId:binding.id});if(disposed||epoch!==wslBindingEpoch||state.projectId!==projectId)return false;
      if(!result.ok){update({wslBindingNotice:wslResultsError(result.error.code)});await refreshWslBinding(true);return false;}
      update({wslBinding:null,wslBindingKnown:true,wslBindingNotice:'后续任务已取消此连接，历史任务来源保留。'});return true;
    }catch{if(state.projectId===projectId){update({wslBindingNotice:'取消连接结果尚未确认，正在核对保存状态；没有自动重试。'});await refreshWslBinding(true);}return false;}
    finally{update({pending:null});}
  }
  async function openWaveformCitation(preview:WaveformCitation){
    const run=state.selectedRun;if(disposed||!run||wslBindingIdentity(run.wslResultsBinding)!==wslBindingIdentity(preview.source.binding))return;
    const epoch=++citationEpoch,view=viewEpoch;update({citation:null,wslCitation:null,waveformCitation:null,citationLoading:true,citationError:null,citationCheck:null});
    try{const result=await call('resolveWaveformCitation',{contractVersion:V,runId:run.runId,citationId:preview.citationId});if(disposed||epoch!==citationEpoch||view!==viewEpoch)return;
      if(!result.ok){update({citationError:waveformResultsError(result.error.code)});return;}
      if(waveformCitationIdentity(result.value)!==waveformCitationIdentity(preview))throw Error('Waveform citation identity');
      update({waveformCitation:result.value});
    }catch{if(epoch===citationEpoch&&view===viewEpoch)update({citationError:'波形依据的来源、样点或计算版本无法确认，未打开其他结果。'});}
    finally{if(epoch===citationEpoch&&view===viewEpoch)update({citationLoading:false});}
  }
  async function checkWaveformCitation(){
    const run=state.selectedRun,citation=state.waveformCitation;if(disposed||state.inspecting||state.pending||!run||!citation)return;
    if(inspectionProject&&!await cancelInspection())return;
    const epoch=++inspectionEpoch,view=citationEpoch;update({inspecting:true,citationError:null,citationCheck:null});
    try{const result=await call('checkWaveformCitation',{contractVersion:V,runId:run.runId,citationId:citation.citationId});if(disposed||epoch!==inspectionEpoch||view!==citationEpoch)return;
      if(!result.ok){update({citationError:waveformResultsError(result.error.code)});return;}
      if(result.value.citationId!==citation.citationId)throw Error('Waveform check identity');update({citationCheck:result.value});
    }catch{if(epoch===inspectionEpoch&&view===citationEpoch)update({citationError:'当前波形来源核对未完成，已保存结果保留。'});}
    finally{if(epoch===inspectionEpoch)update({inspecting:false});}
  }
  async function openWslCitation(preview:WslResultsReadValue){
    const run=state.selectedRun;if(disposed||!run||wslBindingIdentity(run.wslResultsBinding)!==wslBindingIdentity(preview.source))return;
    const epoch=++citationEpoch,view=viewEpoch;update({citation:null,wslCitation:null,waveformCitation:null,citationLoading:true,citationError:null,citationCheck:null});
    try{const result=await call('resolveWslResultsCitation',{contractVersion:V,runId:run.runId,citationId:preview.citationId});if(disposed||epoch!==citationEpoch||view!==viewEpoch)return;
      if(!result.ok){update({citationError:wslResultsError(result.error.code)});return;}
      if(wslCitationIdentity(result.value)!==wslCitationIdentity(preview))throw Error('WSL citation identity');
      update({wslCitation:result.value});
    }catch{if(epoch===citationEpoch&&view===viewEpoch)update({citationError:'WSL 引用来源或版本无法确认，未打开其他文件。'});}
    finally{if(epoch===citationEpoch&&view===viewEpoch)update({citationLoading:false});}
  }
  async function checkWslCitation(){
    const run=state.selectedRun,citation=state.wslCitation;if(disposed||state.inspecting||state.pending||!run||!citation)return;
    if(inspectionProject&&!await cancelInspection())return;
    const epoch=++inspectionEpoch,view=citationEpoch;update({inspecting:true,citationError:null,citationCheck:null});
    try{const result=await call('checkWslResultsCitation',{contractVersion:V,runId:run.runId,citationId:citation.citationId});if(disposed||epoch!==inspectionEpoch||view!==citationEpoch)return;
      if(!result.ok){update({citationError:wslResultsError(result.error.code)});return;}
      if(result.value.citationId!==citation.citationId)throw Error('WSL check identity');update({citationCheck:result.value});
    }catch{if(epoch===inspectionEpoch&&view===citationEpoch)update({citationError:'当前 WSL 文件版本核对未完成，历史片段保留。'});}
    finally{if(epoch===inspectionEpoch)update({inspecting:false});}
  }
  async function refreshCapacity(){
    if(disposed)return null;const epoch=++capacityEpoch;
    update({capacityLoading:true,capacityError:null,deletionPreview:null});
    try{const result=await call('getTaskCapacity',{contractVersion:V,projectId:null});if(disposed||epoch!==capacityEpoch)return null;
      if(!result.ok){update({capacity:null,capacityError:projectReadError(result.error.code)});return null;}
      update({capacity:result.value});return result.value;
    }catch{if(epoch===capacityEpoch)update({capacity:null,capacityError:'容量统计尚未确认，请重新核对。'});return null;}
    finally{if(epoch===capacityEpoch)update({capacityLoading:false});}
  }
  async function prepareDeletion(runId:string){
    if(disposed||state.pending)return false;
    const run=state.runs.find(item=>item.runId===runId);if(!run)return false;
    update({deletionTarget:run,deletionPreview:null,deletionNotice:null,deleteDependents:[]});
    const capacity=await refreshCapacity();if(!capacity||disposed||state.deletionTarget?.runId!==runId)return false;
    const entry=capacity.runs.find(item=>item.runId===runId);
    if(!entry||entry.projectId!==run.project.projectId||entry.expectedEventCount<run.eventCount){update({deletionNotice:'该任务的容量与记录尚未对应，请刷新记录后重新核对。'});return false;}
    update({deletionPreview:entry});return true;
  }
  function cancelDeletion(){
    if(state.pending==='delete')return;capacityEpoch++;
    update({capacityLoading:false,deletionTarget:null,deletionPreview:null,deletionNotice:null,deleteDependents:[]});
  }
  async function deleteRun(runId:string){
    const run=state.runs.find(item=>item.runId===runId),preview=state.deletionPreview;
    if(disposed||state.pending||state.startUnconfirmed||state.workContinuation||state.capacityLoading||!run||!projectRunTerminal(run.status)
      ||state.deletionTarget?.runId!==runId||preview?.runId!==runId||preview.projectId!==run.project.projectId
      ||!preview.complete||!preview.canDelete||preview.blockedReason)return false;
    capacityEpoch++;update({pending:'delete',error:null,deleteDependents:[],deletionPreview:null,deletionNotice:null});
    try{const result=await call('deleteRun',{contractVersion:V,runId,expectedEventCount:preview.expectedEventCount,expectedCapacityVersion:preview.capacityVersion});if(disposed)return false;
      if(!result.ok){update({deletionNotice:projectReadError(result.error.code)+' 请重新核对删除影响，再决定是否重试。',deleteDependents:result.error.code==='RUN_HAS_DEPENDENTS'?result.error.dependentRunIds:[]});return false;}
      if(state.selectedRun?.runId===runId){viewEpoch++;citationEpoch++;clearTimer();update({selectedRun:null,events:[],hasMore:false,citation:null,wslCitation:null,waveformCitation:null,citationLoading:false,citationError:null,citationCheck:null});}
      update({runs:state.runs.filter(item=>item.runId!==runId),deletionTarget:null,deletionNotice:'此任务的主记录、独占工作文件、命令日志和执行副本已删除；共享引擎缓存保留，其中可能有会话副本。'});return true;
    }catch{update({deletionNotice:'删除结果尚未确认；正在重新核对容量，没有自动重试。请刷新记录核对。'});return false;}
    finally{await refreshCapacity();await refreshStatus();update({pending:null});}
  }
  async function revalidate(){
    const project=state.status?.project;if(disposed||state.inspecting||state.pending||!project||project.bindingId===null)return;
    if(inspectionProject&&!await cancelInspection())return;
    const epoch=++inspectionEpoch;inspectionProject=project;update({inspecting:true,inspectionError:null});
    try{const result=await call('revalidateProject',{contractVersion:V,projectId:project.projectId,bindingId:project.bindingId});if(disposed||epoch!==inspectionEpoch)return;
      if(!result.ok){update({inspectionError:projectReadError(result.error.code)});return;}
      if(result.value.project&&result.value.project.projectId!==project.projectId)throw Error('Project mismatch');update({status:result.value});
    }catch{if(epoch===inspectionEpoch)update({inspectionError:'项目身份核对未完成，请恢复原目录后重试。'});}finally{if(epoch===inspectionEpoch){inspectionProject=null;update({inspecting:false});}}
  }
  async function browse(directoryId:string|null=null,relativeDirectory='',next=false){
    const current=state.inspection,project=next?current?.project:state.status?.project;
    if(disposed||state.inspecting||state.pending||!project||project.bindingId===null||next&&!current?.value.coverage.nextCursor)return;
    if(inspectionProject&&(inspectionProject.projectId!==project.projectId||(!next&&directoryId===null))&&!await cancelInspection())return;
    const epoch=++inspectionEpoch;inspectionProject=project;update({inspecting:true,inspectionError:null});
    try{const result=await call('browseProject',{contractVersion:V,projectId:project.projectId,bindingId:project.bindingId,directoryId:next?current!.directoryId:directoryId,cursor:next?current!.value.coverage.nextCursor:null,refresh:!next&&directoryId===null});if(disposed||epoch!==inspectionEpoch)return;
      if(!result.ok){update({inspectionError:projectReadError(result.error.code)});return;}const value=result.value;
      if(value.coverage.scope.projectId!==project.projectId||value.coverage.scope.bindingId!==project.bindingId||value.coverage.scope.identity!==project.identity||next&&value.snapshotId!==current!.value.snapshotId)throw Error('Inspection mismatch');
      update({inspection:{project,directoryId:next?current!.directoryId:directoryId,relativeDirectory:next?current!.relativeDirectory:relativeDirectory,page:next?current!.page+1:1,returnedTotal:(next?current!.returnedTotal:0)+value.entries.length,value}});
    }catch{if(epoch===inspectionEpoch)update({inspectionError:'目录浏览页无法确认，请关闭后重新查看目录。'});}finally{if(epoch===inspectionEpoch)update({inspecting:false});}
  }
  async function checkCitation(){
    if(state.waveformCitation){await checkWaveformCitation();return;}
    if(state.wslCitation){await checkWslCitation();return;}
    const citation=state.citation;if(disposed||state.inspecting||state.pending||!citation)return;
    if(inspectionProject&&!await cancelInspection())return;
    const epoch=++inspectionEpoch,view=citationEpoch;inspectionProject=citation.project;update({inspecting:true,inspectionError:null,citationCheck:null});
    try{const result=await call('checkCitation',{contractVersion:V,runId:citation.runId,citationId:citation.citationId});if(disposed||epoch!==inspectionEpoch||view!==citationEpoch)return;
      if(!result.ok){update({citationError:projectReadError(result.error.code)});return;}if(result.value.citationId!==citation.citationId)throw Error('Citation mismatch');update({citationCheck:result.value});
    }catch{if(epoch===inspectionEpoch&&view===citationEpoch)update({citationError:'当前文件版本核对未完成，保留任务时片段。'});}finally{if(epoch===inspectionEpoch){inspectionProject=null;update({inspecting:false});}}
  }
  async function cancelInspection(){
    const project=inspectionProject;if(!project){update({inspection:null,inspecting:false,inspectionError:null});return true;}
    const epoch=++inspectionEpoch;update({inspecting:true});
    try{const result=await call('cancelInspection',{contractVersion:V,projectId:project.projectId});if(disposed||epoch!==inspectionEpoch)return false;
      if(!result.ok){update({inspectionError:projectReadError(result.error.code)});return false;}inspectionProject=null;update({inspection:null,inspectionError:null});await refreshStatus();return true;
    }catch{if(epoch===inspectionEpoch)update({inspectionError:'资料核验取消尚未确认，请再次取消并核对状态。'});return false;}finally{if(epoch===inspectionEpoch)update({inspecting:false});}
  }
  return {snapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},setProject,refresh,select,start,startWork:(goal:string,constraint:string)=>start(goal,constraint,null,true),prepareWorkContinuation,cancelWorkContinuation,continueWork,answer,stop,poll,older,openCitation,continueRun,deleteRun,refreshCapacity,prepareDeletion,cancelDeletion,revalidate,browse,checkCitation,cancelInspection,
    refreshWslBinding:()=>refreshWslBinding(),selectWslBinding,clearWslBinding,selectModel,
    closeCitation:()=>{citationEpoch++;update({citation:null,wslCitation:null,waveformCitation:null,citationLoading:false,citationError:null,citationCheck:null});if(state.inspecting)void cancelInspection();},
    dispose:()=>{const project=inspectionProject;disposed=true;scopeEpoch++;viewEpoch++;citationEpoch++;inspectionEpoch++;clearTimer();listeners.clear();if(project)void call('cancelInspection',{contractVersion:V,projectId:project.projectId}).catch(()=>{});}};
}
export type ProjectReadController=ReturnType<typeof createProjectReadController>;
