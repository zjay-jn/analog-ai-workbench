import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import {
  AgentContractError,
  parseCanonicalDecimalStringV1,
} from "../packages/agent-adapters/src/agent-contract";
import {
  evaluateAgentBudgetBoundaryV1,
  parseConformanceTraceabilityManifestV1,
  parseConformanceResultReceiptV1,
  type ConformanceVectorV1,
} from "../packages/agent-adapters/src/conformance";
import {
  parseCanonicalEventV1,
  parseToolTransitionV1,
} from "../packages/agent-adapters/src/canonical-contract";
import {
  parseResolveArtifactRequestV1,
  parseResolveCitationRequestV1,
  parseResolveDocumentRequestV1,
  parseResolveResultV1,
} from "../packages/agent-adapters/src/public-contract";
import {
  decodeAgentSourceEventFrameV1,
  StrictAgentFrameError,
} from "../packages/agent-adapters/src/strict-agent-frame";
import {
  canonicalizeAawJsonV1,
  sha256CanonicalAawJsonV1,
} from "../packages/schematic-workbench/src/canonical-json";
import { decodeStrictSourceFrameV1 } from "../packages/schematic-workbench/src/strict-source-frame";

const manifestPath =
  "packages/agent-adapters/fixtures/n01-n30.traceability.json";
const sourceEventSchemaPath =
  "packages/agent-adapters/schemas/agent-source-event.v1alpha1.schema.json";
const citationSourceSchemaPath =
  "packages/agent-adapters/schemas/citation-source.v1alpha1.schema.json";
const citationLocatorSchemaPath =
  "packages/agent-adapters/schemas/citation-locator.v1alpha1.schema.json";
const conformanceSchemaPath =
  "packages/agent-adapters/schemas/agent-conformance.v1alpha1.schema.json";
const traceabilitySchemaPath =
  "packages/agent-adapters/schemas/agent-conformance-traceability.v1alpha1.schema.json";
const fixtureManifestPath =
  "packages/agent-adapters/fixtures/approved-synthetic-agent-fixtures.manifest.json";
const fixtureManifestSchemaPath =
  "packages/agent-adapters/schemas/synthetic-agent-fixture-manifest.v1alpha1.schema.json";
const publicResolveSchemaPath =
  "packages/agent-adapters/schemas/agent-public-resolve.v1alpha1.schema.json";
const canonicalContractSchemaPath =
  "packages/agent-adapters/schemas/agent-canonical-contract.v1alpha1.schema.json";
const resultSchemaPath =
  "packages/agent-adapters/schemas/agent-conformance-results.v1alpha1.schema.json";
const resultReceiptPath =
  "packages/agent-adapters/fixtures/p4a-conformance-results.json";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function bytesFromRawInput(
  input: NonNullable<ConformanceVectorV1["rawInput"]>,
): Uint8Array {
  return "utf8Hex" in input
    ? Uint8Array.from(Buffer.from(input.utf8Hex, "hex"))
    : Uint8Array.from(Buffer.from(input.base64, "base64"));
}

function expectedRecord(vector: ConformanceVectorV1): Record<string, unknown> {
  return vector.expected as unknown as Record<string, unknown>;
}

function collectStringValues(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) {
    for (const entry of value) collectStringValues(entry, output);
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectStringValues(entry, output);
  }
  return output;
}

function p4bAddendumSchemaExpected(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    decision: "accept",
    retryability: "never",
    recoveryAction: "none",
    warningCodes: [],
    canonicalEvents: [],
    mappingDelta: 0,
    ledgerDelta: 0,
    reducerDelta: 0,
    ackDelta: 0,
    quarantineState: "unchanged",
    rendererEmissions: 0,
    sideEffectCounters: {
      toolBrokerInvocationCount: 0,
      capabilityGrantCount: 0,
      productDocumentFileMutationCount: 0,
      nativeSaveHelperCallCount: 0,
      oaEdaMutationCallCount: 0,
      externalNetworkCount: 0,
      processSpawnCount: 0,
      pythonBridgeCallCount: 0,
      credentialReadCount: 0,
    },
    ...overrides,
  };
}

function firstCancelSchemaExpected(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    cancelDispatchDelta: 1,
    postRunLifecycle: "cancelling",
    postCancelCommandId: "cancel.synthetic.command.1",
    postCancelDeadlineMonotonicMs: 2000,
    postCancelDispatchState: "dispatched",
    ...overrides,
  };
}

