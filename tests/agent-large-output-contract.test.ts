import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {describeToolOutput} from '../apps/desktop/src/shared/agent/tool-output';
import type {CommandLogPage} from '../apps/desktop/src/shared/agent/agent-command';
import type {ProjectReadToolCall,ProjectReadToolResult,ProjectReadCoverage,ProjectReadCitationPreview} from '../apps/desktop/src/shared/agent/agent-project-read';
import {parseProjectReadToolResult} from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import {projectReadTools} from '../apps/desktop/src/main/agent-project-read/protocol';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),version=hash('version');
const base={sessionId:'s',messageId:'m',callId:'c'},runId='original-run';
const call:Extract<ProjectReadToolCall,{toolName:'command_log'}>={...base,toolName:'command_log',arguments:{executionId:'command',stream:'stdout',offset:0,maxBytes:16384,expectedPrefixVersion:null}};
const page:CommandLogPage={executionId:'command',stream:'stdout',prefixVersion:version,offset:0,endOffset:3,snapshotBytes:6,availableBytes:6,format:'utf8',data:'one',bytesSha256:hash('one'),nextCursor:{offset:3,prefixVersion:version},streamClosed:true,coverage:'complete',hasNewerBytes:false};
const result=(p:CommandLogPage):ProjectReadToolResult=>({ok:true,value:{kind:'command_log',page:p}});
const describe=(p:CommandLogPage)=>describeToolOutput({runId,call,result:result(p)})!;

test('old persisted command results parse unchanged and project exact continuation without mutation',()=>{
 const saved=JSON.stringify(result(page)),parsed=parseProjectReadToolResult(JSON.parse(saved));assert(parsed);
 const d=describeToolOutput({runId,call,result:parsed})!;assert.equal(d.state,'partial');assert.equal(d.source.retention,'stored_log');assert.deepEqual(d.range,{start:0,end:3});
 assert.deepEqual(d.continuation,{mode:'next_page',toolName:'command_log',arguments:{...call.arguments,offset:3,expectedPrefixVersion:version},lifetime:'source_run'});
 assert.equal(JSON.stringify(parsed),saved);assert.equal(d.runId,runId);assert(!('toolOutput' in parsed));
});

test('closed tail, current EOF, new suffix, old prefix and missing capture have distinct meanings',()=>{
 const tail={...page,offset:3,endOffset:6,data:'two',bytesSha256:hash('two'),nextCursor:null};
 assert.equal(describe(tail).state,'partial');assert.equal(describe(tail).continuation,null);
 const whole={...page,endOffset:6,data:'onetwo',bytesSha256:hash('onetwo'),nextCursor:null};assert.equal(describe(whole).state,'complete');
 const eof={...tail,offset:6,data:'',bytesSha256:hash(''),streamClosed:false,coverage:'open' as const};
 const pending=describe(eof);assert.equal(pending.state,'pending');assert.equal(pending.continuation?.mode,'refresh');assert(pending.continuation?.toolName==='command_log');assert.equal(pending.continuation.arguments.offset,6);
 const older=describe({...tail,streamClosed:false,hasNewerBytes:true,availableBytes:9});assert.equal(older.sourceState,'unknown');assert.equal(older.continuation?.mode,'refresh');assert(older.continuation?.toolName==='command_log');assert.equal(older.continuation.arguments.offset,6);
 for(const coverage of ['partial_at_limit','incomplete'] as const){const d=describe({...whole,coverage});assert.equal(d.state,'limited');assert.equal(d.sourceCoverage,'partial');assert.equal(d.continuation,null);}
 assert.equal(describe({...whole,coverage:'partial_at_limit',streamClosed:false}).state,'limited');
});

test('work history stays source-run scoped and EOF after a suffix is not whole-file delivery',()=>{
 const workCall:ProjectReadToolCall={...base,toolName:'work_read',arguments:{fileId:'file',version,offset:3}};
 const work:ProjectReadToolResult={ok:true,value:{kind:'work_read',file:{fileId:'file',version,relativePath:'out.txt',bytes:6,confirmation:'confirmed',origin:{kind:'write',changeId:'change'}},text:'尾',offset:3,nextOffset:null}};
 const d=describeToolOutput({runId,call:workCall,result:work})!;assert.equal(d.state,'partial');assert.equal(d.source.retention,'stored_work_file');assert.deepEqual(d.range,{start:3,end:6});assert.equal(d.continuation,null);assert.equal(d.totalBytes,6);
});

