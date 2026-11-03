import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { optionalP4cRendererHost } from "./helpers/phase4-p4c-runner";
import { sha256CanonicalAawJsonV1 } from "../packages/schematic-workbench/src/canonical-json";

type StateReducer = (state: unknown, action: unknown) => unknown;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Readonly<Record<string, unknown>>;
}

const deltaEvent = Object.freeze({
  type: "message.delta",
  hostRunId: "host.synthetic.1",
  eventId: "event.synthetic.1",
  hostSequence: 1,
  acceptedAt: "2026-09-02T00:00:01Z",
  canonicalPayloadDigest: sha256CanonicalAawJsonV1({ text: "Synthetic delta." }),
  payload: Object.freeze({ text: "Synthetic delta." }),
});

test("P4C_RENDERER_AGENT_HOST_UNAVAILABLE", async () => {
  const loaded = await optionalP4cRendererHost();
  if (!loaded.available) assert.fail(loaded.code);
});

test("P4-C Renderer deduplicates replay/live and does not optimistically cancel", async (t) => {
  const loaded = await optionalP4cRendererHost();
  if (!loaded.available) return void t.skip(loaded.code);
  const create = loaded.value.state.createInitialAgentViewStateV1;
  const reduce = loaded.value.state.reduceAgentViewStateV1;
  assert.equal(typeof create, "function");
  assert.equal(typeof reduce, "function");
  let state = (create as () => unknown)();
  const reducer = reduce as StateReducer;
  state = reducer(state, { type: "run-started", hostRunId: "host.synthetic.1" });
  state = reducer(state, { type: "canonical-event", event: deltaEvent, replayed: true, generation: 1 });
  const replayed = record(state, "replayed state");
  state = reducer(state, { type: "canonical-event", event: deltaEvent, replayed: false, generation: 1 });
  assert.deepEqual(state, replayed);
  state = reducer(state, { type: "cancel-requested" });
  const cancelling = record(state, "cancelling state");
  assert.equal(cancelling.lifecycle, "cancelling");
  assert.equal(cancelling.cancelEnabled, false);
  assert.notEqual(cancelling.lifecycle, "terminal");
});

test("P4-C Renderer gates recovery, citation freshness, ARIA and stale generations", async (t) => {
  const loaded = await optionalP4cRendererHost();
  if (!loaded.available) return void t.skip(loaded.code);
  const create = loaded.value.state.createInitialAgentViewStateV1;
  const reduce = loaded.value.state.reduceAgentViewStateV1 as StateReducer;
  assert.equal(typeof create, "function");
  let state = (create as () => unknown)();
  state = reduce(state, { type: "run-started", hostRunId: "host.synthetic.1" });
  state = reduce(state, {
    type: "recovery-offered",
    retryability: "safe_resume",
    recoveryAction: "resume_from_cursor",
  });
  assert.equal(record(state, "recovery state").recoveryRequiresUserAction, true);
  state = reduce(state, {
    type: "citation-resolved",
    generation: 2,
    citationId: "citation.synthetic.1",
    revisionId: "rev-historical",
    freshness: "historical",
  });
  const historical = record(state, "historical citation state");
  assert.equal(historical.citationFreshness, "historical");
  state = reduce(state, {
    type: "citation-resolved",
    generation: 1,
    citationId: "citation.synthetic.1",
    revisionId: "rev-late",
    freshness: "current",
  });
  assert.deepEqual(state, historical);

  const previewPayload = {
    citationId: "citation.synthetic.preview",
    source: { sourceKind: "artifact", artifactId: "synthetic.circuit-ir.flat-basic", revisionId: "rev-preview" },
    locator: { locatorKind: "whole_source" },
    authorityStatus: "authoritative",
    verificationStatus: "verified",
    preview: { text: "Previously visible preview.", truncated: false },
  };
  state = reduce(state, {
    type: "canonical-event",
    generation: 2,
    replayed: false,
    event: {
      ...deltaEvent,
      hostRunId: "host.synthetic.1",
      type: "citation.declared",
      eventId: "event.synthetic.preview",
      hostSequence: 1,
      canonicalPayloadDigest: sha256CanonicalAawJsonV1(previewPayload),
      payload: previewPayload,
    },
  });
  state = reduce(state, {
    type: "citation-failed",
    generation: 2,
    citationId: "citation.synthetic.preview",
    freshness: "revoked",
  });
  const revokedCitation = (record(state, "revoked citation state").citations as readonly Readonly<Record<string, unknown>>[])
    .find((citation) => citation.citationId === "citation.synthetic.preview");
  assert.equal(revokedCitation?.freshness, "revoked");
  assert.equal(Object.hasOwn(revokedCitation ?? {}, "previewText"), false, "revocation must remove stale preview text");
  assert.equal(Object.hasOwn(revokedCitation ?? {}, "previewTruncated"), false, "revocation must remove stale preview metadata");

  state = reduce(state, {
    type: "source-time-warning",
    generation: 2,
    eventId: "event.synthetic.warning.1",
    hostSequence: 2,
    message: "Source timestamp was invalid and was ignored.",
  });
  const firstWarning = record(state, "warning state");
  state = reduce(state, {
    type: "source-time-warning",
    generation: 2,
    eventId: "event.synthetic.warning.1",
    hostSequence: 2,
    message: "Source timestamp was invalid and was ignored.",
  });
  assert.deepEqual(state, firstWarning);
  assert.doesNotMatch(JSON.stringify(state), /rawSourceTime|sourceTimeValue/u);
});

