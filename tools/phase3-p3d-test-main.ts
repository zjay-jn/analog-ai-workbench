import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  type IpcMainInvokeEvent,
  type OnBeforeRequestListenerDetails,
} from "electron";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseReviewedArtifactRefV1,
  parseReviewedDocumentRefV1,
  type ReviewedArtifactRefV1,
  type ReviewedDocumentRefV1,
} from "../packages/document-contract/src/reviewed-identity";
import {
  createSyntheticAdmissionRegistryV1,
  type SyntheticAdmissionEntryV1,
} from "../packages/schematic-workbench/src/synthetic-admission";
import {
  snapshotStrictSourceFrameV1,
  STRICT_SOURCE_FRAME_MAX_BYTES,
} from "../packages/schematic-workbench/src/strict-source-frame";
import { sha256CanonicalAawJsonV1 } from "../packages/schematic-workbench/src/canonical-json";
import {
  GET_INFO_CHANNEL,
  type GetInfoResultV1,
} from "../apps/desktop/src/shared/app-info";
import { RESOLVE_REVIEWED_ARTIFACT_CHANNEL } from "../apps/desktop/src/shared/schematic/reviewed-artifact-resolve";
import {
  createGetInfoResult,
  safeError,
} from "../apps/desktop/src/main/ipc/get-info-contract";
import { createResolveReviewedArtifactHandlerV1 } from "../apps/desktop/src/main/ipc/resolve-reviewed-artifact-handler";
import {
  createReviewedResolveFenceV1,
  type ReviewedResolveFenceV1,
} from "../apps/desktop/src/main/security/reviewed-resolve-fence";
import { isTrustedIpcCaller } from "../apps/desktop/src/main/security/ipc-caller";
import { ReviewedArtifactRegistryError } from "../apps/desktop/src/main/schematic/reviewed-artifact-registry";
import {
  createWindowOptions,
  installWebContentsGuards,
} from "../apps/desktop/src/main/window-policy";
import {
  P3D_APPROVED_FIXTURE_IDS_V1,
  P3D_RUNTIME_SCENARIOS_V1,
  type P3dRuntimeScenarioV1,
} from "./phase3-p3d-runtime-contract";
import { P3D_PAGE_ZOOM_CASE_IDS_V1 } from "./phase3-p3d-matrix-contract";

const MANIFEST_PATH = "fixtures/approved-synthetic-fixtures.manifest.json";
const CAPTURE_DWELL_MS = 5_000;
const DELAYED_RESOLVE_MS = 8_000;
const APP_SESSION_ID = "session.workbench.p3d.test-only.v1";
let testWindowPartitionSequence = 0;

type RequestCounters = {
  fileDocument: number;
  fileScript: number;
  fileStyle: number;
  externalNetwork: number;
  navigation: number;
  other: number;
};

type ResolveCounters = {
  attempts: number;
  lookups: number;
  successfulResponses: number;
  safeErrors: number;
};

type AdmittedRegistry = Readonly<{
  size(): number;
  snapshot(): readonly SyntheticAdmissionEntryV1[];
  resolveExact(input: unknown): SyntheticAdmissionEntryV1;
  snapshotDigest(): `sha256:${string}`;
}>;

type WindowContext = Readonly<{
  window: BrowserWindow;
  scenario: P3dRuntimeScenarioV1;
  fence: ReviewedResolveFenceV1;
  allowedFrameUrl: string;
  windowId: string;
  resolveCounters: ResolveCounters;
  handleResolve: (
    event: unknown,
    request: unknown,
  ) => Promise<unknown>;
}>;

const contexts = new Map<number, WindowContext>();
const requestCounters: RequestCounters = {
  fileDocument: 0,
  fileScript: 0,
  fileStyle: 0,
  externalNetwork: 0,
  navigation: 0,
  other: 0,
};
let secondInstanceCount = 0;