const coverage:ProjectReadCoverage={scope:{projectId:'p',bindingId:'b',identity:'identity',directoryId:null,relativeDirectory:''},complete:false,scannedCandidates:1,scannedFiles:1,scannedBytes:120,returned:1,skipped:{policy:0,unsupported:0,fileLimit:0,unavailable:0},remaining:{directories:0,files:1,position:{line:1,column:2}},nextCursor:'cursor',limitReason:'page'};
const citation:ProjectReadCitationPreview={citationId:'cite',fileId:'file',relativePath:'source.txt',version,normalizedSha256:version,range:{start:{line:1,column:1},end:{line:1,column:2}},excerpt:'中',excerptSha256:hash('中'),totalLines:1,fileBytes:120,source:'read'};
test('project and skill continuations retain source references and scalar positions, with no saved-copy claim',()=>{
 const value={kind:'read' as const,phase:'data' as const,snapshotId:'snapshot',coverage,rules:[],resume:null,citation,empty:false,next:{line:1,column:2}};
 const read:ProjectReadToolCall={...base,toolName:'project_read',arguments:{fileId:'file',version:null,start:{line:1,column:1},cursor:null}};
 const d=describeToolOutput({runId,call:read,result:{ok:true,value}})!;assert.equal(d.source.retention,'source_reference');assert.equal(d.state,'partial');assert.equal(d.range,null);assert.equal(d.returnedBytes,3);
 assert.deepEqual(d.continuation,{mode:'next_page',toolName:'project_read',arguments:{fileId:'file',version,start:{line:1,column:2},cursor:'cursor'},lifetime:'active_run_cursor'});
 const skillCalls:ProjectReadToolCall[]=[
  {...base,toolName:'skill_load',arguments:{skillId:'skill',discoveryVersion:version,version:null,start:{line:1,column:1},cursor:null}},
  {...base,toolName:'skill_read_reference',arguments:{skillId:'skill',skillVersion:version,fileId:'file',version:null,start:{line:1,column:1},cursor:null}},
 ];
 for(const skillCall of skillCalls){const projected=describeToolOutput({runId,call:skillCall,result:{ok:true,value}})!;assert.deepEqual(projected.continuation,{mode:'next_page',toolName:skillCall.toolName,arguments:{...skillCall.arguments,version,start:{line:1,column:2},cursor:'cursor'},lifetime:'active_run_cursor'});}
 const rulesOnly=describeToolOutput({runId,call:read,result:{ok:true,value:{...value,citation:null}}});assert.equal(rulesOnly,null);
});

test('search with skipped sources and later-page EOF never claims complete source coverage',()=>{
 const searchCall:Extract<ProjectReadToolCall,{toolName:'project_search'}>={...base,toolName:'project_search',arguments:{directoryId:null,query:'needle',cursor:null,refresh:false}};
 const value={kind:'search' as const,phase:'data' as const,snapshotId:'snapshot',coverage,rules:[],resume:null,matches:[]};
 const d=describeToolOutput({runId,call:searchCall,result:{ok:true,value}})!;assert.equal(d.continuation?.lifetime,'active_run_cursor');assert.equal(d.continuation?.toolName,'project_search');
 const done={...value,coverage:{...coverage,complete:true,nextCursor:null,limitReason:null}};
 assert.equal(describeToolOutput({runId,call:{...searchCall,arguments:{...searchCall.arguments,cursor:'older'}},result:{ok:true,value:done}})!.state,'partial');
 const skipped=describeToolOutput({runId,call:searchCall,result:{ok:true,value:{...done,coverage:{...done.coverage,skipped:{...coverage.skipped,unavailable:1}}}}})!;assert.equal(skipped.state,'partial');assert.equal(skipped.sourceCoverage,'partial');
});

test('unsupported families and failures retain legacy presentation; actual tool descriptions expose model continuation semantics',()=>{
 assert.equal(describeToolOutput({runId,call,result:{ok:false,error:{code:'BUDGET_EXCEEDED'},coverage:null}}),null);
 const sumCall:ProjectReadToolCall={...base,toolName:'pilot_sum',arguments:{values:[1,2]}};
 assert.equal(describeToolOutput({runId,call:sumCall,result:{ok:true,value:{kind:'sum',sum:3,count:2,source:'deterministic-local',toolVersion:'pilot.sum.v1'}}}),null);
 const tools=projectReadTools(true) as readonly {function:{name:string;description:string}}[];
 const expected=[
  'fs_list','fs_find','fs_search','fs_read','skill_discover','skill_load','skill_read_reference',
  'project_list','project_find','project_search','project_read','pilot_sum','question',
  'oa_open_design','oa_inspect_design','oa_query_instances','oa_query_nets','oa_describe_device',
  'wsl_results_list','wsl_results_read','wsl_waveform_list','wsl_waveform_read','wsl_waveform_metrics',
  'work_list','work_read','work_write','work_edit','work_import','work_run',
  'command_environment','command_start','command_status','command_log','command_stop',
 ];
 const names=tools.map(tool=>tool.function.name);assert.equal(new Set(names).size,names.length);
 assert.equal(tools.length,expected.length);assert.deepEqual([...names].sort(),expected.sort());
 const command=tools.find(t=>t.function.name==='command_log')!.function.description,work=tools.find(t=>t.function.name==='work_read')!.function.description;
 for(const text of [command,work]){assert.match(text,/4096/);assert.match(text,/ok:true/);assert.match(text,/delivery capacity/);}
 assert.match(command,/snapshotBytes/);assert.match(command,/does not mean process exit/);assert.match(command,/nextCursor/);assert.match(work,/nextOffset/);assert.match(work,/UTF-8 byte length/);
});