test("P4-C Renderer cleanup is generation-invalidated and unsubscribe exactly once", async (t) => {
  const loaded = await optionalP4cRendererHost();
  if (!loaded.available) return void t.skip(loaded.code);
  const create = loaded.value.state.createInitialAgentViewStateV1;
  const reduce = loaded.value.state.reduceAgentViewStateV1 as StateReducer;
  assert.equal(typeof create, "function");
  let state = (create as () => unknown)();
  state = reduce(state, { type: "subscription-opened", generation: 1 });
  state = reduce(state, { type: "unmount", generation: 2 });
  const first = record(state, "first cleanup");
  assert.equal(first.unsubscribeRequestDelta, 1);
  assert.equal(first.queuedEventCount, 0);
  state = reduce(state, { type: "unmount", generation: 3 });
  assert.equal(record(state, "repeat cleanup").unsubscribeRequestDelta, 1);
});

test("P4-C injected AgentPanel controller drives real API callbacks into SSR markup and ARIA", async (t) => {
  const loaded = await optionalP4cRendererHost();
  if (!loaded.available) return void t.skip(loaded.code);
  const createController = loaded.value.panel.createAgentPanelControllerV1;
  const AgentPanel = loaded.value.panel.AgentPanel;
  assert.equal(typeof createController, "function");
  assert.equal(typeof AgentPanel, "function");
  let subscriptionCallback: ((event: unknown) => void) | undefined;
  let unsubscribeCount = 0;
  let cancelCount = 0;
  let resolveCitationCount = 0;
  const api = Object.freeze({
    getInfo: async () => ({ ok: true, value: {} }),
    resolveReviewedArtifact: async () => ({ ok: false, error: { code: "REVISION_UNAVAILABLE", message: "Unavailable.", retryability: "never", recoveryAction: "none" } }),
    startTurn: async () => ({ ok: true, value: { hostRunId: "host.synthetic.controller.1" } }),
    subscribeRun: async (_request: unknown, callback: (event: unknown) => void) => {
      subscriptionCallback = callback;
      return { ok: true, value: { unsubscribe: async () => { unsubscribeCount += 1; } } };
    },
    cancelRun: async () => { cancelCount += 1; return { ok: true, value: { hostRunId: "host.synthetic.controller.1", cancelState: "requested" } }; },
    resolveArtifact: async () => ({ ok: true, value: { freshness: "current", action: "inspect" } }),
    resolveCitation: async () => { resolveCitationCount += 1; return { ok: true, value: { freshness: "historical", action: "preview_source" } }; },
  });
  const controller = (createController as (input: unknown) => Record<string, unknown>)({ api });
  await (controller.submitTurn as (request: unknown) => Promise<void>)({ text: "Inspect the reviewed circuit." });
  assert.equal(typeof subscriptionCallback, "function");
  const emit = subscriptionCallback as (event: unknown) => void;
  emit({ ...deltaEvent, hostRunId: "host.synthetic.controller.1" });
  const beforeAriaFlush = record((controller.snapshot as () => unknown)(), "pending ARIA state");
  assert.equal(beforeAriaFlush.politeAnnouncement, "", "message deltas must not announce before the batch flush");
  assert.equal(beforeAriaFlush.pendingPoliteAnnouncement, "Synthetic delta.");
  const citationPayload = {
    citationId: "citation.synthetic.1",
    source: { sourceKind: "artifact", artifactId: "synthetic.circuit-ir.flat-basic", revisionId: "rev-historical" },
    locator: { locatorKind: "whole_source" },
    authorityStatus: "authoritative",
    verificationStatus: "verified",
  };
  emit({
    ...deltaEvent,
    hostRunId: "host.synthetic.controller.1",
    type: "citation.declared",
    eventId: "event.synthetic.citation.1",
    hostSequence: 2,
    canonicalPayloadDigest: sha256CanonicalAawJsonV1(citationPayload),
    payload: citationPayload,
  });
  await Promise.resolve();
  const afterAriaFlush = record((controller.snapshot as () => unknown)(), "flushed ARIA state");
  assert.equal(afterAriaFlush.pendingPoliteAnnouncement, "", "the batched delta queue must be cleared after one flush");
  assert.equal(afterAriaFlush.politeAnnouncement, "Synthetic delta.");
  const Panel = AgentPanel as (props: { mode: string; controller: Record<string, unknown> }) => ReturnType<typeof createElement>;
  const markup = renderToStaticMarkup(createElement(Panel, { mode: "test", controller }));
  assert.match(markup, /<h1 id="agent-panel-title">软件产品主控<\/h1>/u);
  assert.match(markup, /Synthetic delta\./u);
  assert.match(markup, /aria-live="polite">Synthetic delta\.<\/div>/u);
  assert.match(markup, /citation\.synthetic\.1|rev-historical/u);
  assert.doesNotMatch(markup, /<span>你<\/span>|<span>Agent<\/span>/u);
  await (controller.resolveCitation as (citationId: string) => Promise<void>)("citation.synthetic.1");
  assert.equal(resolveCitationCount, 1);
  await (controller.requestCancel as () => Promise<void>)();
  await (controller.requestCancel as () => Promise<void>)();
  assert.equal(cancelCount, 1);
  const cancelledPayload = { reason: "cancelled" };
  const cancelled = {
    ...deltaEvent,
    hostRunId: "host.synthetic.controller.1",
    type: "run.cancelled",
    eventId: "event.synthetic.cancelled.1",
    hostSequence: 3,
    canonicalPayloadDigest: sha256CanonicalAawJsonV1(cancelledPayload),
    payload: cancelledPayload,
  };
  emit(cancelled);
  emit(cancelled);
  await Promise.resolve();
  const terminalState = record((controller.snapshot as () => unknown)(), "terminal controller state");
  assert.equal(terminalState.lifecycle, "terminal");
  assert.equal(terminalState.rendererEmissions, 3, "duplicate terminal must not render twice");
  const cancellingMarkup = renderToStaticMarkup(createElement(Panel, { mode: "test", controller }));
  assert.match(cancellingMarkup, /<textarea[^>]*aria-label="消息输入"/u);
  assert.match(cancellingMarkup, /<button[^>]*aria-label="发送消息"[^>]*disabled=""[^>]*>Start synthetic turn<\/button>/u);
  assert.doesNotMatch(cancellingMarkup, />Cancel<\/button>/u);
});

