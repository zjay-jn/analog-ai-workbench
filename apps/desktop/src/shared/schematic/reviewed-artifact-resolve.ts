export const RESOLVE_REVIEWED_ARTIFACT_CHANNEL =
  "workbench.schematic.resolveReviewedArtifact.v1" as const;
export const RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION =
  "workbench.schematic.resolveReviewedArtifact.v1" as const;

export const RESOLVE_REVIEWED_ARTIFACT_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "CAPABILITY_DENIED",
  "REVISION_UNAVAILABLE",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL",
] as const);

export type ResolveReviewedArtifactErrorCodeV1 =
  (typeof RESOLVE_REVIEWED_ARTIFACT_ERROR_CODES)[number];

export interface ReviewedDocumentRefDtoV1 {
  readonly documentId: string;
  readonly revisionId: string;
  readonly documentKind: "schematic_reviewed";
}

export interface ReviewedArtifactRefDtoV1 {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly artifactKind: "circuit_ir_reviewed";
}

export interface ResolveReviewedArtifactRequestV1 {
  readonly contractVersion: typeof RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION;
  readonly documentRef: ReviewedDocumentRefDtoV1;
  readonly artifactRef: ReviewedArtifactRefDtoV1;
  readonly intent: "render";
}

export interface ResolvedReviewedArtifactV1 {
  readonly contractVersion: typeof RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION;
  readonly documentRef: ReviewedDocumentRefDtoV1;
  readonly artifactRef: ReviewedArtifactRefDtoV1;
  readonly freshness: "current" | "historical";
  readonly reviewedCircuitIr: unknown;
}

export interface ResolveReviewedArtifactSafeErrorV1 {
  readonly code: ResolveReviewedArtifactErrorCodeV1;
  readonly message: string;
  readonly correlationId: string;
  readonly retryability: "never";
  readonly recoveryAction: "none";
}

export type ResolveReviewedArtifactResultV1 =
  | { readonly ok: true; readonly value: ResolvedReviewedArtifactV1 }
  | { readonly ok: false; readonly error: ResolveReviewedArtifactSafeErrorV1 };

const identityComponentSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^(?!latest$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
} as const;

const reviewedDocumentRefSchema = {
  type: "object",
  properties: {
    documentId: identityComponentSchema,
    revisionId: identityComponentSchema,
    documentKind: { const: "schematic_reviewed" },
  },
  required: ["documentId", "revisionId", "documentKind"],
  additionalProperties: false,
} as const;

const reviewedArtifactRefSchema = {
  type: "object",
  properties: {
    artifactId: identityComponentSchema,
    revisionId: identityComponentSchema,
    artifactKind: { const: "circuit_ir_reviewed" },
  },
  required: ["artifactId", "revisionId", "artifactKind"],
  additionalProperties: false,
} as const;

export const resolveReviewedArtifactRequestSchema = {
  $id: "workbench.schematic.resolveReviewedArtifact.v1.request",
  type: "object",
  properties: {
    contractVersion: { const: RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION },
    documentRef: reviewedDocumentRefSchema,
    artifactRef: reviewedArtifactRefSchema,
    intent: { const: "render" },
  },
  required: ["contractVersion", "documentRef", "artifactRef", "intent"],
  additionalProperties: false,
} as const;

export const resolveReviewedArtifactResultSchema = {
  $id: "workbench.schematic.resolveReviewedArtifact.v1.result",
  oneOf: [
    {
      type: "object",
      properties: {
        ok: { const: true },
        value: {
          type: "object",
          properties: {
            contractVersion: {
              const: RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION,
            },
            documentRef: reviewedDocumentRefSchema,
            artifactRef: reviewedArtifactRefSchema,
            freshness: { enum: ["current", "historical"] },
            reviewedCircuitIr: { type: "object" },
          },
          required: [
            "contractVersion",
            "documentRef",
            "artifactRef",
            "freshness",
            "reviewedCircuitIr",
          ],
          additionalProperties: false,
        },
      },
      required: ["ok", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ok: { const: false },
        error: {
          type: "object",
          properties: {
            code: { enum: RESOLVE_REVIEWED_ARTIFACT_ERROR_CODES },
            message: { type: "string", minLength: 1, maxLength: 160 },
            correlationId: { type: "string", format: "uuid" },
            retryability: { const: "never" },
            recoveryAction: { const: "none" },
          },
          required: [
            "code",
            "message",
            "correlationId",
            "retryability",
            "recoveryAction",
          ],
          additionalProperties: false,
        },
      },
      required: ["ok", "error"],
      additionalProperties: false,
    },
  ],
} as const;
