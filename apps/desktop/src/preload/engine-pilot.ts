import './index';
import { contextBridge, ipcRenderer } from 'electron';
import { PILOT_METHODS, parsePilotRequest, parsePilotResult, pilotChannel, pilotFailure, type EnginePilotApi, type PilotMethod } from '../shared/agent/engine-pilot';
const entries=PILOT_METHODS.map(method=>[method,async(value:unknown)=>{
  let request;try{request=parsePilotRequest(method,value);}catch{return pilotFailure('INVALID_REQUEST');}
  try{
    const result=parsePilotResult(method,await ipcRenderer.invoke(pilotChannel(method),request));
    if(method==='readRun'&&result.ok){const input=parsePilotRequest('readRun',request),output=parsePilotResult('readRun',result);if(output.ok&&(output.value.runId!==input.runId||output.value.nextSequence!==input.afterSequence+output.value.events.length))return pilotFailure('INTERNAL');}
    return result;
  }catch{return pilotFailure('INTERNAL');}
}] as const);
contextBridge.exposeInMainWorld('workbenchEnginePilot',Object.freeze(Object.fromEntries(entries)) as Record<PilotMethod,EnginePilotApi[PilotMethod]>);
