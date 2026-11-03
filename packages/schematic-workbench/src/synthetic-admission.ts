import {
  REVIEWED_ARTIFACT_KIND_V1,
  REVIEWED_DOCUMENT_KIND_V1,
  ReviewedIdentityError,
  createReviewedIdentityRegistryV1,
  parseReviewedArtifactRefV1,
  parseReviewedDocumentRefV1,
  type ReviewedArtifactRefV1,
  type ReviewedDocumentRefV1,
  type ReviewedIdentityBindingV1,
} from "../../document-contract/src/reviewed-identity";
import { sha256CanonicalAawJsonV1 } from "./canonical-json";
import {
  REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION,
  REVIEWED_CIRCUIT_IR_SCHEMA_VERSION,
  validateReviewedCircuitIrV1,
  type ReviewedCircuitIrV1,
} from "./reviewed-circuit-ir";
import {
  decodeAndHashStrictSourceFrameV1,
  StrictSourceFrameError,
  STRICT_SOURCE_FRAME_MAX_BYTES,
} from "./strict-source-frame";

export type {
  ReviewedArtifactRefV1,
  ReviewedDocumentRefV1,
} from "../../document-contract/src/reviewed-identity";

export const SYNTHETIC_FIXTURE_MANIFEST_SCHEMA_VERSION =
  "aaw.synthetic-fixture-manifest/v1alpha1" as const;
export const SYNTHETIC_FIXTURE_MANIFEST_ID =
  "aaw.synthetic.reviewed-fixtures/v1" as const;
export const SYNTHETIC_ADMISSION_RECEIPT_CLASS =
  "synthetic_fixture_admission" as const;
export const SYNTHETIC_ADMISSION_ISSUER_ID =
  "aaw.main.fixture-registry/v1" as const;
export const APPROVED_SYNTHETIC_FIXTURE_MANIFEST_SHA256 =
  "sha256:b446b2063c9c580dd4009f43759f42e02bba851dd8070b94ab76acb1f7282ff4" as const;

const SYNTHETIC_PROVENANCE = "hand-authored-synthetic" as const;
const SYNTHETIC_LICENSE = "CC0-1.0" as const;
const FORBIDDEN_REAL_DATA_ATTESTATION =
  "hand-authored; contains no real OA/PDK/netlist/reviewed/candidate data" as const;
const REQUIRED_OWNER_APPROVALS = Object.freeze([
  "reviewed-schematic-owner",
  "security-qa-owner",
] as const);

const MANIFEST_TOP_LEVEL_KEYS = [
  "schemaVersion",
  "canonicalizationVersion",
  "manifestId",
  "issuerId",
  "receiptClass",
  "entries",
] as const;
const CIRCUIT_IR_TOP_LEVEL_KEYS = [
  "schemaVersion",
  "canonicalizationVersion",
  "coordinateUnit",
  "bounds",
  "rootDefinitionId",
  "definitions",
] as const;
const FIXTURE_IDS = Object.freeze([
  "flat-basic",
  "repeated-hierarchy",
  "same-label-different-net",
  "blackbox-child",
  "explicit-port-mapping",
  "empty-minimum",
  "max-boundary",
  "unicode-labels",
] as const);

type SyntheticFixtureIdV1 = (typeof FIXTURE_IDS)[number];
type Sha256Digest = `sha256:${string}`;
type LimitOracleMode = "inline-small" | "generated-boundary";
type FixtureSpec = Readonly<{
  expectedSemanticOracleIds: readonly string[];
  limitOracleMode: LimitOracleMode;
}>;

