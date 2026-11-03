import { isDeepStrictEqual } from 'node:util';
import { PROJECT_READ_LIMITS as L, type ProjectReadCode, type ProjectReadToolCall, type ProjectReadToolResult } from '../../shared/agent/agent-project-read';
import { WORK_CYCLE_LIMITS as W, type WorkCycleFile, type WorkCycleImportSource, type WorkCycleToolValue } from '../../shared/agent/agent-work-cycle';
import { isWorkCycleToolName, parseProjectReadToolArguments, parseProjectReadToolResult } from '../../shared/agent/agent-project-read-validation';
import { TOOL_OUTPUT_PREVIEW_BYTES } from '../../shared/agent/tool-output';
import type { ProjectReadPublication } from '../cloud/project-read-broker';
import { ProjectReadFsError } from '../cloud/project-read-files';
import { WorkCycleError, type WorkCycleRunner, type WorkCycleWorkspace } from './types';

type Call = Extract<ProjectReadToolCall, {toolName: import('../../shared/agent/agent-work-cycle').WorkCycleToolName}>;
const fail = (code: ProjectReadCode): never => { throw new WorkCycleError(code); };
const confirmed = (file: WorkCycleFile): WorkCycleFile => ({ ...file, confirmation: 'confirmed' });
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export function createWorkCycleBroker(options: Readonly<{
  workspace: WorkCycleWorkspace; runner: WorkCycleRunner; signal: AbortSignal;
  authorize(call: ProjectReadToolCall): boolean;
  canDeliver(publication: ProjectReadPublication): boolean;
  remainingToolBytes(): number;
  publish(publication: ProjectReadPublication): Promise<void>;
  importSource(fileId: string, version: string): Promise<Readonly<{ source: WorkCycleImportSource; bytes: Uint8Array }>>;
  beforeMutation?(): void;
  /** Main-owned conversation count policy; mutation and execution safety limits remain independent. */
  maxToolCalls?: number | null;
}>) {
  const maxToolCalls=options.maxToolCalls===undefined?L.toolCalls:options.maxToolCalls;
  if(maxToolCalls!==null&&(!Number.isSafeInteger(maxToolCalls)||maxToolCalls<1||maxToolCalls>L.toolCalls))fail('INVALID_REQUEST');
  const completed = new Map<string, {call: Call; result: ProjectReadToolResult}>();
  const pending = new Map<string, {call: Call; result: Promise<ProjectReadToolResult>}>();
  let closed = false, busy = false, executions = 0, changes = 0;
  const alive = () => { if (closed || options.signal.aborted) return fail('CANCELLED'); };
  async function publish(call: Call, result: ProjectReadToolResult, mutation: boolean): Promise<ProjectReadToolResult> {
    alive(); const parsed = parseProjectReadToolResult(result); if (!parsed) return fail('ENGINE_FAILED');
    const publication = { call, result: parsed, citations: [], locators: [] };
    if (byteLength(parsed) > options.remainingToolBytes() || !options.canDeliver(publication)) return fail('BUDGET_EXCEEDED');
    try { await options.publish(publication); if (mutation) await options.workspace.confirm(call.callId); }
    catch { return fail('STORAGE_FAILED'); }
    alive(); completed.set(call.callId, {call, result: parsed}); return parsed;
  }
  async function executeOnce(call: Call): Promise<ProjectReadToolResult> {
    alive(); if (!options.authorize(call)) return fail('CAPABILITY_DENIED');
    const prior = completed.get(call.callId); if (prior) return isDeepStrictEqual(prior.call, call) ? prior.result : fail('CONFLICT');
    if (busy) return fail('BUSY');
    if (!parseProjectReadToolArguments(call.toolName, call.arguments)) return fail('INVALID_REQUEST');
    busy = true; let mutation = false;
    try {
      // Reserve bounded escaped response space before any write or program execution.
      const placeholder: ProjectReadToolResult = {ok:false,error:{code:'BUDGET_EXCEEDED'},coverage:null};
      const readOnly=call.toolName==='work_list'||call.toolName==='work_read';
      if (!readOnly) {
        if (options.remainingToolBytes() < W.toolResultBytes || !options.canDeliver({call,result:placeholder,citations:[],locators:[],reserveBytes:W.eventBytes})) return fail('BUDGET_EXCEEDED');
      } else if (byteLength(placeholder)>options.remainingToolBytes() || !options.canDeliver({call,result:placeholder,citations:[],locators:[]})) return fail('BUDGET_EXCEEDED');
      let value: WorkCycleToolValue;
      if (!['work_list','work_read'].includes(call.toolName)) options.beforeMutation?.();
      switch (call.toolName) {
        case 'work_list': value = {kind:'work_list', files: options.workspace.list()}; break;
        case 'work_read': {
          const result = options.workspace.read(call.arguments.fileId, call.arguments.version), bytes = Buffer.from(result.text, 'utf8'), offset = call.arguments.offset;
          if (offset > bytes.length || offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) return fail('INVALID_REQUEST');
          let end = Math.min(bytes.length, offset + Math.min(W.readPageBytes,TOOL_OUTPUT_PREVIEW_BYTES));
          while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
          for (;;) {
            alive();value={kind:'work_read',file:result.file,text:bytes.subarray(offset,end).toString('utf8'),offset,nextOffset:end===bytes.length?null:end};
            const candidate:ProjectReadToolResult={ok:true,value};
            if(byteLength(candidate)<=options.remainingToolBytes()&&options.canDeliver({call,result:candidate,citations:[],locators:[]}))break;
            if(end===offset)return fail('BUDGET_EXCEEDED');
            let next=offset+Math.floor((end-offset)/2);
            while(next>offset&&next<bytes.length&&(bytes[next]!&0xc0)===0x80)next--;
            // Test one whole scalar before concluding the remaining capacity is exhausted.
            if(next===offset){next=offset+1;while(next<bytes.length&&(bytes[next]!&0xc0)===0x80)next++;}
            if(next>=end)return fail('BUDGET_EXCEEDED');
            end=next;
          }
          break;
        }
        case 'work_write': {
          if (changes >= W.changes) return fail('BUDGET_EXCEEDED'); changes++;
          const result = await options.workspace.write(call.callId, call.arguments); mutation = true;
          value = {...result, file:confirmed(result.file)}; break;
        }
        case 'work_edit': {
          if (changes >= W.changes) return fail('BUDGET_EXCEEDED'); changes++;
          const result = await options.workspace.edit(call.callId, call.arguments); mutation = true;
          value = {...result, file:confirmed(result.file)}; break;
        }
        case 'work_import': {
          if (changes >= W.changes) return fail('BUDGET_EXCEEDED'); changes++;
          const source = await options.importSource(call.arguments.fileId, call.arguments.version); alive();
          const result = await options.workspace.importFile(call.callId, call.arguments, source.source, source.bytes); mutation = true;
          value = {...result,file:confirmed(result.file)}; break;
        }
        case 'work_run': {
          if (executions >= W.executions) return fail('BUDGET_EXCEEDED');
          if (!options.runner.available().available) return fail('CAPABILITY_DENIED'); executions++;
          const snapshot = await options.workspace.snapshot(call.callId, call.arguments); alive();
          const result = await options.runner.run(snapshot, options.signal);
          if (!result.cleanupConfirmed) return fail('CLEANUP_FAILED'); alive();
          const execution = await options.workspace.acceptExecution(snapshot, result); mutation = true;
          value = {kind:'work_run',execution:{...execution,artifacts:execution.artifacts.map(confirmed)}}; break;
        }
      }
      return await publish(call, {ok:true,value}, mutation);
    } catch (error) {
      alive(); const code = error instanceof WorkCycleError || error instanceof ProjectReadFsError ? error.code : 'IO_ERROR';
      if (mutation || ['STORAGE_FAILED','CANCELLED','CLEANUP_FAILED'].includes(code)) { closed = true; throw error; }
      return await publish(call, {ok:false,error:{code},coverage:null}, false);
    } finally { busy = false; }
  }
  return Object.freeze({
    busy(): boolean { return busy; },
    execute(input: ProjectReadToolCall): Promise<ProjectReadToolResult> {
      if (!isWorkCycleToolName(input.toolName)) return Promise.reject(new WorkCycleError('CAPABILITY_DENIED'));
      const call = input as Call, previous = pending.get(call.callId);
      if (previous) return isDeepStrictEqual(previous.call, call) ? previous.result : Promise.reject(new WorkCycleError('CONFLICT'));
      if (maxToolCalls!==null && completed.size + pending.size >= maxToolCalls && !completed.has(call.callId)) return Promise.reject(new WorkCycleError('BUDGET_EXCEEDED'));
      const result = executeOnce(call); pending.set(call.callId, {call,result});
      void result.finally(() => pending.delete(call.callId)).catch(() => {}); return result;
    },
    async close(): Promise<void> {
      closed = true; await options.runner.close();
      await Promise.allSettled([...pending.values()].map(p => p.result)); await options.workspace.close();
    },
  });
}
export type WorkCycleBroker = ReturnType<typeof createWorkCycleBroker>;
