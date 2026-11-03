import assert from "node:assert/strict";
import test from "node:test";
import { sha256CanonicalAawJsonV1 } from "../packages/schematic-workbench/src/canonical-json";
import {
  createFakeIpcMainV1,
  invokeFakeIpcV1,
  optionalP4cBuildProfiles,
  optionalP4cCallerFence,
} from "./helpers/phase4-p4c-runner";
import { loadApprovedP4bSourceFrames } from "./helpers/phase4-p4b-runner";

type Fence = Readonly<Record<string, unknown>>;

function method(fence: Fence, name: string): (...args: unknown[]) => unknown {
  const candidate = fence[name];
  assert.equal(typeof candidate, "function", name);
  return candidate as (...args: unknown[]) => unknown;
}

const caller = Object.freeze({
  senderId: 7,
  isTopFrame: true,
  appOrigin: "file://",
  navigationEpoch: 1,
  appSessionId: "session.synthetic.1",
  windowId: "window.synthetic.1",
  webContentsId: 7,
  workspaceId: "workspace.synthetic.1",
  rootId: "root.synthetic.1",
});

const channels = Object.freeze({
  start: "workbench.agent.startTurn.v1",
  subscribe: "workbench.agent.subscribeRun.v1",
  cancel: "workbench.agent.cancelRun.v1",
});

const event = (sequence: number, type: "message.delta" | "run.completed" = "message.delta") => {
  const payload = type === "message.delta" ? { text: `delta-${sequence}` } : { finishReason: "completed" };
  return {
    type,
    hostRunId: "host.synthetic.subscription.1",
    eventId: `event.synthetic.subscription.${sequence}`,
    hostSequence: sequence,
    acceptedAt: `2026-09-02T00:00:0${sequence}Z`,
    canonicalPayloadDigest: sha256CanonicalAawJsonV1(payload),
    payload,
  };
};