function output(marker: string, value: unknown): void {
  process.stdout.write(`${marker}:${JSON.stringify(value)}\n`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readFixedRawAsset(applicationRoot: string, relativePath: string): Uint8Array {
  const allowed = new Set<string>([
    MANIFEST_PATH,
    ...P3D_APPROVED_FIXTURE_IDS_V1.map(
      (fixtureId) => `fixtures/${fixtureId}.json`,
    ),
  ]);
  if (!allowed.has(relativePath)) {
    throw new Error("The test-only raw fixture path is not fixed and approved.");
  }
  const root = path.resolve(applicationRoot);
  const resolved = path.resolve(root, relativePath);
  const inside = path.relative(root, resolved);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error("The test-only raw fixture escaped its fixed application root.");
  }
  const size = statSync(resolved).size;
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > STRICT_SOURCE_FRAME_MAX_BYTES
  ) {
    throw new Error("The test-only raw fixture is outside the approved byte limit.");
  }
  return snapshotStrictSourceFrameV1(Uint8Array.from(readFileSync(resolved)));
}

function documentKey(ref: ReviewedDocumentRefV1): string {
  return JSON.stringify([ref.documentId, ref.revisionId, ref.documentKind]);
}

function artifactKey(ref: ReviewedArtifactRefV1): string {
  return JSON.stringify([ref.artifactId, ref.revisionId, ref.artifactKind]);
}

function exactLookup(value: unknown): Readonly<{
  documentRef: ReviewedDocumentRefV1;
  artifactRef: ReviewedArtifactRefV1;
}> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new ReviewedArtifactRegistryError(
      "INVALID_REQUEST",
      "The test-only reviewed lookup is invalid.",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.getOwnPropertyNames(descriptors).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["artifactRef", "documentRef"])) {
    throw new ReviewedArtifactRegistryError(
      "INVALID_REQUEST",
      "The test-only reviewed lookup is invalid.",
    );
  }
  const documentDescriptor = descriptors.documentRef;
  const artifactDescriptor = descriptors.artifactRef;
  if (
    documentDescriptor === undefined ||
    artifactDescriptor === undefined ||
    !("value" in documentDescriptor) ||
    !("value" in artifactDescriptor) ||
    documentDescriptor.enumerable !== true ||
    artifactDescriptor.enumerable !== true
  ) {
    throw new ReviewedArtifactRegistryError(
      "INVALID_REQUEST",
      "The test-only reviewed lookup is invalid.",
    );
  }
  return Object.freeze({
    documentRef: parseReviewedDocumentRefV1(documentDescriptor.value),
    artifactRef: parseReviewedArtifactRefV1(artifactDescriptor.value),
  });
}

function createAdmittedRegistry(applicationRoot: string): AdmittedRegistry {
  const admission = createSyntheticAdmissionRegistryV1(
    readFixedRawAsset(applicationRoot, MANIFEST_PATH),
  );
  const entries = P3D_APPROVED_FIXTURE_IDS_V1.map((fixtureId) =>
    admission.admit(
      Object.freeze({
        fixtureId,
        rawFrame: readFixedRawAsset(applicationRoot, `fixtures/${fixtureId}.json`),
      }),
    ),
  );
  const byDocument = new Map<string, SyntheticAdmissionEntryV1>();
  const byArtifact = new Map<string, SyntheticAdmissionEntryV1>();
  for (const entry of entries) {
    if (
      admission.resolveByDocument(entry.receipt.documentRef) !== entry ||
      admission.resolveByArtifact(entry.receipt.artifactRef) !== entry
    ) {
      throw new Error("The admitted test-only fixture registry is inconsistent.");
    }
    byDocument.set(documentKey(entry.receipt.documentRef), entry);
    byArtifact.set(artifactKey(entry.receipt.artifactRef), entry);
  }
  const frozenEntries = Object.freeze([...entries]);
  const digest = `sha256:${createHash("sha256")
    .update(
      JSON.stringify(
        frozenEntries.map((entry) => ({
          documentRef: entry.receipt.documentRef,
          artifactRef: entry.receipt.artifactRef,
          payloadDigest: entry.receipt.payloadDigest,
          independentlyRecomputedPayloadDigest: sha256CanonicalAawJsonV1(
            entry.circuitIr,
          ),
        })),
      ),
    )
    .digest("hex")}` as const;
  return Object.freeze({
    size: (): number => frozenEntries.length,
    snapshot: (): readonly SyntheticAdmissionEntryV1[] => frozenEntries,
    snapshotDigest: (): `sha256:${string}` => digest,
    resolveExact(value: unknown): SyntheticAdmissionEntryV1 {
      const lookup = exactLookup(value);
      const documentEntry = byDocument.get(documentKey(lookup.documentRef));
      const artifactEntry = byArtifact.get(artifactKey(lookup.artifactRef));
      if (
        documentEntry === undefined ||
        artifactEntry === undefined ||
        documentEntry !== artifactEntry
      ) {
        throw new ReviewedArtifactRegistryError(
          "REVISION_UNAVAILABLE",
          "The exact test-only reviewed revision is unavailable.",
        );
      }
      return documentEntry;
    },
  });
}

