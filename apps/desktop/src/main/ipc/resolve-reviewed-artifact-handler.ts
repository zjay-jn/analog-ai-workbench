import {
  ReviewedIdentityError,
  parseReviewedArtifactRefV1,
  parseReviewedDocumentRefV1,
  type ReviewedArtifactRefV1,
  type ReviewedDocumentRefV1,
} from "../../../../../packages/document-contract/src/reviewed-identity";
import { sha256CanonicalAawJsonV1 } from "../../../../../packages/schematic-workbench/src/canonical-json";
import {
  REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION,
  REVIEWED_CIRCUIT_IR_SCHEMA_VERSION,
  validateReviewedCircuitIrV1,
  type ReviewedCircuitIrV1,
} from "../../../../../packages/schematic-workbench/src/reviewed-circuit-ir";
import type {
  SyntheticAdmissionEntryV1,
} from "../../../../../packages/schematic-workbench/src/synthetic-admission";
import {
  ReviewedArtifactRegistryError,
  type ReviewedArtifactLookupV1,
} from "../schematic/reviewed-artifact-registry";
import type {
  CallerContextV1,
  ReviewedResolveFenceDecisionV1,
  ReviewedResolveFenceV1,
} from "../security/reviewed-resolve-fence";
import {
  RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION,
  type ResolveReviewedArtifactErrorCodeV1,
  type ResolveReviewedArtifactRequestV1,
  type ResolveReviewedArtifactResultV1,
} from "../../shared/schematic/reviewed-artifact-resolve";
import { types as nodeTypes } from "node:util";

type ResolveRegistryV1 = Readonly<{
  resolveExact(
    input: ReviewedArtifactLookupV1,
  ): SyntheticAdmissionEntryV1 | Promise<SyntheticAdmissionEntryV1>;
}>;

export type ResolveReviewedArtifactHandlerDependenciesV1 = Readonly<{
  deriveCallerContext(event: unknown): CallerContextV1 | null;
  fence: ReviewedResolveFenceV1;
  registry: ResolveRegistryV1;
  createCorrelationId(): string;
}>;

export type ResolveReviewedArtifactHandlerV1 = (
  event: unknown,
  request: unknown,
) => Promise<ResolveReviewedArtifactResultV1>;

type ExactRecord = Readonly<Record<string, unknown>>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const fallbackCorrelationId = "00000000-0000-4000-8000-000000000000";
const syntheticAdmissionReceiptClass = "synthetic_fixture_admission";
const syntheticAdmissionIssuerId = "aaw.main.fixture-registry/v1";

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ExactRecord | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.getOwnPropertyNames(descriptors).sort();
    const expected = [...expectedKeys].sort();
    if (
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function parseRequest(value: unknown): ResolveReviewedArtifactRequestV1 | null {
  const record = exactRecord(value, [
    "contractVersion",
    "documentRef",
    "artifactRef",
    "intent",
  ]);
  if (
    record === null ||
    record.contractVersion !== RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION ||
    record.intent !== "render"
  ) {
    return null;
  }
  try {
    return Object.freeze({
      contractVersion: RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION,
      documentRef: parseReviewedDocumentRefV1(record.documentRef),
      artifactRef: parseReviewedArtifactRefV1(record.artifactRef),
      intent: "render",
    });
  } catch (error: unknown) {
    if (error instanceof ReviewedIdentityError) return null;
    return null;
  }
}

function sameDocumentRef(
  left: ReviewedDocumentRefV1,
  right: ReviewedDocumentRefV1,
): boolean {
  return (
    left.documentId === right.documentId &&
    left.revisionId === right.revisionId &&
    left.documentKind === right.documentKind
  );
}

function sameArtifactRef(
  left: ReviewedArtifactRefV1,
  right: ReviewedArtifactRefV1,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.revisionId === right.revisionId &&
    left.artifactKind === right.artifactKind
  );
}

function correlationId(
  createCorrelationId: () => string,
): string {
  try {
    const value = createCorrelationId();
    return uuidPattern.test(value) ? value : fallbackCorrelationId;
  } catch {
    return fallbackCorrelationId;
  }
}

function safeError(
  code: ResolveReviewedArtifactErrorCodeV1,
  createCorrelationId: () => string,
): ResolveReviewedArtifactResultV1 {
  const messages: Readonly<Record<ResolveReviewedArtifactErrorCodeV1, string>> = {
    INVALID_REQUEST: "The reviewed artifact request is invalid.",
    CAPABILITY_DENIED: "The reviewed artifact capability is unavailable.",
    REVISION_UNAVAILABLE: "The exact reviewed artifact revision is unavailable.",
    PAYLOAD_TOO_LARGE: "The reviewed artifact payload is outside the approved limit.",
    INTERNAL: "The reviewed artifact is unavailable.",
  };
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code,
      message: messages[code],
      correlationId: correlationId(createCorrelationId),
      retryability: "never" as const,
      recoveryAction: "none" as const,
    }),
  });
}

function decisionError(
  decision: Exclude<ReviewedResolveFenceDecisionV1, "deliver">,
  createCorrelationId: () => string,
): ResolveReviewedArtifactResultV1 {
  return safeError(decision, createCorrelationId);
}

