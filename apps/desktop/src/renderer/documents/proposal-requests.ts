import type {ProposalJob} from '../../shared/agent/project-workspace';
import type {SessionTurn} from '../../shared/agent/chat-sessions';
import type {FileContext} from '../../shared/agent/file-context';
import {replacementFromReply,replaceLineRange} from '../../shared/agent/reviewed-edit';
export type ProposalSendOutcome='accepted'|'rejected'|'uncertain';
/** Ordered field tuples are stable across IPC parsing and workspace restart. */
export async function proposalRequestFingerprint(sessionId:string,requestId:string,text:string,images:NonNullable<SessionTurn['images']>,files:FileContext[]):Promise<string>{
 const payload=JSON.stringify(['proposal-request-v1',sessionId,requestId,text,images.map(i=>[i.id,i.name,i.data,i.width,i.height]),files.map(f=>[f.id,f.name,f.text,f.startLine,f.endLine,f.totalLines])]);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
}
export async function submitProposal(job:ProposalJob,setJobs:(update:(jobs:ProposalJob[])=>ProposalJob[])=>Promise<boolean>,send:()=>Promise<ProposalSendOutcome>):Promise<ProposalSendOutcome>{
 if(!await setJobs(jobs=>[...jobs,job]))return 'rejected';
 let result:ProposalSendOutcome;try{result=await send();}catch{result='uncertain';}
 // Only a confirmed refusal permits removing the recovery record. Never resend.
 if(result==='rejected'&&!await setJobs(jobs=>jobs.filter(value=>value.id!==job.id)))return 'uncertain';
 return result;
}
export async function reconcileProposalJobs(jobs:ProposalJob[],sessionId:string,turns:SessionTurn[]):Promise<ProposalJob[]>{
 let changed=false;const next=await Promise.all(jobs.map(async job=>{
  if(job.status!=='waiting'||job.sessionId!==sessionId)return job;const turn=turns.find(t=>t.id===job.id);if(!turn)return job;
  const matches=!!job.requestFingerprint&&!turn.continueFrom&&job.requestFingerprint===await proposalRequestFingerprint(sessionId,turn.id,turn.user,turn.images??[],turn.files??[]);
  if(!matches){const error=job.requestFingerprint?'对应记录与原修改请求不一致；不会作为提案，请手动核对或移除。':'旧提案缺少原请求核对信息；请手动核对聊天记录或移除，不会自动生成修改稿。';if(job.error===error)return job;changed=true;return {...job,error};}
  if(turn.status==='running')return job;changed=true;
  try{if(turn.status!=='completed')throw Error();const after=replaceLineRange(job.document.text,job.excerpt.startLine,job.excerpt.endLine,replacementFromReply(turn.assistant));const {error:_,...rest}=job;return {...rest,after,status:'review' as const};}
  catch{return {...job,status:'rejected' as const,error:turn.status==='completed'?'回复不是单个完整代码块，不能作为修改稿。请重新请求。':'回复未完整结束，不能作为修改稿。请重新请求。'};}
 }));return changed?next:jobs;
}
