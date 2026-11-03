import { app } from "electron";

import { startDesktopAppV1 } from "./bootstrap";
import { createProductionReviewedArtifactRegistryV1 } from "./schematic/reviewed-artifact-registry";
import { createEmptyAgentBackendV1 } from "./agent/empty-agent-backend";

startDesktopAppV1({
  buildProfile: "production",
  createReviewedRegistry: () => createProductionReviewedArtifactRegistryV1(),
  createAgentBackend: () => createEmptyAgentBackendV1(),
  smokeMode: app.commandLine.hasSwitch("aaw-smoke"),
});
