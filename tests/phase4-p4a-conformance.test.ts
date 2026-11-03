import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONFORMANCE_CONTRACT_VERSION_V1,
  ConformanceContractError,
  evaluateConformanceStageV1,
  parseConformanceResultReceiptV1,
  parseConformanceTraceabilityManifestV1,
  parseConformanceVectorV1,
  type ConformanceContractErrorCodeV1,
} from "../packages/agent-adapters/src/conformance";

function conformanceError(
  code: ConformanceContractErrorCodeV1,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ConformanceContractError);
    assert.equal(error.code, code);
    return true;
  };
}

function codecVector(id: string, oracleId = "N01") {
  return {
    id,
    oracleId,
    contractVersion: "aaw.agent.conformance/v1alpha1",
    harness: "codec",
    requiredStage: "P4-A",
    negotiatedCapabilities: [],
    rawInput: { utf8Hex: "7b7d" },
    expected: {
      decision: "reject",
      errorCode: "MALFORMED_EVENT",
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
    },
  } as const;
}

function p4bAddendumExpected(
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
    reducerDelta: 1,
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

function firstCancelDispatchExpected(
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

function p4bAddendumVector(
  id: string,
  action: string,
  stepFields: Readonly<Record<string, unknown>> = {},
  expectedFields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    oracleId: id.slice(0, 3),
    contractVersion: "aaw.agent.conformance/v1alpha1",
    harness: "reducer",
    requiredStage: "P4-B",
    negotiatedCapabilities: [],
    preState: {
      fixtureId: "synthetic-addendum-red",
      hostSequence: 2,
      terminal: false,
      quarantined: false,
    },
    steps: [{ action, ...stepFields }],
    expected: p4bAddendumExpected(expectedFields),
  };
}

function withoutExpectedField(
  vector: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> {
  const candidate = structuredClone(vector) as {
    expected: Record<string, unknown>;
  };
  delete candidate.expected[field];
  return candidate;
}

test("P4-A conformance vector is a closed harness-discriminated union", () => {
  assert.equal(
    CONFORMANCE_CONTRACT_VERSION_V1,
    "aaw.agent.conformance/v1alpha1",
  );
  const parsed = parseConformanceVectorV1(codecVector("N01-a"));
  assert.equal(parsed.harness, "codec");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.expected));

  assert.throws(
    () =>
      parseConformanceVectorV1({
        ...codecVector("N01-b"),
        rawInput: { utf8Hex: "7b7d", base64: "e30=" },
      }),
    conformanceError("INVALID_VECTOR"),
  );
  assert.throws(
    () =>
      parseConformanceVectorV1({
        ...codecVector("N01-c"),
        input: "free-form",
      }),
    conformanceError("INVALID_VECTOR"),
  );
  assert.throws(
    () =>
      parseConformanceVectorV1({
        ...codecVector("N01-d"),
        digest: "sha256:deadbeef",
      }),
    conformanceError("INVALID_VECTOR"),
  );
});

