import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,Fragment} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChatAgentParts} from '../apps/desktop/src/renderer/agent/ChatAgentParts';
import {ReplyFooter} from '../apps/desktop/src/renderer/agent/ReplyFooter';
import {projectReadError} from '../apps/desktop/src/renderer/agent/project-read-presentation';
import type {SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';
import type {ChatTurnActivity,ChatTurnExecution} from '../apps/desktop/src/shared/agent/chat-turns';
import type {ProjectReadEvent,ProjectReadSummary} from '../apps/desktop/src/shared/agent/agent-project-read';

const no=()=>{},time='2026-09-16T00:00:00.000Z',runId='synthetic-run',turnId='22222222-2222-4222-8222-222222222222',projectId='33333333-3333-4333-8333-333333333333';
const execution:ChatTurnExecution={executionId:'synthetic-execution',version:4,requestDigest:'a'.repeat(64),acceptedContext:{projectId,workspaceRevision:1,bindingId:'binding-a',bindingIdentity:'b'.repeat(64),provider:'kimi',model:'kimi-k3',historyVersion:'c'.repeat(64)},phase:'failed',cleanupState:'idle',runLink:{runId,workspaceId:null},parentTurnId:null,pendingInteraction:null};
const run:ProjectReadSummary={runId,clientRequestId:turnId,project:{projectId,bindingId:'binding-a',identity:'b'.repeat(64),name:'合成项目',directoryName:'fixture',directorySegments:['C','fixture']},model:{provider:'kimi',model:'kimi-k3'},goal:'合成失败原因展示',constraint:'',continuedFrom:null,status:'failed',cleanupState:'idle',createdAt:time,updatedAt:time,accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null},eventCount:4,continuation:null};
const turn:SessionTurn={id:turnId,user:'合成任务',assistant:'',status:'failed',error:'',execution};
const conflict:ProjectReadEvent={runId,sequence:1,time,type:'tool.completed',data:{sessionId:'engine-a',messageId:'message-a',callId:'call-a',toolName:'pilot_sum',arguments:{values:[1]},result:{ok:false,error:{code:'CONFLICT'},coverage:null}}};
const unmatched:ProjectReadEvent={runId,sequence:2,time,type:'tool.started',data:{sessionId:'engine-a',messageId:'message-a',callId:'call-b',toolName:'command_log',arguments:{executionId:'command-a',stream:'stdout',offset:0,maxBytes:1024,expectedPrefixVersion:null}}};
const failed:ProjectReadEvent={runId,sequence:3,time,type:'run.failed',data:{code:'BUDGET_EXCEEDED',stage:'model'}};
const cleaned:ProjectReadEvent={runId,sequence:4,time,type:'cleanup.completed',data:{outcome:'confirmed'}};
function activity(events:ProjectReadEvent[],override:Partial<ChatTurnActivity>={}):ChatTurnActivity{return {sessionId:'11111111-1111-4111-8111-111111111111',turnId,version:4,execution,run,parts:events.map(event=>({kind:'run_event',partId:'part-'+event.sequence,sequence:event.sequence,runId,event})),nextSequence:events.at(-1)?.sequence??0,hasMore:false,...override};}
const render=(value:ChatTurnActivity|null,source=turn)=>renderToStaticMarkup(createElement(ChatAgentParts,{turn:source,activity:value,reading:!!value?.hasMore,onRetry:no,onOpen:no,onAdvance:no}));
const previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
Object.defineProperty(globalThis,'window',{configurable:true,value:{matchMedia:()=>({matches:true})}});
test.after(()=>{if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else Reflect.deleteProperty(globalThis,'window');});

