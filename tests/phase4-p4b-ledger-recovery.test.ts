import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  calculateP4bLedgerIntegrityV1,
  createRestartableAgentLedgerV1,
} from "../packages/agent-adapters/src/agent-ledger-contract";
import { canonicalizeAawJsonV1 } from "../packages/schematic-workbench/src/canonical-json";
import {
  createP4bHarnessDependencies,
  executionInputFor,
  loadFrozenP4bManifest,
  loadFrozenP4bVectors,
  optionalP4bLedgerRecoveryRunner,
  runAndRequireRecord,
  runInputAndRequireRecord,
  type FrozenP4bVector,
  type P4bExecutionInput,
  type P4bVectorRunner,
} from "./helpers/phase4-p4b-runner";

const recoveryVectors = loadFrozenP4bVectors().filter(
  (vector) => vector.harness === "ledger_recovery",
);

function vectorById(id: string): FrozenP4bVector {
  const vector = recoveryVectors.find((candidate) => candidate.id === id);
  assert.ok(vector, `${id} must remain in the frozen P4-B recovery table`);
  return vector;
}

function fixtureById(id: string): Readonly<Record<string, unknown>> {
  const fixture = loadFrozenP4bManifest().stateFixtures.find(
    (candidate) => candidate.fixtureId === id,
  );
  assert.ok(fixture, `${id} must remain a frozen state fixture`);
  return fixture as unknown as Readonly<Record<string, unknown>>;
}

function rowsOf(
  state: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] {
  const rows = state[key];
  assert.ok(Array.isArray(rows), `${key} must be an array`);
  return rows;
}

function mutableFixtureById(id: string): Record<string, unknown> {
  return structuredClone(fixtureById(id)) as Record<string, unknown>;
}

function mutableRecordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const field = value[key];
  assert.ok(field !== null && typeof field === "object" && !Array.isArray(field));
  return field as Record<string, unknown>;
}

function mutableRowsField(
  value: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const field = value[key];
  assert.ok(Array.isArray(field), `${key} must be an array`);
  assert.ok(
    field.every(
      (row) => row !== null && typeof row === "object" && !Array.isArray(row),
    ),
    key,
  );
  return field as Array<Record<string, unknown>>;
}

function rewriteCanonicalRow(
  row: Record<string, unknown>,
  patch: Readonly<Record<string, unknown>>,
): void {
  const canonicalUtf8Hex = row.canonicalUtf8Hex;
  if (typeof canonicalUtf8Hex !== "string") {
    throw new TypeError("canonicalUtf8Hex must be a string");
  }
  const event = JSON.parse(
    Buffer.from(canonicalUtf8Hex, "hex").toString("utf8"),
  ) as Record<string, unknown>;
  Object.assign(event, patch);
  Object.assign(row, patch, {
    canonicalUtf8Hex: Buffer.from(
      canonicalizeAawJsonV1(event),
      "utf8",
    ).toString("hex"),
  });
}

async function requireAvailableRecovery(
  t: TestContext,
): Promise<P4bVectorRunner | undefined> {
  const loaded = await optionalP4bLedgerRecoveryRunner();
  if (!loaded.available) {
    t.skip(loaded.code);
    return undefined;
  }
  return loaded.runner;
}

test("P4-B ledger recovery executes all 9 frozen fault oracles", async (t) => {
  const runner = await requireAvailableRecovery(t);
  if (runner === undefined) return;
  assert.equal(recoveryVectors.length, 9);
  for (const vector of recoveryVectors) {
    assert.deepEqual(
      await runAndRequireRecord(runner, vector),
      vector.expected,
      vector.id,
    );
  }
});

test("P4-B recovery row counts equal their deltas including zero to empty", async (t) => {
  const runner = await requireAvailableRecovery(t);
  if (runner === undefined) return;
  for (const vector of recoveryVectors) {
    const actual = await runAndRequireRecord(runner, vector);
    const checkpointRows = actual.checkpointRows;
    const ackRows = actual.ackRows;
    assert.ok(Array.isArray(checkpointRows), vector.id);
    assert.ok(Array.isArray(ackRows), vector.id);
    assert.equal(checkpointRows.length, actual.checkpointDelta, vector.id);
    assert.equal(ackRows.length, actual.ackPersistDelta, vector.id);
  }
});

