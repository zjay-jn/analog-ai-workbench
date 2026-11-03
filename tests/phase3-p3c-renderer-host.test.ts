import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../apps/desktop/src/renderer/App";
import {
  RendererReviewedArtifactDeliveryError,
  admitReviewedArtifactDeliveryV1,
  createReviewedArtifactHostControllerV1,
  type ReviewedArtifactHostStateV1,
} from "../apps/desktop/src/renderer/schematic/reviewed-artifact-host";
import type {
  ResolvedReviewedArtifactV1,
  ResolveReviewedArtifactRequestV1,
  ResolveReviewedArtifactResultV1,
} from "../apps/desktop/src/shared/schematic/reviewed-artifact-resolve";
import { admitP3bFixtureV1 } from "./phase3-p3b-test-support";

const baseRequest: ResolveReviewedArtifactRequestV1 = Object.freeze({
  contractVersion: "workbench.schematic.resolveReviewedArtifact.v1",
  documentRef: Object.freeze({
    documentId: "synthetic.schematic.flat-basic",
    revisionId: "rev-1",
    documentKind: "schematic_reviewed",
  }),
  artifactRef: Object.freeze({
    artifactId: "synthetic.circuit-ir.flat-basic",
    revisionId: "rev-1",
    artifactKind: "circuit_ir_reviewed",
  }),
  intent: "render",
});

function requestAt(revisionId: string): ResolveReviewedArtifactRequestV1 {
  return Object.freeze({
    ...baseRequest,
    documentRef: Object.freeze({ ...baseRequest.documentRef, revisionId }),
    artifactRef: Object.freeze({ ...baseRequest.artifactRef, revisionId }),
  });
}

function successfulResultAt(revisionId: string): ResolveReviewedArtifactResultV1 {
  const admitted = admitP3bFixtureV1("flat-basic");
  return {
    ok: true,
    value: {
      contractVersion: "workbench.schematic.resolveReviewedArtifact.v1",
      documentRef: { ...baseRequest.documentRef, revisionId },
      artifactRef: { ...baseRequest.artifactRef, revisionId },
      freshness: revisionId === "rev-1" ? "current" : "historical",
      reviewedCircuitIr: JSON.parse(
        JSON.stringify(admitted.circuitIr),
      ) as ResolvedReviewedArtifactV1["reviewedCircuitIr"],
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      assert.ok(resolvePromise);
      resolvePromise(value);
    },
  };
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test("P3-C renderer validates a structured clone and owns a deep-frozen snapshot", () => {
  const result = successfulResultAt("rev-1");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected fixture success");
  const mutableDelivery = result.value as unknown as {
    documentRef: { revisionId: string };
    reviewedCircuitIr: {
      definitions: Array<{ definitionId: string }>;
    };
  };
  const snapshot = admitReviewedArtifactDeliveryV1(mutableDelivery);
  assert.notEqual(snapshot, mutableDelivery);
  assert.notEqual(snapshot.reviewedCircuitIr, mutableDelivery.reviewedCircuitIr);
  assertDeepFrozen(snapshot);
  const snapshotDefinition = snapshot.reviewedCircuitIr.definitions[0]!.definitionId;
  mutableDelivery.documentRef.revisionId = "rev-mutated-after-clone";
  mutableDelivery.reviewedCircuitIr.definitions[0]!.definitionId =
    "definition.mutated-after-clone";
  assert.equal(snapshot.documentRef.revisionId, "rev-1");
  assert.equal(
    snapshot.reviewedCircuitIr.definitions[0]!.definitionId,
    snapshotDefinition,
  );

  const invalidDeliveries: ReadonlyArray<readonly [string, unknown]> = [
    ["receipt", { ...result.value, receipt: { issuerId: "renderer-visible" } }],
    ["path", { ...result.value, path: "C:/fixture.json" }],
    [
      "non-cloneable value",
      {
        ...result.value,
        reviewedCircuitIr: {
          ...(result.value.reviewedCircuitIr as object),
          definitions: [() => undefined],
        },
      },
    ],
  ];
  for (const [label, candidate] of invalidDeliveries) {
    assert.throws(
      () => admitReviewedArtifactDeliveryV1(candidate),
      (error: unknown) => {
        assert.ok(error instanceof RendererReviewedArtifactDeliveryError);
        assert.equal(error.code, "INVALID_DELIVERY");
        return true;
      },
      label,
    );
  }
});

test("P3-C renderer host ignores late results after revision switch and unmount", async () => {
  const pendingByRevision = new Map<
    string,
    ReturnType<typeof deferred<ResolveReviewedArtifactResultV1>>
  >();
  const host = createReviewedArtifactHostControllerV1({
    resolveReviewedArtifact: (
      resolveRequest: ResolveReviewedArtifactRequestV1,
    ): Promise<ResolveReviewedArtifactResultV1> => {
      const pending = deferred<ResolveReviewedArtifactResultV1>();
      pendingByRevision.set(resolveRequest.artifactRef.revisionId, pending);
      return pending.promise;
    },
  });

  const first = host.mount(requestAt("rev-1"));
  assert.equal(host.getState().status, "loading");
  const second = host.mount(requestAt("rev-2"));
  pendingByRevision.get("rev-1")?.resolve(successfulResultAt("rev-1"));
  await first;
  assert.equal(host.getState().status, "loading");
  assert.equal(host.getState().request.artifactRef.revisionId, "rev-2");
  pendingByRevision.get("rev-2")?.resolve(successfulResultAt("rev-2"));
  await second;
  const ready = host.getState();
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("Expected ready host state");
  assert.equal(ready.delivery.artifactRef.revisionId, "rev-2");
  assert.equal(ready.delivery.freshness, "historical");
  assertDeepFrozen(ready);

  const third = host.mount(requestAt("rev-3"));
  host.unmount();
  pendingByRevision.get("rev-3")?.resolve(successfulResultAt("rev-3"));
  await third;
  const afterUnmount: ReviewedArtifactHostStateV1 = host.getState();
  assert.equal(afterUnmount.status, "idle");
});

test("P3-C App exposes exactly the text and synthetic schematic tabs through the host", () => {
  const markup = renderToStaticMarkup(createElement(App));
  assert.equal((markup.match(/role="tab"/gu) ?? []).length, 2);
  assert.match(markup, />fixture-notes\.txt</u);
  assert.match(markup, />flat-basic\.schematic</u);
  assert.match(markup, /data-schematic-workspace="true"/u);
  assert.match(
    markup,
    /SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED/u,
  );
  assert.doesNotMatch(
    markup,
    /Provider:\s*(?:file|OA|Cadence)|Agent connected|EDA connected/iu,
  );
});
