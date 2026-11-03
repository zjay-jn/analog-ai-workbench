import {sessionExact} from './chat-sessions';
import {fileNameAllowed,validFileText,textBytes,parseFileContext,type FileContext} from './file-context';
import {parseReviewedEdit,EDIT_VERSION} from './reviewed-edit';

export const WORKSPACE_VERSION='workbench.workspace.v1' as const;
export const WORKSPACE_LIMIT=32*1024*1024,PROJECT_LIMIT=8*1024*1024;
export const DEFAULT_PROJECT='00000000-0000-4000-8000-000000000001';
export type ProposalJob={id:string;sessionId:string;document:FileContext;excerpt:FileContext;status:'waiting'|'review'|'accepted'|'rejected'|'saved'|'uncertain';after?:string;error?:string;requestFingerprint?:string};
export type FilePaneState={documents:FileContext[];active:string;start:number;end:number};
export type Project={id:string;name:string;sessionIds:string[];selectedId:string|null;files:FilePaneState;jobs:ProposalJob[]};
export type WorkspaceDisk={version:1;revision:number;activeId:string;projects:Project[];pinnedSessionIds?:string[]};
export type WorkspaceCode='INVALID_REQUEST'|'CAPABILITY_DENIED'|'CONFLICT'|'STORAGE_ERROR';
export type WorkspaceResult={ok:true;value:WorkspaceDisk}|{ok:false;error:{code:WorkspaceCode}};
export type WorkspaceRead={contractVersion:typeof WORKSPACE_VERSION};
export type WorkspaceSave=WorkspaceRead&{expectedRevision:number;state:WorkspaceDisk};
export type WorkbenchWorkspaceApi={read:(request:WorkspaceRead)=>Promise<WorkspaceResult>;save:(request:WorkspaceSave)=>Promise<WorkspaceResult>};
export const workspaceChannel=(method:'read'|'save')=>'workbench.workspace.'+method+'.v1';
function bad():never{throw new TypeError('Invalid workspace');}
function uuid(value:unknown):string{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))bad();return value;}
function integer(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):number{if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>max)bad();return value as number;}
function list<T>(value:unknown,max:number,parse:(v:unknown)=>T):T[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max||Reflect.ownKeys(value).length!==value.length+1)bad();
 return Array.from({length:value.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable)bad();return parse(d.value);});
}
function unique(ids:string[]){if(new Set(ids).size!==ids.length)bad();}
export function emptyFiles():FilePaneState{return {documents:[],active:'',start:1,end:1};}
export function newProject(id:string,name:string):Project{return {id,name,sessionIds:[],selectedId:null,files:emptyFiles(),jobs:[]};}
export function emptyWorkspace():WorkspaceDisk{return {version:1,revision:0,activeId:DEFAULT_PROJECT,projects:[newProject(DEFAULT_PROJECT,'默认项目')]};}
export function parseWorkspaceFile(value:unknown):FileContext{
 const v=sessionExact(value,['id','name','text','startLine','endLine','totalLines']);
 const id=uuid(v.id);if(typeof v.name!=='string'||!fileNameAllowed(v.name)||!validFileText(v.text)||textBytes(v.text)>256*1024)bad();
 const total=integer(v.totalLines,1,10000),start=integer(v.startLine,1,total),end=integer(v.endLine,start,total);
 if(v.text.split('\n').length!==end-start+1)bad();return {id,name:v.name,text:v.text,startLine:start,endLine:end,totalLines:total};
}
export function parseFilePane(value:unknown):FilePaneState{
 const v=sessionExact(value,['documents','active','start','end']),documents=list(v.documents,8,parseWorkspaceFile);unique(documents.map(f=>f.id));
 if(typeof v.active!=='string'||(documents.length?!documents.some(d=>d.id===v.active):v.active!==''))bad();
 const selected=documents.find(d=>d.id===v.active),start=integer(v.start,selected?.startLine??1,selected?.endLine??1),end=integer(v.end,start,selected?.endLine??1);
 return {documents,active:v.active,start,end};
}
function parseJob(value:unknown):ProposalJob{
 const optional=['after','error','requestFingerprint'].filter(key=>value&&typeof value==='object'&&Object.prototype.hasOwnProperty.call(value,key));
 const v=sessionExact(value,['id','sessionId','document','excerpt','status',...optional]),document=parseWorkspaceFile(v.document),excerpt=parseFileContext(v.excerpt);
 if(document.startLine!==1||document.endLine!==document.totalLines||excerpt.name!==document.name||excerpt.totalLines!==document.totalLines||excerpt.text!==document.text.split('\n').slice(excerpt.startLine-1,excerpt.endLine).join('\n'))bad();
 if(!['waiting','review','accepted','rejected','saved','uncertain'].includes(v.status as string))bad();
 if(v.after!==undefined)parseReviewedEdit({contractVersion:EDIT_VERSION,name:document.name,before:document.text,after:v.after});
 if(['review','accepted','saved','uncertain'].includes(v.status as string)&&v.after===undefined)bad();
 if(v.error!==undefined&&(typeof v.error!=='string'||v.error.length>300||!validFileText(v.error)))bad();
 if(optional.includes('requestFingerprint')&&(typeof v.requestFingerprint!=='string'||!/^[0-9a-f]{64}$/u.test(v.requestFingerprint)))bad();
 return {id:uuid(v.id),sessionId:uuid(v.sessionId),document,excerpt,status:v.status as ProposalJob['status'],...(v.after!==undefined?{after:v.after as string}:{}),...(v.error!==undefined?{error:v.error as string}:{}),...(v.requestFingerprint!==undefined?{requestFingerprint:v.requestFingerprint as string}:{})};
}
export function parseWorkspaceDisk(value:unknown):WorkspaceDisk{
 const hasPins=!!value&&typeof value==='object'&&Object.hasOwn(value,'pinnedSessionIds');
 const v=sessionExact(value,['version','revision','activeId','projects',...(hasPins?['pinnedSessionIds']:[])]);if(v.version!==1)bad();
 const pinnedSessionIds=hasPins?list(v.pinnedSessionIds,50,uuid):undefined;if(pinnedSessionIds)unique(pinnedSessionIds);
 const projects=list(v.projects,12,value=>{const p=sessionExact(value,['id','name','sessionIds','selectedId','files','jobs']);
  if(typeof p.name!=='string'||!p.name.trim()||p.name.length>60||!validFileText(p.name)||/[\n\t\u202a-\u202e\u2066-\u2069]/u.test(p.name))bad();
  const sessionIds=list(p.sessionIds,50,uuid);unique(sessionIds);const selectedId=p.selectedId===null?null:uuid(p.selectedId);
  if(selectedId!==null&&!sessionIds.includes(selectedId))bad();
  const project:Project={id:uuid(p.id),name:p.name.trim(),sessionIds,selectedId,files:parseFilePane(p.files),jobs:list(p.jobs,8,parseJob)};unique(project.jobs.map(j=>j.id));
  if(textBytes(JSON.stringify(project))>PROJECT_LIMIT)bad();return project;
 });
 unique(projects.map(p=>p.id));unique(projects.flatMap(p=>p.sessionIds));unique(projects.flatMap(p=>p.jobs.map(j=>j.id)));
 const activeId=uuid(v.activeId);if(!projects.some(p=>p.id===DEFAULT_PROJECT)||!projects.some(p=>p.id===activeId))bad();
 const result:WorkspaceDisk={version:1,revision:integer(v.revision,0,Number.MAX_SAFE_INTEGER-1),activeId,projects,...(pinnedSessionIds?{pinnedSessionIds}:{})};if(textBytes(JSON.stringify(result))>WORKSPACE_LIMIT)bad();return result;
}
export function parseWorkspaceRead(value:unknown):WorkspaceRead{const v=sessionExact(value,['contractVersion']);if(v.contractVersion!==WORKSPACE_VERSION)bad();return {contractVersion:WORKSPACE_VERSION};}
export function parseWorkspaceSave(value:unknown):WorkspaceSave{const v=sessionExact(value,['contractVersion','expectedRevision','state']);if(v.contractVersion!==WORKSPACE_VERSION)bad();return {contractVersion:WORKSPACE_VERSION,expectedRevision:integer(v.expectedRevision,0,Number.MAX_SAFE_INTEGER-2),state:parseWorkspaceDisk(v.state)};}
export function workspaceFailure(code:WorkspaceCode):WorkspaceResult{return {ok:false,error:{code}};}
export function parseWorkspaceResult(value:unknown):WorkspaceResult{
 if(value&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'ok')?.value===true){const v=sessionExact(value,['ok','value']);return {ok:true,value:parseWorkspaceDisk(v.value)};}
 const v=sessionExact(value,['ok','error']),e=sessionExact(v.error,['code']);if(v.ok!==false||!['INVALID_REQUEST','CAPABILITY_DENIED','CONFLICT','STORAGE_ERROR'].includes(e.code as string))bad();return workspaceFailure(e.code as WorkspaceCode);
}
/** Missing membership is always recoverable in the default project; chat remains authoritative. */
export function projectForSession(state:WorkspaceDisk,id:string):string{return state.projects.find(p=>p.sessionIds.includes(id))?.id??DEFAULT_PROJECT;}
