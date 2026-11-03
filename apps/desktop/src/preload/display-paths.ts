import {contextBridge,ipcRenderer} from 'electron';
import {displayPathChannel,parseDisplayPathRead,parseDisplayPathRemember,parseDisplayPathResult,displayPathFailure,type WorkbenchDisplayPathsApi} from '../shared/agent/display-paths';
const api:WorkbenchDisplayPathsApi=Object.freeze({
 read:async value=>{let request;try{request=parseDisplayPathRead(value);}catch{return displayPathFailure('INVALID_REQUEST');}try{return parseDisplayPathResult(await ipcRenderer.invoke(displayPathChannel('read'),request));}catch{return displayPathFailure('STORAGE_ERROR');}},
 remember:async value=>{let request;try{request=parseDisplayPathRemember(value);}catch{return displayPathFailure('INVALID_REQUEST');}try{return parseDisplayPathResult(await ipcRenderer.invoke(displayPathChannel('remember'),request));}catch{return displayPathFailure('STORAGE_ERROR');}},
});
contextBridge.exposeInMainWorld('workbenchDisplayPaths',api);
