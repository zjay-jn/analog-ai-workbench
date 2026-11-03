export type ResolveArtifactRequestV1 = Readonly<{
  target: Readonly<{ artifactId: string; revisionId: string; artifactKind: "circuit_ir_reviewed" | "generic" }>;
  intent: "open" | "preview" | "inspect";
}>;
export type CitationSourceV1 =
  | Readonly<{ sourceKind: "document"; documentId: string; revisionId: string }>
  | Readonly<{ sourceKind: "artifact" | "reviewed_schematic"; artifactId: string; revisionId: string }>
  | Readonly<{ sourceKind: "rag_source"; corpusId: string; sourceId: string; sourceRevisionId: string }>;
export type CitationLocatorV1 =
  | Readonly<{ locatorKind: "whole_source" }>
  | Readonly<{ locatorKind: "text_range"; coordinateSystem: "unicode_code_point"; start: number; end: number }>
  | Readonly<{ locatorKind: "schematic_element"; occurrencePath: readonly string[]; definitionId: string; elementKind: string; elementId: string }>
  | Readonly<{ locatorKind: "rag_chunk"; chunkId: string; span?: Readonly<{ coordinateSystem: "unicode_code_point"; start: number; end: number }> }>;
export type ResolveCitationRequestV1 = Readonly<{
  source: CitationSourceV1;
  locator: CitationLocatorV1;
  intent: "preview_source" | "open_source" | "highlight_locator";
}>;
export type ResolveResultV1 =
  | Readonly<{ ok: true; value: Readonly<{ freshness: "current" | "historical"; action: ResolveArtifactRequestV1["intent"] | ResolveCitationRequestV1["intent"] }> }>
  | Readonly<{ ok: false; error: AgentSafeErrorV1 }>;
type CanonicalEventHeaderV1 = Readonly<{
  hostRunId: string;
  eventId: string;
  hostSequence: number;
  acceptedAt: string;
  canonicalPayloadDigest: `sha256:${string}`;
  warningCodes?: readonly "SOURCE_TIME_INVALID"[];
}>;
type CitationRefV1 = Readonly<{
  citationId: string;
  source: CitationSourceV1;
  locator: CitationLocatorV1;
  authorityStatus: "authoritative" | "non_authoritative";
  verificationStatus: "unverified" | "verified" | "unavailable";
  retrievalId?: string;
  preview?: Readonly<{ text: string; truncated: boolean; authority: "non_authoritative" }>;
}>;
type AgentErrorCodeV1 = "INVALID_REQUEST" | "PROTOCOL_MISMATCH" | "CAPABILITY_DENIED" | "NOT_CONFIGURED" | "ADAPTER_UNAVAILABLE" | "UPSTREAM_TIMEOUT" | "RATE_LIMITED" | "STREAM_INTERRUPTED" | "EVENT_GAP" | "MALFORMED_EVENT" | "CANCELLATION_TIMEOUT" | "TOOL_DENIED" | "TOOL_FAILED" | "RECOVERY_UNSUPPORTED" | "REVISION_UNAVAILABLE" | "INTERNAL";
export type CanonicalEventV1 =
  | (CanonicalEventHeaderV1 & Readonly<{ type: "run.accepted"; payload: Readonly<{ conversationId: string; turnId: string; adapterProfileId: string; adapterProfileRevision: string }> }>)
  | (CanonicalEventHeaderV1 & Readonly<{ type: "message.delta"; payload: Readonly<{ text: string }> }>)
  | (CanonicalEventHeaderV1 & Readonly<{ type: "citation.declared"; payload: CitationRefV1 }>)
  | (CanonicalEventHeaderV1 & Readonly<{ type: "run.completed"; payload: Readonly<{ finishReason: "completed" }> }>)
  | (CanonicalEventHeaderV1 & Readonly<{ type: "run.failed"; payload: Readonly<{ errorCode: AgentErrorCodeV1; retryability: "never" | "safe_resume" | "safe_same_request"; recoveryAction: "none" | "reconfigure" | "start_new_run" | "resume_from_cursor" | "retry_same_request" }> }>)
  | (CanonicalEventHeaderV1 & Readonly<{ type: "run.cancelled"; payload: Readonly<{ reason: "cancelled" }> }>);

