import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChatAgentParts,chatActivityProjection} from '../apps/desktop/src/renderer/agent/ChatAgentParts';
import {ChatAgentResults,type ChatResultRequest} from '../apps/desktop/src/renderer/agent/ChatAgentResults';
import {ProjectReadResults,ProjectReadCoverageView} from '../apps/desktop/src/renderer/agent/ProjectReadResults';
import {ChatInteractionDock,chatFilesystemRetry,emptyChatInteractionMemory} from '../apps/desktop/src/renderer/agent/ChatInteractionDock';
import {projectCitationPath,projectMessageCitations} from '../apps/desktop/src/renderer/agent/project-read-presentation';
import {mergeChatActivity} from '../apps/desktop/src/renderer/agent/chat-agent-controller';
import {describeToolOutput} from '../apps/desktop/src/shared/agent/tool-output';
import {ToolOutputSummary} from '../apps/desktop/src/renderer/agent/ToolOutputSummary';
import {parseSessionResult,type SessionState,type SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';
import {parseChatTurnActivity} from '../apps/desktop/src/shared/agent/chat-turn-activity';
import type {ChatTurnActivity,ChatTurnExecution,ChatTurnInteraction} from '../apps/desktop/src/shared/agent/chat-turns';
import type {ProjectReadCitationPreview,ProjectReadCoverage,ProjectReadToolResult,ProjectReadEvent,ProjectReadSummary,WorkbenchAgentProjectReadApi} from '../apps/desktop/src/shared/agent/agent-project-read';
import {parseProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import type {FileSystemSourceRef} from '../apps/desktop/src/shared/agent/agent-filesystem-read';

const no=()=>{},digest='a'.repeat(64),time='2026-09-17T00:00:00.000Z';
const sessionId='11111111-1111-4111-8111-111111111111',turnId='22222222-2222-4222-8222-222222222222',projectId='33333333-3333-4333-8333-333333333333';
const source=(suffix:string):FileSystemSourceRef=>({kind:'windows_filesystem',sourceId:'source-'+suffix,rootPath:'C:\\synthetic\\source-'+suffix,rootIdentity:suffix==='A'?digest:'b'.repeat(64)});
function citation(suffix:string,legacy=false):ProjectReadCitationPreview{
 const excerpt='saved '+suffix+' <script>text only</script>',hash=createHash('sha256').update(excerpt).digest('hex');
 return {citationId:'citation-'+suffix,fileId:'file-'+suffix,relativePath:'same.md',version:suffix==='A'?digest:'b'.repeat(64),normalizedSha256:hash,
  range:{start:{line:2,column:3},end:{line:2,column:3+[...excerpt].length}},excerpt,excerptSha256:hash,totalLines:20,fileBytes:500,source:'read',
  ...(legacy?{}:{location:{...source(suffix),absolutePath:source(suffix).rootPath+'\\same.md'}})};
}
function coverage(ref?:FileSystemSourceRef,partial=false):ProjectReadCoverage{
 return {scope:ref?{kind:'windows_filesystem',projectId,bindingId:null,sourceId:ref.sourceId,identity:ref.rootIdentity,directoryId:null,absoluteDirectory:ref.rootPath,relativeDirectory:''}
  :{projectId,bindingId:'binding-a',identity:digest,directoryId:null,relativeDirectory:''},
  complete:!partial,scannedCandidates:1,scannedFiles:1,scannedBytes:500,returned:1,skipped:{policy:0,unsupported:0,fileLimit:0,unavailable:0},
  remaining:{directories:partial?null:0,files:partial?1:0,position:null},nextCursor:partial?'cursor-a':null,limitReason:partial?'page':null};
}
function readResult(c:ProjectReadCitationPreview,partial=false):ProjectReadToolResult{
 const ref=c.location?{kind:c.location.kind,sourceId:c.location.sourceId,rootPath:c.location.rootPath,rootIdentity:c.location.rootIdentity}:undefined;
 return {ok:true,value:{kind:'read',phase:'data',snapshotId:'snapshot-a',coverage:{...coverage(ref,partial),remaining:{directories:0,files:partial?1:0,position:partial?c.range.end:null}},rules:[],resume:null,citation:c,empty:false,next:partial?c.range.end:null,
  ...(ref?{source:ref,nextArguments:partial?{toolName:'fs_read',arguments:{path:null,fileId:c.fileId,version:c.version,start:c.range.end,cursor:'cursor-a'}}:null}:{})}};
}
const execution=():ChatTurnExecution=>({executionId:'execution-a',version:1,requestDigest:digest,acceptedContext:{projectId,workspaceRevision:2,bindingId:'binding-a',bindingIdentity:digest,provider:'kimi',model:'kimi-k3',historyVersion:digest},
 phase:'completed',cleanupState:'idle',runLink:{runId:'run-a',workspaceId:null},parentTurnId:null,pendingInteraction:null});
const run=():ProjectReadSummary=>({runId:'run-a',clientRequestId:turnId,project:{projectId,bindingId:'binding-a',identity:digest,name:'组织项目',directoryName:'project-A',directorySegments:['C','synthetic','project-A']},
 model:{provider:'kimi',model:'kimi-k3'},goal:'synthetic read',constraint:'',continuedFrom:null,status:'completed',cleanupState:'idle',createdAt:time,updatedAt:time,
 accounting:{providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null},eventCount:1,continuation:null,
 origin:{chatSessionId:sessionId,turnId,executionId:'execution-a',inputDigest:digest}});
function activity(cs:ProjectReadCitationPreview[]):ChatTurnActivity{
 const events:ProjectReadEvent[]=cs.map((c,index)=>({runId:'run-a',sequence:index+2,time,type:'tool.completed',data:{
  sessionId:'engine-a',messageId:'message-a',callId:'call-'+index,
  ...(c.location?{toolName:'fs_read' as const,arguments:{path:c.location.absolutePath,fileId:null,version:null,start:c.range.start,cursor:null}}
   :{toolName:'project_read' as const,arguments:{fileId:c.fileId,version:c.version,start:c.range.start,cursor:null}}),
  result:readResult(c)}}));
 return {sessionId,turnId,version:1,execution:execution(),run:{...run(),eventCount:events.length+1},
  parts:[...events.map((event,index)=>({kind:'run_event' as const,partId:'part-'+event.sequence,sequence:index+1,runId:'run-a',event})),
   {kind:'text',partId:'answer',sequence:events.length+1,text:cs.map(c=>'[资料:'+c.citationId+']').join(' ')+' [资料:invented]'}],nextSequence:events.length+1,hasMore:false};
}
const turn=(a:ChatTurnActivity):SessionTurn=>({id:turnId,user:'原问题',assistant:'',status:'completed',error:'',execution:a.execution!});
function right(a:ChatTurnActivity,citationId?:string,api?:WorkbenchAgentProjectReadApi){
 const request:ChatResultRequest={sessionId,turnId,executionId:'execution-a',runId:'run-a',workspaceId:null,activity:a,target:citationId?{kind:'citation',citationId}:{kind:'run'}};
 return renderToStaticMarkup(createElement(ChatAgentResults,{request,activity:a,api}));
}
const validated=(r:ProjectReadToolResult)=>{const parsed=parseProjectReadToolResult(JSON.parse(JSON.stringify(r)));assert(parsed,'synthetic result must pass production parser');return parsed;};
const renderResult=(result:ProjectReadToolResult)=>renderToStaticMarkup(createElement(ProjectReadResults,{result:validated(result),onCitation:no}));
const config:ChatTurnInteraction={kind:'configuration',interactionId:'configuration-a',required:'project_directory',action:'select_project',message:'此前需要项目目录。'};
function hostState(capabilities?:SessionState['capabilities']){
 const parsed=parseSessionResult({ok:true,value:{revision:1,selectedId:null,sessions:[],selected:null,runningSessionId:null,storage:'saved',configured:{deepseek:false,kimi:true},...(capabilities?{capabilities}:{})}});
 assert(parsed.ok);return parsed.value;
}
const previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
Object.defineProperty(globalThis,'window',{configurable:true,value:{matchMedia:()=>({matches:true})}});
test.after(()=>{if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else Reflect.deleteProperty(globalThis,'window');});

// SSR checks display and render purity; it does not execute effects or click handlers.
test('main capability renders old directory retry without binding controls or render-time submission',()=>{
 let submitted=0,configured=0;
 const state=hostState({filesystemRead:true});
 assert(chatFilesystemRetry(config,state.capabilities));
 const html=renderToStaticMarkup(createElement(ChatInteractionDock,{interaction:config,capabilities:state.capabilities,configurationTools:createElement('p',null,'必须绑定控件'),
  configurationRetryDisabled:!chatFilesystemRetry(config,state.capabilities),onSubmit:async()=>{submitted++;return {status:'accepted' as const,state};},onConfigure:()=>configured++,onStop:no,canStop:false,stopping:false}));
 assert.match(html,/<button type="button">重新尝试/);assert.match(html,/沿用原问题和附件/);assert.match(html,/此前需要项目目录/);
 assert.doesNotMatch(html,/必须绑定控件|新建项目并选择目录|配置后继续/);assert.equal(submitted,0);assert.equal(configured,0);
});

test('missing or false capability retains directory gate; model and command configuration stay explicit',()=>{
 for(const capabilities of [undefined,{filesystemRead:false}]){
  const state=hostState(capabilities);assert(!chatFilesystemRetry(config,state.capabilities));
  const html=renderToStaticMarkup(createElement(ChatInteractionDock,{interaction:config,capabilities:state.capabilities,configurationRetryDisabled:true,onSubmit:async()=>({status:'uncertain' as const}),onConfigure:no,onStop:no,stopping:false,canStop:false}));
  assert.match(html,/新建项目并选择目录/);assert.match(html,/<button[^>]*disabled[^>]*>配置后继续/);assert.doesNotMatch(html,/重新尝试/);
 }
 for(const interaction of [
  {kind:'configuration',interactionId:'model-a',required:'supported_model',action:'select_model',message:'请选择模型。'},
  {kind:'configuration',interactionId:'environment-a',required:'command_environment',action:'review_environment',message:'请核对环境。'},
 ] as const){
  assert(!chatFilesystemRetry(interaction,{filesystemRead:true}));
  const html=renderToStaticMarkup(createElement(ChatInteractionDock,{interaction,capabilities:{filesystemRead:true},onSubmit:async()=>({status:'uncertain' as const}),onConfigure:no,onStop:no,stopping:false,canStop:false}));
  assert.match(html,interaction.required==='supported_model'?/模型设置/:/核对命令环境/);assert.match(html,/配置后继续/);assert.doesNotMatch(html,/重新尝试|无需先关联/);
 }
});

test('uncertain card renders original receipt recovery and disables a new attempt',()=>{
 const memory=emptyChatInteractionMemory();memory.uncertain=true;memory.attempt={requestId:turnId,decision:{kind:'configuration',decision:'retry'}};
 const before=JSON.stringify(memory);let calls=0;
 const props={interaction:config,capabilities:{filesystemRead:true},memory,onSubmit:async()=>{calls++;return {status:'uncertain' as const};},onConfigure:no,onStop:no,stopping:false,canStop:false};
 const html=renderToStaticMarkup(createElement(ChatInteractionDock,props));
 assert.match(html,/<button[^>]*disabled[^>]*>重新尝试/);assert.match(html,/<button type="button">核对同一次提交/);
 const blocked=renderToStaticMarkup(createElement(ChatInteractionDock,{...props,disabled:true}));
 assert.match(blocked,/<button[^>]*disabled[^>]*>核对同一次提交/);assert.equal(calls,0);assert.equal(JSON.stringify(memory),before);
});

test('same-name native citations remain independent by id, path, saved version and fragment',()=>{
 const a=citation('A'),b=citation('B'),saved=activity([a,b]),before=JSON.stringify(saved),cold=parseChatTurnActivity(JSON.parse(before));
 const projection=chatActivityProjection(cold);assert.equal(projection.citations.size,2);
 assert.deepEqual(projectMessageCitations('[资料:citation-B] [资料:citation-A] [资料:invented]',projection.citations).map(c=>c.citationId),[b.citationId,a.citationId]);
 const chat=renderToStaticMarkup(createElement(ChatAgentParts,{turn:turn(cold),activity:cold,onRetry:no,onOpen:no,onAdvance:no}));
 assert.match(chat,/C:\\synthetic\\source-A\\same.md/);assert.match(chat,/C:\\synthetic\\source-B\\same.md/);
 assert.doesNotMatch(chat,/<button[^>]*>invented<\/button>/);
 for(const c of [a,b]){
  const html=right(cold,c.citationId);assert(html.includes(projectCitationPath(c)));assert(html.includes(c.version));
  assert.match(html,/所属项目：组织项目/);assert.match(html,/读取时保存的片段/);assert.match(html,/第 2 行，第 3 列/);
  assert.doesNotMatch(html,/project-A|项目来源：|<script>/);assert.match(html,/&lt;script&gt;/);
 }
 assert.equal(JSON.stringify(saved),before);
});

test('mixed historic citations keep old relative source and never acquire a current absolute path',()=>{
 const old=citation('legacy',true),native=citation('B'),saved=activity([old,native]),before=JSON.stringify(saved),cold=parseChatTurnActivity(JSON.parse(before));
 const oldCopy=chatActivityProjection(cold).citations.get(old.citationId)!;assert.equal(oldCopy.location,undefined);assert.equal(projectCitationPath(oldCopy),'same.md');
 const html=right(cold,old.citationId);assert.match(html,/<h3>same.md<\/h3>/);assert.match(html,/项目来源：C &gt; synthetic &gt; project-A/);
 assert.doesNotMatch(html,/source-B|source-legacy|C:\\synthetic\\project-A\\same.md/);assert.equal(JSON.stringify(saved),before);
 const missing=right(cold,'invented');assert.match(missing,/本轮已保存记录中没有这条引用/);assert.doesNotMatch(missing,/<h3>|saved legacy/);
});

test('native list uses source path and partial coverage instead of the organizational project root',()=>{
 const ref=source('B'),result:ProjectReadToolResult={ok:true,value:{kind:'list',phase:'data',snapshotId:'snapshot-a',source:ref,rules:[],resume:null,
  coverage:coverage(ref,true),nextArguments:{toolName:'fs_list',arguments:{path:null,directoryId:'directory-B',cursor:'cursor-a',refresh:false}},
  entries:[{fileId:'file-B',directoryId:null,parentId:null,name:'same.md',relativePath:'nested/same.md',kind:'file',bytes:500,readability:'readable',version:null}]}};
 const html=renderResult(result);assert.match(html,/C:\\synthetic\\source-B\\nested\\same.md/);assert.match(html,/本次范围尚未查完/);assert.match(html,/文件：1/);
 assert.doesNotMatch(html,/项目根目录|project-A|扫描结束|版本：/);
 const old=renderToStaticMarkup(createElement(ProjectReadCoverageView,{coverage:coverage()}));assert.match(old,/项目根目录/);
});

test('native read page preserves its saved boundary and single-file search names the actual file scope',()=>{
 const c=citation('A'),partial=readResult(c,true),before=JSON.stringify(partial),html=renderResult(partial);
 assert.match(html,/C:\\synthetic\\source-A\\same.md/);assert.match(html,/本次范围尚未查完/);assert.match(html,/后续位置：第 2 行/);assert.match(html,/终点不含/);
 assert.equal(JSON.stringify(partial),before);
 const ref=source('A'),range=coverage(ref),result:ProjectReadToolResult={ok:true,value:{kind:'search',phase:'data',snapshotId:'snapshot-a',source:ref,rules:[],resume:null,nextArguments:null,matches:[],
  coverage:{...range,scope:{...range.scope,kind:'windows_filesystem',projectId,bindingId:null,sourceId:ref.sourceId,identity:ref.rootIdentity,directoryId:null,relativeDirectory:c.relativePath,absoluteDirectory:c.location!.absolutePath},returned:0}}};
 const search=renderResult(result);assert.match(search,/C:\\synthetic\\source-A\\same.md/);assert.match(search,/本次搜索范围内没有匹配/);assert.doesNotMatch(search,/项目根目录/);
});

test('native OS, missing cwd, policy and source-version failures do not ask for project rebinding',()=>{
 const cases=[
  ['CWD_UNAVAILABLE',undefined,'绝对路径'],['PATH_POLICY_DENIED',undefined,'访问规则'],['PATH_NOT_FOUND','ENOENT','不存在'],
  ['ACCESS_DENIED','EACCES','系统拒绝'],['NOT_A_DIRECTORY','ENOTDIR','不是文件夹'],['NOT_A_FILE','EISDIR','不是普通文件'],
  ['SOURCE_CHANGED',undefined,'文件已发生变化'],['IO_ERROR','EIO','资料读取失败'],
 ] as const;
 for(const [code,osCode,message] of cases){
  const html=renderResult({ok:false,error:{code,...(osCode?{osCode}:{})},coverage:null});
  assert(html.includes(message));if(osCode)assert(html.includes('（'+osCode+'）'));assert.doesNotMatch(html,/选择目录|切换到|尚未关联|不存在.*EACCES/);
 }
 assert.equal(parseProjectReadToolResult({ok:false,error:{code:'IO_ERROR',osCode:'raw-stack-detail'},coverage:null}),null);
});

test('saved right-pane citation render does not read APIs or mutate its organization',()=>{
 const saved=activity([citation('A')]),before=JSON.stringify(saved);let accesses=0;
 const api=new Proxy({} as WorkbenchAgentProjectReadApi,{get(){accesses++;throw Error('unexpected bridge use');}});
 const html=right(saved,'citation-A',api);assert.match(html,/所属项目：组织项目/);assert.match(html,/saved A/);assert.equal(accesses,0);assert.equal(JSON.stringify(saved),before);
 const merged=mergeChatActivity(null,saved,sessionId,turn(saved));assert.equal(merged.run!.project.projectId,projectId);
 assert.throws(()=>mergeChatActivity(null,{...saved,run:{...saved.run!,project:{...saved.run!.project,projectId:turnId}}},sessionId,turn(saved)),/Run scope mismatch/);
});

test('unbound read-only activity survives the typed cold path with logical project identity intact',()=>{
 const original=activity([citation('B')]),e=original.execution!;
 const saved:ChatTurnActivity={...original,execution:{...e,readOnlyScope:true,acceptedContext:{...e.acceptedContext,bindingId:null,bindingIdentity:null}},
  run:{...original.run!,project:{projectId,name:'组织项目',bindingId:null,identity:null,directoryName:null,directorySegments:[]}}};
 const before=JSON.stringify(saved),cold=parseChatTurnActivity(JSON.parse(before)),merged=mergeChatActivity(null,cold,sessionId,turn(cold));
 assert.equal(merged.execution!.readOnlyScope,true);assert.equal(merged.execution!.runLink!.workspaceId,null);assert.equal(merged.run!.project.projectId,projectId);
 const html=right(merged,'citation-B');assert.match(html,/所属项目：组织项目/);assert.match(html,/C:\\synthetic\\source-B\\same.md/);
 assert.doesNotMatch(html,/项目来源|关联目录|任务工作区|核对文件|正在核对成果/);assert.equal(JSON.stringify(saved),before);
 const invalid=JSON.parse(before);delete invalid.execution.readOnlyScope;assert.throws(()=>parseChatTurnActivity(invalid));
});

test('filesystem output uses main-issued continuation unchanged and does not describe directory results as quoted text',()=>{
 const c=citation('A'),result=validated(readResult(c,true)),call={sessionId:'engine-a',messageId:'message-a',callId:'call-a',toolName:'fs_read' as const,
  arguments:{path:c.location!.absolutePath,fileId:null,version:null,start:c.range.start,cursor:null}};
 const output=describeToolOutput({runId:'run-a',call,result});assert(output);assert(result.ok&&result.value.kind==='read');
 assert.deepEqual(output.continuation,{...result.value.nextArguments,mode:'next_page',lifetime:'active_run_cursor'});
 assert.equal(output.source.kind,'filesystem');assert.equal(output.state,'partial');
 const html=renderToStaticMarkup(createElement(ToolOutputSummary,{output}));assert.match(html,/本次结果与来源位置/);assert.match(html,/尚有后续内容/);
 assert.doesNotMatch(html,/工作文件保存在本地|已保存引用片段|完整保存/);
 const listOutput={...output,source:{...source('A'),kind:'filesystem' as const,retention:'source_reference' as const,snapshotId:'snapshot-a',absolutePath:null},continuation:null};
 const list=renderToStaticMarkup(createElement(ToolOutputSummary,{output:listOutput}));assert.match(list,/本次结果与来源位置/);assert.doesNotMatch(list,/已保存引用片段|尚有后续内容/);
});
