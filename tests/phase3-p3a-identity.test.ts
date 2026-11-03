import assert from "node:assert/strict";
import test from "node:test";
import {
  createReviewedIdentityRegistryV1,
  parseReviewedArtifactRefV1,
  parseReviewedDocumentRefV1,
  ReviewedIdentityError,
  type ReviewedIdentityErrorCodeV1,
} from "../packages/document-contract/src/reviewed-identity";

function documentRef(
  revisionId = "rev-1",
  documentId = "synthetic.schematic.identity",
) {
  return {
    documentId,
    revisionId,
    documentKind: "schematic_reviewed",
  };
}

function artifactRef(
  revisionId = "rev-1",
  artifactId = "synthetic.circuit-ir.identity",
) {
  return {
    artifactId,
    revisionId,
    artifactKind: "circuit_ir_reviewed",
  };
}

function identityError(
  code: ReviewedIdentityErrorCodeV1,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ReviewedIdentityError);
    assert.equal(error.code, code);
    assert.equal(error.retryability, "never");
    assert.equal(error.recoveryAction, "none");
    return true;
  };
}

test("P3-A identity parsers require exact data descriptors and bounded exact kinds", () => {
  const parsedDocument = parseReviewedDocumentRefV1(documentRef());
  const parsedArtifact = parseReviewedArtifactRefV1(artifactRef());
  assert.deepEqual(parsedDocument, documentRef());
  assert.deepEqual(parsedArtifact, artifactRef());
  assert.equal(Object.isFrozen(parsedDocument), true);
  assert.equal(Object.isFrozen(parsedArtifact), true);

  const accessor = documentRef();
  Object.defineProperty(accessor, "documentId", {
    configurable: true,
    enumerable: true,
    get: () => "synthetic.schematic.identity",
  });
  const hidden = documentRef();
  Object.defineProperty(hidden, "revisionId", {
    configurable: true,
    enumerable: false,
    value: "rev-1",
  });
  const symbolProperty = documentRef();
  Object.defineProperty(symbolProperty, Symbol("hidden"), {
    enumerable: true,
    value: true,
  });
  const nullPrototype = Object.assign(Object.create(null) as object, documentRef());

  const rejectedDocuments: ReadonlyArray<readonly [string, unknown]> = [
    ["accessor", accessor],
    ["non-enumerable property", hidden],
    ["symbol property", symbolProperty],
    ["null prototype", nullPrototype],
    ["extra field", { ...documentRef(), extra: true }],
    ["reserved latest", documentRef("latest")],
    ["invalid alphabet", documentRef("rev/1")],
    ["oversize UTF-8 component", documentRef("a".repeat(129))],
    ["wrong kind", { ...documentRef(), documentKind: "schematic_candidate" }],
  ];
  for (const [label, value] of rejectedDocuments) {
    assert.throws(
      () => parseReviewedDocumentRefV1(value),
      identityError("INVALID_REQUEST"),
      label,
    );
  }

  const rejectedArtifacts: ReadonlyArray<readonly [string, unknown]> = [
    ["reserved latest", artifactRef("latest")],
    ["invalid alphabet", artifactRef("rev 1")],
    ["oversize UTF-8 component", artifactRef("b".repeat(129))],
    ["wrong kind", { ...artifactRef(), artifactKind: "candidate" }],
  ];
  for (const [label, value] of rejectedArtifacts) {
    assert.throws(
      () => parseReviewedArtifactRefV1(value),
      identityError("INVALID_REQUEST"),
      label,
    );
  }
});