const FIXTURE_SPECS: Readonly<Record<SyntheticFixtureIdV1, FixtureSpec>> =
  Object.freeze({
    "flat-basic": Object.freeze({
      expectedSemanticOracleIds: Object.freeze(["oracle.flat-net"]),
      limitOracleMode: "inline-small",
    }),
    "repeated-hierarchy": Object.freeze({
      expectedSemanticOracleIds: Object.freeze([
        "oracle.repeated-occurrence-paths",
      ]),
      limitOracleMode: "inline-small",
    }),
    "same-label-different-net": Object.freeze({
      expectedSemanticOracleIds: Object.freeze([
        "oracle.same-label-distinct-net",
      ]),
      limitOracleMode: "inline-small",
    }),
    "blackbox-child": Object.freeze({
      expectedSemanticOracleIds: Object.freeze([
        "oracle.blackbox-nonnavigable",
      ]),
      limitOracleMode: "inline-small",
    }),
    "explicit-port-mapping": Object.freeze({
      expectedSemanticOracleIds: Object.freeze([
        "oracle.parent-terminal-port-mapping",
      ]),
      limitOracleMode: "inline-small",
    }),
    "empty-minimum": Object.freeze({
      expectedSemanticOracleIds: Object.freeze(["oracle.empty-minimum"]),
      limitOracleMode: "inline-small",
    }),
    "max-boundary": Object.freeze({
      expectedSemanticOracleIds: Object.freeze([
        "oracle.generated-eight-mibibyte-boundary",
        "oracle.coordinate-max-boundary",
      ]),
      limitOracleMode: "generated-boundary",
    }),
    "unicode-labels": Object.freeze({
      expectedSemanticOracleIds: Object.freeze([
        "oracle.unicode-label-plain-text",
      ]),
      limitOracleMode: "inline-small",
    }),
  });

export type SyntheticReviewedAdmissionV1 = Readonly<{
  receiptClass: typeof SYNTHETIC_ADMISSION_RECEIPT_CLASS;
  issuerId: typeof SYNTHETIC_ADMISSION_ISSUER_ID;
  receiptId: string;
  documentRef: ReviewedDocumentRefV1;
  artifactRef: ReviewedArtifactRefV1;
  schemaVersion: typeof REVIEWED_CIRCUIT_IR_SCHEMA_VERSION;
  canonicalizationVersion: typeof REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION;
  payloadDigest: Sha256Digest;
  fixtureManifestDigest: Sha256Digest;
}>;

export type SyntheticReviewedProviderStateV1 = Readonly<{
  status: "ready";
  dirty: false;
  documentRef: ReviewedDocumentRefV1;
  artifactRef: ReviewedArtifactRefV1;
  payloadDigest: Sha256Digest;
}>;

export type SyntheticAdmissionEntryV1 = Readonly<{
  receipt: SyntheticReviewedAdmissionV1;
  providerState: SyntheticReviewedProviderStateV1;
  circuitIr: ReviewedCircuitIrV1;
}>;

export type SyntheticAdmissionInputV1 = Readonly<{
  fixtureId: string;
  rawFrame: Uint8Array;
}>;

export type SyntheticAdmissionErrorCode =
  | "INVALID_REQUEST"
  | "REVISION_UNAVAILABLE"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL";

export class SyntheticAdmissionError extends Error {
  readonly retryability = "never" as const;
  readonly recoveryAction = "none" as const;

  constructor(
    readonly code: SyntheticAdmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SyntheticAdmissionError";
  }
}

type ManifestCounts = Readonly<{
  definitions: number;
  entities: number;
  nets: number;
  references: number;
}>;
type ManifestLimitOracle = Readonly<{
  mode: LimitOracleMode;
  declaredBoundary: string;
}>;
type ApprovedManifestEntry = Readonly<{
  fixtureId: SyntheticFixtureIdV1;
  relativePath: string;
  byteLength: number;
  rawSha256: Sha256Digest;
  payloadDigest: Sha256Digest;
  binding: ReviewedIdentityBindingV1;
  receiptId: string;
  schemaVersion: typeof REVIEWED_CIRCUIT_IR_SCHEMA_VERSION;
  canonicalizationVersion: typeof REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION;
  provenance: typeof SYNTHETIC_PROVENANCE;
  license: typeof SYNTHETIC_LICENSE;
  issuerId: typeof SYNTHETIC_ADMISSION_ISSUER_ID;
  counts: ManifestCounts;
  limitOracle: ManifestLimitOracle;
  expectedSemanticOracleIds: readonly string[];
  forbiddenRealDataAttestation: typeof FORBIDDEN_REAL_DATA_ATTESTATION;
  ownerApprovals: readonly string[];
}>;
type ApprovedManifest = Readonly<{
  entries: readonly ApprovedManifestEntry[];
  digest: typeof APPROVED_SYNTHETIC_FIXTURE_MANIFEST_SHA256;
}>;