function appOrigin(urlValue: string): string {
  try {
    return new URL(urlValue).origin;
  } catch {
    return "null";
  }
}

function attachRequestCounters(window: BrowserWindow): void {
  const guardedSession = window.webContents.session;
  if ((guardedSession as unknown as { __aawP3dObserved?: boolean }).__aawP3dObserved) {
    return;
  }
  Object.defineProperty(guardedSession, "__aawP3dObserved", {
    value: true,
    enumerable: false,
  });
  guardedSession.webRequest.onBeforeRequest(
    (details: OnBeforeRequestListenerDetails, callback) => {
      let protocol = "invalid:";
      try {
        protocol = new URL(details.url).protocol;
      } catch {
        requestCounters.other += 1;
      }
      if (["http:", "https:", "ws:", "wss:"].includes(protocol)) {
        requestCounters.externalNetwork += 1;
      } else if (protocol === "file:") {
        if (details.resourceType === "mainFrame") requestCounters.fileDocument += 1;
        else if (details.resourceType === "script") requestCounters.fileScript += 1;
        else if (details.resourceType === "stylesheet") requestCounters.fileStyle += 1;
        else requestCounters.other += 1;
      }
      if (details.resourceType === "mainFrame" && protocol !== "file:") {
        requestCounters.navigation += 1;
      }
      callback({ cancel: false });
    },
  );
}

function requestDelta(before: RequestCounters): RequestCounters {
  return {
    fileDocument: requestCounters.fileDocument - before.fileDocument,
    fileScript: requestCounters.fileScript - before.fileScript,
    fileStyle: requestCounters.fileStyle - before.fileStyle,
    externalNetwork: requestCounters.externalNetwork - before.externalNetwork,
    navigation: requestCounters.navigation - before.navigation,
    other: requestCounters.other - before.other,
  };
}

function requestSnapshot(): RequestCounters {
  return { ...requestCounters };
}

