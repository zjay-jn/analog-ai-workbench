import {PROJECT_FOLDERS_VERSION,parseProjectFolderBindingResult,type WorkbenchProjectFoldersApi} from '../../shared/agent/project-folders';

export type ChatProjectBindingState={projectId:string;busy:boolean;notice:string};
/** This operation only associates a directory. It never moves a chat or retries a turn. */
export function createChatProjectBindingController(api:Pick<WorkbenchProjectFoldersApi,'bindFolder'>|undefined,onRefresh:()=>void){
 let state:ChatProjectBindingState={projectId:'',busy:false,notice:''};
 const listeners=new Set<()=>void>(),emit=(next:ChatProjectBindingState)=>{state=next;for(const listener of listeners)listener();};
 return {
  snapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  async bind(projectId:string){
   if(state.busy||!api)return;emit({projectId,busy:true,notice:''});
   try{
    const result=parseProjectFolderBindingResult(await api.bindFolder({contractVersion:PROJECT_FOLDERS_VERSION,projectId}));
    if(result.ok){
     if(result.projectId!==projectId||!result.binding)throw Error('Unconfirmed directory owner');
     emit({projectId,busy:false,notice:'目录已关联，请点击“配置后继续”发送原问题。'});onRefresh();
    }else{
     const notice=result.error.code==='CANCELLED'?'':result.error.code==='CONFLICT'?'项目关联已变化，请重新核对目录。':result.error.code==='UNSUPPORTED_FILE'?'所选目录不可用，请选择支持的本地文件夹。':result.error.code==='CREATION_PENDING'?'请先完成未完成的项目创建。':'目录关联未能确认，请重新核对目录后再试。';
     emit({projectId,busy:false,notice});if(result.error.code!=='CANCELLED')onRefresh();
    }
   }catch{emit({projectId,busy:false,notice:'目录关联结果尚未确认，正在重新核对；原问题和草稿已保留。'});onRefresh();}
  },
 };
}
