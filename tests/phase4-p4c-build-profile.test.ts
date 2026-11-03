import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { optionalP4cBuildProfiles } from "./helpers/phase4-p4c-runner";

test("P4C_BUILD_PROFILE_SEPARATION_UNAVAILABLE", async () => {
  const loaded = await optionalP4cBuildProfiles();
  if (!loaded.available) assert.fail(loaded.code);
});

test("P4-C production and development Agent graphs are compile-time separated", async (t) => {
  const loaded = await optionalP4cBuildProfiles();
  if (!loaded.available) return void t.skip(loaded.code);
  const production = readFileSync("apps/desktop/src/main/index.ts", "utf8");
  const development = readFileSync("apps/desktop/src/main/index.dev.ts", "utf8");
  assert.match(production, /createEmptyAgentBackendV1/u);
  assert.doesNotMatch(production, /development-synthetic-agent-backend/u);
  assert.doesNotMatch(production, /synthetic-agent-core|approved-synthetic-agent-fixtures|source-events/u);
  assert.match(development, /createDevelopmentSyntheticAgentBackendV1/u);
  assert.match(development, /development-synthetic-agent-backend/u);

  const emptyFactory = loaded.value.empty.createEmptyAgentBackendV1;
  const developmentFactory =
    loaded.value.development.createDevelopmentSyntheticAgentBackendV1;
  assert.equal(typeof emptyFactory, "function");
  assert.equal(typeof developmentFactory, "function");
  const empty = (emptyFactory as () => unknown)();
  assert.ok(empty !== null && typeof empty === "object" && !Array.isArray(empty));
  assert.deepEqual((empty as Record<string, unknown>).registrySizes, {
    agent: 0,
    rag: 0,
    toolBroker: 0,
    fixture: 0,
  });
});

test("P4-C runtime input cannot enable the synthetic backend", async (t) => {
  const loaded = await optionalP4cBuildProfiles();
  if (!loaded.available) return void t.skip(loaded.code);
  const productionFiles = [
    "apps/desktop/src/main/index.ts",
    "apps/desktop/src/main/bootstrap.ts",
    "apps/desktop/src/main/agent/empty-agent-backend.ts",
  ];
  const source = productionFiles.map((path) => readFileSync(path, "utf8")).join("\n");
  const approvedSmokeExpression = 'app.commandLine.hasSwitch("aaw-smoke")';
  assert.equal(source.split(approvedSmokeExpression).length - 1, 1);
  assert.doesNotMatch(source, /process\.env|process\.argv|NODE_ENV/u);
  assert.doesNotMatch(source, /fixtureRegistryEnabled\s*:\s*true/u);
  assert.doesNotMatch(source, /createDevelopmentSyntheticAgentBackendV1/u);
});