function p4bAddendumSchemaVector(
  id: string,
  steps: readonly Record<string, unknown>[],
  expectedFields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    id,
    oracleId: id.slice(0, 3),
    contractVersion: "aaw.agent.conformance/v1alpha1",
    harness: "reducer",
    requiredStage: "P4-B",
    negotiatedCapabilities: [],
    preState: {
      fixtureId: "synthetic-addendum-schema",
      hostSequence: 2,
      terminal: false,
      quarantined: false,
    },
    steps,
    expected: p4bAddendumSchemaExpected(expectedFields),
  };
}

function schemaWithoutExpectedField(
  vector: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> {
  const candidate = structuredClone(vector) as {
    expected: Record<string, unknown>;
  };
  delete candidate.expected[field];
  return candidate;
}

test("P4-A addendum schemas close cancel, recovery and host replay state", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const conformanceSchema = readJson(conformanceSchemaPath) as object;
  ajv.addSchema(conformanceSchema);
  const validateConformance = ajv.getSchema("aaw.agent.conformance:v1alpha1");
  assert.ok(validateConformance);

  const validCancel = p4bAddendumSchemaVector(
    "N28-cancel-ack-terminal-once",
    [
      {
        action: "submit-cancel-ack",
        sourceSequence: 1,
        sourceEventId: "synthetic.event.cancel-ack",
      },
    ],
    {
      cancelDispatchDelta: 0,
      postRunLifecycle: "terminal",
      checkpointDelta: 1,
      ackPersistDelta: 1,
      checkpointRows: [
        {
          hostRunId: "host.synthetic-addendum-schema",
          eventId: "event.synthetic-addendum-schema.3",
          hostSequence: 3,
          resumeEpoch: 1,
        },
      ],
      ackRows: [
        {
          hostRunId: "host.synthetic-addendum-schema",
          eventId: "event.synthetic-addendum-schema.3",
          hostSequence: 3,
          resumeEpoch: 1,
        },
      ],
    },
  );
  const validReplay = p4bAddendumSchemaVector(
    "N18-host-replay-snapshot-tail-exactly-once",
    [{ action: "subscribe-replay", afterHostSequence: 0 }],
    {
      deliveryHostSequences: [1, 2, 3],
      subscriptionDisposition: "wait",
    },
  );
  const validLiveTail = p4bAddendumSchemaVector(
    "N18-host-replay-snapshot-tail-exactly-once",
    [
      {
        action: "commit-live-tail",
        sourceSequence: 3,
        sourceEventId: "synthetic.event.live-tail",
      },
    ],
    {
      deliveryHostSequences: [1, 2, 3],
      subscriptionDisposition: "wait",
      checkpointDelta: 1,
      ackPersistDelta: 1,
      checkpointRows: [
        {
          hostRunId: "host.synthetic-addendum-schema",
          eventId: "event.synthetic-addendum-schema.3",
          hostSequence: 3,
          resumeEpoch: 1,
        },
      ],
      ackRows: [
        {
          hostRunId: "host.synthetic-addendum-schema",
          eventId: "event.synthetic-addendum-schema.3",
          hostSequence: 3,
          resumeEpoch: 1,
        },
      ],
    },
  );
  const validOmittedReplay = p4bAddendumSchemaVector(
    "N18-host-replay-omitted-after-zero",
    [{ action: "subscribe-replay" }],
    {
      deliveryHostSequences: [1, 2],
      subscriptionDisposition: "wait",
    },
  );
  const validMonotonicActions = [
    p4bAddendumSchemaVector(
      "N28-cancel-before-stream",
      [{ action: "request-cancel", monotonicMs: 1000 }],
      firstCancelSchemaExpected(),
    ),
    p4bAddendumSchemaVector(
      "N28-monotonic-deadline-metamorphic",
      [{ action: "advance-monotonic-clock", monotonicMs: 2001 }],
      { cancelDispatchDelta: 0, postRunLifecycle: "quarantined" },
    ),
    p4bAddendumSchemaVector(
      "N28-cancel-timeout-late-event-isolated",
      [{ action: "fire-cancel-timeout", monotonicMs: 200 }],
      { cancelDispatchDelta: 0, postRunLifecycle: "quarantined" },
    ),
  ];
  const validRepeatedCancel = p4bAddendumSchemaVector(
    "N28-cancel-repeated-idempotent",
    [{ action: "request-cancel", monotonicMs: 1001 }],
    { cancelDispatchDelta: 0, postRunLifecycle: "cancelling" },
  );
  const validLateAfterCancel = p4bAddendumSchemaVector(
    "N28-cancel-timeout-late-event-isolated",
    [
      {
        action: "submit-late-after-cancel",
        sourceSequence: 3,
        sourceEventId: "synthetic.event.cancel-late",
      },
    ],
    {
      decision: "isolate",
      errorCode: "PROTOCOL_MISMATCH",
      cancelDispatchDelta: 0,
      postRunLifecycle: "quarantined",
      quarantineState: "active",
    },
  );
  for (const vector of [
    validCancel,
    validReplay,
    validLiveTail,
    validOmittedReplay,
    validRepeatedCancel,
    validLateAfterCancel,
    ...validMonotonicActions,
  ]) {
    assert.equal(
      validateConformance(vector),
      true,
      `${String(vector.id)}: ${JSON.stringify(validateConformance.errors)}`,
    );
  }
  for (const vector of [
    validCancel,
    validLateAfterCancel,
    ...validMonotonicActions,
  ]) {
    for (const field of ["cancelDispatchDelta", "postRunLifecycle"]) {
      const candidate = schemaWithoutExpectedField(vector, field);
      assert.equal(
        validateConformance(candidate),
        false,
        `${String(vector.id)} must require expected.${field}`,
      );
    }
  }
  for (const vector of [validCancel, validLiveTail]) {
    for (const field of [
      "checkpointDelta",
      "ackPersistDelta",
      "checkpointRows",
      "ackRows",
    ]) {
      const candidate = schemaWithoutExpectedField(vector, field);
      assert.equal(
        validateConformance(candidate),
        false,
        `${String(vector.id)} must require expected.${field}`,
      );
    }
    for (const field of ["checkpointRows", "ackRows"] as const) {
      const wrongLength = structuredClone(vector) as {
        expected: Record<string, unknown>;
      };
      wrongLength.expected[field] = [];
      assert.equal(
        validateConformance(wrongLength),
        false,
        `${String(vector.id)} ${field} length must equal its delta`,
      );
    }
  }
  const firstCancelVector = validMonotonicActions[0];
  assert.ok(firstCancelVector);
  for (const field of [
    "postCancelCommandId",
    "postCancelDeadlineMonotonicMs",
    "postCancelDispatchState",
  ]) {
    assert.equal(
      validateConformance(
        schemaWithoutExpectedField(firstCancelVector, field),
      ),
      false,
      `first cancel dispatch must require expected.${field}`,
    );
  }
  const unsafePostDeadline = structuredClone(firstCancelVector) as {
    expected: Record<string, unknown>;
  };
  unsafePostDeadline.expected.postCancelDeadlineMonotonicMs =
    Number.MAX_SAFE_INTEGER + 1;
  assert.equal(validateConformance(unsafePostDeadline), false);
  for (const [field, value] of [
    ["postCancelCommandId", "cancel.synthetic.command.extra"],
    ["postCancelDeadlineMonotonicMs", 2000],
    ["postCancelDispatchState", "dispatched"],
  ] as const) {
    const extra = structuredClone(validRepeatedCancel) as {
      expected: Record<string, unknown>;
    };
    extra.expected[field] = value;
    assert.equal(
      validateConformance(extra),
      false,
      `zero dispatch must forbid expected.${field}`,
    );
  }

  const rawConformance = readJson(manifestPath) as {
    vectors: Record<string, unknown>[];
  };
  const ledgerRecoveryVectors = rawConformance.vectors.filter(
    (vector) => vector.harness === "ledger_recovery",
  );
  assert.ok(ledgerRecoveryVectors.length > 0);
  for (const vector of ledgerRecoveryVectors) {
    assert.equal(
      validateConformance(vector),
      true,
      `${String(vector.id)}: ${JSON.stringify(validateConformance.errors)}`,
    );
    for (const field of [
      "checkpointDelta",
      "ackPersistDelta",
      "checkpointRows",
      "ackRows",
    ]) {
      assert.equal(
        validateConformance(schemaWithoutExpectedField(vector, field)),
        false,
        `${String(vector.id)} must require expected.${field}`,
      );
    }
  }
  const zeroRowVector = ledgerRecoveryVectors.find(
    (vector) =>
      (vector.expected as Record<string, unknown>).checkpointDelta === 0 &&
      (vector.expected as Record<string, unknown>).ackPersistDelta === 0,
  );
  assert.ok(zeroRowVector);
  for (const field of ["checkpointRows", "ackRows"] as const) {
    const nonempty = structuredClone(zeroRowVector) as {
      expected: Record<string, unknown>;
    };
    nonempty.expected[field] = [
      {
        hostRunId: "host.synthetic-addendum-schema",
        eventId: "event.synthetic-addendum-schema.1",
        hostSequence: 1,
        resumeEpoch: 1,
      },
    ];
    assert.equal(
      validateConformance(nonempty),
      false,
      `${String(zeroRowVector.id)} ${field} length must equal zero delta`,
    );
  }
  for (const invalid of [
    {
      ...validCancel,
      steps: [{ action: "submit-cancel-ack", sourceSequence: 1 }],
    },
    {
      ...validMonotonicActions[0],
      steps: [
        {
          action: "request-cancel",
          monotonicMs: 1000,
          sourceSequence: 1,
          sourceEventId: "synthetic.event.cancel-request",
        },
      ],
    },
    {
      ...validReplay,
      steps: [
        {
          action: "subscribe-replay",
          sourceEventId: "synthetic.event.replay",
        },
      ],
    },
    {
      ...validMonotonicActions[0],
      steps: [
        { action: "request-cancel", monotonicMs: 1000, api: "resolveDocument" },
      ],
    },
    {
      ...validMonotonicActions[0],
      steps: [{ action: "request-cancel", monotonicMs: 1000, request: {} }],
    },
    {
      ...validMonotonicActions[0],
      steps: [
        {
          action: "request-cancel",
          monotonicMs: 1000,
          api: "resolveDocument",
          request: {},
        },
      ],
    },
    {
      ...validMonotonicActions[0],
      steps: [{ action: "request-cancel" }],
    },
    {
      ...validMonotonicActions[1],
      steps: [{ action: "advance-monotonic-clock" }],
    },
    {
      ...validMonotonicActions[2],
      steps: [{ action: "fire-cancel-timeout" }],
    },
    {
      ...validReplay,
      steps: [{ action: "subscribe-replay", monotonicMs: 100 }],
    },
    {
      ...validMonotonicActions[0],
      steps: [
        {
          action: "request-cancel",
          monotonicMs: Number.MAX_SAFE_INTEGER + 1,
        },
      ],
    },
    {
      ...validMonotonicActions[0],
      expected: p4bAddendumSchemaExpected(firstCancelSchemaExpected({
        deliveryHostSequences: [],
        subscriptionDisposition: "wait",
      })),
    },
    {
      ...validReplay,
      expected: p4bAddendumSchemaExpected({
        deliveryHostSequences: [1, 2, 3],
        subscriptionDisposition: "wait",
        checkpointRows: [],
      }),
    },
  ]) {
    assert.equal(
      validateConformance(invalid),
      false,
      `${String((invalid as Record<string, unknown>).id)} must reject invalid action-field combinations`,
    );
  }

  const validateTraceability = ajv.compile(
    readJson(traceabilitySchemaPath) as object,
  );
  const seeded = structuredClone(readJson(manifestPath)) as {
    stateFixtures: {
      binding: { resumeEpoch: number };
      run: Record<string, unknown> & { hostRunId: string; hostSequence: number };
      ledger: { eventId: string; hostSequence: number }[];
      checkpoints?: Record<string, unknown>[];
      acks?: Record<string, unknown>[];
    }[];
  };
  const fixture = seeded.stateFixtures.find((entry) => entry.ledger.length > 0);
  assert.ok(fixture);
  const committed = fixture.ledger.at(-1);
  assert.ok(committed);
  Object.assign(fixture.run, {
    committedHead: fixture.run.hostSequence,
    retentionFloor: 0,
    snapshotHead: fixture.run.hostSequence,
    tailRegisteredAfter: fixture.run.hostSequence,
  });
  fixture.checkpoints = [
    {
      hostRunId: fixture.run.hostRunId,
      eventId: committed.eventId,
      hostSequence: committed.hostSequence,
      resumeEpoch: fixture.binding.resumeEpoch,
    },
  ];
  fixture.acks = [
    {
      hostRunId: fixture.run.hostRunId,
      eventId: committed.eventId,
      hostSequence: committed.hostSequence,
      resumeEpoch: fixture.binding.resumeEpoch,
    },
  ];
  assert.equal(
    validateTraceability(seeded),
    true,
    JSON.stringify(validateTraceability.errors),
  );

  const closedState = structuredClone(readJson(manifestPath)) as {
    stateFixtures: {
      fixtureId: string;
      run: Record<string, unknown> & {
        terminal: boolean;
        quarantined: boolean;
        ledgerIntegrity: string;
      };
    }[];
  };
  const cancelling = closedState.stateFixtures.find(
    (entry) => entry.run.lifecycle === "cancelling",
  );
  assert.ok(cancelling, "the addendum must freeze a cancelling state fixture");
  assert.equal(cancelling.run.terminal, false);
  assert.equal(cancelling.run.quarantined, false);
  assert.equal(typeof cancelling.run.cancelCommandId, "string");
  assert.ok(
    typeof cancelling.run.cancelDeadlineMonotonicMs === "number" &&
      Number.isSafeInteger(cancelling.run.cancelDeadlineMonotonicMs) &&
      cancelling.run.cancelDeadlineMonotonicMs >= 0,
  );
  assert.ok(
    ["pending", "dispatched"].includes(String(cancelling.run.cancelDispatchState)),
  );

  const missingDeadline = structuredClone(closedState);
  const missingDeadlineRun = missingDeadline.stateFixtures.find(
    (entry) => entry.fixtureId === cancelling.fixtureId,
  )!.run;
  delete missingDeadlineRun.cancelDeadlineMonotonicMs;
  assert.equal(validateTraceability(missingDeadline), false);
  assert.throws(() => parseConformanceTraceabilityManifestV1(missingDeadline));

  const unsafeDeadline = structuredClone(closedState);
  unsafeDeadline.stateFixtures.find(
    (entry) => entry.fixtureId === cancelling.fixtureId,
  )!.run.cancelDeadlineMonotonicMs = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(validateTraceability(unsafeDeadline), false);
  assert.throws(() => parseConformanceTraceabilityManifestV1(unsafeDeadline));

  const flagOnlyCorrupt = structuredClone(closedState);
  const consistentBase = flagOnlyCorrupt.stateFixtures.find(
    (entry) => entry.fixtureId === "synthetic-corruption-valid-base",
  );
  assert.ok(consistentBase);
  assert.equal(consistentBase.run.ledgerIntegrity, "valid");
  consistentBase.run.ledgerIntegrity = "corrupt";
  assert.equal(validateTraceability(flagOnlyCorrupt), false);
  assert.throws(() => parseConformanceTraceabilityManifestV1(flagOnlyCorrupt));
});

