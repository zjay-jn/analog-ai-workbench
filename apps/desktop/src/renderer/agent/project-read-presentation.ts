import type {ProjectReadCitationPreview,ProjectReadCode,ProjectReadEvent,ProjectReadEventData,ProjectReadRunState,ProjectReadToolResult} from '../../shared/agent/agent-project-read';
import type {FileSystemSourceRef} from '../../shared/agent/agent-filesystem-read';
import type {WorkCycleToolValue} from '../../shared/agent/agent-work-cycle';
import type {CommandToolValue} from '../../shared/agent/agent-command';
import {isWorkCycleValue} from './work-cycle-presentation';
import type {WslResultsReadValue} from '../../shared/agent/wsl-results';
import {isWaveformResultsToolName} from '../../shared/agent/waveform-results';
import type {WaveformCitation} from './waveform-results-presentation';

export const projectRunLabels:Record<ProjectReadRunState,string>={preparing:'正在核对项目',running:'运行中',waiting_user:'等待回答',completed:'执行已结束',failed:'执行失败',stopped:'已停止',interrupted:'已中断'};
export const projectRunTerminal=(status:ProjectReadRunState)=>!['preparing','running','waiting_user'].includes(status);
export const projectUsesWslTools=(events:readonly ProjectReadEvent[])=>events.some(event=>(event.type==='tool.started'||event.type==='tool.completed')&&(event.data.toolName==='wsl_results_list'||event.data.toolName==='wsl_results_read'||isWaveformResultsToolName(event.data.toolName)));
/** Display only: main supplies these paths; current bindings never fill in old metadata. */
export const projectCitationPath=(citation:ProjectReadCitationPreview)=>citation.location?.absolutePath??citation.relativePath;
export const projectEntryPath=(relativePath:string,source?:FileSystemSourceRef)=>source?`${source.rootPath.replace(/[\\/]+$/u,'')}\\${relativePath.replace(/\//gu,'\\')}`:relativePath;
export function projectReadToolError(error:Extract<ProjectReadToolResult,{ok:false}>['error']){
  return projectReadError(error.code)+(error.osCode?`（${error.osCode}）`:'');
}
export function projectReadError(code:ProjectReadCode):string{
  const messages:Partial<Record<ProjectReadCode,string>>={
    NOT_BOUND:'项目尚未关联目录，请返回项目区新建项目并选择目录。',CREATION_PENDING:'项目创建尚未完成，请返回项目区核对创建状态。',
    ROOT_UNAVAILABLE:'原项目目录暂时无法访问。恢复目录后刷新状态，再开始任务。',ROOT_CHANGED:'原项目目录身份已改变。请新建项目选择目录，旧任务记录仍保留。',
    CWD_UNAVAILABLE:'本轮没有默认工作目录，请提供明确的绝对路径。',PATH_POLICY_DENIED:'该路径受访问规则限制，无法读取。',
    PATH_NOT_FOUND:'指定路径不存在。',ACCESS_DENIED:'系统拒绝访问该路径。',NOT_A_DIRECTORY:'指定路径不是文件夹。',NOT_A_FILE:'指定路径不是普通文件。',
    FILE_UNAVAILABLE:'文件暂时无法访问。已保存片段仍可查看；可在新任务中重新查询。',SOURCE_CHANGED:'文件已发生变化。保留任务时片段，请在新任务中重新读取。',
    SNAPSHOT_CHANGED:'目录快照发生变化，请在新任务中重新查询。',CURSOR_STALE:'读取位置已失效，请重新查询，不能沿用旧位置。',
    MODEL_UNAVAILABLE:'工具任务模型不可用，请检查模型设置后刷新状态。',BUSY:'已有任务或资料核验占用执行资源，请等待收尾或查看正在运行的任务。',
    STORAGE_FAILED:'任务记录保存失败，请刷新核对；尚不能确认操作已完成。',HISTORY_FULL:'工具任务记录容量已满，暂时无法开始新任务。可在存储用量中查看占用，再核对并删除不再需要且无引用的任务。',
    CLEANUP_FAILED:'执行资源尚未确认释放，请核对记录，暂时不能开始新任务。',BUDGET_EXCEEDED:'本次任务达到预算限制。请查看已覆盖范围，并缩小下一任务范围。',
    RULES_UNAVAILABLE:'项目规则无法读取，请检查规则文件后重新开始。',RULES_LIMIT:'项目规则超过读取限制，请缩小任务范围或整理规则后重试。',
    FILE_LIMIT:'文件超出读取限制，请选择较小的普通文本资料。',SCOPE_LIMIT:'本次访问范围达到限制，请缩小目录或查询范围。',
    UNSUPPORTED_ENCODING:'文件编码不支持，请使用 UTF-8 普通文本资料。',UNSUPPORTED_TEXT:'文件不是支持的普通文本。',UNSUPPORTED_PATH:'当前路径不在支持范围内。',
    CAPABILITY_DENIED:'当前入口没有此项能力。',INVALID_REQUEST:'任务内容或参数不符合要求，请检查输入。',CANCELLED:'本次操作已取消。',
    ENGINE_FAILED:'任务引擎执行失败，可查看已保存记录后重新开始。',IO_ERROR:'资料读取失败，请检查目录或文件后重试。',
    RUN_NOT_FOUND:'该任务记录已不存在，请刷新历史。',RUN_HAS_DEPENDENTS:'其他任务仍引用这条记录，请先处理依赖记录。',CONFLICT:'记录已经改变，请刷新后核对。',
    OA_UNAVAILABLE:'原理图读取环境暂不可用，请查看诊断后重新查询。',OA_SNAPSHOT_UNPROVEN:'尚未核对到一致的原理图保存版本，本次结果不能作为电路依据。',
    OA_OBJECT_NOT_FOUND:'当前原理图版本中未找到该对象，请重新查询器件或网络。',OA_UNSUPPORTED:'当前原理图读取器尚不支持这项查询。',
  };
  return messages[code]??`操作未完成（${code}），请刷新核对。`;
}
export function workContinuationError(code:ProjectReadCode,recovering=false):string{
  if(recovering&&code==='CLEANUP_FAILED')return '执行收尾或生命周期依据尚未核定，暂不能承接此任务。历史、文件和日志仍可查看；后续要求已保留，可重新核对。';
  if(recovering&&code==='CONFLICT')return '原任务记录、文件基线或命令核定结果已变化，或仍有未确认操作。后续要求已保留，请重新核对后再继续。';
  if(code==='CONFLICT')return '原任务的文件基线已变化，或仍有未确认操作。后续要求已保留；请返回原任务核对，再重新准备续接。';
  if(code==='BUSY')return '原任务或其他任务仍占用执行资源，请等待结束后重新核对。后续要求已保留。';
  if(code==='CLEANUP_FAILED')return '执行资源尚未确认释放，暂时不能继续或开始新任务。后续要求已保留，请返回原任务核对。';
  return projectReadError(code);
}
export type ProjectToolRow={call:ProjectReadEventData['tool.started'];result:ProjectReadEventData['tool.completed']['result']|null};
export type ProjectTimelineItem={kind:'text';key:number;messageId:string;step:number;text:string}
  |{kind:'tool';key:number;tool:ProjectToolRow}|{kind:'answer';key:number;prompt:string;answer:string;delivered:boolean;questionId:string};
