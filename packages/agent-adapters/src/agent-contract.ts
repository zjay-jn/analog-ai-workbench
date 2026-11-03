export const AGENT_CONTRACT_VERSION_V1 = "aaw.agent/v1alpha1" as const;
export const AGENT_SOURCE_EVENT_SCHEMA_VERSION_V1 =
  "aaw.agent.source-event/v1alpha1" as const;
export const AGENT_CANONICALIZATION_VERSION_V1 = "aaw-json-c14n/v1" as const;

export const AGENT_ERROR_CODES_V1 = Object.freeze([
  "INVALID_REQUEST",
  "PROTOCOL_MISMATCH",
  "CAPABILITY_DENIED",
  "NOT_CONFIGURED",
  "ADAPTER_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "RATE_LIMITED",
  "STREAM_INTERRUPTED",
  "EVENT_GAP",
  "MALFORMED_EVENT",
  "CANCELLATION_TIMEOUT",
  "TOOL_DENIED",
  "TOOL_FAILED",
  "RECOVERY_UNSUPPORTED",
  "REVISION_UNAVAILABLE",
  "INTERNAL",
] as const);

export const AGENT_WARNING_CODES_V1 = Object.freeze([
  "SOURCE_TIME_INVALID",
] as const);

export const AGENT_WARNING_MESSAGES_V1 = Object.freeze({
  SOURCE_TIME_INVALID: "Source timestamp was invalid and was ignored.",
} as const);

export const LEGAL_RETRY_RECOVERY_PAIRS_V1 = Object.freeze([
  Object.freeze(["never", "none"] as const),
  Object.freeze(["never", "reconfigure"] as const),
  Object.freeze(["never", "start_new_run"] as const),
  Object.freeze(["safe_resume", "resume_from_cursor"] as const),
  Object.freeze(["safe_same_request", "retry_same_request"] as const),
] as const);

export type AgentContractErrorCodeV1 = (typeof AGENT_ERROR_CODES_V1)[number];
export type AgentWarningCodeV1 = (typeof AGENT_WARNING_CODES_V1)[number];
export type AgentRetryabilityV1 =
  (typeof LEGAL_RETRY_RECOVERY_PAIRS_V1)[number][0];
export type AgentRecoveryActionV1 =
  (typeof LEGAL_RETRY_RECOVERY_PAIRS_V1)[number][1];

export class AgentContractError extends Error {
  readonly retryability = "never" as const;
  readonly recoveryAction = "none" as const;

  constructor(
    readonly code: AgentContractErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "AgentContractError";
  }
}

export interface AgentJsonArrayV1 extends ReadonlyArray<AgentJsonValueV1> {}

export interface AgentJsonObjectV1 {
  readonly [key: string]: AgentJsonValueV1;
}

export type AgentJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | AgentJsonArrayV1
  | AgentJsonObjectV1;

export const AGENT_SOURCE_EVENT_TYPES_V1 = Object.freeze([
  "message.delta",
  "citation.declared",
  "cancel.acknowledged",
  "run.completed",
  "run.failed",
] as const);

export type AgentSourceEventTypeV1 =
  (typeof AGENT_SOURCE_EVENT_TYPES_V1)[number];

export type MessageDeltaSourcePayloadV1 = Readonly<{ text: string }>;
export type CitationDeclaredSourcePayloadV1 = Readonly<{
  citationId: string;
  source: CitationSourceV1;
  locator: CitationLocatorV1;
}>;
export type CancelAcknowledgedSourcePayloadV1 = Readonly<{
  acknowledged: true;
}>;
export type RunCompletedSourcePayloadV1 = Readonly<{
  finishReason: "completed";
}>;
export type RunFailedSourcePayloadV1 = Readonly<{
  failureKind:
    | "upstream_timeout"
    | "rate_limited"
    | "adapter_unavailable"
    | "stream_interrupted";
}>;

export type AgentSourcePayloadByTypeV1 = Readonly<{
  "message.delta": MessageDeltaSourcePayloadV1;
  "citation.declared": CitationDeclaredSourcePayloadV1;
  "cancel.acknowledged": CancelAcknowledgedSourcePayloadV1;
  "run.completed": RunCompletedSourcePayloadV1;
  "run.failed": RunFailedSourcePayloadV1;
}>;

