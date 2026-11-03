import {
  AGENT_ERROR_CODES_V1,
  AGENT_WARNING_CODES_V1,
  AgentContractError,
  LEGAL_RETRY_RECOVERY_PAIRS_V1,
  type AgentContractErrorCodeV1,
  type AgentRecoveryActionV1,
  type AgentRetryabilityV1,
  type AgentSourceEventTypeV1,
  type AgentWarningCodeV1,
} from "./agent-contract";
import {
  TOOL_STATES_V1,
  TOOL_TRANSITIONS_V1,
  parseCitationRefV1,
  type CitationRefV1,
  type ToolStateV1,
} from "./public-contract";
import { sha256CanonicalAawJsonV1 } from "../../schematic-workbench/src/canonical-json";

export const AGENT_CANONICAL_EVENT_TYPES_V1 = Object.freeze([
  "run.accepted",
  "message.delta",
  "citation.declared",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const);

export type AgentCanonicalEventTypeV1 =
  (typeof AGENT_CANONICAL_EVENT_TYPES_V1)[number];

export type CanonicalPayloadByTypeV1 = Readonly<{
  "run.accepted": Readonly<{
    conversationId: string;
    turnId: string;
    adapterProfileId: string;
    adapterProfileRevision: string;
  }>;
  "message.delta": Readonly<{ text: string }>;
  "citation.declared": CitationRefV1;
  "run.completed": Readonly<{ finishReason: "completed" }>;
  "run.failed": Readonly<{
    errorCode: AgentContractErrorCodeV1;
    retryability: AgentRetryabilityV1;
    recoveryAction: AgentRecoveryActionV1;
  }>;
  "run.cancelled": Readonly<{ reason: "cancelled" }>;
}>;

type CanonicalHeaderV1 = Readonly<{
  hostRunId: string;
  eventId: string;
  hostSequence: number;
  acceptedAt: string;
  canonicalPayloadDigest: `sha256:${string}`;
  warningCodes?: readonly AgentWarningCodeV1[];
}>;

export type CanonicalEventV1 = {
  readonly [Type in AgentCanonicalEventTypeV1]: CanonicalHeaderV1 &
    Readonly<{ type: Type; payload: CanonicalPayloadByTypeV1[Type] }>;
}[AgentCanonicalEventTypeV1];

export type SourceCanonicalMappingV1 = Readonly<{
  adapterInstanceId: string;
  resumeEpoch: number;
  sourceRunId: string;
  sourceEventId: string;
  sourceSequence: number;
  sourceEventType: AgentSourceEventTypeV1;
  sourcePayloadDigest: `sha256:${string}`;
  sourceSchemaVersion: "aaw.agent.source-event/v1alpha1";
  sourceCanonicalizationVersion: "aaw-json-c14n/v1";
  hostRunId: string;
  eventId: string;
  hostSequence: number;
}>;

export type RetryRecoveryFactsV1 = Readonly<{
  runState: "starting" | "running" | "cancelling" | "terminal" | "cancelled" | "quarantined";
  errorCode: AgentContractErrorCodeV1;
  reconfigureAuthorized: boolean;
  policyAllowsNewRun: boolean;
  noPendingOrUnknownSideEffects: boolean;
  resumeCapabilityNegotiated: boolean;
  cursorCurrentEpoch: boolean;
  cursorLedgerVerified: boolean;
  canonicalProgressExists: boolean;
  sameRequestNotAcceptedOrIdempotent: boolean;
}>;

export type RetryRecoveryDecisionV1 = Readonly<{
  retryability: AgentRetryabilityV1;
  recoveryAction: AgentRecoveryActionV1;
  rule: 1 | 2 | 3 | 4 | 5 | 6;
}>;

const rule1ErrorCodes = new Set<AgentContractErrorCodeV1>([
  "CAPABILITY_DENIED",
  "PROTOCOL_MISMATCH",
  "MALFORMED_EVENT",
  "REVISION_UNAVAILABLE",
  "INTERNAL",
]);

const identityPattern = /^(?!latest$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;
const utf8 = new TextEncoder();

export const STRICT_UTC_TIMESTAMP_PATTERN_SOURCE_V1 =
  "^(?!0000)(?:(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)|(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$" as const;

const strictUtcTimestampPatternV1 = new RegExp(
  STRICT_UTC_TIMESTAMP_PATTERN_SOURCE_V1,
  "u",
);

export function isStrictUtcTimestampV1(value: unknown): value is string {
  return typeof value === "string" && strictUtcTimestampPatternV1.test(value);
}

function invalid(message: string): never {
  throw new AgentContractError("INVALID_REQUEST", message);
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return invalid(`${label} must be a plain object`);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return invalid(`${label} must be a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return invalid(`${label} has unsupported properties`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const allowed = [...required, ...optional].sort();
    if (
      required.some((key) => !keys.includes(key)) ||
      keys.some((key) => !allowed.includes(key))
    ) {
      return invalid(`${label} has an invalid property set`);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return invalid(`${label}.${key} must be an enumerable data property`);
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof AgentContractError) throw error;
    return invalid(`${label} could not be validated`);
  }
}

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !identityPattern.test(value) ||
    utf8.encode(value).byteLength > 128
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(`${label} is invalid`);
  return value;
}

function canonicalPayloadForType(
  type: AgentCanonicalEventTypeV1,
  value: unknown,
): CanonicalPayloadByTypeV1[AgentCanonicalEventTypeV1] {
  switch (type) {
    case "run.accepted": {
      const input = exactObject(
        value,
        ["conversationId", "turnId", "adapterProfileId", "adapterProfileRevision"],
        [],
        "canonical run.accepted payload",
      );
      return Object.freeze({
        conversationId: identity(input.conversationId, "conversationId"),
        turnId: identity(input.turnId, "turnId"),
        adapterProfileId: identity(input.adapterProfileId, "adapterProfileId"),
        adapterProfileRevision: identity(
          input.adapterProfileRevision,
          "adapterProfileRevision",
        ),
      });
    }
    case "message.delta": {
      const input = exactObject(value, ["text"], [], "canonical message payload");
      if (
        typeof input.text !== "string" ||
        utf8.encode(input.text).byteLength > 4_096
      ) {
        return invalid("canonical message text is invalid");
      }
      return Object.freeze({ text: input.text });
    }
    case "citation.declared":
      return parseCitationRefV1(value);
    case "run.completed": {
      const input = exactObject(value, ["finishReason"], [], "canonical completed payload");
      if (input.finishReason !== "completed") return invalid("finishReason is invalid");
      return Object.freeze({ finishReason: "completed" as const });
    }
    case "run.failed": {
      const input = exactObject(
        value,
        ["errorCode", "retryability", "recoveryAction"],
        [],
        "canonical failed payload",
      );
      if (
        typeof input.errorCode !== "string" ||
        !AGENT_ERROR_CODES_V1.includes(input.errorCode as AgentContractErrorCodeV1) ||
        typeof input.retryability !== "string" ||
        typeof input.recoveryAction !== "string" ||
        !LEGAL_RETRY_RECOVERY_PAIRS_V1.some(
          ([retry, recovery]) =>
            retry === input.retryability && recovery === input.recoveryAction,
        )
      ) {
        return invalid("canonical failed payload is invalid");
      }
      return Object.freeze({
        errorCode: input.errorCode as AgentContractErrorCodeV1,
        retryability: input.retryability as AgentRetryabilityV1,
        recoveryAction: input.recoveryAction as AgentRecoveryActionV1,
      });
    }
    case "run.cancelled": {
      const input = exactObject(value, ["reason"], [], "canonical cancelled payload");
      if (input.reason !== "cancelled") return invalid("cancel reason is invalid");
      return Object.freeze({ reason: "cancelled" as const });
    }
  }
}

export function parseCanonicalEventV1(value: unknown): CanonicalEventV1 {
  const input = exactObject(
    value,
    [
      "hostRunId",
      "eventId",
      "hostSequence",
      "acceptedAt",
      "canonicalPayloadDigest",
      "type",
      "payload",
    ],
    ["warningCodes"],
    "canonical event",
  );
  if (
    typeof input.type !== "string" ||
    !AGENT_CANONICAL_EVENT_TYPES_V1.includes(
      input.type as AgentCanonicalEventTypeV1,
    ) ||
    !isStrictUtcTimestampV1(input.acceptedAt) ||
    typeof input.canonicalPayloadDigest !== "string" ||
    !sha256Pattern.test(input.canonicalPayloadDigest)
  ) {
    return invalid("canonical event header is invalid");
  }
  const type = input.type as AgentCanonicalEventTypeV1;
  const payload = canonicalPayloadForType(type, input.payload);
  let warningCodes: readonly AgentWarningCodeV1[] | undefined;
  if (input.warningCodes !== undefined) {
    if (
      !Array.isArray(input.warningCodes) ||
      input.warningCodes.length !== 1 ||
      input.warningCodes[0] !== AGENT_WARNING_CODES_V1[0]
    ) {
      return invalid("canonical warning codes are invalid");
    }
    warningCodes = Object.freeze([AGENT_WARNING_CODES_V1[0]] as const);
  }
  if (sha256CanonicalAawJsonV1(payload) !== input.canonicalPayloadDigest) {
    return invalid("canonical payload digest does not match payload");
  }
  return Object.freeze({
    hostRunId: identity(input.hostRunId, "hostRunId"),
    eventId: identity(input.eventId, "eventId"),
    hostSequence: safeInteger(input.hostSequence, "hostSequence", 1, 10_000),
    acceptedAt: input.acceptedAt,
    canonicalPayloadDigest: input.canonicalPayloadDigest as `sha256:${string}`,
    ...(warningCodes === undefined ? {} : { warningCodes }),
    type,
    payload,
  }) as CanonicalEventV1;
}

export function canonicalWarningAnnouncementKeysV1(
  event: CanonicalEventV1,
): readonly string[] {
  return Object.freeze(
    (event.warningCodes ?? []).map(
      (code) => `${event.hostRunId}:${event.eventId}:${code}`,
    ),
  );
}

export function parseSourceCanonicalMappingV1(
  value: unknown,
): SourceCanonicalMappingV1 {
  const input = exactObject(
    value,
    [
      "adapterInstanceId",
      "resumeEpoch",
      "sourceRunId",
      "sourceEventId",
      "sourceSequence",
      "sourceEventType",
      "sourcePayloadDigest",
      "sourceSchemaVersion",
      "sourceCanonicalizationVersion",
      "hostRunId",
      "eventId",
      "hostSequence",
    ],
    [],
    "source mapping",
  );
  if (
    input.sourceSchemaVersion !== "aaw.agent.source-event/v1alpha1" ||
    input.sourceCanonicalizationVersion !== "aaw-json-c14n/v1" ||
    typeof input.sourceEventType !== "string" ||
    !["message.delta", "citation.declared", "cancel.acknowledged", "run.completed", "run.failed"].includes(input.sourceEventType) ||
    typeof input.sourcePayloadDigest !== "string" ||
    !sha256Pattern.test(input.sourcePayloadDigest)
  ) {
    return invalid("source mapping is invalid");
  }
  return Object.freeze({
    adapterInstanceId: identity(input.adapterInstanceId, "adapterInstanceId"),
    resumeEpoch: safeInteger(input.resumeEpoch, "resumeEpoch", 0),
    sourceRunId: identity(input.sourceRunId, "sourceRunId"),
    sourceEventId: identity(input.sourceEventId, "sourceEventId"),
    sourceSequence: safeInteger(input.sourceSequence, "sourceSequence", 0),
    sourceEventType: input.sourceEventType as AgentSourceEventTypeV1,
    sourcePayloadDigest: input.sourcePayloadDigest as `sha256:${string}`,
    sourceSchemaVersion: "aaw.agent.source-event/v1alpha1",
    sourceCanonicalizationVersion: "aaw-json-c14n/v1",
    hostRunId: identity(input.hostRunId, "hostRunId"),
    eventId: identity(input.eventId, "eventId"),
    hostSequence: safeInteger(input.hostSequence, "hostSequence", 1, 10_000),
  });
}

export function parseRetryRecoveryFactsV1(value: unknown): RetryRecoveryFactsV1 {
  const input = exactObject(
    value,
    [
      "runState",
      "errorCode",
      "reconfigureAuthorized",
      "policyAllowsNewRun",
      "noPendingOrUnknownSideEffects",
      "resumeCapabilityNegotiated",
      "cursorCurrentEpoch",
      "cursorLedgerVerified",
      "canonicalProgressExists",
      "sameRequestNotAcceptedOrIdempotent",
    ],
    [],
    "retry facts",
  );
  if (
    typeof input.runState !== "string" ||
    !["starting", "running", "cancelling", "terminal", "cancelled", "quarantined"].includes(input.runState) ||
    typeof input.errorCode !== "string" ||
    !AGENT_ERROR_CODES_V1.includes(input.errorCode as AgentContractErrorCodeV1)
  ) {
    return invalid("retry facts are invalid");
  }
  return Object.freeze({
    runState: input.runState as RetryRecoveryFactsV1["runState"],
    errorCode: input.errorCode as AgentContractErrorCodeV1,
    reconfigureAuthorized: boolean(input.reconfigureAuthorized, "reconfigureAuthorized"),
    policyAllowsNewRun: boolean(input.policyAllowsNewRun, "policyAllowsNewRun"),
    noPendingOrUnknownSideEffects: boolean(input.noPendingOrUnknownSideEffects, "noPendingOrUnknownSideEffects"),
    resumeCapabilityNegotiated: boolean(input.resumeCapabilityNegotiated, "resumeCapabilityNegotiated"),
    cursorCurrentEpoch: boolean(input.cursorCurrentEpoch, "cursorCurrentEpoch"),
    cursorLedgerVerified: boolean(input.cursorLedgerVerified, "cursorLedgerVerified"),
    canonicalProgressExists: boolean(input.canonicalProgressExists, "canonicalProgressExists"),
    sameRequestNotAcceptedOrIdempotent: boolean(
      input.sameRequestNotAcceptedOrIdempotent,
      "sameRequestNotAcceptedOrIdempotent",
    ),
  });
}

export function parseToolTransitionV1(
  value: unknown,
): Readonly<{ from: ToolStateV1; to: ToolStateV1; toolBrokerInvocationCount: 0 }> {
  const input = exactObject(
    value,
    ["from", "to", "toolBrokerInvocationCount"],
    [],
    "tool transition",
  );
  if (
    typeof input.from !== "string" ||
    typeof input.to !== "string" ||
    !TOOL_STATES_V1.includes(input.from as ToolStateV1) ||
    !TOOL_STATES_V1.includes(input.to as ToolStateV1) ||
    input.toolBrokerInvocationCount !== 0 ||
    !TOOL_TRANSITIONS_V1.some(
      ([from, to]) => from === input.from && to === input.to,
    )
  ) {
    return invalid("tool transition is invalid");
  }
  return Object.freeze({
    from: input.from as ToolStateV1,
    to: input.to as ToolStateV1,
    toolBrokerInvocationCount: 0 as const,
  });
}

function decision(
  retryability: AgentRetryabilityV1,
  recoveryAction: AgentRecoveryActionV1,
  rule: RetryRecoveryDecisionV1["rule"],
): RetryRecoveryDecisionV1 {
  return Object.freeze({ retryability, recoveryAction, rule });
}

export function reduceRetryRecoveryV1(
  value: unknown,
): RetryRecoveryDecisionV1 {
  const facts = parseRetryRecoveryFactsV1(value);
  if (
    facts.runState === "quarantined" ||
    facts.runState === "terminal" ||
    facts.runState === "cancelled" ||
    rule1ErrorCodes.has(facts.errorCode)
  ) {
    return decision("never", "none", 1);
  }
  if (facts.errorCode === "NOT_CONFIGURED" && facts.reconfigureAuthorized) {
    return decision("never", "reconfigure", 2);
  }
  if (
    (facts.errorCode === "RECOVERY_UNSUPPORTED" ||
      facts.errorCode === "EVENT_GAP") &&
    facts.noPendingOrUnknownSideEffects &&
    facts.policyAllowsNewRun
  ) {
    return decision("never", "start_new_run", 3);
  }
  if (
    facts.runState === "running" &&
    facts.resumeCapabilityNegotiated &&
    facts.cursorCurrentEpoch &&
    facts.cursorLedgerVerified &&
    facts.noPendingOrUnknownSideEffects
  ) {
    return decision("safe_resume", "resume_from_cursor", 4);
  }
  if (
    !facts.canonicalProgressExists &&
    facts.sameRequestNotAcceptedOrIdempotent &&
    facts.noPendingOrUnknownSideEffects
  ) {
    return decision("safe_same_request", "retry_same_request", 5);
  }
  return decision("never", "none", 6);
}

export function canonicalEventIdentityV1(
  event: CanonicalEventV1,
): Readonly<{ hostRunId: string; eventId: string; hostSequence: number }> {
  return Object.freeze({
    hostRunId: event.hostRunId,
    eventId: event.eventId,
    hostSequence: event.hostSequence,
  });
}
