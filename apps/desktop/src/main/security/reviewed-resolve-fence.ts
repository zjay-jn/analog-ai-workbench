import {
  parseReviewedArtifactRefV1,
  parseReviewedDocumentRefV1,
  type ReviewedArtifactRefV1,
  type ReviewedDocumentRefV1,
} from "../../../../../packages/document-contract/src/reviewed-identity";
import {
  RESOLVE_REVIEWED_ARTIFACT_CONTRACT_VERSION,
  type ResolveReviewedArtifactRequestV1,
} from "../../shared/schematic/reviewed-artifact-resolve";
import { types as nodeTypes } from "node:util";

export type CallerContextV1 = Readonly<{
  senderId: number;
  isTopFrame: boolean;
  topFrameUrl: string;
  appOrigin: string;
  webContentsId: number;
  navigationEpoch: number;
  appSessionId: string;
  windowId: string;
  documentRef: ReviewedDocumentRefV1;
  capability: string;
  registryGeneration: number;
}>;

export type ReviewedResolveFenceDecisionV1 =
  | "deliver"
  | "CAPABILITY_DENIED"
  | "REVISION_UNAVAILABLE"
  | "INTERNAL";

export type ReviewedResolveLeaseV1 = Readonly<{
  caller: CallerContextV1;
  documentRef: ReviewedDocumentRefV1;
  artifactRef: ReviewedArtifactRefV1;
  lifecycleEpoch: number;
  navigationEpoch: number;
  registryEpoch: number;
}>;

export type ReviewedResolveFenceV1 = Readonly<{
  authorizeCaller(caller: unknown): boolean;
  begin(caller: unknown, request: unknown): ReviewedResolveLeaseV1 | null;
  checkBeforeDelivery(lease: ReviewedResolveLeaseV1): ReviewedResolveFenceDecisionV1;
  advanceNavigation(webContentsId: number): void;
  closeWebContents(webContentsId: number): void;
  closeWindow(windowId: string): void;
  closeSession(appSessionId: string): void;
  disableFixtureRegistry(): void;
  advanceRegistryGeneration(): void;
  revokeRevision(artifactRef: ReviewedArtifactRefV1): void;
  quarantineRevision(artifactRef: ReviewedArtifactRefV1): void;
}>;

