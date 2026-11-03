import {
  parseReviewedDocumentRefV1,
  REVIEWED_ARTIFACT_KIND_V1,
  REVIEWED_DOCUMENT_KIND_V1,
} from "../../document-contract/src/reviewed-identity";
import {
  AgentContractError,
  type AgentContractErrorCodeV1,
  type CitationLocatorV1,
  type CitationSourceV1,
  parseCitationLocatorV1,
  parseCitationSourceV1,
} from "./agent-contract";

export const AGENT_PUBLIC_RESOLVE_CONTRACT_VERSION_V1 =
  "aaw.agent.resolve/v1alpha1" as const;
export const CITATION_PREVIEW_MAX_CODE_POINTS_V1 = 512;
export const CITATION_PREVIEW_MAX_UTF8_BYTES_V1 = 2_048;
export const ARTIFACT_KINDS_V1 = Object.freeze([
  REVIEWED_ARTIFACT_KIND_V1,
  "generic",
] as const);
export type ArtifactKindV1 = (typeof ARTIFACT_KINDS_V1)[number];

export type DocumentRefV1 = Readonly<{
  documentId: string;
  revisionId: string;
  documentKind: "text" | typeof REVIEWED_DOCUMENT_KIND_V1;
}>;

export type ArtifactRefV1 = Readonly<{
  artifactId: string;
  revisionId: string;
  artifactKind: ArtifactKindV1;
}>;

export type CitationPreviewV1 = Readonly<{
  text: string;
  truncated: boolean;
  authority: "non_authoritative";
}>;

export type CitationRefV1 = Readonly<{
  citationId: string;
  source: CitationSourceV1;
  locator: CitationLocatorV1;
  authorityStatus: "authoritative" | "non_authoritative";
  verificationStatus: "unverified" | "verified" | "unavailable";
  retrievalId?: string;
  preview?: CitationPreviewV1;
}>;

export type ResolveDocumentRequestV1 = Readonly<{
  target: DocumentRefV1;
  intent: "open" | "preview" | "inspect";
}>;

export type ResolveArtifactRequestV1 = Readonly<{
  target: ArtifactRefV1;
  intent: "open" | "preview" | "inspect";
}>;

export type ResolveCitationRequestV1 = Readonly<{
  source: CitationSourceV1;
  locator: CitationLocatorV1;
  intent: "preview_source" | "open_source" | "highlight_locator";
}>;

export type ResolveFailureCodeV1 =
  | "INVALID_REQUEST"
  | "CAPABILITY_DENIED"
  | "REVISION_UNAVAILABLE"
  | "INTERNAL";

export const RESOLVE_FAILURE_CODES_V1 = Object.freeze([
  "INVALID_REQUEST",
  "CAPABILITY_DENIED",
  "REVISION_UNAVAILABLE",
  "INTERNAL",
] as const satisfies readonly ResolveFailureCodeV1[]);

export type ResolveFailureV1 = Readonly<{
  ok: false;
  error: Readonly<{
    code: ResolveFailureCodeV1;
    message: string;
    retryability: "never";
    recoveryAction: "none";
  }>;
}>;

export type ResolveSuccessV1 = Readonly<{
  ok: true;
  value: Readonly<{
    freshness: "current" | "historical";
    action:
      | "open"
      | "preview"
      | "inspect"
      | "preview_source"
      | "open_source"
      | "highlight_locator";
  }>;
}>;

export type ResolveResultV1 = ResolveSuccessV1 | ResolveFailureV1;

export const TOOL_STATES_V1 = Object.freeze([
  "idle",
  "requested",
  "denied",
  "approved",
  "dispatched",
  "succeeded",
  "failed",
] as const);

export type ToolStateV1 = (typeof TOOL_STATES_V1)[number];

export const TOOL_TRANSITIONS_V1 = Object.freeze([
  Object.freeze(["idle", "requested"] as const),
  Object.freeze(["requested", "denied"] as const),
  Object.freeze(["requested", "approved"] as const),
  Object.freeze(["approved", "dispatched"] as const),
  Object.freeze(["dispatched", "succeeded"] as const),
  Object.freeze(["dispatched", "failed"] as const),
] as const);