test("P4-B named faults mutate one ledger, survive recreation and persist ack once", async (t) => {
  const runner = await requireAvailableRecovery(t);
  if (runner === undefined) return;

  const seed = fixtureById("synthetic-ledger");
  const beforeCommitLedger = createRestartableAgentLedgerV1(seed);
  const beforeSnapshot = beforeCommitLedger.snapshot();
  const beforeVector = vectorById("N19-before-commit-restart");
  assert.deepEqual(
    await runAndRequireRecord(
      runner,
      beforeVector,
      createP4bHarnessDependencies(beforeCommitLedger),
    ),
    beforeVector.expected,
  );
  assert.deepEqual(beforeCommitLedger.snapshot(), beforeSnapshot);

  const committedLedger = createRestartableAgentLedgerV1(seed);
  const committedBefore = committedLedger.snapshot();
  const afterVector = vectorById("N20-after-commit-before-ack-restart");
  const actual = await runAndRequireRecord(
    runner,
    afterVector,
    createP4bHarnessDependencies(committedLedger),
  );
  assert.deepEqual(actual, afterVector.expected);
  const committedAfter = committedLedger.snapshot();
  assert.equal(
    rowsOf(committedAfter, "mappings").length -
      rowsOf(committedBefore, "mappings").length,
    actual.mappingDelta,
  );
  assert.equal(
    rowsOf(committedAfter, "ledger").length -
      rowsOf(committedBefore, "ledger").length,
    actual.ledgerDelta,
  );
  assert.equal(
    rowsOf(committedAfter, "checkpoints").length -
      rowsOf(committedBefore, "checkpoints").length,
    actual.checkpointDelta,
  );
  assert.equal(
    rowsOf(committedAfter, "acks").length -
      rowsOf(committedBefore, "acks").length,
    actual.ackPersistDelta,
  );

  const recreated = createRestartableAgentLedgerV1(committedAfter);
  const checkpointRows = actual.checkpointRows;
  assert.ok(Array.isArray(checkpointRows));
  const checkpoint = checkpointRows[0];
  assert.ok(
    checkpoint !== null &&
      typeof checkpoint === "object" &&
      !Array.isArray(checkpoint),
  );
  assert.equal(
    recreated.persistAck(checkpoint as Readonly<Record<string, unknown>>),
    true,
  );
  assert.equal(
    recreated.persistAck(checkpoint as Readonly<Record<string, unknown>>),
    false,
  );
  assert.equal(
    rowsOf(recreated.snapshot(), "acks").length -
      rowsOf(committedAfter, "acks").length,
    1,
  );
});

test("P4-B before-commit and after-commit-before-ack remain distinct", async (t) => {
  const runner = await requireAvailableRecovery(t);
  if (runner === undefined) return;
  const before = await runAndRequireRecord(
    runner,
    vectorById("N19-before-commit-restart"),
  );
  const after = await runAndRequireRecord(
    runner,
    vectorById("N20-after-commit-before-ack-restart"),
  );
  assert.equal(before.ledgerDelta, 0);
  assert.equal(before.ackPersistDelta, 0);
  assert.equal(after.ledgerDelta, 1);
  assert.equal(after.checkpointDelta, 1);
  assert.equal(after.ackPersistDelta, 0);
});

test("P4-B cancel restart preserves commit state without inventing acknowledgement", async (t) => {
  const runner = await requireAvailableRecovery(t);
  if (runner === undefined) return;
  const before = await runAndRequireRecord(
    runner,
    vectorById("N19-cancel-before-commit-restart"),
  );
  const after = await runAndRequireRecord(
    runner,
    vectorById("N20-cancel-after-commit-before-ack-restart"),
  );
  assert.equal(before.postRunLifecycle, "running");
  assert.equal(before.checkpointDelta, 0);
  assert.equal(after.postRunLifecycle, "cancelling");
  assert.equal(after.checkpointDelta, 1);
  assert.equal(after.ackPersistDelta, 0);
  assert.deepEqual(after.ackRows, []);
});

test("P4-B real single-axis corruption always fails closed", async (t) => {
  const runner = await requireAvailableRecovery(t);
  if (runner === undefined) return;
  for (const id of [
    "N21-mapping-only-corruption-quarantine",
    "N21-event-only-corruption-quarantine",
    "N21-checkpoint-only-corruption-quarantine",
    "N21-ack-before-commit-corruption-quarantine",
  ]) {
    const vector = vectorById(id);
    const actual = await runAndRequireRecord(runner, vector);
    assert.deepEqual(actual, vector.expected, id);
    assert.equal(actual.decision, "block", id);
    assert.equal(actual.errorCode, "INTERNAL", id);
    assert.equal(actual.quarantineState, "active", id);
    assert.equal(actual.rendererEmissions, 0, id);
  }
});