test('final run failure is distinct from an earlier recoverable conflict and cleanup action',()=>{
 const html=render(activity([conflict,unmatched,failed,cleaned]));
 const reason=html.match(/<p[^>]*data-run-failure="BUDGET_EXCEEDED"[^>]*>(.*?)<\/p>/)?.[1];
 assert.equal(reason,projectReadError('BUDGET_EXCEEDED'));assert.doesNotMatch(reason,/记录已经改变|执行资源已释放/);
 assert.match(html,/计算未完成：记录已经改变/);assert.match(html,/未确认完成/);assert.match(html,/在右侧查看执行详情/);
 assert.equal((html.match(/data-run-failure=/g)??[]).length,1);assert.doesNotMatch(html,/<dialog|自动重试/);
});
test('failed run without final event does not promote a tool conflict into final cause',()=>{
 const html=render(activity([conflict,unmatched]));assert.match(html,/回复未完成/);assert.match(html,/未确认完成/);assert.doesNotMatch(html,/data-run-failure/);
});
test('paged terminal activity waits for its actual failure event without guessing',()=>{
 const partial=render(activity([unmatched],{hasMore:true}));assert.match(partial,/正在读取较早的过程记录/);assert.doesNotMatch(partial,/data-run-failure/);
 assert.match(render(activity([unmatched,failed])),/本次任务达到预算限制/);
});
test('completed recovery keeps intermediate tool error but does not label the turn a failure',()=>{
 const completed={...execution,phase:'completed' as const};
 const html=render(activity([conflict],{execution:completed,run:{...run,status:'completed'}}),{...turn,status:'completed',execution:completed});
 assert.match(html,/计算未完成/);assert.doesNotMatch(html,/data-run-failure|本轮失败原因|执行失败/);
});
test('newer execution or different run identity cannot borrow an older terminal cause',()=>{
 const stale=activity([failed]);assert.doesNotMatch(render(stale,{...turn,execution:{...execution,version:5,phase:'completed'}}),/data-run-failure|本次任务达到预算限制/);
 assert.doesNotMatch(render({...stale,run:{...run,runId:'other-run'}}),/data-run-failure|本次任务达到预算限制/);
 assert.doesNotMatch(render(null),/data-run-failure|本次任务达到预算限制/);
});
test('known final failure does not hide pending or unconfirmed cleanup status',()=>{
 for(const cleanupState of ['pending','failed'] as const){
  const next={...execution,cleanupState},html=render(activity([failed],{execution:next,run:{...run,cleanupState}}),{...turn,execution:next});
  assert.match(html,/本次任务达到预算限制/);assert.match(html,cleanupState==='pending'?/正在核对执行收尾，暂时不能继续/:/执行收尾尚未确认，暂时不能继续/);
 }
});

test('a cancellation with uncertain cleanup is a stop request, not confirmed completion',()=>{
 for(const cleanupState of ['pending','failed','idle'] as const){
  const next={...execution,phase:'cancelled' as const,cleanupState};
  const html=render(activity([],{execution:next,run:{...run,status:'stopped',cleanupState}}),{...turn,status:'cancelled',execution:next});
  if(cleanupState==='idle'){assert.match(html,/已停止。/);assert.doesNotMatch(html,/暂时不能继续/);}
  else {assert.match(html,/已请求停止。/);assert.match(html,/暂时不能继续/);assert.doesNotMatch(html,/>已停止。/);}
 }
});

test('native failure shows its verified stage instead of a generic engine failure',()=>{
 const nativeFailure={origin:'native_adapter',stage:'text_projection',reason:'text_regression'} as const;
 const next={...execution,failureDiagnostic:{stage:'native_engine',reason:'ENGINE_FAILED',providerAttempts:4,httpDispatches:4,nativeFailure} as const};
 const event={...failed,data:{code:'ENGINE_FAILED',stage:'model'}} as ProjectReadEvent;
 const html=render(activity([event,cleaned],{execution:next}),{...turn,execution:next});
 assert.match(html,/同步回答内容时发现回答内容不一致/);assert.doesNotMatch(html,/任务引擎执行失败/);
});

