import type {SchematicContext} from '../../shared/schematic/reviewed-schematic';
import type {UnifiedChatService} from './unified-chat-service';
import type {DesktopBootstrapOptionsV1} from '../bootstrap';import type {CloudExecutorV2} from './cloud-host';
import {createSessionHost} from './session-host';import {createSessionStore,type SessionStore} from './session-store';
import {draftExtension} from './register-drafts';
import {createChatExportHost} from './chat-export';import {EXPORT_CHANNEL} from '../../shared/agent/chat-export';
import {SESSION_METHODS,sessionChannel,sessionFailure,parseSessionMethodResult,type SessionState} from '../../shared/agent/chat-sessions';
import {parseSettingsRead,parseSettingsSave,parseSettingsResult,settingsChannel} from '../../shared/agent/model-settings';import {createAgentCallerFenceV1} from '../agent/agent-caller-fence';import type {ModelSettingsHost} from './model-settings-host';import type {MultimodalExecutor} from './multimodal-context';import type {ImageAttachment} from '../../shared/agent/image-attachment';
export function sessionExtension(options:{root:string;directory:string;draftDirectory?:string;chooseExportFile?:(name:string)=>Promise<string|undefined>;configured:SessionState['configured'];execute:CloudExecutorV2;clearCredentials:()=>void;store?:SessionStore;settingsFactory?:()=>ModelSettingsHost;executeMultimodal?:MultimodalExecutor;validateImages?:(images:ImageAttachment[])=>void;validateSchematicContexts?:(sessionId:string,contexts:readonly SchematicContext[])=>void;turns?:UnifiedChatService}){
 return (context:Parameters<NonNullable<DesktopBootstrapOptionsV1['registerExtension']>>[0])=>{
  const settings=options.settingsFactory?.(),fence=createAgentCallerFenceV1({caller:context.owner,capabilities:['start_turn'],generation:1});let revoked=false;
  const host=createSessionHost({...options.validateSchematicContexts?{validateSchematicContexts:options.validateSchematicContexts}:{},owner:context.owner,store:options.store??createSessionStore(options.root,options.directory),configured:settings?()=>settings.configured():options.configured,execute:options.execute,...(settings?{defaultModel:settings.defaultModel,replyLimits:settings.replyLimits}:{}),...(options.executeMultimodal?{executeMultimodal:options.executeMultimodal}:{}),...(options.validateImages?{validateImages:options.validateImages}:{}),...(options.turns?{turns:options.turns}:{})});
  for(const method of SESSION_METHODS){const channel=sessionChannel(method);context.ipcMain.removeHandler(channel);context.ipcMain.handle(channel,(event:unknown,value:unknown)=>{try{return parseSessionMethodResult(method,host.invoke(context.deriveCallerContext(event),method,value));}catch{return sessionFailure('INTERNAL');}});}
  if(settings)for(const method of ['readSettings','saveSettings'] as const){const channel=settingsChannel(method);context.ipcMain.removeHandler(channel);context.ipcMain.handle(channel,(event:unknown,value:unknown)=>{
   if(revoked||!fence.authorizeInvocation({caller:context.deriveCallerContext(event),operation:'startTurn'}).allowed)return {ok:false,error:{code:'CAPABILITY_DENIED'}};
   try{if(method==='readSettings'){parseSettingsRead(value);return parseSettingsResult(settings.read());}const request=parseSettingsSave(value);if(host.isRunning())return {ok:false,error:{code:'BUSY'}};const result=settings.save(request);host.settingsChanged();return parseSettingsResult(result);}catch{return {ok:false,error:{code:'INVALID_REQUEST'}};}
  });}
  const drafts=options.draftDirectory?draftExtension({root:options.root,directory:options.draftDirectory,...(options.validateImages?{validateImages:options.validateImages}:{})})(context):undefined;
  const exporter=options.chooseExportFile?createChatExportHost(host.getSession,options.chooseExportFile):undefined;
  if(exporter){context.ipcMain.removeHandler(EXPORT_CHANNEL);context.ipcMain.handle(EXPORT_CHANNEL,(event:unknown,value:unknown)=>exporter.save(value,()=>{try{return !revoked&&fence.authorizeInvocation({caller:context.deriveCallerContext(event),operation:'startTurn'}).allowed;}catch{return false;}}));}
  const revoke=()=>{revoked=true;host.revoke();drafts?.revoke();exporter?.revoke();settings?.dispose();options.clearCredentials();};return {host,revoke,dispose(){revoke();drafts?.dispose();if(exporter)context.ipcMain.removeHandler(EXPORT_CHANNEL);for(const method of SESSION_METHODS)context.ipcMain.removeHandler(sessionChannel(method));if(settings)for(const method of ['readSettings','saveSettings'] as const)context.ipcMain.removeHandler(settingsChannel(method));}};
 };
}
