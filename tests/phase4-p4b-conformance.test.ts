import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluateConformanceStageV1,
  parseConformanceResultReceiptV1,
} from "../packages/agent-adapters/src/conformance";
import {
  loadFrozenP4bManifest,
  loadFrozenP4bVectors,
  optionalP4bLedgerRecoveryRunner,
  optionalP4bReducerRunner,
  requireP4bLedgerRecoveryRunner,
  requireP4bReducerRunner,
  runAndRequireRecord,
  type P4bVectorRunner,
} from "./helpers/phase4-p4b-runner";

const exactP4bIds = Object.freeze([
  "N01-exact-primary-replay",
  "N02-primary-key-sequence-conflict",
  "N03-secondary-key-identity-conflict",
  "N04-version-gate-before-identity",
  "N06-exact-replay-zero-ledger-delta",
  "N07-late-old-transport-isolated",
  "N07-old-cursor-recovery-unsupported",
  "N07-old-source-replay-protocol-mismatch",
  "N17-invalid-semantic-time-warning",
  "N17-source-time-drift-invariant",
  "N18-post-terminal-new-event",
  "N18-terminal-exact-replay-ack-only",
  "N19-before-commit-restart",
  "N20-after-commit-before-ack-restart",
  "N21-ledger-corruption-quarantine",
  "N26-illegal-main-pair-first-trigger",
  "N26-quarantine-subsequent-recovery",
  "N27-retry-recovery-priority",
  "N28-monotonic-deadline-metamorphic",
  "N18-host-replay-after-zero",
  "N18-host-replay-omitted-after-zero",
  "N18-host-replay-head-nonterminal-wait",
  "N18-host-replay-head-terminal-end",
  "N18-host-replay-future-after-invalid",
  "N18-host-replay-retention-gap-start-new-run",
  "N18-host-replay-retention-gap-recovery-unsupported",
  "N18-host-replay-quarantined-zero",
  "N18-host-replay-snapshot-tail-exactly-once",
  "N19-cancel-before-commit-restart",
  "N20-cancel-after-commit-before-ack-restart",
  "N21-mapping-only-corruption-quarantine",
  "N21-event-only-corruption-quarantine",
  "N21-checkpoint-only-corruption-quarantine",
  "N21-ack-before-commit-corruption-quarantine",
  "N28-cancel-before-stream",
  "N28-cancel-during-delta",
  "N28-cancel-repeated-idempotent",
  "N28-cancel-ack-terminal-once",
  "N28-cancel-after-terminal-noop",
  "N28-cancel-timeout-late-event-isolated",
]);

test("P4-B frozen vector set is exactly 40 with the 31/9 harness split", () => {
  const vectors = loadFrozenP4bVectors();
  assert.deepEqual(
    vectors.map((vector) => vector.id),
    exactP4bIds,
  );
  assert.equal(
    vectors.filter((vector) => vector.harness === "reducer").length,
    31,
  );
  assert.equal(
    vectors.filter((vector) => vector.harness === "ledger_recovery").length,
    9,
  );
});

test("P4B_REDUCER_RUNNER_UNAVAILABLE", async () => {
  await requireP4bReducerRunner();
});

test("P4B_LEDGER_RECOVERY_RUNNER_UNAVAILABLE", async () => {
  await requireP4bLedgerRecoveryRunner();
});

test("P4-B executable results form a complete stage receipt", async (t) => {
  const reducer = await optionalP4bReducerRunner();
  const recovery = await optionalP4bLedgerRecoveryRunner();
  if (!reducer.available || !recovery.available) {
    t.skip(
      !reducer.available
        ? reducer.code
        : !recovery.available
          ? recovery.code
          : "P4-B runner unavailable",
    );
    return;
  }

  const vectors = loadFrozenP4bVectors();
  const actualSuccessIds = new Set<string>();
  for (const vector of vectors) {
    const runner: P4bVectorRunner =
      vector.harness === "reducer" ? reducer.runner : recovery.runner;
    assert.deepEqual(await runAndRequireRecord(runner, vector), vector.expected);
    actualSuccessIds.add(vector.id);
  }

  const manifest = loadFrozenP4bManifest();
  const rawReceipt: unknown = JSON.parse(
    readFileSync(
      "packages/agent-adapters/fixtures/p4b-conformance-results.json",
      "utf8",
    ),
  );
  const receipt = parseConformanceResultReceiptV1(manifest, rawReceipt);
  assert.equal(receipt.currentStage, "P4-B");
  assert.equal(receipt.results.length, 120);
  const receiptById = new Map(
    receipt.results.map((result) => [result.vectorId, result]),
  );
  assert.equal(receiptById.size, 120);
  for (const vector of manifest.vectors) {
    const result = receiptById.get(vector.id);
    assert.ok(result, `${vector.id} must have one P4-B receipt result`);
    assert.equal(result.harness, vector.harness, vector.id);
    assert.equal(result.requiredStage, vector.requiredStage, vector.id);
    assert.equal(
      result.status,
      vector.requiredStage === "P4-A" || vector.requiredStage === "P4-B"
        ? "PASS"
        : "NOT_RUN",
      vector.id,
    );
  }
  const receiptP4bPassIds = receipt.results
    .filter(
      (result) => result.requiredStage === "P4-B" && result.status === "PASS",
    )
    .map((result) => result.vectorId)
    .sort();
  assert.deepEqual(receiptP4bPassIds, [...actualSuccessIds].sort());
  assert.deepEqual(evaluateConformanceStageV1("P4-B", manifest, receipt), {
    status: "PASS",
    blockers: [],
  });
  assert.equal(
    receipt.results.filter(
      (result) => result.requiredStage === "P4-A" && result.status === "PASS",
    ).length,
    73,
  );
  assert.equal(
    receipt.results.filter(
      (result) => result.requiredStage === "P4-B" && result.status === "PASS",
    ).length,
    40,
  );
  assert.equal(
    receipt.results.filter(
      (result) => result.requiredStage === "P4-C" && result.status === "NOT_RUN",
    ).length,
    6,
  );
  assert.equal(
    receipt.results.filter(
      (result) => result.requiredStage === "P4-D" && result.status === "NOT_RUN",
    ).length,
    1,
  );
});
