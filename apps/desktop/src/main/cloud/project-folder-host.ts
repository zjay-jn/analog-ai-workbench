import path from 'node:path';import {randomUUID} from 'node:crypto';
import {sessionExact} from '../../shared/agent/chat-sessions';
import {parseWorkspaceDisk,newProject} from '../../shared/agent/project-workspace';
import {PROJECT_FOLDER_LIMITS,folderList,folderUuid,projectCreationName,projectFolderFailure,parseProjectFolderRequest,parseProjectFolderResult,type ProjectFolderMethod,type ProjectFolderRequests,type ProjectFolderResults,type ProjectFolderBinding} from '../../shared/agent/project-folders';
import {createAtomicJsonStore} from './session-store';
import {workspaceDigest,type WorkspaceCreationProof,type createWorkspaceHost} from './project-workspace-host';
import {captureFolderRoot,checkedFolderPath,folderDisplaySegments,scanProjectFolder,openProjectFolderNode,ProjectFolderFsError,type FolderRoot,type FolderNode,type FolderScanLimits} from './project-folder-files';
import type {ProjectReadCode} from '../../shared/agent/agent-project-read';
export type ProjectCreationJournal=WorkspaceCreationProof&{creationId:string;status:'pending'|'complete';folder:FolderRoot};
export type ProjectFolderState={version:2;bindings:FolderRoot[];creation:ProjectCreationJournal|null};
export type ProjectFolderDisk=ProjectFolderState|{version:1;bindings:FolderRoot[]};
export type ProjectFolderStore={load:()=>ProjectFolderDisk;save:(state:ProjectFolderDisk)=>void};
function parseRoot(value:unknown):FolderRoot{
 const r=sessionExact(value,['projectId','bindingId','root','chain']);if(typeof r.root!=='string')throw Error('Invalid root');const root=checkedFolderPath(r.root);
 const chain=folderList(r.chain,128,value=>{const item=sessionExact(value,['dev','ino']);if(typeof item.dev!=='string'||typeof item.ino!=='string'||!/^\d{1,30}$/u.test(item.dev)||!/^\d{1,30}$/u.test(item.ino))throw Error('Invalid identity');return {dev:item.dev,ino:item.ino};});
 if(chain.length!==root.slice(path.parse(root).root.length).split(path.sep).length+1)throw Error('Invalid chain');
 return {projectId:folderUuid(r.projectId),bindingId:folderUuid(r.bindingId),root,chain};
}
export function parseProjectFolderDisk(value:unknown):ProjectFolderState{
 const version=Object.getOwnPropertyDescriptor(value??{},'version')?.value;
 const v=sessionExact(value,version===1?['version','bindings']:['version','bindings','creation']);if(v.version!==1&&v.version!==2)throw Error('Invalid project folder store');
 const bindings=folderList(v.bindings,PROJECT_FOLDER_LIMITS.bindings,parseRoot);
 if(new Set(bindings.map(r=>r.projectId)).size!==bindings.length||new Set(bindings.map(r=>r.bindingId)).size!==bindings.length)throw Error('Duplicate binding');
 let creation:ProjectCreationJournal|null=null;
 if(v.version===2&&v.creation!==null){
  const c=sessionExact(v.creation,['creationId','projectId','name','expectedRevision','beforeDigest','nextDigest','status','folder']);
  if(!Number.isSafeInteger(c.expectedRevision)||(c.expectedRevision as number)<0||(c.expectedRevision as number)>Number.MAX_SAFE_INTEGER-2||!['pending','complete'].includes(c.status as string)||typeof c.beforeDigest!=='string'||typeof c.nextDigest!=='string'||!/^([0-9a-f]{64})$/u.test(c.beforeDigest)||!/^([0-9a-f]{64})$/u.test(c.nextDigest)||c.beforeDigest===c.nextDigest)throw Error('Invalid creation proof');
  const folder=parseRoot(c.folder),projectId=folderUuid(c.projectId);if(folder.projectId!==projectId)throw Error('Creation identity mismatch');
  creation={creationId:folderUuid(c.creationId),projectId,name:projectCreationName(c.name),expectedRevision:c.expectedRevision as number,beforeDigest:c.beforeDigest,nextDigest:c.nextDigest,status:c.status as 'pending'|'complete',folder};
  const binding=bindings.find(r=>r.projectId===projectId);
  if(creation.status==='pending'?(!!binding||bindings.some(r=>r.bindingId===folder.bindingId)):(!binding||JSON.stringify(binding)!==JSON.stringify(folder)))throw Error('Invalid creation binding');
 }
 const result:ProjectFolderState={version:2,bindings,creation};if(Buffer.byteLength(JSON.stringify(result))>PROJECT_FOLDER_LIMITS.diskBytes)throw Error('Folder store limit');return result;
}
export const createProjectFolderStore=(root:string,directory:string):ProjectFolderStore=>createAtomicJsonStore<ProjectFolderDisk>(root,directory,'folders.json',parseProjectFolderDisk,PROJECT_FOLDER_LIMITS.diskBytes,()=>({version:2,bindings:[],creation:null}));
export type ProjectCreationWorkspace=Pick<ReturnType<typeof createWorkspaceHost>,'creationSnapshot'|'createProject'>;
export function createProjectFolderHost(options:{store:ProjectFolderStore;chooseFolder:()=>Promise<string|undefined>;hasProject:(projectId:string)=>boolean;workspace:ProjectCreationWorkspace;limits?:Partial<FolderScanLimits>;now?:()=>number}){
 let state:ProjectFolderState|undefined,attemptedNext:ProjectFolderState|undefined,failed=false,revoked=false,busy=false;
 let ticket:{ticketId:string;creationId:string;projectId:string;folder:FolderRoot;expires:number}|undefined;
 const trees=new Map<string,{treeId:string;bindingId:string;nodes:Map<string,FolderNode>}>();
 const limits:FolderScanLimits={...PROJECT_FOLDER_LIMITS};for(const key of ['nodes','candidates','directories','depth','treeBytes','scanMs'] as const){const value=options.limits?.[key];if(value!==undefined){if(!Number.isSafeInteger(value)||value<1||value>limits[key])throw Error('Invalid test limit');limits[key]=value;}}
 try{state=parseProjectFolderDisk(options.store.load());}catch{failed=true;}
 const now=options.now??Date.now;
 const info=(root:FolderRoot):ProjectFolderBinding=>({projectId:root.projectId,bindingId:root.bindingId,name:path.basename(root.root),segments:folderDisplaySegments(root.root)});
 const proof=(c:ProjectCreationJournal):WorkspaceCreationProof=>({projectId:c.projectId,name:c.name,expectedRevision:c.expectedRevision,beforeDigest:c.beforeDigest,nextDigest:c.nextDigest});
 const presentation=(c:ProjectCreationJournal|null)=>c?{creationId:c.creationId,projectId:c.projectId,name:c.name,status:c.status,binding:info(c.folder)}:null;
 const stop=()=>{failed=true;trees.clear();};
 const commit=(next:ProjectFolderState)=>{try{next=parseProjectFolderDisk(next);attemptedNext=next;options.store.save(next);state=next;attemptedNext=undefined;return true;}catch{stop();return false;}};
 const reload=()=>{if(!state)return false;try{const loaded=parseProjectFolderDisk(options.store.load()),serialized=JSON.stringify(loaded);if(serialized!==JSON.stringify(state)&&(!failed||!attemptedNext||serialized!==JSON.stringify(attemptedNext))){stop();return false;}state=loaded;attemptedNext=undefined;failed=false;return true;}catch{stop();return false;}};
 const verifyRoot=(folder:FolderRoot)=>{const actual=captureFolderRoot(folder.projectId,folder.bindingId,folder.root);if(JSON.stringify(actual)!==JSON.stringify(folder))throw new ProjectFolderFsError('ROOT_CHANGED');};
 return {
  /** Main-only metadata snapshot. Source-root verification is an explicit project-read operation. */
  snapshotBinding(projectId:string):Readonly<{ok:true;value:Readonly<{folder:FolderRoot;name:string}>}>|Readonly<{ok:false;error:Readonly<{code:ProjectReadCode}>}>{
   const fail=(code:ProjectReadCode)=>({ok:false as const,error:{code}});
   try{folderUuid(projectId);}catch{return fail('INVALID_REQUEST');}
   if(revoked)return fail('CAPABILITY_DENIED');if(failed||!state)return fail('STORAGE_FAILED');
   if(state.creation?.status==='pending'&&state.creation.projectId===projectId)return fail('CREATION_PENDING');
   if(!options.hasProject(projectId))return fail('NOT_BOUND');
   const binding=state.bindings.find(row=>row.projectId===projectId);if(!binding)return fail('NOT_BOUND');
   const workspace=options.workspace.creationSnapshot();if(!workspace.ok)return fail(workspace.error.code==='CONFLICT'?'BUSY':'STORAGE_FAILED');
   const project=workspace.value.projects.find(row=>row.id===projectId);if(!project)return fail('NOT_BOUND');
   return {ok:true,value:{name:project.name,folder:{...binding,chain:binding.chain.map(item=>({...item}))}}};
  },
  async invoke<M extends ProjectFolderMethod>(method:M,value:unknown,isCurrent:()=>boolean):Promise<ProjectFolderResults[M]>{
   const fail=(code:Parameters<typeof projectFolderFailure>[0])=>projectFolderFailure(code) as ProjectFolderResults[M],respond=(payload:unknown)=>parseProjectFolderResult(method,payload);
   const allowed=()=>!revoked&&isCurrent();if(!allowed())return fail('CAPABILITY_DENIED');let request;try{request=parseProjectFolderRequest(method,value);}catch{return fail('INVALID_REQUEST');}
   if(busy)return fail('BUSY');
   if(method==='readCreation'){
    if(!reload()||!state)return fail('STORAGE_ERROR');
    const snapshot=options.workspace.creationSnapshot(state.creation?.status==='pending'?proof(state.creation):undefined);if(!snapshot.ok)return fail(snapshot.error.code);
    return respond({ok:true,creation:presentation(state.creation),workspace:snapshot.value});
   }
   if(failed||!state)return fail('STORAGE_ERROR');
   if(method==='bindFolder'){
    const r=request as ProjectFolderRequests['bindFolder'];busy=true;
    try{
     if(!reload()||!state)return fail('STORAGE_ERROR');
     if(state.creation?.status==='pending')return fail('CREATION_PENDING');
     if(state.bindings.some(row=>row.projectId===r.projectId))return fail('CONFLICT');
     const before=options.workspace.creationSnapshot();if(!before.ok)return fail(before.error.code);
     if(!options.hasProject(r.projectId)||!before.value.projects.some(project=>project.id===r.projectId))return fail('CAPABILITY_DENIED');
     if(state.bindings.length>=PROJECT_FOLDER_LIMITS.bindings)return fail('LIMIT');
     const target=await options.chooseFolder();if(!allowed())return fail('CAPABILITY_DENIED');if(!target)return fail('CANCELLED');
     const after=options.workspace.creationSnapshot();if(!after.ok)return fail(after.error.code);
     if(!options.hasProject(r.projectId)||workspaceDigest(before.value)!==workspaceDigest(after.value))return fail('CONFLICT');
     if(!reload()||!state)return fail('STORAGE_ERROR');
     if(state.bindings.some(row=>row.projectId===r.projectId))return fail('CONFLICT');
     const folder=captureFolderRoot(r.projectId,randomUUID(),target);verifyRoot(folder);
     if(!allowed())return fail('CAPABILITY_DENIED');
     if(!commit({...state,bindings:[...state.bindings,folder]}))return fail('STORAGE_ERROR');
     return respond({ok:true,projectId:r.projectId,binding:info(folder)});
    }catch(error){if(error instanceof ProjectFolderFsError)return fail(error.code);return fail('IO_ERROR');}finally{busy=false;}
   }
   if(method==='cancelSelection'){const r=request as ProjectFolderRequests['cancelSelection'];if(!ticket||ticket.ticketId!==r.ticketId)return fail('SELECTION_EXPIRED');ticket=undefined;return respond({ok:true});}
   if(method==='chooseFolder'||method==='saveCreation'){
    busy=true;
    try{
     if(method==='chooseFolder'){
      const r=request as ProjectFolderRequests['chooseFolder'],pending=state.creation?.status==='pending'?state.creation:null;
      if(pending&&r.creationId!==pending.creationId)return fail('CREATION_PENDING');
      if(!pending&&r.creationId!==null&&r.creationId!==ticket?.creationId)return fail('CONFLICT');
      const target=await options.chooseFolder();if(!allowed())return fail('CAPABILITY_DENIED');if(!target)return fail('CANCELLED');
      const current=r.creationId!==null?ticket:undefined,creationId=pending?.creationId??current?.creationId??randomUUID(),projectId=pending?.projectId??current?.projectId??randomUUID(),bindingId=pending?.folder.bindingId??current?.folder.bindingId??randomUUID();
      const folder=captureFolderRoot(projectId,bindingId,target);
      ticket={ticketId:randomUUID(),creationId,projectId,folder,expires:now()+10*60*1000};
      return respond({ok:true,selection:{ticketId:ticket.ticketId,creationId,projectId,binding:info(folder)}});
     }
     const r=request as ProjectFolderRequests['saveCreation'],existing=state.creation;
     if(existing?.status==='pending'&&existing.creationId!==r.creationId)return fail('CREATION_PENDING');
     if(existing?.creationId===r.creationId&&existing.status==='complete'){
      if(r.ticketId!==null||r.name!==existing.name)return fail('CONFLICT');
      const snapshot=options.workspace.creationSnapshot();if(!snapshot.ok)return fail(snapshot.error.code);if(snapshot.value.revision!==r.expectedRevision)return fail('CONFLICT');
      return respond({ok:true,creation:presentation(existing),workspace:snapshot.value});
     }
     const pending=existing?.creationId===r.creationId&&existing.status==='pending'?existing:null;
     if(pending&&pending.name!==r.name)return fail('CONFLICT');
     let folder:FolderRoot;
     if(r.ticketId!==null){if(!ticket||ticket.ticketId!==r.ticketId||ticket.creationId!==r.creationId||ticket.expires<=now())return fail('SELECTION_EXPIRED');folder=ticket.folder;}
     else if(pending)folder=pending.folder;
     else return fail('SELECTION_EXPIRED');
     verifyRoot(folder);
     const snapshot=options.workspace.creationSnapshot(pending?proof(pending):undefined);if(!snapshot.ok)return fail(snapshot.error.code);
     if(snapshot.value.revision!==r.expectedRevision)return fail('CONFLICT');
     let creation:ProjectCreationJournal;
     if(pending)creation={...pending,folder};
     else{
      if(state.bindings.length>=PROJECT_FOLDER_LIMITS.bindings||snapshot.value.projects.length>=12)return fail('LIMIT');
      if(snapshot.value.projects.some(p=>p.id===folder.projectId))return fail('CONFLICT');
      const next=parseWorkspaceDisk({...snapshot.value,revision:snapshot.value.revision+1,activeId:folder.projectId,projects:[...snapshot.value.projects,newProject(folder.projectId,r.name)]});
      creation={creationId:r.creationId,projectId:folder.projectId,name:r.name,status:'pending',folder,expectedRevision:snapshot.value.revision,beforeDigest:workspaceDigest(snapshot.value),nextDigest:workspaceDigest(next)};
     }
     if(!pending||JSON.stringify(pending.folder)!==JSON.stringify(folder)){if(!commit({...state,creation}))return fail('STORAGE_ERROR');}
     ticket=undefined;
     if(!allowed())return fail('CAPABILITY_DENIED');
     const created=options.workspace.createProject(proof(creation));if(!created.ok)return fail(created.error.code);
     verifyRoot(folder);
     if(!allowed())return fail('CAPABILITY_DENIED');
     const complete:ProjectCreationJournal={...creation,status:'complete'};
     if(!commit({...state,bindings:[...state.bindings,folder],creation:complete}))return fail('STORAGE_ERROR');
     return respond({ok:true,creation:presentation(complete),workspace:created.value});
    }catch(error){if(error instanceof ProjectFolderFsError)return fail(error.code);return fail('IO_ERROR');}finally{busy=false;}
   }
   const r=request as ProjectFolderRequests['open'];
   if(!options.hasProject(r.projectId))return fail('CAPABILITY_DENIED');
   if(method==='list')trees.delete(r.projectId);
   const binding=state.bindings.find(row=>row.projectId===r.projectId);
   if(method==='readBinding')return respond({ok:true,projectId:r.projectId,binding:binding?info(binding):null});
   if(!binding)return fail('NOT_BOUND');if(r.bindingId!==binding.bindingId)return fail('STALE_BINDING');
   busy=true;
   try{
    if(method==='list'){const scan=scanProjectFolder(binding,limits,options.now),treeId=randomUUID();if(!allowed()||!options.hasProject(r.projectId))return fail('CAPABILITY_DENIED');const result=respond({ok:true,projectId:r.projectId,bindingId:binding.bindingId,treeId,entries:scan.entries,truncated:scan.truncated});trees.set(r.projectId,{treeId,bindingId:binding.bindingId,nodes:scan.nodes});return result;}
    const tree=trees.get(r.projectId),node=tree?.nodes.get(r.nodeId);if(!tree||tree.treeId!==r.treeId||tree.bindingId!==binding.bindingId||!node)return fail('STALE_BINDING');const opened=openProjectFolderNode(binding,r.nodeId,node);if(!allowed()||!options.hasProject(r.projectId))return fail('CAPABILITY_DENIED');return respond({ok:true,projectId:r.projectId,bindingId:binding.bindingId,treeId:r.treeId,nodeId:r.nodeId,...opened});
   }catch(error){if(error instanceof ProjectFolderFsError){if(error.code==='ROOT_CHANGED')trees.delete(r.projectId);return fail(error.code);}return fail('IO_ERROR');}finally{busy=false;}
  },
  revoke(){revoked=true;ticket=undefined;trees.clear();state=undefined;},
 };
}