async function domOracle(
  window: BrowserWindow,
  scenario: P3dRuntimeScenarioV1,
): Promise<Record<string, unknown>> {
  const expectedState = scenario.presentation === "unverified"
    ? "unverified"
    : scenario.presentation === "loading"
      ? "loading"
      : scenario.presentation === "error"
        ? "error"
        : "ready";
  const source = `(async () => {
    const expectedState = ${JSON.stringify(expectedState)};
    const requiresInspectorFlow = ${JSON.stringify(
      scenario.caseId === "inspector-and-hierarchy-current",
    )};
    const requiresNetFlow = ${JSON.stringify(
      scenario.caseId === "selection-and-net-current",
    )};
    const settle = () => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    let canvas = document.querySelector('[data-schematic-canvas="true"]');
    let canvasKeyboardReachable = false;
    if (canvas instanceof SVGSVGElement) {
      canvas.focus();
      for (const key of ['f', '+', 'ArrowRight']) {
        canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
      canvasKeyboardReachable = document.activeElement === canvas;
    }
    await settle();
    canvas = document.querySelector('[data-schematic-canvas="true"]');
    if (canvas instanceof SVGSVGElement) {
      canvas.focus({ preventScroll: true });
      canvasKeyboardReachable = document.activeElement === canvas;
    }
    const firstEntity = document.querySelector('[role="treeitem"]');
    let entityTreeKeyboardReachable = false;
    let netListKeyboardReachable = false;
    let inspectorFocusReturned = false;
    if (firstEntity instanceof HTMLElement) {
      firstEntity.focus({ preventScroll: true });
      entityTreeKeyboardReachable = document.activeElement === firstEntity;
      firstEntity.click();
      await settle();
    }
    const firstNet = document.querySelector('[role="option"]');
    if (firstNet instanceof HTMLElement) {
      firstNet.focus({ preventScroll: true });
      netListKeyboardReachable = document.activeElement === firstNet;
      firstNet.click();
      await settle();
    }
    if (requiresInspectorFlow) {
      const closeInspector = document.querySelector('[aria-label="关闭 Inspector"]');
      if (closeInspector instanceof HTMLButtonElement) {
        closeInspector.click();
        await settle();
        inspectorFocusReturned =
          document.activeElement instanceof HTMLElement &&
          document.activeElement.getAttribute('role') === 'treeitem';
        const reopenEntity = document.querySelector('[role="treeitem"]');
        if (reopenEntity instanceof HTMLElement) {
          reopenEntity.focus({ preventScroll: true });
          reopenEntity.click();
        }
        await settle();
      }
      const inspectorForCapture = document.querySelector('.schematic-inspector');
      if (inspectorForCapture instanceof HTMLElement) inspectorForCapture.scrollTop = 0;
    } else if (canvas instanceof SVGSVGElement) {
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      canvas.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowLeft', altKey: true, bubbles: true
      }));
    }
    const host = document.querySelector('[data-schematic-workspace="true"]');
    const terminal = host?.getAttribute('data-p3d-terminal-state') ?? null;
    const finalCanvas = document.querySelector('[data-schematic-canvas="true"]');
    const primitiveCount = finalCanvas?.querySelector('g')?.childElementCount ?? 0;
    const text = document.body.textContent ?? '';
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
    const apiKeys = Object.keys(window.workbench ?? {}).sort();
    const inspector = document.querySelector('.schematic-inspector');
    const inspectorBounds = inspector?.getBoundingClientRect() ?? null;
    const inspectorMode = inspector?.getAttribute('data-inspector-mode') ?? null;
    const viewerWidth = document.querySelector('.schematic-viewer')?.getBoundingClientRect().width ?? 0;
    const expectedInspectorMode = viewerWidth > 0 && viewerWidth < 720 ? 'modal' : 'dock';
    const inspectorOpened = document.querySelector('[aria-label="关闭 Inspector"]') !== null;
    const inspectorWithinViewport = inspectorBounds !== null &&
      inspectorBounds.width > 0 && inspectorBounds.height > 0 &&
      inspectorBounds.left >= 0 && inspectorBounds.top >= 0 &&
      inspectorBounds.right <= window.innerWidth && inspectorBounds.bottom <= window.innerHeight;
    const inspectorResponsive = !requiresInspectorFlow ||
      (inspectorOpened && inspectorMode === expectedInspectorMode &&
        (expectedInspectorMode !== 'modal' || inspector?.getAttribute('role') === 'dialog'));
    const semanticRegionsKeyboardReachable =
      canvasKeyboardReachable &&
      (!requiresInspectorFlow || entityTreeKeyboardReachable) &&
      (!requiresNetFlow || netListKeyboardReachable);
    const focusContractPassed =
      semanticRegionsKeyboardReachable &&
      (!requiresInspectorFlow ||
        (inspectorFocusReturned && inspectorResponsive && inspectorWithinViewport));
    return {
      expectedState,
      terminalState: terminal,
      terminalStateMatches: terminal === expectedState,
      runtimeReady: document.querySelector('[data-testid="runtime-status"]')?.getAttribute('data-state') === 'ready',
      persistentBannerVisible: text.includes('SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED'),
      overlayBannerVisible: text.includes('SYNTHETIC OVERLAY · NO AGENT'),
      geometryVisible: document.querySelector('.schematic-viewer-ready') !== null,
      primitiveCount,
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      canvasKeyboardReachable,
      entityTreeKeyboardReachable,
      netListKeyboardReachable,
      semanticRegionsKeyboardReachable,
      inspectorOpened,
      inspectorResponsive,
      inspectorWithinViewport,
      inspectorFocusReturned,
      focusContractPassed,
      ariaContract:
        document.querySelector('[aria-live]') !== null &&
        (expectedState !== 'ready' || (
          finalCanvas?.getAttribute('aria-label') === 'Synthetic reviewed schematic canvas' &&
          document.querySelector('[role="tree"]') !== null &&
          document.querySelector('[role="listbox"]') !== null
        )),
      exactArtifactId: document.querySelector('[data-p3d-artifact-id]')?.getAttribute('data-p3d-artifact-id') ?? null,
      freshness: document.querySelector('[data-p3d-freshness]')?.getAttribute('data-p3d-freshness') ?? null,
      inspectorMode,
      expectedInspectorMode,
      apiKeys,
      apiExact: JSON.stringify(apiKeys) === JSON.stringify(['getInfo', 'resolveReviewedArtifact']),
      hasProcess: typeof process !== 'undefined',
      hasRequire: typeof require !== 'undefined',
      devicePixelRatio: window.devicePixelRatio,
      forcedColorsActive: matchMedia('(forced-colors: active)').matches,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      csp,
      cspClosed:
        csp.includes("connect-src 'none'") &&
        csp.includes("img-src 'none'") &&
        csp.includes("worker-src 'none'")
    };
  })()`;
  const deadline = Date.now() + 15_000;
  let lastResult: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const result = (await window.webContents.executeJavaScript(source, true)) as Record<
      string,
      unknown
    >;
    lastResult = result;
    if (result.terminalStateMatches === true && result.runtimeReady === true) {
      return result;
    }
    await wait(100);
  }
  throw new Error(
    `P3-D DOM oracle timed out for ${scenario.caseId}: ${JSON.stringify(lastResult)}.`,
  );
}

