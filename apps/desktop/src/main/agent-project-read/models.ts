import { PROJECT_READ_LIMITS as L, type ProjectReadModel } from '../../shared/agent/agent-project-read';
import { parseProjectReadModel } from '../../shared/agent/agent-project-model';
import {parseReplyLimits,replyBodyBytes,replyWireBytes,type ReplyLimits} from '../../shared/agent/reply-limits';

/** Optional main-only chat limits; omission preserves the original tool-run policy. */
export function projectReadReplyPolicy(limits?:ReplyLimits){
  if(limits===undefined)return {maxOutputTokens:L.maxOutputTokens,requestTimeoutMs:L.requestMs,outputBytes:L.outputBytes,wireBytes:L.wireBytes,contextBytes:L.contextBytes};
  if(!limits||Object.getPrototypeOf(limits)!==Object.prototype||Reflect.ownKeys(limits).length!==2)throw new TypeError('Invalid reply limits');
  const tokens=Object.getOwnPropertyDescriptor(limits,'maxOutputTokens'),timeout=Object.getOwnPropertyDescriptor(limits,'timeoutMs');
  if(!tokens?.enumerable||!('value'in tokens)||!timeout?.enumerable||!('value'in timeout))throw new TypeError('Invalid reply limits');
  const parsed=parseReplyLimits(tokens.value,timeout.value);
  return {maxOutputTokens:parsed.maxOutputTokens,requestTimeoutMs:parsed.timeoutMs,outputBytes:replyBodyBytes(parsed.maxOutputTokens),wireBytes:replyWireBytes(parsed.maxOutputTokens),contextBytes:1024*1024};
}

const checked = (input: ProjectReadModel): ProjectReadModel => {
  const model = parseProjectReadModel(input); if (!model) throw Error('PROJECT_READ_MODEL_UNAVAILABLE'); return model;
};
export function projectReadEndpoint(input: ProjectReadModel): string {
  return checked(input).provider === 'kimi' ? 'https://api.moonshot.cn/v1/chat/completions' : 'https://api.deepseek.com/chat/completions';
}
/** Main constructs endpoint, reasoning policy and output ceilings; native request options confer no authority. */
export function projectReadRequestBody(input: ProjectReadModel, messages: readonly unknown[], tools: readonly unknown[], maxOutputTokens: number, toolChoice: 'auto'|'none' = 'auto'): Record<string, unknown> {
  const model = checked(input);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > L.maxOutputTokens || !['auto','none'].includes(toolChoice)) throw Error('PROJECT_READ_MODEL_UNAVAILABLE');
  return { model:model.model, messages, tools, tool_choice:toolChoice, stream:true, stream_options:{include_usage:true},
    ...(model.provider === 'kimi' ? {max_completion_tokens:maxOutputTokens,reasoning_effort:'low'}
      : {max_tokens:maxOutputTokens,thinking:{type:'disabled'},parallel_tool_calls:false}) };
}
