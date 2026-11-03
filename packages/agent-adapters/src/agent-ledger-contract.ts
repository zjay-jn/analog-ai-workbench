import { canonicalizeAawJsonV1 } from "../../schematic-workbench/src/canonical-json";
import { parseCanonicalEventV1 } from "./canonical-contract";
import {
  P4B_ZERO_SIDE_EFFECT_COUNTERS_V1,
  assertP4bExecutionInputV1,
  cloneFrozenP4bResultV1,
  type P4bHarnessDependenciesV1,
} from "./deterministic-synthetic-adapter";

type JsonRecord = Readonly<Record<string, unknown>>;

const LEDGER_EVENT_2 = Object.freeze({
  type: "message.delta", hostRunId: "host.synthetic-ledger",
  eventId: "event.synthetic-ledger.2", hostSequence: 2,
  acceptedAt: "2026-09-02T00:00:02Z",
  canonicalPayloadDigest: "sha256:95eb5e898feab0b23ad92a39d9ab6771d48f17ab9b5a2109f4abcffae1fcf751",
  canonicalUtf8Hex: "7b2261636365707465644174223a22323032362d30392d30325430303a30303a30325a222c2263616e6f6e6963616c5061796c6f6164446967657374223a227368613235363a39356562356538393866656162306232336164393261333964396162363737316434386631376162396235613231303966346162636666616531666366373531222c226576656e744964223a226576656e742e73796e7468657469632d6c65646765722e32222c22686f737452756e4964223a22686f73742e73796e7468657469632d6c6564676572222c22686f737453657175656e6365223a322c227061796c6f6164223a7b2274657874223a2253796e746865746963206c6564676572206576656e7420322e227d2c2274797065223a226d6573736167652e64656c7461227d",
});
const LEDGER_CHECKPOINT_2 = Object.freeze({
  hostRunId: "host.synthetic-ledger", eventId: "event.synthetic-ledger.2",
  hostSequence: 2, resumeEpoch: 1,
});
const CANCEL_CHECKPOINT_2 = Object.freeze({
  hostRunId: "host.synthetic-cancel-deadline",
  eventId: "event.synthetic-cancel-deadline.2", hostSequence: 2, resumeEpoch: 1,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function rows(value: unknown, label: string, optional = false): readonly JsonRecord[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new TypeError(`${label} must be an array of rows`);
  }
  return value;
}
function eventRowIdentity(row: JsonRecord): string {
  return `${String(row.hostRunId)}\u0000${String(row.eventId)}\u0000${String(row.hostSequence)}`;
}

function checkpointRowIdentity(row: JsonRecord): string {
  return `${eventRowIdentity(row)}\u0000${String(row.resumeEpoch)}`;
}

function validateCanonicalLedgerRows(ledger: readonly JsonRecord[]): void {
  for (const row of ledger) {
    if (typeof row.canonicalUtf8Hex !== "string") throw new TypeError("ledger row lacks canonical bytes");
    const bytes = Buffer.from(row.canonicalUtf8Hex, "hex");
    const event = parseCanonicalEventV1(JSON.parse(bytes.toString("utf8")));
    if (
      bytes.toString("hex") !== row.canonicalUtf8Hex ||
      Buffer.from(canonicalizeAawJsonV1(event), "utf8").toString("hex") !== row.canonicalUtf8Hex
    ) {
      throw new TypeError("ledger canonical bytes do not round-trip");
    }
    for (const key of [
      "hostRunId", "eventId", "hostSequence", "acceptedAt", "type", "canonicalPayloadDigest",
    ]) {
      if ((event as unknown as Record<string, unknown>)[key] !== row[key]) {
        throw new TypeError(`ledger row ${key} drifted`);
      }
    }
  }
}

function calculateP4bLedgerIntegrityUnsafeV1(stateFixture: JsonRecord): "valid" | "corrupt" {
  const ledger = rows(stateFixture.ledger, "ledger");
  const mappings = rows(stateFixture.mappings, "mappings");
  const checkpoints = rows(stateFixture.checkpoints, "checkpoints", true);
  const acks = rows(stateFixture.acks, "acks", true);
  validateCanonicalLedgerRows(ledger);
  const run = isRecord(stateFixture.run) ? stateFixture.run : undefined;
  const binding = isRecord(stateFixture.binding) ? stateFixture.binding : undefined;
  if (run === undefined || binding === undefined ||
    !Number.isSafeInteger(run.hostSequence) ||
    !Number.isSafeInteger(binding.resumeEpoch)) return "corrupt";
  const ledgerByIdentity = new Map(ledger.map((row) => [eventRowIdentity(row), row]));
  const checkpointIds = new Set(checkpoints.map(checkpointRowIdentity));
  let corrupt = false;
  const hostRunId = run.hostRunId;

  const eventIds = new Set<unknown>();
  const hostSequences = new Set<unknown>();
  let terminalCount = 0;
  for (let index = 0; index < ledger.length; index += 1) {
    const event = ledger[index]!;
    if (eventIds.has(event.eventId) || hostSequences.has(event.hostSequence)) corrupt = true;
    eventIds.add(event.eventId);
    hostSequences.add(event.hostSequence);
    if (event.hostRunId !== hostRunId || event.hostSequence !== index + 1) corrupt = true;
    if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
      terminalCount += 1;
      if (index !== ledger.length - 1) corrupt = true;
    }
  }
  if (terminalCount > 1 || run.hostSequence !== ledger.length) corrupt = true;
  if (run.committedHead !== undefined && run.committedHead !== ledger.length) corrupt = true;
  if ((run.terminal === true) !== (terminalCount === 1)) corrupt = true;

  const mappingPrimary = new Set<string>();
  const mappingSecondary = new Set<string>();
  const mappingTargets = new Set<string>();
  for (const mapping of mappings) {
    const sourceRunKey = typeof mapping.sourceRunId === "string"
      ? mapping.sourceRunId
      : "legacy-unbound-source-run";
    const primary = `${sourceRunKey}\u0000${String(mapping.sourceEventId)}`;
    const secondary = `${sourceRunKey}\u0000${String(mapping.sourceSequence)}`;
    const target = `${String(mapping.eventId)}\u0000${String(mapping.hostSequence)}`;
    if (mappingPrimary.has(primary) || mappingSecondary.has(secondary) ||
      mappingTargets.has(target)) corrupt = true;
    mappingPrimary.add(primary);
    mappingSecondary.add(secondary);
    mappingTargets.add(target);
    const matching = ledgerByIdentity.get(
      `${String(hostRunId)}\u0000${String(mapping.eventId)}\u0000${String(mapping.hostSequence)}`,
    );
    const canonicalType = mapping.eventType === "cancel.acknowledged"
      ? "run.cancelled"
      : mapping.eventType;
    if (
      matching === undefined ||
      matching.type !== canonicalType ||
      (mapping.eventType !== "cancel.acknowledged" &&
        matching.canonicalPayloadDigest !== mapping.sourcePayloadDigest)
    ) corrupt = true;
  }
  const checkpointSeen = new Set<string>();
  for (const checkpoint of checkpoints) {
    const identity = checkpointRowIdentity(checkpoint);
    if (checkpointSeen.has(identity) || checkpoint.resumeEpoch !== binding.resumeEpoch ||
      !ledgerByIdentity.has(eventRowIdentity(checkpoint))) corrupt = true;
    checkpointSeen.add(identity);
  }
  const ackSeen = new Set<string>();
  for (const ack of acks) {
    const identity = checkpointRowIdentity(ack);
    if (ackSeen.has(identity) || ack.resumeEpoch !== binding.resumeEpoch ||
      !ledgerByIdentity.has(eventRowIdentity(ack)) || !checkpointIds.has(identity)) corrupt = true;
    ackSeen.add(identity);
  }
  const mappedEventIds = new Set(mappings.map((row) => row.eventId));
  for (const event of ledger) {
    if (event.type !== "run.accepted" && !mappedEventIds.has(event.eventId)) corrupt = true;
  }
  return corrupt ? "corrupt" : "valid";
}