test("P4-A public schemas and runtime validators agree on frozen surface vectors", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const sourceSchema = readJson(sourceEventSchemaPath) as object;
  const citationSourceSchema = readJson(citationSourceSchemaPath) as object;
  const citationLocatorSchema = readJson(citationLocatorSchemaPath) as object;
  const conformanceSchema = readJson(conformanceSchemaPath) as object;
  const traceabilitySchema = readJson(traceabilitySchemaPath) as object;
  const validatePublic = ajv.compile(readJson(publicResolveSchemaPath) as object);
  const validateCanonical = ajv.compile(readJson(canonicalContractSchemaPath) as object);
  const validateResults = ajv.compile(readJson(resultSchemaPath) as object);
  const validateSource = ajv.compile(sourceSchema);
  assert.equal(ajv.compile(citationSourceSchema)({
    sourceKind: "rag_source",
    corpusId: "synthetic.corpus",
    sourceId: "source.1",
    sourceRevisionId: "rev-1",
  }), true);
  assert.equal(ajv.compile(citationLocatorSchema)({ locatorKind: "whole_source" }), true);
  const canonicalCitation = {
    citationId: "citation.synthetic.schema",
    source: {
      sourceKind: "reviewed_schematic",
      artifactId: "synthetic.circuit-ir.flat-basic",
      revisionId: "rev-1",
    },
    locator: { locatorKind: "whole_source" },
    authorityStatus: "non_authoritative",
    verificationStatus: "verified",
  };
  const canonicalCitationEvent = {
    hostRunId: "host.synthetic.schema",
    eventId: "event.synthetic.schema",
    hostSequence: 1,
    acceptedAt: "2026-09-02T00:00:01Z",
    canonicalPayloadDigest: sha256CanonicalAawJsonV1(canonicalCitation),
    type: "citation.declared",
    payload: canonicalCitation,
  };
  assert.equal(
    validateCanonical(canonicalCitationEvent),
    true,
    JSON.stringify(validateCanonical.errors),
  );
  const canonicalWarningEvent = {
    hostRunId: "host.synthetic.warning",
    eventId: "event.synthetic.warning.1",
    hostSequence: 1,
    acceptedAt: "2026-09-02T00:00:01Z",
    canonicalPayloadDigest: sha256CanonicalAawJsonV1({ text: "warning" }),
    warningCodes: ["SOURCE_TIME_INVALID"],
    type: "message.delta",
    payload: { text: "warning" },
  };
  assert.equal(validateCanonical(canonicalWarningEvent), true);
  assert.doesNotThrow(() => parseCanonicalEventV1(canonicalWarningEvent));
  assert.equal(validateCanonical({ ...canonicalWarningEvent, warningCodes: [] }), false);
  assert.equal(
    validateCanonical({
      ...canonicalWarningEvent,
      warningCodes: ["SOURCE_TIME_INVALID", "SOURCE_TIME_INVALID"],
    }),
    false,
  );
  assert.equal(
    validateCanonical({ ...canonicalWarningEvent, warningCodes: ["UNSAFE_WARNING"] }),
    false,
  );
  assert.equal(
    validateCanonical({ ...canonicalCitationEvent, type: "run.accepted" }),
    false,
  );
  assert.equal(
    validateCanonical({
      from: "idle",
      to: "dispatched",
      toolBrokerInvocationCount: 0,
    }),
    false,
  );
  ajv.addSchema(conformanceSchema);
  const validateTraceability = ajv.compile(traceabilitySchema);

  const manifest = readJson(manifestPath) as {
    vectors: readonly Record<string, unknown>[];
  };
  assert.equal(validateTraceability(manifest), true, JSON.stringify(validateTraceability.errors));
  const parsed = parseConformanceTraceabilityManifestV1(manifest);
  const resultReceipt = readJson(resultReceiptPath);
  assert.equal(validateResults(resultReceipt), true, JSON.stringify(validateResults.errors));
  assert.doesNotThrow(() => parseConformanceResultReceiptV1(parsed, resultReceipt));
  assert.ok(parsed.vectors.length >= 30);
  assert.equal(
    new Set(parsed.vectors.map((vector) => vector.id)).size,
    parsed.vectors.length,
  );
  assert.deepEqual(
    new Set(parsed.vectors.map((vector) => vector.oracleId)),
    new Set(Array.from({ length: 30 }, (_, index) => `N${String(index + 1).padStart(2, "0")}`)),
  );

  for (const vector of parsed.vectors.filter((entry) => entry.harness === "schema")) {
    const input = vector.jsonInput as Record<string, unknown>;
    const expected = expectedRecord(vector);
    if (input.schemaTarget === "source_event") {
      assert.equal(validateSource(input.value), false, vector.id);
      continue;
    }
    if (input.schemaTarget === "resolve_request") {
      assert.equal(
        validatePublic(input.value),
        expected.decision === "pass",
        `${vector.id}: ${JSON.stringify(validatePublic.errors)}`,
      );
      continue;
    }
    if (input.schemaTarget === "resolve_result") {
      assert.equal(
        validatePublic(input.value),
        expected.decision === "pass",
        `${vector.id}: ${JSON.stringify(validatePublic.errors)}`,
      );
      continue;
    }
    if (input.schemaTarget === "canonical_event") {
      assert.equal(
        validateCanonical(input.value),
        expected.decision === "pass",
        `${vector.id}: ${JSON.stringify(validateCanonical.errors)}`,
      );
      continue;
    }
    if (input.schemaTarget === "tool_transition") {
      assert.equal(
        validateCanonical({
          from: input.from,
          to: input.to,
          toolBrokerInvocationCount: input.expectedInvocationCount,
        }),
        expected.decision === "pass",
        `${vector.id}: ${JSON.stringify(validateCanonical.errors)}`,
      );
    }
  }
});