test("P4-B a corrupt flag alone cannot manufacture ledger corruption", async (t) => {
  const runner = await requireAvailableRecovery(t);
  if (runner === undefined) return;
  const validSeed = structuredClone(fixtureById("synthetic-ledger")) as Record<
    string,
    unknown
  >;
  const run = validSeed.run;
  assert.ok(run !== null && typeof run === "object" && !Array.isArray(run));
  (run as Record<string, unknown>).ledgerIntegrity = "corrupt";
  assert.equal(calculateP4bLedgerIntegrityV1(validSeed), "valid");

  const vector = vectorById("N20-after-commit-before-ack-restart");
  const input = structuredClone(executionInputFor(vector)) as unknown as Record<
    string,
    unknown
  >;
  input.stateFixture = validSeed;
  await assert.rejects(() =>
    runInputAndRequireRecord(
      runner,
      input as unknown as P4bExecutionInput,
      createP4bHarnessDependencies(createRestartableAgentLedgerV1(validSeed)),
    ),
  );
});

test("P4-B ledger integrity rejects structural corruption without throwing", async (t) => {
  const runner = await requireAvailableRecovery(t);
  if (runner === undefined) return;

  const assertStructuredCorruption = async (
    fixture: Record<string, unknown>,
    label: string,
  ): Promise<void> => {
    const run = mutableRecordField(fixture, "run");
    run.ledgerIntegrity = "corrupt";
    const template = vectorById("N21-ledger-corruption-quarantine");
    const input = structuredClone(executionInputFor(template)) as unknown as Record<
      string,
      unknown
    >;
    input.preState = {
      fixtureId: fixture.fixtureId,
      hostSequence: run.hostSequence,
      terminal: run.terminal,
      quarantined: run.quarantined,
    };
    input.stateFixture = fixture;
    input.steps = [{ action: "restart" }];
    const actual = await runInputAndRequireRecord(
      runner,
      input as unknown as P4bExecutionInput,
      createP4bHarnessDependencies(createRestartableAgentLedgerV1(fixture)),
    );
    assert.equal(actual.decision, "block", label);
    assert.equal(actual.errorCode, "INTERNAL", label);
    assert.equal(actual.retryability, "never", label);
    assert.equal(actual.recoveryAction, "none", label);
    assert.equal(actual.quarantineState, "active", label);
    assert.equal(actual.rendererEmissions, 0, label);
    assert.deepEqual(actual.canonicalEvents, [], label);
    for (const key of [
      "mappingDelta",
      "ledgerDelta",
      "reducerDelta",
      "ackDelta",
      "checkpointDelta",
      "ackPersistDelta",
    ]) {
      assert.equal(actual[key], 0, `${label}:${key}`);
    }
  };

  const cases: ReadonlyArray<
    Readonly<{
      name: string;
      base?: string;
      mutate(fixture: Record<string, unknown>): void;
    }>
  > = [
    {
      name: "duplicate mapping primary key",
      mutate(fixture) {
        const mappings = mutableRowsField(fixture, "mappings");
        mappings.push(structuredClone(mappings[0]!));
      },
    },
    {
      name: "duplicate mapping secondary key",
      mutate(fixture) {
        const mappings = mutableRowsField(fixture, "mappings");
        const duplicate = structuredClone(mappings[0]!);
        duplicate.sourceEventId = "source.synthetic-cancel-deadline.duplicate";
        duplicate.sourceSequence = 2;
        mappings.push(duplicate);
      },
    },
    {
      name: "duplicate eventId",
      mutate(fixture) {
        const ledger = mutableRowsField(fixture, "ledger");
        const duplicate = structuredClone(ledger[1]!);
        rewriteCanonicalRow(duplicate, { hostSequence: 3 });
        ledger.push(duplicate);
        Object.assign(mutableRecordField(fixture, "run"), {
          hostSequence: 3,
          committedHead: 3,
        });
      },
    },
    {
      name: "duplicate hostSequence",
      mutate(fixture) {
        const ledger = mutableRowsField(fixture, "ledger");
        const duplicate = structuredClone(ledger[0]!);
        rewriteCanonicalRow(duplicate, {
          eventId: "event.synthetic-cancel-deadline.duplicate-sequence",
          hostSequence: 2,
        });
        ledger.push(duplicate);
      },
    },
    {
      name: "noncontiguous hostSequence",
      mutate(fixture) {
        const ledger = mutableRowsField(fixture, "ledger");
        const gap = structuredClone(ledger[0]!);
        rewriteCanonicalRow(gap, {
          eventId: "event.synthetic-cancel-deadline.4",
          hostSequence: 4,
        });
        ledger.push(gap);
        Object.assign(mutableRecordField(fixture, "run"), {
          hostSequence: 4,
          committedHead: 4,
        });
      },
    },
    {
      name: "run head mismatch",
      mutate(fixture) {
        Object.assign(mutableRecordField(fixture, "run"), {
          hostSequence: 3,
          committedHead: 3,
        });
      },
    },
    {
      name: "multiple terminal events",
      base: "synthetic-terminal",
      mutate(fixture) {
        const ledger = mutableRowsField(fixture, "ledger");
        ledger.push(structuredClone(ledger[ledger.length - 1]!));
      },
    },
    {
      name: "terminal event is not ledger tail",
      base: "synthetic-terminal",
      mutate(fixture) {
        const ledger = mutableRowsField(fixture, "ledger");
        const terminal = ledger[ledger.length - 1]!;
        ledger[ledger.length - 1] = ledger[ledger.length - 2]!;
        ledger[ledger.length - 2] = terminal;
      },
    },
    {
      name: "checkpoint resumeEpoch mismatch",
      mutate(fixture) {
        fixture.checkpoints = [
          {
            hostRunId: "host.synthetic-cancel-deadline",
            eventId: "event.synthetic-cancel-deadline.2",
            hostSequence: 2,
            resumeEpoch: 2,
          },
        ];
      },
    },
    {
      name: "ack resumeEpoch mismatch",
      mutate(fixture) {
        fixture.checkpoints = [
          {
            hostRunId: "host.synthetic-cancel-deadline",
            eventId: "event.synthetic-cancel-deadline.2",
            hostSequence: 2,
            resumeEpoch: 1,
          },
        ];
        fixture.acks = [
          {
            hostRunId: "host.synthetic-cancel-deadline",
            eventId: "event.synthetic-cancel-deadline.2",
            hostSequence: 2,
            resumeEpoch: 2,
          },
        ];
      },
    },
    {
      name: "malformed canonical hex",
      mutate(fixture) {
        mutableRowsField(fixture, "ledger")[1]!.canonicalUtf8Hex = "zz";
      },
    },
    {
      name: "malformed canonical JSON",
      mutate(fixture) {
        mutableRowsField(fixture, "ledger")[1]!.canonicalUtf8Hex =
          Buffer.from("{", "utf8").toString("hex");
      },
    },
  ];

  for (const entry of cases) {
    const fixture = mutableFixtureById(
      entry.base ?? "synthetic-cancel-pending",
    );
    entry.mutate(fixture);
    await assertStructuredCorruption(fixture, entry.name);
  }
});

