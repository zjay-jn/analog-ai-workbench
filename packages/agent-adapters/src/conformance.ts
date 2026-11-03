import {
  AGENT_ERROR_CODES_V1,
  AGENT_WARNING_CODES_V1,
  LEGAL_RETRY_RECOVERY_PAIRS_V1,
  type AgentContractErrorCodeV1,
} from "./agent-contract";
import {
  canonicalizeAawJsonV1,
  sha256CanonicalAawJsonV1,
} from "../../schematic-workbench/src/canonical-json";
import {
  parseResolveArtifactRequestV1,
  parseResolveCitationRequestV1,
  parseResolveDocumentRequestV1,
} from "./public-contract";
import { parseCanonicalEventV1 } from "./canonical-contract";

export const CONFORMANCE_CONTRACT_VERSION_V1 =
  "aaw.agent.conformance/v1alpha1" as const;

export const CONFORMANCE_STAGES_V1 = Object.freeze([
  "P4-A",
  "P4-B",
  "P4-C",
  "P4-D",
] as const);

export const CONFORMANCE_HARNESSES_V1 = Object.freeze([
  "codec",
  "schema",
  "c14n",
  "reducer",
  "ledger_recovery",
  "build_gate",
  "surface_scan",
  "desktop_boundary",
  "electron_boundary",
] as const);

export type ConformanceStageV1 = (typeof CONFORMANCE_STAGES_V1)[number];
export type ConformanceHarnessV1 = (typeof CONFORMANCE_HARNESSES_V1)[number];
export type ConformanceStatusV1 = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export type ConformanceContractErrorCodeV1 =
  | "INVALID_VECTOR"
  | "TRACEABILITY_INCOMPLETE"
  | "TRACEABILITY_DUPLICATE";

export class ConformanceContractError extends Error {
  constructor(
    readonly code: ConformanceContractErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "ConformanceContractError";
  }
}

interface PureJsonArray extends ReadonlyArray<PureJson> {}

interface PureJsonObject {
  readonly [key: string]: PureJson;
}

type PureJson = null | boolean | number | string | PureJsonArray | PureJsonObject;

export type ConformanceVectorV1 = Readonly<{
  id: string;
  oracleId: string;
  contractVersion: typeof CONFORMANCE_CONTRACT_VERSION_V1;
  harness: ConformanceHarnessV1;
  requiredStage: ConformanceStageV1;
  negotiatedCapabilities: readonly string[];
  rawInput?: Readonly<{ utf8Hex: string } | { base64: string }>;
  jsonInput?: PureJson;
  preState?: PureJsonObject;
  steps?: readonly PureJson[];
  faultPoint?: string;
  scanTarget?: PureJson;
  expected: PureJsonObject;
}>;

export type ConformanceStateFixtureV1 = Readonly<{
  fixtureId: string;
  binding: Readonly<{
    adapterInstanceId: string;
    resumeEpoch: number;
    sourceRunId: string;
    sourceSchemaVersion: "aaw.agent.source-event/v1alpha1";
    sourceCanonicalizationVersion: "aaw-json-c14n/v1";
    callerScope: "authorized" | "unauthorized";
    documentId?: string;
    documentRevisionId?: string;
    documentKind?: "text" | "schematic_reviewed";
    artifactId?: string;
    artifactRevisionId?: string;
    artifactKind?: "circuit_ir_reviewed" | "generic";
    revisionAvailable?: boolean;
    revisionFreshness?: "current" | "historical";
    sourceLocatorValid?: boolean;
    intentAuthorized?: boolean;
    resolutionAvailable?: boolean;
  }>;
  run: Readonly<{
    hostRunId: string;
    hostSequence: number;
    terminal: boolean;
    quarantined: boolean;
    cursorVerified: boolean;
    resumeCapability: boolean;
    sideEffectState: "none" | "known_complete" | "unknown";
    ledgerIntegrity: "valid" | "corrupt";
    committedHead?: number;
    retentionFloor?: number;
    snapshotHead?: number;
    tailRegisteredAfter?: number;
    lifecycle?: "running" | "cancelling" | "terminal" | "quarantined";
    cancelCommandId?: string;
    cancelDeadlineMonotonicMs?: number;
    cancelDispatchState?: "none" | "pending" | "dispatched";
  }>;
  mappings: readonly PureJsonObject[];
  ledger: readonly PureJsonObject[];
  checkpoints: readonly PureJsonObject[];
  acks: readonly PureJsonObject[];
}>;

export type ConformanceTraceabilityManifestV1 = Readonly<{
  contractVersion: typeof CONFORMANCE_CONTRACT_VERSION_V1;
  stateFixtures: readonly ConformanceStateFixtureV1[];
  vectors: readonly ConformanceVectorV1[];
}>;

export type ConformanceVectorResultV1 = Readonly<{
  vectorId: string;
  harness: ConformanceHarnessV1;
  requiredStage: ConformanceStageV1;
  status: ConformanceStatusV1;
}>;

export type ConformanceResultReceiptV1 = Readonly<{
  contractVersion: typeof CONFORMANCE_CONTRACT_VERSION_V1;
  currentStage: ConformanceStageV1;
  results: readonly ConformanceVectorResultV1[];
}>;

export const AGENT_BUDGET_LIMITS_V1 = Object.freeze({
  raw_frame: 1_048_576,
  canonical_payload: 1_048_576,
  json_depth: 64,
  string_bytes: 4_096,
  run_events: 10_000,
  queued_events: 1_024,
  queued_bytes: 8_388_608,
  input_refs: 128,
  context_refs: 128,
  citations: 256,
  artifacts: 128,
  preview_code_points: 512,
  preview_utf8_bytes: 2_048,
} as const);

export type AgentBudgetNameV1 = keyof typeof AGENT_BUDGET_LIMITS_V1;
export type AgentBudgetBoundaryV1 = "limit-1" | "limit" | "limit+1";
export type AgentBudgetResumabilityV1 = Readonly<{
  currentEpoch: boolean;
  cursorVerified: boolean;
  resumeCapabilityNegotiated: boolean;
  noPendingOrUnknownSideEffects: boolean;
}>;

export type AgentBudgetInputV1 = Readonly<{
  budget: AgentBudgetNameV1;
  limit: number;
  observed: number;
  resumability?: AgentBudgetResumabilityV1;
}>;

export type AgentBudgetOutcomeV1 = Readonly<{
  decision: "pass" | "truncate" | "reject" | "isolate";
  errorCode?: AgentContractErrorCodeV1;
  retryability: "never" | "safe_resume";
  recoveryAction: "none" | "resume_from_cursor";
  warningCodes: readonly [];
  canonicalEvents: readonly [];
  mappingDelta: 0;
  ledgerDelta: 0;
  reducerDelta: 0;
  ackDelta: 0;
  quarantineState: "unchanged" | "active";
  rendererEmissions: 0;
  sideEffectCounters: Readonly<{
    toolBrokerInvocationCount: 0;
    capabilityGrantCount: 0;
    productDocumentFileMutationCount: 0;
    nativeSaveHelperCallCount: 0;
    oaEdaMutationCallCount: 0;
    externalNetworkCount: 0;
    processSpawnCount: 0;
    pythonBridgeCallCount: 0;
    credentialReadCount: 0;
  }>;
}>;

const ZERO_AGENT_SIDE_EFFECT_COUNTERS_V1 = Object.freeze({
  toolBrokerInvocationCount: 0 as const,
  capabilityGrantCount: 0 as const,
  productDocumentFileMutationCount: 0 as const,
  nativeSaveHelperCallCount: 0 as const,
  oaEdaMutationCallCount: 0 as const,
  externalNetworkCount: 0 as const,
  processSpawnCount: 0 as const,
  pythonBridgeCallCount: 0 as const,
  credentialReadCount: 0 as const,
});

function budgetOutcomeV1(
  decision: AgentBudgetOutcomeV1["decision"],
  options: Readonly<{
    errorCode?: AgentContractErrorCodeV1;
    retryability?: AgentBudgetOutcomeV1["retryability"];
    recoveryAction?: AgentBudgetOutcomeV1["recoveryAction"];
    quarantineState?: AgentBudgetOutcomeV1["quarantineState"];
  }> = {},
): AgentBudgetOutcomeV1 {
  return Object.freeze({
    decision,
    ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
    retryability: options.retryability ?? "never",
    recoveryAction: options.recoveryAction ?? "none",
    warningCodes: Object.freeze([] as const),
    canonicalEvents: Object.freeze([] as const),
    mappingDelta: 0 as const,
    ledgerDelta: 0 as const,
    reducerDelta: 0 as const,
    ackDelta: 0 as const,
    quarantineState: options.quarantineState ?? "unchanged",
    rendererEmissions: 0 as const,
    sideEffectCounters: ZERO_AGENT_SIDE_EFFECT_COUNTERS_V1,
  });
}

