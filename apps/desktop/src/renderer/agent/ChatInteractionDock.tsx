import {useRef,useState,type ReactNode} from 'react';
import type {ChatInteractionDecision,ChatTurnInteraction} from '../../shared/agent/chat-turns';
import type {SessionState} from '../../shared/agent/chat-sessions';
import type {SessionOperationOutcome} from './session-operations';

export type ChatInteractionMemory={answer:string;attempt:{requestId:string;decision:ChatInteractionDecision}|null;uncertain:boolean;confirmed:boolean;notice:string};
export const emptyChatInteractionMemory=():ChatInteractionMemory=>({answer:'',attempt:null,uncertain:false,confirmed:false,notice:''});
export const chatFilesystemRetry=(interaction:ChatTurnInteraction|null,capabilities:SessionState['capabilities'])=>capabilities?.filesystemRead===true&&interaction?.kind==='configuration'&&interaction.required==='project_directory';
export function ChatInteractionDock({interaction,onSubmit,onConfigure,onStop,stopping,canStop,disabled=false,memory,configurationTools,configurationRetryDisabled=false,capabilities}:{interaction:ChatTurnInteraction;onSubmit:(decision:ChatInteractionDecision,requestId:string)=>Promise<SessionOperationOutcome>;onConfigure:()=>void;onStop:()=>void;stopping:boolean;canStop:boolean;disabled?:boolean;memory?:ChatInteractionMemory;configurationTools?:ReactNode;configurationRetryDisabled?:boolean;capabilities?:SessionState['capabilities']}){
 const filesystemRetry=chatFilesystemRetry(interaction,capabilities);
 const saved=useRef(memory??emptyChatInteractionMemory()).current;
 const [answer,setAnswer]=useState(saved.answer),[sending,setSending]=useState(false),[notice,setNoticeState]=useState(saved.notice),[confirmed,setConfirmedState]=useState(saved.confirmed);
 const attempt=useRef(saved.attempt),inFlight=useRef(false),[uncertain,setUncertainState]=useState(saved.uncertain);
 const setNotice=(value:string)=>{saved.notice=value;setNoticeState(value);},setConfirmed=(value:boolean)=>{saved.confirmed=value;setConfirmedState(value);},setUncertain=(value:boolean)=>{saved.uncertain=value;setUncertainState(value);};
 const submit=async(decision:ChatInteractionDecision)=>{
  if(inFlight.current||sending||disabled||confirmed||!uncertain&&decision.kind==='configuration'&&decision.decision==='retry'&&configurationRetryDisabled)return;
  if(!attempt.current)attempt.current=saved.attempt={requestId:crypto.randomUUID(),decision};
  if(JSON.stringify(attempt.current.decision)!==JSON.stringify(decision))return;
  inFlight.current=true;setSending(true);setNotice('');
  try{const outcome=await onSubmit(attempt.current.decision,attempt.current.requestId);
   if(outcome.status==='accepted'){setConfirmed(true);setUncertain(false);setNotice('已提交，等待状态更新。');}
   else if(outcome.status==='rejected'){setNotice(outcome.code==='CONFIGURATION_REQUIRED'?'当前项目尚未关联目录，请先选择目录，或切换到已关联目录的项目。':outcome.code==='CONFIGURATION_UNAVAILABLE'?'已关联目录不可用或已移动，请恢复原目录，或切换到其他已关联项目后继续。':'操作未接受，请核对当前状态。');if(!uncertain)attempt.current=saved.attempt=null;}
   else {setUncertain(true);setNotice('提交回执尚未确认。内容已保留，可核对同一次提交。');}
  }catch{setUncertain(true);setNotice('提交回执尚未确认，内容已保留。');}finally{inFlight.current=false;setSending(false);}
 };
 const busy=disabled||sending||confirmed,submitted=interaction.kind==='question'&&interaction.state==='submitted';
 return <section className="chat-interaction-dock" aria-label={interaction.kind==='question'?'回答当前问题':interaction.kind==='permission'?'确认继续工作':'补充配置'} data-interaction-id={interaction.interactionId}>
  <p>{interaction.kind==='question'?interaction.prompt:interaction.message}</p>
  {filesystemRetry&&<p>当前可直接读取明确路径。重新尝试将沿用原问题和附件，无需先关联项目目录。</p>}
  {interaction.kind==='question'?<form onSubmit={event=>{event.preventDefault();if(answer.trim()&&new TextEncoder().encode(answer).length<=4096)void submit({kind:'question',questionId:interaction.questionId,answer});}}>
   <textarea aria-label="回答当前问题" value={answer} rows={2} maxLength={4096} disabled={busy||submitted||uncertain} onChange={event=>{saved.answer=event.target.value;setAnswer(event.target.value);}}/>
   <button type="submit" disabled={busy||submitted||!answer.trim()||new TextEncoder().encode(answer).length>4096}>{submitted?'回答已记录，等待交付':uncertain?'核对同一次回答':'提交回答'}</button>
  </form>:interaction.kind==='configuration'?<div className="chat-interaction-actions">
   {!filesystemRetry&&configurationTools&&<fieldset className="chat-configuration-controls" disabled={busy||uncertain}>{configurationTools}</fieldset>}
   {!filesystemRetry&&<button type="button" disabled={busy||uncertain} onClick={onConfigure}>{interaction.action==='select_model'?'模型设置':interaction.action==='select_project'?'新建项目并选择目录':'核对命令环境'}</button>}
   <button type="button" disabled={busy||uncertain||configurationRetryDisabled} onClick={()=>void submit({kind:'configuration',decision:'retry'})}>{filesystemRetry?'重新尝试':'配置后继续'}</button>
   <button type="button" disabled={busy||uncertain} onClick={()=>void submit({kind:'configuration',decision:'cancel'})}>取消本次操作</button>
  </div>:<div className="chat-interaction-actions">
   <button type="button" disabled={busy||uncertain} onClick={()=>void submit({kind:'permission',permissionRequestId:interaction.permissionRequestId,decision:'allow_once'})}>确认这一次继续</button>
   <button type="button" disabled={busy||uncertain} onClick={()=>void submit({kind:'permission',permissionRequestId:interaction.permissionRequestId,decision:'deny'})}>拒绝</button>
  </div>}
  {uncertain&&interaction.kind!=='question'&&<button type="button" disabled={busy} onClick={()=>{if(attempt.current)void submit(attempt.current.decision);}}>核对同一次提交</button>}
  {notice&&<p role="status">{notice}</p>}
  {canStop&&<button type="button" disabled={stopping} onClick={onStop}>{stopping?'正在停止…':'停止'}</button>}
 </section>;
}
