import { decodeSyntheticSourceFrameV1 } from "../../../../../packages/agent-adapters/src/deterministic-synthetic-adapter";
import { P4B_ZERO_SIDE_EFFECT_COUNTERS_V1 } from "../../../../../packages/agent-adapters/src/deterministic-synthetic-adapter";
import { assertResolveErrorOrderV1, createResolveFailureV1, createResolveSuccessV1, type ResolveArtifactRequestV1, type ResolveCitationRequestV1 } from "../../../../../packages/agent-adapters/src/public-contract";

export function createDevelopmentSyntheticAgentBackendV1(input: Readonly<{
  sourceFrames?: readonly Uint8Array[];
  desktopBoundaryFixture?: Readonly<Record<string, unknown>>;
  negotiatedCapabilities?: readonly string[];
}> = {}) {
  const decodedFrames = Object.freeze((input.sourceFrames ?? []).map((frame) => decodeSyntheticSourceFrameV1(frame)));
  let resolveRegistryQuarantined = false;
  let runtimeCommit: ((event: unknown) => void) | undefined;
  const boundaryBinding = input.desktopBoundaryFixture !== undefined && input.desktopBoundaryFixture.binding !== null && typeof input.desktopBoundaryFixture.binding === "object" ? input.desktopBoundaryFixture.binding as Record<string, unknown> : undefined;
  let diagnostics: Readonly<Record<string, unknown>> = Object.freeze({
    retryability: "never", recoveryAction: "none", warningCodes: Object.freeze([]), canonicalEvents: Object.freeze([]),
    mappingDelta: 0, ledgerDelta: 0, reducerDelta: 0, ackDelta: 0,
    quarantineState: "unchanged", rendererEmissions: 0,
    sideEffectCounters: P4B_ZERO_SIDE_EFFECT_COUNTERS_V1,
    processOrRequestCounters: Object.freeze({ requestCount: 1, successCount: 0, rejectedCount: 1, deliveryCount: 0, registryMutationCount: 0, fileReadCount: 0 }),
  });
  return Object.freeze({
    mode: "development-synthetic" as const,
    registrySizes: Object.freeze({ agent: 1, rag: 0, toolBroker: 0, fixture: decodedFrames.length }),
    sourceFrames: decodedFrames,
    bindRuntimeCommit(commit: (event: unknown) => void): void { runtimeCommit = commit; },
    commitCanonicalEventV1(event: unknown): void {
      if (runtimeCommit === undefined) throw new TypeError("Agent runtime is not registered");
      runtimeCommit(event);
    },
    snapshotDesktopBoundaryDiagnosticsV1() { return diagnostics; },
    acceptsStart(request: unknown): boolean {
      if (request === null || typeof request !== "object") return false;
      const value = request as Record<string, unknown>;
      return value.conversationId === "conversation.synthetic.middle-column" && value.turnId === "turn.synthetic.middle-column.1" && value.adapterProfileId === "profile.synthetic.deterministic" && value.adapterProfileRevision === "rev-1" && Array.isArray(value.inputRefs) && value.inputRefs.length === 1 && value.inputRefs[0] === "input.synthetic.fixed-turn" && Array.isArray(value.contextRefs) && value.contextRefs.length === 1 && value.contextRefs[0] === "context.synthetic.reviewed-schematic";
    },
    resolve(method: "resolveArtifact" | "resolveCitation", request: unknown) {
      if (resolveRegistryQuarantined) return createResolveFailureV1("INTERNAL");
      if (boundaryBinding !== undefined) {
        const artifactRequest = method === "resolveArtifact" ? request as ResolveArtifactRequestV1 : undefined;
        const citationSource = method === "resolveCitation" ? (request as ResolveCitationRequestV1).source : undefined;
        const revision = artifactRequest?.target.revisionId ?? (citationSource?.sourceKind === "rag_source" ? citationSource.sourceRevisionId : citationSource?.revisionId);
        const kindIntegrity = artifactRequest === undefined || (artifactRequest.target.artifactId === boundaryBinding.artifactId && artifactRequest.target.artifactKind === boundaryBinding.artifactKind);
        const failure = assertResolveErrorOrderV1({
          callerAuthorized: boundaryBinding.callerScope === "authorized",
          kindIntegrity,
          revisionAvailable: boundaryBinding.revisionAvailable === true && revision === boundaryBinding.artifactRevisionId,
          sourceLocatorValid: method === "resolveCitation" ? boundaryBinding.sourceLocatorValid !== false : true,
          intentAuthorized: method === "resolveCitation" ? boundaryBinding.intentAuthorized === true : (input.negotiatedCapabilities ?? []).includes("resolve_artifact"),
          resolutionAvailable: boundaryBinding.resolutionAvailable === undefined ? boundaryBinding.revisionAvailable === true : boundaryBinding.resolutionAvailable === true,
        });
        const passed = failure === null;
        const registryMutationCount = !kindIntegrity ? 1 : 0;
        diagnostics = Object.freeze({ ...diagnostics, quarantineState: registryMutationCount === 1 ? "active" : "unchanged", processOrRequestCounters: Object.freeze({ requestCount: 1, successCount: passed ? 1 : 0, rejectedCount: passed ? 0 : 1, deliveryCount: passed ? 1 : 0, registryMutationCount, fileReadCount: 0 }) });
        if (failure !== null) { if (!kindIntegrity) resolveRegistryQuarantined = true; return failure; }
        return createResolveSuccessV1(boundaryBinding.revisionFreshness === "historical" ? "historical" : "current", (request as ResolveArtifactRequestV1 | ResolveCitationRequestV1).intent);
      }
      if (method === "resolveArtifact") {
        const value = request as ResolveArtifactRequestV1;
        if (value.target.artifactId !== "synthetic.circuit-ir.flat-basic") return createResolveFailureV1("CAPABILITY_DENIED");
        if (value.target.artifactKind !== "circuit_ir_reviewed") { resolveRegistryQuarantined = true; return createResolveFailureV1("INTERNAL"); }
        if (value.target.revisionId !== "rev-1") return createResolveFailureV1("REVISION_UNAVAILABLE");
        return createResolveSuccessV1("current", value.intent);
      }
      const value = request as ResolveCitationRequestV1;
      if (value.source.sourceKind === "artifact" && value.source.artifactId === "synthetic.circuit-ir.flat-basic") { resolveRegistryQuarantined = true; return createResolveFailureV1("INTERNAL"); }
      if (value.source.sourceKind !== "reviewed_schematic" || value.source.artifactId !== "synthetic.circuit-ir.flat-basic") return createResolveFailureV1("CAPABILITY_DENIED");
      if (value.source.revisionId !== "rev-1") return createResolveFailureV1("REVISION_UNAVAILABLE");
      return createResolveSuccessV1("current", value.intent);
    },
  });
}

export type DesktopAgentBackendV1 = ReturnType<typeof createDevelopmentSyntheticAgentBackendV1>;
