import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  loadSubscribeRunContractFreeze,
  optionalP4cApiSurface,
} from "./helpers/phase4-p4c-runner";

const expectedMethods = [
  "getInfo",
  "resolveReviewedArtifact",
  "startTurn",
  "subscribeRun",
  "cancelRun",
  "resolveArtifact",
  "resolveCitation",
] as const;
const expectedChannels = [
  "workbench.agent.startTurn.v1",
  "workbench.agent.subscribeRun.v1",
  "workbench.agent.cancelRun.v1",
  "workbench.agent.resolveArtifact.v1",
  "workbench.agent.resolveCitation.v1",
] as const;

test("P4C_AGENT_API_SURFACE_UNAVAILABLE", async () => {
  const loaded = await optionalP4cApiSurface();
  if (!loaded.available) assert.fail(loaded.code);
});

test("P4-C API uses exactly seven methods and five Agent channels", async (t) => {
  const loaded = await optionalP4cApiSurface();
  if (!loaded.available) return void t.skip(loaded.code);
  const freeze = loadSubscribeRunContractFreeze();
  assert.deepEqual(freeze.publicWorkbenchMethods, expectedMethods);
  assert.deepEqual(freeze.agentChannels, expectedChannels);
  assert.deepEqual(loaded.value.WORKBENCH_API_METHODS_V1, expectedMethods);
  assert.deepEqual(loaded.value.AGENT_CHANNELS_V1, expectedChannels);

  const preload = readFileSync("apps/desktop/src/preload/index.ts", "utf8");
  for (const method of expectedMethods) {
    assert.match(preload, new RegExp(`\\b${method}\\s*:`, "u"), method);
  }
  assert.doesNotMatch(preload, /\bresolveDocument\s*:/u);
  assert.doesNotMatch(preload, /contextBridge\.exposeInMainWorld\([^,]+,[\s\S]*\binvoke\s*:/u);
  assert.doesNotMatch(preload, /contextBridge\.exposeInMainWorld\([^,]+,[\s\S]*\b(?:send|on|once)\s*:/u);
});

test("P4-C subscription shape and closed parsers reject authority smuggling", async (t) => {
  const loaded = await optionalP4cApiSurface();
  if (!loaded.available) return void t.skip(loaded.code);
  const freeze = loadSubscribeRunContractFreeze();
  assert.deepEqual(freeze.subscribeRequest, {
    required: ["hostRunId"],
    optional: ["afterHostSequence"],
    additionalProperties: false,
    afterHostSequence:
      "omitted-equals-zero-safe-integer-greater-than-or-equal-to-zero",
  });
  assert.deepEqual(freeze.handle, {
    exactOwnDataProperties: ["unsubscribe"],
    unsubscribeSignature: "() => Promise<void>",
    idempotency:
      "first call closes callback and clears buffer before one main revoke; repeats return the same promise and send zero IPC",
    publicSubscriptionIdentity: false,
  });

  const parseRequest = loaded.value.parseAgentDesktopRequestV1;
  const parseResult = loaded.value.parseAgentDesktopResultV1;
  const parseEvent = loaded.value.parseAgentDesktopEventV1;
  assert.equal(typeof parseRequest, "function");
  assert.equal(typeof parseResult, "function");
  assert.equal(typeof parseEvent, "function");
  for (const forbidden of [
    "sessionId", "windowId", "webContentsId", "workspaceId", "rootId",
    "origin", "callerContext", "path", "token", "grant", "subscriptionId",
  ]) {
    assert.throws(() => (parseRequest as (value: unknown) => unknown)({
      hostRunId: "host.synthetic.1",
      [forbidden]: "attacker-controlled",
    }), forbidden);
  }
  assert.throws(() => (parseResult as (value: unknown) => unknown)(Object.create({ ok: true })));
  assert.throws(() => (parseEvent as (value: unknown) => unknown)(new Uint8Array([1])));
});

test("P4-C preload fail-closes malformed delivery inside the serialized route and revokes locally", () => {
  const preload = readFileSync("apps/desktop/src/preload/index.ts", "utf8");
  assert.match(preload, /route\.tail\s*=\s*route\.tail\.then\([\s\S]*?try\s*\{[\s\S]*?parseAgentDesktopEventV1\(envelope\.event\)[\s\S]*?route\.callback[\s\S]*?\}\s*catch\s*\{[\s\S]*?route\.unsubscribe\(\)/u);
  assert.doesNotMatch(preload, /const canonicalEvent\s*=\s*deepFreezeClone\(parseAgentDesktopEventV1\(envelope\.event\)\);\s*if\s*\(!route\.active\)/u);
  assert.match(preload, /unsubscribePromise\s*\?\?=[\s\S]*?route\.closed\s*=\s*true;[\s\S]*?route\.buffer\.length\s*=\s*0;[\s\S]*?kind:\s*"unsubscribe"/u);
});
