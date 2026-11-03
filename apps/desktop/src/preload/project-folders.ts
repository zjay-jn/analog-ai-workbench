import {contextBridge,ipcRenderer} from 'electron';
import {PROJECT_FOLDER_METHODS,projectFolderChannel,projectFolderFailure,parseProjectFolderRequest,parseProjectFolderResult,type WorkbenchProjectFoldersApi} from '../shared/agent/project-folders';
const bridge=Object.freeze(Object.fromEntries(PROJECT_FOLDER_METHODS.map(method=>[method,async(value:unknown)=>{
 let request;try{request=parseProjectFolderRequest(method,value);}catch{return projectFolderFailure('INVALID_REQUEST');}
 try{
  const result=parseProjectFolderResult(method,await ipcRenderer.invoke(projectFolderChannel(method),request));
  if(result.ok){
   if('projectId'in request&&(!('projectId'in result)||result.projectId!==request.projectId))return projectFolderFailure('IO_ERROR');
   if(method==='chooseFolder'&&'creationId'in request&&request.creationId!==null&&(!('selection'in result)||result.selection.creationId!==request.creationId))return projectFolderFailure('IO_ERROR');
   if(method==='saveCreation'&&'creationId'in request&&(!('creation'in result)||result.creation?.creationId!==request.creationId))return projectFolderFailure('STORAGE_ERROR');
   if(method==='list'||method==='open'){if(!('bindingId'in result)||!('bindingId'in request)||result.bindingId!==request.bindingId)return projectFolderFailure('IO_ERROR');}
   if(method==='open'&&(!('treeId'in result)||!('treeId'in request)||!('nodeId'in result)||!('nodeId'in request)||result.treeId!==request.treeId||result.nodeId!==request.nodeId))return projectFolderFailure('IO_ERROR');
  }
  return result;
 }catch{return projectFolderFailure(method==='saveCreation'||method==='bindFolder'?'STORAGE_ERROR':'IO_ERROR');}
}])) as WorkbenchProjectFoldersApi);
contextBridge.exposeInMainWorld('workbenchProjectFolders',bridge);
