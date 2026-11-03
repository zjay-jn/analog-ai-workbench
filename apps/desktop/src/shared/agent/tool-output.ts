import type {ProjectReadToolArguments,ProjectReadToolCall,ProjectReadToolResult} from './agent-project-read';

/** Model-facing raw-byte preview target, not a new storage or context allowance. */
export const TOOL_OUTPUT_PREVIEW_BYTES=4096;
export const TOOL_OUTPUT_VERSION='aaw.tool-output.v1' as const;
type ContinuationName='command_log'|'work_read'|'project_read'|'project_search'|'skill_load'|'skill_read_reference'|'fs_list'|'fs_find'|'fs_search'|'fs_read';
export type ToolOutputContinuation={ [K in ContinuationName]:Readonly<{
 mode:'next_page'|'refresh';toolName:K;arguments:ProjectReadToolArguments[K];
 /** A descriptor grants no authority. Existing main handlers revalidate this scope. */
 lifetime:'source_run'|'active_run_cursor';
}> }[ContinuationName];
export type ToolOutputSource=
 | Readonly<{kind:'filesystem';retention:'source_reference';sourceId:string;rootPath:string;snapshotId:string;absolutePath:string|null}>
 | Readonly<{kind:'command_log';retention:'stored_log';executionId:string;stream:'stdout'|'stderr';version:string}>
 | Readonly<{kind:'work_file';retention:'stored_work_file';fileId:string;version:string}>
 | Readonly<{kind:'project_file';retention:'source_reference';snapshotId:string;fileId:string;version:string}>
 | Readonly<{kind:'project_search';retention:'source_reference';snapshotId:string}>;
export type ToolOutputDescriptor=Readonly<{
 contractVersion:typeof TOOL_OUTPUT_VERSION;runId:string;source:ToolOutputSource;
 /** Describes only this delivered selection, never command exit or task success. */
 state:'complete'|'partial'|'pending'|'limited';
 sourceState:'open'|'closed'|'snapshot'|'unknown';sourceCoverage:'complete'|'partial'|'unknown';
 returnedBytes:number;totalBytes:number|null;
 /** Byte offsets only. Project text continues with its existing Unicode positions. */
 range:Readonly<{start:number;end:number}>|null;
 continuation:ToolOutputContinuation|null;
}>;
const size=(text:string)=>new TextEncoder().encode(text).length;

