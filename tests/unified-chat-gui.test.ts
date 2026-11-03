import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createChatAgentController,mergeChatActivity,chatExecutionLabel,chatTurnActive,restoreBlockedChatDraft} from '../apps/desktop/src/renderer/agent/chat-agent-controller';
import {ChatAgentParts,chatActivityProjection} from '../apps/desktop/src/renderer/agent/ChatAgentParts';
import {ChatAgentTurn} from '../apps/desktop/src/renderer/agent/ChatAgentTurn';
import {ChatInteractionDock,emptyChatInteractionMemory} from '../apps/desktop/src/renderer/agent/ChatInteractionDock';
import {FileWorkbench} from '../apps/desktop/src/renderer/documents/FileWorkbench';
import {parseSessionMethodResult,type SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';
import type {ChatTurnActivity,ChatTurnExecution,ChatTurnPart} from '../apps/desktop/src/shared/agent/chat-turns';
import type {ProjectReadSummary,ProjectReadEvent} from '../apps/desktop/src/shared/agent/agent-project-read';

const sessionId='11111111-1111-4111-8111-111111111111',turnId='22222222-2222-4222-8222-222222222222',projectId='33333333-3333-4333-8333-333333333333',time='2026-09-16T00:00:00.000Z';
const execution=():ChatTurnExecution=>({executionId:'execution-a',version:1,requestDigest:'a'.repeat(64),acceptedContext:{projectId,workspaceRevision:2,bindingId:'binding-a',bindingIdentity:'b'.repeat(64),provider:'kimi',model:'kimi-k3',historyVersion:'c'.repeat(64)},phase:'running',cleanupState:'idle',runLink:null,parentTurnId:null,pendingInteraction:null});
const turn=(override:Partial<SessionTurn>={}):SessionTurn=>({id:turnId,user:'分析此文件',assistant:'',status:'running',error:'',provider:'kimi',model:'kimi-k3',execution:execution(),...override});
const part=(sequence:number,text=`text-${sequence}`):ChatTurnPart=>({kind:'text',partId:`part-${sequence}`,sequence,text});
const page=(parts:readonly ChatTurnPart[]=[],override:Partial<ChatTurnActivity>={}):ChatTurnActivity=>({sessionId,turnId,version:1,execution:execution(),run:null,parts,nextSequence:parts.at(-1)?.sequence??0,hasMore:false,...override});
const run=(workspaceId:string|null=null):ProjectReadSummary=>({runId:'run-a',clientRequestId:turnId,project:{projectId,bindingId:'binding-a',identity:'b'.repeat(64),name:'合成项目',directoryName:'fixture',directorySegments:['C','fixture']},model:{provider:'kimi',model:'kimi-k3'},goal:'合成GUI验收',constraint:'',continuedFrom:null,status:'running',cleanupState:'idle',createdAt:time,updatedAt:time,accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null},eventCount:1,continuation:null,origin:{chatSessionId:sessionId,turnId,executionId:'execution-a',inputDigest:'a'.repeat(64)},...(workspaceId?{workCycle:{workspaceId}}:{})});
const linked=(parts:readonly ChatTurnPart[]=[],workspaceId:string|null=null):ChatTurnActivity=>page(parts,{execution:{...execution(),runLink:{runId:'run-a',workspaceId}},run:run(workspaceId)});
function clock(){let serial=0;const tasks=new Map<number,()=>void>();return {set:(fn:()=>void)=>{tasks.set(++serial,fn);return serial;},clear:(id:unknown)=>{tasks.delete(id as number);},count:()=>tasks.size,tick:async()=>{const next=tasks.entries().next().value;if(next){tasks.delete(next[0]);next[1]();}await new Promise<void>(resolve=>setImmediate(resolve));}};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const no=()=>{};
const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
Object.defineProperty(globalThis,'window',{configurable:true,value:{matchMedia:()=>({matches:true})}});
test.after(()=>{if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');});

test('cold chat displays its saved compaction count without an activity page or tool action',()=>{
 const saved=turn({status:'completed',assistant:'retained answer',execution:{...execution(),phase:'completed',compaction:{version:2,sourceHash:'d'.repeat(64),summaryHash:'e'.repeat(64),coveredResponses:68}}});
 const html=renderToStaticMarkup(createElement(ChatAgentParts,{turn:saved,activity:null,onRetry:()=>assert.fail('unexpected reload'),onOpen:()=>assert.fail('unexpected tool execution'),onAdvance:no}));
 assert.match(html,/已压缩上下文 2 次/u);assert.match(html,/原始聊天记录保留/u);assert.match(html,/retained answer/u);assert.doesNotMatch(html,/d{64}|e{64}/u);
});

test('formal activity result parses independently from SessionState',()=>{
 const parsed=parseSessionMethodResult('readTurnActivity',{ok:true,value:linked([part(1)])});assert(parsed.ok);assert.equal(parsed.value.turnId,turnId);
 assert.throws(()=>parseSessionMethodResult('readState',{ok:true,value:linked([part(1)])}));
});
test('immutable repeated pages are idempotent and subsequent pages append once',()=>{
 const first=mergeChatActivity(null,page([part(1)],{hasMore:true}),sessionId,turn());
 const again=mergeChatActivity(first,page([part(1)],{hasMore:true}),sessionId,turn());assert.equal(again.parts.length,1);
 const next=mergeChatActivity(again,page([part(2)]),sessionId,turn());assert.deepEqual(next.parts.map(p=>p.sequence),[1,2]);
 assert.throws(()=>mergeChatActivity(next,page([part(2,'changed')]),sessionId,turn()),/Part changed/);
 assert.throws(()=>mergeChatActivity(first,page([part(3)]),sessionId,turn()),/sequence gap/);
});
test('wrong session, turn, model, origin and run events are refused',()=>{
 assert.throws(()=>mergeChatActivity(null,page(),turnId,turn()));
 assert.throws(()=>mergeChatActivity(null,page(),sessionId,turn({id:projectId})));
 assert.throws(()=>mergeChatActivity(null,page([],{execution:{...execution(),acceptedContext:{...execution().acceptedContext,model:'deepseek-v4-flash',provider:'deepseek'}}}),sessionId,turn()));
 const wrong=linked();assert.throws(()=>mergeChatActivity(null,{...wrong,run:{...wrong.run!,origin:{...wrong.run!.origin!,turnId:projectId}}},sessionId,turn()),/origin/);
 const event:ProjectReadEvent={runId:'another-run',sequence:1,time,type:'run.completed',data:{citations:[]}};
 assert.throws(()=>mergeChatActivity(null,linked([{kind:'run_event',partId:'event-1',sequence:1,runId:'another-run',event}]),sessionId,turn()));
});
test('lazy run/workspace materialization is accepted once but cannot swap or clear a known workspace',()=>{
 const first=mergeChatActivity(null,page(),sessionId,turn());
 const reading=mergeChatActivity(first,linked(),sessionId,turn());
 const work=mergeChatActivity(reading,linked([],'workspace-a'),sessionId,turn());assert.equal(work.execution?.runLink?.workspaceId,'workspace-a');
 assert.throws(()=>mergeChatActivity(work,linked([],'workspace-b'),sessionId,turn()),/Run link/);
 assert.throws(()=>mergeChatActivity(work,linked(),sessionId,turn()),/Run link/);
});
test('old turns without executions do not schedule activity or replay',async()=>{
 const timer=clock();let reads=0;const controller=createChatAgentController(async()=>{reads++;return page();},timer);
 const old=turn();delete old.execution;controller.setSession(sessionId,[old]);await timer.tick();assert.equal(reads,0);assert.equal(timer.count(),0);controller.dispose();
});
test('terminal page drain is bounded by hasMore and unchanged versions do not cause a read loop',async()=>{
 const timer=clock(),cursors:number[]=[];const controller=createChatAgentController(async(_s,_t,cursor)=>{cursors.push(cursor);return cursor===0?page([part(1)],{hasMore:true}):page([part(2)],{version:2,execution:{...execution(),version:2}});},timer);
 const finished=turn({status:'completed',assistant:'done',execution:{...execution(),phase:'completed'}});
 controller.setSession(sessionId,[finished]);await timer.tick();await timer.tick();assert.deepEqual(cursors,[0,1]);assert.equal(timer.count(),0);
 controller.setSession(sessionId,[finished]);await timer.tick();assert.deepEqual(cursors,[0,1]);controller.dispose();
});
test('late page from the old chat cannot populate the newly selected chat',async()=>{
 const timer=clock(),wait=deferred<ChatTurnActivity>();const controller=createChatAgentController(()=>wait.promise,timer);
 controller.setSession(sessionId,[turn()]);await timer.tick();controller.setSession(projectId,[]);wait.resolve(page([part(1)]));await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(controller.snapshot().sessionId,projectId);assert.deepEqual(controller.snapshot().entries,{});controller.dispose();
});
test('failed read retains received content and retries only after explicit request',async()=>{
 const timer=clock();let reads=0;const controller=createChatAgentController(async()=>{reads++;if(reads===2)throw Error('offline');return page([part(reads===1?1:2)],{hasMore:reads===1});},timer);
 controller.setSession(sessionId,[turn()]);await timer.tick();await timer.tick();assert.equal(controller.snapshot().entries[turnId]?.activity?.parts.length,1);assert(controller.snapshot().entries[turnId]?.error);assert.equal(timer.count(),0);
 controller.retry(turnId);await timer.tick();assert.equal(controller.snapshot().entries[turnId]?.activity?.parts.length,2);assert.equal(controller.snapshot().entries[turnId]?.error,null);controller.dispose();
});
test('disposed controller drops outstanding observations and timers',async()=>{
 const timer=clock(),wait=deferred<ChatTurnActivity>();let changes=0;const controller=createChatAgentController(()=>wait.promise,timer);controller.subscribe(()=>changes++);
 controller.setSession(sessionId,[turn()]);await timer.tick();const before=changes;controller.dispose();wait.resolve(page([part(1)]));await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(changes,before);assert.equal(timer.count(),0);
});
test('plain text chunks coalesce into a paragraph and tools keep chronological placement',()=>{
 const event:ProjectReadEvent={runId:'run-a',sequence:1,time,type:'tool.started',data:{sessionId:'engine-session-a',messageId:'message-a',callId:'call-a',toolName:'pilot_sum',arguments:{values:[1,2]}}};
 const parts=[part(1,'前'),part(2,'文'),{kind:'run_event' as const,partId:'tool-1',sequence:3,runId:'run-a',event},part(4,'后'),part(5,'文')];
 const timeline=chatActivityProjection(linked(parts)).timeline;assert.deepEqual(timeline.map(item=>item.kind),['text','tool','text']);assert.equal(timeline[0]?.kind==='text'&&timeline[0].text,'前文');assert.equal(timeline[2]?.kind==='text'&&timeline[2].text,'后文');assert.equal(parts[0]!.kind==='text'&&parts[0]!.text,'前');
});
test('tool details default to collapsed and failed result remains visible',()=>{
 const event:ProjectReadEvent={runId:'run-a',sequence:1,time,type:'tool.completed',data:{sessionId:'engine-session-a',messageId:'message-a',callId:'call-a',toolName:'pilot_sum',arguments:{values:[1]},result:{ok:false,error:{code:'ENGINE_FAILED'},coverage:null}}};
 const activity=linked([{kind:'run_event',partId:'tool-1',sequence:1,runId:'run-a',event}]);
 const html=renderToStaticMarkup(createElement(ChatAgentParts,{turn:turn(),activity,onRetry:no,onOpen:no,onAdvance:no}));
 assert.match(html,/<details class="chat-tool-disclosure"[^>]*>/);assert.doesNotMatch(html,/<details[^>]*open/);assert.match(html,/class="chat-tool-failure"/);assert.doesNotMatch(html,/查看结果|运行记录|任务目标|开始任务/);
});
test('cleanup pending or failed never reads as fully stopped/completed',()=>{
 assert(chatTurnActive({...execution(),phase:'cancelled',cleanupState:'pending'}));
 assert.match(chatExecutionLabel({...execution(),phase:'cancelled',cleanupState:'pending'}),/收尾/);
 assert.match(chatExecutionLabel({...execution(),phase:'completed',cleanupState:'failed'}),/尚未确认/);
 assert.equal(chatExecutionLabel({...execution(),phase:'cancelled'}),'已停止');
});
test('question dock has one dedicated answer field, submission state and an independent stop',()=>{
 const html=renderToStaticMarkup(createElement(ChatInteractionDock,{interaction:{kind:'question',interactionId:'i-a',questionId:'q-a',prompt:'哪一列？',state:'submitted'},onSubmit:async()=>({status:'uncertain' as const}),onConfigure:no,onStop:no,stopping:false,canStop:true}));
 assert.equal((html.match(/<textarea/g)??[]).length,1);assert.match(html,/textarea[^>]*disabled/);assert.match(html,/回答已记录，等待交付/);assert.match(html,/>停止<\/button>/);assert.doesNotMatch(html,/云端消息|发送云端消息/);
});
test('permission dock offers exactly one-time continuation or deny, no general grant',()=>{
 const html=renderToStaticMarkup(createElement(ChatInteractionDock,{interaction:{kind:'permission',interactionId:'i-a',permissionRequestId:'p-a',operation:'continue_verified_work',sourceRunId:'run-a',recoveryVersion:'d'.repeat(64),message:'继续已核定的成果？'},onSubmit:async()=>({status:'uncertain' as const}),onConfigure:no,onStop:no,stopping:false,canStop:false}));
 assert.match(html,/确认这一次继续/);assert.match(html,/>拒绝<\/button>/);assert.doesNotMatch(html,/始终允许|全部允许|<textarea/);
});
test('existing user image, file and question render once in unified turn',()=>{
 const html=renderToStaticMarkup(createElement(ChatAgentTurn,{turn:turn({images:[{id:'image-a',name:'fixture.jpg',data:'',width:24,height:16}],files:[{id:projectId,name:'fixture.md',text:'内容',startLine:1,endLine:1,totalLines:1}]}),onOpenFile:no,onPreviewSchematic:no,children:'回复'}));
 assert.equal((html.match(/role="img"/g)??[]).length,1);assert.match(html,/fixture\.md/);assert.match(html,/分析此文件/);assert.equal((html.match(/cloud-assistant-message/g)??[]).length,1);
});
test('right result is a tab inside the same document pane and suppresses other active panels',()=>{
 const file={id:projectId,name:'fixture.md',text:'# 标题',startLine:1,endLine:1,totalLines:1};
 const html=renderToStaticMarkup(createElement(FileWorkbench,{onAttach:no,canAttach:false,view:null,initial:{documents:[file],active:file.id,start:1,end:1},schematic:{opened:true,active:true,onOpen:no,onSelect:no,onClose:no,onSelectText:no,content:'原理图'},result:{title:'工具结果',active:true,onSelect:no,onClose:no,onSelectText:no,content:'结果正文'}}));
 assert.equal((html.match(/<aside/g)??[]).length,1);assert.equal((html.match(/aria-selected="true"/g)??[]).length,1);assert.match(html,/id="file-text-panel"[^>]*hidden/);assert.match(html,/id="file-schematic-panel"[^>]*hidden/);assert.doesNotMatch(html,/id="file-result-panel"[^>]*hidden/);assert.match(html,/关闭工具结果/);
});

test('cancelled configuration restores original images/files without overwriting a newer draft',()=>{
 const source=turn({images:[{id:'image-a',name:'fixture.jpg',data:'',width:2,height:2}],files:[{id:projectId,name:'fixture.md',text:'内容',startLine:1,endLine:1,totalLines:1}]});
 const restored=restoreBlockedChatDraft({text:'',revision:4,images:[],files:[]},source);assert.equal(restored.revision,5);assert.equal(restored.text,source.user);assert.deepEqual(restored.images,source.images);assert.deepEqual(restored.files,source.files);assert.notEqual(restored.files,source.files);
 const draft={text:'新的草稿',revision:6,images:[],files:[]};assert.equal(restoreBlockedChatDraft(draft,source),draft);
});
test('returning to an uncertain question preserves answer and original request identity',()=>{
 const memory=emptyChatInteractionMemory();memory.answer='使用第三列';memory.uncertain=true;memory.attempt={requestId:projectId,decision:{kind:'question',questionId:'q-a',answer:memory.answer}};
 const html=renderToStaticMarkup(createElement(ChatInteractionDock,{memory,interaction:{kind:'question',interactionId:'i-a',questionId:'q-a',prompt:'哪一列？',state:'pending'},onSubmit:async()=>({status:'uncertain' as const}),onConfigure:no,onStop:no,stopping:false,canStop:true}));
 assert.match(html,/使用第三列/);assert.match(html,/核对同一次回答/);assert.match(html,/textarea[^>]*disabled/);assert.equal(memory.attempt.requestId,projectId);
});
test('non-advancing hasMore response is not polled forever',async()=>{
 const timer=clock();let reads=0;const controller=createChatAgentController(async()=>{reads++;return page([part(1)],{hasMore:true});},timer);
 controller.setSession(sessionId,[turn()]);await timer.tick();await timer.tick();assert.equal(reads,2);assert.equal(timer.count(),0);assert(controller.snapshot().entries[turnId]?.error);controller.dispose();
});
test('active turn reads new broker events even when execution version is unchanged',async()=>{
 const timer=clock();let reads=0;const controller=createChatAgentController(async(_s,_t,cursor)=>{reads++;return page([part(cursor+1)],{version:reads});},timer);
 controller.setSession(sessionId,[turn()]);await timer.tick();await timer.tick();await timer.tick();assert.equal(reads,3);assert.equal(controller.snapshot().entries[turnId]?.activity?.parts.length,3);
 controller.setSession(sessionId,[turn({status:'completed',assistant:'done',execution:{...execution(),phase:'completed'}})]);assert.equal(timer.count(),0);controller.dispose();
});
test('no-run completed clarification history shows saved question, delivered answer and final text',()=>{
 const e={...execution(),phase:'completed' as const,clarifications:[{questionId:'q-native',prompt:'采用哪种单位？',answer:'毫伏',delivered:true}]};
 const html=renderToStaticMarkup(createElement(ChatAgentParts,{turn:turn({status:'completed',assistant:'已按毫伏整理结果。',execution:e}),activity:null,onRetry:no,onOpen:no,onAdvance:no}));
 assert.match(html,/采用哪种单位？/);assert.match(html,/你的回答：<\/strong>毫伏/);assert.match(html,/回答已交付/);assert.match(html,/已按毫伏整理结果/);assert.doesNotMatch(html,/查看成果与日志|<textarea/);
});
test('no-run clarification distinguishes submitted, unanswered and current unanswered dock',()=>{
 const render=(e:ChatTurnExecution)=>renderToStaticMarkup(createElement(ChatAgentParts,{turn:turn({execution:e}),activity:null,onRetry:no,onOpen:no,onAdvance:no}));
 const e={...execution(),clarifications:[{questionId:'q-native',prompt:'采用哪种单位？',answer:'毫伏',delivered:false}]};
 const submitted=render(e);assert.match(submitted,/回答已记录，交付尚未确认/);assert.doesNotMatch(submitted,/回答已交付/);
 const unanswered={...e,clarifications:[{...e.clarifications[0]!,answer:null}]};assert.match(render({...unanswered,phase:'interrupted'}),/尚未回答/);
 assert.doesNotMatch(render({...unanswered,pendingInteraction:{kind:'question',interactionId:'i-native',questionId:'q-native',prompt:'采用哪种单位？',state:'pending'}}),/data-question-id/);
});
test('linked run uses its question events once and does not repeat execution clarifications',()=>{
 const q={questionId:'q-native',prompt:'采用哪种单位？',answer:'毫伏',delivered:true};
 const events:ProjectReadEvent[]=[{runId:'run-a',sequence:1,time,type:'question.asked',data:{questionId:q.questionId,prompt:q.prompt}},{runId:'run-a',sequence:2,time,type:'question.answered',data:{questionId:q.questionId,answer:q.answer}},{runId:'run-a',sequence:3,time,type:'question.delivered',data:{questionId:q.questionId}}];
 const activity=linked(events.map((event,index)=>({kind:'run_event',partId:`event-${index+1}`,sequence:index+1,runId:'run-a',event})));activity.execution!.clarifications=[q];
 const html=renderToStaticMarkup(createElement(ChatAgentParts,{turn:turn({execution:activity.execution!}),activity,onRetry:no,onOpen:no,onAdvance:no}));
 assert.equal((html.match(/采用哪种单位？/g)??[]).length,1);assert.equal((html.match(/毫伏/g)??[]).length,1);assert.doesNotMatch(html,/data-question-id/);
});