export const WORKBENCH_API_METHODS_V1 = Object.freeze([
  "getInfo",
  "resolveReviewedArtifact",
  "startTurn",
  "subscribeRun",
  "cancelRun",
  "resolveArtifact",
  "resolveCitation",
] as const);

export const AGENT_CHANNELS_V1 = Object.freeze([
  "workbench.agent.startTurn.v1",
  "workbench.agent.subscribeRun.v1",
  "workbench.agent.cancelRun.v1",
  "workbench.agent.resolveArtifact.v1",
  "workbench.agent.resolveCitation.v1",
] as const);

export const START_TURN_CHANNEL = AGENT_CHANNELS_V1[0];
export const SUBSCRIBE_RUN_CHANNEL = AGENT_CHANNELS_V1[1];
export const CANCEL_RUN_CHANNEL = AGENT_CHANNELS_V1[2];
export const RESOLVE_ARTIFACT_CHANNEL = AGENT_CHANNELS_V1[3];
export const RESOLVE_CITATION_CHANNEL = AGENT_CHANNELS_V1[4];

export type AgentDesktopMethodV1 =
  | "startTurn"
  | "subscribeRun"
  | "cancelRun"
  | "resolveArtifact"
  | "resolveCitation";

export type StartTurnRequestV1 = Readonly<{
  conversationId: string;
  turnId: string;
  adapterProfileId: string;
  adapterProfileRevision: string;
  inputRefs: readonly string[];
  contextRefs: readonly string[];
}>;
export type SubscribeRunRequestV1 = Readonly<{
  hostRunId: string;
  afterHostSequence?: number;
}>;
export type CancelRunRequestV1 = Readonly<{ hostRunId: string }>;

export type AgentSafeErrorV1 = Readonly<{
  code: AgentErrorCodeV1;
  message: string;
  retryability: "never" | "safe_resume" | "safe_same_request";
  recoveryAction: "none" | "reconfigure" | "start_new_run" | "resume_from_cursor" | "retry_same_request";
}>;
export type StartTurnResultV1 =
  | Readonly<{ ok: true; value: Readonly<{ hostRunId: string }> }>
  | Readonly<{ ok: false; error: AgentSafeErrorV1 }>;
export type CancelRunResultV1 =
  | Readonly<{
      ok: true;
      value: Readonly<{
        hostRunId: string;
        cancelState: "requested" | "acknowledged" | "already_terminal";
      }>;
    }>
  | Readonly<{ ok: false; error: AgentSafeErrorV1 }>;
export type AgentDesktopRequestV1 =
  | StartTurnRequestV1
  | SubscribeRunRequestV1
  | CancelRunRequestV1
  | ResolveArtifactRequestV1
  | ResolveCitationRequestV1;
export type AgentDesktopResultV1 = StartTurnResultV1 | CancelRunResultV1 | ResolveResultV1;

export type AgentSubscriptionHandleV1 = Readonly<{
  unsubscribe: () => Promise<void>;
}>;
export type SubscribeRunResultV1 =
  | Readonly<{ ok: true; value: AgentSubscriptionHandleV1 }>
  | Readonly<{ ok: false; error: AgentSafeErrorV1 }>;

export type SubscribeControlV1 =
  | Readonly<{ kind: "open"; request: SubscribeRunRequestV1 }>
  | Readonly<{ kind: "activate"; subscriptionId: string; generation: number }>
  | Readonly<{ kind: "unsubscribe"; subscriptionId: string; generation: number }>;
export type SubscribeControlResultV1 =
  | Readonly<{
      ok: true;
      value: Readonly<{
        subscriptionId: string;
        generation: number;
        snapshotHead: number;
      }>;
    }>
  | Readonly<{ ok: true; value: Readonly<{ closed: true }> }>
  | Readonly<{ ok: false; error: AgentSafeErrorV1 }>;
export type SubscribeDeliveryV1 =
  | Readonly<{
      kind: "deliver";
      subscriptionId: string;
      generation: number;
      event: CanonicalEventV1;
    }>
  | Readonly<{
      kind: "closed";
      subscriptionId: string;
      generation: number;
    }>;