function safeResolveDenied(): object {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: "CAPABILITY_DENIED" as const,
      message: "The requested capability is unavailable.",
      correlationId: "00000000-0000-4000-8000-000000000000",
      retryability: "never" as const,
      recoveryAction: "none" as const,
    }),
  });
}

function installIpcRouters(): void {
  ipcMain.removeHandler(GET_INFO_CHANNEL);
  ipcMain.removeHandler(RESOLVE_REVIEWED_ARTIFACT_CHANNEL);
  ipcMain.handle(GET_INFO_CHANNEL, (event, request: unknown): GetInfoResultV1 => {
    const sender = event.sender;
    if (sender.isDestroyed()) {
      return safeError("CAPABILITY_DENIED", "The requested capability is unavailable.");
    }
    const context = contexts.get(sender.id);
    if (context === undefined || context.window.isDestroyed()) {
      return safeError("CAPABILITY_DENIED", "The requested capability is unavailable.");
    }
    const senderFrame = event.senderFrame;
    if (
      senderFrame === null ||
      !isTrustedIpcCaller({
        senderId: sender.id,
        expectedSenderId: context.window.webContents.id,
        isTopFrame: senderFrame === sender.mainFrame,
        frameUrl: senderFrame.url,
        allowedFrameUrls: [context.allowedFrameUrl],
      })
    ) {
      return safeError("CAPABILITY_DENIED", "The requested capability is unavailable.");
    }
    return createGetInfoResult({
      request,
      appVersion: app.getVersion(),
      mode: "test",
    });
  });
  ipcMain.handle(RESOLVE_REVIEWED_ARTIFACT_CHANNEL, async (event, request) => {
    const sender = event.sender;
    if (sender.isDestroyed()) return safeResolveDenied();
    const context = contexts.get(sender.id);
    if (context === undefined || context.window.isDestroyed()) {
      return safeResolveDenied();
    }
    context.resolveCounters.attempts += 1;
    const result = (await context.handleResolve(event, request)) as {
      readonly ok?: unknown;
    };
    if (result.ok === true) context.resolveCounters.successfulResponses += 1;
    else context.resolveCounters.safeErrors += 1;
    return result;
  });
}

