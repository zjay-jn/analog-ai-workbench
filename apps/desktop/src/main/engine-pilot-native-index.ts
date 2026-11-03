import { app } from 'electron';
import path from 'node:path';
import { startDesktopAppV1 } from './bootstrap';
import { createProductionReviewedArtifactRegistryV1 } from './schematic/reviewed-artifact-registry';
import { createEmptyAgentBackendV1 } from './agent/empty-agent-backend';
import { createPilotStore } from './engine-pilot/store';
import { pilotExtension } from './engine-pilot/register-ipc';
import { createPilotLoopbackServices, type PilotLoopbackServices } from './engine-pilot/loopback-services';
import { createOpenCodePilotClient, createUnreadyOpenCodePilotEngine } from './engine-pilot/opencode-client';
import { createOpenCodePilotEngine } from './engine-pilot/opencode-engine';
import { startOpenCodeSupervisor, type OpenCodeSupervisor } from './engine-pilot/opencode-supervisor';
import type { PilotEngine } from './engine-pilot/engine';

// Separate QA-admitted native entry, compiled beside the fake index.cjs. No environment switch.
const root=path.resolve(__dirname,'../../..');
app.setName('Analog AI Workbench — Native Engine Pilot');
app.setPath('userData',path.join(root,'.local','agent-engine-pilot','electron-native'));
let engine:PilotEngine=createUnreadyOpenCodePilotEngine(),supervisor:OpenCodeSupervisor|undefined,services:PilotLoopbackServices|undefined;
let quitting=false,cleanupComplete=false;
let startup:Promise<void>;
async function cleanup(){
  await startup.catch(()=>{});engine.dispose();await services?.close();
  const result=await supervisor?.stop();if(result&&!result.exited)console.error('Native pilot exit unconfirmed');
}
app.on('before-quit',event=>{
  if(cleanupComplete)return;event.preventDefault();if(quitting)return;quitting=true;
  void cleanup().finally(()=>{cleanupComplete=true;app.quit();});
});
async function start(){
  services=await createPilotLoopbackServices();
  try{
    supervisor=await startOpenCodeSupervisor({services:{port:services.port,providerToken:services.providerToken,toolToken:services.toolToken}});
    if(quitting){await supervisor.stop();await services.close();return;}
    const client=createOpenCodePilotClient({port:supervisor.port,password:supervisor.password,directory:supervisor.directory});
    engine=createOpenCodePilotEngine({client,services});
  }catch{await services.close();if(quitting)return;}
  startDesktopAppV1({applicationRoot:path.join(root,'.local','agent-engine-pilot-build'),applicationVersion:'0.1.0-alpha.0',buildProfile:'production',preloadEntry:'engine-pilot.js',createReviewedRegistry:()=>createProductionReviewedArtifactRegistryV1(),createAgentBackend:()=>createEmptyAgentBackendV1(),registerExtension:context=>pilotExtension({store:createPilotStore(root),engine})(context)});
}
startup=start();void startup.catch(()=>app.quit());