type ExactSnapshot = Readonly<Record<string, unknown>>;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const textEncoder = new TextEncoder();

function invalidRequest(message: string): never {
  throw new SyntheticAdmissionError("INVALID_REQUEST", message);
}

function unavailable(): never {
  throw new SyntheticAdmissionError(
    "REVISION_UNAVAILABLE",
    "The exact synthetic reviewed fixture revision is unavailable.",
  );
}

function internal(): never {
  throw new SyntheticAdmissionError(
    "INTERNAL",
    "The synthetic reviewed registry entry is quarantined.",
  );
}

function manifestInternal(): never {
  throw new SyntheticAdmissionError(
    "INTERNAL",
    "The build-owned synthetic fixture manifest is invalid.",
  );
}

function exactOuterSnapshot(
  value: unknown,
  expectedKeys: readonly string[],
): ExactSnapshot {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalidRequest("Synthetic admission input must be a plain object.");
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return invalidRequest("Synthetic admission input must be a plain object.");
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return invalidRequest("Synthetic admission input has an invalid property set.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Object.getOwnPropertyNames(descriptors).sort();
    const requiredKeys = [...expectedKeys].sort();
    if (
      actualKeys.length !== requiredKeys.length ||
      actualKeys.some((key, index) => key !== requiredKeys[index])
    ) {
      return invalidRequest("Synthetic admission input has an invalid property set.");
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of requiredKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return invalidRequest("Synthetic admission input has an invalid descriptor.");
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error: unknown) {
    if (error instanceof SyntheticAdmissionError) throw error;
    return invalidRequest("Synthetic admission input could not be safely snapshotted.");
  }
}

function exactManifestRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ExactSnapshot {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return manifestInternal();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      return manifestInternal();
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return manifestInternal();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Object.getOwnPropertyNames(descriptors).sort();
    const requiredKeys = [...expectedKeys].sort();
    if (
      actualKeys.length !== requiredKeys.length ||
      actualKeys.some((key, index) => key !== requiredKeys[index])
    ) {
      return manifestInternal();
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of requiredKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return manifestInternal();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error: unknown) {
    if (error instanceof SyntheticAdmissionError) throw error;
    return manifestInternal();
  }
}

function exactManifestArray(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return manifestInternal();
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return manifestInternal();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownNames = Object.getOwnPropertyNames(descriptors);
    const expectedNames = [
      ...Array.from({ length: value.length }, (_unused, index) => String(index)),
      "length",
    ];
    if (
      ownNames.length !== expectedNames.length ||
      ownNames.some((name) => !expectedNames.includes(name))
    ) {
      return manifestInternal();
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return manifestInternal();
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch (error: unknown) {
    if (error instanceof SyntheticAdmissionError) throw error;
    return manifestInternal();
  }
}

function manifestText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    textEncoder.encode(value).byteLength > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return manifestInternal();
  }
  return value;
}

function manifestDigest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    return manifestInternal();
  }
  return value as Sha256Digest;
}

function manifestInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    return manifestInternal();
  }
  return value;
}

function exactStringList(
  value: unknown,
  minimum: number,
  maximum: number,
): readonly string[] {
  const values = exactManifestArray(value);
  if (values.length < minimum || values.length > maximum) {
    return manifestInternal();
  }
  const result = values.map((entry) => manifestText(entry));
  if (new Set(result).size !== result.length) return manifestInternal();
  return Object.freeze(result);
}

