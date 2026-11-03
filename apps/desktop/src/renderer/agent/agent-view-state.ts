import type {
  AgentRecoveryActionV1,
  AgentRetryabilityV1,
} from "../../../../../packages/agent-adapters/src/agent-contract";
import type {
  CitationLocatorV1,
  CitationSourceV1,
  CanonicalEventV1,
} from "../../shared/agent/desktop-agent-api";

export type AgentViewLifecycleV1 =
  | "idle"
  | "starting"
  | "running"
  | "cancelling"
  | "terminal"
  | "error"
  | "quarantined"
  | "replay";

export type AgentCitationFreshnessV1 =
  | "unresolved"
  | "loading"
  | "current"
  | "historical"
  | "unavailable"
  | "unauthorized"
  | "revoked"
  | "quarantined";

export type AgentCitationCardV1 = Readonly<{
  citationId: string;
  source: CitationSourceV1;
  locator: CitationLocatorV1;
  revisionId: string;
  freshness: AgentCitationFreshnessV1;
  authorityStatus: "authoritative" | "non_authoritative";
  verificationStatus: "unverified" | "verified" | "unavailable";
  previewText?: string;
  previewTruncated?: boolean;
}>;

export type AgentViewStateV1 = Readonly<{
  lifecycle: AgentViewLifecycleV1;
  generation: number;
  hostRunId?: string;
  terminal: boolean;
  lastHostSequence: number;
  acceptedEventIds: readonly string[];
  acceptedEvents: readonly Readonly<{
    eventId: string;
    hostSequence: number;
    canonicalPayloadDigest: string;
  }>[];
  messageText: string;
  citations: readonly AgentCitationCardV1[];
  citationFreshness: AgentCitationFreshnessV1;
  cancelEnabled: boolean;
  retryability: AgentRetryabilityV1;
  recoveryAction: AgentRecoveryActionV1;
  recoveryRequiresUserAction: boolean;
  recoveryPending: boolean;
  politeAnnouncement: string;
  pendingPoliteAnnouncement: string;
  statusAnnouncement: string;
  announcedWarningKeys: readonly string[];
  queuedEventCount: number;
  subscriptionActive: boolean;
  unsubscribeRequestDelta: number;
  rendererEmissions: number;
}>;

export type AgentViewActionV1 =
  | Readonly<{ type: "start-requested" }>
  | Readonly<{ type: "run-started"; hostRunId: string }>
  | Readonly<{ type: "start-failed"; message?: string; recoveryAction?: AgentRecoveryActionV1; retryability?: AgentRetryabilityV1 }>
  | Readonly<{ type: "subscription-opened"; generation: number }>
  | Readonly<{ type: "subscription-live"; generation: number }>
  | Readonly<{ type: "canonical-event"; event: CanonicalEventV1; replayed: boolean; generation: number }>
  | Readonly<{ type: "cancel-requested" }>
  | Readonly<{ type: "cancel-failed"; message?: string }>
  | Readonly<{ type: "recovery-offered"; retryability: AgentRetryabilityV1; recoveryAction: AgentRecoveryActionV1 }>
  | Readonly<{ type: "recovery-requested" }>
  | Readonly<{ type: "recovery-settled" }>
  | Readonly<{ type: "citation-loading"; generation: number; citationId: string }>
  | Readonly<{ type: "citation-resolved"; generation: number; citationId: string; revisionId: string; freshness: "current" | "historical"; previewText?: string; previewTruncated?: boolean }>
  | Readonly<{ type: "citation-failed"; generation: number; citationId: string; freshness: "unavailable" | "unauthorized" | "revoked" | "quarantined" }>
  | Readonly<{ type: "source-time-warning"; generation: number; eventId: string; hostSequence: number; message?: string }>
  | Readonly<{ type: "aria-flush"; generation: number }>
  | Readonly<{ type: "unmount"; generation: number }>;

const SOURCE_TIME_WARNING = "Source timestamp was invalid and was ignored.";

function frozenStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function frozenCitations(values: readonly AgentCitationCardV1[]): readonly AgentCitationCardV1[] {
  return Object.freeze([...values]);
}

