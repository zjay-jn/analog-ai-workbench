import type {WorkCycleChange,WorkCycleFile,WorkCycleFileContent,WorkCycleToolValue} from '../../shared/agent/agent-work-cycle';
import {AGENT_PROJECT_READ_VERSION as V,type WorkbenchAgentProjectReadApi,type ProjectReadRequests} from '../../shared/agent/agent-project-read';
import {parseProjectReadRequest,parseProjectReadResult} from '../../shared/agent/agent-project-read-validation';
import {projectReadError} from './project-read-presentation';

/** Renderer-only ports. The bridge adapter validates shared responses before reaching this controller. */
export type WorkCycleInspectionResult<T>={ok:true;value:T}|{ok:false;message:string};
export type WorkCycleInspectionPorts={
 list:(runId:string)=>Promise<WorkCycleInspectionResult<readonly WorkCycleFile[]>>;
 file:(runId:string,fileId:string,version:string)=>Promise<WorkCycleInspectionResult<WorkCycleFileContent>>;
 change:(runId:string,changeId:string)=>Promise<WorkCycleInspectionResult<WorkCycleChange>>;
};
export type WorkCycleInspectionScope=Readonly<{runId:string;workspaceId:string}>;
export type WorkCyclePreview=Readonly<{kind:'file';content:WorkCycleFileContent}>|Readonly<{kind:'change';change:WorkCycleChange}>;
export type WorkCycleInspectionState=Readonly<{
 scope:WorkCycleInspectionScope|null;revision:number;files:readonly WorkCycleFile[];listing:boolean;listError:string|null;
 preview:WorkCyclePreview|null;opening:boolean;previewError:string|null;
}>;
export const initialWorkCycleInspectionState:WorkCycleInspectionState={scope:null,revision:-1,files:[],listing:false,listError:null,preview:null,opening:false,previewError:null};
const fileKey=(file:Pick<WorkCycleFile,'fileId'|'version'>)=>`${file.fileId}:${file.version}`;
const originKey=(file:WorkCycleFile)=>file.origin.kind==='write'?`write:${file.origin.changeId}`:file.origin.kind==='execution'?`execution:${file.origin.executionId}`:file.origin.kind==='command'?JSON.stringify(['command',file.origin.executionId,file.origin.manifestVersion,file.origin.sourceRelativePath]):file.origin.kind==='continuation'?JSON.stringify(['continuation',file.origin.source.runId,file.origin.source.workspaceId,file.origin.source.fileId,file.origin.source.version,file.origin.source.baselineVersion]):JSON.stringify(['import',file.origin.changeId,file.origin.source.projectId,file.origin.source.bindingId,file.origin.source.identity,file.origin.source.fileId,file.origin.source.relativePath,file.origin.source.version,file.origin.source.bytes]);
const sameFile=(a:WorkCycleFile,b:WorkCycleFile)=>a.fileId===b.fileId&&a.version===b.version&&a.relativePath===b.relativePath&&a.bytes===b.bytes&&originKey(a)===originKey(b);