test("P4-A required codec/schema/c14n vectors execute against independent exact oracles", () => {
  const manifest = parseConformanceTraceabilityManifestV1(readJson(manifestPath));
  const p4a = manifest.vectors.filter(
    (vector) =>
      vector.requiredStage === "P4-A" &&
      ["codec", "schema", "c14n"].includes(vector.harness),
  );
  assert.ok(p4a.length >= 10);

  for (const vector of p4a) {
    const expected = expectedRecord(vector);
    if (vector.harness === "codec") {
      assert.ok(vector.rawInput);
      assert.throws(
        () => decodeAgentSourceEventFrameV1(bytesFromRawInput(vector.rawInput!)),
        (error: unknown) => {
          assert.ok(error instanceof StrictAgentFrameError);
          assert.equal(error.code, expected.errorCode, vector.id);
          return true;
        },
        vector.id,
      );
      continue;
    }
    if (vector.harness === "schema") {
      const input = vector.jsonInput as Record<string, unknown>;
      if (input.schemaTarget === "canonical_decimal") {
        assert.equal(parseCanonicalDecimalStringV1(input.value), "1.25");
      } else if (input.schemaTarget === "source_event") {
        assert.throws(
          () =>
            decodeAgentSourceEventFrameV1(
              new TextEncoder().encode(JSON.stringify(input.value)),
            ),
          (error: unknown) => {
            assert.ok(error instanceof StrictAgentFrameError);
            assert.equal(error.code, expected.errorCode, vector.id);
            return true;
          },
          vector.id,
        );
      } else if (input.schemaTarget === "tool_transition") {
        const transition = parseToolTransitionV1({
          from: input.from,
          to: input.to,
          toolBrokerInvocationCount: input.expectedInvocationCount,
        });
        assert.equal(transition.toolBrokerInvocationCount, 0, vector.id);
      } else if (input.schemaTarget === "resolve_request") {
        const parser =
          input.api === "resolveDocument"
            ? parseResolveDocumentRequestV1
            : input.api === "resolveArtifact"
              ? parseResolveArtifactRequestV1
              : parseResolveCitationRequestV1;
        const materialized = JSON.parse(canonicalizeAawJsonV1(input.value));
        if (expected.decision === "pass") {
          assert.doesNotThrow(() => parser(materialized), vector.id);
        } else {
          assert.throws(
            () => parser(materialized),
            (error: unknown) => {
              assert.ok(error instanceof AgentContractError);
              assert.equal(error.code, expected.errorCode, vector.id);
              return true;
            },
            vector.id,
          );
        }
      } else if (input.schemaTarget === "resolve_result") {
        const materialized = JSON.parse(canonicalizeAawJsonV1(input.value));
        if (expected.decision === "pass") {
          assert.doesNotThrow(() => parseResolveResultV1(materialized), vector.id);
        } else {
          assert.throws(
            () => parseResolveResultV1(materialized),
            (error: unknown) => {
              assert.ok(error instanceof AgentContractError);
              assert.equal(error.code, expected.errorCode, vector.id);
              return true;
            },
            vector.id,
          );
        }
      } else if (input.schemaTarget === "canonical_event") {
        const materialized = JSON.parse(canonicalizeAawJsonV1(input.value));
        if (expected.decision === "pass") {
          assert.doesNotThrow(() => parseCanonicalEventV1(materialized), vector.id);
        } else {
          assert.throws(
            () => parseCanonicalEventV1(materialized),
            (error: unknown) => {
              assert.ok(error instanceof AgentContractError);
              assert.equal(error.code, expected.errorCode, vector.id);
              return true;
            },
            vector.id,
          );
        }
      } else if (input.schemaTarget === "budget_contract") {
        const outcome = evaluateAgentBudgetBoundaryV1({
          budget: input.budget as never,
          limit: input.limit as number,
          observed: input.observed as number,
          ...(input.resumability === undefined
            ? {}
            : { resumability: input.resumability as never }),
        });
        assert.deepEqual(
          JSON.parse(JSON.stringify(outcome)),
          JSON.parse(JSON.stringify(expected)),
          `${vector.id}: complete budget oracle`,
        );
      } else {
        assert.fail(`${vector.id}: unknown schema target`);
      }
      continue;
    }
    const admitted =
      vector.jsonInput !== undefined
        ? vector.jsonInput
        : decodeStrictSourceFrameV1(bytesFromRawInput(vector.rawInput!), {
            allowedTopLevelKeys: ["tail"],
            maxBytes: 1_048_576,
            maxDepth: 64,
            maxStringBytes: 4_096,
          });
    const value =
      typeof admitted === "object" && admitted !== null && "decoded" in admitted
        ? admitted.decoded
        : admitted;
    const canonical = canonicalizeAawJsonV1(value);
    assert.equal(
      sha256CanonicalAawJsonV1(value),
      expected.canonicalBytesSha256,
      vector.id,
    );
    const canonicalEvents = expected.canonicalEvents as readonly {
      canonicalUtf8Hex: string;
    }[];
    assert.equal(
      Buffer.from(canonical, "utf8").toString("hex"),
      canonicalEvents[0]?.canonicalUtf8Hex,
      `${vector.id}: exact canonical bytes`,
    );
  }
});

