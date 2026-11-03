import {WORKSPACE_VERSION,emptyWorkspace,parseWorkspaceDisk,parseWorkspaceResult,type WorkspaceDisk,type WorkbenchWorkspaceApi} from '../../shared/agent/project-workspace';
export type WorkspaceSnapshot={disk:WorkspaceDisk|null;status:'loading'|'saved'|'saving'|'error'|'memory';error:string};
/** One ordered writer. A stale acknowledgement may advance revision, never replace newer local edits. */
export function createWorkspaceController(api?:WorkbenchWorkspaceApi,options:{requireInitialExternal?:boolean}={}){
 let snapshot:WorkspaceSnapshot={disk:null,status:'loading',error:''},revision=0,queued=0,locked=false,external=false,externalUncertain=!!options.requireInitialExternal,chain=Promise.resolve(true),started:Promise<void>|undefined;
 const listeners=new Set<()=>void>(),emit=(next:WorkspaceSnapshot)=>{snapshot=next;for(const listener of listeners)listener();};
 const fail=()=>emit({...snapshot,status:'error',error:'工作区保存失败或已被其他窗口更改。当前内容仍在此窗口，请保留重要内容后重新打开；后续工作区写入已暂停。'});
 const pendingChanges=new Set<Promise<boolean>>();
 function trackedChange(update:(state:WorkspaceDisk)=>WorkspaceDisk,confirmed=false):Promise<boolean>{
   if(external||externalUncertain)return Promise.resolve(false);
   const result=change(update,confirmed);pendingChanges.add(result);void result.finally(()=>pendingChanges.delete(result));return result;
 }
 function change(update:(state:WorkspaceDisk)=>WorkspaceDisk,confirmed=false):Promise<boolean>{
   if(locked||(confirmed&&queued))return chain.then(ok=>ok?change(update,confirmed):false);
   if(!snapshot.disk||snapshot.status==='error')return Promise.resolve(false);
   let next:WorkspaceDisk;try{const updated=update(snapshot.disk);if(updated===snapshot.disk)return chain;next=parseWorkspaceDisk(updated);}catch{emit({...snapshot,error:'项目数量、文件或提案容量超出限制，或所选范围无效；这次变更未保存。'});return Promise.resolve(false);}
   if(!api){emit({disk:next,status:'memory',error:''});return Promise.resolve(true);}
   queued++;locked=confirmed;emit({disk:confirmed?snapshot.disk:next,status:'saving',error:''});
   chain=chain.then(async previous=>{
    if(!previous||snapshot.status==='error'){queued--;locked=false;return false;}
    try{const result=parseWorkspaceResult(await api.save({contractVersion:WORKSPACE_VERSION,expectedRevision:revision,state:{...next,revision}}));
     if(!result.ok||result.value.revision!==revision+1){queued--;locked=false;fail();return false;}
     revision=result.value.revision;queued--;locked=false;emit({...snapshot,disk:{...(confirmed?next:snapshot.disk!),revision},status:queued?'saving':'saved'});return true;
    }catch{queued--;locked=false;fail();return false;}
   });return chain;
 }
 async function runExternal<T extends {ok:boolean;workspace?:WorkspaceDisk;creation?:{status:string}|null}>(operation:(expectedRevision:number)=>Promise<T>):Promise<T|undefined>{
  if(external||(!externalUncertain&&snapshot.status==='error')||!snapshot.disk)return;
  external=true;
  try{
   if((await Promise.all([...pendingChanges])).some(ok=>!ok))return;
   if(!await chain)return;
   emit({...snapshot,status:'saving',error:''});
   const result=await operation(revision);
   if(!result.ok||!result.workspace)throw Error('Unconfirmed external transaction');
   const next=parseWorkspaceDisk(result.workspace);
   if(next.revision<revision)throw Error('Stale external revision');
   revision=next.revision;externalUncertain=result.creation?.status==='pending';chain=Promise.resolve(true);
   emit({disk:next,status:externalUncertain?'error':api?'saved':'memory',error:externalUncertain?'项目创建尚未完成，请继续完成原项目；期间工作区写入已暂停。':''});return result;
  }catch{
   externalUncertain=true;emit({...snapshot,status:'error',error:'项目创建结果尚未确认，工作区写入已暂停。请在新建项目窗口点击“核对结果”，不要重复新建。'});return;
  }finally{external=false;}
 }
 return {
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  snapshot:()=>snapshot,
  start(){return started??= (async()=>{if(!api){emit({disk:emptyWorkspace(),status:externalUncertain?'saving':'memory',error:''});return;}try{const result=parseWorkspaceResult(await api.read({contractVersion:WORKSPACE_VERSION}));if(!result.ok){fail();return;}revision=result.value.revision;emit({disk:result.value,status:externalUncertain?'saving':'saved',error:''});}catch{fail();}})();},
  flush:()=>chain,
  change:trackedChange,
  runExternal,
 };
}
