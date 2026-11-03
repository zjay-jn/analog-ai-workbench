export type DocumentProviderStatus =
  | "opening"
  | "clean"
  | "dirty"
  | "checking"
  | "saving"
  | "conflict"
  | "error"
  | "close_pending"
  | "closing"
  | "reloading"
  | "closed"
  | "cancelled";

export type StableDocumentState = {
  readonly status: DocumentProviderStatus;
  readonly revisionId: string | null;
  readonly persistedContentDigest: string | null;
  readonly workingContentDigest: string | null;
  readonly dirty: boolean;
  readonly resumeAfterCheck: "clean" | "dirty" | null;
  readonly errorCode: string | null;
};

export type DocumentProviderEvent =
  | {
      readonly type: "OPEN_SUCCEEDED";
      readonly revisionId: string;
      readonly contentDigest: string;
    }
  | { readonly type: "OPEN_CANCELLED" }
  | { readonly type: "OPEN_FAILED"; readonly errorCode: string }
  | { readonly type: "CONTENT_CHANGED"; readonly contentDigest: string }
  | { readonly type: "CHECK_STARTED" }
  | { readonly type: "CHECK_UNCHANGED" }
  | { readonly type: "CHECK_CONFLICT" }
  | { readonly type: "CHECK_FAILED"; readonly errorCode: string }
  | { readonly type: "SAVE_STARTED" }
  | {
      readonly type: "SAVE_SUCCEEDED";
      readonly revisionId: string;
      readonly contentDigest: string;
    }
  | { readonly type: "SAVE_CONFLICT" }
  | { readonly type: "SAVE_FAILED"; readonly errorCode: string }
  | { readonly type: "CLOSE_REQUESTED" }
  | { readonly type: "CLOSE_CANCELLED" }
  | { readonly type: "CLOSE_CONFIRMED" }
  | { readonly type: "RELOAD_STARTED" }
  | {
      readonly type: "RELOAD_SUCCEEDED";
      readonly revisionId: string;
      readonly contentDigest: string;
    }
  | { readonly type: "RELOAD_FAILED"; readonly errorCode: string };

export class InvalidDocumentTransitionError extends Error {
  constructor(
    readonly status: DocumentProviderStatus,
    readonly eventType: DocumentProviderEvent["type"],
  ) {
    super(`Invalid document transition: ${status} + ${eventType}`);
    this.name = "InvalidDocumentTransitionError";
  }
}

export function createOpeningDocumentState(): StableDocumentState {
  return {
    status: "opening",
    revisionId: null,
    persistedContentDigest: null,
    workingContentDigest: null,
    dirty: false,
    resumeAfterCheck: null,
    errorCode: null,
  };
}

export function createOpenedDocumentState(input: {
  readonly revisionId: string;
  readonly contentDigest: string;
}): StableDocumentState {
  return {
    status: "clean",
    revisionId: input.revisionId,
    persistedContentDigest: input.contentDigest,
    workingContentDigest: input.contentDigest,
    dirty: false,
    resumeAfterCheck: null,
    errorCode: null,
  };
}

function invalid(
  state: StableDocumentState,
  event: DocumentProviderEvent,
): never {
  throw new InvalidDocumentTransitionError(state.status, event.type);
}

export function reduceDocumentProviderState(
  state: StableDocumentState,
  event: DocumentProviderEvent,
): StableDocumentState {
  switch (event.type) {
    case "OPEN_SUCCEEDED":
      if (state.status !== "opening") return invalid(state, event);
      return createOpenedDocumentState(event);
    case "OPEN_CANCELLED":
      if (state.status !== "opening") return invalid(state, event);
      return { ...state, status: "cancelled" };
    case "OPEN_FAILED":
      if (state.status !== "opening") return invalid(state, event);
      return { ...state, status: "error", errorCode: event.errorCode };
    case "CONTENT_CHANGED": {
      if (!["clean", "dirty", "conflict", "error"].includes(state.status)) {
        return invalid(state, event);
      }
      const dirty = event.contentDigest !== state.persistedContentDigest;
      return {
        ...state,
        status: dirty ? "dirty" : "clean",
        workingContentDigest: event.contentDigest,
        dirty,
        resumeAfterCheck: null,
        errorCode: null,
      };
    }
    case "CHECK_STARTED":
      if (state.status !== "clean" && state.status !== "dirty") {
        return invalid(state, event);
      }
      return {
        ...state,
        status: "checking",
        resumeAfterCheck: state.status,
        errorCode: null,
      };
    case "CHECK_UNCHANGED":
      if (state.status !== "checking" || state.resumeAfterCheck === null) {
        return invalid(state, event);
      }
      return {
        ...state,
        status: state.resumeAfterCheck,
        resumeAfterCheck: null,
      };
    case "CHECK_CONFLICT":
      if (state.status !== "checking") return invalid(state, event);
      return {
        ...state,
        status: "conflict",
        dirty: true,
        resumeAfterCheck: null,
      };
    case "CHECK_FAILED":
      if (state.status !== "checking") return invalid(state, event);
      return {
        ...state,
        status: "error",
        dirty: state.resumeAfterCheck === "dirty",
        resumeAfterCheck: null,
        errorCode: event.errorCode,
      };
    case "SAVE_STARTED":
      if (state.status !== "dirty") return invalid(state, event);
      return { ...state, status: "saving", errorCode: null };
    case "SAVE_SUCCEEDED":
      if (
        state.status !== "saving" ||
        event.contentDigest !== state.workingContentDigest
      ) {
        return invalid(state, event);
      }
      return createOpenedDocumentState(event);
    case "SAVE_CONFLICT":
      if (state.status !== "saving") return invalid(state, event);
      return { ...state, status: "conflict", dirty: true };
    case "SAVE_FAILED":
      if (state.status !== "saving") return invalid(state, event);
      return {
        ...state,
        status: "error",
        dirty: true,
        errorCode: event.errorCode,
      };
    case "CLOSE_REQUESTED":
      if (state.status === "clean") {
        return { ...state, status: "closing" };
      }
      if (state.status === "dirty" || state.status === "conflict") {
        return { ...state, status: "close_pending", dirty: true };
      }
      return invalid(state, event);
    case "CLOSE_CANCELLED":
      if (state.status !== "close_pending") return invalid(state, event);
      return { ...state, status: "dirty", dirty: true };
    case "CLOSE_CONFIRMED":
      if (state.status !== "close_pending" && state.status !== "closing") {
        return invalid(state, event);
      }
      return { ...state, status: "closed" };
    case "RELOAD_STARTED":
      if (state.status !== "conflict") return invalid(state, event);
      return { ...state, status: "reloading" };
    case "RELOAD_SUCCEEDED":
      if (state.status !== "reloading") return invalid(state, event);
      return createOpenedDocumentState(event);
    case "RELOAD_FAILED":
      if (state.status !== "reloading") return invalid(state, event);
      return {
        ...state,
        status: "error",
        dirty: true,
        errorCode: event.errorCode,
      };
  }
}
