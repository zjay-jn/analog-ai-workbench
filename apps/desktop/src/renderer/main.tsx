import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

const rootNode = document.getElementById("root");
if (rootNode === null) {
  throw new Error("The renderer root is unavailable.");
}

createRoot(rootNode).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
