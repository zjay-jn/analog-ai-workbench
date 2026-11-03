import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluateConformanceStageV1,
  parseConformanceResultReceiptV1,
} from "../packages/agent-adapters/src/conformance";
import {
  loadFrozenP4cManifest,
  loadFrozenP4cVectors,
  optionalP4cDesktopBoundaryRunner,
  runP4cVector,
} from "./helpers/phase4-p4c-runner";

test("P4C_DESKTOP_BOUNDARY_RUNNER_UNAVAILABLE", async () => {
  const loaded = await optionalP4cDesktopBoundaryRunner();
  if (!loaded.available) assert.fail(loaded.code);
});

test("P4-C frozen vectors enter through registered IPC rather than a fixture interpreter", () => {
  const helper = readFileSync("tests/helpers/phase4-p4c-runner.ts", "utf8");
  assert.match(helper, /registerAgentIpcHandlersV1/u);
  assert.match(helper, /invokeFakeIpcV1/u);
  assert.match(helper, /createDesktopAgentHostV1/u);
  assert.doesNotMatch(helper, /executeP4cDesktopBoundaryVectorV1/u);
});

test("P4-C executes the six frozen desktop-boundary vectors", async (t) => {
  const loaded = await optionalP4cDesktopBoundaryRunner();
  if (!loaded.available) return void t.skip(loaded.code);
  const vectors = loadFrozenP4cVectors();
  assert.equal(vectors.length, 6);
  const successIds = new Set<string>();
  for (const vector of vectors) {
    const actual = await runP4cVector(loaded.value, vector);
    assert.deepEqual(actual, vector.expected, vector.id);
    successIds.add(vector.id);
  }

  const manifest = loadFrozenP4cManifest();
  const receipt = parseConformanceResultReceiptV1(
    manifest,
    JSON.parse(readFileSync(
      "packages/agent-adapters/fixtures/p4c-conformance-results.json",
      "utf8",
    )),
  );
  assert.equal(receipt.currentStage, "P4-C");
  assert.equal(receipt.results.length, 120);
  const p4cPassIds = receipt.results
    .filter((row) => row.requiredStage === "P4-C" && row.status === "PASS")
    .map((row) => row.vectorId)
    .sort();
  assert.deepEqual(p4cPassIds, [...successIds].sort());
  assert.deepEqual(evaluateConformanceStageV1("P4-C", manifest, receipt), {
    status: "PASS",
    blockers: [],
  });
  assert.equal(receipt.results.filter((row) =>
    row.requiredStage === "P4-A" && row.status === "PASS").length, 73);
  assert.equal(receipt.results.filter((row) =>
    row.requiredStage === "P4-B" && row.status === "PASS").length, 40);
  assert.equal(receipt.results.filter((row) =>
    row.requiredStage === "P4-C" && row.status === "PASS").length, 6);
  assert.equal(receipt.results.filter((row) =>
    row.requiredStage === "P4-D" && row.status === "NOT_RUN").length, 1);
});

test("P4-C desktop decision order and request counters are exact", async (t) => {
  const loaded = await optionalP4cDesktopBoundaryRunner();
  if (!loaded.available) return void t.skip(loaded.code);
  const expectedById = new Map<string, readonly [string, number]>([
    ["N25-wrong-caller-scope-denied", ["CAPABILITY_DENIED", 0]],
    ["N25-authorized-kind-corruption", ["INTERNAL", 1]],
    ["N25-exact-revision-caller-order", ["REVISION_UNAVAILABLE", 0]],
    ["N25-invalid-locator-before-intent-capability", ["INVALID_REQUEST", 0]],
    ["N25-intent-capability-after-valid-locator", ["CAPABILITY_DENIED", 0]],
  ]);
  for (const vector of loadFrozenP4cVectors()) {
    const actual = await runP4cVector(loaded.value, vector);
    const counters = actual.processOrRequestCounters;
    assert.ok(counters !== null && typeof counters === "object" && !Array.isArray(counters));
    const row = counters as Record<string, unknown>;
    assert.equal(row.requestCount, 1, vector.id);
    assert.equal(row.deliveryCount, vector.id === "N25-historical-exact-revision" ? 1 : 0, vector.id);
    const ordered = expectedById.get(vector.id);
    if (ordered !== undefined) {
      assert.equal(actual.errorCode, ordered[0], vector.id);
      assert.equal(row.registryMutationCount, ordered[1], vector.id);
    } else {
      assert.equal(vector.id, "N25-historical-exact-revision");
      assert.equal(actual.decision, "pass");
      assert.equal(actual.freshness, "historical");
    }
  }
});