export function projectReadEvents(events:readonly ProjectReadEvent[]){
  const timeline:ProjectTimelineItem[]=[],tools=new Map<string,ProjectToolRow>(),citations=new Map<string,ProjectReadCitationPreview>(),wslCitations=new Map<string,WslResultsReadValue>(),waveformCitations=new Map<string,WaveformCitation>();
  const responses:ProjectReadEventData['model.response'][]=[],rules:ProjectReadEventData['project.rules']['rules'][number][]=[];
  const ruleChunks:import('../../shared/agent/agent-project-read').ProjectReadRuleChunk[]=[];
  const workValues:WorkCycleToolValue[]=[];
  const commandValues:CommandToolValue[]=[];
  let text:Extract<ProjectTimelineItem,{kind:'text'}>|null=null,question:(ProjectReadEventData['question.asked']&{answered:boolean;delivered:boolean})|null=null;
  let failure:ProjectReadCode|null=null,action='正在读取记录';
  for(const event of events){
    switch(event.type){
      case 'run.accepted':action='任务已接受，正在核对项目';break;
      case 'run.started':action='正在处理任务';break;
      case 'model.step':if(text?.step!==event.data.step)text=null;action=`处理第 ${event.data.step} 步`;break;
      case 'model.response':responses.push(event.data);break;
      case 'message.delta':if(!text||text.messageId!==event.data.messageId||text.step!==event.data.step){text={kind:'text',key:event.sequence,messageId:event.data.messageId,step:event.data.step,text:''};timeline.push(text);}text.text+=event.data.text;break;
      case 'tool.started':{text=null;const tool={call:event.data,result:null};tools.set(event.data.callId,tool);timeline.push({kind:'tool',key:event.sequence,tool});action='正在执行工具';break;}
      case 'tool.completed':{
        text=null;let tool=tools.get(event.data.callId);if(!tool){tool={call:event.data,result:null};tools.set(event.data.callId,tool);timeline.push({kind:'tool',key:event.sequence,tool});}tool.result=event.data.result;
        if(event.data.result.ok){const value=event.data.result.value;if(value.kind==='read'&&value.citation)citations.set(value.citation.citationId,value.citation);if(value.kind==='search')for(const match of value.matches)citations.set(match.citation.citationId,match.citation);
          if('rules' in value)ruleChunks.push(...value.rules);
          if(value.kind==='wsl_results_read')wslCitations.set(value.citationId,value);
          if(value.kind==='wsl_waveform_read'||value.kind==='wsl_waveform_metrics')waveformCitations.set(value.citationId,value);
          if(isWorkCycleValue(value))workValues.push(value);
          if(value.kind==='command_environment'||value.kind==='command_start'||value.kind==='command_status'||value.kind==='command_log'||value.kind==='command_stop')commandValues.push(value);
        }
        action='工具结果已返回';break;
      }
      case 'project.rules':rules.push(...event.data.rules);break;
      case 'question.asked':text=null;question={...event.data,answered:false,delivered:false};action='等待你的回答';break;
      case 'question.answered':text=null;timeline.push({kind:'answer',key:event.sequence,prompt:question?.questionId===event.data.questionId?question.prompt:'',answer:event.data.answer,questionId:event.data.questionId,delivered:false});if(question?.questionId===event.data.questionId)question.answered=true;action='回答已记录，等待交付确认';break;
      case 'question.delivered':for(const item of timeline)if(item.kind==='answer'&&item.questionId===event.data.questionId)item.delivered=true;if(question?.questionId===event.data.questionId)question.delivered=true;action='回答交付已确认';break;
      case 'cleanup.started':action='正在释放执行资源';break;
      case 'cleanup.completed':action=event.data.outcome==='confirmed'?'执行资源已释放':'执行资源释放尚未确认';break;
      case 'run.failed':failure=event.data.code;action=projectReadError(event.data.code);question=null;break;
      case 'run.completed':action='执行已结束，请结合结果与覆盖范围判断任务结论。';question=null;break;
      case 'run.stopped':action='任务已停止';question=null;break;
      case 'run.interrupted':action='任务已中断，未自动重放。';question=null;break;
    }
  }
  return {timeline,citations,wslCitations,waveformCitations,responses,rules,ruleChunks,workValues,commandValues,question,failure,action};
}
/** Only IDs already present in validated tool results become citation controls. */
export function projectMessageCitations<T extends {citationId:string}>(text:string,citations:ReadonlyMap<string,T>):readonly T[]{
  const found=new Map<string,T>();for(const match of text.matchAll(/\[资料:([^\]\r\n]{1,160})\]/gu)){const citation=citations.get(match[1]!);if(citation)found.set(citation.citationId,citation);}return [...found.values()];
}