const IDENTITY = /^(?!latest$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: "Request is invalid",
  PROTOCOL_MISMATCH: "Protocol is unavailable",
  CAPABILITY_DENIED: "Requested resource is unavailable",
  NOT_CONFIGURED: "Agent is not configured",
  ADAPTER_UNAVAILABLE: "Agent adapter is unavailable",
  UPSTREAM_TIMEOUT: "Agent request timed out",
  RATE_LIMITED: "Agent request was rate limited",
  STREAM_INTERRUPTED: "Agent stream was interrupted",
  EVENT_GAP: "Agent event history is unavailable",
  MALFORMED_EVENT: "Agent event was invalid",
  CANCELLATION_TIMEOUT: "Cancellation timed out",
  TOOL_DENIED: "Tool request was denied",
  TOOL_FAILED: "Tool request failed",
  RECOVERY_UNSUPPORTED: "Agent recovery is unavailable",
  REVISION_UNAVAILABLE: "Requested revision is unavailable",
  INTERNAL: "Request could not be completed",
} as const);

function invalid(label: string): never {
  throw new TypeError(`${label} is invalid`);
}

function exact(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(label);
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid(label);
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid(label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (required.some((key) => !(key in descriptors)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) invalid(label);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) invalid(label);
    result[key] = descriptor.value;
  }
  return result;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTITY.test(value)) invalid(label);
  return value;
}

function identityList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 128) invalid(label);
  return Object.freeze(value.map((item, index) => identity(item, `${label}[${index}]`)));
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(label);
  return value as number;
}

function parseStartTurn(value: unknown): StartTurnRequestV1 {
  const input = exact(value, ["conversationId", "turnId", "adapterProfileId", "adapterProfileRevision", "inputRefs", "contextRefs"], [], "startTurn");
  return Object.freeze({
    conversationId: identity(input.conversationId, "startTurn.conversationId"),
    turnId: identity(input.turnId, "startTurn.turnId"),
    adapterProfileId: identity(input.adapterProfileId, "startTurn.adapterProfileId"),
    adapterProfileRevision: identity(input.adapterProfileRevision, "startTurn.adapterProfileRevision"),
    inputRefs: identityList(input.inputRefs, "startTurn.inputRefs"),
    contextRefs: identityList(input.contextRefs, "startTurn.contextRefs"),
  });
}

function parseSubscribe(value: unknown): SubscribeRunRequestV1 {
  const input = exact(value, ["hostRunId"], ["afterHostSequence"], "subscribeRun");
  return Object.freeze({
    hostRunId: identity(input.hostRunId, "subscribeRun.hostRunId"),
    ...(input.afterHostSequence === undefined ? {} : { afterHostSequence: safeInteger(input.afterHostSequence, "subscribeRun.afterHostSequence") }),
  });
}

function parseCancel(value: unknown): CancelRunRequestV1 {
  const input = exact(value, ["hostRunId"], [], "cancelRun");
  return Object.freeze({ hostRunId: identity(input.hostRunId, "cancelRun.hostRunId") });
}

function parseResolveArtifact(value: unknown): ResolveArtifactRequestV1 {
  const input = exact(value, ["target", "intent"], [], "resolveArtifact");
  const target = exact(input.target, ["artifactId", "revisionId", "artifactKind"], [], "resolveArtifact.target");
  if (target.artifactKind !== "circuit_ir_reviewed" && target.artifactKind !== "generic") invalid("resolveArtifact.target.artifactKind");
  if (input.intent !== "open" && input.intent !== "preview" && input.intent !== "inspect") invalid("resolveArtifact.intent");
  return Object.freeze({ target: Object.freeze({ artifactId: identity(target.artifactId, "resolveArtifact.target.artifactId"), revisionId: identity(target.revisionId, "resolveArtifact.target.revisionId"), artifactKind: target.artifactKind }), intent: input.intent });
}