function exactStringListEquals(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function documentKey(ref: ReviewedDocumentRefV1): string {
  return JSON.stringify([ref.documentId, ref.revisionId]);
}

function artifactKey(ref: ReviewedArtifactRefV1): string {
  return JSON.stringify([ref.artifactId, ref.revisionId]);
}

function parseManifestCounts(value: unknown): ManifestCounts {
  const record = exactManifestRecord(value, [
    "definitions",
    "entities",
    "nets",
    "references",
  ]);
  return Object.freeze({
    definitions: manifestInteger(record.definitions, 1, 4_096),
    entities: manifestInteger(record.entities, 0, 50_000),
    nets: manifestInteger(record.nets, 0, 50_000),
    references: manifestInteger(record.references, 0, 100_000),
  });
}

function parseLimitOracle(
  value: unknown,
  expectedMode: LimitOracleMode,
): ManifestLimitOracle {
  const record = exactManifestRecord(value, ["mode", "declaredBoundary"]);
  if (record.mode !== expectedMode) return manifestInternal();
  return Object.freeze({
    mode: expectedMode,
    declaredBoundary: manifestText(record.declaredBoundary),
  });
}

function parseCanonicalDocumentRef(value: unknown): ReviewedDocumentRefV1 {
  const record = exactManifestRecord(value, [
    "documentId",
    "revisionId",
    "documentKind",
  ]);
  try {
    return parseReviewedDocumentRefV1({
      documentId: record.documentId,
      revisionId: record.revisionId,
      documentKind: record.documentKind,
    });
  } catch {
    return manifestInternal();
  }
}

function parseCanonicalArtifactRef(value: unknown): ReviewedArtifactRefV1 {
  const record = exactManifestRecord(value, [
    "artifactId",
    "revisionId",
    "artifactKind",
  ]);
  try {
    return parseReviewedArtifactRefV1({
      artifactId: record.artifactId,
      revisionId: record.revisionId,
      artifactKind: record.artifactKind,
    });
  } catch {
    return manifestInternal();
  }
}

function parseApprovedManifest(rawManifestFrame: unknown): ApprovedManifest {
  let sourceFrame: ReturnType<typeof decodeAndHashStrictSourceFrameV1>;
  try {
    sourceFrame = decodeAndHashStrictSourceFrameV1(rawManifestFrame, {
      maxBytes: STRICT_SOURCE_FRAME_MAX_BYTES,
      allowedTopLevelKeys: MANIFEST_TOP_LEVEL_KEYS,
    });
  } catch {
    return manifestInternal();
  }
  if (
    sourceFrame.rawSha256 !== APPROVED_SYNTHETIC_FIXTURE_MANIFEST_SHA256
  ) {
    return manifestInternal();
  }
  const root = exactManifestRecord(
    sourceFrame.decoded,
    MANIFEST_TOP_LEVEL_KEYS,
  );
  if (
    root.schemaVersion !== SYNTHETIC_FIXTURE_MANIFEST_SCHEMA_VERSION ||
    root.canonicalizationVersion !==
      REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION ||
    root.manifestId !== SYNTHETIC_FIXTURE_MANIFEST_ID ||
    root.issuerId !== SYNTHETIC_ADMISSION_ISSUER_ID ||
    root.receiptClass !== SYNTHETIC_ADMISSION_RECEIPT_CLASS
  ) {
    return manifestInternal();
  }

  const rawEntries = exactManifestArray(root.entries);
  if (rawEntries.length !== FIXTURE_IDS.length) return manifestInternal();
  const identityRegistry = createReviewedIdentityRegistryV1();
  const seenDocumentKeys = new Set<string>();
  const seenArtifactKeys = new Set<string>();
  const entries: ApprovedManifestEntry[] = [];

  for (let index = 0; index < FIXTURE_IDS.length; index += 1) {
    const fixtureId = FIXTURE_IDS[index];
    const rawEntry = rawEntries[index];
    if (fixtureId === undefined || rawEntry === undefined) {
      return manifestInternal();
    }
    const spec = FIXTURE_SPECS[fixtureId];
    const record = exactManifestRecord(rawEntry, [
      "fixtureId",
      "relativePath",
      "byteLength",
      "rawSha256",
      "payloadDigest",
      "documentRef",
      "artifactRef",
      "receiptId",
      "schemaVersion",
      "canonicalizationVersion",
      "provenance",
      "license",
      "issuerId",
      "counts",
      "limitOracle",
      "expectedSemanticOracleIds",
      "forbiddenRealDataAttestation",
      "ownerApprovals",
    ]);
    if (record.fixtureId !== fixtureId) return manifestInternal();
    const relativePath = manifestText(record.relativePath);
    const receiptId = manifestText(record.receiptId);
    if (
      relativePath !==
        `packages/schematic-workbench/fixtures/${fixtureId}.json` ||
      receiptId !== `receipt.synthetic.${fixtureId}.v1` ||
      record.schemaVersion !== REVIEWED_CIRCUIT_IR_SCHEMA_VERSION ||
      record.canonicalizationVersion !==
        REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION ||
      record.provenance !== SYNTHETIC_PROVENANCE ||
      record.license !== SYNTHETIC_LICENSE ||
      record.issuerId !== SYNTHETIC_ADMISSION_ISSUER_ID ||
      record.forbiddenRealDataAttestation !== FORBIDDEN_REAL_DATA_ATTESTATION
    ) {
      return manifestInternal();
    }

    const documentRef = parseCanonicalDocumentRef(record.documentRef);
    const artifactRef = parseCanonicalArtifactRef(record.artifactRef);
    if (
      documentRef.documentId !== `synthetic.schematic.${fixtureId}` ||
      documentRef.revisionId !== "rev-1" ||
      documentRef.documentKind !== REVIEWED_DOCUMENT_KIND_V1 ||
      artifactRef.artifactId !== `synthetic.circuit-ir.${fixtureId}` ||
      artifactRef.revisionId !== "rev-1" ||
      artifactRef.artifactKind !== REVIEWED_ARTIFACT_KIND_V1
    ) {
      return manifestInternal();
    }
    const requestedDocumentKey = documentKey(documentRef);
    const requestedArtifactKey = artifactKey(artifactRef);
    if (
      seenDocumentKeys.has(requestedDocumentKey) ||
      seenArtifactKeys.has(requestedArtifactKey)
    ) {
      return manifestInternal();
    }
    seenDocumentKeys.add(requestedDocumentKey);
    seenArtifactKeys.add(requestedArtifactKey);

    let binding: ReviewedIdentityBindingV1;
    try {
      binding = identityRegistry.admitBinding({
        documentRef,
        artifactRef,
        freshness: "current",
      });
    } catch {
      return manifestInternal();
    }

    const expectedSemanticOracleIds = exactStringList(
      record.expectedSemanticOracleIds,
      1,
      64,
    );
    const ownerApprovals = exactStringList(record.ownerApprovals, 1, 8);
    if (
      !exactStringListEquals(
        expectedSemanticOracleIds,
        spec.expectedSemanticOracleIds,
      ) ||
      !exactStringListEquals(ownerApprovals, REQUIRED_OWNER_APPROVALS)
    ) {
      return manifestInternal();
    }

    entries.push(
      Object.freeze({
        fixtureId,
        relativePath,
        byteLength: manifestInteger(
          record.byteLength,
          1,
          STRICT_SOURCE_FRAME_MAX_BYTES,
        ),
        rawSha256: manifestDigest(record.rawSha256),
        payloadDigest: manifestDigest(record.payloadDigest),
        binding,
        receiptId,
        schemaVersion: REVIEWED_CIRCUIT_IR_SCHEMA_VERSION,
        canonicalizationVersion:
          REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION,
        provenance: SYNTHETIC_PROVENANCE,
        license: SYNTHETIC_LICENSE,
        issuerId: SYNTHETIC_ADMISSION_ISSUER_ID,
        counts: parseManifestCounts(record.counts),
        limitOracle: parseLimitOracle(
          record.limitOracle,
          spec.limitOracleMode,
        ),
        expectedSemanticOracleIds,
        forbiddenRealDataAttestation: FORBIDDEN_REAL_DATA_ATTESTATION,
        ownerApprovals,
      }),
    );
  }

  if (
    seenDocumentKeys.size !== FIXTURE_IDS.length ||
    seenArtifactKeys.size !== FIXTURE_IDS.length
  ) {
    return manifestInternal();
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    digest: APPROVED_SYNTHETIC_FIXTURE_MANIFEST_SHA256,
  });
}