export function calculateP4bLedgerIntegrityV1(stateFixture: JsonRecord): "valid" | "corrupt" {
  try {
    return calculateP4bLedgerIntegrityUnsafeV1(stateFixture);
  } catch {
    return "corrupt";
  }
}

export type RestartableAgentLedgerV1 = Readonly<{
  snapshot(): JsonRecord;
  commitAtomically(
    mapping: JsonRecord | undefined,
    event: JsonRecord | undefined,
    checkpoint: JsonRecord,
    runPatch?: JsonRecord,
  ): void;
  persistAck(checkpoint: JsonRecord): boolean;
}>;

export function createRestartableAgentLedgerV1(seed: JsonRecord): RestartableAgentLedgerV1 {
  let state = structuredClone(seed) as Record<string, unknown>;
  return Object.freeze({
    snapshot(): JsonRecord {
      return cloneFrozenP4bResultV1(state);
    },
    commitAtomically(
      mapping: JsonRecord | undefined,
      event: JsonRecord | undefined,
      checkpoint: JsonRecord,
      runPatch: JsonRecord = {},
    ): void {
      const candidate: Record<string, unknown> = {
        ...structuredClone(state),
        run: {
          ...(isRecord(state.run) ? structuredClone(state.run) : {}),
          ...structuredClone(runPatch),
        },
        mappings: [
          ...rows(state.mappings, "mappings"),
          ...(mapping === undefined ? [] : [structuredClone(mapping)]),
        ],
        ledger: [
          ...rows(state.ledger, "ledger"),
          ...(event === undefined ? [] : [structuredClone(event)]),
        ],
        checkpoints: [...rows(state.checkpoints, "checkpoints", true), structuredClone(checkpoint)],
      };
      if (calculateP4bLedgerIntegrityV1(candidate) !== "valid") {
        throw new TypeError("atomic ledger commit would violate identity consistency");
      }
      state = candidate;
    },
    persistAck(checkpoint: JsonRecord): boolean {
      const identity = checkpointRowIdentity(checkpoint);
      const checkpointRows = rows(state.checkpoints, "checkpoints", true);
      if (!checkpointRows.some((row) => checkpointRowIdentity(row) === identity)) {
        throw new TypeError("ack cannot precede its committed checkpoint");
      }
      const existing = rows(state.acks, "acks", true);
      if (existing.some((row) => checkpointRowIdentity(row) === identity)) return false;
      state = { ...state, acks: [...existing, structuredClone(checkpoint)] };
      return true;
    },
  });
}