function parseCitationSource(value: unknown): CitationSourceV1 {
  const header = exact(value, ["sourceKind"], ["documentId", "revisionId", "artifactId", "corpusId", "sourceId", "sourceRevisionId"], "resolveCitation.source");
  if (header.sourceKind === "document") {
    const input = exact(value, ["sourceKind", "documentId", "revisionId"], [], "resolveCitation.source");
    return Object.freeze({ sourceKind: "document", documentId: identity(input.documentId, "source.documentId"), revisionId: identity(input.revisionId, "source.revisionId") });
  }
  if (header.sourceKind === "artifact" || header.sourceKind === "reviewed_schematic") {
    const input = exact(value, ["sourceKind", "artifactId", "revisionId"], [], "resolveCitation.source");
    return Object.freeze({ sourceKind: header.sourceKind, artifactId: identity(input.artifactId, "source.artifactId"), revisionId: identity(input.revisionId, "source.revisionId") });
  }
  if (header.sourceKind === "rag_source") {
    const input = exact(value, ["sourceKind", "corpusId", "sourceId", "sourceRevisionId"], [], "resolveCitation.source");
    return Object.freeze({ sourceKind: "rag_source", corpusId: identity(input.corpusId, "source.corpusId"), sourceId: identity(input.sourceId, "source.sourceId"), sourceRevisionId: identity(input.sourceRevisionId, "source.sourceRevisionId") });
  }
  return invalid("resolveCitation.source.sourceKind");
}

function parseCitationLocator(value: unknown, source: CitationSourceV1): CitationLocatorV1 {
  const header = exact(value, ["locatorKind"], ["coordinateSystem", "start", "end", "occurrencePath", "definitionId", "elementKind", "elementId", "chunkId", "span"], "resolveCitation.locator");
  if (header.locatorKind === "whole_source") { exact(value, ["locatorKind"], [], "resolveCitation.locator"); return Object.freeze({ locatorKind: "whole_source" }); }
  if (header.locatorKind === "text_range" && source.sourceKind === "document") {
    const input = exact(value, ["locatorKind", "coordinateSystem", "start", "end"], [], "resolveCitation.locator");
    const start = safeInteger(input.start, "locator.start");
    const end = safeInteger(input.end, "locator.end");
    if (input.coordinateSystem !== "unicode_code_point" || end < start) invalid("resolveCitation.locator");
    return Object.freeze({ locatorKind: "text_range", coordinateSystem: "unicode_code_point", start, end });
  }
  if (header.locatorKind === "schematic_element" && source.sourceKind === "reviewed_schematic") {
    const input = exact(value, ["locatorKind", "occurrencePath", "definitionId", "elementKind", "elementId"], [], "resolveCitation.locator");
    return Object.freeze({ locatorKind: "schematic_element", occurrencePath: identityList(input.occurrencePath, "locator.occurrencePath"), definitionId: identity(input.definitionId, "locator.definitionId"), elementKind: identity(input.elementKind, "locator.elementKind"), elementId: identity(input.elementId, "locator.elementId") });
  }
  if (header.locatorKind === "rag_chunk" && source.sourceKind === "rag_source") {
    const input = exact(value, ["locatorKind", "chunkId"], ["span"], "resolveCitation.locator");
    let span: Readonly<{ coordinateSystem: "unicode_code_point"; start: number; end: number }> | undefined;
    if (input.span !== undefined) {
      const raw = exact(input.span, ["coordinateSystem", "start", "end"], [], "resolveCitation.locator.span");
      const start = safeInteger(raw.start, "locator.span.start");
      const end = safeInteger(raw.end, "locator.span.end");
      if (raw.coordinateSystem !== "unicode_code_point" || end < start) invalid("resolveCitation.locator.span");
      span = Object.freeze({ coordinateSystem: "unicode_code_point", start, end });
    }
    return Object.freeze({ locatorKind: "rag_chunk", chunkId: identity(input.chunkId, "locator.chunkId"), ...(span === undefined ? {} : { span }) });
  }
  return invalid("resolveCitation.locator");
}