function computeCircuitIrCounts(circuitIr: ReviewedCircuitIrV1): ManifestCounts {
  let entities = 0;
  let nets = 0;
  let references = 0;
  for (const definition of circuitIr.definitions) {
    const pins = definition.pins ?? [];
    entities +=
      definition.instances.length +
      definition.ports.length +
      pins.length +
      definition.nets.length +
      definition.wires.length +
      definition.labels.length;
    nets += definition.nets.length;
    references += definition.renderOrder.length;
    for (const instance of definition.instances) {
      if (instance.childDefinitionId !== undefined) references += 1;
      references += (instance.terminalMappings?.length ?? 0) * 3;
    }
    for (const port of definition.ports) {
      if (port.netId !== undefined) references += 1;
    }
    references += pins.length * 2;
    for (const net of definition.nets) {
      references += net.memberElementIds.length;
    }
    for (const wire of definition.wires) {
      references += 1;
      entities += wire.points?.length ?? 0;
    }
    for (const label of definition.labels) {
      if (label.targetElementId !== undefined) references += 1;
    }
  }
  return Object.freeze({
    definitions: circuitIr.definitions.length,
    entities,
    nets,
    references,
  });
}

function countsEqual(left: ManifestCounts, right: ManifestCounts): boolean {
  return (
    left.definitions === right.definitions &&
    left.entities === right.entities &&
    left.nets === right.nets &&
    left.references === right.references
  );
}

