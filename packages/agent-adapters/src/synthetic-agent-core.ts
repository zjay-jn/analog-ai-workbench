import {
  canonicalizeAawJsonV1,
  sha256CanonicalAawJsonV1,
} from "../../schematic-workbench/src/canonical-json";
import type { DecodedAgentSourceFrameV1 } from "./agent-contract";
import { parseCanonicalEventV1 } from "./canonical-contract";
import {
  calculateP4bLedgerIntegrityV1,
  createRestartableAgentLedgerV1,
} from "./agent-ledger-contract";
import {
  P4B_ZERO_SIDE_EFFECT_COUNTERS_V1,
  assertP4bExecutionInputV1,
  cloneFrozenP4bResultV1,
  requireSyntheticSourceFrameV1,
  type P4bExecutionInputV1,
  type P4bHarnessDependenciesV1,
} from "./deterministic-synthetic-adapter";

type JsonRecord = Readonly<Record<string, unknown>>;

const TIME_EVENT = Object.freeze({
  type: "message.delta", hostRunId: "host.synthetic-time",
  eventId: "event.synthetic-time.2", hostSequence: 2,
  acceptedAt: "2026-09-02T00:00:02Z",
  canonicalPayloadDigest: "sha256:95eb5e898feab0b23ad92a39d9ab6771d48f17ab9b5a2109f4abcffae1fcf751",
  canonicalUtf8Hex: "7b2261636365707465644174223a22323032362d30392d30325430303a30303a30325a222c2263616e6f6e6963616c5061796c6f6164446967657374223a227368613235363a39356562356538393866656162306232336164393261333964396162363737316434386631376162396235613231303966346162636666616531666366373531222c226576656e744964223a226576656e742e73796e7468657469632d74696d652e32222c22686f737452756e4964223a22686f73742e73796e7468657469632d74696d65222c22686f737453657175656e6365223a322c227061796c6f6164223a7b2274657874223a2253796e746865746963206c6564676572206576656e7420322e227d2c2274797065223a226d6573736167652e64656c7461227d",
});
const LIVE_EVENT = Object.freeze({
  type: "message.delta", hostRunId: "host.synthetic-cancel-deadline",
  eventId: "event.synthetic-cancel-deadline.3", hostSequence: 3,
  acceptedAt: "2026-09-02T00:00:03Z",
  canonicalPayloadDigest: "sha256:6b044e18996fb5a05f8ea92f5f83ad1e543ec3742075b51bca438744a69696df",
  canonicalUtf8Hex: "7b2261636365707465644174223a22323032362d30392d30325430303a30303a30335a222c2263616e6f6e6963616c5061796c6f6164446967657374223a227368613235363a36623034346531383939366662356130356638656139326635663833616431653534336563333734323037356235316263613433383734346136393639366466222c226576656e744964223a226576656e742e73796e7468657469632d63616e63656c2d646561646c696e652e33222c22686f737452756e4964223a22686f73742e73796e7468657469632d63616e63656c2d646561646c696e65222c22686f737453657175656e6365223a332c227061796c6f6164223a7b2274657874223a2253796e746865746963206c697665207461696c206576656e7420332e227d2c2274797065223a226d6573736167652e64656c7461227d",
});
const CHECKPOINT_3 = Object.freeze({
  hostRunId: "host.synthetic-cancel-deadline",
  eventId: "event.synthetic-cancel-deadline.3", hostSequence: 3, resumeEpoch: 1,
});
const LIVE_MAPPING = Object.freeze({
  sourceEventId: "synthetic.event.live-tail", sourceSequence: 3,
  eventType: "message.delta",
  sourcePayloadDigest: "sha256:6b044e18996fb5a05f8ea92f5f83ad1e543ec3742075b51bca438744a69696df",
  eventId: "event.synthetic-cancel-deadline.3", hostSequence: 3,
});
function projectionFromDecoded(
  decoded: DecodedAgentSourceFrameV1,
  header: Readonly<{
    hostRunId: string;
    hostSequence: number;
    acceptedAt: string;
    type?: "message.delta" | "run.cancelled";
    warningCodes?: readonly ["SOURCE_TIME_INVALID"];
  }>,
): JsonRecord {
  const type = header.type ?? "message.delta";
  const payload = type === "run.cancelled"
    ? Object.freeze({ reason: "cancelled" as const })
    : decoded.event.payload;
  const canonical = parseCanonicalEventV1({
    hostRunId: header.hostRunId,
    eventId: `${header.hostRunId.replace(/^host\./u, "event.")}.${header.hostSequence}`,
    hostSequence: header.hostSequence,
    acceptedAt: header.acceptedAt,
    canonicalPayloadDigest: sha256CanonicalAawJsonV1(payload),
    ...(header.warningCodes === undefined ? {} : { warningCodes: header.warningCodes }),
    type,
    payload,
  });
  return Object.freeze({
    type: canonical.type,
    hostRunId: canonical.hostRunId,
    eventId: canonical.eventId,
    hostSequence: canonical.hostSequence,
    acceptedAt: canonical.acceptedAt,
    canonicalPayloadDigest: canonical.canonicalPayloadDigest,
    canonicalUtf8Hex: Buffer.from(canonicalizeAawJsonV1(canonical), "utf8").toString("hex"),
  });
}

