import {sessionExact} from './chat-sessions';import {draftId} from './chat-drafts';
export const EXPORT_VERSION='workbench.chat-export.v1' as const,EXPORT_CHANNEL='workbench.chat-export.save.v1';
export type ChatExportRequest={contractVersion:typeof EXPORT_VERSION;sessionId:string};
export type ExportCode='INVALID_REQUEST'|'CAPABILITY_DENIED'|'NOT_FOUND'|'BUSY'|'CANCELLED'|'EXISTS'|'UNSUPPORTED_FILE'|'WRITE_FAILED'|'VERIFY_FAILED';
export type ChatExportResult={ok:true}|{ok:false;error:{code:ExportCode}};
export type WorkbenchChatExportApi={save:(request:ChatExportRequest)=>Promise<ChatExportResult>};
export function parseChatExport(value:unknown):ChatExportRequest{const v=sessionExact(value,['contractVersion','sessionId']);if(v.contractVersion!==EXPORT_VERSION)throw Error('Invalid export');return {contractVersion:EXPORT_VERSION,sessionId:draftId(v.sessionId)};}
export function parseChatExportResult(value:unknown):ChatExportResult{if(Object.getOwnPropertyDescriptor(value??{},'ok')?.value===true){sessionExact(value,['ok']);return {ok:true};}const v=sessionExact(value,['ok','error']),e=sessionExact(v.error,['code']);if(v.ok!==false||!['INVALID_REQUEST','CAPABILITY_DENIED','NOT_FOUND','BUSY','CANCELLED','EXISTS','UNSUPPORTED_FILE','WRITE_FAILED','VERIFY_FAILED'].includes(e.code as string))throw Error('Invalid export result');return {ok:false,error:{code:e.code as ExportCode}};}
