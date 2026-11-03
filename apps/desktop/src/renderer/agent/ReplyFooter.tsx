import {ChatCopyButton} from './ChatMarkdown';
import type {ReactNode} from 'react';
import type {ChatTurnLimits} from '../../shared/agent/reply-limits';
import {replyLimitDuration,replyTurnLimit} from './reply-limit-presentation';
export function replyDuration(elapsedMs:number):string{const seconds=Math.floor(elapsedMs/1000);if(seconds<1)return '不到1秒';if(seconds<60)return seconds+'秒';return Math.floor(seconds/60)+'分'+seconds%60+'秒';}
const statuses={running:'正在回复',completed:'',failed:'回复未完成',cancelled:'已停止',interrupted:'已中断'};
export function ReplyFooter({text,model,status,elapsedMs,limits,error,compact=false,children}:{text:string;model:string;status:keyof typeof statuses;elapsedMs?:number|undefined;limits?:ChatTurnLimits|undefined;error?:string|undefined;compact?:boolean;children?:ReactNode}){
 return <><div className={'cloud-response-footer'+(compact?' compact-reply-footer':'')}>{text&&<ChatCopyButton text={text}/>}<span className="reply-metadata">{model}{!compact&&statuses[status]&&<> · {statuses[status]}</>}{elapsedMs!==undefined&&<span title="本轮从开始到结束的耗时"> · {replyDuration(elapsedMs)}</span>}</span>
  {limits&&<details className="reply-limits" aria-label="本轮使用的设置"><summary aria-label="本轮设置" title="本轮设置">{compact?'···':'本轮设置'}</summary>
   <p>单次模型请求上限：{replyLimitDuration(limits.requestTimeoutMs)} · 整轮任务上限：{replyTurnLimit(limits.turnTimeoutMs)}</p>
   <p>输出预算：{limits.maxOutputTokens} tokens</p>
  </details>}
 {children&&<span className="reply-footer-actions">{children}</span>}</div>{error&&<p className="cloud-turn-error">{error}</p>}</>;
}
