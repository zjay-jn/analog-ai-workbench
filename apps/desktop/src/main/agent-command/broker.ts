import { isDeepStrictEqual } from 'node:util';
import { COMMAND_LIMITS as L, type CommandToolName, type CommandToolValue } from '../../shared/agent/agent-command';
import { isCommandToolName } from '../../shared/agent/agent-command-validation';
import type { ProjectReadToolCall, ProjectReadToolResult } from '../../shared/agent/agent-project-read';
import { parseProjectReadToolArguments, parseProjectReadToolResult } from '../../shared/agent/agent-project-read-validation';
import type { ProjectReadPublication } from '../cloud/project-read-broker';
import { CommandError, type CommandController } from './types';

type Call=Extract<ProjectReadToolCall,{toolName:CommandToolName}>;
export function createCommandBroker(options:Readonly<{
  controller:CommandController;signal:AbortSignal;authorize:(call:ProjectReadToolCall)=>boolean;
  canDeliver:(publication:ProjectReadPublication)=>boolean;remainingToolBytes:()=>number;
  publish:(publication:ProjectReadPublication)=>Promise<void>;legacyBusy:()=>boolean;
}>){
  const completed=new Map<string,{call:Call;result:ProjectReadToolResult}>(),pending=new Map<string,{call:Call;result:Promise<ProjectReadToolResult>}>();
  const alive=():void=>{if(options.signal.aborted)throw new CommandError('CANCELLED');};
  const fits=(call:Call,result:ProjectReadToolResult):boolean=>Buffer.byteLength(JSON.stringify(result))<=options.remainingToolBytes()&&options.canDeliver({call,result,citations:[],locators:[]});
  async function publish(call:Call,result:ProjectReadToolResult):Promise<ProjectReadToolResult>{alive();const parsed=parseProjectReadToolResult(result);if(!parsed)throw new CommandError('ENGINE_FAILED');const p={call,result:parsed,citations:[],locators:[]};if(Buffer.byteLength(JSON.stringify(parsed))>options.remainingToolBytes()||!options.canDeliver(p))throw new CommandError('BUDGET_EXCEEDED');await options.publish(p);alive();completed.set(call.callId,{call,result:parsed});return parsed;}
  async function execute(call:Call):Promise<ProjectReadToolResult>{
    alive();if(!options.authorize(call))throw new CommandError('CAPABILITY_DENIED');const previous=completed.get(call.callId);if(previous){if(!isDeepStrictEqual(previous.call,call))throw new CommandError('CONFLICT');return previous.result;}
    if(!parseProjectReadToolArguments(call.toolName,call.arguments))throw new CommandError('INVALID_REQUEST');
    const placeholder:ProjectReadToolResult={ok:false,error:{code:'BUDGET_EXCEEDED'},coverage:null};
    const changesExecution=call.toolName==='command_start'||call.toolName==='command_stop';
    // Execution side effects require the existing full reservation. Bounded read-only
    // queries can instead check their actual result in publish, including durable capacity.
    if(changesExecution){
      if(options.remainingToolBytes()<L.toolResultBytes||!options.canDeliver({call,result:placeholder,citations:[],locators:[],reserveBytes:L.eventBytes}))throw new CommandError('BUDGET_EXCEEDED');
    }else if(Buffer.byteLength(JSON.stringify(placeholder))>options.remainingToolBytes()||!options.canDeliver({call,result:placeholder,citations:[],locators:[]}))throw new CommandError('BUDGET_EXCEEDED');
    try{let value:CommandToolValue;
      switch(call.toolName){
        case 'command_environment':value={kind:call.toolName,...await options.controller.inspect()};break;
        case 'command_start':if(options.legacyBusy())throw new CommandError('BUSY');value={kind:call.toolName,execution:await options.controller.start(call.arguments)};break;
        case 'command_status':value={kind:call.toolName,execution:await options.controller.status(call.arguments)};break;
        case 'command_stop':value={kind:call.toolName,execution:await options.controller.stop(call.arguments.executionId)};break;
        case 'command_log':{
          let maxBytes=call.arguments.maxBytes,expectedPrefixVersion=call.arguments.expectedPrefixVersion;
          for(;;){
            alive();const page=options.controller.log({...call.arguments,maxBytes,expectedPrefixVersion});
            value={kind:call.toolName,page};
            if(fits(call,{ok:true,value}))break;
            const returned=page.endOffset-page.offset;
            if(returned<=1)throw new CommandError('BUDGET_EXCEEDED');
            // Keep the first observed durable prefix fixed while fitting this page.
            // A whole UTF-8 scalar can serialize smaller than its base64 prefix.
            // Check each size up to four bytes before declaring no progress fits.
            expectedPrefixVersion=page.prefixVersion;maxBytes=returned>4?Math.max(4,Math.floor(returned/2)):returned-1;
          }
          break;
        }
      }
      return await publish(call,{ok:true,value});
    }catch(e){if(e instanceof CommandError&&!['STORAGE_FAILED','CANCELLED','CLEANUP_FAILED'].includes(e.code))return publish(call,{ok:false,error:{code:e.code},coverage:null});throw e;}
  }
  return {execute(input:ProjectReadToolCall):Promise<ProjectReadToolResult>{
    if(!isCommandToolName(input.toolName))return Promise.reject(new CommandError('CAPABILITY_DENIED'));const call=input as Call,prior=pending.get(call.callId);if(prior)return isDeepStrictEqual(prior.call,call)?prior.result:Promise.reject(new CommandError('CONFLICT'));
    const result=execute(call);pending.set(call.callId,{call,result});void result.finally(()=>pending.delete(call.callId)).catch(()=>{});return result;
  }};
}
export type CommandBroker=ReturnType<typeof createCommandBroker>;