export function evaluateAgentBudgetBoundaryV1(
  input: AgentBudgetInputV1,
): AgentBudgetOutcomeV1 {
  const { budget, limit, observed, resumability } = input;
  if (!(budget in AGENT_BUDGET_LIMITS_V1)) {
    return fail("INVALID_VECTOR", "budget name is invalid");
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit !== AGENT_BUDGET_LIMITS_V1[budget] ||
    !Number.isSafeInteger(observed) ||
    observed < 0
  ) {
    return fail("INVALID_VECTOR", "budget limit or observed value is invalid");
  }
  const queued = budget === "queued_events" || budget === "queued_bytes";
  if (queued) {
    if (
      resumability === undefined ||
      Object.values(resumability).some((fact) => typeof fact !== "boolean")
    ) {
      return fail("INVALID_VECTOR", "queued budget requires resumability facts");
    }
  } else if (resumability !== undefined) {
    return fail("INVALID_VECTOR", "resumability is only valid for queued budgets");
  }
  if (observed <= limit) return budgetOutcomeV1("pass");
  if (budget === "preview_code_points" || budget === "preview_utf8_bytes") {
    return budgetOutcomeV1("truncate");
  }
  if (queued) {
    const safeResume =
      resumability!.currentEpoch &&
      resumability!.cursorVerified &&
      resumability!.resumeCapabilityNegotiated &&
      resumability!.noPendingOrUnknownSideEffects;
    return budgetOutcomeV1("reject", {
      errorCode: safeResume ? "STREAM_INTERRUPTED" : "RECOVERY_UNSUPPORTED",
      retryability: safeResume ? "safe_resume" : "never",
      recoveryAction: safeResume ? "resume_from_cursor" : "none",
    });
  }
  const errorCode: AgentContractErrorCodeV1 =
    budget === "input_refs" || budget === "context_refs"
      ? "INVALID_REQUEST"
      : "MALFORMED_EVENT";
  const isolate =
    budget === "raw_frame" || budget === "citations" || budget === "artifacts";
  return budgetOutcomeV1(isolate ? "isolate" : "reject", {
    errorCode,
    quarantineState: budget === "run_events" ? "active" : "unchanged",
  });
}

const stageOrder = new Map<ConformanceStageV1, number>(
  CONFORMANCE_STAGES_V1.map((stage, index) => [stage, index]),
);

function fail(code: ConformanceContractErrorCodeV1, message: string): never {
  throw new ConformanceContractError(code, message);
}

function plainSnapshot(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail("INVALID_VECTOR", `${label} must be a plain object`);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return fail("INVALID_VECTOR", `${label} must be a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return fail("INVALID_VECTOR", `${label} has unsupported properties`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const allowed = [...required, ...optional].sort();
    if (
      required.some((key) => !keys.includes(key)) ||
      keys.some((key) => !allowed.includes(key))
    ) {
      return fail("INVALID_VECTOR", `${label} has an invalid property set`);
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return fail("INVALID_VECTOR", `${label}.${key} is not a data property`);
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof ConformanceContractError) throw error;
    return fail("INVALID_VECTOR", `${label} could not be validated`);
  }
}

function cloneFreezeJson(value: unknown, label: string): PureJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      return fail("INVALID_VECTOR", `${label} has an invalid number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry, index) => cloneFreezeJson(entry, `${label}[${index}]`)),
    );
  }
  let keys: string[];
  try {
    keys = Object.keys(Object.getOwnPropertyDescriptors(value));
  } catch {
    return fail("INVALID_VECTOR", `${label} could not be validated`);
  }
  const snapshot = plainSnapshot(value, keys, [], label);
  const result: Record<string, PureJson> = Object.create(null);
  for (const [key, entry] of Object.entries(snapshot)) {
    result[key] = cloneFreezeJson(entry, `${label}.${key}`);
  }
  return Object.freeze(result);
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return fail("INVALID_VECTOR", `${label} must be a string array`);
  }
  if (new Set(value).size !== value.length) {
    return fail("INVALID_VECTOR", `${label} must not contain duplicates`);
  }
  return Object.freeze([...value]);
}

function parseRawInput(value: unknown) {
  const snapshot = plainSnapshot(value, [], ["utf8Hex", "base64"], "rawInput");
  const hasHex = typeof snapshot.utf8Hex === "string";
  const hasBase64 = typeof snapshot.base64 === "string";
  if (hasHex === hasBase64) {
    return fail("INVALID_VECTOR", "rawInput must select exactly one encoding");
  }
  if (hasHex) {
    if (!/^(?:[0-9a-f]{2})*$/u.test(snapshot.utf8Hex as string)) {
      return fail("INVALID_VECTOR", "rawInput.utf8Hex is invalid");
    }
    return Object.freeze({ utf8Hex: snapshot.utf8Hex as string });
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(snapshot.base64 as string)) {
    return fail("INVALID_VECTOR", "rawInput.base64 is invalid");
  }
  return Object.freeze({ base64: snapshot.base64 as string });
}

function parseSchemaInput(value: unknown): PureJsonObject {
  const header = plainSnapshot(
    value,
    ["schemaTarget"],
    [
      "value",
      "fieldPointer",
      "from",
      "to",
      "expectedInvocationCount",
      "api",
      "budget",
      "limit",
      "observed",
      "boundary",
      "resumability",
    ],
    "jsonInput",
  );
  switch (header.schemaTarget) {
    case "source_event": {
      const input = plainSnapshot(value, ["schemaTarget", "value"], [], "jsonInput");
      return Object.freeze({
        schemaTarget: "source_event",
        value: cloneFreezeJson(input.value, "jsonInput.value"),
      });
    }
    case "canonical_decimal": {
      const input = plainSnapshot(
        value,
        ["schemaTarget", "fieldPointer", "value"],
        [],
        "jsonInput",
      );
      if (
        input.fieldPointer !== "/payload/usage/inputTokens" ||
        typeof input.value !== "string"
      ) {
        return fail("INVALID_VECTOR", "canonical decimal schema input is invalid");
      }
      return Object.freeze({
        schemaTarget: "canonical_decimal",
        fieldPointer: input.fieldPointer,
        value: input.value,
      });
    }
    case "tool_transition": {
      const input = plainSnapshot(
        value,
        ["schemaTarget", "from", "to", "expectedInvocationCount"],
        [],
        "jsonInput",
      );
      if (
        typeof input.from !== "string" ||
        typeof input.to !== "string" ||
        input.expectedInvocationCount !== 0
      ) {
        return fail("INVALID_VECTOR", "tool transition schema input is invalid");
      }
      return Object.freeze({
        schemaTarget: "tool_transition",
        from: input.from,
        to: input.to,
        expectedInvocationCount: 0,
      });
    }
    case "resolve_request": {
      const input = plainSnapshot(
        value,
        ["schemaTarget", "api", "value"],
        [],
        "jsonInput",
      );
      if (
        typeof input.api !== "string" ||
        !["resolveDocument", "resolveArtifact", "resolveCitation"].includes(input.api)
      ) {
        return fail("INVALID_VECTOR", "resolve request schema input is invalid");
      }
      return Object.freeze({
        schemaTarget: "resolve_request",
        api: input.api,
        value: cloneFreezeJson(input.value, "jsonInput.value"),
      });
    }
    case "resolve_result": {
      const input = plainSnapshot(
        value,
        ["schemaTarget", "value"],
        [],
        "jsonInput",
      );
      return Object.freeze({
        schemaTarget: "resolve_result",
        value: cloneFreezeJson(input.value, "jsonInput.value"),
      });
    }
    case "canonical_event": {
      const input = plainSnapshot(
        value,
        ["schemaTarget", "value"],
        [],
        "jsonInput",
      );
      return Object.freeze({
        schemaTarget: "canonical_event",
        value: cloneFreezeJson(input.value, "jsonInput.value"),
      });
    }
    case "budget_contract": {
      const header = plainSnapshot(
        value,
        ["schemaTarget", "budget", "limit", "observed", "boundary"],
        ["resumability"],
        "jsonInput",
      );
      if (
        typeof header.budget !== "string" ||
        ![
          "raw_frame",
          "canonical_payload",
          "json_depth",
          "string_bytes",
          "run_events",
          "queued_events",
          "queued_bytes",
          "input_refs",
          "context_refs",
          "citations",
          "artifacts",
          "preview_code_points",
          "preview_utf8_bytes",
        ].includes(header.budget) ||
        typeof header.limit !== "number" ||
        !Number.isSafeInteger(header.limit) ||
        header.limit < 0 ||
        typeof header.observed !== "number" ||
        !Number.isSafeInteger(header.observed) ||
        header.observed < 0 ||
        !["limit-1", "limit", "limit+1"].includes(String(header.boundary))
      ) {
        return fail("INVALID_VECTOR", "budget schema input is invalid");
      }
      const budget = header.budget as AgentBudgetNameV1;
      if (header.limit !== AGENT_BUDGET_LIMITS_V1[budget]) {
        return fail("INVALID_VECTOR", "budget limit is not the frozen limit");
      }
      const boundary = header.boundary as AgentBudgetBoundaryV1;
      const expectedObserved =
        boundary === "limit-1"
          ? header.limit - 1
          : boundary === "limit"
            ? header.limit
            : header.limit + 1;
      if (header.observed !== expectedObserved) {
        return fail("INVALID_VECTOR", "budget observed value does not match boundary");
      }
      const queued = budget === "queued_events" || budget === "queued_bytes";
      let resumability: PureJsonObject | undefined;
      if (queued) {
        const facts = plainSnapshot(
          header.resumability,
          [
            "currentEpoch",
            "cursorVerified",
            "resumeCapabilityNegotiated",
            "noPendingOrUnknownSideEffects",
          ],
          [],
          "jsonInput.resumability",
        );
        if (Object.values(facts).some((fact) => typeof fact !== "boolean")) {
          return fail("INVALID_VECTOR", "budget resumability facts are invalid");
        }
        resumability = Object.freeze({ ...facts }) as PureJsonObject;
      } else if (header.resumability !== undefined) {
        return fail("INVALID_VECTOR", "budget resumability is not applicable");
      }
      return Object.freeze({
        schemaTarget: "budget_contract",
        budget,
        limit: header.limit,
        observed: header.observed,
        boundary,
        ...(resumability === undefined ? {} : { resumability }),
      });
    }
    default:
      return fail("INVALID_VECTOR", "jsonInput.schemaTarget is invalid");
  }
}

