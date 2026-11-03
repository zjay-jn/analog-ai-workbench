/** Public diagnostic projection. Never contains commands, messages, absolute paths or credentials. */
export const COMMAND_DIAGNOSTIC_COMPONENTS=['controller','windows_driver','wsl_driver','recovery'] as const;
export const COMMAND_DIAGNOSTIC_OPERATIONS=[
 'record.create','record.validate','record.save','driver.start','driver.wait','driver.stop','callback.started','callback.exit','callback.job','callback.log',
 'finish.validate','finish.log.stdout','finish.log.stderr','finish.changes.validate','finish.baseline','finish.artifacts.publish','finish.artifacts.confirm','finish.persist','controller.reopen','controller.close','recovery.read','recovery.validate','recovery.persist',
 'prepare','profile_verify','request_prepare','directory_prepare','request_write','spawn','stop_send','stdin_error','protocol_stdout_limit','callback_started','callback_exit','callback_job','callback_log','status_sequence','status_exit','status_job','log_read','protocol_ready','protocol_status','protocol_result','protocol_decode','protocol_fault','protocol_identity','protocol_started','protocol_log','protocol_job','protocol_artifact','protocol_unknown','protocol_line_limit','protocol_tail','log_flush','log_digest','process_wait','process_kill','process_exit','result_missing','baseline_verify','artifacts_verify','runtime_dispose','native_failure','cleanup_confirm','proof_write',
] as const;
export const COMMAND_DIAGNOSTIC_CAUSE_CODES=[
 'UNKNOWN_ERROR','NO_ERROR','INVALID_REQUEST','CAPABILITY_DENIED','NOT_BOUND','CREATION_PENDING','CWD_UNAVAILABLE','PATH_POLICY_DENIED','PATH_NOT_FOUND','ACCESS_DENIED','NOT_A_DIRECTORY','NOT_A_FILE','ROOT_UNAVAILABLE','ROOT_CHANGED','FILE_UNAVAILABLE','SOURCE_CHANGED','SNAPSHOT_CHANGED','CURSOR_STALE','UNSUPPORTED_PATH','UNSUPPORTED_ENCODING','UNSUPPORTED_TEXT','FILE_LIMIT','SCOPE_LIMIT','RULES_UNAVAILABLE','RULES_LIMIT','BUDGET_EXCEEDED','CANCELLED','BUSY','STORAGE_FAILED','MODEL_UNAVAILABLE','ENGINE_FAILED','CLEANUP_FAILED','IO_ERROR','HISTORY_FULL','RUN_NOT_FOUND','RUN_HAS_DEPENDENTS','CONFLICT','UNSUPPORTED_FORMAT','UNSUPPORTED_ANALYSIS','UNSUPPORTED_UNIT','UNSUPPORTED_WAVEFORM','TRACE_UNAVAILABLE','AXIS_MISMATCH','CONVERTER_UNAVAILABLE','METRIC_INPUT_INVALID',
 'CALLBACK_FAILED','NATIVE_CLEANUP_TIMEOUT','NATIVE_RESULT_MISSING','ARTIFACTS_UNAVAILABLE','NATIVE_EVIDENCE_FAILED','WSL_BRIDGE_FAILED','WSL_FAULT_FRAME','WSL_RESULT_MISSING','WSL_PROCESS_EXIT','WSL_ARTIFACTS_UNAVAILABLE','INSUFFICIENT_DISK_SPACE','PREPARATION_DEADLINE','PREPARATION_FAILED','DRIVER_EVIDENCE_FAILED','STOP_DELIVERY_FAILED','LOG_INCOMPLETE','RECONCILIATION_REQUIRED',
 'EACCES','EPERM','ENOENT','EEXIST','ENOSPC','EIO','EBUSY','EMFILE','ENFILE','EROFS','ENOTDIR','EISDIR','EINVAL','EPIPE','ECONNRESET','ETIMEDOUT','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_STREAM_DESTROYED','ERR_STREAM_WRITE_AFTER_END','SYNTAX_ERROR','TYPE_ERROR','RANGE_ERROR',
] as const;
export type CommandDiagnosticComponent=typeof COMMAND_DIAGNOSTIC_COMPONENTS[number];
export type CommandDiagnosticOperation=typeof COMMAND_DIAGNOSTIC_OPERATIONS[number];
export type CommandDiagnosticCauseCode=typeof COMMAND_DIAGNOSTIC_CAUSE_CODES[number];
export type CommandDiagnosticInput=Readonly<{
 runId:string;executionId:string;workspaceId?:string;chatSessionId?:string;turnId?:string;
 component:CommandDiagnosticComponent;operation:CommandDiagnosticOperation;kind:'failure'|'cleanup'|'observation';
 causeCode?:CommandDiagnosticCauseCode;nativeCode?:number|null;
}>;
export type CommandDiagnosticRecord=Readonly<Omit<CommandDiagnosticInput,'causeCode'|'nativeCode'> & {
 version:1;id:string;time:string;appVersion:string;causeCode:CommandDiagnosticCauseCode;nativeCode:number|null;stack:readonly string[];
}>;
export type CommandDiagnosticReadResult=Readonly<{records:readonly CommandDiagnosticRecord[];unavailable:boolean;truncated:boolean}>;
const own=(value:unknown,required:readonly string[],optional:readonly string[]=[]):value is Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return false;
 const keys=Reflect.ownKeys(value);return required.every(key=>keys.includes(key))&&keys.every(key=>typeof key==='string'&&(required.includes(key)||optional.includes(key))&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(v);
const member=(v:unknown,values:readonly string[])=>typeof v==='string'&&values.includes(v);
const array=(v:unknown,max:number,check:(item:unknown)=>boolean):boolean=>Array.isArray(v)&&Object.getPrototypeOf(v)===Array.prototype&&v.length<=max&&Reflect.ownKeys(v).length===v.length+1&&Array.from({length:v.length},(_,i)=>Object.getOwnPropertyDescriptor(v,String(i))).every(p=>!!p&&Object.hasOwn(p,'value')&&check(p.value));
export const commandDiagnosticCauseCode=(v:unknown):CommandDiagnosticCauseCode|undefined=>member(v,COMMAND_DIAGNOSTIC_CAUSE_CODES)?v as CommandDiagnosticCauseCode:undefined;
export const commandDiagnosticVersion=(v:unknown):v is string=>typeof v==='string'&&/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,64})?$/u.test(v);
export const commandDiagnosticStackFrame=(v:unknown):v is string=>typeof v==='string'&&v.length<=240&&/^(?:apps\/desktop\/src\/(?:main|shared|preload)\/|dist\/(?:main|preload)\/)[A-Za-z0-9_./-]+\.(?:ts|js|mjs|cjs):[1-9]\d{0,6}:[1-9]\d{0,6}$/u.test(v)&&!v.includes('..');
export function isCommandDiagnosticInput(value:unknown):value is CommandDiagnosticInput {
 if(!own(value,['runId','executionId','component','operation','kind'],['workspaceId','chatSessionId','turnId','causeCode','nativeCode']))return false;
 return id(value.runId)&&id(value.executionId)&&['workspaceId','chatSessionId','turnId'].every(key=>!Object.hasOwn(value,key)||id(value[key]))&&member(value.component,COMMAND_DIAGNOSTIC_COMPONENTS)&&member(value.operation,COMMAND_DIAGNOSTIC_OPERATIONS)&&member(value.kind,['failure','cleanup','observation'])&&(!Object.hasOwn(value,'causeCode')||!!commandDiagnosticCauseCode(value.causeCode))&&(!Object.hasOwn(value,'nativeCode')||value.nativeCode===null||typeof value.nativeCode==='number'&&Number.isSafeInteger(value.nativeCode)&&Math.abs(value.nativeCode)<=4294967295);
}
export function isCommandDiagnosticRecord(value:unknown):value is CommandDiagnosticRecord {
 if(!own(value,['version','id','time','appVersion','runId','executionId','component','operation','kind','causeCode','nativeCode','stack'],['workspaceId','chatSessionId','turnId']))return false;
 const {version,id:recordId,time,appVersion,stack,...input}=value;
 return version===1&&typeof recordId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(recordId)&&typeof time==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(time)&&Number.isFinite(Date.parse(time))&&commandDiagnosticVersion(appVersion)&&array(stack,8,commandDiagnosticStackFrame)&&isCommandDiagnosticInput(input);
}
export function isCommandDiagnosticReadResult(value:unknown):value is CommandDiagnosticReadResult {
 return own(value,['records','unavailable','truncated'])&&typeof value.unavailable==='boolean'&&typeof value.truncated==='boolean'&&array(value.records,64,isCommandDiagnosticRecord);
}
