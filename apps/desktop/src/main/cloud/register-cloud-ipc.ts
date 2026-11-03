import type {DesktopBootstrapOptionsV1} from '../bootstrap';
import {createCloudHostV2,type CloudExecutorV2} from './cloud-host';
import {CLOUD_STATUS_CHANNEL_V2,CLOUD_SUBMIT_CHANNEL_V2,CLOUD_READ_CHANNEL_V2,CLOUD_CANCEL_CHANNEL_V2,cloudFailureV2,parseCloudStatusResultV2,parseCloudSubmitResultV2,parseCloudReadResultV2,parseCloudCancelResultV2,type CloudProviderIdV2} from '../../shared/agent/cloud-chat-api';

export function cloudExtensionV2(options:Readonly<{configured:Readonly<Record<CloudProviderIdV2,boolean>>;execute:CloudExecutorV2;clearCredentials:()=>void;maxOutputTokens?:Readonly<Record<CloudProviderIdV2,number>>}>):NonNullable<DesktopBootstrapOptionsV1['registerExtension']> {
  return context=>{
    const host=createCloudHostV2({owner:context.owner,cloudEnabled:true,configured:options.configured,execute:options.execute,...(options.maxOutputTokens?{maxOutputTokens:options.maxOutputTokens}:{})});
    const bindings=[[CLOUD_STATUS_CHANNEL_V2,host.getStatus,parseCloudStatusResultV2],[CLOUD_SUBMIT_CHANNEL_V2,host.submitTextTurn,parseCloudSubmitResultV2],[CLOUD_READ_CHANNEL_V2,host.readRun,parseCloudReadResultV2],[CLOUD_CANCEL_CHANNEL_V2,host.cancelRun,parseCloudCancelResultV2]] as const;
    for(const [channel,handler,parseResult] of bindings){
      context.ipcMain.removeHandler(channel);
      context.ipcMain.handle(channel,(event:unknown,value:unknown)=>{try{return parseResult(handler(context.deriveCallerContext(event),value));}catch{return cloudFailureV2('INTERNAL');}});
    }
    const revoke=()=>{host.revoke();options.clearCredentials();};
    return Object.freeze({revoke,dispose(){revoke();for(const [channel] of bindings)context.ipcMain.removeHandler(channel);}});
  };
}