function parsePreState(value: unknown): PureJsonObject {
  const input = plainSnapshot(
    value,
    ["fixtureId", "hostSequence", "terminal", "quarantined"],
    [],
    "preState",
  );
  if (
    typeof input.fixtureId !== "string" ||
    !/^[a-z][a-z0-9._-]{0,127}$/u.test(input.fixtureId)
  ) {
    return fail("INVALID_VECTOR", "preState.fixtureId is invalid");
  }
  if (typeof input.terminal !== "boolean" || typeof input.quarantined !== "boolean") {
    return fail("INVALID_VECTOR", "preState flags are invalid");
  }
  return Object.freeze({
    fixtureId: input.fixtureId,
    hostSequence: nonNegativeCounter(input.hostSequence, "preState.hostSequence"),
    terminal: input.terminal,
    quarantined: input.quarantined,
  });
}

const stepActions = Object.freeze([
  "advance-monotonic-clock",
  "commit-live-tail",
  "commit-event",
  "drain-replay-tail",
  "fire-cancel-timeout",
  "open-agent-workspace-offline",
  "permute-source-occurred-at",
  "permute-wall-clock",
  "reduce-recovery",
  "request-cancel",
  "replay-exact-primary-key",
  "replay-old-epoch-source",
  "replay-preterminal-exact",
  "replay-primary-key-conflict",
  "replay-secondary-key-conflict",
  "resolve-cross-workspace",
  "resolve-historical-revision",
  "resolve-invalid-locator-with-denied-intent",
  "resolve-kind-corruption",
  "resolve-unavailable-exact-revision",
  "resolve-valid-locator-with-denied-intent",
  "restart",
  "resume-old-epoch-cursor",
  "resume-quarantined-run",
  "submit-cancel-ack",
  "submit-exact-replay",
  "submit-invalid-semantic-time",
  "submit-late-after-cancel",
  "submit-late-old-transport",
  "submit-new-post-terminal",
  "submit-unnegotiated-version",
  "subscribe-replay",
  "trigger-illegal-main-pair",
] as const);

function parseSteps(value: unknown): readonly PureJsonObject[] {
  if (!Array.isArray(value) || value.length === 0) {
    return fail("INVALID_VECTOR", "vector.steps must be a non-empty array");
  }
  return Object.freeze(
    value.map((step, index) => {
      const input = plainSnapshot(
        step,
        ["action"],
        [
          "sourceSequence",
          "sourceEventId",
          "afterHostSequence",
          "monotonicMs",
          "api",
          "request",
        ],
        `steps[${index}]`,
      );
      if (
        typeof input.action !== "string" ||
        !stepActions.includes(input.action as (typeof stepActions)[number])
      ) {
        return fail("INVALID_VECTOR", `steps[${index}].action is invalid`);
      }
      const action = input.action as string;
      const isResolve = action.startsWith("resolve-");
      const isReplaySubscription = action === "subscribe-replay";
      const sourceIdentityActions = [
        "commit-live-tail",
        "submit-cancel-ack",
        "submit-invalid-semantic-time",
        "submit-late-after-cancel",
      ];
      const sourceSequenceOnlyActions = [
        "commit-event",
        "permute-source-occurred-at",
        "permute-wall-clock",
        "reduce-recovery",
        "replay-exact-primary-key",
        "replay-old-epoch-source",
        "replay-preterminal-exact",
        "replay-primary-key-conflict",
        "replay-secondary-key-conflict",
        "resume-old-epoch-cursor",
        "resume-quarantined-run",
        "submit-exact-replay",
        "submit-late-old-transport",
        "submit-new-post-terminal",
        "submit-unnegotiated-version",
        "trigger-illegal-main-pair",
      ];
      const monotonicActions = [
        "request-cancel",
        "advance-monotonic-clock",
        "fire-cancel-timeout",
      ];
      const requiresSourceIdentity = sourceIdentityActions.includes(action);
      const requiresSourceSequenceOnly = sourceSequenceOnlyActions.includes(action);
      const requiresMonotonicMs = monotonicActions.includes(action);
      if (
        (isResolve &&
          (typeof input.api !== "string" || input.request === undefined)) ||
        (!isResolve && (input.api !== undefined || input.request !== undefined))
      ) {
        return fail("INVALID_VECTOR", `steps[${index}] resolve request is incomplete`);
      }
      if (!isReplaySubscription && input.afterHostSequence !== undefined) {
        return fail("INVALID_VECTOR", `steps[${index}] replay cursor is invalid`);
      }
      if (
        requiresSourceIdentity !==
          (input.sourceSequence !== undefined && input.sourceEventId !== undefined) ||
        (!requiresSourceIdentity && input.sourceEventId !== undefined) ||
        requiresSourceSequenceOnly !==
          (!requiresSourceIdentity && input.sourceSequence !== undefined)
      ) {
        return fail("INVALID_VECTOR", `steps[${index}] source identity fields are invalid`);
      }
      if (requiresMonotonicMs !== (input.monotonicMs !== undefined)) {
        return fail("INVALID_VECTOR", `steps[${index}].monotonicMs is invalid`);
      }
      let parsedRequest: unknown;
      if (isResolve) {
        switch (input.api) {
          case "resolveDocument":
            parsedRequest = parseResolveDocumentRequestV1(input.request);
            break;
          case "resolveArtifact":
            parsedRequest = parseResolveArtifactRequestV1(input.request);
            break;
          case "resolveCitation":
            parsedRequest = parseResolveCitationRequestV1(input.request);
            break;
          default:
            return fail("INVALID_VECTOR", `steps[${index}].api is invalid`);
        }
      }
      return Object.freeze({
        action: input.action,
        ...(input.sourceSequence === undefined
          ? {}
          : {
              sourceSequence: nonNegativeCounter(
                input.sourceSequence,
                `steps[${index}].sourceSequence`,
              ),
            }),
        ...(input.sourceEventId === undefined
          ? {}
          : {
              sourceEventId: conformanceIdentity(
                input.sourceEventId,
                `steps[${index}].sourceEventId`,
              ),
            }),
        ...(isReplaySubscription
          ? {
              afterHostSequence:
                input.afterHostSequence === undefined
                  ? 0
                  : nonNegativeCounter(
                      input.afterHostSequence,
                      `steps[${index}].afterHostSequence`,
                    ),
            }
          : {}),
        ...(input.monotonicMs === undefined
          ? {}
          : {
              monotonicMs: nonNegativeCounter(
                input.monotonicMs,
                `steps[${index}].monotonicMs`,
              ),
            }),
        ...(isResolve
          ? {
              api: input.api as string,
              request: cloneFreezeJson(parsedRequest, `steps[${index}].request`),
            }
          : {}),
      });
    }),
  );
}

function parseScanTarget(value: unknown): PureJsonObject {
  const input = plainSnapshot(value, ["profile", "target"], [], "scanTarget");
  if (
    typeof input.profile !== "string" ||
    !["production", "development_test", "public"].includes(input.profile) ||
    typeof input.target !== "string" ||
    !/^[a-z][a-z0-9._-]{0,127}$/u.test(input.target)
  ) {
    return fail("INVALID_VECTOR", "scanTarget is invalid");
  }
  return Object.freeze({ profile: input.profile, target: input.target });
}

function parseCanonicalEvents(value: unknown): readonly PureJsonObject[] {
  if (!Array.isArray(value)) {
    return fail("INVALID_VECTOR", "expected.canonicalEvents must be an array");
  }
  return Object.freeze(
    value.map((entry, index) => {
      const header = plainSnapshot(
        entry,
        [],
        [
          "type",
          "hostRunId",
          "eventId",
          "hostSequence",
          "acceptedAt",
          "canonicalPayloadDigest",
          "canonicalUtf8Hex",
        ],
        `expected.canonicalEvents[${index}]`,
      );
      const eventFields = [
        "type",
        "hostRunId",
        "eventId",
        "hostSequence",
        "acceptedAt",
        "canonicalPayloadDigest",
      ];
      const isEvent = eventFields.every((field) => header[field] !== undefined);
      const isC14n =
        typeof header.canonicalUtf8Hex === "string" &&
        eventFields.every((field) => header[field] === undefined);
      if (isC14n === isEvent) {
        return fail("INVALID_VECTOR", "canonical event oracle is invalid");
      }
      if (isC14n) {
        if (!/^(?:[0-9a-f]{2})+$/u.test(header.canonicalUtf8Hex as string)) {
          return fail("INVALID_VECTOR", "canonicalUtf8Hex is invalid");
        }
        return Object.freeze({ canonicalUtf8Hex: header.canonicalUtf8Hex as string });
      }
      if (
        typeof header.type !== "string" ||
        !["run.accepted", "message.delta", "citation.declared", "run.completed", "run.failed", "run.cancelled"].includes(header.type) ||
        typeof header.hostRunId !== "string" ||
        typeof header.eventId !== "string" ||
        typeof header.acceptedAt !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(header.canonicalPayloadDigest)) ||
        typeof header.canonicalUtf8Hex !== "string" ||
        !/^(?:[0-9a-f]{2})+$/u.test(header.canonicalUtf8Hex)
      ) {
        return fail("INVALID_VECTOR", "canonical event type is invalid");
      }
      assertCanonicalEventOracleV1(header, `expected.canonicalEvents[${index}]`);
      return Object.freeze({
        type: header.type,
        hostRunId: header.hostRunId,
        eventId: header.eventId,
        hostSequence: nonNegativeCounter(
          header.hostSequence,
          "canonical event hostSequence",
        ),
        acceptedAt: header.acceptedAt,
        canonicalPayloadDigest: header.canonicalPayloadDigest,
        canonicalUtf8Hex: header.canonicalUtf8Hex,
      });
    }),
  );
}