function fixtureIdFromRequest(value: unknown): SyntheticFixtureIdV1 {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    textEncoder.encode(value).byteLength > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return invalidRequest("fixtureId is outside the approved request contract.");
  }
  if (!FIXTURE_IDS.includes(value as SyntheticFixtureIdV1)) return unavailable();
  return value as SyntheticFixtureIdV1;
}

function translateIdentityError(error: unknown): never {
  if (error instanceof ReviewedIdentityError) {
    if (error.code === "INVALID_REQUEST") {
      return invalidRequest("The reviewed identity request is invalid.");
    }
    if (error.code === "REVISION_UNAVAILABLE") return unavailable();
  }
  return internal();
}

export type SyntheticAdmissionRegistryV1 = Readonly<{
  admit(input: unknown): SyntheticAdmissionEntryV1;
  resolveByDocument(documentRef: unknown): SyntheticAdmissionEntryV1;
  resolveByArtifact(artifactRef: unknown): SyntheticAdmissionEntryV1;
  size(): number;
}>;

export function createSyntheticAdmissionRegistryV1(
  rawManifestFrame: unknown,
): SyntheticAdmissionRegistryV1 {
  const manifest = parseApprovedManifest(rawManifestFrame);
  const identityRegistry = createReviewedIdentityRegistryV1();
  const manifestByFixture = new Map<
    SyntheticFixtureIdV1,
    ApprovedManifestEntry
  >();
  for (const manifestEntry of manifest.entries) {
    let binding: ReviewedIdentityBindingV1;
    try {
      binding = identityRegistry.admitBinding({
        documentRef: manifestEntry.binding.documentRef,
        artifactRef: manifestEntry.binding.artifactRef,
        freshness: manifestEntry.binding.freshness,
      });
    } catch {
      return manifestInternal();
    }
    manifestByFixture.set(
      manifestEntry.fixtureId,
      Object.freeze({ ...manifestEntry, binding }),
    );
  }

  const byFixture = new Map<SyntheticFixtureIdV1, SyntheticAdmissionEntryV1>();
  const byDocument = new Map<string, SyntheticAdmissionEntryV1>();
  const byArtifact = new Map<string, SyntheticAdmissionEntryV1>();
  const quarantinedFixtures = new Set<SyntheticFixtureIdV1>();
  const quarantinedDocuments = new Set<string>();
  const quarantinedArtifacts = new Set<string>();

  const quarantine = (manifestEntry: ApprovedManifestEntry): void => {
    quarantinedFixtures.add(manifestEntry.fixtureId);
    quarantinedDocuments.add(documentKey(manifestEntry.binding.documentRef));
    quarantinedArtifacts.add(artifactKey(manifestEntry.binding.artifactRef));
  };

  const quarantineAndInternal = (manifestEntry: ApprovedManifestEntry): never => {
    quarantine(manifestEntry);
    return internal();
  };

  const admit = (inputValue: unknown): SyntheticAdmissionEntryV1 => {
    const input = exactOuterSnapshot(inputValue, ["fixtureId", "rawFrame"]);
    const fixtureId = fixtureIdFromRequest(input.fixtureId);
    const manifestEntry = manifestByFixture.get(fixtureId);
    if (manifestEntry === undefined) return unavailable();
    if (quarantinedFixtures.has(fixtureId)) return internal();

    let sourceFrame: ReturnType<typeof decodeAndHashStrictSourceFrameV1>;
    try {
      sourceFrame = decodeAndHashStrictSourceFrameV1(input.rawFrame, {
        maxBytes: STRICT_SOURCE_FRAME_MAX_BYTES,
        allowedTopLevelKeys: CIRCUIT_IR_TOP_LEVEL_KEYS,
      });
    } catch (error: unknown) {
      if (error instanceof StrictSourceFrameError) {
        if (error.code === "PAYLOAD_TOO_LARGE") {
          quarantine(manifestEntry);
          throw new SyntheticAdmissionError(
            "PAYLOAD_TOO_LARGE",
            "The synthetic source frame exceeds the approved byte limit.",
          );
        }
        if (error.code === "INVALID_FRAME") {
          return invalidRequest(
            "rawFrame must be a bounded standard Uint8Array with private backing.",
          );
        }
      }
      return quarantineAndInternal(manifestEntry);
    }
    if (
      sourceFrame.byteLength !== manifestEntry.byteLength ||
      sourceFrame.rawSha256 !== manifestEntry.rawSha256
    ) {
      return quarantineAndInternal(manifestEntry);
    }

    let circuitIr: ReviewedCircuitIrV1;
    let payloadDigestBeforeValidation: Sha256Digest;
    let payloadDigestAfterValidation: Sha256Digest;
    try {
      const decoded = sourceFrame.decoded;
      if (
        decoded.schemaVersion !== manifestEntry.schemaVersion ||
        decoded.canonicalizationVersion !==
          manifestEntry.canonicalizationVersion
      ) {
        return quarantineAndInternal(manifestEntry);
      }
      circuitIr = validateReviewedCircuitIrV1(decoded);
      payloadDigestBeforeValidation = sha256CanonicalAawJsonV1(decoded);
      payloadDigestAfterValidation = sha256CanonicalAawJsonV1(circuitIr);
    } catch {
      return quarantineAndInternal(manifestEntry);
    }
    if (
      payloadDigestBeforeValidation !== manifestEntry.payloadDigest ||
      payloadDigestAfterValidation !== manifestEntry.payloadDigest ||
      !countsEqual(computeCircuitIrCounts(circuitIr), manifestEntry.counts)
    ) {
      return quarantineAndInternal(manifestEntry);
    }

    const documentIdentity = documentKey(manifestEntry.binding.documentRef);
    const artifactIdentity = artifactKey(manifestEntry.binding.artifactRef);
    const existingByFixture = byFixture.get(fixtureId);
    const existingByDocument = byDocument.get(documentIdentity);
    const existingByArtifact = byArtifact.get(artifactIdentity);
    if (existingByFixture !== undefined) {
      if (
        existingByDocument === existingByFixture &&
        existingByArtifact === existingByFixture &&
        existingByFixture.receipt.payloadDigest === manifestEntry.payloadDigest &&
        existingByFixture.receipt.fixtureManifestDigest === manifest.digest &&
        existingByFixture.receipt.schemaVersion === manifestEntry.schemaVersion &&
        existingByFixture.receipt.canonicalizationVersion ===
          manifestEntry.canonicalizationVersion
      ) {
        return existingByFixture;
      }
      return quarantineAndInternal(manifestEntry);
    }
    if (existingByDocument !== undefined || existingByArtifact !== undefined) {
      return quarantineAndInternal(manifestEntry);
    }

    const receipt: SyntheticReviewedAdmissionV1 = Object.freeze({
      receiptClass: SYNTHETIC_ADMISSION_RECEIPT_CLASS,
      issuerId: manifestEntry.issuerId,
      receiptId: manifestEntry.receiptId,
      documentRef: manifestEntry.binding.documentRef,
      artifactRef: manifestEntry.binding.artifactRef,
      schemaVersion: manifestEntry.schemaVersion,
      canonicalizationVersion: manifestEntry.canonicalizationVersion,
      payloadDigest: manifestEntry.payloadDigest,
      fixtureManifestDigest: manifest.digest,
    });
    const providerState: SyntheticReviewedProviderStateV1 = Object.freeze({
      status: "ready",
      dirty: false,
      documentRef: manifestEntry.binding.documentRef,
      artifactRef: manifestEntry.binding.artifactRef,
      payloadDigest: manifestEntry.payloadDigest,
    });
    const admittedEntry: SyntheticAdmissionEntryV1 = Object.freeze({
      receipt,
      providerState,
      circuitIr,
    });
    byFixture.set(fixtureId, admittedEntry);
    byDocument.set(documentIdentity, admittedEntry);
    byArtifact.set(artifactIdentity, admittedEntry);
    return admittedEntry;
  };

  return Object.freeze({
    admit,
    resolveByDocument(documentRefValue: unknown): SyntheticAdmissionEntryV1 {
      let binding: ReviewedIdentityBindingV1;
      try {
        binding = identityRegistry.resolveByDocument(documentRefValue);
      } catch (error: unknown) {
        return translateIdentityError(error);
      }
      const key = documentKey(binding.documentRef);
      if (
        quarantinedDocuments.has(key) ||
        quarantinedArtifacts.has(artifactKey(binding.artifactRef))
      ) {
        return internal();
      }
      return byDocument.get(key) ?? unavailable();
    },
    resolveByArtifact(artifactRefValue: unknown): SyntheticAdmissionEntryV1 {
      let binding: ReviewedIdentityBindingV1;
      try {
        binding = identityRegistry.resolveByArtifact(artifactRefValue);
      } catch (error: unknown) {
        return translateIdentityError(error);
      }
      const key = artifactKey(binding.artifactRef);
      if (
        quarantinedArtifacts.has(key) ||
        quarantinedDocuments.has(documentKey(binding.documentRef))
      ) {
        return internal();
      }
      return byArtifact.get(key) ?? unavailable();
    },
    size: (): number => byFixture.size,
  });
}