type ExactObject = Readonly<Record<string, unknown>>;
const utf8 = new TextEncoder();
const identityPattern = /^(?!latest$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function invalid(message: string): never {
  throw new AgentContractError("INVALID_REQUEST", message);
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): ExactObject {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return invalid(`${label} must be a plain object`);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return invalid(`${label} must be a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return invalid(`${label} has unsupported properties`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const allowed = [...required, ...optional].sort();
    if (
      required.some((key) => !keys.includes(key)) ||
      keys.some((key) => !allowed.includes(key))
    ) {
      return invalid(`${label} has an invalid property set`);
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return invalid(`${label}.${key} must be an enumerable data property`);
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof AgentContractError) throw error;
    return invalid(`${label} could not be validated`);
  }
}

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !identityPattern.test(value) ||
    utf8.encode(value).byteLength > 128
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function parseDocumentRefV1(value: unknown): DocumentRefV1 {
  const input = exactObject(
    value,
    ["documentId", "revisionId", "documentKind"],
    [],
    "documentRef",
  );
  if (input.documentKind === REVIEWED_DOCUMENT_KIND_V1) {
    return parseReviewedDocumentRefV1(value);
  }
  if (input.documentKind !== "text") {
    return invalid("documentRef.documentKind is invalid");
  }
  return Object.freeze({
    documentId: identity(input.documentId, "documentRef.documentId"),
    revisionId: identity(input.revisionId, "documentRef.revisionId"),
    documentKind: "text" as const,
  });
}

export function parseArtifactRefV1(value: unknown): ArtifactRefV1 {
  const input = exactObject(
    value,
    ["artifactId", "revisionId", "artifactKind"],
    [],
    "artifactRef",
  );
  if (
    typeof input.artifactKind !== "string" ||
    !ARTIFACT_KINDS_V1.includes(input.artifactKind as ArtifactKindV1)
  ) {
    return invalid("artifactRef.artifactKind is invalid");
  }
  return Object.freeze({
    artifactId: identity(input.artifactId, "artifactRef.artifactId"),
    revisionId: identity(input.revisionId, "artifactRef.revisionId"),
    artifactKind: input.artifactKind as ArtifactKindV1,
  });
}

function previewText(value: unknown): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) {
    return invalid("citation.preview.text is invalid");
  }
  if (
    Array.from(value).length > CITATION_PREVIEW_MAX_CODE_POINTS_V1 ||
    utf8.encode(value).byteLength > CITATION_PREVIEW_MAX_UTF8_BYTES_V1
  ) {
    return invalid("citation.preview.text exceeds the preview budget");
  }
  return value;
}

export function createCitationPreviewV1(value: string): CitationPreviewV1 {
  if (typeof value !== "string") return invalid("citation preview source is invalid");
  let text = "";
  let truncated = false;
  for (const codePoint of Array.from(value)) {
    const candidate = `${text}${codePoint}`;
    if (
      Array.from(candidate).length > CITATION_PREVIEW_MAX_CODE_POINTS_V1 ||
      utf8.encode(candidate).byteLength > CITATION_PREVIEW_MAX_UTF8_BYTES_V1
    ) {
      truncated = true;
      break;
    }
    text = candidate;
  }
  return Object.freeze({
    text: previewText(text),
    truncated,
    authority: "non_authoritative" as const,
  });
}

export function parseCitationRefV1(value: unknown): CitationRefV1 {
  const input = exactObject(
    value,
    ["citationId", "source", "locator", "authorityStatus", "verificationStatus"],
    ["retrievalId", "preview"],
    "citationRef",
  );
  const source = parseCitationSourceV1(input.source);
  const locator = parseCitationLocatorV1(source, input.locator);
  if (
    input.authorityStatus !== "authoritative" &&
    input.authorityStatus !== "non_authoritative"
  ) {
    return invalid("citationRef.authorityStatus is invalid");
  }
  if (
    input.verificationStatus !== "unverified" &&
    input.verificationStatus !== "verified" &&
    input.verificationStatus !== "unavailable"
  ) {
    return invalid("citationRef.verificationStatus is invalid");
  }
  let preview: CitationPreviewV1 | undefined;
  if (input.preview !== undefined) {
    const previewInput = exactObject(
      input.preview,
      ["text", "truncated", "authority"],
      [],
      "citationRef.preview",
    );
    if (
      typeof previewInput.truncated !== "boolean" ||
      previewInput.authority !== "non_authoritative"
    ) {
      return invalid("citationRef.preview is invalid");
    }
    preview = Object.freeze({
      text: previewText(previewInput.text),
      truncated: previewInput.truncated,
      authority: "non_authoritative" as const,
    });
  }
  return Object.freeze({
    citationId: identity(input.citationId, "citationRef.citationId"),
    source,
    locator,
    authorityStatus: input.authorityStatus,
    verificationStatus: input.verificationStatus,
    ...(input.retrievalId === undefined
      ? {}
      : { retrievalId: identity(input.retrievalId, "citationRef.retrievalId") }),
    ...(preview === undefined ? {} : { preview }),
  });
}

export function parseResolveDocumentRequestV1(
  value: unknown,
): ResolveDocumentRequestV1 {
  const input = exactObject(value, ["target", "intent"], [], "resolveDocument");
  if (input.intent !== "open" && input.intent !== "preview" && input.intent !== "inspect") {
    return invalid("resolveDocument.intent is invalid");
  }
  return Object.freeze({ target: parseDocumentRefV1(input.target), intent: input.intent });
}

export function parseResolveArtifactRequestV1(
  value: unknown,
): ResolveArtifactRequestV1 {
  const input = exactObject(value, ["target", "intent"], [], "resolveArtifact");
  if (input.intent !== "open" && input.intent !== "preview" && input.intent !== "inspect") {
    return invalid("resolveArtifact.intent is invalid");
  }
  return Object.freeze({ target: parseArtifactRefV1(input.target), intent: input.intent });
}

export function parseResolveCitationRequestV1(
  value: unknown,
): ResolveCitationRequestV1 {
  const input = exactObject(
    value,
    ["source", "locator", "intent"],
    [],
    "resolveCitation",
  );
  if (
    input.intent !== "preview_source" &&
    input.intent !== "open_source" &&
    input.intent !== "highlight_locator"
  ) {
    return invalid("resolveCitation.intent is invalid");
  }
  const source = parseCitationSourceV1(input.source);
  return Object.freeze({
    source,
    locator: parseCitationLocatorV1(source, input.locator),
    intent: input.intent,
  });
}

export const RESOLVE_FAILURE_MESSAGES_V1: Readonly<
  Record<ResolveFailureCodeV1, string>
> = Object.freeze({
  INVALID_REQUEST: "Request is invalid",
  CAPABILITY_DENIED: "Requested resource is unavailable",
  REVISION_UNAVAILABLE: "Requested revision is unavailable",
  INTERNAL: "Request could not be completed",
});

export function createResolveFailureV1(code: ResolveFailureCodeV1): ResolveFailureV1 {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code,
      message: RESOLVE_FAILURE_MESSAGES_V1[code],
      retryability: "never" as const,
      recoveryAction: "none" as const,
    }),
  });
}

export function createResolveSuccessV1(
  freshness: "current" | "historical",
  action: ResolveSuccessV1["value"]["action"],
): ResolveSuccessV1 {
  return Object.freeze({ ok: true as const, value: Object.freeze({ freshness, action }) });
}

export function parseResolveResultV1(value: unknown): ResolveResultV1 {
  const header = exactObject(value, ["ok"], ["value", "error"], "resolveResult");
  if (header.ok === true) {
    const result = exactObject(value, ["ok", "value"], [], "resolveResult");
    const success = exactObject(
      result.value,
      ["freshness", "action"],
      [],
      "resolveResult.value",
    );
    if (success.freshness !== "current" && success.freshness !== "historical") {
      return invalid("resolveResult.value.freshness is invalid");
    }
    if (
      typeof success.action !== "string" ||
      ![
        "open",
        "preview",
        "inspect",
        "preview_source",
        "open_source",
        "highlight_locator",
      ].includes(success.action)
    ) {
      return invalid("resolveResult.value.action is invalid");
    }
    return createResolveSuccessV1(
      success.freshness,
      success.action as ResolveSuccessV1["value"]["action"],
    );
  }
  if (header.ok !== false) return invalid("resolveResult.ok is invalid");
  const result = exactObject(value, ["ok", "error"], [], "resolveResult");
  const failure = exactObject(
    result.error,
    ["code", "message", "retryability", "recoveryAction"],
    [],
    "resolveResult.error",
  );
  if (
    typeof failure.code !== "string" ||
    !RESOLVE_FAILURE_CODES_V1.includes(failure.code as ResolveFailureCodeV1) ||
    failure.message !==
      RESOLVE_FAILURE_MESSAGES_V1[failure.code as ResolveFailureCodeV1] ||
    failure.retryability !== "never" ||
    failure.recoveryAction !== "none"
  ) {
    return invalid("resolveResult.error is invalid");
  }
  return createResolveFailureV1(failure.code as ResolveFailureCodeV1);
}

export function applyToolStateTransitionV1(
  from: ToolStateV1,
  to: ToolStateV1,
): Readonly<{ from: ToolStateV1; to: ToolStateV1; toolBrokerInvocationCount: 0 }> {
  if (!TOOL_STATES_V1.includes(from) || !TOOL_STATES_V1.includes(to)) {
    return invalid("tool state is invalid");
  }
  const permitted = TOOL_TRANSITIONS_V1.some(
    ([expectedFrom, expectedTo]) => expectedFrom === from && expectedTo === to,
  );
  if (!permitted) return invalid("tool transition is invalid");
  return Object.freeze({ from, to, toolBrokerInvocationCount: 0 as const });
}

export function assertResolveErrorOrderV1(
  input: Readonly<{
    callerAuthorized: boolean;
    kindIntegrity: boolean;
    revisionAvailable: boolean;
    sourceLocatorValid: boolean;
    intentAuthorized: boolean;
    resolutionAvailable: boolean;
  }>,
): ResolveFailureV1 | null {
  if (!input.callerAuthorized) return createResolveFailureV1("CAPABILITY_DENIED");
  if (!input.kindIntegrity) return createResolveFailureV1("INTERNAL");
  if (!input.revisionAvailable) return createResolveFailureV1("REVISION_UNAVAILABLE");
  if (!input.sourceLocatorValid) return createResolveFailureV1("INVALID_REQUEST");
  if (!input.intentAuthorized) return createResolveFailureV1("CAPABILITY_DENIED");
  if (!input.resolutionAvailable) return createResolveFailureV1("REVISION_UNAVAILABLE");
  return null;
}

export function isNeverNoneErrorV1(
  error: Readonly<{ code: AgentContractErrorCodeV1; retryability: string; recoveryAction: string }>,
): boolean {
  return error.retryability === "never" && error.recoveryAction === "none";
}