type AgentSourceEventHeaderV1 = Readonly<{
  sourceSchemaVersion: typeof AGENT_SOURCE_EVENT_SCHEMA_VERSION_V1;
  sourceCanonicalizationVersion: typeof AGENT_CANONICALIZATION_VERSION_V1;
  sourceRunId: string;
  sourceEventId: string;
  sourceSequence: number;
  sourcePayloadDigest: `sha256:${string}`;
  sourceOccurredAt?: string;
}>;

export type AgentSourceEventV1 = {
  readonly [Type in AgentSourceEventTypeV1]: AgentSourceEventHeaderV1 &
    Readonly<{
      type: Type;
      payload: AgentSourcePayloadByTypeV1[Type];
    }>;
}[AgentSourceEventTypeV1];

export type CitationSourceV1 =
  | Readonly<{
      sourceKind: "document";
      documentId: string;
      revisionId: string;
    }>
  | Readonly<{
      sourceKind: "artifact" | "reviewed_schematic";
      artifactId: string;
      revisionId: string;
    }>
  | Readonly<{
      sourceKind: "rag_source";
      corpusId: string;
      sourceId: string;
      sourceRevisionId: string;
    }>;

export type CitationLocatorV1 =
  | Readonly<{
      locatorKind: "text_range";
      coordinateSystem: "unicode_code_point";
      start: number;
      end: number;
    }>
  | Readonly<{
      locatorKind: "schematic_element";
      occurrencePath: readonly string[];
      definitionId: string;
      elementKind: string;
      elementId: string;
    }>
  | Readonly<{
      locatorKind: "rag_chunk";
      chunkId: string;
      span?: Readonly<{
        coordinateSystem: "unicode_code_point";
        start: number;
        end: number;
      }>;
    }>
  | Readonly<{ locatorKind: "whole_source" }>;

