import {contextBridge,ipcRenderer} from 'electron';
import {CLOUD_SCHEMATIC_CHANNEL,parseCloudSchematicRequest,parseCloudSchematicResult,cloudSchematicFailure,type WorkbenchSchematicApi} from '../shared/schematic/cloud-schematic';
const schematic:WorkbenchSchematicApi=Object.freeze({openSynthetic:async value=>{
  let request;try{request=parseCloudSchematicRequest(value);}catch{return cloudSchematicFailure('INVALID_REQUEST');}
  try{return parseCloudSchematicResult(await ipcRenderer.invoke(CLOUD_SCHEMATIC_CHANNEL,request),request.projectId);}catch{return cloudSchematicFailure('INTERNAL');}
}});
contextBridge.exposeInMainWorld('workbenchSchematic',schematic);
