import type { DesktopBootstrapOptionsV1 } from '../bootstrap';
import { PILOT_METHODS, parsePilotResult, pilotChannel, pilotFailure } from '../../shared/agent/engine-pilot';
import { createPilotHost } from './host';
import type { PilotStore } from './store';
import type { PilotEngine } from './engine';
export function pilotExtension(options:Readonly<{store:PilotStore;engine:PilotEngine}>):NonNullable<DesktopBootstrapOptionsV1['registerExtension']> {
  return context=>{
    const host=createPilotHost({owner:context.owner,...options});
    for(const method of PILOT_METHODS){const channel=pilotChannel(method);context.ipcMain.removeHandler(channel);context.ipcMain.handle(channel,async(event:unknown,value:unknown)=>{try{return parsePilotResult(method,await host.invoke(method,context.deriveCallerContext(event),value));}catch{return pilotFailure('INTERNAL');}});}
    return {revoke:()=>host.revoke(),dispose(){host.revoke();for(const method of PILOT_METHODS)context.ipcMain.removeHandler(pilotChannel(method));}};
  };
}
