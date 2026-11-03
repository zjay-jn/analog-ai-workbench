import assert from "node:assert/strict";
import test from "node:test";
import type { SyntheticAdmissionEntryV1 } from "../packages/schematic-workbench/src/synthetic-admission";
import {
  createReviewedResolveFenceV1,
  type CallerContextV1,
  type ReviewedResolveFenceV1,
} from "../apps/desktop/src/main/security/reviewed-resolve-fence";
import { createResolveReviewedArtifactHandlerV1 } from "../apps/desktop/src/main/ipc/resolve-reviewed-artifact-handler";
import type {
  ResolveReviewedArtifactRequestV1,
  ResolveReviewedArtifactResultV1,
} from "../apps/desktop/src/shared/schematic/reviewed-artifact-resolve";
import { admitP3bFixtureV1 } from "./phase3-p3b-test-support";

const correlationId = "00000000-0000-4000-8000-000000000003";
const request: ResolveReviewedArtifactRequestV1 = Object.freeze({
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
const caller: CallerContextV1 = Object.freeze({
  senderId: 17,
  isTopFrame: true,
  topFrameUrl: "http://127.0.0.1:5173/",
  appOrigin: "http://127.0.0.1:5173",
  webContentsId: 17,
  navigationEpoch: 4,
  appSessionId: "session.synthetic.1",
  windowId: "window.synthetic.1",
  documentRef: request.documentRef,
  capability: "schematic_reviewed.render",
  registryGeneration: 9,
});

function createFence(): ReviewedResolveFenceV1 {
  return createReviewedResolveFenceV1({
    caller,
    artifactRef: request.artifactRef,
    fixtureRegistryEnabled: true,
  });
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

function errorCode(result: ResolveReviewedArtifactResultV1): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected a safe resolve error");
  assert.equal(result.error.retryability, "never");
  assert.equal(result.error.recoveryAction, "none");
  return result.error.code;
}

test("P3-C CallerContext uses every main-owned ownership dimension", () => {
  const wrongCallerCases: ReadonlyArray<readonly [string, CallerContextV1]> = [
    ["sender", { ...caller, senderId: 18 }],
    ["subframe", { ...caller, isTopFrame: false }],
    ["top-frame URL", { ...caller, topFrameUrl: "https://invalid.example/" }],
    ["origin", { ...caller, appOrigin: "https://invalid.example" }],
    ["webContents", { ...caller, webContentsId: 18 }],
    ["navigation epoch", { ...caller, navigationEpoch: 5 }],
    ["session", { ...caller, appSessionId: "session.synthetic.other" }],
    ["window", { ...caller, windowId: "window.synthetic.other" }],
    [
      "document ownership",
      {
        ...caller,
        documentRef: { ...request.documentRef, revisionId: "rev-other" },
      },
    ],
    ["capability", { ...caller, capability: "none" }],
    ["registry generation", { ...caller, registryGeneration: 10 }],
  ];
  for (const [label, candidate] of wrongCallerCases) {
    const fence = createFence();
    assert.equal(fence.begin(candidate, request), null, label);
  }
  assert.ok(createFence().begin(caller, request));
});

test("P3-C pre-delivery fence cancels every lifecycle and registry race", () => {
  const invalidations: ReadonlyArray<
    readonly [
      string,
      (fence: ReviewedResolveFenceV1) => void,
      "CAPABILITY_DENIED" | "REVISION_UNAVAILABLE" | "INTERNAL",
    ]
  > = [
    ["navigation", (fence) => fence.advanceNavigation(17), "CAPABILITY_DENIED"],
    ["webContents close", (fence) => fence.closeWebContents(17), "CAPABILITY_DENIED"],
    ["window close", (fence) => fence.closeWindow("window.synthetic.1"), "CAPABILITY_DENIED"],
    ["session close", (fence) => fence.closeSession("session.synthetic.1"), "CAPABILITY_DENIED"],
    ["registry disable", (fence) => fence.disableFixtureRegistry(), "CAPABILITY_DENIED"],
    ["registry generation", (fence) => fence.advanceRegistryGeneration(), "CAPABILITY_DENIED"],
    ["revision revoke", (fence) => fence.revokeRevision(request.artifactRef), "REVISION_UNAVAILABLE"],
    ["quarantine", (fence) => fence.quarantineRevision(request.artifactRef), "INTERNAL"],
  ];
  for (const [label, invalidate, expected] of invalidations) {
    const fence = createFence();
    const lease = fence.begin(caller, request);
    assert.ok(lease, label);
    assert.equal(fence.checkBeforeDelivery(lease), "deliver", label);
    invalidate(fence);
    assert.equal(fence.checkBeforeDelivery(lease), expected, label);
  }
});

test("P3-C handler delivers only a stable validated payload and no receipt evidence", async () => {
  const admitted = admitP3bFixtureV1("flat-basic");
  const fence = createFence();
  let resolveCount = 0;
  const handler = createResolveReviewedArtifactHandlerV1({
    deriveCallerContext: (_event: unknown): CallerContextV1 => caller,
    fence,
    registry: {
      resolveExact: async (): Promise<SyntheticAdmissionEntryV1> => {
        resolveCount += 1;
        return admitted;
      },
    },
    createCorrelationId: (): string => correlationId,
  });

  const result = await handler(Object.freeze({}), request);
  assert.equal(resolveCount, 1);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected a reviewed artifact result");
  assert.deepEqual(Object.keys(result.value).sort(), [
    "artifactRef",
    "contractVersion",
    "documentRef",
    "freshness",
    "reviewedCircuitIr",
  ]);
  assert.equal(result.value.freshness, "current");
  assert.notEqual(result.value.reviewedCircuitIr, admitted.circuitIr);
  assert.deepEqual(result.value.reviewedCircuitIr, admitted.circuitIr);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /receipt|issuerId|fixtureManifestDigest|payloadDigest|sourceFrame|relativePath/iu,
  );
});

test("P3-C handler rechecks the fence after an async lookup and delivers zero late payload", async () => {
  const admitted = admitP3bFixtureV1("flat-basic");
  const invalidations: ReadonlyArray<
    readonly [
      string,
      (fence: ReviewedResolveFenceV1) => void,
      "CAPABILITY_DENIED" | "REVISION_UNAVAILABLE" | "INTERNAL",
    ]
  > = [
    ["navigation", (fence) => fence.advanceNavigation(17), "CAPABILITY_DENIED"],
    ["registry generation", (fence) => fence.advanceRegistryGeneration(), "CAPABILITY_DENIED"],
    ["revision revoke", (fence) => fence.revokeRevision(request.artifactRef), "REVISION_UNAVAILABLE"],
    ["quarantine", (fence) => fence.quarantineRevision(request.artifactRef), "INTERNAL"],
  ];

  for (const [label, invalidate, expectedCode] of invalidations) {
    const pending = deferred<SyntheticAdmissionEntryV1>();
    const fence = createFence();
    const handler = createResolveReviewedArtifactHandlerV1({
      deriveCallerContext: (_event: unknown): CallerContextV1 => caller,
      fence,
      registry: {
        resolveExact: async (): Promise<SyntheticAdmissionEntryV1> => pending.promise,
      },
      createCorrelationId: (): string => correlationId,
    });
    const pendingResult = handler(Object.freeze({}), request);
    invalidate(fence);
    pending.resolve(admitted);
    const result = await pendingResult;
    assert.equal(errorCode(result), expectedCode, label);
    assert.equal("value" in result, false, label);
    assert.doesNotMatch(JSON.stringify(result), /definitions|receiptId|net\.flat/u, label);
  }
});

test("P3-C invalid and unauthorized calls fail before registry lookup", async () => {
  const admitted = admitP3bFixtureV1("flat-basic");
  const cases: ReadonlyArray<
    readonly [string, CallerContextV1 | null, unknown, "INVALID_REQUEST" | "CAPABILITY_DENIED"]
  > = [
    ["unknown caller", null, request, "CAPABILITY_DENIED"],
    ["wrong sender", { ...caller, senderId: 99 }, request, "CAPABILITY_DENIED"],
    ["renderer caller fields", caller, { ...request, windowId: caller.windowId }, "INVALID_REQUEST"],
  ];
  for (const [label, derivedCaller, candidateRequest, expectedCode] of cases) {
    let resolveCount = 0;
    const handler = createResolveReviewedArtifactHandlerV1({
      deriveCallerContext: (_event: unknown): CallerContextV1 | null => derivedCaller,
      fence: createFence(),
      registry: {
        resolveExact: async (): Promise<SyntheticAdmissionEntryV1> => {
          resolveCount += 1;
          return admitted;
        },
      },
      createCorrelationId: (): string => correlationId,
    });
    const result = await handler(Object.freeze({}), candidateRequest);
    assert.equal(errorCode(result), expectedCode, label);
    assert.equal(resolveCount, 0, label);
  }
});

test("P3-C request materialization rejects prototype, accessor, symbol and proxy state without reads", async () => {
  const admitted = admitP3bFixtureV1("flat-basic");
  let resolveCount = 0;
  let getterReads = 0;
  let proxyReads = 0;
  const handler = createResolveReviewedArtifactHandlerV1({
    deriveCallerContext: (): CallerContextV1 => caller,
    fence: createFence(),
    registry: {
      resolveExact: async (): Promise<SyntheticAdmissionEntryV1> => {
        resolveCount += 1;
        return admitted;
      },
    },
    createCorrelationId: (): string => correlationId,
  });

  const accessor = { ...request } as Record<string, unknown>;
  Object.defineProperty(accessor, "contractVersion", {
    enumerable: true,
    get: () => {
      getterReads += 1;
      return request.contractVersion;
    },
  });
  const symbolState = { ...request } as Record<PropertyKey, unknown>;
  symbolState[Symbol("renderer-grant")] = "forbidden";
  const nonEnumerable = { ...request } as Record<string, unknown>;
  Object.defineProperty(nonEnumerable, "rendererScope", {
    enumerable: false,
    value: "forbidden",
  });
  const prototypeState = Object.assign(Object.create({ inherited: true }), request);
  const proxyState = new Proxy(
    { ...request },
    {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );

  for (const candidate of [
    accessor,
    symbolState,
    nonEnumerable,
    prototypeState,
    proxyState,
  ]) {
    assert.equal(errorCode(await handler(Object.freeze({}), candidate)), "INVALID_REQUEST");
  }
  assert.equal(getterReads, 0);
  assert.equal(proxyReads, 0);
  assert.equal(resolveCount, 0);
});
