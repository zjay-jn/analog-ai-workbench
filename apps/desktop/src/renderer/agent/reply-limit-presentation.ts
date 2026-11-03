/** Render only recorded durations; callers must not fill historical values from today's settings. */
export function replyLimitDuration(ms:number):string{
 if(ms%3600000===0)return `${ms/3600000} 小时`;
 if(ms%60000===0)return `${ms/60000} 分钟`;
 return `${ms/1000} 秒`;
}
export function replyTurnLimit(ms:number|null):string{return ms===null?'关闭':replyLimitDuration(ms);}
