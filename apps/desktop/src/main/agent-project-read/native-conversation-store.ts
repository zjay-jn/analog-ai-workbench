import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {OpenCodePilotError} from '../engine-pilot/opencode-client';
import {runtimePaths} from '../runtime-paths';

export type NativeConversationBinding={version:1;conversationId:string;sessionId:string;migrationHash:string;migrationComplete:boolean;externalTurnIds:string[];historyCount:number;historyHash:string;pending:boolean};
export const DEFAULT_NATIVE_CONVERSATION_DIRECTORY=path.join(runtimePaths().pilotRoot,'conversations');
// The native paginated route uses a raw JSON response while its final page uses
// the API schema encoder. Both preserve values but may reorder object fields.
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
export const nativeHistoryHash=(rows:unknown):string=>createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex');
const fail=():never=>{throw new OpenCodePilotError();};
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
/** Main-owned bindings contain identifiers and integrity receipts, never credentials or duplicated history. */
export function createNativeConversationStore(directory=path.join(runtimePaths().pilotRoot,'conversations')){
  const base=path.resolve(directory),product=runtimePaths().dataRoot;
  if(!base.toLowerCase().startsWith(product.toLowerCase()+path.sep))fail();
  const verify=(filename:string,file=false)=>{let cursor=path.resolve(filename);for(;;){const stat=fs.lstatSync(cursor);if(stat.isSymbolicLink()||path.resolve(fs.realpathSync(cursor)).toLowerCase()!==cursor.toLowerCase()||cursor===filename&&(file?(!stat.isFile()||stat.nlink!==1):!stat.isDirectory()))fail();const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}};
  const filename=(id:string)=>{if(!uuid(id))fail();return path.join(base,'bindings',id.toLowerCase()+'.json');};
  const ensureDirectory=(directory:string)=>{const missing:string[]=[];let cursor=directory;while(!fs.existsSync(cursor)){missing.unshift(cursor);cursor=path.dirname(cursor);}verify(cursor);for(const entry of missing){fs.mkdirSync(entry);verify(entry);}};
  const validate=(value:unknown,id:string):NativeConversationBinding=>{if(!value||typeof value!=='object'||Array.isArray(value))return fail();const v=value as NativeConversationBinding;
    if(Object.keys(v).sort().join(',')!=='conversationId,externalTurnIds,historyCount,historyHash,migrationComplete,migrationHash,pending,sessionId,version'||v.version!==1||v.conversationId!==id||typeof v.sessionId!=='string'||!/^ses[A-Za-z0-9_.:-]{1,255}$/u.test(v.sessionId)||typeof v.migrationComplete!=='boolean'||typeof v.pending!=='boolean'||!Number.isSafeInteger(v.historyCount)||v.historyCount<0||!Array.isArray(v.externalTurnIds)||v.externalTurnIds.some(id=>!uuid(id))||new Set(v.externalTurnIds).size!==v.externalTurnIds.length||!(/^[a-f0-9]{64}$/u.test(v.historyHash))||!(/^[a-f0-9]{64}$/u.test(v.migrationHash)))return fail();return v;};
  return {
    load(id:string):NativeConversationBinding|null{const file=filename(id);try{verify(file,true);const bytes=fs.readFileSync(file);if(bytes.length>64*1024*1024)fail();return validate(JSON.parse(bytes.toString('utf8')),id);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},
    save(value:NativeConversationBinding){validate(value,value.conversationId);const file=filename(value.conversationId);ensureDirectory(base);const parent=path.dirname(file);ensureDirectory(parent);if(fs.existsSync(file))verify(file,true);const temporary=path.join(parent,randomUUID()+'.tmp');fs.writeFileSync(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});verify(temporary,true);fs.renameSync(temporary,file);verify(file,true);},
    verify(binding:NativeConversationBinding,rows:unknown[]){if(rows.length<binding.historyCount||nativeHistoryHash(rows.slice(0,binding.historyCount))!==binding.historyHash)fail();},
    checkpoint(binding:NativeConversationBinding,rows:unknown[],pending=false){const next={...binding,historyCount:rows.length,historyHash:nativeHistoryHash(rows),pending};this.save(next);return next;},
  };
}
export type NativeConversationStore=ReturnType<typeof createNativeConversationStore>;
