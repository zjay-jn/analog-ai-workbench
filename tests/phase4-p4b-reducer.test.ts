import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { decodeSyntheticSourceFrameV1 } from "../packages/agent-adapters/src/deterministic-synthetic-adapter";
import {
  createP4bHarnessDependencies,
  executionInputFor,
  loadApprovedP4bSourceFrames,
  loadFrozenP4bVectors,
  optionalP4bReducerRunner,
  runAndRequireRecord,
  runInputAndRequireRecord,
  type FrozenP4bVector,
  type P4bExecutionInput,
  type P4bHarnessDependenciesV1,
  type P4bVectorRunner,
} from "./helpers/phase4-p4b-runner";

const reducerVectors = loadFrozenP4bVectors().filter(
  (vector) => vector.harness === "reducer",
);

function vectorById(id: string): FrozenP4bVector {
  const vector = reducerVectors.find((candidate) => candidate.id === id);
  assert.ok(vector, `${id} must remain in the frozen P4-B reducer table`);
  return vector;
}

function mutateInput(
  id: string,
  mutate: (steps: Array<Record<string, unknown>>) => void,
): P4bExecutionInput {
  const input = structuredClone(executionInputFor(vectorById(id))) as unknown as {
    steps: unknown[];
  };
  assert.ok(
    input.steps.every(
      (step) => step !== null && typeof step === "object" && !Array.isArray(step),
    ),
    id,
  );
  mutate(input.steps as Array<Record<string, unknown>>);
  return input as unknown as P4bExecutionInput;
}

async function requireAvailableReducer(
  t: TestContext,
): Promise<P4bVectorRunner | undefined> {
  const loaded = await optionalP4bReducerRunner();
  if (!loaded.available) {
    t.skip(loaded.code);
    return undefined;
  }
  return loaded.runner;
}

test("P4-B reducer executes all 31 frozen table oracles", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;
  assert.equal(reducerVectors.length, 31);
  for (const vector of reducerVectors) {
    const actual = await runAndRequireRecord(runner, vector);
    assert.deepEqual(actual, vector.expected, vector.id);
  }
});

test("P4-B reducer is deterministic and capability-free", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;
  for (const vector of reducerVectors) {
    const first = await runAndRequireRecord(runner, vector);
    const second = await runAndRequireRecord(runner, vector);
    assert.deepEqual(second, first, `${vector.id} must be deterministic`);
    const sideEffectCounters = first.sideEffectCounters;
    assert.ok(
      sideEffectCounters !== null &&
        typeof sideEffectCounters === "object" &&
        !Array.isArray(sideEffectCounters),
      vector.id,
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(sideEffectCounters)),
      {
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
      vector.id,
    );
  }
});

test("P4-B replay cursor omission is exactly afterHostSequence zero", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;
  const explicitZero = await runAndRequireRecord(
    runner,
    vectorById("N18-host-replay-after-zero"),
  );
  const omittedZero = await runAndRequireRecord(
    runner,
    vectorById("N18-host-replay-omitted-after-zero"),
  );
  assert.deepEqual(omittedZero, explicitZero);
});

test("P4-B replay snapshot and live tail deliver each host sequence once", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;
  const actual = await runAndRequireRecord(
    runner,
    vectorById("N18-host-replay-snapshot-tail-exactly-once"),
  );
  const deliveries = actual.deliveryHostSequences;
  assert.ok(Array.isArray(deliveries));
  assert.deepEqual(deliveries, [...new Set(deliveries)]);
  assert.equal(actual.rendererEmissions, deliveries.length);
  assert.deepEqual(actual, vectorById("N18-host-replay-snapshot-tail-exactly-once").expected);
});

test("P4-B cancel state machine dispatches and terminates at most once", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;
  const ids = [
    "N28-cancel-before-stream",
    "N28-cancel-during-delta",
    "N28-cancel-repeated-idempotent",
    "N28-cancel-ack-terminal-once",
    "N28-cancel-after-terminal-noop",
    "N28-cancel-timeout-late-event-isolated",
    "N28-monotonic-deadline-metamorphic",
  ] as const;
  for (const id of ids) {
    const vector = vectorById(id);
    const actual = await runAndRequireRecord(runner, vector);
    assert.deepEqual(actual, vector.expected, id);
    const dispatchDelta = actual.cancelDispatchDelta;
    if (dispatchDelta !== undefined) {
      assert.ok(dispatchDelta === 0 || dispatchDelta === 1, id);
    }
    if (id.includes("timeout") || id.includes("deadline")) {
      assert.equal(actual.rendererEmissions, 0, id);
      assert.equal(actual.quarantineState, "active", id);
    }
  }
});

