import { createResolveFailureV1 } from "../../../../../packages/agent-adapters/src/public-contract";

export function createEmptyAgentBackendV1() {
  return Object.freeze({
    mode: "production-empty" as const,
    registrySizes: Object.freeze({ agent: 0, rag: 0, toolBroker: 0, fixture: 0 }),
    sourceFrames: Object.freeze([]),
    acceptsStart(_request: unknown): boolean { return false; },
    resolve(_method: "resolveArtifact" | "resolveCitation", _request: unknown) { return createResolveFailureV1("CAPABILITY_DENIED"); },
  });
}
