import './index';
import {contextBridge,ipcRenderer} from 'electron';
import {CLOUD_STATUS_CHANNEL_V2,CLOUD_SUBMIT_CHANNEL_V2,CLOUD_READ_CHANNEL_V2,CLOUD_CANCEL_CHANNEL_V2,cloudFailureV2,parseCloudStatusRequestV2,parseCloudSubmitRequestV2,parseCloudReadRequestV2,parseCloudCancelRequestV2,parseCloudStatusResultV2,parseCloudSubmitResultV2,parseCloudReadResultV2,parseCloudCancelResultV2,type WorkbenchCloudApiV2,type CloudFailureV2} from '../shared/agent/cloud-chat-api';

async function invoke<T,R>(channel:string,value:unknown,parseRequest:(value:unknown)=>T,parseResult:(value:unknown)=>R):Promise<R|CloudFailureV2> {
  let request:T;try{request=parseRequest(value);}catch{return cloudFailureV2('INVALID_REQUEST');}
  try{return parseResult(await ipcRenderer.invoke(channel,request));}catch{return cloudFailureV2('INTERNAL');}
}
const bridge:WorkbenchCloudApiV2=Object.freeze({
  getStatus:request=>invoke(CLOUD_STATUS_CHANNEL_V2,request,parseCloudStatusRequestV2,parseCloudStatusResultV2),
  submitTextTurn:request=>invoke(CLOUD_SUBMIT_CHANNEL_V2,request,parseCloudSubmitRequestV2,parseCloudSubmitResultV2),
  readRun:async request=>{
    const result=await invoke(CLOUD_READ_CHANNEL_V2,request,parseCloudReadRequestV2,parseCloudReadResultV2);
    if(result.ok&&(result.value.hostRunId!==request.hostRunId||result.value.nextSequence!==request.afterSequence+result.value.events.length))return cloudFailureV2('INTERNAL');
    return result;
  },
  cancelRun:request=>invoke(CLOUD_CANCEL_CHANNEL_V2,request,parseCloudCancelRequestV2,parseCloudCancelResultV2),
});
contextBridge.exposeInMainWorld('workbenchCloud',bridge);