async function createRegisteredRuntime(
  hostOptions: Readonly<Record<string, unknown>> = {},
): Promise<Readonly<Record<string, unknown>>> {
  const [boundary, profiles] = await Promise.all([
    optionalP4cCallerFence(),
    optionalP4cBuildProfiles(),
  ]);
  assert.equal(boundary.available, true);
  assert.equal(profiles.available, true);
  if (!boundary.available || !profiles.available) throw new Error("P4-C runtime unavailable");
  const createFence = boundary.value.fence.createAgentCallerFenceV1;
  const register = boundary.value.ipc.registerAgentIpcHandlersV1;
  const createBackend = profiles.value.development.createDevelopmentSyntheticAgentBackendV1;
  const createHost = boundary.value.host.createDesktopAgentHostV1;
  assert.equal(typeof createFence, "function");
  assert.equal(typeof register, "function");
  assert.equal(typeof createBackend, "function");
  assert.equal(typeof createHost, "function");
  const backend = (createBackend as (input: unknown) => Record<string, unknown>)({
    sourceFrames: loadApprovedP4bSourceFrames().map((frame) => frame.rawBytes),
  });
  let runCounter = 0;
  const host = (createHost as (input: unknown) => Record<string, unknown>)({
    backend,
    createHostRunId: () => `synthetic.registered.${++runCounter}`,
    ...hostOptions,
  });
  const ipcMain = createFakeIpcMainV1();
  const deliveries: unknown[] = [];
  let derivations = 0;
  let currentCaller: unknown = caller;
  const registration = (register as (input: unknown) => Record<string, unknown>)({
    ipcMain,
    host,
    invocationFence: (createFence as (input: unknown) => unknown)({
      caller,
      capabilities: ["start_turn", "subscribe_run", "cancel_run", "resolve_artifact", "resolve_citation"],
      generation: 1,
    }),
    createSubscriptionFence: () => (createFence as (input: unknown) => unknown)({
      caller,
      capabilities: ["subscribe_run"],
      generation: 1,
    }),
    deriveCallerContext: (candidate: unknown) => {
      derivations += 1;
      return record(candidate, "fake IPC event").caller;
    },
    deriveCurrentCallerContext: () => {
      derivations += 1;
      return currentCaller;
    },
    createSubscriptionId: () => "subscription.synthetic.1",
    deliver: (_channel: unknown, payload: unknown) => deliveries.push(payload),
  });
  return {
    host,
    ipcMain,
    deliveries,
    registration,
    derivations: () => derivations,
    setCurrentCaller: (next: unknown) => { currentCaller = next; },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

test("P4C_CALLER_CONTEXT_FENCE_UNAVAILABLE", async () => {
  const loaded = await optionalP4cCallerFence();
  if (!loaded.available) assert.fail(loaded.code);
});

test("P4-C CallerContext is revalidated per invocation and does not disclose existence", async (t) => {
  const loaded = await optionalP4cCallerFence();
  if (!loaded.available) return void t.skip(loaded.code);
  const create = loaded.value.fence.createAgentCallerFenceV1;
  assert.equal(typeof create, "function");
  const fence = (create as (input: unknown) => Fence)({
    caller,
    capabilities: ["start_turn", "subscribe_run", "cancel_run", "resolve_artifact"],
    generation: 1,
  });
  const authorize = method(fence, "authorizeInvocation");
  assert.deepEqual(authorize({ operation: "subscribeRun", caller }), { allowed: true });
  const wrongOrigin = { ...caller, appOrigin: "https://attacker.invalid" };
  const unknownRun = authorize({
    operation: "cancelRun", caller: wrongOrigin, hostRunId: "host.unknown",
  });
  const ownedRun = authorize({
    operation: "cancelRun", caller: wrongOrigin, hostRunId: "host.synthetic.1",
  });
  assert.deepEqual(unknownRun, ownedRun);
  assert.deepEqual(ownedRun, { allowed: false, errorCode: "CAPABILITY_DENIED" });
});

test("P4-C subscription generation revocation precedes queue clearing and later delivery", async (t) => {
  const loaded = await optionalP4cCallerFence();
  if (!loaded.available) return void t.skip(loaded.code);
  const create = loaded.value.fence.createAgentCallerFenceV1;
  assert.equal(typeof create, "function");
  const fence = (create as (input: unknown) => Fence)({
    caller,
    capabilities: ["subscribe_run"],
    generation: 1,
  });
  const open = method(fence, "openSubscription");
  const activate = method(fence, "activateSubscription");
  const canDeliver = method(fence, "authorizeDelivery");
  const revoke = method(fence, "revoke");
  const snapshot = method(fence, "snapshot");
  assert.deepEqual(open({ caller, hostRunId: "host.synthetic.1", snapshotHead: 2 }), {
    opened: true,
    generation: 1,
  });
  assert.deepEqual(activate({ caller }), { activated: true });
  assert.equal(canDeliver({ caller, hostSequence: 3 }), true);
  revoke({ reason: "navigation", nextNavigationEpoch: 2 });
  assert.equal(canDeliver({ caller, hostSequence: 4 }), false);
  const state = snapshot();
  assert.ok(state !== null && typeof state === "object" && !Array.isArray(state));
  assert.equal((state as Record<string, unknown>).queuedDeliveryCount, 0);
  assert.equal((state as Record<string, unknown>).activeSubscriptionCount, 0);
});

test("P4-C registered IPC gives each start a unique run id and hides unknown ownership", async () => {
  const runtime = await createRegisteredRuntime();
  const ipcMain = runtime.ipcMain as ReturnType<typeof createFakeIpcMainV1>;
  const ownerEvent = { caller };
  const request = { conversationId: "conversation.synthetic.middle-column", turnId: "turn.synthetic.middle-column.1", adapterProfileId: "profile.synthetic.deterministic", adapterProfileRevision: "rev-1", inputRefs: ["input.synthetic.fixed-turn"], contextRefs: ["context.synthetic.reviewed-schematic"] };
  const first = record(await invokeFakeIpcV1(ipcMain, channels.start, ownerEvent, request), "first start");
  const second = record(await invokeFakeIpcV1(ipcMain, channels.start, ownerEvent, request), "second start");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(record(first.value, "first value").hostRunId, record(second.value, "second value").hostRunId);

  const unknown = await invokeFakeIpcV1(ipcMain, channels.cancel, ownerEvent, { hostRunId: "host.unknown" });
  const unauthorized = await invokeFakeIpcV1(ipcMain, channels.cancel, { caller: { ...caller, workspaceId: "workspace.other" } }, { hostRunId: record(first.value, "first value").hostRunId });
  assert.deepEqual(unknown, unauthorized);
  assert.equal(record(record(unknown, "unknown").error, "unknown error").code, "CAPABILITY_DENIED");
});

test("P4-C production empty backend stays NOT_CONFIGURED behind the same registered IPC boundary", async () => {
  const [boundary, profiles] = await Promise.all([optionalP4cCallerFence(), optionalP4cBuildProfiles()]);
  assert.equal(boundary.available, true);
  assert.equal(profiles.available, true);
  if (!boundary.available || !profiles.available) throw new Error("P4-C runtime unavailable");
  const ipcMain = createFakeIpcMainV1();
  const createFence = boundary.value.fence.createAgentCallerFenceV1 as (input: unknown) => unknown;
  const backend = (profiles.value.empty.createEmptyAgentBackendV1 as () => unknown)();
  const host = (boundary.value.host.createDesktopAgentHostV1 as (input: unknown) => unknown)({ backend, createHostRunId: () => "empty.1" });
  (boundary.value.ipc.registerAgentIpcHandlersV1 as (input: unknown) => unknown)({
    ipcMain,
    host,
    invocationFence: createFence({ caller, capabilities: ["start_turn", "subscribe_run", "cancel_run", "resolve_artifact", "resolve_citation"], generation: 1 }),
    createSubscriptionFence: () => createFence({ caller, capabilities: ["subscribe_run"], generation: 1 }),
    deriveCallerContext: (candidate: unknown) => record(candidate, "empty event").caller,
    deriveCurrentCallerContext: () => caller,
    createSubscriptionId: () => "subscription.empty.1",
    deliver: () => assert.fail("empty backend must never deliver"),
  });
  const result = record(await invokeFakeIpcV1(ipcMain, channels.start, { caller }, { conversationId: "conversation.empty", turnId: "turn.empty", adapterProfileId: "none", adapterProfileRevision: "1", inputRefs: [], contextRefs: [] }), "empty start");
  assert.equal(result.ok, false);
  assert.equal(record(result.error, "empty error").code, "NOT_CONFIGURED");
  assert.deepEqual(record(backend, "empty backend").registrySizes, { agent: 0, rag: 0, toolBroker: 0, fixture: 0 });
});

test("P4-C registered IPC atomically bridges replay head H to H+1 live exactly once", async () => {
  const runtime = await createRegisteredRuntime({
    sourceFrames: [],
    runSeeds: [{ hostRunId: "host.synthetic.subscription.1", owner: caller, events: [event(1), event(2)], retentionFloor: 0 }],
  });
  const ipcMain = runtime.ipcMain as ReturnType<typeof createFakeIpcMainV1>;
  const host = runtime.host as Record<string, unknown>;
  const commit = host.commitCanonicalEventV1;
  assert.equal(typeof commit, "function", "development backend must expose deterministic live commit injection");
  const opened = record(await invokeFakeIpcV1(ipcMain, channels.subscribe, { caller }, { kind: "open", request: { hostRunId: "host.synthetic.subscription.1", afterHostSequence: 0 } }), "open");
  assert.equal(opened.ok, true);
  const route = record(opened.value, "open value");
  assert.equal(route.snapshotHead, 2);
  await (commit as (value: unknown) => unknown)(event(3));
  await invokeFakeIpcV1(ipcMain, channels.subscribe, { caller }, { kind: "activate", subscriptionId: route.subscriptionId, generation: route.generation });
  await (commit as (value: unknown) => unknown)(event(4));
  const delivered = (runtime.deliveries as unknown[]).map((row) => record(record(row, "delivery").event, "delivery event").hostSequence);
  assert.deepEqual(delivered, [1, 2, 3, 4]);
  assert.equal(new Set(delivered).size, 4);
  assert.ok((runtime.derivations as () => number)() >= 6, "open, activate and every delivery must rederive CallerContext");
});

test("P4-C registered IPC rejects future/gap/quarantine and closes terminal subscriptions", async () => {
  const dispositions = [
    { name: "future", seed: { events: [event(1)], retentionFloor: 0 }, after: 2, code: "INVALID_REQUEST" },
    { name: "gap", seed: { events: [event(2)], retentionFloor: 2 }, after: 0, code: "EVENT_GAP" },
    { name: "quarantine", seed: { events: [event(1)], retentionFloor: 0, quarantined: true }, after: 0, code: "RECOVERY_UNSUPPORTED" },
  ] as const;
  for (const row of dispositions) {
    const runtime = await createRegisteredRuntime({ sourceFrames: [], runSeeds: [{ hostRunId: "host.synthetic.subscription.1", owner: caller, ...row.seed }] });
    const result = record(await invokeFakeIpcV1(runtime.ipcMain as ReturnType<typeof createFakeIpcMainV1>, channels.subscribe, { caller }, { kind: "open", request: { hostRunId: "host.synthetic.subscription.1", afterHostSequence: row.after } }), row.name);
    assert.equal(result.ok, false, row.name);
    assert.equal(record(result.error, `${row.name} error`).code, row.code, row.name);
    assert.deepEqual(runtime.deliveries, [], row.name);
  }

  const terminal = await createRegisteredRuntime({ sourceFrames: [], runSeeds: [{ hostRunId: "host.synthetic.subscription.1", owner: caller, events: [event(1), event(2, "run.completed")], retentionFloor: 0, terminal: true }] });
  const opened = record(await invokeFakeIpcV1(terminal.ipcMain as ReturnType<typeof createFakeIpcMainV1>, channels.subscribe, { caller }, { kind: "open", request: { hostRunId: "host.synthetic.subscription.1", afterHostSequence: 0 } }), "terminal open");
  const route = record(opened.value, "terminal route");
  await invokeFakeIpcV1(terminal.ipcMain as ReturnType<typeof createFakeIpcMainV1>, channels.subscribe, { caller }, { kind: "activate", subscriptionId: route.subscriptionId, generation: route.generation });
  assert.deepEqual((terminal.deliveries as unknown[]).map((item) => record(item, "terminal delivery").kind), ["deliver", "deliver", "closed"]);
});

test("P4-C unsubscribe is owner-bound and revoke prevents all later delivery", async () => {
  const runtime = await createRegisteredRuntime({ sourceFrames: [], runSeeds: [{ hostRunId: "host.synthetic.subscription.1", owner: caller, events: [], retentionFloor: 0 }] });
  const ipcMain = runtime.ipcMain as ReturnType<typeof createFakeIpcMainV1>;
  const host = runtime.host as Record<string, unknown>;
  const opened = record(await invokeFakeIpcV1(ipcMain, channels.subscribe, { caller }, { kind: "open", request: { hostRunId: "host.synthetic.subscription.1", afterHostSequence: 0 } }), "open");
  const route = record(opened.value, "route");
  await invokeFakeIpcV1(ipcMain, channels.subscribe, { caller }, { kind: "activate", subscriptionId: route.subscriptionId, generation: route.generation });
  const wrong = record(await invokeFakeIpcV1(ipcMain, channels.subscribe, { caller: { ...caller, windowId: "window.other" } }, { kind: "unsubscribe", subscriptionId: route.subscriptionId, generation: route.generation }), "wrong unsubscribe");
  assert.equal(record(wrong.error, "wrong unsubscribe error").code, "CAPABILITY_DENIED");
  assert.deepEqual(runtime.deliveries, [], "wrong-owner unsubscribe must emit nothing");
  await invokeFakeIpcV1(ipcMain, channels.subscribe, { caller }, { kind: "unsubscribe", subscriptionId: route.subscriptionId, generation: route.generation });
  assert.deepEqual(
    (runtime.deliveries as unknown[]).map((item) => record(item, "unsubscribe envelope").kind),
    ["closed"],
    "valid unsubscribe emits exactly one private closed envelope",
  );
  await (host.commitCanonicalEventV1 as (value: unknown) => unknown)(event(1));
  assert.equal(
    (runtime.deliveries as unknown[]).filter((item) => record(item, "post-unsubscribe envelope").kind === "deliver").length,
    0,
    "later commits must emit zero canonical deliveries",
  );
  assert.equal((runtime.deliveries as unknown[]).length, 1, "later commits must not emit another closed envelope");
});

test("P4-C live delivery rederives the current caller and revokes before disclosure", async () => {
  const runtime = await createRegisteredRuntime({ runSeeds: [{ hostRunId: "host.synthetic.subscription.1", owner: caller, events: [], retentionFloor: 0 }] });
  const ipcMain = runtime.ipcMain as ReturnType<typeof createFakeIpcMainV1>;
  const routeResult = record(await invokeFakeIpcV1(ipcMain, channels.subscribe, { caller }, { kind: "open", request: { hostRunId: "host.synthetic.subscription.1", afterHostSequence: 0 } }), "open");
  const route = record(routeResult.value, "route");
  await invokeFakeIpcV1(ipcMain, channels.subscribe, { caller }, { kind: "activate", subscriptionId: route.subscriptionId, generation: route.generation });
  (runtime.setCurrentCaller as (next: unknown) => void)({ ...caller, navigationEpoch: 2 });
  await ((runtime.host as Record<string, unknown>).commitCanonicalEventV1 as (value: unknown) => unknown)(event(1));
  const envelopes = runtime.deliveries as unknown[];
  assert.equal(envelopes.some((item) => record(item, "envelope").kind === "deliver"), false);
  assert.equal(envelopes.filter((item) => record(item, "envelope").kind === "closed").length, 1);
});