function recoveryOutcome(
  retryability: "never" | "safe_resume" | "safe_same_request",
  recoveryAction: "none" | "resume_from_cursor" | "retry_same_request",
  extension: JsonRecord = {},
): JsonRecord {
  return {
    decision: extension.decision ?? "accept",
    ...(extension.errorCode === undefined ? {} : { errorCode: extension.errorCode }),
    retryability, recoveryAction, warningCodes: [],
    canonicalEvents: extension.canonicalEvents ?? [],
    mappingDelta: extension.mappingDelta ?? 0,
    ledgerDelta: extension.ledgerDelta ?? 0,
    reducerDelta: extension.reducerDelta ?? 0,
    ackDelta: extension.ackDelta ?? 0,
    ...(extension.cancelDispatchDelta === undefined ? {} : {
      cancelDispatchDelta: extension.cancelDispatchDelta,
    }),
    checkpointDelta: extension.checkpointDelta ?? 0,
    ackPersistDelta: extension.ackPersistDelta ?? 0,
    checkpointRows: extension.checkpointRows ?? [],
    ackRows: extension.ackRows ?? [],
    ...(extension.postRunLifecycle === undefined ? {} : {
      postRunLifecycle: extension.postRunLifecycle,
    }),
    quarantineState: extension.quarantineState ?? "unchanged",
    rendererEmissions: extension.rendererEmissions ?? 0,
    sideEffectCounters: P4B_ZERO_SIDE_EFFECT_COUNTERS_V1,
  };
}