function legalRecovery(
  retryability: AgentRetryabilityV1,
  recoveryAction: AgentRecoveryActionV1,
): boolean {
  return (
    (retryability === "never" && ["none", "reconfigure", "start_new_run"].includes(recoveryAction)) ||
    (retryability === "safe_resume" && recoveryAction === "resume_from_cursor") ||
    (retryability === "safe_same_request" && recoveryAction === "retry_same_request")
  );
}

function recoveryVisible(recoveryAction: AgentRecoveryActionV1): boolean {
  return recoveryAction !== "none";
}

function initialState(generation = 0): AgentViewStateV1 {
  return Object.freeze({
    lifecycle: "idle" as const,
    generation,
    lastHostSequence: 0,
    terminal: false,
    acceptedEventIds: Object.freeze([] as string[]),
    acceptedEvents: Object.freeze([] as Readonly<{
      eventId: string;
      hostSequence: number;
      canonicalPayloadDigest: string;
    }>[]),
    messageText: "",
    citations: Object.freeze([] as AgentCitationCardV1[]),
    citationFreshness: "unresolved" as const,
    cancelEnabled: false,
    retryability: "never" as const,
    recoveryAction: "none" as const,
    recoveryRequiresUserAction: false,
    recoveryPending: false,
    politeAnnouncement: "",
    pendingPoliteAnnouncement: "",
    statusAnnouncement: "",
    announcedWarningKeys: Object.freeze([] as string[]),
    queuedEventCount: 0,
    subscriptionActive: false,
    unsubscribeRequestDelta: 0,
    rendererEmissions: 0,
  });
}

export function createInitialAgentViewStateV1(): AgentViewStateV1 {
  return initialState();
}

function failClosed(state: AgentViewStateV1): AgentViewStateV1 {
  return Object.freeze({
    ...state,
    lifecycle: "quarantined" as const,
    terminal: true,
    cancelEnabled: false,
    retryability: "never" as const,
    recoveryAction: "none" as const,
    recoveryRequiresUserAction: false,
    recoveryPending: false,
    queuedEventCount: 0,
    statusAnnouncement: "Synthetic run was isolated.",
  });
}

function citationRevision(source: CitationSourceV1): string {
  if (source.sourceKind === "rag_source") return source.sourceRevisionId;
  return source.revisionId;
}