function parseResolveCitation(value: unknown): ResolveCitationRequestV1 {
  const input = exact(value, ["source", "locator", "intent"], [], "resolveCitation");
  if (input.intent !== "preview_source" && input.intent !== "open_source" && input.intent !== "highlight_locator") invalid("resolveCitation.intent");
  const source = parseCitationSource(input.source);
  return Object.freeze({ source, locator: parseCitationLocator(input.locator, source), intent: input.intent });
}

export function parseAgentDesktopRequestV1(value: unknown, method: AgentDesktopMethodV1 = "subscribeRun"): AgentDesktopRequestV1 {
  switch (method) {
    case "startTurn": return parseStartTurn(value);
    case "subscribeRun": return parseSubscribe(value);
    case "cancelRun": return parseCancel(value);
    case "resolveArtifact": return parseResolveArtifact(value);
    case "resolveCitation": return parseResolveCitation(value);
    default: return invalid("desktop Agent method");
  }
}

function parseFailure(value: unknown): Readonly<{ ok: false; error: AgentSafeErrorV1 }> {
  const result = exact(value, ["ok", "error"], [], "agentResult");
  if (result.ok !== false) invalid("agentResult.ok");
  const error = exact(result.error, ["code", "message", "retryability", "recoveryAction"], [], "agentResult.error");
  const legalPair = (error.retryability === "never" && ["none", "reconfigure", "start_new_run"].includes(error.recoveryAction as string)) || (error.retryability === "safe_resume" && error.recoveryAction === "resume_from_cursor") || (error.retryability === "safe_same_request" && error.recoveryAction === "retry_same_request");
  if (typeof error.code !== "string" || !Object.hasOwn(ERROR_MESSAGES, error.code) || error.message !== ERROR_MESSAGES[error.code as keyof typeof ERROR_MESSAGES] || !legalPair) invalid("agentResult.error");
  return Object.freeze({ ok: false, error: Object.freeze(error) as AgentSafeErrorV1 });
}

export function parseAgentDesktopResultV1(value: unknown, method?: AgentDesktopMethodV1): AgentDesktopResultV1 {
  const header = exact(value, ["ok"], ["value", "error"], "agentResult");
  if (header.ok === false) return parseFailure(value);
  if (method === "resolveArtifact" || method === "resolveCitation") {
    const result = exact(value, ["ok", "value"], [], "resolveResult");
    if (result.ok !== true) invalid("resolveResult.ok");
    const body = exact(result.value, ["freshness", "action"], [], "resolveResult.value");
    if ((body.freshness !== "current" && body.freshness !== "historical") || typeof body.action !== "string" || !["open", "preview", "inspect", "preview_source", "open_source", "highlight_locator"].includes(body.action)) invalid("resolveResult.value");
    return Object.freeze({ ok: true, value: Object.freeze({ freshness: body.freshness, action: body.action }) }) as ResolveResultV1;
  }
  const result = exact(value, ["ok", "value"], [], "agentResult");
  if (result.ok !== true) invalid("agentResult.ok");
  if (method === "cancelRun") {
    const body = exact(result.value, ["hostRunId", "cancelState"], [], "cancelRunResult.value");
    if (!["requested", "acknowledged", "already_terminal"].includes(body.cancelState as string)) invalid("cancelRunResult.value.cancelState");
    return Object.freeze({ ok: true, value: Object.freeze({ hostRunId: identity(body.hostRunId, "cancelRunResult.value.hostRunId"), cancelState: body.cancelState as "requested" | "acknowledged" | "already_terminal" }) });
  }
  const body = exact(result.value, ["hostRunId"], [], "startTurnResult.value");
  return Object.freeze({ ok: true, value: Object.freeze({ hostRunId: identity(body.hostRunId, "startTurnResult.value.hostRunId") }) });
}

