import {
  ReviewedIdentityError,
  parseReviewedArtifactRefV1,
  parseReviewedDocumentRefV1,
  type ReviewedArtifactRefV1,
  type ReviewedDocumentRefV1,
} from "../../../../../packages/document-contract/src/reviewed-identity";
import type {
  SyntheticAdmissionEntryV1,
  SyntheticAdmissionRegistryV1,
} from "../../../../../packages/schematic-workbench/src/synthetic-admission";
import { types as nodeTypes } from "node:util";

export type ReviewedArtifactRegistryErrorCodeV1 =
  | "INVALID_REQUEST"
  | "REVISION_UNAVAILABLE"
  | "INTERNAL";

export class ReviewedArtifactRegistryError extends Error {
  readonly retryability = "never" as const;
  readonly recoveryAction = "none" as const;

  constructor(
    readonly code: ReviewedArtifactRegistryErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "ReviewedArtifactRegistryError";
  }
}

export type ReviewedArtifactLookupV1 = Readonly<{
  documentRef: ReviewedDocumentRefV1;
  artifactRef: ReviewedArtifactRefV1;
}>;

export type ReviewedArtifactRegistryV1 = Readonly<{
  mode: "production" | "development";
  size(): number;
  fixtureIds(): readonly string[];
  snapshot(): readonly SyntheticAdmissionEntryV1[];
  resolveExact(input: unknown): SyntheticAdmissionEntryV1;
}>;

type ExactRecord = Readonly<Record<string, unknown>>;

function registryError(
  code: ReviewedArtifactRegistryErrorCodeV1,
  message: string,
): never {
  throw new ReviewedArtifactRegistryError(code, message);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ExactRecord {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return registryError("INVALID_REQUEST", "The reviewed artifact lookup is invalid.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Object.getOwnPropertyNames(descriptors).sort();
    const requiredKeys = [...expectedKeys].sort();
    if (
      actualKeys.length !== requiredKeys.length ||
      actualKeys.some((key, index) => key !== requiredKeys[index])
    ) {
      return registryError("INVALID_REQUEST", "The reviewed artifact lookup is invalid.");
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of requiredKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return registryError("INVALID_REQUEST", "The reviewed artifact lookup is invalid.");
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error: unknown) {
    if (error instanceof ReviewedArtifactRegistryError) throw error;
    return registryError("INVALID_REQUEST", "The reviewed artifact lookup is invalid.");
  }
}

function parseLookup(value: unknown): ReviewedArtifactLookupV1 {
  const record = exactRecord(value, ["documentRef", "artifactRef"]);
  try {
    return Object.freeze({
      documentRef: parseReviewedDocumentRefV1(record.documentRef),
      artifactRef: parseReviewedArtifactRefV1(record.artifactRef),
    });
  } catch (error: unknown) {
    if (error instanceof ReviewedIdentityError) {
      return registryError("INVALID_REQUEST", "The reviewed artifact lookup is invalid.");
    }
    return registryError("INVALID_REQUEST", "The reviewed artifact lookup is invalid.");
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

function translateAdmissionError(error: unknown): never {
  let code: unknown;
  try {
    if (error !== null && typeof error === "object") {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (descriptor !== undefined && "value" in descriptor) code = descriptor.value;
    }
  } catch {
    code = undefined;
  }
  if (code === "REVISION_UNAVAILABLE") {
    return registryError(
      "REVISION_UNAVAILABLE",
      "The exact reviewed artifact revision is unavailable.",
    );
  }
  if (code === "INVALID_REQUEST") {
    return registryError("INVALID_REQUEST", "The reviewed artifact lookup is invalid.");
  }
  return registryError("INTERNAL", "The reviewed artifact registry is unavailable.");
}

const emptyFixtureIds = Object.freeze([]) as readonly string[];
const emptySnapshot = Object.freeze([]) as readonly SyntheticAdmissionEntryV1[];

export function createProductionReviewedArtifactRegistryV1(): ReviewedArtifactRegistryV1 {
  return Object.freeze({
    mode: "production" as const,
    size: (): number => 0,
    fixtureIds: (): readonly string[] => emptyFixtureIds,
    snapshot: (): readonly SyntheticAdmissionEntryV1[] => emptySnapshot,
    resolveExact(input: unknown): SyntheticAdmissionEntryV1 {
      parseLookup(input);
      return registryError(
        "REVISION_UNAVAILABLE",
        "The exact reviewed artifact revision is unavailable.",
      );
    },
  });
}

export function createDevelopmentReviewedArtifactSnapshotRegistryV1(input: {
  readonly fixtureId: "flat-basic";
  readonly admissionRegistry: SyntheticAdmissionRegistryV1;
  readonly entry: SyntheticAdmissionEntryV1;
}): ReviewedArtifactRegistryV1 {
  const { fixtureId, admissionRegistry, entry } = input;
  let byDocument: SyntheticAdmissionEntryV1;
  let byArtifact: SyntheticAdmissionEntryV1;
  try {
    byDocument = admissionRegistry.resolveByDocument(entry.receipt.documentRef);
    byArtifact = admissionRegistry.resolveByArtifact(entry.receipt.artifactRef);
  } catch (error: unknown) {
    return translateAdmissionError(error);
  }
  if (
    byDocument !== entry ||
    byArtifact !== entry ||
    !sameDocumentRef(entry.receipt.documentRef, entry.providerState.documentRef) ||
    !sameArtifactRef(entry.receipt.artifactRef, entry.providerState.artifactRef) ||
    entry.receipt.payloadDigest !== entry.providerState.payloadDigest ||
    entry.providerState.dirty !== false
  ) {
    return registryError("INTERNAL", "The reviewed artifact registry is unavailable.");
  }

  const fixtureIds = Object.freeze([fixtureId]) as readonly string[];
  const registrySnapshot = Object.freeze([entry]) as readonly SyntheticAdmissionEntryV1[];

  return Object.freeze({
    mode: "development" as const,
    size: (): number => 1,
    fixtureIds: (): readonly string[] => fixtureIds,
    snapshot: (): readonly SyntheticAdmissionEntryV1[] => registrySnapshot,
    resolveExact(value: unknown): SyntheticAdmissionEntryV1 {
      const lookup = parseLookup(value);
      let resolvedByDocument: SyntheticAdmissionEntryV1;
      let resolvedByArtifact: SyntheticAdmissionEntryV1;
      try {
        resolvedByDocument = admissionRegistry.resolveByDocument(lookup.documentRef);
        resolvedByArtifact = admissionRegistry.resolveByArtifact(lookup.artifactRef);
      } catch (error: unknown) {
        return translateAdmissionError(error);
      }
      if (
        resolvedByDocument !== entry ||
        resolvedByArtifact !== entry ||
        resolvedByDocument !== resolvedByArtifact ||
        !sameDocumentRef(lookup.documentRef, entry.receipt.documentRef) ||
        !sameArtifactRef(lookup.artifactRef, entry.receipt.artifactRef)
      ) {
        return registryError(
          "REVISION_UNAVAILABLE",
          "The exact reviewed artifact revision is unavailable.",
        );
      }
      return entry;
    },
  });
}