test("P3-A identity registry is bidirectional, immutable, replay-idempotent and historical-aware", () => {
  const registry = createReviewedIdentityRegistryV1();
  const currentInput = {
    documentRef: documentRef(),
    artifactRef: artifactRef(),
    freshness: "current",
  } as const;
  const current = registry.admitBinding(currentInput);
  const replay = registry.admitBinding(currentInput);
  assert.equal(replay, current);
  assert.equal(registry.resolveByDocument(documentRef()), current);
  assert.equal(registry.resolveByArtifact(artifactRef()), current);
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.documentRef), true);
  assert.equal(Object.isFrozen(current.artifactRef), true);

  const historicalInput = {
    documentRef: documentRef("rev-0"),
    artifactRef: artifactRef("rev-0"),
    freshness: "historical",
  } as const;
  const historical = registry.admitBinding(historicalInput);
  assert.equal(registry.admitBinding(historicalInput), historical);
  assert.equal(registry.resolveByDocument(documentRef("rev-0")), historical);
  assert.equal(registry.resolveByArtifact(artifactRef("rev-0")), historical);
  assert.equal(registry.resolveByDocument(documentRef()), current);

  assert.throws(
    () => registry.resolveByDocument(documentRef("rev-missing")),
    identityError("REVISION_UNAVAILABLE"),
  );
  assert.throws(
    () => registry.resolveByArtifact(artifactRef("rev-missing")),
    identityError("REVISION_UNAVAILABLE"),
  );
});

test("P3-A second current and one-to-many identity conflicts quarantine both directions", () => {
  const secondCurrent = createReviewedIdentityRegistryV1();
  const originalDocument = documentRef("rev-1", "synthetic.schematic.current");
  const originalArtifact = artifactRef("rev-1", "synthetic.circuit-ir.current-1");
  const requestedDocument = documentRef("rev-2", "synthetic.schematic.current");
  const requestedArtifact = artifactRef("rev-2", "synthetic.circuit-ir.current-2");
  secondCurrent.admitBinding({
    documentRef: originalDocument,
    artifactRef: originalArtifact,
    freshness: "current",
  });
  assert.throws(
    () =>
      secondCurrent.admitBinding({
        documentRef: requestedDocument,
        artifactRef: requestedArtifact,
        freshness: "current",
      }),
    identityError("INTERNAL"),
  );
  for (const ref of [originalDocument, requestedDocument]) {
    assert.throws(
      () => secondCurrent.resolveByDocument(ref),
      identityError("INTERNAL"),
    );
  }
  for (const ref of [originalArtifact, requestedArtifact]) {
    assert.throws(
      () => secondCurrent.resolveByArtifact(ref),
      identityError("INTERNAL"),
    );
  }

  const oneToMany = createReviewedIdentityRegistryV1();
  const sharedDocument = documentRef("rev-1", "synthetic.schematic.one-to-many");
  const firstArtifact = artifactRef("rev-1", "synthetic.circuit-ir.one");
  const secondArtifact = artifactRef("rev-1", "synthetic.circuit-ir.two");
  oneToMany.admitBinding({
    documentRef: sharedDocument,
    artifactRef: firstArtifact,
    freshness: "historical",
  });
  assert.throws(
    () =>
      oneToMany.admitBinding({
        documentRef: sharedDocument,
        artifactRef: secondArtifact,
        freshness: "historical",
      }),
    identityError("INTERNAL"),
  );
  assert.throws(
    () => oneToMany.resolveByDocument(sharedDocument),
    identityError("INTERNAL"),
  );
  assert.throws(
    () => oneToMany.resolveByArtifact(firstArtifact),
    identityError("INTERNAL"),
  );
  assert.throws(
    () => oneToMany.resolveByArtifact(secondArtifact),
    identityError("INTERNAL"),
  );
});

test("P3-A many-to-one identity conflicts quarantine both directions", () => {
  const registry = createReviewedIdentityRegistryV1();
  const firstDocument = documentRef("rev-1", "synthetic.schematic.many-one-a");
  const secondDocument = documentRef("rev-1", "synthetic.schematic.many-one-b");
  const sharedArtifact = artifactRef("rev-1", "synthetic.circuit-ir.many-one");
  registry.admitBinding({
    documentRef: firstDocument,
    artifactRef: sharedArtifact,
    freshness: "historical",
  });
  assert.throws(
    () =>
      registry.admitBinding({
        documentRef: secondDocument,
        artifactRef: sharedArtifact,
        freshness: "historical",
      }),
    identityError("INTERNAL"),
  );
  assert.throws(
    () => registry.resolveByDocument(firstDocument),
    identityError("INTERNAL"),
  );
  assert.throws(
    () => registry.resolveByDocument(secondDocument),
    identityError("INTERNAL"),
  );
  assert.throws(
    () => registry.resolveByArtifact(sharedArtifact),
    identityError("INTERNAL"),
  );
});
