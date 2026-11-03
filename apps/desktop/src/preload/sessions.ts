import './schematic';
import './engine-pilot';
import './agent-project-read';
import './reviewed-schematic';
import './display-paths';
import './project-folders';
import './index';import {contextBridge,ipcRenderer} from 'electron';
import {SESSION_METHODS,sessionChannel,parseSessionRequest,parseSessionMethodResult,sessionFailure,type WorkbenchSessionsApi} from '../shared/agent/chat-sessions';
import {parseSettingsRead,parseSettingsSave,parseSettingsResult,settingsChannel,type WorkbenchSettingsApi} from '../shared/agent/model-settings';
import {EDIT_CHANNEL,parseReviewedEdit,parseEditSaveResult,type WorkbenchEditsApi} from '../shared/agent/reviewed-edit';
import {workspaceChannel,parseWorkspaceRead,parseWorkspaceSave,parseWorkspaceResult,workspaceFailure,type WorkbenchWorkspaceApi} from '../shared/agent/project-workspace';
import {draftChannel,parseDraftRead,parseDraftSave,parseDraftReadResult,parseDraftSaveResult,draftFailure,type WorkbenchDraftsApi} from '../shared/agent/chat-drafts';
import {EXPORT_CHANNEL,parseChatExport,parseChatExportResult,type WorkbenchChatExportApi} from '../shared/agent/chat-export';
const bridge=Object.freeze(Object.fromEntries(SESSION_METHODS.map(method=>[method,async(value:unknown)=>{
 let request;try{request=parseSessionRequest(method,value);}catch{return sessionFailure('INVALID_REQUEST');}
 try{return parseSessionMethodResult(method,await ipcRenderer.invoke(sessionChannel(method),request));}catch{return sessionFailure('INTERNAL');}
}])) as WorkbenchSessionsApi);
contextBridge.exposeInMainWorld('workbenchSessions',bridge);
const settings:WorkbenchSettingsApi=Object.freeze({
 readSettings:async value=>{try{return parseSettingsResult(await ipcRenderer.invoke(settingsChannel('readSettings'),parseSettingsRead(value)));}catch{return {ok:false,error:{code:'INVALID_REQUEST'}};}},
 saveSettings:async value=>{try{return parseSettingsResult(await ipcRenderer.invoke(settingsChannel('saveSettings'),parseSettingsSave(value)));}catch{return {ok:false,error:{code:'INVALID_REQUEST'}};}},
});
contextBridge.exposeInMainWorld('workbenchModelSettings',settings);
const edits:WorkbenchEditsApi=Object.freeze({saveReviewedEdit:async value=>{let request;try{request=parseReviewedEdit(value);}catch{return {ok:false,error:{code:'INVALID_REQUEST'}};}try{return parseEditSaveResult(await ipcRenderer.invoke(EDIT_CHANNEL,request));}catch{return {ok:false,error:{code:'VERIFY_FAILED'}};}}});
contextBridge.exposeInMainWorld('workbenchEdits',edits);
const workspace:WorkbenchWorkspaceApi=Object.freeze({
 read:async value=>{try{return parseWorkspaceResult(await ipcRenderer.invoke(workspaceChannel('read'),parseWorkspaceRead(value)));}catch{return workspaceFailure('STORAGE_ERROR');}},
 save:async value=>{let request;try{request=parseWorkspaceSave(value);}catch{return workspaceFailure('INVALID_REQUEST');}try{return parseWorkspaceResult(await ipcRenderer.invoke(workspaceChannel('save'),request));}catch{return workspaceFailure('STORAGE_ERROR');}},
});
contextBridge.exposeInMainWorld('workbenchWorkspace',workspace);
const drafts:WorkbenchDraftsApi=Object.freeze({read:async value=>{try{return parseDraftReadResult(await ipcRenderer.invoke(draftChannel('read'),parseDraftRead(value)));}catch{return draftFailure('STORAGE_ERROR');}},save:async value=>{let request;try{request=parseDraftSave(value);}catch{return draftFailure('INVALID_REQUEST');}try{return parseDraftSaveResult(await ipcRenderer.invoke(draftChannel('save'),request));}catch{return draftFailure('STORAGE_ERROR');}}});
contextBridge.exposeInMainWorld('workbenchDrafts',drafts);
const exporter:WorkbenchChatExportApi=Object.freeze({save:async value=>{let request;try{request=parseChatExport(value);}catch{return {ok:false,error:{code:'INVALID_REQUEST'}};}try{return parseChatExportResult(await ipcRenderer.invoke(EXPORT_CHANNEL,request));}catch{return {ok:false,error:{code:'VERIFY_FAILED'}};}}});
contextBridge.exposeInMainWorld('workbenchChatExport',exporter);
