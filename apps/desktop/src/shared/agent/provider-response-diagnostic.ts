/** Fixed local validation locations. Never populate these fields from provider text. */
export const PROVIDER_RESPONSE_CODES = Object.freeze([
  'response.unclassified','response.content_type','response.utf8','response.secret',
  'response.tools_disabled','response.compaction','response.call_identity','response.canonical','response.publish',
  'sse.chunk','sse.frame.order','sse.frame.lines','sse.done','sse.json','sse.frame.shape','sse.frame.metadata',
  'sse.id','sse.model','sse.usage','sse.usage.conflict','sse.choices','sse.choice.shape','sse.choice.index',
  'sse.choice.usage','sse.delta.shape','sse.delta.role','sse.delta.reasoning','sse.delta.text',
  'sse.tool.chunks','sse.tool.shape','sse.tool.index','sse.tool.id','sse.tool.type','sse.tool.function',
  'sse.tool.name','sse.tool.arguments_text','sse.finish.reason','sse.final.incomplete',
  'sse.tool.complete','sse.tool.arguments_json','sse.tool.arguments_schema','sse.final.consistency',
  'sse.choice.usage.finish','sse.usage.shape','sse.usage.counts','sse.usage.total','sse.usage.completion_details',
  'sse.usage.reasoning','sse.usage.cache_hit','sse.usage.cache_miss','sse.usage.prompt_details',
  'sse.usage.cached','sse.usage.cache_write','sse.usage.cached_conflict','sse.usage.cache_total',
] as const);
export type ProviderResponseCode = typeof PROVIDER_RESPONSE_CODES[number];
export const PROVIDER_USAGE_FIELDS=Object.freeze(['prompt_tokens','completion_tokens','total_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','cached_tokens','completion_tokens_details','completion_tokens_details.reasoning_tokens','prompt_tokens_details','prompt_tokens_details.cached_tokens','prompt_tokens_details.cache_write_tokens'] as const);
const usageKinds=['missing','null','integer','invalid_number','string','boolean','array','object','other'] as const;
type UsageKind=typeof usageKinds[number];
export type ProviderUsageDiagnostic=Readonly<{
  scope:'frame'|'choice';finishReason:'absent'|'null'|'stop'|'tool_calls'|'length'|'content_filter'|'other';
  shape:UsageKind;unknownFields:number;completionUnknownFields:number;promptUnknownFields:number;
  fields:readonly Readonly<{field:typeof PROVIDER_USAGE_FIELDS[number];kind:UsageKind;value?:number}>[];
}>;
const valueKind=(value:unknown):UsageKind=>value===undefined?'missing':value===null?'null':typeof value==='number'?(Number.isSafeInteger(value)&&!Object.is(value,-0)&&value>=0?'integer':'invalid_number'):typeof value==='string'?'string':typeof value==='boolean'?'boolean':Array.isArray(value)?'array':typeof value==='object'?'object':'other';
/** Diagnostic observer receives only known numeric counters and fixed classifications. */
export function providerUsageDiagnostic(value:unknown,scope:'frame'|'choice',finish:unknown):ProviderUsageDiagnostic{
 const read=(row:unknown,key:string):unknown=>row&&typeof row==='object'&&!Array.isArray(row)?Object.getOwnPropertyDescriptor(row,key)?.value:undefined;
 const unknown=(row:unknown,known:readonly string[])=>row&&typeof row==='object'&&!Array.isArray(row)?Reflect.ownKeys(row).filter(key=>typeof key!=='string'||!known.includes(key)).length:0;
 const fields=PROVIDER_USAGE_FIELDS.map(field=>{const [parent,child]=field.split('.'),item=child?read(read(value,parent!),child):read(value,parent!),kind=valueKind(item);return Object.freeze({field,kind,...(kind==='integer'?{value:item as number}:{})});});
 return Object.freeze({scope,finishReason:finish===undefined?'absent':finish===null?'null':['stop','tool_calls','length','content_filter'].includes(finish as string)?finish as 'stop'|'tool_calls'|'length'|'content_filter':'other',shape:valueKind(value),unknownFields:unknown(value,PROVIDER_USAGE_FIELDS.filter(field=>!field.includes('.'))),completionUnknownFields:unknown(read(value,'completion_tokens_details'),['reasoning_tokens']),promptUnknownFields:unknown(read(value,'prompt_tokens_details'),['cached_tokens','cache_write_tokens']),fields:Object.freeze(fields)});
}
export type ProviderResponseDiagnostic = Readonly<{
  code:ProviderResponseCode;frame:number;receivedBytes:number;textBytes:number;toolCalls:number;
  done:boolean;finish:'none'|'stop'|'tool_calls';
  usage?:ProviderUsageDiagnostic;
}>;
/** Exact data descriptors only; unknown strings, fields, accessors and non-scalars are rejected. */
export function parseProviderResponseDiagnostic(value:unknown):ProviderResponseDiagnostic {
  const bad=():never=>{throw TypeError('Invalid provider response diagnostic');};
  if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)return bad();
  const expected=['code','frame','receivedBytes','textBytes','toolCalls','done','finish'];
  const keys=Reflect.ownKeys(value);if(expected.some(key=>!Object.hasOwn(value,key))||keys.some(key=>typeof key!=='string'||!expected.includes(key)&&key!=='usage'))return bad();
  const row:Record<string,unknown>={};for(const key of expected){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!('value' in d))return bad();row[key]=d.value;}
  if(!PROVIDER_RESPONSE_CODES.includes(row.code as ProviderResponseCode)||typeof row.done!=='boolean'||!['none','stop','tool_calls'].includes(row.finish as string))return bad();
  for(const key of ['frame','receivedBytes','textBytes','toolCalls'])if(!Number.isSafeInteger(row[key])||Object.is(row[key],-0)||(row[key] as number)<0)return bad();
  if(Object.hasOwn(value,'usage')){const d=Object.getOwnPropertyDescriptor(value,'usage');if(!d?.enumerable||!('value'in d)||typeof row.code!=='string'||!row.code.includes('usage'))return bad();row.usage=parseProviderUsageDiagnostic(d.value);}
  return Object.freeze(row as ProviderResponseDiagnostic);
}
export function parseProviderUsageDiagnostic(value:unknown):ProviderUsageDiagnostic{
 const bad=():never=>{throw TypeError('Invalid provider usage diagnostic');};
 const exact=(value:unknown,names:readonly string[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)return bad();const keys=Reflect.ownKeys(value);if(keys.length!==names.length||keys.some(key=>typeof key!=='string'||!names.includes(key)))return bad();const row:Record<string,unknown>={};for(const key of names){const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!('value'in d))return bad();row[key]=d.value;}return row;};
 const row=exact(value,['scope','finishReason','shape','unknownFields','completionUnknownFields','promptUnknownFields','fields']);
 if(!['frame','choice'].includes(row.scope as string)||!['absent','null','stop','tool_calls','length','content_filter','other'].includes(row.finishReason as string)||!usageKinds.includes(row.shape as UsageKind))return bad();
 for(const key of ['unknownFields','completionUnknownFields','promptUnknownFields'])if(!Number.isSafeInteger(row[key])||Object.is(row[key],-0)||(row[key] as number)<0)return bad();
 if(!Array.isArray(row.fields)||Object.getPrototypeOf(row.fields)!==Array.prototype||row.fields.length!==PROVIDER_USAGE_FIELDS.length||Reflect.ownKeys(row.fields).length!==PROVIDER_USAGE_FIELDS.length+1)return bad();
 const fields=[];for(let i=0;i<PROVIDER_USAGE_FIELDS.length;i++){const d=Object.getOwnPropertyDescriptor(row.fields,String(i));if(!d?.enumerable||!('value'in d))return bad();const hasValue=d.value&&typeof d.value==='object'&&Object.hasOwn(d.value,'value'),field=exact(d.value,['field','kind',...(hasValue?['value']:[])]);if(field.field!==PROVIDER_USAGE_FIELDS[i]||!usageKinds.includes(field.kind as UsageKind)||(field.kind==='integer')!==!!hasValue||hasValue&&(!Number.isSafeInteger(field.value)||Object.is(field.value,-0)||(field.value as number)<0))return bad();fields.push(Object.freeze(field));}
 return Object.freeze({...row,fields:Object.freeze(fields)}) as ProviderUsageDiagnostic;
}