test("P4-B legal recovery path requires one final closed restart step", async (t) => {
  const runner = await requireAvailableRecovery(t);
  if (runner === undefined) return;
  const vector = vectorById("N20-after-commit-before-ack-restart");

  const assertRejected = async (input: P4bExecutionInput): Promise<void> => {
    let actual: Readonly<Record<string, unknown>> | undefined;
    try {
      actual = await runInputAndRequireRecord(runner, input);
    } catch {
      return;
    }
    assert.notEqual(actual.decision, "accept");
    assert.equal(actual.rendererEmissions, 0);
  };
  const mutateRecoverySteps = (
    mutate: (steps: Array<Record<string, unknown>>) => void,
  ): P4bExecutionInput => {
    const input = structuredClone(executionInputFor(vector)) as unknown as {
      steps: Array<Record<string, unknown>>;
    };
    mutate(input.steps);
    return input as unknown as P4bExecutionInput;
  };

  const missingRestart = mutateRecoverySteps((steps) => {
    steps.splice(1, 1);
  });
  const reorderedRestart = mutateRecoverySteps((steps) => {
    const first = steps[0]!;
    steps[0] = steps[1]!;
    steps[1] = first;
  });
  const extraRestart = mutateRecoverySteps((steps) => {
    steps.push({ action: "restart" });
  });
  const restartWithExtraField = mutateRecoverySteps((steps) => {
    steps[1]!.unexpected = true;
  });
  for (const input of [
    missingRestart,
    reorderedRestart,
    extraRestart,
    restartWithExtraField,
  ]) {
    await assertRejected(input);
  }
});