export function createWorkCycleInspectionController(ports:WorkCycleInspectionPorts){
 let state=initialWorkCycleInspectionState,disposed=false,scopeEpoch=0,listEpoch=0,previewEpoch=0;
 const issuedFiles=new Map<string,WorkCycleFile>(),issuedChanges=new Map<string,Extract<WorkCycleToolValue,{kind:'work_write'|'work_edit'|'work_import'}>>(),listeners=new Set<()=>void>();
 const update=(patch:Partial<WorkCycleInspectionState>)=>{if(disposed)return;state={...state,...patch};listeners.forEach(listener=>listener());};
 function setScope(scope:WorkCycleInspectionScope|null){
  if(disposed||state.scope?.runId===scope?.runId&&state.scope?.workspaceId===scope?.workspaceId)return;
  scopeEpoch++;listEpoch++;previewEpoch++;issuedFiles.clear();issuedChanges.clear();update({...initialWorkCycleInspectionState,scope});
 }
 /** Accept only values projected from validated events for the currently selected run. */
 function register(scope:WorkCycleInspectionScope,values:readonly WorkCycleToolValue[],revision=values.length){
  if(disposed||scope.runId!==state.scope?.runId||scope.workspaceId!==state.scope.workspaceId)return;
  if(state.revision!==revision){listEpoch++;previewEpoch++;update({revision,files:[],listing:false,opening:false});}
  for(const value of values){
   const files=value.kind==='work_list'?value.files:value.kind==='work_run'?value.execution.artifacts:[value.file];
   for(const file of files)issuedFiles.set(fileKey(file),file);
   if(value.kind==='work_write'||value.kind==='work_edit'||value.kind==='work_import')issuedChanges.set(value.changeId,value);
  }
 }
 async function refresh(){
  const scope=state.scope;if(disposed||!scope)return;const epoch=scopeEpoch,request=++listEpoch;previewEpoch++;update({listing:true,listError:null,files:[],opening:false});
  try{const result=await ports.list(scope.runId);if(disposed||epoch!==scopeEpoch||request!==listEpoch)return;
   if(!result.ok){update({listError:result.message});return;}
   for(const file of result.value)issuedFiles.set(fileKey(file),file);update({files:result.value});
  }catch{if(epoch===scopeEpoch&&request===listEpoch)update({listError:'工作文件列表读取失败，请刷新核对。'});}
  finally{if(epoch===scopeEpoch&&request===listEpoch)update({listing:false});}
 }
 async function openFile(file:WorkCycleFile){
  const scope=state.scope,known=issuedFiles.get(fileKey(file));if(disposed||!scope||!known||!sameFile(known,file))return false;
  const epoch=scopeEpoch,request=++previewEpoch;listEpoch++;update({opening:true,previewError:null,listing:false});
  try{const result=await ports.file(scope.runId,known.fileId,known.version);if(disposed||epoch!==scopeEpoch||request!==previewEpoch)return false;
   if(!result.ok){update({previewError:result.message,files:state.files.filter(item=>fileKey(item)!==fileKey(known))});return false;}
   if(!sameFile(known,result.value.file)||result.value.verified!==true||result.value.file.confirmation!=='confirmed')throw Error('Identity or verification mismatch');
   update({preview:{kind:'file',content:result.value},files:[...state.files.filter(item=>fileKey(item)!==fileKey(known)),result.value.file]});return true;
  }catch{if(epoch===scopeEpoch&&request===previewEpoch)update({previewError:'工作文件身份或版本核对失败，保留先前预览；请刷新文件列表后重试。',files:state.files.filter(item=>fileKey(item)!==fileKey(known))});return false;}
  finally{if(epoch===scopeEpoch&&request===previewEpoch)update({opening:false});}
 }
 async function openChange(changeId:string){
  const scope=state.scope,known=issuedChanges.get(changeId);if(disposed||!scope||!known)return false;
  const epoch=scopeEpoch,request=++previewEpoch;update({opening:true,previewError:null});
  try{const result=await ports.change(scope.runId,changeId);if(disposed||epoch!==scopeEpoch||request!==previewEpoch)return false;
   if(!result.ok){update({previewError:result.message});return false;}
   const change=result.value;
   if(change.changeId!==known.changeId||!sameFile(known.file,change.file)||change.previousVersion!==known.previousVersion||change.changed!==known.changed)throw Error('Change mismatch');
   update({preview:{kind:'change',change}});return true;
  }catch{if(epoch===scopeEpoch&&request===previewEpoch)update({previewError:'文件差异身份或版本核对失败，保留先前预览。'});return false;}
  finally{if(epoch===scopeEpoch&&request===previewEpoch)update({opening:false});}
 }
 return {snapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},setScope,register,refresh,openFile,openChange,
  closePreview:()=>{previewEpoch++;update({preview:null,opening:false,previewError:null});},
  dispose:()=>{disposed=true;scopeEpoch++;listEpoch++;previewEpoch++;issuedFiles.clear();issuedChanges.clear();listeners.clear();}};
}
export type WorkCycleInspectionController=ReturnType<typeof createWorkCycleInspectionController>;

export function workCycleInspectionPorts(api:WorkbenchAgentProjectReadApi):WorkCycleInspectionPorts{
 async function call<K extends 'listWorkFiles'|'readWorkFile'|'readWorkChange'>(method:K,input:ProjectReadRequests[K]){
  const request=parseProjectReadRequest(method,input);if(!request)throw Error('Invalid inspection request');
  const result=parseProjectReadResult(method,await api[method](request as never));if(!result)throw Error('Invalid inspection result');return result;
 }
 return {
  list:async runId=>{const result=await call('listWorkFiles',{contractVersion:V,runId});return result.ok?{ok:true,value:result.value.files}:{ok:false,message:projectReadError(result.error.code)};},
  file:async(runId,fileId,version)=>{const result=await call('readWorkFile',{contractVersion:V,runId,fileId,version});return result.ok?{ok:true,value:result.value}:{ok:false,message:projectReadError(result.error.code)};},
  change:async(runId,changeId)=>{const result=await call('readWorkChange',{contractVersion:V,runId,changeId});return result.ok?{ok:true,value:result.value}:{ok:false,message:projectReadError(result.error.code)};},
 };
}