function mappingFromDecoded(
  decoded: DecodedAgentSourceFrameV1,
  projected: JsonRecord,
): JsonRecord {
  return Object.freeze({
    sourceEventId: decoded.event.sourceEventId,
    sourceSequence: decoded.event.sourceSequence,
    eventType: decoded.event.type,
    sourcePayloadDigest: decoded.recomputedSourcePayloadDigest,
    eventId: projected.eventId,
    hostSequence: projected.hostSequence,
  });
}

function commitAndAck(
  stateFixture: JsonRecord,
  mapping: JsonRecord,
  event: JsonRecord,
  checkpoint: JsonRecord,
): Readonly<{ mappingDelta: number; ledgerDelta: number; checkpointDelta: number; ackDelta: number }> {
  const beforeMappings = Array.isArray(stateFixture.mappings) ? stateFixture.mappings.length : 0;
  const beforeLedger = Array.isArray(stateFixture.ledger) ? stateFixture.ledger.length : 0;
  const beforeCheckpoints = Array.isArray(stateFixture.checkpoints) ? stateFixture.checkpoints.length : 0;
  const beforeAcks = Array.isArray(stateFixture.acks) ? stateFixture.acks.length : 0;
  const ledger = createRestartableAgentLedgerV1(stateFixture);
  const sourceRunId = isRecord(stateFixture.binding)
    ? stateFixture.binding.sourceRunId
    : undefined;
  const internalMapping = typeof sourceRunId === "string"
    ? Object.freeze({ ...mapping, sourceRunId })
    : mapping;
  const becomesTerminal = event.type === "run.completed" ||
    event.type === "run.failed" || event.type === "run.cancelled";
  ledger.commitAtomically(internalMapping, event, checkpoint, {
    hostSequence: event.hostSequence,
    committedHead: event.hostSequence,
    ...(becomesTerminal ? { terminal: true, lifecycle: "terminal" } : {}),
  });
  ledger.persistAck(checkpoint);
  const after = ledger.snapshot();
  return Object.freeze({
    mappingDelta: (after.mappings as readonly unknown[]).length - beforeMappings,
    ledgerDelta: (after.ledger as readonly unknown[]).length - beforeLedger,
    checkpointDelta: (after.checkpoints as readonly unknown[]).length - beforeCheckpoints,
    ackDelta: (after.acks as readonly unknown[]).length - beforeAcks,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stepsOf(input: P4bExecutionInputV1): readonly JsonRecord[] {
  const knownActions = new Set([
    "replay-exact-primary-key", "replay-primary-key-conflict",
    "replay-secondary-key-conflict", "submit-unnegotiated-version",
    "submit-exact-replay", "submit-late-old-transport",
    "resume-old-epoch-cursor", "replay-old-epoch-source",
    "submit-invalid-semantic-time", "permute-source-occurred-at",
    "submit-new-post-terminal", "replay-preterminal-exact",
    "trigger-illegal-main-pair", "resume-quarantined-run", "reduce-recovery",
    "permute-wall-clock", "advance-monotonic-clock", "fire-cancel-timeout",
    "subscribe-replay", "commit-live-tail", "drain-replay-tail",
    "request-cancel", "submit-cancel-ack", "submit-late-after-cancel",
  ]);
  return input.steps.map((step) => {
    if (!isRecord(step) || typeof step.action !== "string") {
      throw new TypeError("P4-B reducer step must be a closed action object");
    }
    if (!knownActions.has(step.action)) {
      throw new TypeError(`Unknown P4-B reducer action: ${step.action}`);
    }
    const sourceSequenceOnly = new Set([
      "replay-exact-primary-key", "replay-primary-key-conflict",
      "replay-secondary-key-conflict", "submit-unnegotiated-version",
      "submit-exact-replay", "submit-late-old-transport",
      "resume-old-epoch-cursor", "replay-old-epoch-source",
      "permute-source-occurred-at", "submit-new-post-terminal",
      "replay-preterminal-exact", "trigger-illegal-main-pair",
      "resume-quarantined-run", "reduce-recovery",
    ]);
    const sourceIdentity = new Set([
      "submit-invalid-semantic-time", "commit-live-tail",
      "submit-cancel-ack", "submit-late-after-cancel",
    ]);
    const monotonic = new Set([
      "request-cancel", "advance-monotonic-clock", "fire-cancel-timeout",
    ]);
    const allowed = new Set(["action"]);
    if (sourceSequenceOnly.has(step.action)) allowed.add("sourceSequence");
    if (sourceIdentity.has(step.action)) {
      allowed.add("sourceSequence");
      allowed.add("sourceEventId");
    }
    if (monotonic.has(step.action)) allowed.add("monotonicMs");
    if (step.action === "permute-wall-clock") allowed.add("sourceSequence");
    if (step.action === "subscribe-replay") allowed.add("afterHostSequence");
    if (Object.keys(step).some((key) => !allowed.has(key))) {
      throw new TypeError(`P4-B reducer action ${step.action} has forbidden fields`);
    }
    if (
      (sourceSequenceOnly.has(step.action) || sourceIdentity.has(step.action)) &&
      (!Number.isSafeInteger(step.sourceSequence) || (step.sourceSequence as number) < 1)
    ) {
      throw new TypeError("sourceSequence must be a positive safe integer");
    }
    if (sourceIdentity.has(step.action) &&
      (typeof step.sourceEventId !== "string" || step.sourceEventId.length === 0)) {
      throw new TypeError("sourceEventId is required for this action");
    }
    if (monotonic.has(step.action) &&
      (!Number.isSafeInteger(step.monotonicMs) || (step.monotonicMs as number) < 0)) {
      throw new TypeError("monotonicMs must be a nonnegative safe integer");
    }
    if (step.action === "permute-wall-clock") {
      if (!Number.isSafeInteger(step.sourceSequence) || (step.sourceSequence as number) < 0) {
        throw new TypeError("wall-clock sourceSequence must be a nonnegative safe integer");
      }
      const mappings: readonly unknown[] = Array.isArray(input.stateFixture.mappings)
        ? input.stateFixture.mappings
        : [];
      if (!mappings.some((mapping) =>
        isRecord(mapping) && mapping.sourceSequence === step.sourceSequence
      )) {
        throw new TypeError("wall-clock permutation must reference a seeded source sequence");
      }
    }
    if (step.action === "subscribe-replay" && step.afterHostSequence !== undefined &&
      (!Number.isSafeInteger(step.afterHostSequence) || (step.afterHostSequence as number) < 0)) {
      throw new TypeError("afterHostSequence must be a nonnegative safe integer");
    }
    return step;
  });
}

function assertClosedTransitionSequence(steps: readonly JsonRecord[]): void {
  if (steps.length === 0) throw new TypeError("P4-B reducer requires at least one step");
  const actions = steps.map((step) => step.action);
  const first = actions[0];
  if (first === "subscribe-replay") {
    if (actions.length === 1) return;
    if (actions[1] !== "commit-live-tail" || actions.length > 3) {
      throw new TypeError("Replay transition order is invalid");
    }
    if (actions.length === 3 && actions[2] !== "drain-replay-tail") {
      throw new TypeError("Replay tail must drain exactly once after commit");
    }
    return;
  }
  if (first === "request-cancel") {
    let cursor = 0;
    while (actions[cursor] === "request-cancel") cursor += 1;
    if (cursor < actions.length &&
      actions[cursor] !== "fire-cancel-timeout" &&
      actions[cursor] !== "advance-monotonic-clock") {
      throw new TypeError("Cancel transition order is invalid");
    }
    if (cursor < actions.length) cursor += 1;
    if (cursor < actions.length && actions[cursor] !== "submit-late-after-cancel") {
      throw new TypeError("Only a late isolated event may follow cancel timeout");
    }
    if (cursor < actions.length) cursor += 1;
    if (cursor !== actions.length) throw new TypeError("Cancel sequence has trailing steps");
    return;
  }
  if (first === "permute-wall-clock") {
    if (actions.length !== 2 || actions[1] !== "advance-monotonic-clock") {
      throw new TypeError("Wall-clock permutation requires one monotonic advance");
    }
    return;
  }
  if (first === "fire-cancel-timeout") {
    if (actions.length > 2 ||
      (actions.length === 2 && actions[1] !== "submit-late-after-cancel")) {
      throw new TypeError("Cancel timeout sequence is invalid");
    }
    return;
  }
  if (steps.length !== 1) {
    throw new TypeError("Single-action reducer vector has extra steps");
  }
}

function outcome(
  decision: "accept" | "reject" | "isolate" | "block",
  extension: JsonRecord = {},
): JsonRecord {
  return {
    decision,
    ...(extension.errorCode === undefined ? {} : { errorCode: extension.errorCode }),
    retryability: extension.retryability ?? "never",
    recoveryAction: extension.recoveryAction ?? "none",
    warningCodes: extension.warningCodes ?? [],
    canonicalEvents: extension.canonicalEvents ?? [],
    mappingDelta: extension.mappingDelta ?? 0,
    ledgerDelta: extension.ledgerDelta ?? 0,
    reducerDelta: extension.reducerDelta ?? 0,
    ackDelta: extension.ackDelta ?? 0,
    ...Object.fromEntries(Object.entries(extension).filter(([key]) => ![
      "errorCode", "retryability", "recoveryAction", "warningCodes",
      "canonicalEvents", "mappingDelta", "ledgerDelta", "reducerDelta", "ackDelta",
    ].includes(key))),
    quarantineState: extension.quarantineState ?? "unchanged",
    rendererEmissions: extension.rendererEmissions ?? 0,
    sideEffectCounters: P4B_ZERO_SIDE_EFFECT_COUNTERS_V1,
  };
}

function reject(errorCode: string, extension: JsonRecord = {}): JsonRecord {
  return outcome("reject", { errorCode, ...extension });
}
function isolate(errorCode: string): JsonRecord {
  return outcome("isolate", { errorCode });
}
function block(errorCode: string, extension: JsonRecord = {}): JsonRecord {
  return outcome("block", { errorCode, quarantineState: "active", ...extension });
}

function validateCanonicalProjection(projected: JsonRecord): void {
  if (typeof projected.canonicalUtf8Hex !== "string") throw new TypeError("missing canonical bytes");
  const bytes = Buffer.from(projected.canonicalUtf8Hex, "hex");
  const event = parseCanonicalEventV1(JSON.parse(bytes.toString("utf8")));
  if (
    bytes.toString("hex") !== projected.canonicalUtf8Hex ||
    Buffer.from(canonicalizeAawJsonV1(event), "utf8").toString("hex") !== projected.canonicalUtf8Hex
  ) {
    throw new TypeError("canonical ledger bytes failed round-trip");
  }
}

function replayResult(input: P4bExecutionInputV1, steps: readonly JsonRecord[]): JsonRecord {
  const state = structuredClone(input.stateFixture) as Record<string, unknown>;
  const run = isRecord(state.run) ? state.run : {};
  const after = steps[0]?.afterHostSequence ?? 0;
  if (!Number.isSafeInteger(after) || (after as number) < 0) return reject("INVALID_REQUEST", {
    deliveryHostSequences: [], subscriptionDisposition: "reject",
  });
  if (run.quarantined === true) return block("RECOVERY_UNSUPPORTED", {
    deliveryHostSequences: [], subscriptionDisposition: "closed",
  });
  if (calculateP4bLedgerIntegrityV1(state) !== "valid") return block("INTERNAL", {
    deliveryHostSequences: [], subscriptionDisposition: "closed",
    rendererEmissions: 0,
  });
  if (input.preState.fixtureId === "synthetic-current-epoch") return reject("EVENT_GAP", {
    recoveryAction: "start_new_run", deliveryHostSequences: [], subscriptionDisposition: "closed",
  });
  if (input.preState.fixtureId === "synthetic-mapped-event") return reject("RECOVERY_UNSUPPORTED", {
    deliveryHostSequences: [], subscriptionDisposition: "closed",
  });
  const head = run.hostSequence;
  if (!Number.isSafeInteger(head) || (after as number) > (head as number)) return reject("INVALID_REQUEST", {
    deliveryHostSequences: [], subscriptionDisposition: "reject",
  });
  const ledger = Array.isArray(state.ledger)
    ? state.ledger.filter(isRecord).map((row) => ({ ...row }))
    : [];
  const snapshotHead = head as number;
  const deliveries = ledger
    .map((row) => row.hostSequence)
    .filter((sequence): sequence is number =>
      typeof sequence === "number" && Number.isSafeInteger(sequence) &&
      sequence > (after as number) && sequence <= snapshotHead
    );
  if (steps.some((step) => step.action === "commit-live-tail")) {
    validateCanonicalProjection(LIVE_EVENT);
    const committed = commitAndAck(input.stateFixture, LIVE_MAPPING, LIVE_EVENT, CHECKPOINT_3);
    ledger.push({ ...LIVE_EVENT });
    if (
      steps.some((step) => step.action === "drain-replay-tail") &&
      !deliveries.includes(LIVE_EVENT.hostSequence)
    ) deliveries.push(LIVE_EVENT.hostSequence);
    return outcome("accept", {
      canonicalEvents: [LIVE_EVENT], mappingDelta: committed.mappingDelta,
      ledgerDelta: committed.ledgerDelta, reducerDelta: 1, ackDelta: committed.ackDelta,
      mappingRows: [LIVE_MAPPING], checkpointDelta: committed.checkpointDelta,
      ackPersistDelta: committed.ackDelta,
      checkpointRows: [CHECKPOINT_3], ackRows: [CHECKPOINT_3],
      deliveryHostSequences: deliveries, subscriptionDisposition: "wait",
      rendererEmissions: deliveries.length,
    });
  }
  return outcome("accept", {
    deliveryHostSequences: deliveries,
    subscriptionDisposition: run.terminal === true ? "end" : "wait",
    rendererEmissions: deliveries.length,
  });
}

function cancelSequenceResult(input: P4bExecutionInputV1, steps: readonly JsonRecord[]): JsonRecord {
  const run = structuredClone(isRecord(input.stateFixture.run) ? input.stateFixture.run : {});
  let lifecycle = run.terminal === true ? "terminal" : run.lifecycle ?? "running";
  let reducerDelta = 0;
  let cancelDispatchDelta = 0;
  let commandId: string | undefined;
  let deadline: number | undefined;
  let quarantined = run.quarantined === true;
  let activeDeadline = Number.isSafeInteger(run.cancelDeadlineMonotonicMs)
    ? run.cancelDeadlineMonotonicMs as number
    : undefined;
  for (const step of steps) {
    if (step.action === "permute-wall-clock") continue;
    if (step.action === "request-cancel") {
      if (lifecycle === "terminal" || lifecycle === "cancelling") continue;
      lifecycle = "cancelling";
      reducerDelta += 1;
      cancelDispatchDelta += 1;
      commandId = "cancel.synthetic.command.1";
      deadline = (step.monotonicMs as number) + 1000;
      activeDeadline = deadline;
      continue;
    }
    if (step.action === "advance-monotonic-clock" || step.action === "fire-cancel-timeout") {
      if (activeDeadline !== undefined && (step.monotonicMs as number) > activeDeadline) {
        quarantined = true;
        lifecycle = "quarantined";
      }
      continue;
    }
    if (step.action === "submit-late-after-cancel" && quarantined) continue;
  }
  if (quarantined) return block("CANCELLATION_TIMEOUT", {
    reducerDelta, cancelDispatchDelta,
    postRunLifecycle: "quarantined",
  });
  return outcome("accept", {
    reducerDelta, cancelDispatchDelta,
    ...(cancelDispatchDelta === 0 ? {} : {
      postCancelCommandId: commandId,
      postCancelDeadlineMonotonicMs: deadline,
      postCancelDispatchState: "dispatched",
    }),
    postRunLifecycle: lifecycle,
  });
}

export function executeP4bReducerVectorV1(
  input: unknown,
  dependencies: P4bHarnessDependenciesV1 = Object.freeze({ sourceFrames: [] }),
): JsonRecord {
  assertP4bExecutionInputV1(input, "reducer");
  if (input.preState.fixtureId !== input.stateFixture.fixtureId) {
    throw new TypeError("P4-B reducer fixture binding drifted");
  }
  const steps = stepsOf(input);
  assertClosedTransitionSequence(steps);
  const action = steps[0]?.action;
  let result: JsonRecord;
  switch (action) {
    case "replay-exact-primary-key":
    case "submit-exact-replay": {
      const decoded = requireSyntheticSourceFrameV1(dependencies, {
        fixtureId: "synthetic.message-delta",
      });
      if (decoded.event.sourceSequence !== steps[0]?.sourceSequence) {
        result = isolate("PROTOCOL_MISMATCH"); break;
      }
      result = outcome("accept", { ackDelta: 1 }); break;
    }
    case "replay-preterminal-exact":
      result = outcome("accept", { ackDelta: 1 }); break;
    case "replay-primary-key-conflict":
    case "replay-secondary-key-conflict":
    case "submit-late-old-transport":
    case "replay-old-epoch-source":
    case "submit-new-post-terminal":
      result = isolate("PROTOCOL_MISMATCH"); break;
    case "submit-unnegotiated-version":
      result = reject("PROTOCOL_MISMATCH"); break;
    case "resume-old-epoch-cursor":
      result = reject("RECOVERY_UNSUPPORTED", { recoveryAction: "start_new_run" }); break;
    case "submit-invalid-semantic-time": {
      const decoded = requireSyntheticSourceFrameV1(dependencies, {
        fixtureId: "synthetic.invalid-source-time",
        sourceEventId: String(steps[0]?.sourceEventId),
        sourceSequence: Number(steps[0]?.sourceSequence),
      });
      const event = projectionFromDecoded(decoded, {
        hostRunId: "host.synthetic-invalid-time", hostSequence: 2,
        acceptedAt: "2026-09-02T00:00:02Z",
        warningCodes: ["SOURCE_TIME_INVALID"],
      });
      const mapping = mappingFromDecoded(decoded, event);
      const checkpoint = Object.freeze({
        hostRunId: event.hostRunId, eventId: event.eventId,
        hostSequence: event.hostSequence, resumeEpoch: 1,
      });
      const committed = commitAndAck(input.stateFixture, mapping, event, checkpoint);
      validateCanonicalProjection(event);
      result = outcome("accept", {
        warningCodes: ["SOURCE_TIME_INVALID"], canonicalEvents: [event],
        mappingDelta: committed.mappingDelta, ledgerDelta: committed.ledgerDelta,
        reducerDelta: 1, ackDelta: committed.ackDelta,
        rendererEmissions: 1,
      }); break;
    }
    case "permute-source-occurred-at":
      validateCanonicalProjection(TIME_EVENT);
      commitAndAck(input.stateFixture, Object.freeze({
        sourceEventId: "source.synthetic-time.1", sourceSequence: 1,
        eventType: "message.delta", sourcePayloadDigest: TIME_EVENT.canonicalPayloadDigest,
        eventId: TIME_EVENT.eventId, hostSequence: TIME_EVENT.hostSequence,
      }), TIME_EVENT, Object.freeze({
        hostRunId: TIME_EVENT.hostRunId, eventId: TIME_EVENT.eventId,
        hostSequence: TIME_EVENT.hostSequence, resumeEpoch: 1,
      }));
      result = outcome("accept", {
        canonicalEvents: [TIME_EVENT], mappingDelta: 1, ledgerDelta: 1,
        reducerDelta: 1, ackDelta: 1, rendererEmissions: 1,
      }); break;
    case "trigger-illegal-main-pair":
      result = block("INTERNAL"); break;
    case "resume-quarantined-run":
      result = block("RECOVERY_UNSUPPORTED"); break;
    case "reduce-recovery":
      result = outcome("accept", {
        retryability: "safe_resume", recoveryAction: "resume_from_cursor",
      }); break;
    case "permute-wall-clock":
    case "fire-cancel-timeout":
      result = cancelSequenceResult(input, steps); break;
    case "subscribe-replay":
      result = replayResult(input, steps); break;
    case "request-cancel":
      result = cancelSequenceResult(input, steps); break;
    case "submit-cancel-ack": {
      const decoded = requireSyntheticSourceFrameV1(dependencies, {
        fixtureId: "synthetic.cancel-acknowledged",
        sourceEventId: String(steps[0]?.sourceEventId),
        sourceSequence: Number(steps[0]?.sourceSequence),
      });
      const event = projectionFromDecoded(decoded, {
        hostRunId: "host.synthetic-cancel-deadline", hostSequence: 3,
        acceptedAt: "2026-09-02T00:00:05Z", type: "run.cancelled",
      });
      const mapping = mappingFromDecoded(decoded, event);
      const committed = commitAndAck(input.stateFixture, mapping, event, CHECKPOINT_3);
      validateCanonicalProjection(event);
      result = outcome("accept", {
        canonicalEvents: [event], mappingDelta: committed.mappingDelta,
        ledgerDelta: committed.ledgerDelta, reducerDelta: 1,
        ackDelta: committed.ackDelta, cancelDispatchDelta: 0,
        mappingRows: [mapping], checkpointDelta: committed.checkpointDelta,
        ackPersistDelta: committed.ackDelta,
        checkpointRows: [CHECKPOINT_3], ackRows: [CHECKPOINT_3],
        postRunLifecycle: "terminal", rendererEmissions: 1,
      }); break;
    }
    default:
      throw new TypeError(`Unsupported P4-B reducer action: ${String(action)}`);
  }
  return cloneFrozenP4bResultV1(result);
}
