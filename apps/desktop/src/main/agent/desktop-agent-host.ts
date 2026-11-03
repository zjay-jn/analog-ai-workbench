import { P4B_ZERO_SIDE_EFFECT_COUNTERS_V1 } from "../../../../../packages/agent-adapters/src/deterministic-synthetic-adapter";
import { calculateP4bLedgerIntegrityV1 } from "../../../../../packages/agent-adapters/src/agent-ledger-contract";
import { createRestartableAgentLedgerV1, type RestartableAgentLedgerV1 } from "../../../../../packages/agent-adapters/src/agent-ledger-contract";
import { canonicalizeAawJsonV1, sha256CanonicalAawJsonV1 } from "../../../../../packages/schematic-workbench/src/canonical-json";
import { parseCanonicalEventV1, type CanonicalEventV1 } from "../../../../../packages/agent-adapters/src/canonical-contract";
import type { DecodedAgentSourceFrameV1 } from "../../../../../packages/agent-adapters/src/agent-contract";
import {
  assertResolveErrorOrderV1,
  createResolveSuccessV1,
  parseResolveArtifactRequestV1,
  parseResolveCitationRequestV1,
  type ResolveArtifactRequestV1,
  type ResolveCitationRequestV1,
} from "../../../../../packages/agent-adapters/src/public-contract";
import {
  parseAgentDesktopRequestV1,
  createAgentSafeFailureV1,
  type CancelRunRequestV1,
  type AgentDesktopMethodV1,
  type StartTurnRequestV1,
} from "../../shared/agent/desktop-agent-api";