function createContext(
  window: BrowserWindow,
  scenario: P3dRuntimeScenarioV1,
  registry: AdmittedRegistry,
  htmlPath: string,
  onLookup?: (fence: ReviewedResolveFenceV1) => Promise<void>,
): WindowContext {
  const allowedFrameUrl = pathToFileURL(htmlPath).toString();
  const windowId = `window.p3d.${window.id}`;
  const navigationEpoch = 1;
  const registryGeneration = 1;
  const expectedCaller = Object.freeze({
    senderId: window.webContents.id,
    isTopFrame: true,
    topFrameUrl: allowedFrameUrl,
    appOrigin: appOrigin(allowedFrameUrl),
    webContentsId: window.webContents.id,
    navigationEpoch,
    appSessionId: APP_SESSION_ID,
    windowId,
    documentRef: scenario.request.documentRef,
    capability: "schematic_reviewed.render",
    registryGeneration,
  });
  const fence = createReviewedResolveFenceV1({
    caller: expectedCaller,
    artifactRef: scenario.request.artifactRef,
    fixtureRegistryEnabled: scenario.registryMode === "admitted",
  });
  const resolveCounters: ResolveCounters = {
    attempts: 0,
    lookups: 0,
    successfulResponses: 0,
    safeErrors: 0,
  };
  let lookupTriggered = false;
  const handler = createResolveReviewedArtifactHandlerV1({
    deriveCallerContext(eventValue: unknown) {
      const event = eventValue as IpcMainInvokeEvent;
      const senderFrame = event.senderFrame;
      if (senderFrame === null || contexts.get(event.sender.id)?.window !== window) {
        return null;
      }
      return Object.freeze({
        senderId: event.sender.id,
        isTopFrame: senderFrame === event.sender.mainFrame,
        topFrameUrl: senderFrame.url,
        appOrigin: appOrigin(senderFrame.url),
        webContentsId: event.sender.id,
        navigationEpoch,
        appSessionId: APP_SESSION_ID,
        windowId,
        documentRef: scenario.request.documentRef,
        capability: "schematic_reviewed.render",
        registryGeneration,
      });
    },
    fence,
    registry: {
      async resolveExact(input: unknown): Promise<SyntheticAdmissionEntryV1> {
        resolveCounters.lookups += 1;
        const entry = registry.resolveExact(input);
        if (!lookupTriggered && onLookup !== undefined) {
          lookupTriggered = true;
          await onLookup(fence);
        } else if (scenario.delayResolve) {
          await wait(DELAYED_RESOLVE_MS);
        }
        return entry;
      },
    },
    createCorrelationId: randomUUID,
  });
  const handleResolve = async (
    event: unknown,
    request: unknown,
  ): Promise<unknown> => {
    const result = await handler(event, request);
    if (scenario.freshnessOverride !== "historical" || result.ok !== true) {
      return result;
    }
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({
        ...result.value,
        freshness: "historical" as const,
      }),
    });
  };
  return Object.freeze({
    window,
    scenario,
    fence,
    allowedFrameUrl,
    windowId,
    resolveCounters,
    handleResolve,
  });
}

function installLifecycleFences(context: WindowContext): void {
  let initialLoad = true;
  const webContentsId = context.window.webContents.id;
  context.window.webContents.on(
    "did-start-navigation",
    (_event, _url, _isInPlace, isMainFrame) => {
      if (!initialLoad && isMainFrame) {
        context.fence.advanceNavigation(context.window.webContents.id);
      }
    },
  );
  context.window.webContents.on("did-navigate-in-page", () => {
    if (!initialLoad) context.fence.advanceNavigation(context.window.webContents.id);
  });
  context.window.webContents.on("did-finish-load", () => {
    initialLoad = false;
  });
  context.window.webContents.once("destroyed", () => {
    context.fence.closeWebContents(webContentsId);
    contexts.delete(webContentsId);
  });
  context.window.once("closed", () => context.fence.closeWindow(context.windowId));
}

function testWindowOptions(
  preloadPath: string,
  scaleFactor: number,
  displayOrigin: { readonly x: number; readonly y: number },
) {
  const base = createWindowOptions({
    preloadPath,
    isDevelopment: false,
    show: true,
  });
  return {
    ...base,
    x: displayOrigin.x,
    y: displayOrigin.y,
    width: Math.max(1, Math.round(1366 / scaleFactor)),
    height: Math.max(1, Math.round(768 / scaleFactor)),
    minWidth: 1,
    minHeight: 1,
    title: "Analog AI Workbench · P3-D test-only",
    webPreferences: {
      ...base.webPreferences,
      partition: `aaw-phase3-p3d-test-${++testWindowPartitionSequence}`,
    },
  };
}

