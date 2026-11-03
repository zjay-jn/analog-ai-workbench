/** Locally selected enum evidence only. Native/provider text, paths and IDs never enter this value. */
export const NATIVE_CLIENT_FAILURE_STAGES = ['health','session_create','session_open','history_seed','prompt_submit','message_read','status_read','question_read','question_answer','question_reject','session_abort','event_connect','event_decode','event_message','event_text'] as const;
export const NATIVE_ADAPTER_FAILURE_STAGES = ['conversation_prepare','snapshot_validate','text_projection','tool_projection','question_projection','completion_validate','tool_callback','engine_start'] as const;
export const NATIVE_ENGINE_FAILURE_REASONS = ['transport','timeout','http_status','response_identity','response_format','response_size','invalid_payload','invalid_identity','text_regression','text_after_end','unexpected_state','stream_closed','native_session_error','native_disposed','history_changed','user_part_timeout','tool_result_mismatch','incomplete_completion','unknown'] as const;
export type NativeEngineFailureStage = typeof NATIVE_CLIENT_FAILURE_STAGES[number] | typeof NATIVE_ADAPTER_FAILURE_STAGES[number];
export type NativeEngineFailureReason = typeof NATIVE_ENGINE_FAILURE_REASONS[number];
export type NativeEngineFailure = Readonly<{origin:'native_client'|'native_adapter';stage:NativeEngineFailureStage;reason:NativeEngineFailureReason}>;
/** Reject extra fields and accessors without reading untrusted property values. */
export function parseNativeEngineFailure(value:unknown):NativeEngineFailure|null {
  try {
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return null;
    const keys=Reflect.ownKeys(value);if(keys.length!==3||keys.some(key=>key!=='origin'&&key!=='stage'&&key!=='reason'))return null;
    const fields=Object.getOwnPropertyDescriptors(value);
    if(['origin','stage','reason'].some(key=>!fields[key]||!Object.hasOwn(fields[key]!,'value')))return null;
    const origin=fields.origin!.value,stage=fields.stage!.value,reason=fields.reason!.value;
    const stages=origin==='native_client'?NATIVE_CLIENT_FAILURE_STAGES:origin==='native_adapter'?NATIVE_ADAPTER_FAILURE_STAGES:null;
    if(!stages||!stages.some(item=>item===stage)||!NATIVE_ENGINE_FAILURE_REASONS.some(item=>item===reason))return null;
    return Object.freeze({origin,stage,reason}) as NativeEngineFailure;
  }catch{return null;}
}