const commonRequired = [
  "id",
  "oracleId",
  "contractVersion",
  "harness",
  "requiredStage",
  "negotiatedCapabilities",
  "expected",
] as const;

const fieldsByHarness: Readonly<
  Record<
    ConformanceHarnessV1,
    Readonly<{ required: readonly string[]; optional: readonly string[] }>
  >
> =
  Object.freeze({
    codec: { required: ["rawInput"], optional: [] },
    schema: { required: ["jsonInput"], optional: [] },
    c14n: { required: [], optional: ["rawInput", "jsonInput"] },
    reducer: { required: ["preState", "steps"], optional: [] },
    ledger_recovery: {
      required: ["preState", "steps", "faultPoint"],
      optional: [],
    },
    build_gate: { required: ["scanTarget"], optional: [] },
    surface_scan: { required: ["scanTarget"], optional: [] },
    desktop_boundary: { required: ["preState", "steps"], optional: [] },
    electron_boundary: { required: ["preState", "steps"], optional: [] },
  });

const expectedStateFields = Object.freeze([
  "decision",
  "errorCode",
  "retryability",
  "recoveryAction",
  "warningCodes",
  "canonicalBytesSha256",
  "canonicalEvents",
  "mappingDelta",
  "ledgerDelta",
  "reducerDelta",
  "ackDelta",
  "quarantineState",
  "rendererEmissions",
  "sideEffectCounters",
] as const);

const addendumExpectedFields = Object.freeze([
  "cancelDispatchDelta",
  "postCancelCommandId",
  "postCancelDeadlineMonotonicMs",
  "postCancelDispatchState",
  "checkpointDelta",
  "ackPersistDelta",
  "mappingRows",
  "checkpointRows",
  "ackRows",
  "deliveryHostSequences",
  "subscriptionDisposition",
  "postRunLifecycle",
] as const);

const sideEffectCounterFields = Object.freeze([
  "toolBrokerInvocationCount",
  "capabilityGrantCount",
  "productDocumentFileMutationCount",
  "nativeSaveHelperCallCount",
  "oaEdaMutationCallCount",
  "externalNetworkCount",
  "processSpawnCount",
  "pythonBridgeCallCount",
  "credentialReadCount",
] as const);

const processOrRequestCounterFields = Object.freeze([
  "requestCount",
  "successCount",
  "rejectedCount",
  "deliveryCount",
  "registryMutationCount",
  "fileReadCount",
] as const);

function nonNegativeCounter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("INVALID_VECTOR", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function conformanceIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^(?!latest$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return fail("INVALID_VECTOR", `${label} is invalid`);
  }
  return value;
}