function validateEmittedEvent(projected: JsonRecord): void {
  if (typeof projected.canonicalUtf8Hex !== "string") throw new TypeError("missing canonical event bytes");
  const bytes = Buffer.from(projected.canonicalUtf8Hex, "hex");
  const event = parseCanonicalEventV1(JSON.parse(bytes.toString("utf8")));
  if (Buffer.from(canonicalizeAawJsonV1(event), "utf8").toString("hex") !== projected.canonicalUtf8Hex) {
    throw new TypeError("recovery event canonical bytes drifted");
  }
}

function isRestartableLedger(value: unknown): value is RestartableAgentLedgerV1 {
  return isRecord(value) &&
    typeof value.snapshot === "function" &&
    typeof value.commitAtomically === "function" &&
    typeof value.persistAck === "function";
}

function countRows(snapshot: JsonRecord, key: string): number {
  return rows(snapshot[key], key, true).length;
}

function integrityBlockResult(): JsonRecord {
  return cloneFrozenP4bResultV1(recoveryOutcome("never", "none", {
    decision: "block", errorCode: "INTERNAL", quarantineState: "active",
  }));
}

export function executeP4bLedgerRecoveryVectorV1(
  input: unknown,
  dependencies: P4bHarnessDependenciesV1 = Object.freeze({ sourceFrames: [] }),
): JsonRecord {
  assertP4bExecutionInputV1(input, "ledger_recovery");
  if (input.preState.fixtureId !== input.stateFixture.fixtureId) {
    throw new TypeError("P4-B ledger recovery fixture binding drifted");
  }
  const declaredIntegrity = isRecord(input.stateFixture.run)
    ? input.stateFixture.run.ledgerIntegrity
    : undefined;
  const calculatedIntegrity = calculateP4bLedgerIntegrityV1(input.stateFixture);
  if (calculatedIntegrity === "corrupt") {
    const only = input.steps[0];
    if (input.steps.length !== 1 || !isRecord(only) ||
      only.action !== "restart" || Object.keys(only).length !== 1) {
      return integrityBlockResult();
    }
    return integrityBlockResult();
  }
  if (declaredIntegrity !== "valid") {
    throw new TypeError("ledger integrity flag does not match independently computed state");
  }
  const firstStep = input.steps[0];
  if (!isRecord(firstStep) || typeof firstStep.action !== "string") {
    throw new TypeError("P4-B recovery step is invalid");
  }
  const allowedFirst = firstStep.action === "commit-event"
    ? new Set(["action", "sourceSequence"])
    : firstStep.action === "request-cancel"
      ? new Set(["action", "monotonicMs"])
      : undefined;
  if (allowedFirst === undefined || Object.keys(firstStep).some((key) => !allowedFirst.has(key))) {
    throw new TypeError("P4-B recovery action fields are invalid");
  }
  const restartStep = input.steps[1];
  if (input.steps.length !== 2 || !isRecord(restartStep) ||
    restartStep.action !== "restart" || Object.keys(restartStep).length !== 1) {
    throw new TypeError("P4-B recovery must end with a closed restart step");
  }
  let activeLedger: RestartableAgentLedgerV1;
  let before: JsonRecord;
  try {
    const providedLedger = dependencies?.ledger;
    activeLedger = isRestartableLedger(providedLedger)
      ? providedLedger
      : createRestartableAgentLedgerV1(input.stateFixture);
    before = activeLedger.snapshot();
    if (calculateP4bLedgerIntegrityV1(before) !== "valid") return integrityBlockResult();
  } catch {
    return integrityBlockResult();
  }
  if (input.faultPoint === "before-commit") {
    let after: JsonRecord;
    try {
      const restarted = createRestartableAgentLedgerV1(activeLedger.snapshot());
      after = restarted.snapshot();
      if (calculateP4bLedgerIntegrityV1(after) !== "valid") return integrityBlockResult();
    } catch {
      return integrityBlockResult();
    }
    if (canonicalizeAawJsonV1(before) !== canonicalizeAawJsonV1(after)) {
      throw new TypeError("before-commit restart changed ledger state");
    }
    return cloneFrozenP4bResultV1(recoveryOutcome("safe_same_request", "retry_same_request", {
      ...(firstStep.action === "request-cancel"
        ? { cancelDispatchDelta: 0, postRunLifecycle: "running" }
        : {}),
    }));
  }
  if (input.faultPoint !== "after-commit-before-ack") {
    throw new TypeError("P4-B recovery fault point is invalid");
  }
  if (firstStep.action === "request-cancel") {
    let after: JsonRecord;
    try {
      activeLedger.commitAtomically(undefined, undefined, CANCEL_CHECKPOINT_2, {
        lifecycle: "cancelling",
        cancelCommandId: "cancel.synthetic.command.1",
        cancelDeadlineMonotonicMs: 2000,
        cancelDispatchState: "dispatched",
      });
      const restarted = createRestartableAgentLedgerV1(activeLedger.snapshot());
      after = restarted.snapshot();
      if (calculateP4bLedgerIntegrityV1(after) !== "valid") return integrityBlockResult();
    } catch {
      return integrityBlockResult();
    }
    return cloneFrozenP4bResultV1(recoveryOutcome("safe_resume", "resume_from_cursor", {
      reducerDelta: 1, cancelDispatchDelta: 0,
      checkpointDelta: countRows(after, "checkpoints") - countRows(before, "checkpoints"),
      ackPersistDelta: countRows(after, "acks") - countRows(before, "acks"),
      checkpointRows: [CANCEL_CHECKPOINT_2], ackRows: [],
      postRunLifecycle: "cancelling",
    }));
  }
  if (firstStep.action !== "commit-event") {
    throw new TypeError("P4-B recovery action is unsupported");
  }
  validateEmittedEvent(LEDGER_EVENT_2);
  const mapping = Object.freeze({
    sourceRunId: isRecord(input.stateFixture.binding)
      ? input.stateFixture.binding.sourceRunId
      : undefined,
    sourceEventId: "source.synthetic-ledger.1",
    sourceSequence: firstStep.sourceSequence,
    eventType: LEDGER_EVENT_2.type,
    sourcePayloadDigest: LEDGER_EVENT_2.canonicalPayloadDigest,
    eventId: LEDGER_EVENT_2.eventId,
    hostSequence: LEDGER_EVENT_2.hostSequence,
  });
  let after: JsonRecord;
  try {
    activeLedger.commitAtomically(mapping, LEDGER_EVENT_2, LEDGER_CHECKPOINT_2, {
      hostSequence: 2,
      committedHead: 2,
    });
    const restarted = createRestartableAgentLedgerV1(activeLedger.snapshot());
    after = restarted.snapshot();
    if (calculateP4bLedgerIntegrityV1(after) !== "valid") return integrityBlockResult();
  } catch {
    return integrityBlockResult();
  }
  return cloneFrozenP4bResultV1(recoveryOutcome("safe_resume", "resume_from_cursor", {
    canonicalEvents: [LEDGER_EVENT_2],
    mappingDelta: countRows(after, "mappings") - countRows(before, "mappings"),
    ledgerDelta: countRows(after, "ledger") - countRows(before, "ledger"),
    reducerDelta: 1,
    checkpointDelta: countRows(after, "checkpoints") - countRows(before, "checkpoints"),
    ackPersistDelta: countRows(after, "acks") - countRows(before, "acks"),
    checkpointRows: [LEDGER_CHECKPOINT_2], ackRows: [],
  }));
}
