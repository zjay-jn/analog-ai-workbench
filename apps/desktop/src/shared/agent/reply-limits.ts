export const OUTPUT_CHOICES=[2048,8192,16384] as const;
export const REQUEST_TIMEOUT_CHOICES=[30000,120000,300000,600000,900000] as const;
export const TIMEOUT_CHOICES=[...REQUEST_TIMEOUT_CHOICES,1800000,3600000,14400000] as const;
export type ReplyLimits={maxOutputTokens:number;timeoutMs:number};
/** Legacy timeoutMs is a request fallback; only the explicit new field authorizes a whole-turn deadline. */
export type ChatReplyLimits=ReplyLimits&{requestTimeoutMs?:number;turnTimeoutMs?:number|null};
export type ChatTurnLimits={maxOutputTokens:number;requestTimeoutMs:number;turnTimeoutMs:number|null};
export const DEFAULT_REPLY_LIMITS:ReplyLimits={maxOutputTokens:8192,timeoutMs:600000};
/** Only a newly created configuration uses these separate defaults. */
export const DEFAULT_CHAT_REPLY_LIMITS:ChatReplyLimits={maxOutputTokens:8192,timeoutMs:600000,requestTimeoutMs:600000,turnTimeoutMs:null};
export const LEGACY_REPLY_LIMITS:ReplyLimits={maxOutputTokens:2048,timeoutMs:30000};
export const REPLY_RESPONSE_BYTES=8*1024*1024,REPLY_EVENT_COUNT=32768;
export const MAX_REPLY_BYTES=256*1024,REPLY_FIRST_MS=120000,REPLY_IDLE_MS=60000;
export const replyBodyBytes=(tokens:number)=>Math.min(MAX_REPLY_BYTES,Math.max(65536,tokens*16));
export const replyWireBytes=(tokens:number)=>replyBodyBytes(tokens)*64;
export function parseReplyLimits(maxOutputTokens:unknown,timeoutMs:unknown):ReplyLimits{
 if(!OUTPUT_CHOICES.includes(maxOutputTokens as 2048)||!REQUEST_TIMEOUT_CHOICES.includes(timeoutMs as 30000))throw new TypeError('Invalid reply limits');
 return {maxOutputTokens:maxOutputTokens as number,timeoutMs:timeoutMs as number};
}
export function parseTurnTimeoutMs(value:unknown):number{
 if(!TIMEOUT_CHOICES.includes(value as 30000))throw new TypeError('Invalid turn timeout');return value as number;
}
export function resolveChatTurnLimits(limits:ChatReplyLimits):ChatTurnLimits{
 const request=parseReplyLimits(limits.maxOutputTokens,limits.requestTimeoutMs??limits.timeoutMs);
 const turnTimeoutMs=Object.hasOwn(limits,'turnTimeoutMs')?(limits.turnTimeoutMs===null?null:parseTurnTimeoutMs(limits.turnTimeoutMs)):null;
 return {maxOutputTokens:request.maxOutputTokens,requestTimeoutMs:request.timeoutMs,turnTimeoutMs};
}