const identityPattern = /^(?!latest$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const canonicalDecimalPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;
const utf8Encoder = new TextEncoder();
const forbiddenObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const forbiddenSourcePayloadKeys = new Set(
  [
    "hostRunId",
    "eventId",
    "hostSequence",
    "acceptedAt",
    "canonicalPayloadDigest",
    "adapterInstanceId",
    "resumeEpoch",
    "adapterProfileId",
    "adapterProfileRevision",
    "resumeCursor",
    "runAccepted",
    "runTerminal",
    "terminal",
    "status",
    "decision",
    "retryability",
    "recoveryAction",
    "rendererDelivery",
    "callerContext",
    "sessionId",
    "windowId",
    "webContentsId",
    "workspaceId",
    "rootId",
    "capability",
    "grant",
    "resolverToken",
    "token",
    "path",
    "uri",
    "uriHandle",
    "registryHandle",
    "internalRegistryHandle",
  ].map((key) => key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase()),
);

type ExactSnapshot = Readonly<Record<string, unknown>>;

function fail(
  code: AgentContractErrorCodeV1,
  message: string,
): never {
  throw new AgentContractError(code, message);
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  code: AgentContractErrorCodeV1,
): ExactSnapshot {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(code, `${label} must be a plain object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail(code, `${label} must be a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return fail(code, `${label} has unsupported properties`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Object.keys(descriptors).sort();
    const allowed = [...required, ...optional].sort();
    if (
      actual.some((key) => !allowed.includes(key)) ||
      required.some((key) => !actual.includes(key))
    ) {
      return fail(code, `${label} has an invalid property set`);
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of actual) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return fail(code, `${label}.${key} must be an enumerable data property`);
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof AgentContractError) throw error;
    return fail(code, `${label} could not be validated`);
  }
}

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !identityPattern.test(value) ||
    utf8Encoder.encode(value).byteLength > 128
  ) {
    return fail("INVALID_REQUEST", `${label} is invalid`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0)
  ) {
    return fail("MALFORMED_EVENT", `${label} must be a safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  const result = safeInteger(value, label);
  if (result < 0) return fail("INVALID_REQUEST", `${label} must be non-negative`);
  return result;
}

function safeString(value: unknown, label: string, maxBytes = 4096): string {
  let hasIsolatedSurrogate = false;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          hasIsolatedSurrogate = true;
          break;
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        hasIsolatedSurrogate = true;
        break;
      }
    }
  }
  if (
    typeof value !== "string" ||
    utf8Encoder.encode(value).byteLength > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    hasIsolatedSurrogate
  ) {
    return fail("MALFORMED_EVENT", `${label} is not a safe string`);
  }
  return value;
}

function digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    return fail("MALFORMED_EVENT", `${label} is not a canonical SHA-256`);
  }
  return value as `sha256:${string}`;
}

export function parseCanonicalDecimalStringV1(
  value: unknown,
  label = "canonical decimal",
): string {
  if (
    typeof value !== "string" ||
    value === "-0" ||
    !canonicalDecimalPattern.test(value)
  ) {
    return fail("MALFORMED_EVENT", `${label} is not canonical decimal text`);
  }
  return value;
}

function cloneFreezeJson(
  value: unknown,
  label: string,
  seen = new Set<object>(),
): AgentJsonValueV1 {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return safeString(value, label);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      return fail("MALFORMED_EVENT", `${label} has an invalid number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    return fail("MALFORMED_EVENT", `${label} is not JSON data`);
  }
  if (seen.has(value)) return fail("MALFORMED_EVENT", `${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.getOwnPropertySymbols(value).length !== 0) {
        return fail("MALFORMED_EVENT", `${label} has unsupported properties`);
      }
      const result = value.map((_, index) => {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) {
          return fail("MALFORMED_EVENT", `${label} has an invalid array item`);
        }
        return cloneFreezeJson(descriptor.value, `${label}[${index}]`, seen);
      });
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail("MALFORMED_EVENT", `${label} must be a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return fail("MALFORMED_EVENT", `${label} has unsupported properties`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, AgentJsonValueV1> = Object.create(null);
    for (const key of Object.keys(descriptors)) {
      if (forbiddenObjectKeys.has(key)) {
        return fail("MALFORMED_EVENT", `${label} has a forbidden key`);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return fail("MALFORMED_EVENT", `${label}.${key} is not a data property`);
      }
      result[key] = cloneFreezeJson(descriptor.value, `${label}.${key}`, seen);
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function rejectReservedSourcePayloadKeys(
  value: unknown,
  label: string,
  seen = new Set<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return fail("MALFORMED_EVENT", `${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        rejectReservedSourcePayloadKeys(value[index], `${label}[${index}]`, seen);
      }
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const normalized = key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
      if (forbiddenSourcePayloadKeys.has(normalized)) {
        return fail("MALFORMED_EVENT", `${label} contains a reserved field`);
      }
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        return fail("MALFORMED_EVENT", `${label}.${key} is not a data property`);
      }
      rejectReservedSourcePayloadKeys(descriptor.value, `${label}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function parseSourceEventPayloadV1(
  type: AgentSourceEventTypeV1,
  value: unknown,
): AgentSourcePayloadByTypeV1[AgentSourceEventTypeV1] {
  rejectReservedSourcePayloadKeys(value, "SourceEvent.payload");
  switch (type) {
    case "message.delta": {
      const input = exactObject(
        value,
        ["text"],
        [],
        "SourceEvent.payload",
        "MALFORMED_EVENT",
      );
      return Object.freeze({
        text: safeString(input.text, "SourceEvent.payload.text"),
      });
    }
    case "citation.declared": {
      const input = exactObject(
        value,
        ["citationId", "source", "locator"],
        [],
        "SourceEvent.payload",
        "MALFORMED_EVENT",
      );
      const source = parseCitationSourceV1(input.source);
      const locator = parseCitationLocatorV1(source, input.locator);
      return Object.freeze({
        citationId: identity(input.citationId, "SourceEvent.payload.citationId"),
        source,
        locator,
      });
    }
    case "cancel.acknowledged": {
      const input = exactObject(
        value,
        ["acknowledged"],
        [],
        "SourceEvent.payload",
        "MALFORMED_EVENT",
      );
      if (input.acknowledged !== true) {
        return fail("MALFORMED_EVENT", "cancel acknowledgement is invalid");
      }
      return Object.freeze({ acknowledged: true as const });
    }
    case "run.completed": {
      const input = exactObject(
        value,
        ["finishReason"],
        [],
        "SourceEvent.payload",
        "MALFORMED_EVENT",
      );
      if (input.finishReason !== "completed") {
        return fail("MALFORMED_EVENT", "run completion reason is invalid");
      }
      return Object.freeze({ finishReason: "completed" as const });
    }
    case "run.failed": {
      const input = exactObject(
        value,
        ["failureKind"],
        [],
        "SourceEvent.payload",
        "MALFORMED_EVENT",
      );
      const failureKinds = [
        "upstream_timeout",
        "rate_limited",
        "adapter_unavailable",
        "stream_interrupted",
      ] as const;
      if (
        typeof input.failureKind !== "string" ||
        !failureKinds.includes(input.failureKind as (typeof failureKinds)[number])
      ) {
        return fail("MALFORMED_EVENT", "run failure kind is invalid");
      }
      return Object.freeze({
        failureKind: input.failureKind as (typeof failureKinds)[number],
      });
    }
  }
}

function parseDecodedAgentSourceEventV1(value: unknown): AgentSourceEventV1 {
  const input = exactObject(
    value,
    [
      "sourceSchemaVersion",
      "sourceCanonicalizationVersion",
      "sourceRunId",
      "sourceEventId",
      "sourceSequence",
      "sourcePayloadDigest",
      "type",
      "payload",
    ],
    ["sourceOccurredAt"],
    "SourceEvent",
    "MALFORMED_EVENT",
  );
  if (input.sourceSchemaVersion !== AGENT_SOURCE_EVENT_SCHEMA_VERSION_V1) {
    return fail("PROTOCOL_MISMATCH", "SourceEvent schema version is unavailable");
  }
  if (input.sourceCanonicalizationVersion !== AGENT_CANONICALIZATION_VERSION_V1) {
    return fail(
      "PROTOCOL_MISMATCH",
      "SourceEvent canonicalization version is unavailable",
    );
  }
  if (
    typeof input.type !== "string" ||
    input.type.length > 128 ||
    !AGENT_SOURCE_EVENT_TYPES_V1.includes(input.type as AgentSourceEventTypeV1)
  ) {
    return fail("MALFORMED_EVENT", "SourceEvent type is invalid");
  }
  const type = input.type as AgentSourceEventTypeV1;
  const payload = parseSourceEventPayloadV1(type, input.payload);
  const occurredAt =
    input.sourceOccurredAt === undefined
      ? undefined
      : safeString(input.sourceOccurredAt, "SourceEvent.sourceOccurredAt", 64);
  return Object.freeze({
    sourceSchemaVersion: AGENT_SOURCE_EVENT_SCHEMA_VERSION_V1,
    sourceCanonicalizationVersion: AGENT_CANONICALIZATION_VERSION_V1,
    sourceRunId: identity(input.sourceRunId, "SourceEvent.sourceRunId"),
    sourceEventId: identity(input.sourceEventId, "SourceEvent.sourceEventId"),
    sourceSequence: nonNegativeSafeInteger(
      input.sourceSequence,
      "SourceEvent.sourceSequence",
    ),
    sourcePayloadDigest: digest(
      input.sourcePayloadDigest,
      "SourceEvent.sourcePayloadDigest",
    ),
    ...(occurredAt === undefined ? {} : { sourceOccurredAt: occurredAt }),
    type,
    payload,
  }) as AgentSourceEventV1;
}

export const AGENT_SOURCE_FRAME_MAX_BYTES_V1 = 1_048_576;
export const AGENT_CANONICAL_PAYLOAD_MAX_BYTES_V1 = 1_048_576;
export const AGENT_SOURCE_FRAME_MAX_DEPTH_V1 = 64;
export const AGENT_SOURCE_FRAME_MAX_STRING_BYTES_V1 = 4_096;

export type StrictAgentFrameErrorCodeV1 =
  | "MALFORMED_EVENT"
  | "PROTOCOL_MISMATCH";

export class StrictAgentFrameError extends Error {
  readonly retryability = "never" as const;
  readonly recoveryAction = "none" as const;

  constructor(
    readonly code: StrictAgentFrameErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "StrictAgentFrameError";
  }
}

export type DecodedAgentSourceFrameV1 = Readonly<{
  event: AgentSourceEventV1;
  rawByteLength: number;
  rawSha256: `sha256:${string}`;
  canonicalPayloadBytes: readonly number[];
  recomputedSourcePayloadDigest: `sha256:${string}`;
}>;

export function enforceAgentCanonicalPayloadBudgetV1(byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > AGENT_CANONICAL_PAYLOAD_MAX_BYTES_V1
  ) {
    throw new StrictAgentFrameError(
      "MALFORMED_EVENT",
      "Source event canonical payload exceeds the limit",
    );
  }
}

export function decodeAgentSourceEventFrameV1(
  rawFrame: unknown,
): DecodedAgentSourceFrameV1 {
  try {
    const decoded = decodeAndHashStrictSourceFrameV1(rawFrame, {
      allowedTopLevelKeys: [
        "sourceSchemaVersion",
        "sourceCanonicalizationVersion",
        "sourceRunId",
        "sourceEventId",
        "sourceSequence",
        "sourcePayloadDigest",
        "sourceOccurredAt",
        "type",
        "payload",
      ],
      maxBytes: AGENT_SOURCE_FRAME_MAX_BYTES_V1,
      maxDepth: AGENT_SOURCE_FRAME_MAX_DEPTH_V1,
      maxStringBytes: AGENT_SOURCE_FRAME_MAX_STRING_BYTES_V1,
    });
    const event = parseDecodedAgentSourceEventV1(decoded.decoded);
    const canonicalPayload = canonicalizeAawJsonV1(event.payload);
    const canonicalPayloadBytes = new TextEncoder().encode(canonicalPayload);
    enforceAgentCanonicalPayloadBudgetV1(canonicalPayloadBytes.byteLength);
    const recomputedSourcePayloadDigest = sha256CanonicalAawJsonV1(event.payload);
    if (event.sourcePayloadDigest !== recomputedSourcePayloadDigest) {
      throw new StrictAgentFrameError(
        "PROTOCOL_MISMATCH",
        "Source payload digest does not match the canonical payload",
      );
    }
    return Object.freeze({
      event,
      rawByteLength: decoded.byteLength,
      rawSha256: decoded.rawSha256,
      canonicalPayloadBytes: Object.freeze(Array.from(canonicalPayloadBytes)),
      recomputedSourcePayloadDigest,
    });
  } catch (error: unknown) {
    if (error instanceof StrictAgentFrameError) throw error;
    if (error instanceof StrictSourceFrameError) {
      throw new StrictAgentFrameError(
        "MALFORMED_EVENT",
        "Source event frame is malformed",
      );
    }
    if (error instanceof AgentContractError && error.code === "PROTOCOL_MISMATCH") {
      throw new StrictAgentFrameError(
        "PROTOCOL_MISMATCH",
        "Source event protocol does not match",
      );
    }
    throw new StrictAgentFrameError(
      "MALFORMED_EVENT",
      "Source event frame could not be validated",
    );
  }
}

export function parseCitationSourceV1(value: unknown): CitationSourceV1 {
  const discriminator = exactObject(
    value,
    ["sourceKind"],
    [
      "documentId",
      "revisionId",
      "artifactId",
      "corpusId",
      "sourceId",
      "sourceRevisionId",
    ],
    "citation.source",
    "INVALID_REQUEST",
  );
  switch (discriminator.sourceKind) {
    case "document": {
      const input = exactObject(
        value,
        ["sourceKind", "documentId", "revisionId"],
        [],
        "citation.source",
        "INVALID_REQUEST",
      );
      return Object.freeze({
        sourceKind: "document" as const,
        documentId: identity(input.documentId, "citation.source.documentId"),
        revisionId: identity(input.revisionId, "citation.source.revisionId"),
      });
    }
    case "artifact":
    case "reviewed_schematic": {
      const input = exactObject(
        value,
        ["sourceKind", "artifactId", "revisionId"],
        [],
        "citation.source",
        "INVALID_REQUEST",
      );
      return Object.freeze({
        sourceKind: discriminator.sourceKind,
        artifactId: identity(input.artifactId, "citation.source.artifactId"),
        revisionId: identity(input.revisionId, "citation.source.revisionId"),
      });
    }
    case "rag_source": {
      const input = exactObject(
        value,
        ["sourceKind", "corpusId", "sourceId", "sourceRevisionId"],
        [],
        "citation.source",
        "INVALID_REQUEST",
      );
      return Object.freeze({
        sourceKind: "rag_source" as const,
        corpusId: identity(input.corpusId, "citation.source.corpusId"),
        sourceId: identity(input.sourceId, "citation.source.sourceId"),
        sourceRevisionId: identity(
          input.sourceRevisionId,
          "citation.source.sourceRevisionId",
        ),
      });
    }
    default:
      return fail("INVALID_REQUEST", "citation.sourceKind is invalid");
  }
}

function codePointSpan(value: unknown, label: string) {
  const input = exactObject(
    value,
    ["coordinateSystem", "start", "end"],
    [],
    label,
    "INVALID_REQUEST",
  );
  if (input.coordinateSystem !== "unicode_code_point") {
    return fail("INVALID_REQUEST", `${label}.coordinateSystem is invalid`);
  }
  const start = nonNegativeSafeInteger(input.start, `${label}.start`);
  const end = nonNegativeSafeInteger(input.end, `${label}.end`);
  if (start > end) return fail("INVALID_REQUEST", `${label} is reversed`);
  return Object.freeze({
    coordinateSystem: "unicode_code_point" as const,
    start,
    end,
  });
}

export function parseCitationLocatorV1(
  sourceValue: unknown,
  locatorValue: unknown,
): CitationLocatorV1 {
  const source = parseCitationSourceV1(sourceValue);
  const header = exactObject(
    locatorValue,
    ["locatorKind"],
    [
      "coordinateSystem",
      "start",
      "end",
      "occurrencePath",
      "definitionId",
      "elementKind",
      "elementId",
      "chunkId",
      "span",
    ],
    "citation.locator",
    "INVALID_REQUEST",
  );
  if (header.locatorKind === "whole_source") {
    exactObject(
      locatorValue,
      ["locatorKind"],
      [],
      "citation.locator",
      "INVALID_REQUEST",
    );
    return Object.freeze({ locatorKind: "whole_source" as const });
  }
  if (source.sourceKind === "document" && header.locatorKind === "text_range") {
    const input = exactObject(
      locatorValue,
      ["locatorKind", "coordinateSystem", "start", "end"],
      [],
      "citation.locator",
      "INVALID_REQUEST",
    );
    const span = codePointSpan(
      {
        coordinateSystem: input.coordinateSystem,
        start: input.start,
        end: input.end,
      },
      "citation.locator",
    );
    return Object.freeze({ locatorKind: "text_range" as const, ...span });
  }
  if (
    source.sourceKind === "reviewed_schematic" &&
    header.locatorKind === "schematic_element"
  ) {
    const input = exactObject(
      locatorValue,
      [
        "locatorKind",
        "occurrencePath",
        "definitionId",
        "elementKind",
        "elementId",
      ],
      [],
      "citation.locator",
      "INVALID_REQUEST",
    );
    if (!Array.isArray(input.occurrencePath) || input.occurrencePath.length > 32) {
      return fail("INVALID_REQUEST", "citation occurrencePath is invalid");
    }
    return Object.freeze({
      locatorKind: "schematic_element" as const,
      occurrencePath: Object.freeze(
        input.occurrencePath.map((item, index) =>
          identity(item, `citation.occurrencePath[${index}]`),
        ),
      ),
      definitionId: identity(input.definitionId, "citation.definitionId"),
      elementKind: identity(input.elementKind, "citation.elementKind"),
      elementId: identity(input.elementId, "citation.elementId"),
    });
  }
  if (source.sourceKind === "rag_source" && header.locatorKind === "rag_chunk") {
    const input = exactObject(
      locatorValue,
      ["locatorKind", "chunkId"],
      ["span"],
      "citation.locator",
      "INVALID_REQUEST",
    );
    const span =
      input.span === undefined
        ? undefined
        : codePointSpan(input.span, "citation.locator.span");
    return Object.freeze({
      locatorKind: "rag_chunk" as const,
      chunkId: identity(input.chunkId, "citation.chunkId"),
      ...(span === undefined ? {} : { span }),
    });
  }
  return fail("INVALID_REQUEST", "citation source/locator combination is invalid");
}
import {
  canonicalizeAawJsonV1,
  sha256CanonicalAawJsonV1,
} from "../../schematic-workbench/src/canonical-json";
import {
  decodeAndHashStrictSourceFrameV1,
  StrictSourceFrameError,
} from "../../schematic-workbench/src/strict-source-frame";
