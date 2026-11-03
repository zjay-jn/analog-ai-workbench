import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import {
  RESOLVE_REVIEWED_ARTIFACT_CHANNEL,
  RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION,
  RESOLVE_REVIEWED_ARTIFACT_ERROR_CODES,
  resolveReviewedArtifactRequestSchema,
  resolveReviewedArtifactResultSchema,
  type ResolveReviewedArtifactRequestV1,
} from "../apps/desktop/src/shared/schematic/reviewed-artifact-resolve";

const validRequest: ResolveReviewedArtifactRequestV1 = Object.freeze({
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("P3-C shared resolve request/result contract is exact and versioned", () => {
  assert.equal(
    RESOLVE_REVIEWED_ARTIFACT_CHANNEL,
    "workbench.schematic.resolveReviewedArtifact.v1",
  );
  assert.equal(
    RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION,
    "workbench.schematic.resolveReviewedArtifact.v1",
  );
  assert.deepEqual(RESOLVE_REVIEWED_ARTIFACT_ERROR_CODES, [
    "INVALID_REQUEST",
    "CAPABILITY_DENIED",
    "REVISION_UNAVAILABLE",
    "PAYLOAD_TOO_LARGE",
    "INTERNAL",
  ]);

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: { uuid: true },
  });
  const validateRequest = ajv.compile(resolveReviewedArtifactRequestSchema);
  const validateResult = ajv.compile(resolveReviewedArtifactResultSchema);
  assert.equal(validateRequest(validRequest), true);

  const forbiddenRequestCases: ReadonlyArray<readonly [string, unknown]> = [
    ["caller session", { ...cloneJson(validRequest), sessionId: "renderer" }],
    ["path", { ...cloneJson(validRequest), path: "C:/fixture.json" }],
    ["grant", { ...cloneJson(validRequest), grant: "self-asserted" }],
    ["digest", { ...cloneJson(validRequest), payloadDigest: "sha256:00" }],
    ["schema", { ...cloneJson(validRequest), schemaVersion: "anything" }],
    [
      "document unknown field",
      {
        ...cloneJson(validRequest),
        documentRef: { ...validRequest.documentRef, latest: true },
      },
    ],
    [
      "artifact unknown field",
      {
        ...cloneJson(validRequest),
        artifactRef: { ...validRequest.artifactRef, uri: "fixture://flat" },
      },
    ],
    [
      "wrong document kind",
      {
        ...cloneJson(validRequest),
        documentRef: { ...validRequest.documentRef, documentKind: "candidate" },
      },
    ],
    [
      "wrong artifact kind",
      {
        ...cloneJson(validRequest),
        artifactRef: { ...validRequest.artifactRef, artifactKind: "candidate" },
      },
    ],
    ["wrong intent", { ...cloneJson(validRequest), intent: "read" }],
  ];
  for (const [label, candidate] of forbiddenRequestCases) {
    assert.equal(validateRequest(candidate), false, label);
  }

  const reviewedCircuitIr = JSON.parse(
    readFileSync(
      "packages/schematic-workbench/fixtures/flat-basic.json",
      "utf8",
    ),
  ) as unknown;
  const success = {
    ok: true,
    value: {
      contractVersion: RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION,
      documentRef: validRequest.documentRef,
      artifactRef: validRequest.artifactRef,
      freshness: "current",
      reviewedCircuitIr,
    },
  } as const;
  assert.equal(validateResult(success), true);

  const safeError = {
    ok: false,
    error: {
      code: "CAPABILITY_DENIED",
      message: "The requested capability is unavailable.",
      correlationId: "00000000-0000-4000-8000-000000000001",
      retryability: "never",
      recoveryAction: "none",
    },
  } as const;
  assert.equal(validateResult(safeError), true);

  const forbiddenResultCases: ReadonlyArray<readonly [string, unknown]> = [
    [
      "receipt trust state",
      {
        ...cloneJson(success),
        value: { ...success.value, receipt: { issuerId: "renderer-visible" } },
      },
    ],
    [
      "source frame",
      {
        ...cloneJson(success),
        value: { ...success.value, sourceFrame: [123, 125] },
      },
    ],
    [
      "path",
      {
        ...cloneJson(success),
        value: { ...success.value, path: "C:/fixture.json" },
      },
    ],
    [
      "digest evidence",
      {
        ...cloneJson(success),
        value: { ...success.value, payloadDigest: "sha256:00" },
      },
    ],
    [
      "unknown error field",
      {
        ...cloneJson(safeError),
        error: { ...safeError.error, details: "registry contents" },
      },
    ],
    [
      "retryable error",
      {
        ...cloneJson(safeError),
        error: { ...safeError.error, retryability: "retry" },
      },
    ],
  ];
  for (const [label, candidate] of forbiddenResultCases) {
    assert.equal(validateResult(candidate), false, label);
  }
});
