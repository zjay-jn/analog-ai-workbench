import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../apps/desktop/src/renderer/App";
import { ErrorBoundary } from "../apps/desktop/src/renderer/ErrorBoundary";
import type { P3dRuntimeScenarioV1 } from "./phase3-p3d-runtime-contract";
import "../apps/desktop/src/renderer/styles.css";

declare global {
  interface Window {
    readonly __AAW_P3D_SCENARIO__: P3dRuntimeScenarioV1;
  }
}

export function mountP3dRendererV1(scenario: P3dRuntimeScenarioV1): void {
  const exactScenario = Object.freeze({ ...scenario });
  Object.defineProperty(globalThis, "__AAW_P3D_SCENARIO__", {
    value: exactScenario,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "__AAW_P3D_SCENARIO__",
  );
  if (
    descriptor === undefined ||
    descriptor.value !== exactScenario ||
    descriptor.configurable !== false ||
    descriptor.writable !== false
  ) {
    throw new Error("The renderer-owned P3-D scenario binding is unavailable.");
  }
  const rootNode = document.getElementById("root");
  if (rootNode === null) throw new Error("The P3-D renderer root is unavailable.");
  createRoot(rootNode).render(
    <StrictMode>
      <ErrorBoundary>
        <App schematicRequest={exactScenario.request} />
      </ErrorBoundary>
    </StrictMode>,
  );
}
