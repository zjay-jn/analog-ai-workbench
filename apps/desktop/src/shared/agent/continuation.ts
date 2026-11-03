import type {SessionTurn} from './chat-sessions';
import {MAX_REPLY_BYTES} from './reply-limits';
export const CONTINUE_TEXT='请从上次中断的位置继续回答，衔接已有内容，不要重复已经完成的部分。';
export function canContinue(turn:SessionTurn):boolean{return ['failed','cancelled','interrupted'].includes(turn.status)&&!!turn.assistant.trim();}
/** Resolve main-owned source data; never accept reply text or attachments from the continuation caller. */
export function continuationSource(turns:SessionTurn[],id:string,completed=false){
 const last=turns.at(-1);if(!last||last.id!==id||!(canContinue(last)||(completed&&last.status==='completed')))throw Error('Invalid continuation target');
 let current=last;const chain=[current],seen=new Set([current.id]);
 while(current.continueFrom){const parent=turns.find(t=>t.id===current.continueFrom);if(!parent||seen.has(parent.id)||!canContinue(parent))throw Error('Invalid continuation chain');seen.add(parent.id);chain.unshift(parent);current=parent;}
 const assistant=chain.map(t=>t.assistant).join('\n\n');if(new TextEncoder().encode(assistant).length>MAX_REPLY_BYTES)throw Error('Continuation too large');
 return {root:chain[0]!,assistant};
}
export function completedHistory(turns:SessionTurn[]):SessionTurn[]{return turns.flatMap((turn,i)=>{if(turn.status!=='completed')return [];if(!turn.continueFrom)return [turn];try{const {root,assistant}=continuationSource(turns.slice(0,i+1),turn.id,true);return [{...root,assistant,status:'completed' as const}];}catch{return [];}});}
