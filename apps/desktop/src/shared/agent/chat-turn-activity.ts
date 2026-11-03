import {CHAT_TURN_ACTIVITY_BYTES,CHAT_TURN_ACTIVITY_PAGE,CHAT_TURN_PHASES,parseChatTurnExecution,parseChatTurnInteraction,type ChatTurnActivity,type ChatTurnPart,type ChatTurnPhase} from './chat-turns';
import {parseProjectReadEvent,parseProjectReadValue} from './agent-project-read-validation';

const bad=():never=>{throw TypeError('Invalid chat activity');};
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length)return bad();
 const out:Record<string,unknown>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!('value'in d))return bad();out[key]=d.value;}return out;
}
const integer=(v:unknown,min=0):number=>typeof v==='number'&&Number.isSafeInteger(v)&&!Object.is(v,-0)&&v>=min?v:bad();
const text=(v:unknown,max:number):string=>typeof v==='string'&&new TextEncoder().encode(v).length<=max&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)?v:bad();
const id=(v:unknown):string=>{const s=text(v,256);return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(s)?s:bad();};
const uuid=(v:unknown):string=>{const s=text(v,36);return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(s)?s:bad();};
function part(value:unknown):ChatTurnPart{
 const kind=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'kind')?.value:undefined;
 const keys=['kind','partId','sequence'];
 if(kind==='text'){const v=exact(value,[...keys,'text']);return {kind,partId:id(v.partId),sequence:integer(v.sequence,1),text:text(v.text,CHAT_TURN_ACTIVITY_BYTES)};}
 if(kind==='run_event'){const v=exact(value,[...keys,'runId','event']),event=parseProjectReadEvent(v.event);if(!event||event.runId!==v.runId)return bad();return {kind,partId:id(v.partId),sequence:integer(v.sequence,1),runId:id(v.runId),event};}
 if(kind==='interaction'){const v=exact(value,[...keys,'interaction']);return {kind,partId:id(v.partId),sequence:integer(v.sequence,1),interaction:parseChatTurnInteraction(v.interaction)};}
 if(kind==='status'){const v=exact(value,[...keys,'phase','cleanupState','message']);if(!CHAT_TURN_PHASES.includes(v.phase as ChatTurnPhase)||!['idle','pending','failed'].includes(v.cleanupState as string))return bad();return {kind,partId:id(v.partId),sequence:integer(v.sequence,1),phase:v.phase as ChatTurnPhase,cleanupState:v.cleanupState as 'idle'|'pending'|'failed',message:text(v.message,4096)};}
 return bad();
}
export function parseChatTurnActivity(value:unknown):ChatTurnActivity{
 const v=exact(value,['sessionId','turnId','version','execution','run','parts','nextSequence','hasMore']);
 const sessionId=uuid(v.sessionId),turnId=uuid(v.turnId),version=integer(v.version),execution=v.execution===null?null:parseChatTurnExecution(v.execution);
 const parsed=v.run===null?null:parseProjectReadValue('listRuns',{runs:[v.run],nextBefore:null});if(v.run!==null&&!parsed)return bad();const run=parsed?.runs[0]??null;
 if((execution?.runLink?.runId??null)!==(run?.runId??null))return bad();
 if(run&&execution){const c=execution.acceptedContext,o=run.origin;if(!o||o.chatSessionId!==sessionId||o.turnId!==turnId||o.executionId!==execution.executionId||o.inputDigest!==execution.requestDigest||run.project.projectId!==c.projectId||run.project.bindingId!==c.bindingId||run.project.identity!==c.bindingIdentity||run.model.provider!==c.provider||run.model.model!==c.model||(run.workCycle?.workspaceId??null)!==execution.runLink?.workspaceId)return bad();}
 if(!Array.isArray(v.parts)||Object.getPrototypeOf(v.parts)!==Array.prototype||v.parts.length>CHAT_TURN_ACTIVITY_PAGE||Reflect.ownKeys(v.parts).length!==v.parts.length+1)return bad();
 const parts:ChatTurnPart[]=[];for(let i=0;i<v.parts.length;i++){const d=Object.getOwnPropertyDescriptor(v.parts,String(i));if(!d||!('value'in d))return bad();parts.push(part(d.value));}
 const nextSequence=integer(v.nextSequence);if(typeof v.hasMore!=='boolean'||v.hasMore&&!parts.length||parts.length&&parts.at(-1)!.sequence!==nextSequence)return bad();
 if(new Set(parts.map(p=>p.partId)).size!==parts.length||parts.some((p,i)=>i>0&&p.sequence!==parts[i-1]!.sequence+1||p.kind==='run_event'&&p.runId!==run?.runId))return bad();
 const result={sessionId,turnId,version,execution,run,parts,nextSequence,hasMore:v.hasMore};if(new TextEncoder().encode(JSON.stringify(result)).length>CHAT_TURN_ACTIVITY_BYTES)return bad();return result;
}