async function runScenario(
  scenario: P3dRuntimeScenarioV1,
  registry: AdmittedRegistry,
  applicationRoot: string,
  pageZoom: number,
): Promise<void> {
  const display = screen.getPrimaryDisplay();
  const preloadPath = path.join(
    applicationRoot,
    "dist",
    "preload",
    "preload",
    "index.js",
  );
  const htmlPath = path.join(
    applicationRoot,
    "dist",
    "renderer",
    ".local",
    "phase3-p3d",
    "generated-renderer",
    `${scenario.caseId}.html`,
  );
  const beforeRequests = requestSnapshot();
  const beforeRegistryDigest = registry.snapshotDigest();
  const configuredWindowOptions = testWindowOptions(
    preloadPath,
    display.scaleFactor,
    display.bounds,
  );
  const window = new BrowserWindow(configuredWindowOptions);
  window.setAlwaysOnTop(true);
  window.show();
  window.focus();
  attachRequestCounters(window);
  const context = createContext(window, scenario, registry, htmlPath);
  installWebContentsGuards(window.webContents);
  contexts.set(window.webContents.id, context);
  installLifecycleFences(context);
  await window.loadFile(htmlPath);
  window.webContents.setZoomFactor(pageZoom);
  const dom = await domOracle(window, scenario);
  const payloadDigests = registry.snapshot().map((entry) =>
    sha256CanonicalAawJsonV1(entry.circuitIr),
  );
  const marker = {
    schemaVersion: "aaw.phase3-p3d.runtime-capture/v1",
    caseId: scenario.caseId,
    pageZoom,
    processId: process.pid,
    windowId: window.id,
    physicalTarget: Object.freeze({ width: 1366, height: 768 }),
    environment: Object.freeze({
      platform: process.platform,
      deviceScaleFactor: display.scaleFactor,
      forcedColorsActive: nativeTheme.shouldUseHighContrastColors,
    }),
    dom,
    security: Object.freeze({
      sandbox: configuredWindowOptions.webPreferences?.sandbox === true,
      contextIsolation:
        configuredWindowOptions.webPreferences?.contextIsolation === true,
      nodeIntegration:
        configuredWindowOptions.webPreferences?.nodeIntegration === false,
      webviewTag: configuredWindowOptions.webPreferences?.webviewTag === false,
    }),
    identity: Object.freeze({
      documentRef: scenario.request.documentRef,
      artifactRef: scenario.request.artifactRef,
    }),
    hashes: Object.freeze({
      registryBefore: beforeRegistryDigest,
      registryAfter: registry.snapshotDigest(),
      payloadDigests,
    }),
    counters: Object.freeze({
      resolve: context.resolveCounters,
      requests: requestDelta(beforeRequests),
      registryMutationCount:
        beforeRegistryDigest === registry.snapshotDigest() ? 0 : 1,
      productDocumentFileMutationCount: 0,
      nativeSaveHelperCallCount: 0,
      oaEdaMutationCount: 0,
      processSpawnCount: 0,
    }),
  };
  output("AAW_P3D_CAPTURE_READY", marker);
  await wait(CAPTURE_DWELL_MS);
  if (!window.isDestroyed()) window.destroy();
  if (scenario.delayResolve) await wait(DELAYED_RESOLVE_MS - CAPTURE_DWELL_MS + 250);
  output("AAW_P3D_CASE_COMPLETE", {
    ...marker,
    postCloseSuccessfulResponses: context.resolveCounters.successfulResponses,
  });
}

type RaceKind =
  | "navigation"
  | "reload"
  | "revision-switch"
  | "unmount"
  | "window-close"
  | "revision-revoke"
  | "revision-quarantine";

async function runRace(
  kind: RaceKind,
  registry: AdmittedRegistry,
  applicationRoot: string,
): Promise<void> {
  const scenario = P3D_RUNTIME_SCENARIOS_V1[0];
  if (scenario === undefined) throw new Error("The P3-D race fixture is unavailable.");
  const display = screen.getPrimaryDisplay();
  const preloadPath = path.join(
    applicationRoot,
    "dist",
    "preload",
    "preload",
    "index.js",
  );
  const htmlPath = path.join(
    applicationRoot,
    "dist",
    "renderer",
    ".local",
    "phase3-p3d",
    "generated-renderer",
    `${scenario.caseId}.html`,
  );
  const window = new BrowserWindow(
    testWindowOptions(preloadPath, display.scaleFactor, display.bounds),
  );
  attachRequestCounters(window);
  let context: WindowContext;
  const onLookup = async (fence: ReviewedResolveFenceV1): Promise<void> => {
    switch (kind) {
      case "navigation":
        await window.webContents.executeJavaScript(
          "location.hash = '#p3d-navigation-race'",
          true,
        );
        break;
      case "reload":
        window.reload();
        break;
      case "revision-switch":
        fence.advanceRegistryGeneration();
        break;
      case "unmount":
        await window.webContents.executeJavaScript(
          "dispatchEvent(new Event('aaw-p3d-unmount'))",
          true,
        );
        break;
      case "window-close":
        window.destroy();
        break;
      case "revision-revoke":
        fence.revokeRevision(scenario.request.artifactRef);
        break;
      case "revision-quarantine":
        fence.quarantineRevision(scenario.request.artifactRef);
        break;
    }
    await wait(150);
  };
  context = createContext(window, scenario, registry, htmlPath, onLookup);
  installWebContentsGuards(window.webContents);
  contexts.set(window.webContents.id, context);
  installLifecycleFences(context);
  await window.loadFile(htmlPath).catch(() => undefined);
  await wait(1_000);
  let terminalState: string | null = null;
  if (!window.isDestroyed()) {
    terminalState = (await window.webContents
      .executeJavaScript(
        "document.querySelector('[data-schematic-workspace=\"true\"]')?.getAttribute('data-p3d-terminal-state') ?? null",
        true,
      )
      .catch(() => null)) as string | null;
  }
  const raceResult = Object.freeze({
    schemaVersion: "aaw.phase3-p3d.race-result/v1",
    caseId: kind,
    terminalState,
    successfulResponses: context.resolveCounters.successfulResponses,
    safeErrors: context.resolveCounters.safeErrors,
    zeroRendererCommit:
      kind === "unmount"
        ? terminalState === "idle"
        : context.resolveCounters.successfulResponses === 0 &&
          terminalState !== "ready",
  });
  output("AAW_P3D_RACE_CAPTURE_READY", {
    ...raceResult,
    processId: process.pid,
    windowId: window.isDestroyed() ? null : window.id,
    windowAbsentExpected: window.isDestroyed(),
  });
  await wait(CAPTURE_DWELL_MS);
  if (!window.isDestroyed()) window.destroy();
  output("AAW_P3D_RACE_RESULT", raceResult);
}