function strictUtc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/u.exec(value);
  if (match === null || match[1] === "0000") return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] ?? 0);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid("canonical JSON number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const input = exact(value, [], Object.keys(value as object), "canonical JSON object");
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`;
}

function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) { const x = w[i - 15]!; const y = w[i - 2]!; w[i] = (w[i - 16]! + (rotr(x,7)^rotr(x,18)^(x>>>3)) + w[i - 7]! + (rotr(y,17)^rotr(y,19)^(y>>>10))) >>> 0; }
    let [a,b,c,d,e,f,g,hh] = h as [number,number,number,number,number,number,number,number];
    for (let i = 0; i < 64; i += 1) { const s1=rotr(e,6)^rotr(e,11)^rotr(e,25); const ch=(e&f)^((~e)&g); const t1=(hh+s1+ch+k[i]!+w[i]!)>>>0; const s0=rotr(a,2)^rotr(a,13)^rotr(a,22); const maj=(a&b)^(a&c)^(b&c); const t2=(s0+maj)>>>0; hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    h[0]=(h[0]!+a)>>>0;h[1]=(h[1]!+b)>>>0;h[2]=(h[2]!+c)>>>0;h[3]=(h[3]!+d)>>>0;h[4]=(h[4]!+e)>>>0;h[5]=(h[5]!+f)>>>0;h[6]=(h[6]!+g)>>>0;h[7]=(h[7]!+hh)>>>0;
  }
  return h.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function parseCanonicalPayload(type: CanonicalEventV1["type"], value: unknown): Readonly<Record<string, unknown>> {
  if (type === "run.accepted") {
    const input = exact(value, ["conversationId", "turnId", "adapterProfileId", "adapterProfileRevision"], [], "agentEvent.payload");
    return Object.freeze({ conversationId: identity(input.conversationId, "payload.conversationId"), turnId: identity(input.turnId, "payload.turnId"), adapterProfileId: identity(input.adapterProfileId, "payload.adapterProfileId"), adapterProfileRevision: identity(input.adapterProfileRevision, "payload.adapterProfileRevision") });
  }
  if (type === "message.delta") {
    const input = exact(value, ["text"], [], "agentEvent.payload");
    if (typeof input.text !== "string" || new TextEncoder().encode(input.text).byteLength > 4096) invalid("agentEvent.payload.text");
    return Object.freeze({ text: input.text });
  }
  if (type === "run.completed") { const input = exact(value, ["finishReason"], [], "agentEvent.payload"); if (input.finishReason !== "completed") invalid("agentEvent.payload.finishReason"); return Object.freeze({ finishReason: "completed" }); }
  if (type === "run.cancelled") { const input = exact(value, ["reason"], [], "agentEvent.payload"); if (input.reason !== "cancelled") invalid("agentEvent.payload.reason"); return Object.freeze({ reason: "cancelled" }); }
  if (type === "run.failed") {
    const input = exact(value, ["errorCode", "retryability", "recoveryAction"], [], "agentEvent.payload");
    const legal = typeof input.errorCode === "string" && Object.hasOwn(ERROR_MESSAGES, input.errorCode) && ((input.retryability === "never" && ["none", "reconfigure", "start_new_run"].includes(input.recoveryAction as string)) || (input.retryability === "safe_resume" && input.recoveryAction === "resume_from_cursor") || (input.retryability === "safe_same_request" && input.recoveryAction === "retry_same_request"));
    if (!legal) invalid("agentEvent.payload");
    return Object.freeze({ errorCode: input.errorCode, retryability: input.retryability, recoveryAction: input.recoveryAction });
  }
  const input = exact(value, ["citationId", "source", "locator", "authorityStatus", "verificationStatus"], ["retrievalId", "preview"], "agentEvent.payload");
  const source = parseCitationSource(input.source);
  const locator = parseCitationLocator(input.locator, source);
  if ((input.authorityStatus !== "authoritative" && input.authorityStatus !== "non_authoritative") || !["unverified", "verified", "unavailable"].includes(input.verificationStatus as string)) invalid("agentEvent.payload");
  let preview: Readonly<Record<string, unknown>> | undefined;
  if (input.preview !== undefined) {
    const raw = exact(input.preview, ["text", "truncated", "authority"], [], "agentEvent.payload.preview");
    if (typeof raw.text !== "string" || /[\u0000-\u001f\u007f]/u.test(raw.text) || Array.from(raw.text).length > 512 || new TextEncoder().encode(raw.text).byteLength > 2_048 || typeof raw.truncated !== "boolean" || raw.authority !== "non_authoritative") invalid("agentEvent.payload.preview");
    preview = Object.freeze({ text: raw.text, truncated: raw.truncated, authority: "non_authoritative" });
  }
  return Object.freeze({ citationId: identity(input.citationId, "payload.citationId"), source, locator, authorityStatus: input.authorityStatus, verificationStatus: input.verificationStatus, ...(input.retrievalId === undefined ? {} : { retrievalId: identity(input.retrievalId, "payload.retrievalId") }), ...(preview === undefined ? {} : { preview }) });
}

export function parseAgentDesktopEventV1(value: unknown): CanonicalEventV1 {
  if (value instanceof Uint8Array) invalid("agentEvent");
  const input = exact(value, ["hostRunId", "eventId", "hostSequence", "acceptedAt", "canonicalPayloadDigest", "type", "payload"], ["warningCodes"], "agentEvent");
  if (!strictUtc(input.acceptedAt) || typeof input.canonicalPayloadDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input.canonicalPayloadDigest) || typeof input.type !== "string" || !["run.accepted", "message.delta", "citation.declared", "run.completed", "run.failed", "run.cancelled"].includes(input.type)) invalid("agentEvent.header");
  const payload = parseCanonicalPayload(input.type as CanonicalEventV1["type"], input.payload);
  if (`sha256:${sha256Hex(canonicalJson(payload))}` !== input.canonicalPayloadDigest) invalid("agentEvent.canonicalPayloadDigest");
  const hostSequence = safeInteger(input.hostSequence, "agentEvent.hostSequence");
  if (hostSequence < 1 || hostSequence > 10_000) invalid("agentEvent.hostSequence");
  let warningCodes: readonly "SOURCE_TIME_INVALID"[] | undefined;
  if (input.warningCodes !== undefined) {
    if (!Array.isArray(input.warningCodes) || input.warningCodes.length !== 1 || input.warningCodes[0] !== "SOURCE_TIME_INVALID") invalid("agentEvent.warningCodes");
    warningCodes = Object.freeze(["SOURCE_TIME_INVALID"]);
  }
  return Object.freeze({ hostRunId: identity(input.hostRunId, "agentEvent.hostRunId"), eventId: identity(input.eventId, "agentEvent.eventId"), hostSequence, acceptedAt: input.acceptedAt, canonicalPayloadDigest: input.canonicalPayloadDigest as `sha256:${string}`, ...(warningCodes === undefined ? {} : { warningCodes }), type: input.type, payload: Object.freeze(payload) }) as CanonicalEventV1;
}

export function parseSubscribeControlV1(value: unknown): SubscribeControlV1 {
  const header = exact(value, ["kind"], ["request", "subscriptionId", "generation"], "subscribeControl");
  if (header.kind === "open") return Object.freeze({ kind: "open", request: parseSubscribe(header.request) });
  if (header.kind !== "activate" && header.kind !== "unsubscribe") invalid("subscribeControl.kind");
  exact(value, ["kind", "subscriptionId", "generation"], [], "subscribeControl");
  return Object.freeze({ kind: header.kind, subscriptionId: identity(header.subscriptionId, "subscribeControl.subscriptionId"), generation: safeInteger(header.generation, "subscribeControl.generation") });
}

export function createAgentSafeFailureV1(
  code: AgentSafeErrorV1["code"],
  retryability: AgentSafeErrorV1["retryability"] = "never",
  recoveryAction: AgentSafeErrorV1["recoveryAction"] = "none",
): Readonly<{ ok: false; error: AgentSafeErrorV1 }> {
  const legalPair = (retryability === "never" && ["none", "reconfigure", "start_new_run"].includes(recoveryAction)) || (retryability === "safe_resume" && recoveryAction === "resume_from_cursor") || (retryability === "safe_same_request" && recoveryAction === "retry_same_request");
  if (!legalPair) invalid("Agent safe error retry/recovery pair");
  if (!Object.hasOwn(ERROR_MESSAGES, code)) invalid("Agent safe error code");
  return Object.freeze({ ok: false, error: Object.freeze({ code, message: ERROR_MESSAGES[code], retryability, recoveryAction }) });
}
