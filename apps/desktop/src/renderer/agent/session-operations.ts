import {parseSessionResult,type SessionError,type SessionState} from '../../shared/agent/chat-sessions';
export type SessionOperationOutcome={status:'accepted'|'partial';state:SessionState}|{status:'rejected';code:SessionError}|{status:'uncertain'};
export async function runSessionOperation(invoke:()=>Promise<unknown>,accept:(state:SessionState)=>void,confirm?:(state:SessionState)=>Promise<boolean>):Promise<SessionOperationOutcome>{
 let result;try{result=parseSessionResult(await invoke());}catch{return {status:'uncertain'};}
 if(!result.ok)return result.error.code==='INTERNAL'||result.error.code==='STORAGE_ERROR'?{status:'uncertain'}:{status:'rejected',code:result.error.code};
 accept(result.value);
 // The chat transaction is already committed. A second store cannot undo it.
 if(confirm){try{if(!await confirm(result.value))return {status:'partial',state:result.value};}catch{return {status:'partial',state:result.value};}}
 return {status:'accepted',state:result.value};
}