type ExactRecord = Readonly<Record<string, unknown>>;

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

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeText(value: unknown, maximumBytes = 2_048): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maximumBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function parseCallerContext(value: unknown): CallerContextV1 | null {
  const record = exactRecord(value, [
    "senderId",
    "isTopFrame",
    "topFrameUrl",
    "appOrigin",
    "webContentsId",
    "navigationEpoch",
    "appSessionId",
    "windowId",
    "documentRef",
    "capability",
    "registryGeneration",
  ]);
  if (record === null || typeof record.isTopFrame !== "boolean") return null;
  const senderId = safeInteger(record.senderId);
  const webContentsId = safeInteger(record.webContentsId);
  const navigationEpoch = safeInteger(record.navigationEpoch);
  const registryGeneration = safeInteger(record.registryGeneration);
  const topFrameUrl = safeText(record.topFrameUrl);
  const appOrigin = safeText(record.appOrigin);
  const appSessionId = safeText(record.appSessionId, 256);
  const windowId = safeText(record.windowId, 256);
  const capability = safeText(record.capability, 128);
  if (
    senderId === null ||
    webContentsId === null ||
    navigationEpoch === null ||
    registryGeneration === null ||
    topFrameUrl === null ||
    appOrigin === null ||
    appSessionId === null ||
    windowId === null ||
    capability === null
  ) {
    return null;
  }
  try {
    return Object.freeze({
      senderId,
      isTopFrame: record.isTopFrame,
      topFrameUrl,
      appOrigin,
      webContentsId,
      navigationEpoch,
      appSessionId,
      windowId,
      documentRef: parseReviewedDocumentRefV1(record.documentRef),
      capability,
      registryGeneration,
    });
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
  } catch {
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

function artifactKey(ref: ReviewedArtifactRefV1): string {
  return JSON.stringify([ref.artifactId, ref.revisionId, ref.artifactKind]);
}

function sameCaller(left: CallerContextV1, right: CallerContextV1): boolean {
  return (
    left.senderId === right.senderId &&
    left.isTopFrame === right.isTopFrame &&
    left.topFrameUrl === right.topFrameUrl &&
    left.appOrigin === right.appOrigin &&
    left.webContentsId === right.webContentsId &&
    left.navigationEpoch === right.navigationEpoch &&
    left.appSessionId === right.appSessionId &&
    left.windowId === right.windowId &&
    sameDocumentRef(left.documentRef, right.documentRef) &&
    left.capability === right.capability &&
    left.registryGeneration === right.registryGeneration
  );
}

export function createReviewedResolveFenceV1(input: Readonly<{
  caller: CallerContextV1;
  artifactRef: ReviewedArtifactRefV1;
  fixtureRegistryEnabled: boolean;
}>): ReviewedResolveFenceV1 {
  const expectedCaller = parseCallerContext(input.caller);
  if (expectedCaller === null) {
    throw new TypeError("Reviewed resolve fence caller context is invalid.");
  }
  const expectedArtifactRef = parseReviewedArtifactRefV1(input.artifactRef);
  let fixtureRegistryEnabled = input.fixtureRegistryEnabled === true;
  let lifecycleEpoch = 0;
  let navigationEpoch = expectedCaller.navigationEpoch;
  let registryEpoch = expectedCaller.registryGeneration;
  let webContentsOpen = true;
  let windowOpen = true;
  let sessionOpen = true;
  const revoked = new Set<string>();
  const quarantined = new Set<string>();
  const issuedLeases = new WeakSet<object>();

  const authorizeCaller = (value: unknown): boolean => {
    const candidate = parseCallerContext(value);
    return (
      candidate !== null &&
      sameCaller(candidate, expectedCaller) &&
      candidate.isTopFrame &&
      candidate.capability === "schematic_reviewed.render" &&
      fixtureRegistryEnabled &&
      webContentsOpen &&
      windowOpen &&
      sessionOpen &&
      navigationEpoch === expectedCaller.navigationEpoch &&
      registryEpoch === expectedCaller.registryGeneration
    );
  };

  const begin = (
    callerValue: unknown,
    requestValue: unknown,
  ): ReviewedResolveLeaseV1 | null => {
    if (!authorizeCaller(callerValue)) return null;
    const request = parseRequest(requestValue);
    const caller = parseCallerContext(callerValue);
    if (
      request === null ||
      caller === null ||
      !sameDocumentRef(request.documentRef, expectedCaller.documentRef) ||
      !sameArtifactRef(request.artifactRef, expectedArtifactRef)
    ) {
      return null;
    }
    const lease = Object.freeze({
      caller,
      documentRef: request.documentRef,
      artifactRef: request.artifactRef,
      lifecycleEpoch,
      navigationEpoch,
      registryEpoch,
    });
    issuedLeases.add(lease);
    return lease;
  };

  const checkBeforeDelivery = (
    lease: ReviewedResolveLeaseV1,
  ): ReviewedResolveFenceDecisionV1 => {
    if (
      lease === null ||
      typeof lease !== "object" ||
      !issuedLeases.has(lease) ||
      !sameDocumentRef(lease.documentRef, expectedCaller.documentRef) ||
      !sameArtifactRef(lease.artifactRef, expectedArtifactRef)
    ) {
      return "CAPABILITY_DENIED";
    }
    const key = artifactKey(lease.artifactRef);
    if (quarantined.has(key)) return "INTERNAL";
    if (revoked.has(key)) return "REVISION_UNAVAILABLE";
    if (
      !fixtureRegistryEnabled ||
      !webContentsOpen ||
      !windowOpen ||
      !sessionOpen ||
      lease.lifecycleEpoch !== lifecycleEpoch ||
      lease.navigationEpoch !== navigationEpoch ||
      lease.registryEpoch !== registryEpoch
    ) {
      return "CAPABILITY_DENIED";
    }
    return "deliver";
  };

  return Object.freeze({
    authorizeCaller,
    begin,
    checkBeforeDelivery,
    advanceNavigation(webContentsId: number): void {
      if (webContentsId === expectedCaller.webContentsId) navigationEpoch += 1;
    },
    closeWebContents(webContentsId: number): void {
      if (webContentsId === expectedCaller.webContentsId && webContentsOpen) {
        webContentsOpen = false;
        lifecycleEpoch += 1;
      }
    },
    closeWindow(windowId: string): void {
      if (windowId === expectedCaller.windowId && windowOpen) {
        windowOpen = false;
        lifecycleEpoch += 1;
      }
    },
    closeSession(appSessionId: string): void {
      if (appSessionId === expectedCaller.appSessionId && sessionOpen) {
        sessionOpen = false;
        lifecycleEpoch += 1;
      }
    },
    disableFixtureRegistry(): void {
      if (fixtureRegistryEnabled) {
        fixtureRegistryEnabled = false;
        lifecycleEpoch += 1;
      }
    },
    advanceRegistryGeneration(): void {
      registryEpoch += 1;
    },
    revokeRevision(artifactRef: ReviewedArtifactRefV1): void {
      try {
        revoked.add(artifactKey(parseReviewedArtifactRefV1(artifactRef)));
      } catch {
        registryEpoch += 1;
      }
    },
    quarantineRevision(artifactRef: ReviewedArtifactRefV1): void {
      try {
        quarantined.add(artifactKey(parseReviewedArtifactRefV1(artifactRef)));
      } catch {
        registryEpoch += 1;
      }
    },
  });
}