function parseStateFixture(value: unknown): ConformanceStateFixtureV1 {
  const input = plainSnapshot(
    value,
    ["fixtureId", "binding", "run", "mappings", "ledger"],
    ["checkpoints", "acks"],
    "stateFixture",
  );
  const fixtureId = conformanceIdentity(input.fixtureId, "stateFixture.fixtureId");
  const binding = plainSnapshot(
    input.binding,
    [
      "adapterInstanceId",
      "resumeEpoch",
      "sourceRunId",
      "sourceSchemaVersion",
      "sourceCanonicalizationVersion",
      "callerScope",
    ],
    [
      "documentId",
      "documentRevisionId",
      "documentKind",
      "artifactId",
      "artifactRevisionId",
      "artifactKind",
      "revisionAvailable",
      "revisionFreshness",
      "sourceLocatorValid",
      "intentAuthorized",
      "resolutionAvailable",
    ],
    `${fixtureId}.binding`,
  );
  if (
    binding.sourceSchemaVersion !== "aaw.agent.source-event/v1alpha1" ||
    binding.sourceCanonicalizationVersion !== "aaw-json-c14n/v1" ||
    (binding.callerScope !== "authorized" && binding.callerScope !== "unauthorized")
  ) {
    return fail("INVALID_VECTOR", `${fixtureId}.binding is invalid`);
  }
  const hasDocument =
    binding.documentId !== undefined ||
    binding.documentRevisionId !== undefined ||
    binding.documentKind !== undefined;
  const hasArtifact =
    binding.artifactId !== undefined ||
    binding.artifactRevisionId !== undefined ||
    binding.artifactKind !== undefined;
  if (
    hasDocument !==
      (binding.documentId !== undefined &&
        binding.documentRevisionId !== undefined &&
        ["text", "schematic_reviewed"].includes(String(binding.documentKind))) ||
    hasArtifact !==
      (binding.artifactId !== undefined &&
        binding.artifactRevisionId !== undefined &&
        ["circuit_ir_reviewed", "generic"].includes(String(binding.artifactKind))) ||
    (binding.revisionAvailable !== undefined &&
      typeof binding.revisionAvailable !== "boolean") ||
    (binding.revisionFreshness !== undefined &&
      !["current", "historical"].includes(String(binding.revisionFreshness))) ||
    (binding.sourceLocatorValid !== undefined &&
      typeof binding.sourceLocatorValid !== "boolean") ||
    (binding.intentAuthorized !== undefined &&
      typeof binding.intentAuthorized !== "boolean") ||
    (binding.resolutionAvailable !== undefined &&
      typeof binding.resolutionAvailable !== "boolean")
  ) {
    return fail("INVALID_VECTOR", `${fixtureId}.binding identity is incomplete`);
  }
  const run = plainSnapshot(
    input.run,
    [
      "hostRunId",
      "hostSequence",
      "terminal",
      "quarantined",
      "cursorVerified",
      "resumeCapability",
      "sideEffectState",
      "ledgerIntegrity",
    ],
    [
      "committedHead",
      "retentionFloor",
      "snapshotHead",
      "tailRegisteredAfter",
      "lifecycle",
      "cancelCommandId",
      "cancelDeadlineMonotonicMs",
      "cancelDispatchState",
    ],
    `${fixtureId}.run`,
  );
  if (
    typeof run.terminal !== "boolean" ||
    typeof run.quarantined !== "boolean" ||
    typeof run.cursorVerified !== "boolean" ||
    typeof run.resumeCapability !== "boolean" ||
    !["none", "known_complete", "unknown"].includes(String(run.sideEffectState)) ||
    !["valid", "corrupt"].includes(String(run.ledgerIntegrity)) ||
    (run.lifecycle !== undefined &&
      !["running", "cancelling", "terminal", "quarantined"].includes(
        String(run.lifecycle),
      )) ||
    (run.cancelDispatchState !== undefined &&
      !["none", "pending", "dispatched"].includes(
        String(run.cancelDispatchState),
      )) ||
    (run.cancelCommandId !== undefined && typeof run.cancelCommandId !== "string")
  ) {
    return fail("INVALID_VECTOR", `${fixtureId}.run is invalid`);
  }
  if (
    !Array.isArray(input.mappings) ||
    !Array.isArray(input.ledger) ||
    (input.checkpoints !== undefined && !Array.isArray(input.checkpoints)) ||
    (input.acks !== undefined && !Array.isArray(input.acks))
  ) {
    return fail("INVALID_VECTOR", `${fixtureId} state rows are invalid`);
  }
  const mappings = input.mappings.map((entry, index) => {
    const row = plainSnapshot(
      entry,
      [
        "sourceEventId",
        "sourceSequence",
        "eventType",
        "sourcePayloadDigest",
        "eventId",
        "hostSequence",
      ],
      [],
      `${fixtureId}.mappings[${index}]`,
    );
    if (
      typeof row.eventType !== "string" ||
      !["message.delta", "citation.declared", "cancel.acknowledged", "run.completed", "run.failed"].includes(row.eventType) ||
      typeof row.sourcePayloadDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(row.sourcePayloadDigest)
    ) {
      return fail("INVALID_VECTOR", `${fixtureId} mapping row is invalid`);
    }
    return Object.freeze({
      sourceEventId: conformanceIdentity(row.sourceEventId, "mapping.sourceEventId"),
      sourceSequence: nonNegativeCounter(row.sourceSequence, "mapping.sourceSequence"),
      eventType: row.eventType,
      sourcePayloadDigest: row.sourcePayloadDigest,
      eventId: conformanceIdentity(row.eventId, "mapping.eventId"),
      hostSequence: nonNegativeCounter(row.hostSequence, "mapping.hostSequence"),
    });
  });
  const ledger = input.ledger.map((entry, index) => {
    const row = plainSnapshot(
      entry,
      [
        "hostRunId",
        "eventId",
        "hostSequence",
        "acceptedAt",
        "type",
        "canonicalPayloadDigest",
        "canonicalUtf8Hex",
      ],
      [],
      `${fixtureId}.ledger[${index}]`,
    );
    if (
      typeof row.type !== "string" ||
      !["run.accepted", "message.delta", "citation.declared", "run.completed", "run.failed", "run.cancelled"].includes(row.type) ||
      typeof row.canonicalPayloadDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(row.canonicalPayloadDigest) ||
      typeof row.canonicalUtf8Hex !== "string" ||
      !/^(?:[0-9a-f]{2})+$/u.test(row.canonicalUtf8Hex) ||
      typeof row.acceptedAt !== "string"
    ) {
      return fail("INVALID_VECTOR", `${fixtureId} ledger row is invalid`);
    }
    assertCanonicalEventOracleV1(row, `${fixtureId}.ledger[${index}]`);
    return Object.freeze({
      hostRunId: conformanceIdentity(row.hostRunId, "ledger.hostRunId"),
      eventId: conformanceIdentity(row.eventId, "ledger.eventId"),
      hostSequence: nonNegativeCounter(row.hostSequence, "ledger.hostSequence"),
      acceptedAt: row.acceptedAt,
      type: row.type,
      canonicalPayloadDigest: row.canonicalPayloadDigest,
      canonicalUtf8Hex: row.canonicalUtf8Hex,
    });
  });
  const hostSequence = nonNegativeCounter(run.hostSequence, `${fixtureId}.run.hostSequence`);
  const optionalRunCounters = Object.freeze({
    ...(run.committedHead === undefined
      ? {}
      : {
          committedHead: nonNegativeCounter(
            run.committedHead,
            `${fixtureId}.run.committedHead`,
          ),
        }),
    ...(run.retentionFloor === undefined
      ? {}
      : {
          retentionFloor: nonNegativeCounter(
            run.retentionFloor,
            `${fixtureId}.run.retentionFloor`,
          ),
        }),
    ...(run.snapshotHead === undefined
      ? {}
      : {
          snapshotHead: nonNegativeCounter(
            run.snapshotHead,
            `${fixtureId}.run.snapshotHead`,
          ),
        }),
    ...(run.tailRegisteredAfter === undefined
      ? {}
      : {
          tailRegisteredAfter: nonNegativeCounter(
            run.tailRegisteredAfter,
            `${fixtureId}.run.tailRegisteredAfter`,
          ),
        }),
    ...(run.cancelDeadlineMonotonicMs === undefined
      ? {}
      : {
          cancelDeadlineMonotonicMs: nonNegativeCounter(
            run.cancelDeadlineMonotonicMs,
            `${fixtureId}.run.cancelDeadlineMonotonicMs`,
          ),
        }),
  });
  if (
    (optionalRunCounters.committedHead !== undefined &&
      optionalRunCounters.committedHead !== hostSequence) ||
    (optionalRunCounters.retentionFloor !== undefined &&
      optionalRunCounters.committedHead !== undefined &&
      optionalRunCounters.retentionFloor > optionalRunCounters.committedHead) ||
    (optionalRunCounters.snapshotHead !== undefined &&
      optionalRunCounters.committedHead !== undefined &&
      optionalRunCounters.snapshotHead > optionalRunCounters.committedHead) ||
    (optionalRunCounters.tailRegisteredAfter !== undefined &&
      optionalRunCounters.snapshotHead !== undefined &&
      optionalRunCounters.tailRegisteredAfter !== optionalRunCounters.snapshotHead)
  ) {
    return fail("INVALID_VECTOR", `${fixtureId}.run replay state is inconsistent`);
  }
  const parseCommitRows = (value: unknown, label: "checkpoints" | "acks") =>
    (value === undefined ? [] : (value as unknown[])).map((entry, index) => {
      const row = plainSnapshot(
        entry,
        ["hostRunId", "eventId", "hostSequence", "resumeEpoch"],
        [],
        `${fixtureId}.${label}[${index}]`,
      );
      return Object.freeze({
        hostRunId: conformanceIdentity(row.hostRunId, `${label}.hostRunId`),
        eventId: conformanceIdentity(row.eventId, `${label}.eventId`),
        hostSequence: nonNegativeCounter(row.hostSequence, `${label}.hostSequence`),
        resumeEpoch: nonNegativeCounter(row.resumeEpoch, `${label}.resumeEpoch`),
      });
    });
  const checkpoints = parseCommitRows(input.checkpoints, "checkpoints");
  const acks = parseCommitRows(input.acks, "acks");
  const committedEvents = ledger.filter((row) => row.type !== "run.accepted");
  const hasMismatch =
    ledger.some(
      (row, index) =>
        row.hostSequence !== index + 1 || row.hostRunId !== run.hostRunId,
    ) ||
    (ledger.length > 0 && ledger.length !== hostSequence) ||
    new Set(ledger.map((row) => row.eventId)).size !== ledger.length ||
    new Set(mappings.map((row) => row.eventId)).size !== mappings.length ||
    mappings.some(
      (row) =>
        !committedEvents.some(
          (event) =>
            event.eventId === row.eventId &&
            event.hostSequence === row.hostSequence,
        ),
    ) ||
    committedEvents.some(
      (event) =>
        !mappings.some(
          (row) =>
            row.eventId === event.eventId &&
            row.hostSequence === event.hostSequence,
        ),
    ) ||
    checkpoints.some(
      (row) =>
        row.resumeEpoch !== binding.resumeEpoch ||
        !ledger.some(
          (event) =>
            event.hostRunId === row.hostRunId &&
            event.eventId === row.eventId &&
            event.hostSequence === row.hostSequence,
        ),
    ) ||
    acks.some(
      (row) =>
        row.resumeEpoch !== binding.resumeEpoch ||
        !checkpoints.some(
          (checkpoint) =>
            checkpoint.hostRunId === row.hostRunId &&
            checkpoint.eventId === row.eventId &&
            checkpoint.hostSequence === row.hostSequence &&
            checkpoint.resumeEpoch === row.resumeEpoch,
        ),
    );
  if (
    (run.ledgerIntegrity === "valid" && hasMismatch) ||
    (run.ledgerIntegrity === "corrupt" && !hasMismatch)
  ) {
    return fail("INVALID_VECTOR", `${fixtureId} mapping/ledger is inconsistent`);
  }
  const bindingResult = Object.freeze({
    adapterInstanceId: conformanceIdentity(binding.adapterInstanceId, "binding.adapterInstanceId"),
    resumeEpoch: nonNegativeCounter(binding.resumeEpoch, "binding.resumeEpoch"),
    sourceRunId: conformanceIdentity(binding.sourceRunId, "binding.sourceRunId"),
    sourceSchemaVersion: "aaw.agent.source-event/v1alpha1" as const,
    sourceCanonicalizationVersion: "aaw-json-c14n/v1" as const,
    callerScope: binding.callerScope,
    ...(hasDocument
      ? {
          documentId: conformanceIdentity(binding.documentId, "binding.documentId"),
          documentRevisionId: conformanceIdentity(
            binding.documentRevisionId,
            "binding.documentRevisionId",
          ),
          documentKind: binding.documentKind as "text" | "schematic_reviewed",
        }
      : {}),
    ...(hasArtifact
      ? {
          artifactId: conformanceIdentity(binding.artifactId, "binding.artifactId"),
          artifactRevisionId: conformanceIdentity(
            binding.artifactRevisionId,
            "binding.artifactRevisionId",
          ),
          artifactKind: binding.artifactKind as "circuit_ir_reviewed" | "generic",
        }
      : {}),
    ...(binding.revisionAvailable === undefined
      ? {}
      : { revisionAvailable: binding.revisionAvailable }),
    ...(binding.revisionFreshness === undefined
      ? {}
      : {
          revisionFreshness: binding.revisionFreshness as
            | "current"
            | "historical",
        }),
    ...(binding.sourceLocatorValid === undefined
      ? {}
      : { sourceLocatorValid: binding.sourceLocatorValid }),
    ...(binding.intentAuthorized === undefined
      ? {}
      : { intentAuthorized: binding.intentAuthorized }),
    ...(binding.resolutionAvailable === undefined
      ? {}
      : { resolutionAvailable: binding.resolutionAvailable }),
  });
  const lifecycle =
    run.lifecycle === "running" ||
    run.lifecycle === "cancelling" ||
    run.lifecycle === "terminal" ||
    run.lifecycle === "quarantined"
      ? run.lifecycle
      : undefined;
  const cancelDispatchState =
    run.cancelDispatchState === "none" ||
    run.cancelDispatchState === "pending" ||
    run.cancelDispatchState === "dispatched"
      ? run.cancelDispatchState
      : undefined;
  const hasCancelCommand = run.cancelCommandId !== undefined;
  const hasCancellationDeadline =
    run.cancelDeadlineMonotonicMs !== undefined;
  if (
    (lifecycle === "cancelling" &&
      (!hasCancelCommand ||
        !hasCancellationDeadline ||
        !["pending", "dispatched"].includes(String(cancelDispatchState)))) ||
    (lifecycle !== "cancelling" &&
      (hasCancelCommand ||
        hasCancellationDeadline ||
        (cancelDispatchState !== undefined && cancelDispatchState !== "none"))) ||
    (lifecycle === undefined && cancelDispatchState === "none")
  ) {
    return fail("INVALID_VECTOR", `${fixtureId}.run cancel state is inconsistent`);
  }
  return Object.freeze({
    fixtureId,
    binding: bindingResult,
    run: Object.freeze({
      hostRunId: conformanceIdentity(run.hostRunId, "run.hostRunId"),
      hostSequence,
      terminal: run.terminal,
      quarantined: run.quarantined,
      cursorVerified: run.cursorVerified,
      resumeCapability: run.resumeCapability,
      sideEffectState: run.sideEffectState,
      ledgerIntegrity: run.ledgerIntegrity,
      ...optionalRunCounters,
      ...(lifecycle === undefined ? {} : { lifecycle }),
      ...(run.cancelCommandId === undefined
        ? {}
        : {
            cancelCommandId: conformanceIdentity(
              run.cancelCommandId,
              `${fixtureId}.run.cancelCommandId`,
            ),
          }),
      ...(cancelDispatchState === undefined ? {} : { cancelDispatchState }),
    }),
    mappings: Object.freeze(mappings),
    ledger: Object.freeze(ledger),
    checkpoints: Object.freeze(checkpoints),
    acks: Object.freeze(acks),
  }) as ConformanceStateFixtureV1;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const utf8Encoder = new TextEncoder();

function assertCanonicalEventOracleV1(
  row: Readonly<Record<string, unknown>>,
  label: string,
): void {
  try {
    const hex = String(row.canonicalUtf8Hex);
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const text = utf8Decoder.decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    const event = parseCanonicalEventV1(parsed);
    if (
      event.type !== row.type ||
      event.hostRunId !== row.hostRunId ||
      event.eventId !== row.eventId ||
      event.hostSequence !== row.hostSequence ||
      event.acceptedAt !== row.acceptedAt ||
      event.canonicalPayloadDigest !== row.canonicalPayloadDigest
    ) {
      return fail("INVALID_VECTOR", `${label} metadata does not match canonical bytes`);
    }
    if (sha256CanonicalAawJsonV1(event.payload) !== row.canonicalPayloadDigest) {
      return fail("INVALID_VECTOR", `${label} payload digest is inconsistent`);
    }
    const canonical = canonicalizeAawJsonV1(parsed);
    if (
      Buffer.from(utf8Encoder.encode(canonical)).toString("hex") !== hex
    ) {
      return fail("INVALID_VECTOR", `${label} bytes are not canonical`);
    }
  } catch (error: unknown) {
    if (error instanceof ConformanceContractError) throw error;
    return fail("INVALID_VECTOR", `${label} canonical bytes are invalid`);
  }
}

function parseExactCounters(
  value: unknown,
  fields: readonly string[],
  label: string,
): PureJsonObject {
  const input = plainSnapshot(value, fields, [], label);
  const result: Record<string, number> = Object.create(null);
  for (const field of fields) {
    result[field] = nonNegativeCounter(input[field], `${label}.${field}`);
  }
  return Object.freeze(result);
}

function parseExpected(
  value: unknown,
  harness: ConformanceHarnessV1,
  steps: readonly PureJsonObject[] | undefined,
): PureJsonObject {
  const staticHarness = harness === "build_gate" || harness === "surface_scan";
  const required = staticHarness
    ? ["decision", "sideEffectCounters", "processOrRequestCounters"]
    : expectedStateFields.filter(
        (field) => field !== "errorCode" && field !== "canonicalBytesSha256",
      );
  const optional = staticHarness
    ? []
    : [
        "errorCode",
        "canonicalBytesSha256",
        "freshness",
        ...addendumExpectedFields,
        ...(harness === "desktop_boundary" || harness === "electron_boundary"
          ? ["processOrRequestCounters"]
          : []),
      ];
  const input = plainSnapshot(value, required, optional, "expected");
  let validatedMappingRows: readonly PureJsonObject[] | undefined;
  let validatedCheckpointRows: readonly PureJsonObject[] | undefined;
  let validatedAckRows: readonly PureJsonObject[] | undefined;
  const actions = new Set(
    (steps ?? []).map((step) => String(step.action)),
  );
  const hasReplayAction = [
    "subscribe-replay",
    "commit-live-tail",
    "drain-replay-tail",
  ].some((action) => actions.has(action));
  const hasCancelAction = [
    "request-cancel",
    "advance-monotonic-clock",
    "fire-cancel-timeout",
    "submit-cancel-ack",
    "submit-late-after-cancel",
  ].some((action) => actions.has(action));
  const allowsCheckpointAck =
    harness === "ledger_recovery" ||
    actions.has("commit-live-tail") ||
    actions.has("submit-cancel-ack");
  const allowsExactMappingRows =
    actions.has("commit-live-tail") || actions.has("submit-cancel-ack");
  const requiresPostCancelState =
    actions.has("request-cancel") &&
    typeof input.cancelDispatchDelta === "number" &&
    Number.isSafeInteger(input.cancelDispatchDelta) &&
    input.cancelDispatchDelta > 0;
  if (
    (!hasReplayAction &&
      (input.deliveryHostSequences !== undefined ||
        input.subscriptionDisposition !== undefined)) ||
    (hasReplayAction &&
      (input.deliveryHostSequences === undefined ||
        input.subscriptionDisposition === undefined)) ||
    (!hasCancelAction &&
      (input.cancelDispatchDelta !== undefined ||
        input.postRunLifecycle !== undefined)) ||
    (hasCancelAction &&
      (input.cancelDispatchDelta === undefined ||
        input.postRunLifecycle === undefined)) ||
    (!allowsCheckpointAck &&
      (input.checkpointDelta !== undefined ||
        input.ackPersistDelta !== undefined ||
        input.checkpointRows !== undefined ||
        input.ackRows !== undefined)) ||
    (allowsCheckpointAck &&
      (input.checkpointDelta === undefined ||
        input.ackPersistDelta === undefined ||
        input.checkpointRows === undefined ||
        input.ackRows === undefined)) ||
    (requiresPostCancelState &&
      (input.postCancelCommandId === undefined ||
        input.postCancelDeadlineMonotonicMs === undefined ||
        input.postCancelDispatchState === undefined)) ||
    (!requiresPostCancelState &&
      (input.postCancelCommandId !== undefined ||
        input.postCancelDeadlineMonotonicMs !== undefined ||
        input.postCancelDispatchState !== undefined)) ||
    (!allowsExactMappingRows && input.mappingRows !== undefined)
  ) {
    return fail("INVALID_VECTOR", "expected fields do not match the action family");
  }
  if (
    typeof input.decision !== "string" ||
    !["accept", "reject", "pass", "truncate", "block", "isolate"].includes(input.decision)
  ) {
    return fail("INVALID_VECTOR", "expected.decision is invalid");
  }
  if (
    input.errorCode !== undefined &&
    (typeof input.errorCode !== "string" ||
      !AGENT_ERROR_CODES_V1.includes(
        input.errorCode as (typeof AGENT_ERROR_CODES_V1)[number],
      ))
  ) {
    return fail("INVALID_VECTOR", "expected.errorCode is invalid");
  }
  if (
    input.freshness !== undefined &&
    !["current", "historical"].includes(String(input.freshness))
  ) {
    return fail("INVALID_VECTOR", "expected.freshness is invalid");
  }
  if (
    !staticHarness &&
    ["reject", "block", "isolate"].includes(input.decision as string) &&
    input.errorCode === undefined
  ) {
    return fail("INVALID_VECTOR", "rejected expected result requires errorCode");
  }
  if (
    !staticHarness &&
    ["accept", "pass", "truncate"].includes(input.decision) &&
    input.errorCode !== undefined
  ) {
    return fail("INVALID_VECTOR", "successful expected result forbids errorCode");
  }
  if (!staticHarness) {
    if (typeof input.retryability !== "string" || typeof input.recoveryAction !== "string") {
      return fail("INVALID_VECTOR", "expected retry/recovery pair is invalid");
    }
    const pair = `${input.retryability}/${input.recoveryAction}`;
    if (!LEGAL_RETRY_RECOVERY_PAIRS_V1.some(([retry, recovery]) => `${retry}/${recovery}` === pair)) {
      return fail("INVALID_VECTOR", "expected retry/recovery pair is invalid");
    }
    const warningCodes = stringArray(input.warningCodes, "expected.warningCodes");
    if (
      warningCodes.some(
        (warning) =>
          !AGENT_WARNING_CODES_V1.includes(
            warning as (typeof AGENT_WARNING_CODES_V1)[number],
          ),
      )
    ) {
      return fail("INVALID_VECTOR", "expected.warningCodes is invalid");
    }
    if (
      input.canonicalBytesSha256 !== undefined &&
      (typeof input.canonicalBytesSha256 !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(input.canonicalBytesSha256))
    ) {
      return fail("INVALID_VECTOR", "expected.canonicalBytesSha256 is invalid");
    }
    if (
      harness === "c14n" &&
      input.decision === "accept" &&
      input.canonicalBytesSha256 === undefined
    ) {
      return fail("INVALID_VECTOR", "accepted c14n result requires canonicalBytesSha256");
    }
    parseCanonicalEvents(input.canonicalEvents);
    for (const field of ["mappingDelta", "ledgerDelta", "reducerDelta", "ackDelta", "rendererEmissions"]) {
      nonNegativeCounter(input[field], `expected.${field}`);
    }
    for (const field of ["cancelDispatchDelta", "checkpointDelta", "ackPersistDelta"]) {
      if (input[field] !== undefined) {
        nonNegativeCounter(input[field], `expected.${field}`);
      }
    }
    if (input.deliveryHostSequences !== undefined) {
      if (!Array.isArray(input.deliveryHostSequences)) {
        return fail("INVALID_VECTOR", "expected.deliveryHostSequences is invalid");
      }
      input.deliveryHostSequences.forEach((sequence, index) =>
        nonNegativeCounter(sequence, `expected.deliveryHostSequences[${index}]`),
      );
    }
    if (
      input.subscriptionDisposition !== undefined &&
      !["wait", "end", "reject", "closed"].includes(
        String(input.subscriptionDisposition),
      )
    ) {
      return fail("INVALID_VECTOR", "expected.subscriptionDisposition is invalid");
    }
    if (
      input.postRunLifecycle !== undefined &&
      !["running", "cancelling", "terminal", "quarantined"].includes(
        String(input.postRunLifecycle),
      )
    ) {
      return fail("INVALID_VECTOR", "expected.postRunLifecycle is invalid");
    }
    if (
      input.postCancelDispatchState !== undefined &&
      !["pending", "dispatched"].includes(
        String(input.postCancelDispatchState),
      )
    ) {
      return fail("INVALID_VECTOR", "expected.postCancelDispatchState is invalid");
    }
    const parseExpectedMappingRows = (rows: unknown) => {
      if (!Array.isArray(rows)) {
        return fail("INVALID_VECTOR", "expected.mappingRows is invalid");
      }
      return Object.freeze(
        rows.map((entry, index) => {
          const row = plainSnapshot(
            entry,
            [
              "sourceEventId",
              "sourceSequence",
              "eventType",
              "sourcePayloadDigest",
              "eventId",
              "hostSequence",
            ],
            [],
            `expected.mappingRows[${index}]`,
          );
          if (
            typeof row.eventType !== "string" ||
            ![
              "message.delta",
              "citation.declared",
              "cancel.acknowledged",
              "run.completed",
              "run.failed",
            ].includes(row.eventType) ||
            typeof row.sourcePayloadDigest !== "string" ||
            !/^sha256:[0-9a-f]{64}$/u.test(row.sourcePayloadDigest)
          ) {
            return fail("INVALID_VECTOR", "expected mapping row is invalid");
          }
          return Object.freeze({
            sourceEventId: conformanceIdentity(
              row.sourceEventId,
              "expected.mappingRows.sourceEventId",
            ),
            sourceSequence: nonNegativeCounter(
              row.sourceSequence,
              "expected.mappingRows.sourceSequence",
            ),
            eventType: row.eventType,
            sourcePayloadDigest: row.sourcePayloadDigest,
            eventId: conformanceIdentity(
              row.eventId,
              "expected.mappingRows.eventId",
            ),
            hostSequence: nonNegativeCounter(
              row.hostSequence,
              "expected.mappingRows.hostSequence",
            ),
          });
        }),
      );
    };
    const parseExpectedCommitRows = (
      rows: unknown,
      label: "checkpointRows" | "ackRows",
    ) => {
      if (!Array.isArray(rows)) {
        return fail("INVALID_VECTOR", `expected.${label} is invalid`);
      }
      return Object.freeze(
        rows.map((entry, index) => {
          const row = plainSnapshot(
            entry,
            ["hostRunId", "eventId", "hostSequence", "resumeEpoch"],
            [],
            `expected.${label}[${index}]`,
          );
          return Object.freeze({
            hostRunId: conformanceIdentity(
              row.hostRunId,
              `expected.${label}.hostRunId`,
            ),
            eventId: conformanceIdentity(
              row.eventId,
              `expected.${label}.eventId`,
            ),
            hostSequence: nonNegativeCounter(
              row.hostSequence,
              `expected.${label}.hostSequence`,
            ),
            resumeEpoch: nonNegativeCounter(
              row.resumeEpoch,
              `expected.${label}.resumeEpoch`,
            ),
          });
        }),
      );
    };
    validatedMappingRows =
      input.mappingRows === undefined
        ? undefined
        : parseExpectedMappingRows(input.mappingRows);
    validatedCheckpointRows =
      input.checkpointRows === undefined
        ? undefined
        : parseExpectedCommitRows(input.checkpointRows, "checkpointRows");
    validatedAckRows =
      input.ackRows === undefined
        ? undefined
        : parseExpectedCommitRows(input.ackRows, "ackRows");
    if (
      (allowsExactMappingRows &&
        Number(input.mappingDelta) > 0 &&
        validatedMappingRows?.length !== Number(input.mappingDelta)) ||
      (allowsCheckpointAck &&
        validatedCheckpointRows?.length !== Number(input.checkpointDelta)) ||
      (allowsCheckpointAck &&
        validatedAckRows?.length !== Number(input.ackPersistDelta)) ||
      ((harness === "reducer" || harness === "ledger_recovery") &&
        Number(input.ledgerDelta) > 0 &&
        (input.canonicalEvents as unknown[]).length !== Number(input.ledgerDelta))
    ) {
      return fail("INVALID_VECTOR", "expected exact row oracle is incomplete");
    }
    if (
      typeof input.quarantineState !== "string" ||
      !["unchanged", "active", "cleared"].includes(input.quarantineState)
    ) {
      return fail("INVALID_VECTOR", "expected.quarantineState is invalid");
    }
  }
  const result: Record<string, PureJson> = Object.create(null);
  for (const [key, entry] of Object.entries(input)) {
    if (key === "sideEffectCounters") {
      result[key] = parseExactCounters(entry, sideEffectCounterFields, key);
    } else if (key === "processOrRequestCounters") {
      result[key] = parseExactCounters(entry, processOrRequestCounterFields, key);
    } else if (key === "canonicalEvents") {
      result[key] = parseCanonicalEvents(entry);
    } else if (key === "mappingRows") {
      result[key] = validatedMappingRows ?? fail("INVALID_VECTOR", "expected.mappingRows is invalid");
    } else if (key === "checkpointRows") {
      result[key] = validatedCheckpointRows ?? fail("INVALID_VECTOR", "expected.checkpointRows is invalid");
    } else if (key === "ackRows") {
      result[key] = validatedAckRows ?? fail("INVALID_VECTOR", "expected.ackRows is invalid");
    } else if (key === "postCancelCommandId") {
      result[key] = conformanceIdentity(entry, "expected.postCancelCommandId");
    } else if (key === "postCancelDeadlineMonotonicMs") {
      result[key] = nonNegativeCounter(
        entry,
        "expected.postCancelDeadlineMonotonicMs",
      );
    } else if (key === "postCancelDispatchState") {
      result[key] = entry as "pending" | "dispatched";
    } else {
      result[key] = cloneFreezeJson(entry, `expected.${key}`);
    }
  }
  return Object.freeze(result);
}

function stageForHarness(
  harness: ConformanceHarnessV1,
  stage: ConformanceStageV1,
): boolean {
  if (harness === "build_gate" || harness === "surface_scan") {
    return stage === "P4-A" || stage === "P4-C";
  }
  const exact: Readonly<Record<ConformanceHarnessV1, ConformanceStageV1>> = {
    codec: "P4-A",
    schema: "P4-A",
    c14n: "P4-A",
    reducer: "P4-B",
    ledger_recovery: "P4-B",
    build_gate: "P4-A",
    surface_scan: "P4-A",
    desktop_boundary: "P4-C",
    electron_boundary: "P4-D",
  };
  return exact[harness] === stage;
}

export function parseConformanceVectorV1(value: unknown): ConformanceVectorV1 {
  const header = plainSnapshot(
    value,
    commonRequired,
    [
      "rawInput",
      "jsonInput",
      "preState",
      "steps",
      "faultPoint",
      "scanTarget",
    ],
    "vector",
  );
  if (
    typeof header.id !== "string" ||
    !/^N(?:0[1-9]|[12][0-9]|30)-[a-z0-9][a-z0-9._-]*$/u.test(header.id)
  ) {
    return fail("INVALID_VECTOR", "vector.id is invalid");
  }
  if (
    typeof header.oracleId !== "string" ||
    !/^N(?:0[1-9]|[12][0-9]|30)$/u.test(header.oracleId)
  ) {
    return fail("INVALID_VECTOR", "vector.oracleId is invalid");
  }
  if (!header.id.startsWith(`${header.oracleId}-`)) {
    return fail("INVALID_VECTOR", "vector id is not owned by oracleId");
  }
  if (header.contractVersion !== CONFORMANCE_CONTRACT_VERSION_V1) {
    return fail("INVALID_VECTOR", "vector contractVersion is invalid");
  }
  if (
    typeof header.harness !== "string" ||
    !CONFORMANCE_HARNESSES_V1.includes(header.harness as ConformanceHarnessV1)
  ) {
    return fail("INVALID_VECTOR", "vector harness is invalid");
  }
  if (
    typeof header.requiredStage !== "string" ||
    !CONFORMANCE_STAGES_V1.includes(header.requiredStage as ConformanceStageV1)
  ) {
    return fail("INVALID_VECTOR", "vector requiredStage is invalid");
  }
  const harness = header.harness as ConformanceHarnessV1;
  const requiredStage = header.requiredStage as ConformanceStageV1;
  if (!stageForHarness(harness, requiredStage)) {
    return fail("INVALID_VECTOR", "vector requiredStage does not match harness");
  }
  const harnessFields = fieldsByHarness[harness];
  const permitted = new Set([...harnessFields.required, ...harnessFields.optional]);
  for (const field of [
    "rawInput",
    "jsonInput",
    "preState",
    "steps",
    "faultPoint",
    "scanTarget",
  ]) {
    if (header[field] !== undefined && !permitted.has(field)) {
      return fail("INVALID_VECTOR", `vector.${field} is forbidden for ${harness}`);
    }
  }
  for (const field of harnessFields.required) {
    if (header[field] === undefined) {
      return fail("INVALID_VECTOR", `${harness} vector requires ${field}`);
    }
  }
  if (harness === "c14n" && (header.rawInput === undefined) === (header.jsonInput === undefined)) {
    return fail("INVALID_VECTOR", "c14n vector requires exactly one input");
  }
  const rawInput =
    header.rawInput === undefined ? undefined : parseRawInput(header.rawInput);
  const jsonInput =
    header.jsonInput === undefined
      ? undefined
      : harness === "schema"
        ? parseSchemaInput(header.jsonInput)
        : cloneFreezeJson(header.jsonInput, "jsonInput");
  const preState =
    header.preState === undefined
      ? undefined
      : parsePreState(header.preState);
  const steps =
    header.steps === undefined
      ? undefined
      : parseSteps(header.steps);
  const expected = parseExpected(header.expected, harness, steps);
  return Object.freeze({
    id: header.id,
    oracleId: header.oracleId,
    contractVersion: CONFORMANCE_CONTRACT_VERSION_V1,
    harness,
    requiredStage,
    negotiatedCapabilities: stringArray(
      header.negotiatedCapabilities,
      "negotiatedCapabilities",
    ),
    ...(rawInput === undefined ? {} : { rawInput }),
    ...(jsonInput === undefined ? {} : { jsonInput }),
    ...(preState === undefined ? {} : { preState }),
    ...(steps === undefined ? {} : { steps }),
    ...(header.faultPoint === undefined
      ? {}
      : typeof header.faultPoint === "string"
        ? { faultPoint: header.faultPoint }
        : fail("INVALID_VECTOR", "vector.faultPoint must be a string")),
    ...(header.scanTarget === undefined
      ? {}
      : { scanTarget: parseScanTarget(header.scanTarget) }),
    expected,
  });
}

export function parseConformanceTraceabilityManifestV1(
  value: unknown,
): ConformanceTraceabilityManifestV1 {
  const input = plainSnapshot(
    value,
    ["contractVersion", "stateFixtures", "vectors"],
    [],
    "traceability",
  );
  if (input.contractVersion !== CONFORMANCE_CONTRACT_VERSION_V1) {
    return fail("INVALID_VECTOR", "traceability contractVersion is invalid");
  }
  if (!Array.isArray(input.stateFixtures) || !Array.isArray(input.vectors)) {
    return fail("INVALID_VECTOR", "traceability vectors must be an array");
  }
  const stateFixtures = input.stateFixtures.map(parseStateFixture);
  const stateFixtureById = new Map<string, ConformanceStateFixtureV1>();
  for (const fixture of stateFixtures) {
    if (stateFixtureById.has(fixture.fixtureId)) {
      return fail("TRACEABILITY_DUPLICATE", "state fixture id is duplicated");
    }
    stateFixtureById.set(fixture.fixtureId, fixture);
  }
  const vectors = input.vectors.map(parseConformanceVectorV1);
  const ids = new Set<string>();
  const oracles = new Set<string>();
  for (const vector of vectors) {
    if (ids.has(vector.id)) {
      return fail("TRACEABILITY_DUPLICATE", "traceability vector id is duplicated");
    }
    ids.add(vector.id);
    oracles.add(vector.oracleId);
    if (vector.preState !== undefined) {
      const fixtureId = vector.preState.fixtureId;
      if (typeof fixtureId !== "string") {
        return fail("INVALID_VECTOR", "preState fixture reference is invalid");
      }
      const fixture = stateFixtureById.get(fixtureId);
      if (fixture === undefined) {
        return fail("TRACEABILITY_INCOMPLETE", "preState fixture is unresolved");
      }
      if (
        vector.preState.hostSequence !== fixture.run.hostSequence ||
        vector.preState.terminal !== fixture.run.terminal ||
        vector.preState.quarantined !== fixture.run.quarantined
      ) {
        return fail("INVALID_VECTOR", "preState does not match its seed fixture");
      }
    }
  }
  const expected = Array.from({ length: 30 }, (_, index) =>
    `N${String(index + 1).padStart(2, "0")}`,
  );
  if (expected.some((oracleId) => !oracles.has(oracleId))) {
    return fail("TRACEABILITY_INCOMPLETE", "traceability is incomplete");
  }
  if (!vectors.some((vector) => vector.harness === "electron_boundary")) {
    return fail("TRACEABILITY_INCOMPLETE", "electron boundary vector is missing");
  }
  return Object.freeze({
    contractVersion: CONFORMANCE_CONTRACT_VERSION_V1,
    stateFixtures: Object.freeze(stateFixtures),
    vectors: Object.freeze(vectors),
  });
}

export function parseConformanceResultReceiptV1(
  manifest: ConformanceTraceabilityManifestV1,
  value: unknown,
): ConformanceResultReceiptV1 {
  const input = plainSnapshot(
    value,
    ["contractVersion", "currentStage", "results"],
    [],
    "resultReceipt",
  );
  if (input.contractVersion !== CONFORMANCE_CONTRACT_VERSION_V1) {
    return fail("INVALID_VECTOR", "result receipt contractVersion is invalid");
  }
  if (
    typeof input.currentStage !== "string" ||
    !CONFORMANCE_STAGES_V1.includes(input.currentStage as ConformanceStageV1) ||
    !Array.isArray(input.results)
  ) {
    return fail("INVALID_VECTOR", "result receipt header is invalid");
  }
  const currentStage = input.currentStage as ConformanceStageV1;
  const vectorById = new Map(manifest.vectors.map((vector) => [vector.id, vector]));
  const seen = new Set<string>();
  const results = input.results.map((entry, index) => {
    const result = plainSnapshot(
      entry,
      ["vectorId", "harness", "requiredStage", "status"],
      [],
      `resultReceipt.results[${index}]`,
    );
    if (typeof result.vectorId !== "string" || seen.has(result.vectorId)) {
      return fail("TRACEABILITY_DUPLICATE", "result vectorId is invalid or duplicated");
    }
    seen.add(result.vectorId);
    const vector = vectorById.get(result.vectorId);
    if (
      vector === undefined ||
      result.harness !== vector.harness ||
      result.requiredStage !== vector.requiredStage ||
      typeof result.status !== "string" ||
      !["PASS", "FAIL", "BLOCKED", "NOT_RUN"].includes(result.status)
    ) {
      return fail("INVALID_VECTOR", "result does not match its vector");
    }
    const isLaterStage =
      (stageOrder.get(vector.requiredStage) ?? Number.POSITIVE_INFINITY) >
      (stageOrder.get(currentStage) ?? -1);
    if (isLaterStage ? result.status !== "NOT_RUN" : result.status === "NOT_RUN") {
      return fail("INVALID_VECTOR", "result status violates stage discipline");
    }
    return Object.freeze({
      vectorId: result.vectorId,
      harness: vector.harness,
      requiredStage: vector.requiredStage,
      status: result.status as ConformanceStatusV1,
    });
  });
  if (results.length !== manifest.vectors.length || seen.size !== vectorById.size) {
    return fail("TRACEABILITY_INCOMPLETE", "result receipt omits vectors");
  }
  return Object.freeze({
    contractVersion: CONFORMANCE_CONTRACT_VERSION_V1,
    currentStage,
    results: Object.freeze(results),
  });
}

export function evaluateConformanceStageV1(
  currentStage: ConformanceStageV1,
  manifest: ConformanceTraceabilityManifestV1,
  receipt: ConformanceResultReceiptV1,
): Readonly<{ status: "PASS" | "BLOCKED"; blockers: readonly string[] }> {
  if (receipt.currentStage !== currentStage || receipt.results.length !== manifest.vectors.length) {
    return fail("TRACEABILITY_INCOMPLETE", "stage receipt is incomplete");
  }
  const currentOrder = stageOrder.get(currentStage)!;
  const blockers = receipt.results
    .filter(
      (result) =>
        (stageOrder.get(result.requiredStage) ?? Number.POSITIVE_INFINITY) <=
          currentOrder &&
        result.status !== "PASS",
    )
    .map((result) => result.vectorId);
  return Object.freeze({
    status: blockers.length === 0 ? "PASS" : "BLOCKED",
    blockers: Object.freeze(blockers),
  });
}