test("P4-B source-time warning and wall-clock permutations cannot alter identity", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;
  for (const id of [
    "N17-invalid-semantic-time-warning",
    "N17-source-time-drift-invariant",
    "N28-monotonic-deadline-metamorphic",
  ]) {
    const vector = vectorById(id);
    const actual = await runAndRequireRecord(runner, vector);
    assert.deepEqual(actual, vector.expected, id);
  }
});

test("P4-B approved raw source frames traverse the strict decoder", () => {
  const frames = loadApprovedP4bSourceFrames();
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    const decoded = decodeSyntheticSourceFrameV1(frame.rawBytes);
    assert.equal(decoded.rawByteLength, frame.rawBytes.byteLength, frame.fixtureId);
    assert.equal(decoded.event.sourceRunId, frame.sourceRunId, frame.fixtureId);
    assert.equal(decoded.event.sourceEventId, frame.sourceEventId, frame.fixtureId);
    assert.equal(decoded.event.sourceSequence, frame.sourceSequence, frame.fixtureId);
  }

  const corrupted = Uint8Array.from(frames[0]!.rawBytes);
  corrupted[0] = corrupted[0]! ^ 1;
  assert.throws(() => decodeSyntheticSourceFrameV1(corrupted));
});

test("P4-B source sequence and injected raw identity mutations fail closed", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;

  const changedSequence = mutateInput("N01-exact-primary-replay", (steps) => {
    steps[0]!.sourceSequence = 2;
  });
  const sequenceResult = await runInputAndRequireRecord(runner, changedSequence);
  assert.equal(sequenceResult.decision, "isolate");
  assert.equal(sequenceResult.errorCode, "PROTOCOL_MISMATCH");
  assert.equal(sequenceResult.mappingDelta, 0);
  assert.equal(sequenceResult.rendererEmissions, 0);

  const sourceFrames = loadApprovedP4bSourceFrames();
  const cancelIndex = sourceFrames.findIndex(
    (frame) => frame.fixtureId === "synthetic.cancel-acknowledged",
  );
  assert.notEqual(cancelIndex, -1);
  const original = sourceFrames[cancelIndex]!;
  const originalText = Buffer.from(original.rawBytes).toString("utf8");
  const changedIdentity = `${original.sourceEventId.slice(0, -1)}x`;
  const changedText = originalText.replace(original.sourceEventId, changedIdentity);
  assert.equal(Buffer.byteLength(changedText), original.rawBytes.byteLength);
  const mutatedFrames = sourceFrames.map((frame, index) =>
    index === cancelIndex
      ? Object.freeze({ ...frame, rawBytes: Uint8Array.from(Buffer.from(changedText)) })
      : frame,
  );
  const dependencies: P4bHarnessDependenciesV1 = Object.freeze({
    sourceFrames: Object.freeze(mutatedFrames),
  });
  let closedResult: Readonly<Record<string, unknown>> | undefined;
  try {
    closedResult = await runAndRequireRecord(
      runner,
      vectorById("N28-cancel-ack-terminal-once"),
      dependencies,
    );
  } catch {
    return;
  }
  assert.notEqual(closedResult.decision, "accept");
  assert.equal(closedResult.rendererEmissions, 0);
});