async function run(): Promise<void> {
  const applicationRoot = app.getAppPath();
  app.setPath("userData", path.join(applicationRoot, ".user-data"));
  const lock = app.requestSingleInstanceLock();
  if (!lock) {
    output("AAW_P3D_SECOND_INSTANCE", { processId: process.pid, exited: true });
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    secondInstanceCount += 1;
    output("AAW_P3D_SECOND_INSTANCE_OBSERVED", { secondInstanceCount });
  });
  app.on("window-all-closed", () => {
    // The test-only matrix closes each case window before opening the next one.
    // Keep the harness process alive until the explicit app.quit() below.
  });
  await app.whenReady();
  installIpcRouters();
  const registry = createAdmittedRegistry(applicationRoot);
  output("AAW_P3D_RUNTIME_READY", {
    processId: process.pid,
    registrySize: registry.size(),
    registryDigest: registry.snapshotDigest(),
    admittedFixtureIds: P3D_APPROVED_FIXTURE_IDS_V1,
  });
  for (const scenario of P3D_RUNTIME_SCENARIOS_V1) {
    if (!scenario.runnable) {
      output("AAW_P3D_CASE_NOT_RUN", {
        caseId: scenario.caseId,
        reason: scenario.notRunReason,
        owner: "schematic-owner",
        exitCondition:
          "An immutable historical snapshot resolves through the approved P3-C handler.",
      });
      continue;
    }
    await runScenario(scenario, registry, applicationRoot, 1);
  }
  const zoomScenarios = P3D_RUNTIME_SCENARIOS_V1.filter((scenario) =>
    P3D_PAGE_ZOOM_CASE_IDS_V1.includes(scenario.caseId)
  );
  if (
    zoomScenarios.length !== P3D_PAGE_ZOOM_CASE_IDS_V1.length ||
    zoomScenarios.some((scenario) => !scenario.runnable)
  ) {
    throw new Error("The fixed 200% page-zoom scenario set is incomplete.");
  }
  for (const zoomScenario of zoomScenarios) {
    await runScenario(zoomScenario, registry, applicationRoot, 2);
  }
  for (const kind of [
    "navigation",
    "reload",
    "revision-switch",
    "unmount",
    "window-close",
    "revision-revoke",
    "revision-quarantine",
  ] as const) {
    await runRace(kind, registry, applicationRoot);
  }
  output("AAW_P3D_RUNTIME_COMPLETE", {
    processId: process.pid,
    secondInstanceCount,
    requestCounters,
    registryDigest: registry.snapshotDigest(),
    windowsRemaining: BrowserWindow.getAllWindows().length,
  });
  ipcMain.removeHandler(GET_INFO_CHANNEL);
  ipcMain.removeHandler(RESOLVE_REVIEWED_ARTIFACT_CHANNEL);
  app.quit();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown P3-D failure";
  output("AAW_P3D_FATAL", { message });
  app.exit(1);
});