test("P4-A synthetic manifest binds every raw fixture to exact full and payload digests", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(readJson(fixtureManifestSchemaPath) as object);
  const manifest = readJson(fixtureManifestPath) as {
    classification: string;
    entries: readonly {
      fixtureId: string;
      scenarioKind: string;
      path: string;
      byteLength: number;
      rawSha256: string;
      canonicalEventSha256: string;
      canonicalPayloadSha256: string;
      sourceRunId: string;
      sourceEventId: string;
      sourceSequence: number;
      classification: string;
      license: string;
    }[];
  };
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  for (const license of ['LicenseRef-AAW-Synthetic-Test-Only', 'UNKNOWN']) {
    const changed = structuredClone(manifest);
    (changed.entries[0] as {license: string}).license = license;
    assert.equal(validate(changed), false, `Unsupported fixture license ${license}`);
  }
  assert.equal(manifest.classification, "SYNTHETIC AGENT · NO MODEL · NO TOOLS");
  assert.equal(new Set(manifest.entries.map((entry) => entry.fixtureId)).size, manifest.entries.length);
  assert.deepEqual(
    new Set(manifest.entries.map((entry) => entry.scenarioKind)),
    new Set([
      "accepted_text_completed",
      "citation_text",
      "citation_reviewed_schematic",
      "citation_rag_source",
      "invalid_source_time_warning",
      "cancel_terminal",
      "safe_replay_resume",
      "explicit_failure_recovery",
    ]),
  );
  for (const entry of manifest.entries) {
    assert.equal(entry.license, "MIT", entry.fixtureId);
    const raw = Uint8Array.from(readFileSync(entry.path));
    assert.equal(raw.byteLength, entry.byteLength, entry.fixtureId);
    assert.equal(`sha256:${sha256File(entry.path)}`, entry.rawSha256, entry.fixtureId);
    const decoded = decodeAgentSourceEventFrameV1(raw);
    assert.equal(decoded.event.sourceRunId, entry.sourceRunId, entry.fixtureId);
    assert.equal(decoded.event.sourceEventId, entry.sourceEventId, entry.fixtureId);
    assert.equal(decoded.event.sourceSequence, entry.sourceSequence, entry.fixtureId);
    assert.equal(
      sha256CanonicalAawJsonV1(decoded.event),
      entry.canonicalEventSha256,
      entry.fixtureId,
    );
    assert.equal(
      decoded.recomputedSourcePayloadDigest,
      entry.canonicalPayloadSha256,
      entry.fixtureId,
    );
    assert.ok(Object.isFrozen(decoded.event));
    assert.ok(Object.isFrozen(decoded.event.payload));
    assert.ok(
      entry.classification === "SYNTHETIC AGENT · NO MODEL · NO TOOLS" ||
        entry.classification === "SYNTHETIC RAG SOURCE",
    );
  }
});

