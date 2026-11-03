export const REVIEWED_DOCUMENT_KIND_V1 = "schematic_reviewed" as const;
export const REVIEWED_ARTIFACT_KIND_V1 = "circuit_ir_reviewed" as const;
export const REVIEWED_IDENTITY_COMPONENT_MAX_UTF8_BYTES_V1 = 128;
export const REVIEWED_IDENTITY_COMPONENT_PATTERN_V1 =
  "^(?!latest$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" as const;

export type ReviewedDocumentRefV1 = Readonly<{
  documentId: string;
  revisionId: string;
  documentKind: typeof REVIEWED_DOCUMENT_KIND_V1;
}>;

export type ReviewedArtifactRefV1 = Readonly<{
  artifactId: string;
  revisionId: string;
  artifactKind: typeof REVIEWED_ARTIFACT_KIND_V1;
}>;

export type ReviewedRevisionFreshnessV1 = "current" | "historical";

export type ReviewedIdentityBindingV1 = Readonly<{
  documentRef: ReviewedDocumentRefV1;
  artifactRef: ReviewedArtifactRefV1;
  freshness: ReviewedRevisionFreshnessV1;
}>;

export type ReviewedIdentityErrorCodeV1 =
  | "INVALID_REQUEST"
  | "REVISION_UNAVAILABLE"
  | "INTERNAL";

export class ReviewedIdentityError extends Error {
  readonly retryability = "never" as const;
  readonly recoveryAction = "none" as const;

  constructor(
    readonly code: ReviewedIdentityErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "ReviewedIdentityError";
  }
}

export type ReviewedIdentityRegistryV1 = Readonly<{
  admitBinding(input: unknown): ReviewedIdentityBindingV1;
  resolveByDocument(documentRef: unknown): ReviewedIdentityBindingV1;
  resolveByArtifact(artifactRef: unknown): ReviewedIdentityBindingV1;
}>;

const utf8Encoder = new TextEncoder();
const identityComponentPattern = new RegExp(
  REVIEWED_IDENTITY_COMPONENT_PATTERN_V1,
  "u",
);

type ExactObjectSnapshot = Readonly<Record<string, unknown>>;

function failInvalidRequest(message: string): never {
  throw new ReviewedIdentityError("INVALID_REQUEST", message);
}

function exactObjectSnapshot(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): ExactObjectSnapshot {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return failInvalidRequest(`${label} must be an object`);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype) {
      return failInvalidRequest(`${label} must be a plain object`);
    }

    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return failInvalidRequest(`${label} contains unsupported properties`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Object.getOwnPropertyNames(descriptors).sort();
    const requiredKeys = [...expectedKeys].sort();

    if (
      actualKeys.length !== requiredKeys.length ||
      actualKeys.some((key, index) => key !== requiredKeys[index])
    ) {
      return failInvalidRequest(`${label} has an invalid property set`);
    }

    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of requiredKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return failInvalidRequest(`${label}.${key} must be a data property`);
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof ReviewedIdentityError) throw error;
    return failInvalidRequest(`${label} could not be validated`);
  }
}

function identityComponent(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Encoder.encode(value).byteLength >
      REVIEWED_IDENTITY_COMPONENT_MAX_UTF8_BYTES_V1 ||
    !identityComponentPattern.test(value)
  ) {
    return failInvalidRequest(`${label} is outside the reviewed identity alphabet`);
  }
  return value;
}

function revisionComponent(value: unknown, label: string): string {
  return identityComponent(value, label);
}

export function parseReviewedDocumentRefV1(
  value: unknown,
): ReviewedDocumentRefV1 {
  const input = exactObjectSnapshot(
    value,
    ["documentId", "revisionId", "documentKind"],
    "documentRef",
  );
  if (input.documentKind !== REVIEWED_DOCUMENT_KIND_V1) {
    return failInvalidRequest("documentRef.documentKind is invalid");
  }
  return Object.freeze({
    documentId: identityComponent(input.documentId, "documentRef.documentId"),
    revisionId: revisionComponent(
      input.revisionId,
      "documentRef.revisionId",
    ),
    documentKind: REVIEWED_DOCUMENT_KIND_V1,
  });
}

export function parseReviewedArtifactRefV1(
  value: unknown,
): ReviewedArtifactRefV1 {
  const input = exactObjectSnapshot(
    value,
    ["artifactId", "revisionId", "artifactKind"],
    "artifactRef",
  );
  if (input.artifactKind !== REVIEWED_ARTIFACT_KIND_V1) {
    return failInvalidRequest("artifactRef.artifactKind is invalid");
  }
  return Object.freeze({
    artifactId: identityComponent(input.artifactId, "artifactRef.artifactId"),
    revisionId: revisionComponent(
      input.revisionId,
      "artifactRef.revisionId",
    ),
    artifactKind: REVIEWED_ARTIFACT_KIND_V1,
  });
}

function documentKey(ref: ReviewedDocumentRefV1): string {
  return JSON.stringify([ref.documentId, ref.revisionId]);
}