function translateLookupError(
  error: unknown,
  createCorrelationId: () => string,
): ResolveReviewedArtifactResultV1 {
  if (error instanceof ReviewedArtifactRegistryError) {
    return safeError(error.code, createCorrelationId);
  }
  let code: unknown;
  try {
    if (error !== null && typeof error === "object") {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (descriptor !== undefined && "value" in descriptor) code = descriptor.value;
    }
  } catch {
    code = undefined;
  }
  if (code === "INVALID_REQUEST") {
    return safeError("INVALID_REQUEST", createCorrelationId);
  }
  if (code === "REVISION_UNAVAILABLE") {
    return safeError("REVISION_UNAVAILABLE", createCorrelationId);
  }
  if (code === "PAYLOAD_TOO_LARGE") {
    return safeError("PAYLOAD_TOO_LARGE", createCorrelationId);
  }
  return safeError("INTERNAL", createCorrelationId);
}

function stableCircuitIr(
  entryValue: unknown,
  request: ResolveReviewedArtifactRequestV1,
): ReviewedCircuitIrV1 | null {
  const entry = exactRecord(entryValue, ["receipt", "providerState", "circuitIr"]);
  if (entry === null) return null;
  const receipt = exactRecord(entry.receipt, [
    "receiptClass",
    "issuerId",
    "receiptId",
    "documentRef",
    "artifactRef",
    "schemaVersion",
    "canonicalizationVersion",
    "payloadDigest",
    "fixtureManifestDigest",
  ]);
  const providerState = exactRecord(entry.providerState, [
    "status",
    "dirty",
    "documentRef",
    "artifactRef",
    "payloadDigest",
  ]);
  if (
    receipt === null ||
    providerState === null ||
    receipt.receiptClass !== syntheticAdmissionReceiptClass ||
    receipt.issuerId !== syntheticAdmissionIssuerId ||
    receipt.schemaVersion !== REVIEWED_CIRCUIT_IR_SCHEMA_VERSION ||
    receipt.canonicalizationVersion !==
      REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION ||
    typeof receipt.payloadDigest !== "string" ||
    !digestPattern.test(receipt.payloadDigest) ||
    typeof receipt.fixtureManifestDigest !== "string" ||
    !digestPattern.test(receipt.fixtureManifestDigest) ||
    providerState.status !== "ready" ||
    providerState.dirty !== false ||
    providerState.payloadDigest !== receipt.payloadDigest
  ) {
    return null;
  }

  try {
    const receiptDocumentRef = parseReviewedDocumentRefV1(receipt.documentRef);
    const receiptArtifactRef = parseReviewedArtifactRefV1(receipt.artifactRef);
    const providerDocumentRef = parseReviewedDocumentRefV1(providerState.documentRef);
    const providerArtifactRef = parseReviewedArtifactRefV1(providerState.artifactRef);
    if (
      !sameDocumentRef(receiptDocumentRef, request.documentRef) ||
      !sameArtifactRef(receiptArtifactRef, request.artifactRef) ||
      !sameDocumentRef(providerDocumentRef, request.documentRef) ||
      !sameArtifactRef(providerArtifactRef, request.artifactRef)
    ) {
      return null;
    }
    const circuitIr = validateReviewedCircuitIrV1(entry.circuitIr);
    if (sha256CanonicalAawJsonV1(circuitIr) !== receipt.payloadDigest) return null;
    return circuitIr;
  } catch {
    return null;
  }
}

export function createResolveReviewedArtifactHandlerV1(
  dependencies: ResolveReviewedArtifactHandlerDependenciesV1,
): ResolveReviewedArtifactHandlerV1 {
  return async (
    event: unknown,
    requestValue: unknown,
  ): Promise<ResolveReviewedArtifactResultV1> => {
    let caller: CallerContextV1 | null;
    try {
      caller = dependencies.deriveCallerContext(event);
    } catch {
      return safeError("CAPABILITY_DENIED", dependencies.createCorrelationId);
    }
    if (caller === null || !dependencies.fence.authorizeCaller(caller)) {
      return safeError("CAPABILITY_DENIED", dependencies.createCorrelationId);
    }

    const request = parseRequest(requestValue);
    if (request === null) {
      return safeError("INVALID_REQUEST", dependencies.createCorrelationId);
    }
    const lease = dependencies.fence.begin(caller, request);
    if (lease === null) {
      return safeError("CAPABILITY_DENIED", dependencies.createCorrelationId);
    }
    const beforeLookup = dependencies.fence.checkBeforeDelivery(lease);
    if (beforeLookup !== "deliver") {
      return decisionError(beforeLookup, dependencies.createCorrelationId);
    }

    let admitted: SyntheticAdmissionEntryV1;
    try {
      admitted = await dependencies.registry.resolveExact(
        Object.freeze({
          documentRef: request.documentRef,
          artifactRef: request.artifactRef,
        }),
      );
    } catch (error: unknown) {
      return translateLookupError(error, dependencies.createCorrelationId);
    }

    const afterLookup = dependencies.fence.checkBeforeDelivery(lease);
    if (afterLookup !== "deliver") {
      return decisionError(afterLookup, dependencies.createCorrelationId);
    }
    const circuitIr = stableCircuitIr(admitted, request);
    if (circuitIr === null) {
      return safeError("INTERNAL", dependencies.createCorrelationId);
    }

    let reviewedCircuitIr: ReviewedCircuitIrV1;
    try {
      reviewedCircuitIr = structuredClone(circuitIr) as ReviewedCircuitIrV1;
    } catch {
      return safeError("INTERNAL", dependencies.createCorrelationId);
    }
    const beforeDelivery = dependencies.fence.checkBeforeDelivery(lease);
    if (beforeDelivery !== "deliver") {
      return decisionError(beforeDelivery, dependencies.createCorrelationId);
    }

    return {
      ok: true,
      value: {
        contractVersion: RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION,
        documentRef: request.documentRef,
        artifactRef: request.artifactRef,
        freshness: "current",
        reviewedCircuitIr,
      },
    };
  };
}