test('specific saved failure replaces generic run failure and footer adds no second alert',()=>{
 const error='已连接模型服务，但返回内容未通过本地响应校验。';
 const source={...turn,assistant:'已收到的部分回答。',error};
 const event={...failed,data:{code:'ENGINE_FAILED',stage:'model'}} as ProjectReadEvent;
 const html=renderToStaticMarkup(createElement(Fragment,null,
  createElement(ChatAgentParts,{turn:source,activity:activity([event,cleaned]),onRetry:no,onOpen:no,onAdvance:no}),
  createElement(ReplyFooter,{text:source.assistant,model:'Kimi K3',status:source.status,elapsedMs:33000,compact:true,limits:{maxOutputTokens:8192,requestTimeoutMs:120000,turnTimeoutMs:null}}),
 ));
 assert.equal(html.split(error).length-1,1);assert.equal((html.match(/role="alert"/g)??[]).length,1);
 assert.doesNotMatch(html,/任务引擎执行失败|cloud-turn-error|本轮失败原因|回复未完成/);
 assert.match(html,/Kimi K3/);assert.match(html,/33秒/);assert.match(html,/aria-label="本轮设置"/);assert.match(html,/复制回复/);
});

test('individual tool summaries stay inline in narrative order without a collapsed parent group',()=>{
 const tool=(sequence:number,callId:string):ProjectReadEvent=>({runId,sequence,time,type:'tool.started',data:{sessionId:'engine-a',messageId:'message-a',callId,toolName:'pilot_sum',arguments:{values:[1]}}});
 const events=[tool(2,'call-first'),tool(3,'call-second'),tool(5,'call-third')];
 const original=activity(events),value:ChatTurnActivity={...original,parts:[
  {kind:'text',partId:'text-1',sequence:1,text:'叙述甲'},original.parts[0]!,original.parts[1]!,
  {kind:'text',partId:'text-4',sequence:4,text:'叙述乙'},original.parts[2]!,
  {kind:'text',partId:'text-6',sequence:6,text:'叙述丙'},
 ]};
 const html=render(value),rows=[...html.matchAll(/<details class="chat-tool-disclosure"[^>]*>/g)];
 assert.equal(rows.length,3);assert(rows.every(row=>!row[0].includes('open')));
 assert.doesNotMatch(html,/chat-tool-group|个步骤|已完成 2|完成2/);
 const order=['叙述甲','data-tool-call="call-first"','data-tool-call="call-second"','叙述乙','data-tool-call="call-third"','叙述丙'].map(text=>html.indexOf(text));
 assert(order.every((position,index)=>position>=0&&(index===0||position>order[index-1]!)));
 assert.equal((html.match(/data-tool-call=/g)??[]).length,3);
 const summaries=[...html.matchAll(/<summary[^>]*>(.*?)<\/summary>/g)];
 assert.equal(summaries.length,3);assert(summaries.every(summary=>/计算/.test(summary[1]!)&&/未确认完成/.test(summary[1]!)));
});

test('activity read failure remains a separate read-only retry rather than replacing the saved execution cause',()=>{
 const error='过程记录暂时无法核对，已保留收到的内容。';
 const html=renderToStaticMarkup(createElement(ChatAgentParts,{turn:{...turn,error:'模型服务连接或传输失败，请稍后手动发送。'},activity:null,error,onRetry:no,onOpen:no,onAdvance:no}));
 assert.equal(html.split(error).length-1,1);assert.match(html,/模型服务连接或传输失败/);assert.match(html,/<button[^>]*>重新核对<\/button>/);
 assert.doesNotMatch(html,/任务引擎执行失败/);
});

test('legacy footer still shows its error while compact native footer keeps metadata and actions together',()=>{
 const legacy=renderToStaticMarkup(createElement(ReplyFooter,{text:'部分回答',model:'Kimi K3',status:'failed',error:'旧会话错误'}));
 assert.match(legacy,/回复未完成/);assert.match(legacy,/class="cloud-turn-error">旧会话错误/);
 const compact=renderToStaticMarkup(createElement(ReplyFooter,{text:'部分回答',model:'Kimi K3',status:'failed',compact:true},createElement('button',{type:'button',disabled:true},'继续处理')));
 assert.doesNotMatch(compact,/回复未完成|cloud-turn-error/);assert.match(compact,/class="reply-footer-actions"><button[^>]*disabled=""[^>]*>继续处理/);
});