function appendCitation(
  state: AgentViewStateV1,
  event: CanonicalEventV1,
): readonly AgentCitationCardV1[] | null {
  const payload = citationPayload(event.payload);
  if (payload === null) return null;
  if (state.citations.some((citation) => citation.citationId === payload.citationId)) {
    return state.citations;
  }
  const preview = payload.preview;
  const card = Object.freeze({
    citationId: payload.citationId,
    source: payload.source,
    locator: payload.locator,
    revisionId: citationRevision(payload.source),
    freshness: "unresolved" as const,
    authorityStatus: payload.authorityStatus,
    verificationStatus: payload.verificationStatus,
    ...(preview === undefined
      ? {}
      : { previewText: preview.text, previewTruncated: preview.truncated }),
  });
  return frozenCitations([...state.citations, card]);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function citationPayload(value: unknown): Readonly<{
  citationId: string;
  source: CitationSourceV1;
  locator: CitationLocatorV1;
  authorityStatus: "authoritative" | "non_authoritative";
  verificationStatus: "unverified" | "verified" | "unavailable";
  preview?: Readonly<{ text: string; truncated: boolean }>;
}> | null {
  const payload = record(value);
  const source = record(payload?.source);
  const locator = record(payload?.locator);
  if (
    payload === null || source === null || locator === null ||
    typeof payload.citationId !== "string" ||
    !["document", "artifact", "reviewed_schematic", "rag_source"].includes(String(source.sourceKind)) ||
    !["whole_source", "text_range", "schematic_element", "rag_chunk"].includes(String(locator.locatorKind)) ||
    !["authoritative", "non_authoritative"].includes(String(payload.authorityStatus)) ||
    !["unverified", "verified", "unavailable"].includes(String(payload.verificationStatus))
  ) return null;
  const revision = source.sourceKind === "rag_source" ? source.sourceRevisionId : source.revisionId;
  if (typeof revision !== "string") return null;
  let preview: Readonly<{ text: string; truncated: boolean }> | undefined;
  if (payload.preview !== undefined) {
    const previewRecord = record(payload.preview);
    if (previewRecord === null || typeof previewRecord.text !== "string" || typeof previewRecord.truncated !== "boolean") {
      return null;
    }
    preview = Object.freeze({ text: previewRecord.text, truncated: previewRecord.truncated });
  }
  return Object.freeze({
    citationId: payload.citationId,
    source: source as CitationSourceV1,
    locator: locator as CitationLocatorV1,
    authorityStatus: payload.authorityStatus as "authoritative" | "non_authoritative",
    verificationStatus: payload.verificationStatus as "unverified" | "verified" | "unavailable",
    ...(preview === undefined ? {} : { preview }),
  });
}

function messageText(value: unknown): string | null {
  const payload = record(value);
  return payload !== null && typeof payload.text === "string" ? payload.text : null;
}

function failedPayload(value: unknown): Readonly<{
  errorCode: string;
  retryability: AgentRetryabilityV1;
  recoveryAction: AgentRecoveryActionV1;
}> | null {
  const payload = record(value);
  if (
    payload === null ||
    typeof payload.errorCode !== "string" ||
    !["never", "safe_resume", "safe_same_request"].includes(String(payload.retryability)) ||
    !["none", "reconfigure", "start_new_run", "resume_from_cursor", "retry_same_request"].includes(String(payload.recoveryAction))
  ) return null;
  const retryability = payload.retryability as AgentRetryabilityV1;
  const recoveryAction = payload.recoveryAction as AgentRecoveryActionV1;
  if (!legalRecovery(retryability, recoveryAction)) return null;
  return Object.freeze({ errorCode: payload.errorCode, retryability, recoveryAction });
}

function updateCitation(
  state: AgentViewStateV1,
  citationId: string,
  update: Partial<AgentCitationCardV1>,
): readonly AgentCitationCardV1[] {
  return frozenCitations(state.citations.map((citation) =>
    citation.citationId === citationId
      ? Object.freeze({ ...citation, ...update })
      : citation));
}

function addWarning(
  state: AgentViewStateV1,
  key: string,
): Pick<AgentViewStateV1, "announcedWarningKeys" | "statusAnnouncement"> {
  if (state.announcedWarningKeys.includes(key)) {
    return {
      announcedWarningKeys: state.announcedWarningKeys,
      statusAnnouncement: state.statusAnnouncement,
    };
  }
  return {
    announcedWarningKeys: frozenStrings([...state.announcedWarningKeys, key]),
    statusAnnouncement: SOURCE_TIME_WARNING,
  };
}

function reduceCanonicalEvent(
  state: AgentViewStateV1,
  event: CanonicalEventV1,
  replayed: boolean,
): AgentViewStateV1 {
  if (state.hostRunId !== undefined && event.hostRunId !== state.hostRunId) {
    return failClosed(state);
  }
  const previousEvent = state.acceptedEvents.find(
    (candidate) => candidate.eventId === event.eventId,
  );
  if (previousEvent !== undefined) {
    return previousEvent.hostSequence === event.hostSequence &&
        previousEvent.canonicalPayloadDigest === event.canonicalPayloadDigest
      ? state
      : failClosed(state);
  }
  if (event.hostSequence !== state.lastHostSequence + 1) return failClosed(state);
  if (state.terminal || state.lifecycle === "quarantined") {
    return failClosed(state);
  }

  const warningKey = event.warningCodes?.includes("SOURCE_TIME_INVALID")
    ? `${event.hostRunId}:${event.eventId}:SOURCE_TIME_INVALID`
    : undefined;
  const warning = warningKey === undefined
    ? {
        announcedWarningKeys: state.announcedWarningKeys,
        statusAnnouncement: state.statusAnnouncement,
      }
    : addWarning(state, warningKey);
  const base = {
    ...state,
    hostRunId: state.hostRunId ?? event.hostRunId,
    lastHostSequence: event.hostSequence,
    acceptedEventIds: frozenStrings([...state.acceptedEventIds, event.eventId]),
    acceptedEvents: Object.freeze([
      ...state.acceptedEvents,
      Object.freeze({
        eventId: event.eventId,
        hostSequence: event.hostSequence,
        canonicalPayloadDigest: event.canonicalPayloadDigest,
      }),
    ]),
    rendererEmissions: state.rendererEmissions + 1,
    ...warning,
  };
  const streamingLifecycle = replayed && state.lifecycle === "replay"
    ? "replay" as const
    : "running" as const;
  const streamingCancelEnabled = streamingLifecycle === "running";

  switch (event.type) {
    case "run.accepted":
      return Object.freeze({
        ...base,
        lifecycle: streamingLifecycle,
        cancelEnabled: streamingCancelEnabled,
        statusAnnouncement: replayed ? "Replaying synthetic run." : "Synthetic run started.",
      });
    case "message.delta":
      {
      const text = messageText(event.payload);
      if (text === null) return failClosed(state);
      return Object.freeze({
        ...base,
        lifecycle: streamingLifecycle,
        cancelEnabled: streamingCancelEnabled,
        messageText: `${state.messageText}${text}`,
        pendingPoliteAnnouncement: replayed
          ? state.pendingPoliteAnnouncement
          : `${state.pendingPoliteAnnouncement}${text}`,
        queuedEventCount: replayed ? state.queuedEventCount : state.queuedEventCount + 1,
      });
      }
    case "citation.declared":
      {
      const citations = appendCitation(state, event);
      if (citations === null) return failClosed(state);
      return Object.freeze({
        ...base,
        lifecycle: streamingLifecycle,
        cancelEnabled: streamingCancelEnabled,
        citations,
        citationFreshness: "unresolved" as const,
        politeAnnouncement: replayed ? state.politeAnnouncement : "Synthetic citation available.",
      });
      }
    case "run.completed":
      return Object.freeze({
        ...base,
        lifecycle: "terminal" as const,
        terminal: true,
        cancelEnabled: false,
        statusAnnouncement: "Synthetic run completed.",
      });
    case "run.cancelled":
      return Object.freeze({
        ...base,
        lifecycle: "terminal" as const,
        terminal: true,
        cancelEnabled: false,
        statusAnnouncement: "Synthetic run cancelled.",
      });
    case "run.failed": {
      const failure = failedPayload(event.payload);
      if (failure === null) return failClosed(state);
      return Object.freeze({
        ...base,
        lifecycle: failure.errorCode === "INTERNAL" ? "quarantined" as const : "error" as const,
        terminal: true,
        cancelEnabled: false,
        retryability: failure.retryability,
        recoveryAction: failure.recoveryAction,
        recoveryRequiresUserAction: recoveryVisible(failure.recoveryAction),
        recoveryPending: false,
        statusAnnouncement: "Synthetic run failed.",
      });
    }
  }
}

export function reduceAgentViewStateV1(
  state: AgentViewStateV1,
  action: AgentViewActionV1,
): AgentViewStateV1 {
  switch (action.type) {
    case "start-requested":
      return Object.freeze({
        ...initialState(state.generation + 1),
        lifecycle: "starting" as const,
        unsubscribeRequestDelta: state.unsubscribeRequestDelta,
        statusAnnouncement: "Starting synthetic run.",
      });
    case "run-started":
      return Object.freeze({
        ...state,
        lifecycle: "running" as const,
        generation: state.generation === 0 ? 1 : state.generation,
        hostRunId: action.hostRunId,
        cancelEnabled: true,
      });
    case "start-failed": {
      const retryability = action.retryability ?? "never";
      const recoveryAction = action.recoveryAction ?? "none";
      if (!legalRecovery(retryability, recoveryAction)) return failClosed(state);
      return Object.freeze({
        ...state,
        lifecycle: "error" as const,
        cancelEnabled: false,
        retryability,
        recoveryAction,
        recoveryRequiresUserAction: recoveryVisible(recoveryAction),
        statusAnnouncement: "Synthetic Agent is not configured.",
      });
    }
    case "subscription-opened":
      if (!Number.isSafeInteger(action.generation) || action.generation < state.generation) return state;
      return Object.freeze({
        ...state,
        generation: action.generation,
        lifecycle: "replay" as const,
        terminal: state.recoveryPending && state.recoveryAction === "resume_from_cursor"
          ? false
          : state.terminal,
        cancelEnabled: false,
        subscriptionActive: true,
        queuedEventCount: 0,
        statusAnnouncement: "Replaying synthetic run.",
      });
    case "subscription-live":
      if (action.generation !== state.generation || !state.subscriptionActive) return state;
      if (state.lifecycle !== "replay") return state;
      return Object.freeze({
        ...state,
        lifecycle: "running" as const,
        cancelEnabled: state.hostRunId !== undefined,
        statusAnnouncement: "Synthetic run is live.",
      });
    case "canonical-event":
      if (action.generation !== state.generation || !state.subscriptionActive && state.hostRunId === undefined) {
        return state;
      }
      return reduceCanonicalEvent(state, action.event, action.replayed);
    case "cancel-requested":
      if (!state.cancelEnabled || state.lifecycle !== "running") return state;
      return Object.freeze({
        ...state,
        lifecycle: "cancelling" as const,
        cancelEnabled: false,
        statusAnnouncement: "Cancellation requested.",
      });
    case "cancel-failed":
      if (state.lifecycle !== "cancelling") return state;
      return Object.freeze({
        ...state,
        lifecycle: "error" as const,
        cancelEnabled: false,
        statusAnnouncement: "Cancellation request failed.",
      });
    case "recovery-offered":
      if (!legalRecovery(action.retryability, action.recoveryAction)) return failClosed(state);
      return Object.freeze({
        ...state,
        retryability: action.retryability,
        recoveryAction: action.recoveryAction,
        recoveryRequiresUserAction: recoveryVisible(action.recoveryAction),
        recoveryPending: false,
      });
    case "recovery-requested":
      if (!state.recoveryRequiresUserAction || state.recoveryPending) return state;
      return Object.freeze({ ...state, recoveryPending: true });
    case "recovery-settled":
      return Object.freeze({ ...state, recoveryPending: false });
    case "citation-loading":
      if (action.generation < state.generation) return state;
      return Object.freeze({
        ...state,
        generation: action.generation,
        citations: updateCitation(state, action.citationId, { freshness: "loading" }),
        citationFreshness: "loading" as const,
      });
    case "citation-resolved":
      if (action.generation < state.generation) return state;
      return Object.freeze({
        ...state,
        generation: action.generation,
        citations: updateCitation(state, action.citationId, {
          revisionId: action.revisionId,
          freshness: action.freshness,
          ...(action.previewText === undefined ? {} : { previewText: action.previewText }),
          ...(action.previewTruncated === undefined ? {} : { previewTruncated: action.previewTruncated }),
        }),
        citationFreshness: action.freshness,
        statusAnnouncement: action.freshness === "historical"
          ? "Historical synthetic citation opened."
          : "Synthetic citation opened.",
      });
    case "citation-failed":
      if (action.generation < state.generation) return state;
      return Object.freeze({
        ...state,
        generation: action.generation,
        citations: frozenCitations(state.citations.map((citation) => citation.citationId === action.citationId
          ? Object.freeze({
              citationId: citation.citationId,
              source: citation.source,
              locator: citation.locator,
              revisionId: citation.revisionId,
              freshness: action.freshness,
              authorityStatus: citation.authorityStatus,
              verificationStatus: citation.verificationStatus,
            })
          : citation)),
        citationFreshness: action.freshness,
        statusAnnouncement: "Synthetic citation is unavailable.",
      });
    case "source-time-warning": {
      if (action.generation < state.generation) return state;
      const warning = addWarning(state, `${action.eventId}:SOURCE_TIME_INVALID`);
      if (warning.announcedWarningKeys === state.announcedWarningKeys) return state;
      return Object.freeze({ ...state, generation: action.generation, ...warning });
    }
    case "aria-flush":
      if (action.generation !== state.generation || state.pendingPoliteAnnouncement.length === 0) return state;
      return Object.freeze({
        ...state,
        politeAnnouncement: state.pendingPoliteAnnouncement,
        pendingPoliteAnnouncement: "",
        queuedEventCount: 0,
      });
    case "unmount": {
      const shouldUnsubscribe = state.subscriptionActive && state.unsubscribeRequestDelta === 0;
      return Object.freeze({
        ...initialState(Math.max(action.generation, state.generation + 1)),
        unsubscribeRequestDelta: state.unsubscribeRequestDelta + (shouldUnsubscribe ? 1 : 0),
      });
    }
  }
}