test("P4-A addendum closes P4-B cancel and replay step discriminators", () => {
  const validCases = [
    p4bAddendumVector(
      "N28-cancel-before-stream",
      "request-cancel",
      { monotonicMs: 1000 },
      firstCancelDispatchExpected(),
    ),
    p4bAddendumVector(
      "N28-cancel-ack-terminal-once",
      "submit-cancel-ack",
      { sourceSequence: 1, sourceEventId: "synthetic.event.cancel-ack" },
      {
        cancelDispatchDelta: 0,
        postRunLifecycle: "terminal",
        checkpointDelta: 1,
        ackPersistDelta: 1,
        checkpointRows: [
          {
            hostRunId: "host.synthetic-addendum-red",
            eventId: "event.synthetic-addendum-red.3",
            hostSequence: 3,
            resumeEpoch: 1,
          },
        ],
        ackRows: [
          {
            hostRunId: "host.synthetic-addendum-red",
            eventId: "event.synthetic-addendum-red.3",
            hostSequence: 3,
            resumeEpoch: 1,
          },
        ],
      },
    ),
    p4bAddendumVector(
      "N28-cancel-timeout-late-event-isolated",
      "fire-cancel-timeout",
      { monotonicMs: 200 },
      {
        decision: "block",
        errorCode: "CANCELLATION_TIMEOUT",
        quarantineState: "active",
        reducerDelta: 0,
        cancelDispatchDelta: 0,
        postRunLifecycle: "quarantined",
      },
    ),
    p4bAddendumVector(
      "N28-cancel-timeout-late-event-isolated",
      "submit-late-after-cancel",
      { sourceSequence: 3, sourceEventId: "synthetic.event.cancel-late" },
      {
        decision: "isolate",
        errorCode: "PROTOCOL_MISMATCH",
        quarantineState: "active",
        reducerDelta: 0,
        cancelDispatchDelta: 0,
        postRunLifecycle: "quarantined",
      },
    ),
    p4bAddendumVector(
      "N18-host-replay-after-zero",
      "subscribe-replay",
      { afterHostSequence: 0 },
      {
        reducerDelta: 0,
        deliveryHostSequences: [1, 2],
        subscriptionDisposition: "wait",
      },
    ),
    p4bAddendumVector(
      "N18-host-replay-omitted-after-zero",
      "subscribe-replay",
      {},
      {
        reducerDelta: 0,
        deliveryHostSequences: [1, 2],
        subscriptionDisposition: "wait",
      },
    ),
    p4bAddendumVector(
      "N28-monotonic-deadline-metamorphic",
      "advance-monotonic-clock",
      { monotonicMs: 2001 },
      {
        reducerDelta: 0,
        cancelDispatchDelta: 0,
        postRunLifecycle: "quarantined",
      },
    ),
    p4bAddendumVector(
      "N18-host-replay-snapshot-tail-exactly-once",
      "commit-live-tail",
      { sourceSequence: 3, sourceEventId: "synthetic.event.live-tail" },
      {
        deliveryHostSequences: [1, 2, 3],
        subscriptionDisposition: "wait",
        checkpointDelta: 1,
        ackPersistDelta: 1,
        checkpointRows: [
          {
            hostRunId: "host.synthetic-addendum-red",
            eventId: "event.synthetic-addendum-red.3",
            hostSequence: 3,
            resumeEpoch: 1,
          },
        ],
        ackRows: [
          {
            hostRunId: "host.synthetic-addendum-red",
            eventId: "event.synthetic-addendum-red.3",
            hostSequence: 3,
            resumeEpoch: 1,
          },
        ],
      },
    ),
    p4bAddendumVector(
      "N18-host-replay-snapshot-tail-exactly-once",
      "drain-replay-tail",
      {},
      {
        reducerDelta: 0,
        deliveryHostSequences: [1, 2, 3],
        subscriptionDisposition: "wait",
      },
    ),
  ];
  for (const vector of validCases) {
    assert.doesNotThrow(
      () => parseConformanceVectorV1(vector),
      `${String(vector.id)} must be admitted by the closed addendum runtime parser`,
    );
  }
  for (const vector of [
    validCases[0],
    validCases[1],
    validCases[2],
    validCases[3],
    validCases[6],
  ]) {
    assert.ok(vector);
    for (const field of ["cancelDispatchDelta", "postRunLifecycle"]) {
      assert.throws(
        () => parseConformanceVectorV1(withoutExpectedField(vector, field)),
        conformanceError("INVALID_VECTOR"),
        `${String(vector.id)} must require expected.${field}`,
      );
    }
  }
  for (const vector of [validCases[1], validCases[7]]) {
    assert.ok(vector);
    for (const field of [
      "checkpointDelta",
      "ackPersistDelta",
      "checkpointRows",
      "ackRows",
    ]) {
      assert.throws(
        () => parseConformanceVectorV1(withoutExpectedField(vector, field)),
        conformanceError("INVALID_VECTOR"),
        `${String(vector.id)} must require expected.${field}`,
      );
    }
  }
  const firstCancelVector = validCases[0];
  assert.ok(firstCancelVector);
  const firstCancel = parseConformanceVectorV1(firstCancelVector);
  assert.deepEqual(
    {
      postCancelCommandId: firstCancel.expected.postCancelCommandId,
      postCancelDeadlineMonotonicMs:
        firstCancel.expected.postCancelDeadlineMonotonicMs,
      postCancelDispatchState: firstCancel.expected.postCancelDispatchState,
    },
    {
      postCancelCommandId: "cancel.synthetic.command.1",
      postCancelDeadlineMonotonicMs: 2000,
      postCancelDispatchState: "dispatched",
    },
  );
  for (const field of [
    "postCancelCommandId",
    "postCancelDeadlineMonotonicMs",
    "postCancelDispatchState",
  ]) {
    assert.throws(
      () =>
        parseConformanceVectorV1(
          withoutExpectedField(firstCancelVector, field),
        ),
      conformanceError("INVALID_VECTOR"),
      `first cancel dispatch must require expected.${field}`,
    );
  }
  const unsafePostDeadline = structuredClone(firstCancelVector) as {
    expected: Record<string, unknown>;
  };
  unsafePostDeadline.expected.postCancelDeadlineMonotonicMs =
    Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => parseConformanceVectorV1(unsafePostDeadline),
    conformanceError("INVALID_VECTOR"),
  );
  const repeatedCancel = p4bAddendumVector(
    "N28-cancel-repeated-idempotent",
    "request-cancel",
    { monotonicMs: 1001 },
    { cancelDispatchDelta: 0, postRunLifecycle: "cancelling" },
  );
  assert.doesNotThrow(() => parseConformanceVectorV1(repeatedCancel));
  for (const [field, value] of [
    ["postCancelCommandId", "cancel.synthetic.command.extra"],
    ["postCancelDeadlineMonotonicMs", 2000],
    ["postCancelDispatchState", "dispatched"],
  ] as const) {
    const extraPostField = structuredClone(repeatedCancel) as {
      expected: Record<string, unknown>;
    };
    extraPostField.expected[field] = value;
    assert.throws(
      () => parseConformanceVectorV1(extraPostField),
      conformanceError("INVALID_VECTOR"),
      `zero dispatch must forbid expected.${field}`,
    );
  }

  const traceability = JSON.parse(
    readFileSync(
      "packages/agent-adapters/fixtures/n01-n30.traceability.json",
      "utf8",
    ),
  ) as { vectors: Record<string, unknown>[] };
  const ledgerRecoveryVectors = traceability.vectors.filter(
    (vector) => vector.harness === "ledger_recovery",
  );
  assert.ok(ledgerRecoveryVectors.length > 0);
  for (const vector of ledgerRecoveryVectors) {
    assert.doesNotThrow(() => parseConformanceVectorV1(vector), String(vector.id));
    for (const field of [
      "checkpointDelta",
      "ackPersistDelta",
      "checkpointRows",
      "ackRows",
    ]) {
      assert.throws(
        () => parseConformanceVectorV1(withoutExpectedField(vector, field)),
        conformanceError("INVALID_VECTOR"),
        `${String(vector.id)} must require expected.${field}`,
      );
    }
  }
  for (const vector of [validCases[1], validCases[7]]) {
    assert.ok(vector);
    for (const field of ["checkpointRows", "ackRows"] as const) {
      const shortRows = structuredClone(vector) as {
        expected: Record<string, unknown>;
      };
      shortRows.expected[field] = [];
      assert.throws(
        () => parseConformanceVectorV1(shortRows),
        conformanceError("INVALID_VECTOR"),
        `${String(vector.id)} ${field} length must equal delta`,
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
    const nonemptyZeroRows = structuredClone(zeroRowVector) as {
      expected: Record<string, unknown>;
    };
    nonemptyZeroRows.expected[field] = [
      {
        hostRunId: "host.synthetic-addendum-red",
        eventId: "event.synthetic-addendum-red.1",
        hostSequence: 1,
        resumeEpoch: 1,
      },
    ];
    assert.throws(
      () => parseConformanceVectorV1(nonemptyZeroRows),
      conformanceError("INVALID_VECTOR"),
      `${String(zeroRowVector.id)} ${field} length must equal zero delta`,
    );
  }
  const explicitZero = parseConformanceVectorV1(validCases[4]) as unknown as {
    readonly steps: readonly Readonly<Record<string, unknown>>[];
  };
  const omittedZero = parseConformanceVectorV1(validCases[5]) as unknown as {
    readonly steps: readonly Readonly<Record<string, unknown>>[];
  };
  assert.deepEqual(
    omittedZero.steps,
    explicitZero.steps,
    "omitted afterHostSequence must canonicalize exactly to explicit zero",
  );

  for (const invalid of [
    p4bAddendumVector(
      "N28-cancel-before-stream",
      "request-cancel",
      {
        monotonicMs: 1000,
        sourceSequence: 1,
        sourceEventId: "synthetic.event.cancel-request",
      },
      firstCancelDispatchExpected(),
    ),
    p4bAddendumVector(
      "N18-host-replay-after-zero",
      "subscribe-replay",
      { sourceEventId: "synthetic.event.replay" },
      { deliveryHostSequences: [], subscriptionDisposition: "wait" },
    ),
    {
      ...validCases[1],
      steps: [{ action: "submit-cancel-ack" }],
    },
    {
      ...validCases[7],
      steps: [
        {
          action: "commit-live-tail",
          afterHostSequence: 2,
          sourceSequence: 3,
          sourceEventId: "synthetic.event.live-tail",
        },
      ],
    },
    p4bAddendumVector(
      "N28-cancel-before-stream",
      "request-cancel",
      { monotonicMs: 1000, api: "resolveDocument" },
      firstCancelDispatchExpected(),
    ),
    p4bAddendumVector(
      "N28-cancel-before-stream",
      "request-cancel",
      { monotonicMs: 1000, request: {} },
      firstCancelDispatchExpected(),
    ),
    p4bAddendumVector(
      "N28-cancel-before-stream",
      "request-cancel",
      { monotonicMs: 1000, api: "resolveDocument", request: {} },
      firstCancelDispatchExpected(),
    ),
    p4bAddendumVector(
      "N28-cancel-before-stream",
      "request-cancel",
      {},
      firstCancelDispatchExpected(),
    ),
    p4bAddendumVector(
      "N28-monotonic-deadline-metamorphic",
      "advance-monotonic-clock",
      {},
      {
        reducerDelta: 0,
        cancelDispatchDelta: 0,
        postRunLifecycle: "quarantined",
      },
    ),
    p4bAddendumVector(
      "N28-cancel-timeout-late-event-isolated",
      "fire-cancel-timeout",
      {},
      {
        reducerDelta: 0,
        cancelDispatchDelta: 0,
        postRunLifecycle: "quarantined",
      },
    ),
    p4bAddendumVector(
      "N18-host-replay-after-zero",
      "subscribe-replay",
      { monotonicMs: 1000 },
      { deliveryHostSequences: [1, 2], subscriptionDisposition: "wait" },
    ),
    p4bAddendumVector(
      "N28-cancel-before-stream",
      "request-cancel",
      { monotonicMs: Number.MAX_SAFE_INTEGER + 1 },
      firstCancelDispatchExpected(),
    ),
    p4bAddendumVector(
      "N28-cancel-before-stream",
      "request-cancel",
      { monotonicMs: 100 },
      firstCancelDispatchExpected({
        deliveryHostSequences: [],
        subscriptionDisposition: "wait",
      }),
    ),
    p4bAddendumVector(
      "N18-host-replay-after-zero",
      "subscribe-replay",
      { afterHostSequence: 0 },
      { cancelDispatchDelta: 0 },
    ),
  ]) {
    assert.throws(
      () => parseConformanceVectorV1(invalid),
      conformanceError("INVALID_VECTOR"),
      `${String(invalid.id)} must reject action-field cross products`,
    );
  }

  assert.throws(
    () =>
      parseConformanceVectorV1({
        ...codecVector("N01-addendum-field-leak"),
        expected: {
          ...codecVector("N01-addendum-field-leak").expected,
          checkpointRows: [],
        },
      }),
    conformanceError("INVALID_VECTOR"),
    "addendum expected fields must be forbidden on unrelated harnesses",
  );
});

test("P4-A traceability requires a unique vector mapping for every N01-N30", () => {
  const raw = JSON.parse(
    readFileSync(
      "packages/agent-adapters/fixtures/n01-n30.traceability.json",
      "utf8",
    ),
  );
  const parsed = parseConformanceTraceabilityManifestV1(raw);
  assert.ok(parsed.vectors.length >= 30);
  assert.ok(parsed.stateFixtures.length >= 1);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.vectors));

  const missingElectron = structuredClone(raw);
  missingElectron.vectors = missingElectron.vectors.filter(
    (vector: { harness: string }) => vector.harness !== "electron_boundary",
  );
  assert.throws(
    () => parseConformanceTraceabilityManifestV1(missingElectron),
    conformanceError("TRACEABILITY_INCOMPLETE"),
  );

  const duplicate = structuredClone(raw);
  duplicate.vectors.push(structuredClone(duplicate.vectors[0]));
  assert.throws(
    () => parseConformanceTraceabilityManifestV1(duplicate),
    conformanceError("TRACEABILITY_DUPLICATE"),
  );
});