test("P4-C controller recovery is user-gated and cleanup ignores late callbacks exactly once", async (t) => {
  const loaded = await optionalP4cRendererHost();
  if (!loaded.available) return void t.skip(loaded.code);
  const createController = loaded.value.panel.createAgentPanelControllerV1;
  const AgentPanel = loaded.value.panel.AgentPanel;
  assert.equal(typeof createController, "function");
  let callback: ((event: unknown) => void) | undefined;
  let subscriptions = 0;
  let unsubscribeCount = 0;
  const api = {
    startTurn: async () => ({ ok: true, value: { hostRunId: "host.synthetic.controller.1" } }),
    subscribeRun: async (_request: unknown, next: (event: unknown) => void) => {
      subscriptions += 1; callback = next;
      return { ok: true, value: { unsubscribe: async () => { unsubscribeCount += 1; } } };
    },
    cancelRun: async () => ({ ok: true, value: { hostRunId: "host.synthetic.controller.1", cancelState: "requested" } }),
    resolveArtifact: async () => ({ ok: false, error: { code: "REVISION_UNAVAILABLE", message: "Unavailable.", retryability: "never", recoveryAction: "none" } }),
    resolveCitation: async () => ({ ok: false, error: { code: "REVISION_UNAVAILABLE", message: "Unavailable.", retryability: "never", recoveryAction: "none" } }),
  };
  const controller = (createController as (input: unknown) => Record<string, unknown>)({ api });
  await (controller.submitTurn as (request: unknown) => Promise<void>)({ text: "start" });
  assert.equal(typeof callback, "function");
  const emit = callback as (event: unknown) => void;
  const failedPayload = { errorCode: "STREAM_INTERRUPTED", retryability: "safe_resume", recoveryAction: "resume_from_cursor" };
  emit({ ...deltaEvent, hostRunId: "host.synthetic.controller.1", type: "run.failed", canonicalPayloadDigest: sha256CanonicalAawJsonV1(failedPayload), payload: failedPayload });
  await Promise.resolve();
  assert.equal(subscriptions, 1, "safe-resume must not happen without user action");
  const Panel = AgentPanel as (props: { mode: string; controller: Record<string, unknown> }) => ReturnType<typeof createElement>;
  const recoveryMarkup = renderToStaticMarkup(createElement(Panel, { mode: "test", controller }));
  assert.match(recoveryMarkup, /role="group"[^>]*aria-label="Synthetic run recovery"/u);
  assert.match(recoveryMarkup, />Resume synthetic run<\/button>/u);
  await (controller.resume as () => Promise<void>)();
  assert.equal(subscriptions, 2);
  await (controller.dispose as () => Promise<void>)();
  await (controller.dispose as () => Promise<void>)();
  assert.equal(unsubscribeCount, 1);
  const afterDispose = structuredClone((controller.snapshot as () => unknown)());
  emit({ ...deltaEvent, hostRunId: "host.synthetic.controller.1", eventId: "event.synthetic.late", hostSequence: 99 });
  await Promise.resolve();
  assert.deepEqual((controller.snapshot as () => unknown)(), afterDispose);
});

test("P4-C AgentPanel AST binds callbacks to the canonical reducer and owns one cleanup path", () => {
  const source = readFileSync("apps/desktop/src/renderer/agent/AgentPanel.tsx", "utf8");
  const ast = ts.createSourceFile("AgentPanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(calls.some((name) => name.endsWith("subscribeRun")), "panel/controller must subscribe through the public API");
  assert.ok(calls.some((name) => name.endsWith("reduceAgentViewStateV1")), "API callbacks must enter the canonical reducer");
  assert.equal(calls.filter((name) => name.endsWith("unsubscribe")).length, 1, "component/controller owns one cleanup invocation site");
  assert.equal(calls.filter((name) => name === "controller.dispose").length, 1, "useEffect cleanup must dispose the controller exactly once");
  assert.match(source, /useEffect\(\(\) => \{[\s\S]*?queueMicrotask\([\s\S]*?controller\.dispose\(\)/u,
    "useEffect cleanup must defer disposal so the StrictMode probe setup can cancel it");
  assert.doesNotMatch(source, /SourceEventV1|strict-agent-frame|rawSourceTime/u);
});