test("P4-A build and public-surface scans stay dependency-zero and capability-free", () => {
  assert.equal(
    sha256File("package.json"),
    // Approved P5 scripts-only manifest delta; the frozen P4 package remains in its exit evidence.
    "ccaa407c10c1b35563e8c00bd789cc209457212f21696cd8974aef2a3b1b2049",
  );
  assert.equal(
    sha256File("package-lock.json"),
    "56b63b1a1b9f8514937b1350f66c6131f37755f66b62e1bddedc66a26446e908",
  );
  const reachable = [
    "packages/agent-adapters/src/agent-contract.ts",
    "packages/agent-adapters/src/strict-agent-frame.ts",
    "packages/agent-adapters/src/conformance.ts",
    "packages/agent-adapters/src/public-contract.ts",
    "packages/agent-adapters/src/canonical-contract.ts",
  ];
  const privilegedImport =
    /(?:from\s+|require\s*\()\s*["'](?:node:)?(?:fs|child_process|worker_threads|http|https|net|tls|dns|dgram|cluster|vm)["']/u;
  for (const path of reachable) {
    const source = readFileSync(path, "utf8");
    assert.equal(privilegedImport.test(source), false, path);
    assert.equal(/\b(?:fetch|WebSocket|spawn|execFile|shell|ipcRenderer)\s*\(/u.test(source), false, path);
  }
  const publicContractSource = readFileSync(
    "packages/agent-adapters/src/agent-contract.ts",
    "utf8",
  );
  assert.equal(
    /export\s+(?:function|const)\s+(?:parse|accept)AgentSourceEvent/u.test(
      publicContractSource,
    ),
    false,
    "SourceEvent runtime surface must remain byte-only",
  );

  const sourceSchema = readJson(sourceEventSchemaPath) as {
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  assert.equal(sourceSchema.additionalProperties, false);
  for (const forbidden of [
    "hostRunId",
    "eventId",
    "hostSequence",
    "acceptedAt",
    "canonicalPayloadDigest",
    "adapterInstanceId",
    "resumeEpoch",
    "retryability",
    "recoveryAction",
    "resolverToken",
    "path",
    "grant",
  ]) {
    assert.equal(forbidden in sourceSchema.properties, false, forbidden);
  }

  const fixtureValues = collectStringValues([
    readJson(manifestPath),
    readJson(fixtureManifestPath),
    readJson(resultReceiptPath),
  ]);
  for (const value of fixtureValues) {
    assert.equal(/[A-Za-z]:\\|\\\\|file:\/\/|https?:\/\/|@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u.test(value), false, value);
    assert.equal(/(?:api[_-]?key|client[_-]?secret)\s*[:=]\s*\S+/iu.test(value), false, value);
  }
});