test("P4-B reducer observes every ordered replay and cancel step", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;

  const snapshotVector = vectorById(
    "N18-host-replay-snapshot-tail-exactly-once",
  );
  const complete = await runAndRequireRecord(runner, snapshotVector);
  const withoutDrain = mutateInput(snapshotVector.id, (steps) => {
    steps.splice(2, 1);
  });
  assert.notDeepEqual(
    await runInputAndRequireRecord(runner, withoutDrain),
    complete,
  );
  const reordered = mutateInput(snapshotVector.id, (steps) => {
    const first = steps[0]!;
    steps[0] = steps[1]!;
    steps[1] = first;
  });
  let reorderedResult: Readonly<Record<string, unknown>> | undefined;
  try {
    reorderedResult = await runInputAndRequireRecord(runner, reordered);
  } catch {
    // Rejecting an invalid step order before mutation is also fail closed.
  }
  if (reorderedResult !== undefined) {
    assert.notEqual(reorderedResult.decision, "accept");
    assert.equal(reorderedResult.rendererEmissions, 0);
  }

  const timeoutVector = vectorById("N28-cancel-timeout-late-event-isolated");
  const timeoutOnly = mutateInput(timeoutVector.id, (steps) => {
    steps.splice(1, 1);
  });
  assert.deepEqual(
    await runInputAndRequireRecord(runner, timeoutOnly),
    timeoutVector.expected,
  );

  const repeatedVector = vectorById("N28-cancel-repeated-idempotent");
  const singleRepeat = mutateInput(repeatedVector.id, (steps) => {
    steps.splice(1, 1);
  });
  assert.deepEqual(
    await runInputAndRequireRecord(runner, singleRepeat),
    repeatedVector.expected,
  );
});

test("P4-B cancellation deadline uses only the injected monotonic boundary", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;
  const vector = vectorById("N28-monotonic-deadline-metamorphic");
  for (const monotonicMs of [1999, 2000]) {
    const input = mutateInput(vector.id, (steps) => {
      steps[1]!.monotonicMs = monotonicMs;
    });
    const actual = await runInputAndRequireRecord(
      runner,
      input,
      createP4bHarnessDependencies(),
    );
    assert.equal(actual.decision, "accept", String(monotonicMs));
    assert.equal(actual.quarantineState, "unchanged", String(monotonicMs));
    assert.equal(actual.postRunLifecycle, "cancelling", String(monotonicMs));
    assert.equal(actual.rendererEmissions, 0, String(monotonicMs));
  }
  const afterDeadline = mutateInput(vector.id, (steps) => {
    steps[1]!.monotonicMs = 2001;
  });
  assert.deepEqual(
    await runInputAndRequireRecord(runner, afterDeadline),
    vector.expected,
  );
});

test("P4-B request-cancel then timeout is reduced step by step", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;
  const vector = vectorById("N28-cancel-before-stream");

  for (const monotonicMs of [1999, 2000]) {
    const input = mutateInput(vector.id, (steps) => {
      steps.push({ action: "fire-cancel-timeout", monotonicMs });
    });
    const actual = await runInputAndRequireRecord(runner, input);
    assert.equal(actual.decision, "accept", String(monotonicMs));
    assert.equal(actual.cancelDispatchDelta, 1, String(monotonicMs));
    assert.equal(actual.postRunLifecycle, "cancelling", String(monotonicMs));
    assert.equal(actual.quarantineState, "unchanged", String(monotonicMs));
    assert.equal(actual.rendererEmissions, 0, String(monotonicMs));
  }

  const timedOut = mutateInput(vector.id, (steps) => {
    steps.push({ action: "fire-cancel-timeout", monotonicMs: 2001 });
  });
  const timeoutResult = await runInputAndRequireRecord(runner, timedOut);
  assert.equal(timeoutResult.decision, "block");
  assert.equal(timeoutResult.errorCode, "CANCELLATION_TIMEOUT");
  assert.equal(timeoutResult.cancelDispatchDelta, 1);
  assert.equal(timeoutResult.postRunLifecycle, "quarantined");
  assert.equal(timeoutResult.quarantineState, "active");
  assert.equal(timeoutResult.rendererEmissions, 0);

  const timedOutThenLate = mutateInput(vector.id, (steps) => {
    steps.push(
      { action: "fire-cancel-timeout", monotonicMs: 2001 },
      {
        action: "submit-late-after-cancel",
        sourceSequence: 3,
        sourceEventId: "synthetic.event.cancel-late",
      },
    );
  });
  const lateResult = await runInputAndRequireRecord(runner, timedOutThenLate);
  assert.equal(lateResult.decision, "block");
  assert.equal(lateResult.errorCode, "CANCELLATION_TIMEOUT");
  assert.equal(lateResult.cancelDispatchDelta, 1);
  assert.equal(lateResult.mappingDelta, 0);
  assert.equal(lateResult.ledgerDelta, 0);
  assert.equal(lateResult.rendererEmissions, 0);
  assert.deepEqual(lateResult.canonicalEvents, []);
});