function artifactKey(ref: ReviewedArtifactRefV1): string {
  return JSON.stringify([ref.artifactId, ref.revisionId]);
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

function immutableBinding(
  documentRef: ReviewedDocumentRefV1,
  artifactRef: ReviewedArtifactRefV1,
  freshness: ReviewedRevisionFreshnessV1,
): ReviewedIdentityBindingV1 {
  return Object.freeze({ documentRef, artifactRef, freshness });
}

function unavailable(): never {
  throw new ReviewedIdentityError(
    "REVISION_UNAVAILABLE",
    "The exact reviewed revision is unavailable",
  );
}

function internal(): never {
  throw new ReviewedIdentityError(
    "INTERNAL",
    "The reviewed identity registry entry is quarantined",
  );
}

export function createReviewedIdentityRegistryV1(): ReviewedIdentityRegistryV1 {
  const byDocument = new Map<string, ReviewedIdentityBindingV1>();
  const byArtifact = new Map<string, ReviewedIdentityBindingV1>();
  const currentByDocumentId = new Map<string, ReviewedIdentityBindingV1>();
  const quarantinedDocuments = new Set<string>();
  const quarantinedArtifacts = new Set<string>();

  function quarantineConflict(
    requestedDocumentKey: string,
    requestedArtifactKey: string,
    existingBindings: readonly (
      | ReviewedIdentityBindingV1
      | undefined
    )[],
  ): never {
    quarantinedDocuments.add(requestedDocumentKey);
    quarantinedArtifacts.add(requestedArtifactKey);

    for (const binding of existingBindings) {
      if (binding !== undefined) {
        quarantinedDocuments.add(documentKey(binding.documentRef));
        quarantinedArtifacts.add(artifactKey(binding.artifactRef));
      }
    }

    return internal();
  }

  function admitBinding(inputValue: unknown): ReviewedIdentityBindingV1 {
    const input = exactObjectSnapshot(
      inputValue,
      ["documentRef", "artifactRef", "freshness"],
      "binding",
    );
    const documentRef = parseReviewedDocumentRefV1(input.documentRef);
    const artifactRef = parseReviewedArtifactRefV1(input.artifactRef);
    if (input.freshness !== "current" && input.freshness !== "historical") {
      return failInvalidRequest("binding.freshness is invalid");
    }

    const requestedDocumentKey = documentKey(documentRef);
    const requestedArtifactKey = artifactKey(artifactRef);
    if (
      quarantinedDocuments.has(requestedDocumentKey) ||
      quarantinedArtifacts.has(requestedArtifactKey)
    ) {
      return internal();
    }

    const existingByDocument = byDocument.get(requestedDocumentKey);
    const existingByArtifact = byArtifact.get(requestedArtifactKey);
    const existingCurrent =
      input.freshness === "current"
        ? currentByDocumentId.get(documentRef.documentId)
        : undefined;

    if (existingByDocument !== undefined || existingByArtifact !== undefined) {
      if (
        existingByDocument !== undefined &&
        existingByArtifact !== undefined &&
        existingByDocument === existingByArtifact &&
        sameDocumentRef(existingByDocument.documentRef, documentRef) &&
        sameArtifactRef(existingByDocument.artifactRef, artifactRef) &&
        existingByDocument.freshness === input.freshness &&
        (input.freshness === "historical" ||
          existingCurrent === existingByDocument)
      ) {
        // Exact replay includes the main-owned freshness classification. It is
        // idempotent and cannot mutate the stored binding.
        return existingByDocument;
      }

      return quarantineConflict(
        requestedDocumentKey,
        requestedArtifactKey,
        [existingByDocument, existingByArtifact, existingCurrent],
      );
    }

    if (existingCurrent !== undefined) {
      return quarantineConflict(
        requestedDocumentKey,
        requestedArtifactKey,
        [existingCurrent],
      );
    }

    const binding = immutableBinding(
      documentRef,
      artifactRef,
      input.freshness,
    );
    byDocument.set(requestedDocumentKey, binding);
    byArtifact.set(requestedArtifactKey, binding);
    if (binding.freshness === "current") {
      currentByDocumentId.set(binding.documentRef.documentId, binding);
    }
    return binding;
  }

  function resolveByDocument(
    documentRefValue: unknown,
  ): ReviewedIdentityBindingV1 {
    const ref = parseReviewedDocumentRefV1(documentRefValue);
    const key = documentKey(ref);
    if (quarantinedDocuments.has(key)) return internal();
    return byDocument.get(key) ?? unavailable();
  }

  function resolveByArtifact(
    artifactRefValue: unknown,
  ): ReviewedIdentityBindingV1 {
    const ref = parseReviewedArtifactRefV1(artifactRefValue);
    const key = artifactKey(ref);
    if (quarantinedArtifacts.has(key)) return internal();
    return byArtifact.get(key) ?? unavailable();
  }

  return Object.freeze({
    admitBinding,
    resolveByDocument,
    resolveByArtifact,
  });
}
