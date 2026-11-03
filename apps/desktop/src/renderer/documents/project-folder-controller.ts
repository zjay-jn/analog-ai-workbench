import {PROJECT_FOLDERS_VERSION,parseProjectFolderBindingResult,parseProjectFolderListResult,parseProjectFolderOpenResult,type WorkbenchProjectFoldersApi,type ProjectFolderBinding,type ProjectFolderEntry,type ProjectFolderCode,type ProjectFolderOpenResult} from '../../shared/agent/project-folders';
type Tree={treeId:string;entries:ProjectFolderEntry[];truncated:boolean};
type State={binding:ProjectFolderBinding|null;tree:Tree|null;busy:boolean;error:string;fatal:boolean};
const messages:Record<ProjectFolderCode,string>={INVALID_REQUEST:'文件夹操作格式无效，请重新打开软件核对。',CAPABILITY_DENIED:'文件夹连接已失效，请重新打开软件。',STORAGE_ERROR:'文件夹关联未能确认保存，请重新打开软件核对。',CANCELLED:'',BUSY:'另一个文件夹操作尚未结束。',NOT_BOUND:'项目尚未关联文件夹。',STALE_BINDING:'文件夹关联或列表已更新，请重新加载。',ROOT_CHANGED:'项目目录已移动或替换，请检查原目录位置。',UNSUPPORTED_FILE:'此目录或文件不受支持。',LIMIT:'达到目录或文件大小限制。',IO_ERROR:'无法读取文件夹或文件，请检查后重试。',CONFLICT:'项目状态已变化，请重新打开软件核对。',SELECTION_EXPIRED:'文件夹选择已过期，请重新浏览选择。',CREATION_PENDING:'请先继续完成未完成的项目。'};
export function createProjectFolderController(projectId:string,api:WorkbenchProjectFoldersApi){
 let state:State={binding:null,tree:null,busy:false,error:'',fatal:false},epoch=0,disposed=false;
 const listeners=new Set<()=>void>(),base={contractVersion:PROJECT_FOLDERS_VERSION,projectId};
 const emit=(next:State)=>{if(disposed)return;state=next;for(const listener of listeners)listener();};
 const valid=(token:number)=>!disposed&&token===epoch;
 const begin=(clearTree=false)=>{const token=++epoch;emit({...state,busy:true,error:'',...(clearTree?{tree:null}:{})});return token;};
 const fail=(code:ProjectFolderCode)=>emit({...state,busy:false,error:messages[code],fatal:state.fatal||code==='STORAGE_ERROR'||code==='CAPABILITY_DENIED',...(['STORAGE_ERROR','CAPABILITY_DENIED','STALE_BINDING','ROOT_CHANGED','NOT_BOUND'].includes(code)?{tree:null}:{})});
 async function bindingOperation(){
  if(disposed||state.fatal)return false;
  const token=begin();
  try{const raw=await api.readBinding(base);if(!valid(token))return false;
   const result=parseProjectFolderBindingResult(raw);if(!result.ok){fail(result.error.code);return false;}if(result.projectId!==projectId)throw Error('Wrong project');
   emit({...state,binding:result.binding,tree:null,busy:false,error:''});return true;
  }catch{if(valid(token))fail('IO_ERROR');return false;}
 }
 return {
  snapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  start(){disposed=false;return bindingOperation();},
  async list(){
   const binding=state.binding;if(disposed||state.fatal||!binding)return false;const token=begin(true);
   try{const result=parseProjectFolderListResult(await api.list({...base,bindingId:binding.bindingId}));if(!valid(token))return false;if(!result.ok){fail(result.error.code);return false;}
    if(result.projectId!==projectId||result.bindingId!==binding.bindingId)throw Error('Wrong binding');emit({...state,tree:{treeId:result.treeId,entries:result.entries,truncated:result.truncated},busy:false,error:''});return true;
   }catch{if(valid(token))fail('IO_ERROR');return false;}
  },
  async open(nodeIds:readonly string[]):Promise<Array<Extract<ProjectFolderOpenResult,{ok:true}>>|undefined>{
   const binding=state.binding,tree=state.tree;if(disposed||state.fatal||state.busy||!binding||!tree)return;
   if(!nodeIds.length||nodeIds.length>2||new Set(nodeIds).size!==nodeIds.length||nodeIds.some(id=>!tree.entries.some(entry=>entry.nodeId===id&&entry.kind==='file'))){fail('INVALID_REQUEST');return;}
   const token=begin();const files:Array<Extract<ProjectFolderOpenResult,{ok:true}>>=[];
   try{for(const nodeId of nodeIds){const result=parseProjectFolderOpenResult(await api.open({...base,bindingId:binding.bindingId,treeId:tree.treeId,nodeId}));if(!valid(token))return;if(!result.ok){fail(result.error.code);return;}
     if(result.projectId!==projectId||result.bindingId!==binding.bindingId||result.treeId!==tree.treeId||result.nodeId!==nodeId||result.file.name!==tree.entries.find(entry=>entry.nodeId===nodeId)!.name)throw Error('Wrong file identity');files.push(result);
    }emit({...state,busy:false,error:''});return files;
   }catch{if(valid(token))fail('IO_ERROR');return;}
  },
  dispose(){disposed=true;epoch++;listeners.clear();},
 };
}
export function visibleFolderEntries(entries:readonly ProjectFolderEntry[],expanded:ReadonlySet<string>,query:string):Array<{entry:ProjectFolderEntry;depth:number}>{
 const byId=new Map(entries.map(entry=>[entry.nodeId,entry])),wanted=new Set<string>(),needle=query.trim().toLocaleLowerCase();
 if(needle)for(const entry of entries)if(entry.kind==='file'&&entry.name.toLocaleLowerCase().includes(needle)){wanted.add(entry.nodeId);let parent=entry.parentId;while(parent){wanted.add(parent);parent=byId.get(parent)?.parentId??null;}}
 const rows:Array<{entry:ProjectFolderEntry;depth:number}>=[],children=new Map<string|null,ProjectFolderEntry[]>();
 for(const entry of entries){const group=children.get(entry.parentId)??[];group.push(entry);children.set(entry.parentId,group);}
 const visit=(parentId:string|null,depth:number)=>{for(const entry of children.get(parentId)??[]){if(needle&&!wanted.has(entry.nodeId))continue;rows.push({entry,depth});if(entry.kind==='directory'&&(needle||expanded.has(entry.nodeId)))visit(entry.nodeId,depth+1);}};
 visit(null,0);
 return rows;
}