test("P4-B replay rejects invalid sequencing and unrelated trailing actions", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;
  const vector = vectorById("N18-host-replay-snapshot-tail-exactly-once");

  const assertFailsClosed = async (input: P4bExecutionInput): Promise<void> => {
    let actual: Readonly<Record<string, unknown>> | undefined;
    try {
      actual = await runInputAndRequireRecord(runner, input);
    } catch {
      return;
    }
    assert.notEqual(actual.decision, "accept");
    assert.equal(actual.rendererEmissions, 0);
  };

  const drainBeforeCommit = mutateInput(vector.id, (steps) => {
    const commit = steps[1]!;
    steps[1] = steps[2]!;
    steps[2] = commit;
  });
  const duplicateCommit = mutateInput(vector.id, (steps) => {
    steps.splice(2, 0, structuredClone(steps[1]!));
  });
  const duplicateDrain = mutateInput(vector.id, (steps) => {
    steps.push(structuredClone(steps[2]!));
  });
  const unrelatedMiddle = mutateInput(vector.id, (steps) => {
    steps.splice(1, 0, { action: "request-cancel", monotonicMs: 1000 });
  });
  const trailingAction = mutateInput(vector.id, (steps) => {
    steps.push({ action: "reduce-recovery", sourceSequence: 1 });
  });
  const unknownAction = mutateInput(vector.id, (steps) => {
    steps.push({ action: "synthetic-unknown-action" });
  });
  for (const input of [
    drainBeforeCommit,
    duplicateCommit,
    duplicateDrain,
    unrelatedMiddle,
    trailingAction,
    unknownAction,
  ]) {
    await assertFailsClosed(input);
  }
});

test("P4-B replay blocks corrupt persisted ledger state without throwing", async (t) => {
  const runner = await requireAvailableReducer(t);
  if (runner === undefined) return;
  const vector = vectorById("N18-host-replay-snapshot-tail-exactly-once");

  const cases: ReadonlyArray<
    Readonly<{
      name: string;
      mutate(stateFixture: Record<string, unknown>): void;
    }>
  > = [
    {
      name: "duplicate eventId and hostSequence",
      mutate(stateFixture) {
        const ledger = stateFixture.ledger;
        assert.ok(Array.isArray(ledger) && ledger.length > 0);
        ledger.push(structuredClone(ledger[ledger.length - 1]!));
      },
    },
    {
      name: "run head mismatch",
      mutate(stateFixture) {
        const run = stateFixture.run;
        assert.ok(run !== null && typeof run === "object" && !Array.isArray(run));
        (run as Record<string, unknown>).hostSequence = 3;
        (run as Record<string, unknown>).committedHead = 3;
      },
    },
    {
      name: "malformed canonical ledger hex",
      mutate(stateFixture) {
        const ledger = stateFixture.ledger;
        assert.ok(Array.isArray(ledger) && ledger.length > 0);
        const row = ledger[ledger.length - 1];
        assert.ok(row !== null && typeof row === "object" && !Array.isArray(row));
        (row as Record<string, unknown>).canonicalUtf8Hex = "zz";
      },
    },
  ];

  for (const entry of cases) {
    const input = structuredClone(executionInputFor(vector)) as unknown as {
      stateFixture: Record<string, unknown>;
    };
    entry.mutate(input.stateFixture);
    const actual = await runInputAndRequireRecord(
      runner,
      input as unknown as P4bExecutionInput,
    );
    assert.equal(actual.decision, "block", entry.name);
    assert.equal(actual.errorCode, "INTERNAL", entry.name);
    assert.equal(actual.quarantineState, "active", entry.name);
    assert.deepEqual(actual.deliveryHostSequences, [], entry.name);
    assert.equal(actual.subscriptionDisposition, "closed", entry.name);
    assert.equal(actual.rendererEmissions, 0, entry.name);
  }
});
