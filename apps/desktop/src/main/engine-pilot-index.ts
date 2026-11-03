import { app } from 'electron';
import path from 'node:path';
import { startDesktopAppV1 } from './bootstrap';
import { createProductionReviewedArtifactRegistryV1 } from './schematic/reviewed-artifact-registry';
import { createEmptyAgentBackendV1 } from './agent/empty-agent-backend';
import { createPilotStore } from './engine-pilot/store';
import { createFakePilotEngine } from './engine-pilot/fake-engine';
import { pilotExtension } from './engine-pilot/register-ipc';
// This entry is compiled into product/.local/agent-engine-pilot-build/main.
const root=path.resolve(__dirname,'../../..');
app.setName('Analog AI Workbench — Engine Pilot');
app.setPath('userData',path.join(root,'.local','agent-engine-pilot','electron'));
startDesktopAppV1({applicationRoot:path.join(root,'.local','agent-engine-pilot-build'),applicationVersion:'0.1.0-alpha.0',buildProfile:'production',preloadEntry:'engine-pilot.js',createReviewedRegistry:()=>createProductionReviewedArtifactRegistryV1(),createAgentBackend:()=>createEmptyAgentBackendV1(),registerExtension:context=>pilotExtension({store:createPilotStore(root),engine:createFakePilotEngine()})(context)});
