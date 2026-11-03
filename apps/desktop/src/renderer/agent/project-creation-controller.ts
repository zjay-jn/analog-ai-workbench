import {PROJECT_FOLDERS_VERSION,parseProjectFolderResult,projectCreationName,type WorkbenchProjectFoldersApi} from '../../shared/agent/project-folders';
import type {createWorkspaceController} from './workspace-controller';
type Selection=Extract<Awaited<ReturnType<WorkbenchProjectFoldersApi['chooseFolder']>>,{ok:true}>['selection'];
type Creation=Extract<Awaited<ReturnType<WorkbenchProjectFoldersApi['readCreation']>>,{ok:true}>['creation'];
export type ProjectCreationState={open:boolean;name:string;selection:Selection|null;creation:Creation;busy:boolean;uncertain:boolean;error:string};
export function createProjectCreationController(api:WorkbenchProjectFoldersApi,runExternal:ReturnType<typeof createWorkspaceController>['runExternal'],onComplete:()=>void){
 let state:ProjectCreationState={open:false,name:'新项目',selection:null,creation:null,busy:false,uncertain:false,error:''},started:Promise<void>|undefined,lastSaveCode='';
 const listeners=new Set<()=>void>(),emit=(update:Partial<ProjectCreationState>)=>{state={...state,...update};for(const listener of listeners)listener();};
 const uncertain=()=>emit({busy:false,uncertain:true,open:true,error:'尚未确认创建结果。请点击“核对结果”，确认后继续完成原项目。'});
 async function inspect(initial=false){
  if(state.busy)return;emit({busy:true,error:''});
  const result=await runExternal(async()=>parseProjectFolderResult('readCreation',await api.readCreation({contractVersion:PROJECT_FOLDERS_VERSION})));
  if(!result?.ok){uncertain();return;}
  const creation=result.creation;
  if(creation?.status==='pending'){emit({busy:false,uncertain:false,open:true,creation,selection:null,name:creation.name,error:'项目创建尚未完成，请继续完成。'});return;}
  if(!initial&&state.uncertain&&creation?.status==='complete'&&(state.creation?.creationId??state.selection?.creationId)===creation.creationId){
   emit({busy:false,uncertain:false,open:false,creation:null,selection:null,error:''});onComplete();return;
  }
  const expired=lastSaveCode==='SELECTION_EXPIRED';lastSaveCode='';
  emit({busy:false,uncertain:false,creation:null,...(initial?{open:false}:{}),...(expired?{selection:null}:{}),error:expired?'文件夹选择已过期，请重新浏览后保存。':''});
 }
 return {
  snapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  start(){return started??=(async()=>{await inspect(true);})();},
  async begin(){if(state.busy||state.uncertain||state.creation?.status==='pending')return;emit({open:true,name:'新项目',selection:null,creation:null,error:''});},
  setName(name:string){if(!state.busy&&!state.uncertain&&!state.creation)emit({name});},
  async browse(){
   if(state.busy||state.uncertain)return;emit({busy:true,error:''});
   try{const result=parseProjectFolderResult('chooseFolder',await api.chooseFolder({contractVersion:PROJECT_FOLDERS_VERSION,creationId:state.creation?.creationId??state.selection?.creationId??null}));
    if(!result.ok){emit({busy:false,error:result.error.code==='CANCELLED'?'':'无法选择该文件夹，请检查目录或重新打开软件后核对。'});return;}
    if(state.creation&&(result.selection.creationId!==state.creation.creationId||result.selection.projectId!==state.creation.projectId))throw Error('Wrong creation');
    emit({busy:false,selection:result.selection,error:''});
   }catch{emit({busy:false,error:'文件夹选择结果未收到，请再次浏览选择。'});}
  },
  async cancel(){
   if(state.busy||state.uncertain)return;
   if(state.creation?.status==='pending'){emit({open:false});return;}
   if(!state.selection){emit({open:false});return;}emit({busy:true,error:''});
   try{const result=parseProjectFolderResult('cancelSelection',await api.cancelSelection({contractVersion:PROJECT_FOLDERS_VERSION,ticketId:state.selection.ticketId}));
    if(!result.ok)throw Error('Cancel failed');emit({busy:false,open:false,selection:null,error:''});
   }catch{emit({busy:false,error:'取消选择尚未确认，请重试；此时尚未创建项目。'});}
  },
  inspect:()=>inspect(false),
  async save(){
   if(state.busy||state.uncertain||!state.name.trim()||(!state.selection&&!state.creation))return;
   const creationId=state.creation?.creationId??state.selection!.creationId,projectId=state.creation?.projectId??state.selection!.projectId,name=state.creation?.name??state.name.trim(),ticketId=state.selection?.ticketId??null;
   try{projectCreationName(name);}catch{emit({error:'项目名称无效，请使用1至60个普通文字字符。'});return;}
   lastSaveCode='';emit({busy:true,error:''});
   const result=await runExternal(async expectedRevision=>{
    const response=parseProjectFolderResult('saveCreation',await api.saveCreation({contractVersion:PROJECT_FOLDERS_VERSION,creationId,ticketId,name,expectedRevision}));
    if(!response.ok)lastSaveCode=response.error.code;
    if(response.ok&&(!response.creation||response.creation.creationId!==creationId||response.creation.projectId!==projectId||response.creation.name!==name))throw Error('Wrong creation result');
    return response;
   });
   if(!result?.ok){uncertain();return;}
   if(result.creation?.status==='complete'){emit({busy:false,open:false,creation:null,selection:null,error:''});onComplete();}
   else emit({busy:false,creation:result.creation,selection:null,error:'项目创建尚未完成，请继续完成。'});
  },
 };
}