test("P4-A stage evaluation blocks only required current-or-earlier NOT_RUN", () => {
  const manifest = parseConformanceTraceabilityManifestV1(
    JSON.parse(
      readFileSync(
        "packages/agent-adapters/fixtures/n01-n30.traceability.json",
        "utf8",
      ),
    ),
  );
  const rawReceipt = JSON.parse(
    readFileSync(
      "packages/agent-adapters/fixtures/p4a-conformance-results.json",
      "utf8",
    ),
  );
  const receipt = parseConformanceResultReceiptV1(manifest, rawReceipt);
  assert.deepEqual(
    evaluateConformanceStageV1("P4-A", manifest, receipt),
    { status: "PASS", blockers: [] },
  );

  const omitted = structuredClone(rawReceipt);
  omitted.results.pop();
  assert.throws(
    () => parseConformanceResultReceiptV1(manifest, omitted),
    conformanceError("TRACEABILITY_INCOMPLETE"),
  );
  const falsePass = structuredClone(rawReceipt);
  const later = falsePass.results.find(
    (result: { requiredStage: string }) => result.requiredStage === "P4-B",
  );
  later.status = "PASS";
  assert.throws(
    () => parseConformanceResultReceiptV1(manifest, falsePass),
    conformanceError("INVALID_VECTOR"),
  );
});