/** Pure projection of already validated, persisted protocol values. No new receipt/store/IPC. */
export function describeToolOutput({runId,call,result}:{runId:string;call:ProjectReadToolCall;result:ProjectReadToolResult}):ToolOutputDescriptor|null{
 if(!result.ok)return null;
 const value=result.value,base={contractVersion:TOOL_OUTPUT_VERSION,runId};
 if((call.toolName==='fs_list'||call.toolName==='fs_find'||call.toolName==='fs_read'||call.toolName==='fs_search')&&(value.kind==='list'||value.kind==='find'||value.kind==='read'||value.kind==='search')&&value.source){
  const skipped=Object.values(value.coverage.skipped).some(n=>n>0),citation=value.kind==='read'?value.citation:null;
  return {...base,source:{kind:'filesystem',retention:'source_reference',sourceId:value.source.sourceId,rootPath:value.source.rootPath,snapshotId:value.snapshotId,absolutePath:citation?.location?.absolutePath??null},
    state:value.phase!=='data'?'pending':value.coverage.complete&&!skipped&&call.arguments.cursor===null&&(call.toolName!=='fs_read'||call.arguments.start.line===1&&call.arguments.start.column===1)?'complete':'partial',
    sourceState:'snapshot',sourceCoverage:skipped?'partial':value.coverage.complete?'complete':'unknown',returnedBytes:citation?size(citation.excerpt):value.kind==='search'?value.matches.reduce((n,m)=>n+size(m.citation.excerpt),0):size(JSON.stringify(value)),totalBytes:citation?.fileBytes??null,range:null,
    continuation:value.nextArguments?{...value.nextArguments,mode:'next_page',lifetime:'active_run_cursor'}:null};
 }
 if(value.kind==='command_log'&&call.toolName==='command_log'){
  const p=value.page;
  const continuation:ToolOutputContinuation|null=p.nextCursor
   ?{mode:'next_page',toolName:'command_log',arguments:{...call.arguments,offset:p.nextCursor.offset,expectedPrefixVersion:p.nextCursor.prefixVersion},lifetime:'source_run'}
   :p.hasNewerBytes||!p.streamClosed
    ?{mode:'refresh',toolName:'command_log',arguments:{...call.arguments,offset:p.snapshotBytes,expectedPrefixVersion:null},lifetime:'source_run'}:null;
  return {...base,source:{kind:'command_log',retention:'stored_log',executionId:p.executionId,stream:p.stream,version:p.prefixVersion},
   state:p.coverage==='partial_at_limit'||p.coverage==='incomplete'?'limited':!p.streamClosed&&!p.hasNewerBytes&&p.endOffset===p.offset?'pending':p.offset===0&&p.endOffset===p.snapshotBytes&&p.streamClosed&&p.coverage==='complete'?'complete':'partial',
   sourceState:p.streamClosed?'closed':p.coverage==='open'?'open':'unknown',sourceCoverage:p.coverage==='complete'?'complete':p.coverage==='open'?'unknown':'partial',
   returnedBytes:p.endOffset-p.offset,totalBytes:p.snapshotBytes,range:{start:p.offset,end:p.endOffset},continuation};
 }
 if(value.kind==='work_read'&&call.toolName==='work_read'){
  return {...base,source:{kind:'work_file',retention:'stored_work_file',fileId:value.file.fileId,version:value.file.version},
   state:value.offset===0&&value.nextOffset===null?'complete':'partial',sourceState:'snapshot',sourceCoverage:'complete',
   returnedBytes:size(value.text),totalBytes:value.file.bytes,range:{start:value.offset,end:value.offset+size(value.text)},
   continuation:value.nextOffset===null?null:{mode:'next_page',toolName:'work_read',arguments:{fileId:value.file.fileId,version:value.file.version,offset:value.nextOffset},lifetime:'source_run'}};
 }
 if(value.kind==='read'&&value.citation&&(call.toolName==='project_read'||call.toolName==='skill_load'||call.toolName==='skill_read_reference')){
  const c=value.citation;let continuation:ToolOutputContinuation|null=null;
  if(value.next&&value.coverage.nextCursor){
   const page={version:c.version,start:value.next,cursor:value.coverage.nextCursor};
   if(call.toolName==='project_read')continuation={mode:'next_page',toolName:'project_read',arguments:{...call.arguments,...page},lifetime:'active_run_cursor'};
   else if(call.toolName==='skill_load')continuation={mode:'next_page',toolName:'skill_load',arguments:{...call.arguments,...page},lifetime:'active_run_cursor'};
   else continuation={mode:'next_page',toolName:'skill_read_reference',arguments:{...call.arguments,...page},lifetime:'active_run_cursor'};
  }
  return {...base,source:{kind:'project_file',retention:'source_reference',snapshotId:value.snapshotId,fileId:c.fileId,version:c.version},
   state:value.coverage.complete&&c.range.start.line===1&&c.range.start.column===1?'complete':'partial',sourceState:'snapshot',sourceCoverage:value.coverage.complete?'complete':'unknown',
   returnedBytes:size(c.excerpt),totalBytes:c.fileBytes,range:null,continuation};
 }
 if(value.kind==='search'&&call.toolName==='project_search'){
  const skipped=Object.values(value.coverage.skipped).some(count=>count>0);
  return {...base,source:{kind:'project_search',retention:'source_reference',snapshotId:value.snapshotId},
   state:value.coverage.complete&&!skipped&&call.arguments.cursor===null?'complete':'partial',sourceState:'snapshot',sourceCoverage:skipped?'partial':value.coverage.complete?'complete':'unknown',
   returnedBytes:value.matches.reduce((total,m)=>total+size(m.citation.excerpt),0),totalBytes:null,range:null,
   continuation:value.coverage.nextCursor?{mode:'next_page',toolName:'project_search',arguments:{...call.arguments,cursor:value.coverage.nextCursor,refresh:false},lifetime:'active_run_cursor'}:null};
 }
 return null;
}