type JsonRecord = Readonly<Record<string, unknown>>;
export type DesktopAgentBackendV1 = Readonly<{
  mode: "production-empty" | "development-synthetic";
  registrySizes: Readonly<{ agent: number; rag: number; toolBroker: number; fixture: number }>;
  sourceFrames: readonly DecodedAgentSourceFrameV1[];
  bindRuntimeCommit?: (commit: (event: unknown) => void) => void;
  snapshotDesktopBoundaryDiagnosticsV1?: () => Readonly<Record<string, unknown>>;
  acceptsStart(request: unknown): boolean;
  resolve(method: "resolveArtifact" | "resolveCitation", request: unknown): unknown;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function frozenNullPrototypeRecord(
  value: Readonly<Record<string, unknown>>,
  label: string,
): Readonly<Record<string, unknown>> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const clone: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    Object.defineProperty(clone, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(clone);
}

type RunOwnerV1 = AgentCallerContextV1;
type RuntimeRunV1 = {
  owner: RunOwnerV1;
  ledger: RestartableAgentLedgerV1;
  quarantined: boolean;
  cancelRequested: boolean;
  listeners: Set<(event: CanonicalEventV1) => void>;
};

import type { AgentCallerContextV1 } from "./agent-caller-fence";

function sameOwner(left: RunOwnerV1, right: RunOwnerV1): boolean {
  return left.senderId === right.senderId && left.isTopFrame === right.isTopFrame &&
    left.appOrigin === right.appOrigin && left.navigationEpoch === right.navigationEpoch &&
    left.appSessionId === right.appSessionId && left.windowId === right.windowId &&
    left.webContentsId === right.webContentsId && left.workspaceId === right.workspaceId &&
    left.rootId === right.rootId;
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && /^(?!latest$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function projectedEvent(event: CanonicalEventV1): JsonRecord {
  return Object.freeze({
    hostRunId: event.hostRunId, eventId: event.eventId,
    hostSequence: event.hostSequence, acceptedAt: event.acceptedAt,
    type: event.type, canonicalPayloadDigest: event.canonicalPayloadDigest,
    canonicalUtf8Hex: Buffer.from(canonicalizeAawJsonV1(event), "utf8").toString("hex"),
  });
}

function makeCanonical(hostRunId: string, sequence: number, type: CanonicalEventV1["type"], payload: unknown): CanonicalEventV1 {
  return parseCanonicalEventV1({
    hostRunId,
    eventId: `${hostRunId.replace(/^host\./u, "event.")}.${sequence}`,
    hostSequence: sequence,
    acceptedAt: `2026-09-02T00:00:${String(sequence).padStart(2, "0")}Z`,
    canonicalPayloadDigest: sha256CanonicalAawJsonV1(payload),
    type,
    payload,
  });
}

function sourceCanonical(decoded: DecodedAgentSourceFrameV1, hostRunId: string, sequence: number): CanonicalEventV1 | null {
  const source = decoded.event;
  if (source.type === "message.delta") return makeCanonical(hostRunId, sequence, "message.delta", source.payload);
  if (source.type === "run.completed") return makeCanonical(hostRunId, sequence, "run.completed", source.payload);
  if (source.type === "cancel.acknowledged") return makeCanonical(hostRunId, sequence, "run.cancelled", { reason: "cancelled" });
  if (source.type === "run.failed") return makeCanonical(hostRunId, sequence, "run.failed", { errorCode: "ADAPTER_UNAVAILABLE", retryability: "never", recoveryAction: "none" });
  if (source.type === "citation.declared") return makeCanonical(hostRunId, sequence, "citation.declared", { ...source.payload, authorityStatus: "non_authoritative", verificationStatus: "unverified" });
  return null;
}

export function createDesktopAgentHostV1(input: Readonly<{
  backend: DesktopAgentBackendV1;
  createHostRunId: () => string;
  runSeeds?: readonly Readonly<{ hostRunId: string; owner: AgentCallerContextV1; events: readonly unknown[]; retentionFloor: number; terminal?: boolean; quarantined?: boolean }>[];
}>) {
  const backend = input.backend;
  const runs = new Map<string, RuntimeRunV1>();

  function commit(run: RuntimeRunV1, event: CanonicalEventV1, decoded?: DecodedAgentSourceFrameV1): void {
    const row = projectedEvent(event);
    const checkpoint = Object.freeze({ hostRunId: event.hostRunId, eventId: event.eventId, hostSequence: event.hostSequence, resumeEpoch: 1 });
    const mapping = decoded === undefined && event.type === "run.accepted" ? undefined : Object.freeze({
      sourceRunId: decoded?.event.sourceRunId ?? `source.${event.hostRunId}`,
      sourceEventId: decoded?.event.sourceEventId ?? `source.${event.eventId}`,
      sourceSequence: decoded?.event.sourceSequence ?? event.hostSequence,
      eventType: decoded?.event.type ?? (event.type === "run.cancelled" ? "cancel.acknowledged" : event.type),
      sourcePayloadDigest: decoded?.recomputedSourcePayloadDigest ?? event.canonicalPayloadDigest,
      eventId: event.eventId,
      hostSequence: event.hostSequence,
    });
    const terminal = event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";
    run.ledger.commitAtomically(mapping, row, checkpoint, { hostSequence: event.hostSequence, committedHead: event.hostSequence, ...(terminal ? { terminal: true, lifecycle: "terminal" } : {}) });
    run.ledger.persistAck(checkpoint);
    if (calculateP4bLedgerIntegrityV1(run.ledger.snapshot()) !== "valid") {
      run.quarantined = true;
      throw new TypeError("Committed Agent ledger failed integrity validation");
    }
    for (const listener of run.listeners) {
      try {
        listener(event);
      } catch {
        run.listeners.delete(listener);
      }
    }
  }

  for (const seed of input.runSeeds ?? []) {
    if (!isIdentity(seed.hostRunId) || runs.has(seed.hostRunId) || !Number.isSafeInteger(seed.retentionFloor) || seed.retentionFloor < 0) throw new TypeError("Agent run seed is invalid");
    const ledgerSeed: JsonRecord = {
      binding: { resumeEpoch: 1, sourceRunId: `source.${seed.hostRunId}` },
      run: { hostRunId: seed.hostRunId, hostSequence: 0, committedHead: 0, terminal: false, quarantined: false, lifecycle: "running", ledgerIntegrity: "valid", retentionFloor: seed.retentionFloor },
      mappings: [], ledger: [], checkpoints: [], acks: [],
    };
    const run: RuntimeRunV1 = { owner: Object.freeze({ ...seed.owner }), ledger: createRestartableAgentLedgerV1(ledgerSeed), quarantined: false, cancelRequested: false, listeners: new Set() };
    runs.set(seed.hostRunId, run);
    const parsedEvents = seed.events.map((value) => parseCanonicalEventV1(value));
    const firstSequence = parsedEvents[0]?.hostSequence ?? 1;
    for (let sequence = 1; sequence < firstSequence; sequence += 1) {
      commit(run, makeCanonical(seed.hostRunId, sequence, "message.delta", { text: `retained-history-${sequence}` }));
    }
    for (const event of parsedEvents) commit(run, event);
    const seededState = record(run.ledger.snapshot().run, "seeded run state");
    if (seed.terminal !== undefined && seed.terminal !== (seededState.terminal === true)) throw new TypeError("Agent run terminal seed is inconsistent");
    run.quarantined = seed.quarantined === true;
  }

  const commitCanonicalEventV1 = (value: unknown): void => {
    const event = parseCanonicalEventV1(value);
    const run = runs.get(event.hostRunId);
    if (run === undefined || run.quarantined) throw new TypeError("Agent run is unavailable");
    const state = record(run.ledger.snapshot().run, "run state");
    if (state.terminal === true || event.hostSequence !== (state.hostSequence as number) + 1) throw new TypeError("Agent live commit sequence is invalid");
    commit(run, event);
  };
  backend.bindRuntimeCommit?.(commitCanonicalEventV1);

  return Object.freeze({
    registrySizes: backend.registrySizes,
    invoke(method: AgentDesktopMethodV1, request: unknown, caller: RunOwnerV1) {
      const boundary = parseAgentDesktopRequestV1(request, method);
      const parsed = method === "resolveArtifact"
        ? parseResolveArtifactRequestV1(boundary)
        : method === "resolveCitation"
          ? parseResolveCitationRequestV1(boundary)
          : boundary;
      if (method === "startTurn") {
        if (!backend.acceptsStart(parsed)) {
          return backend.mode === "production-empty"
            ? createAgentSafeFailureV1("NOT_CONFIGURED", "never", "reconfigure")
            : createAgentSafeFailureV1("CAPABILITY_DENIED");
        }
        const hostRunId = `host.${input.createHostRunId()}`;
        if (!isIdentity(hostRunId) || runs.has(hostRunId)) return createAgentSafeFailureV1("INTERNAL");
        const seed: JsonRecord = {
          binding: { resumeEpoch: 1, sourceRunId: "synthetic.run.accepted-text" },
          run: { hostRunId, hostSequence: 0, committedHead: 0, terminal: false, quarantined: false, lifecycle: "running", ledgerIntegrity: "valid" },
          mappings: [], ledger: [], checkpoints: [], acks: [],
        };
        const run: RuntimeRunV1 = { owner: Object.freeze({ ...caller }), ledger: createRestartableAgentLedgerV1(seed), quarantined: false, cancelRequested: false, listeners: new Set() };
        const start = parsed as StartTurnRequestV1;
        commit(run, makeCanonical(hostRunId, 1, "run.accepted", { conversationId: start.conversationId, turnId: start.turnId, adapterProfileId: start.adapterProfileId, adapterProfileRevision: start.adapterProfileRevision }));
        const message = backend.sourceFrames.find((frame) => frame.event.type === "message.delta" && frame.event.sourceRunId === "synthetic.run.accepted-text");
        if (message !== undefined) {
          const event = sourceCanonical(message, hostRunId, 2);
          if (event !== null) commit(run, event, message);
        }
        runs.set(hostRunId, run);
        return Object.freeze({ ok: true as const, value: Object.freeze({ hostRunId }) });
      }
      if (method === "cancelRun") {
        const hostRunId = (parsed as CancelRunRequestV1).hostRunId;
        const run = runs.get(hostRunId);
        if (run === undefined || !sameOwner(run.owner, caller)) return createAgentSafeFailureV1("CAPABILITY_DENIED");
        const snapshot = run.ledger.snapshot();
        if (run.quarantined || calculateP4bLedgerIntegrityV1(snapshot) !== "valid") { run.quarantined = true; return createAgentSafeFailureV1("INTERNAL"); }
        const state = record(snapshot.run, "run state");
        if (state.terminal === true) return Object.freeze({ ok: true as const, value: Object.freeze({ hostRunId, cancelState: "already_terminal" as const }) });
        if (!run.cancelRequested) {
          run.cancelRequested = true;
          const decoded = backend.sourceFrames.find((frame) => frame.event.type === "cancel.acknowledged");
          const event = decoded === undefined ? makeCanonical(hostRunId, (state.hostSequence as number) + 1, "run.cancelled", { reason: "cancelled" }) : sourceCanonical(decoded, hostRunId, (state.hostSequence as number) + 1)!;
          commit(run, event, decoded);
        }
        return Object.freeze({ ok: true as const, value: Object.freeze({ hostRunId, cancelState: "acknowledged" as const }) });
      }
      if (method === "subscribeRun") return createAgentSafeFailureV1("INVALID_REQUEST");
      return backend.resolve(method, parsed);
    },
    authorizeRun(caller: RunOwnerV1, hostRunId: string): boolean {
      const run = runs.get(hostRunId);
      if (run === undefined || !sameOwner(run.owner, caller) || run.quarantined) return false;
      if (calculateP4bLedgerIntegrityV1(run.ledger.snapshot()) !== "valid") {
        run.quarantined = true;
        return false;
      }
      return true;
    },
    commitCanonicalEventV1,
    snapshotDesktopBoundaryDiagnosticsV1(): Readonly<Record<string, unknown>> {
      if (backend.snapshotDesktopBoundaryDiagnosticsV1 === undefined) {
        throw new TypeError("Desktop boundary diagnostics are unavailable");
      }
      return backend.snapshotDesktopBoundaryDiagnosticsV1();
    },
    openSubscription(caller: RunOwnerV1, hostRunId: string, afterHostSequence: number, onLive: (event: CanonicalEventV1) => void) {
      const run = runs.get(hostRunId);
      if (run === undefined || !sameOwner(run.owner, caller)) return createAgentSafeFailureV1("CAPABILITY_DENIED");
      const snapshot = run.ledger.snapshot();
      if (run.quarantined) return createAgentSafeFailureV1("RECOVERY_UNSUPPORTED", "never", "none");
      if (calculateP4bLedgerIntegrityV1(snapshot) !== "valid") { run.quarantined = true; return createAgentSafeFailureV1("INTERNAL"); }
      const runState = record(snapshot.run, "run state");
      const head = runState.committedHead as number;
      if (!Number.isSafeInteger(afterHostSequence) || afterHostSequence < 0 || afterHostSequence > head) return createAgentSafeFailureV1("INVALID_REQUEST");
      const retentionFloor = Number.isSafeInteger(runState.retentionFloor) ? runState.retentionFloor as number : 0;
      if (afterHostSequence < retentionFloor) return createAgentSafeFailureV1("EVENT_GAP", "never", "start_new_run");
      run.listeners.add(onLive);
      const events = (snapshot.ledger as readonly JsonRecord[])
        .filter((row) => (row.hostSequence as number) > afterHostSequence && (row.hostSequence as number) <= head)
        .map((row) => parseCanonicalEventV1(JSON.parse(Buffer.from(row.canonicalUtf8Hex as string, "hex").toString("utf8"))));
      return Object.freeze({ ok: true as const, value: Object.freeze({ head, terminal: runState.terminal === true, events: Object.freeze(events), close: () => { run.listeners.delete(onLive); } }) });
    },
  });
}

export type DesktopAgentHostV1 = ReturnType<typeof createDesktopAgentHostV1>;

export function executeP4cDesktopBoundaryVectorV1(inputValue: unknown): JsonRecord {
  const input = record(inputValue, "P4-C execution input");
  if (Object.keys(input).some((key) => !["harness", "negotiatedCapabilities", "preState", "stateFixture", "steps"].includes(key)) || input.harness !== "desktop_boundary" || !Array.isArray(input.negotiatedCapabilities) || !input.negotiatedCapabilities.every((item) => typeof item === "string") || !Array.isArray(input.steps) || input.steps.length !== 1) throw new TypeError("P4-C execution input is invalid");
  const preState = record(input.preState, "P4-C preState");
  const fixture = record(input.stateFixture, "P4-C state fixture");
  const binding = record(fixture.binding, "P4-C binding");
  const step = record(input.steps[0], "P4-C step");
  if ((step.api !== "resolveArtifact" && step.api !== "resolveCitation") || typeof step.action !== "string") throw new TypeError("P4-C step is invalid");
  const method = step.api;
  const boundaryRequest = parseAgentDesktopRequestV1(step.request, method);
  const request = method === "resolveArtifact"
    ? parseResolveArtifactRequestV1(boundaryRequest)
    : parseResolveCitationRequestV1(boundaryRequest);

  const callerAuthorized = binding.callerScope === "authorized";
  const ledgerIntegrity = calculateP4bLedgerIntegrityV1(fixture) === "valid";
  const kindIntegrity = ledgerIntegrity && ("target" in request
    ? request.target.artifactId === binding.artifactId && request.target.artifactKind === binding.artifactKind
    : true);
  const requestedRevision = "target" in request
    ? request.target.revisionId
    : ("revisionId" in request.source ? request.source.revisionId : request.source.sourceRevisionId);
  const revisionAvailable = boolean(binding.revisionAvailable, false) && requestedRevision === binding.artifactRevisionId;
  const sourceLocatorValid = method === "resolveCitation" ? boolean(binding.sourceLocatorValid, true) : true;
  const requiredCapability = method === "resolveCitation" ? "resolve_citation" : "resolve_artifact";
  const intentAuthorized = method === "resolveCitation"
    ? boolean(binding.intentAuthorized, (input.negotiatedCapabilities as readonly string[]).includes(requiredCapability))
    : (input.negotiatedCapabilities as readonly string[]).includes(requiredCapability);
  const resolutionAvailable = boolean(binding.resolutionAvailable, revisionAvailable);
  const orderedFailure = assertResolveErrorOrderV1({ callerAuthorized, kindIntegrity, revisionAvailable, sourceLocatorValid, intentAuthorized, resolutionAvailable });
  const registryMutationCount = callerAuthorized && !kindIntegrity ? 1 : 0;
  const passed = orderedFailure === null;
  if (passed) {
    const freshness = binding.revisionFreshness === "historical" ? "historical" : "current";
    createResolveSuccessV1(freshness, request.intent);
  }
  const sideEffectCounters = frozenNullPrototypeRecord(
    P4B_ZERO_SIDE_EFFECT_COUNTERS_V1,
    "sideEffectCounters",
  );
  const processOrRequestCounters = frozenNullPrototypeRecord({
    requestCount: 1,
    successCount: passed ? 1 : 0,
    rejectedCount: passed ? 0 : 1,
    deliveryCount: passed ? 1 : 0,
    registryMutationCount,
    fileReadCount: 0,
  }, "processOrRequestCounters");
  const outcome: Record<string, unknown> = {
    decision: passed ? "pass" : "reject",
    ...(orderedFailure === null ? {} : { errorCode: orderedFailure.error.code }),
    retryability: "never",
    recoveryAction: "none",
    warningCodes: Object.freeze([]),
    canonicalEvents: Object.freeze([]),
    mappingDelta: 0,
    ledgerDelta: 0,
    reducerDelta: 0,
    ackDelta: 0,
    quarantineState: registryMutationCount === 1 ? "active" : "unchanged",
    rendererEmissions: 0,
    sideEffectCounters,
    processOrRequestCounters,
    ...(passed ? { freshness: binding.revisionFreshness === "historical" ? "historical" : "current" } : {}),
  };
  if (preState.quarantined === true) throw new TypeError("P4-C quarantined input cannot resolve");
  return frozenNullPrototypeRecord(outcome, "desktopBoundaryResult");
}
