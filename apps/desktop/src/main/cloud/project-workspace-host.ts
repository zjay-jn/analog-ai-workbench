import {createHash} from 'node:crypto';
import {WORKSPACE_LIMIT,parseWorkspaceDisk,parseWorkspaceRead,parseWorkspaceSave,emptyWorkspace,newProject,projectForSession,workspaceFailure,type WorkspaceDisk,type WorkspaceResult} from '../../shared/agent/project-workspace';
import {createAtomicJsonStore} from './session-store';
export type WorkspaceStore={load:()=>WorkspaceDisk;save:(value:WorkspaceDisk)=>void};
export type WorkspaceCreationProof={projectId:string;name:string;expectedRevision:number;beforeDigest:string;nextDigest:string};
export const workspaceDigest=(value:WorkspaceDisk)=>createHash('sha256').update(JSON.stringify(parseWorkspaceDisk(value))).digest('hex');
function creationAfterMatches(value:WorkspaceDisk,proof:WorkspaceCreationProof):boolean{
 if(value.revision!==proof.expectedRevision+1||value.activeId!==proof.projectId||JSON.stringify(value.projects.at(-1))!==JSON.stringify(newProject(proof.projectId,proof.name)))return false;
 const projects=value.projects.slice(0,-1);
 // At most eleven previous active IDs; no workspace body is persisted in the journal.
 return projects.some(project=>workspaceDigest({...value,revision:proof.expectedRevision,activeId:project.id,projects})===proof.beforeDigest);
}
export function createWorkspaceStore(root:string,directory:string):WorkspaceStore{return createAtomicJsonStore(root,directory,'workspace.json',parseWorkspaceDisk,WORKSPACE_LIMIT,emptyWorkspace);}
export function createWorkspaceHost(store:WorkspaceStore,activeSessionId?:()=>string|null){
 let state:WorkspaceDisk|undefined,failed=false,revoked=false,creationAttempt:WorkspaceCreationProof|undefined;
 try{state=parseWorkspaceDisk(store.load());}catch{failed=true;}
 const creationSnapshot=(proof?:WorkspaceCreationProof):WorkspaceResult=>{
  if(revoked)return workspaceFailure('CAPABILITY_DENIED');
  if(!state||(failed&&(!proof||!creationAttempt||JSON.stringify(proof)!==JSON.stringify(creationAttempt))))return workspaceFailure('STORAGE_ERROR');
  try{
   const loaded=parseWorkspaceDisk(store.load()),digest=workspaceDigest(loaded);
   if(proof){if((digest!==proof.beforeDigest&&digest!==proof.nextDigest)||(digest===proof.nextDigest&&!creationAfterMatches(loaded,proof))){failed=true;creationAttempt=undefined;return workspaceFailure('CONFLICT');}}
   else if(digest!==workspaceDigest(state)){failed=true;return workspaceFailure('STORAGE_ERROR');}
   // A healthy host never adopts an unrelated external state, even with a journal proof.
   if(!failed&&digest!==workspaceDigest(state)){failed=true;return workspaceFailure('STORAGE_ERROR');}
   state=loaded;failed=false;return {ok:true,value:parseWorkspaceDisk(state)};
  }catch{failed=true;return workspaceFailure('STORAGE_ERROR');}
 };
 return {
  hasProject:(id:string)=>!failed&&!revoked&&!!state?.projects.some(p=>p.id===id),
  projectForSession:(id:string)=>!failed&&!revoked&&state?projectForSession(state,id):null,
  creationSnapshot,
  createProject(proof:WorkspaceCreationProof):WorkspaceResult{
   const snapshot=creationSnapshot(proof);if(!snapshot.ok)return snapshot;
   try{
    const current=snapshot.value,digest=workspaceDigest(current);
    if(digest===proof.nextDigest)return {ok:true,value:current};
    if(digest!==proof.beforeDigest||current.revision!==proof.expectedRevision||current.projects.some(p=>p.id===proof.projectId))return workspaceFailure('CONFLICT');
    const next=parseWorkspaceDisk({...current,revision:current.revision+1,activeId:proof.projectId,projects:[...current.projects,newProject(proof.projectId,proof.name)]});
    if(workspaceDigest(next)!==proof.nextDigest)return workspaceFailure('CONFLICT');
    creationAttempt={...proof};
    try{store.save(next);}catch{failed=true;return workspaceFailure('STORAGE_ERROR');}
    state=next;return {ok:true,value:parseWorkspaceDisk(state)};
   }catch{return workspaceFailure('INVALID_REQUEST');}
  },
  invoke(method:'read'|'save',value:unknown,allowed:boolean):WorkspaceResult{
   if(revoked||!allowed)return workspaceFailure('CAPABILITY_DENIED');
   if(failed||!state)return workspaceFailure('STORAGE_ERROR');
   try{
    if(method==='read'){parseWorkspaceRead(value);return {ok:true,value:parseWorkspaceDisk(state)};}
    const request=parseWorkspaceSave(value);if(request.expectedRevision!==state.revision||request.state.revision!==state.revision)return workspaceFailure('CONFLICT');
    const next=parseWorkspaceDisk({...request.state,revision:state.revision+1});
    const active=activeSessionId?.();if(active&&projectForSession(state,active)!==projectForSession(next,active))return workspaceFailure('CONFLICT');
    creationAttempt=undefined;try{store.save(next);}catch{failed=true;return workspaceFailure('STORAGE_ERROR');}
    state=next;return {ok:true,value:parseWorkspaceDisk(state)};
   }catch{return workspaceFailure('INVALID_REQUEST');}
  },
  revoke(){revoked=true;state=undefined;},
 };
}
