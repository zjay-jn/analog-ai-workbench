import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ReviewedArtifactRefV1,
  ReviewedDocumentRefV1,
} from "../../../../packages/document-contract/src/reviewed-identity";
import {
  GET_INFO_CHANNEL,
  type AppMode,
  type GetInfoResultV1,
} from "../shared/app-info";
import { RESOLVE_REVIEWED_ARTIFACT_CHANNEL } from "../shared/schematic/reviewed-artifact-resolve";
import { createGetInfoResult, safeError } from "./ipc/get-info-contract";
import { createResolveReviewedArtifactHandlerV1 } from "./ipc/resolve-reviewed-artifact-handler";
import { createReviewedResolveFenceV1 } from "./security/reviewed-resolve-fence";
import { isTrustedIpcCaller } from "./security/ipc-caller";
import type { ReviewedArtifactRegistryV1 } from "./schematic/reviewed-artifact-registry";
import { createWindowOptions, installWebContentsGuards } from "./window-policy";
import { createDesktopAgentHostV1, type DesktopAgentBackendV1 } from "./agent/desktop-agent-host";
import { createAgentCallerFenceV1, type AgentCallerContextV1, type AgentCapabilityV1 } from "./agent/agent-caller-fence";
import { registerAgentIpcHandlersV1 } from "./ipc/agent/register-agent-ipc";
import {registerWindowMenu} from './window-menu';
import { createInitializationShutdown, type ShutdownFailureCode, type ShutdownParticipant } from './engine-live/shutdown';

declare const __AAW_MAIN_DEVELOPMENT__: boolean;

const DEFAULT_DOCUMENT_REF = Object.freeze({
  documentId: "synthetic.schematic.flat-basic",
  revisionId: "rev-1",
  documentKind: "schematic_reviewed" as const,
});
const DEFAULT_ARTIFACT_REF = Object.freeze({
  artifactId: "synthetic.circuit-ir.flat-basic",
  revisionId: "rev-1",
  artifactKind: "circuit_ir_reviewed" as const,
});

export interface DesktopBootstrapOptionsV1 {
  readonly applicationRoot?: string;
  readonly applicationVersion?: string;
  readonly preloadEntry?: string;
  readonly registerExtension?: (context: Readonly<{
    ipcMain: typeof ipcMain;
    owner: AgentCallerContextV1;
    deriveCallerContext: (event: unknown) => AgentCallerContextV1 | null;
    /** Synchronous main-only acquisition: enroll partial cleanup before a constructor can throw. */
    registerCleanup?: (participant: ShutdownParticipant) => void;
  }>) => Readonly<{ revoke: () => void; dispose: () => void; shutdown?: () => Promise<void> }>;
  readonly onShutdownFailure?: (code: ShutdownFailureCode) => void;
  readonly buildProfile: "production" | "development";
  readonly createReviewedRegistry: (
    applicationRoot: string,
  ) => ReviewedArtifactRegistryV1;
  readonly createAgentBackend: (
    applicationRoot: string,
  ) => DesktopAgentBackendV1;
  readonly smokeMode?: boolean;
  readonly developmentUrl?: string;
  readonly reviewedBinding?: Readonly<{
    documentRef: ReviewedDocumentRefV1;
    artifactRef: ReviewedArtifactRefV1;
  }>;
}

function appOrigin(urlValue: string): string {
  try {
    return new URL(urlValue).origin;
  } catch {
    return "null";
  }
}

function modeForApp(smokeMode: boolean, isDevelopment: boolean): AppMode {
  if (smokeMode && isDevelopment) return "test";
  return isDevelopment ? "development" : "production";
}

async function runSmokeCheck(
  window: BrowserWindow,
  configuredSecurity: {
    readonly sandbox: boolean;
    readonly contextIsolation: boolean;
    readonly nodeIntegration: boolean;
    readonly webviewTag: boolean;
  },
  registrySizes: Readonly<{ agent: number; rag: number; toolBroker: number; fixture: number }>,
  resourceRequests: Readonly<Record<string, number>>,
  runtimeContexts: readonly Readonly<{ name: string; isDefault: boolean }>[],
  observation: Readonly<Record<string, unknown>>,
): Promise<void> {
  window.setSize(1366, 768);
  window.show();
  window.focus();
  window.webContents.focus();
  // Exercise real keyboard modality before inspecting :focus-visible styling.
  // Programmatic focus alone inherits mouse modality and cannot prove the ring.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rendererState = (await window.webContents.executeJavaScript(
      `(() => {
        const node = document.querySelector('[data-testid="runtime-status"]');
        const workspace = document.querySelector('.workspace-grid');
        const agentPanel = document.querySelector('.agent-panel');
        const composer = document.querySelector('.agent-composer');
        const pathbar = document.querySelector('.document-pathbar');
        const editor = document.querySelector('.cm-editor');
        const editorContent = document.querySelector('.cm-content');
        const fileCreate = document.querySelector('[aria-label="新建文件标签（客户端文件能力延期）"]');
        const methods = Object.keys(window.workbench ?? {}).sort();
        const expectedMethods = ['cancelRun','getInfo','resolveArtifact','resolveCitation','resolveReviewedArtifact','startTurn','subscribeRun'];
        const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
        const codeMirrorStyle = document.querySelector('style[nonce]');
        const schematicHost = document.querySelector('[data-schematic-workspace="true"]');
        const composerRect = composer?.getBoundingClientRect();
        const pathbarRect = pathbar?.getBoundingClientRect();
        const columnRects = Array.from(workspace?.children ?? []).map(
          (column) => column.getBoundingClientRect(),
        );
        const focusTarget = document.querySelector('.document-path-trigger');
        if (focusTarget instanceof HTMLButtonElement) focusTarget.focus({ preventScroll: true });
        const focusStyle = focusTarget ? getComputedStyle(focusTarget) : null;
        const focusRect = focusTarget?.getBoundingClientRect();
        const focusVisible = focusTarget instanceof HTMLButtonElement && document.activeElement === focusTarget &&
          focusRect.width > 2 && focusRect.height > 2 && focusRect.left >= 0 && focusRect.top >= 0 &&
          focusRect.right <= innerWidth && focusRect.bottom <= innerHeight &&
          focusStyle.visibility === 'visible' && focusStyle.display !== 'none' &&
          parseFloat(focusStyle.outlineWidth) >= 2 && !['none','hidden'].includes(focusStyle.outlineStyle) &&
          focusStyle.outlineColor !== 'transparent' && focusStyle.outlineColor !== 'rgba(0, 0, 0, 0)';
        return node ? {
          state: node.getAttribute('data-state'),
          text: node.textContent,
          hasProcess: typeof process !== 'undefined',
          hasRequire: typeof require !== 'undefined',
          styleSheetCount: document.styleSheets.length,
          styled:
            workspace !== null && agentPanel !== null &&
            getComputedStyle(workspace).display === 'grid' &&
            getComputedStyle(agentPanel).display === 'flex',
          apiExactSeven: JSON.stringify(methods) === JSON.stringify(expectedMethods),
          focusVisible,
          keyboardReachable: focusTarget instanceof HTMLButtonElement && !focusTarget.disabled && focusTarget.tabIndex === 0 && document.activeElement === focusTarget,
          ariaContract: document.querySelector('.agent-aria-polite[aria-live="polite"][aria-atomic="true"]') !== null &&
            document.querySelector('.agent-aria-status[role="status"][aria-atomic="true"]') !== null &&
            document.querySelector('.agent-composer textarea[aria-label][aria-describedby="agent-safety-label"]') !== null &&
            document.getElementById('agent-safety-label') !== null &&
            focusTarget?.getAttribute('aria-haspopup') === 'tree' && focusTarget?.getAttribute('aria-expanded') === 'false',
          focusObservation: { selector: '.document-path-trigger', active: document.activeElement === focusTarget, tabIndex: focusTarget?.tabIndex, outlineWidth: focusStyle?.outlineWidth, outlineStyle: focusStyle?.outlineStyle, outlineColor: focusStyle?.outlineColor },
          cspClosed: ["connect-src 'none'", "img-src 'none'", "font-src 'none'", "worker-src 'none'", "object-src 'none'", "frame-src 'none'"].every(token => csp.includes(token)),
          syntheticLabelVisible: (() => { const label=document.querySelector('.agent-safety-label'); if(!label)return false;const rect=label.getBoundingClientRect(),style=getComputedStyle(label);return rect.width>2&&rect.height>2&&style.clipPath==='none'&&style.visibility==='visible'&&rect.bottom<=innerHeight&&rect.right<=innerWidth; })(),
          schematicHost: schematicHost !== null,
          fixtureEditor: {
            mounted:
              editor !== null &&
              editorContent?.getAttribute('contenteditable') === 'false',
            readOnly:
              editorContent?.getAttribute('contenteditable') === 'false',
            synthetic:
              editorContent?.textContent?.includes('这是确定性的合成文本，不来自文件系统。') === true,
            fileControlsDisabled:
              fileCreate instanceof HTMLButtonElement && fileCreate.disabled,
            cspNonceApplied: codeMirrorStyle?.getAttribute('nonce')?.length >= 16
          },
          layout: {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            hasThreeColumns:
              columnRects.length === 3 &&
              columnRects.every((rect) => rect.width > 0) &&
              columnRects[0].left < columnRects[1].left &&
              columnRects[1].left < columnRects[2].left,
            noHorizontalOverflow:
              document.documentElement.scrollWidth <= window.innerWidth,
            composerVisible:
              composerRect !== undefined &&
              composerRect.top >= 0 &&
              composerRect.bottom <= window.innerHeight,
            pathVisible:
              pathbarRect !== undefined &&
              pathbarRect.top >= 0 &&
              pathbarRect.bottom <= window.innerHeight
          }
        } : null;
      })()`,
      true,
    )) as {
      state: string | null;
      fixtureEditor: { readonly mounted: boolean };
      schematicHost: boolean;
    } | null;
    if (
      rendererState?.state === "ready" &&
      rendererState.fixtureEditor.mounted &&
      rendererState.schematicHost
    ) {
      const productionRequestDenied = registrySizes.agent === 0
        ? await window.webContents.executeJavaScript(`(async () => { const result = await window.workbench.startTurn({ conversationId:'conversation.synthetic.middle-column', turnId:'turn.synthetic.middle-column.1', adapterProfileId:'profile.synthetic.deterministic', adapterProfileRevision:'rev-1', inputRefs:['input.synthetic.fixed-turn'], contextRefs:['context.synthetic.reviewed-schematic'] }); return result.ok === false && result.error.code === 'CAPABILITY_DENIED'; })()`, true) as boolean
        : null;
      const rendererMetric = app.getAppMetrics().find(metric => metric.pid === window.webContents.getOSProcessId());
      const rendererBoundary = await window.webContents.executeJavaScript("({ noNode: typeof process === 'undefined' && typeof require === 'undefined', webviewDisabled: typeof document.createElement('webview').getWebContentsId === 'undefined' })", true) as { noNode: boolean; webviewDisabled: boolean };
      console.log(
        `AAW_SMOKE_RESULT:${JSON.stringify({
          ok: true,
          rendererState,
          security: configuredSecurity,
          registrySizes,
          resourceRequests,
          observation,
          productionRequestDenied,
          runtimeContexts,
          rendererMetric: rendererMetric === undefined ? null : { type: rendererMetric.type, sandboxed: rendererMetric.sandboxed },
          runtimeSecurity: {
            sandbox: rendererMetric?.sandboxed === true,
            contextIsolation: runtimeContexts.some(context => /electron.*isolated/iu.test(context.name) && !context.isDefault),
            nodeIntegration: !rendererBoundary.noNode,
            webviewTag: !rendererBoundary.webviewDisabled,
          },
        })}`,
      );
      window.destroy();
      app.exit(0);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Renderer did not reach the ready state before the smoke deadline.");
}

export function startDesktopAppV1(options: DesktopBootstrapOptionsV1): void {
  const smokeMode = options.smokeMode === true;
  if (smokeMode) {
    app.setPath(
      "userData",
      path.join(
        app.getAppPath(),
        ".local",
        "smoke-user-data",
        `electron-${process.pid}`,
      ),
    );
    app.disableHardwareAcceleration();
  }

  let mainWindow: BrowserWindow | null = null;
  const windowShutdowns = new Set<() => Promise<void>>();
  let quitAllowed = false;
  let quitPending: Promise<void> | undefined;
  const requestQuit = (exitCode = 0): Promise<void> => {
    if (quitPending) return quitPending;
    let resolve!: () => void;
    quitPending = new Promise<void>(done => { resolve = done; });
    void Promise.allSettled([...windowShutdowns].map(shutdown => shutdown())).then(() => {
      quitAllowed = true;
      resolve();
      if (exitCode) app.exit(exitCode); else app.quit();
    });
    return quitPending;
  };

  async function createMainWindow(): Promise<void> {
    const cleanup = createInitializationShutdown({
      timeoutMs: 45_000,
      onFailure(code) { console.error(code); options.onShutdownFailure?.(code); },
    });
    const shutdownWindow = cleanup.shutdown;
    windowShutdowns.add(shutdownWindow);
    let shutdownReason: 'navigation' | 'render-process-gone' | 'window-closed' = 'window-closed';
    const ownedChannels = new Set<string>();
    const removeOwnedChannels = () => {
      let failed = false;
      for (const channel of ownedChannels) { try { ipcMain.removeHandler(channel); } catch { failed = true; } }
      if (failed) throw Error('CLOUD_SHUTDOWN_FAILED');
    };
    cleanup.register({ revoke: removeOwnedChannels, dispose: removeOwnedChannels });
    const ownedIpc = new Proxy(ipcMain, {
      get(target, property) {
        if (property === 'handle') return (...args: Parameters<typeof ipcMain.handle>) => {
          cleanup.assertOpen();
          ownedChannels.add(args[0]);
          return target.handle(...args);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
    const applicationRoot = options.applicationRoot ?? app.getAppPath();
    const registry = options.createReviewedRegistry(applicationRoot);
    const agentBackend = options.createAgentBackend(applicationRoot);
    const agentHost = createDesktopAgentHostV1({
      backend: agentBackend,
      createHostRunId: randomUUID,
    });
    const reviewedBinding = options.reviewedBinding ?? Object.freeze({
      documentRef: DEFAULT_DOCUMENT_REF,
      artifactRef: DEFAULT_ARTIFACT_REF,
    });
    const preloadPath = path.join(
      applicationRoot,
      "dist",
      "preload",
      "preload",
      options.preloadEntry ?? "index.js",
    );
    const rendererPath = path.join(
      applicationRoot,
      "dist",
      "renderer",
      "index.html",
    );
    const isDevelopment = __AAW_MAIN_DEVELOPMENT__;
    const developmentUrl = isDevelopment ? options.developmentUrl : undefined;
    let allowedFrameUrl: string;
    if (developmentUrl !== undefined) {
      const parsed = new URL(developmentUrl);
      if (
        parsed.origin !== "http://127.0.0.1:5173" ||
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== ""
      ) {
        throw new Error(
          "The development renderer URL is not on the approved loopback origin.",
        );
      }
      allowedFrameUrl = developmentUrl;
    } else {
      allowedFrameUrl = pathToFileURL(rendererPath).toString();
    }

    const windowOptions = createWindowOptions({
      preloadPath,
      isDevelopment,
      show: !smokeMode,
    });
    const configuredSecurity = {
      sandbox: windowOptions.webPreferences?.sandbox === true,
      contextIsolation: windowOptions.webPreferences?.contextIsolation === true,
      nodeIntegration: windowOptions.webPreferences?.nodeIntegration === true,
      webviewTag: windowOptions.webPreferences?.webviewTag === true,
    };
    const window = new BrowserWindow(windowOptions);
    mainWindow = window;
    const webContentsId = window.webContents.id;
    installWebContentsGuards(window.webContents);
    const smokeResourceRequests: Record<string, number> = Object.fromEntries(
      ["mainFrame", "subFrame", "stylesheet", "script", "image", "font", "object", "xhr", "ping", "cspReport", "media", "webSocket", "other"].map(type => [type, 0]),
    );
    const smokeRuntimeContexts: Array<Readonly<{ name: string; isDefault: boolean }>> = [];
    const smokeObservation = {
      installedBeforeLoad: false,
      loadStarted: false,
      permittedRequests: { mainFrame: 0, script: 0, stylesheet: 0 },
      cdpEnabled: { Runtime: false, Log: false, Audits: false },
      cdpFailures: 0,
      cdpMarkerObserved: false,
      cspViolations: 0,
      securityLogEntries: 0,
      guardEvents: { navigation: 0, webview: 0, download: 0, createdWindow: 0, rendererGone: 0 },
      guardObserversInstalled: false,
    };
    const smokeObserverEnables: Promise<void>[] = [];
    if (smokeMode) {
      const marker = `aaw-smoke-observer-${randomUUID()}`;
      window.webContents.debugger.attach("1.3");
      window.webContents.debugger.on("message", (_event, method, parameters) => {
        if (method === "Runtime.executionContextCreated") smokeRuntimeContexts.push({ name: String(parameters.context.name), isDefault: parameters.context.auxData?.isDefault === true });
        if (method === "Runtime.consoleAPICalled" && parameters.args?.some((argument: { value?: unknown }) => argument.value === marker)) smokeObservation.cdpMarkerObserved = true;
        if (method === "Audits.issueAdded" && parameters.issue?.code === "ContentSecurityPolicyIssue") smokeObservation.cspViolations += 1;
        if (method === "Log.entryAdded" && parameters.entry?.source === "security") smokeObservation.securityLogEntries += 1;
      });
      for (const domain of ["Runtime", "Log", "Audits"] as const) {
        // Do not await enable before load: an uninitialized renderer can defer its reply.
        smokeObserverEnables.push(window.webContents.debugger.sendCommand(`${domain}.enable`).then(() => {
          smokeObservation.cdpEnabled[domain] = true;
        }).catch(() => { smokeObservation.cdpFailures += 1; }));
      }
      window.webContents.once("did-finish-load", () => {
        void window.webContents.debugger.sendCommand("Runtime.evaluate", { expression: `console.debug(${JSON.stringify(marker)})` }).catch(() => { smokeObservation.cdpFailures += 1; });
      });
      // Observation only: the production guards above retain their existing behavior.
      window.webContents.on("will-navigate", () => { smokeObservation.guardEvents.navigation += 1; });
      window.webContents.on("will-attach-webview", () => { smokeObservation.guardEvents.webview += 1; });
      window.webContents.session.on("will-download", () => { smokeObservation.guardEvents.download += 1; });
      window.webContents.on("did-create-window", () => { smokeObservation.guardEvents.createdWindow += 1; });
      window.webContents.on("render-process-gone", () => { smokeObservation.guardEvents.rendererGone += 1; });
      smokeObservation.guardObserversInstalled = true;
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const allowedDocument = details.resourceType === "mainFrame" && details.url === allowedFrameUrl;
        const allowedAsset = ["script", "stylesheet"].includes(details.resourceType) && details.url.startsWith(pathToFileURL(path.dirname(rendererPath) + path.sep).toString());
        if (allowedDocument) smokeObservation.permittedRequests.mainFrame += 1;
        else if (allowedAsset) smokeObservation.permittedRequests[details.resourceType as "script" | "stylesheet"] += 1;
        if (!allowedDocument && !allowedAsset) smokeResourceRequests[details.resourceType] = (smokeResourceRequests[details.resourceType] ?? 0) + 1;
        callback({ cancel: false });
      });
      smokeObservation.installedBeforeLoad = !smokeObservation.loadStarted;
    }

    let navigationEpoch = 1;
    const registryGeneration = 1;
    const sessionId = "session.workbench.main.v1";
    const windowId = `window.${window.id}`;
    const expectedCaller = Object.freeze({
      senderId: window.webContents.id,
      isTopFrame: true,
      topFrameUrl: allowedFrameUrl,
      appOrigin: appOrigin(allowedFrameUrl),
      webContentsId: window.webContents.id,
      navigationEpoch,
      appSessionId: sessionId,
      windowId,
      documentRef: reviewedBinding.documentRef,
      capability: "schematic_reviewed.render",
      registryGeneration,
    });
    const fence = createReviewedResolveFenceV1({
      caller: expectedCaller,
      artifactRef: reviewedBinding.artifactRef,
      fixtureRegistryEnabled:
        options.buildProfile === "development" && registry.mode === "development",
    });
    cleanup.register({ revoke() { fence.closeWebContents(webContentsId); }, dispose() { fence.closeWindow(windowId); } });

    const deriveCallerContext = (eventValue: unknown) => {
      const event = eventValue as IpcMainInvokeEvent;
      const senderFrame = event.senderFrame;
      if (senderFrame === null || mainWindow !== window) return null;
      let origin: string;
      try {
        origin = new URL(senderFrame.url).origin;
      } catch {
        return null;
      }
      return Object.freeze({
        senderId: event.sender.id,
        isTopFrame: senderFrame === event.sender.mainFrame,
        topFrameUrl: senderFrame.url,
        appOrigin: origin,
        webContentsId: event.sender.id,
        navigationEpoch,
        appSessionId: sessionId,
        windowId,
        documentRef: reviewedBinding.documentRef,
        capability: "schematic_reviewed.render",
        registryGeneration,
      });
    };
    const resolveReviewedArtifact = createResolveReviewedArtifactHandlerV1({
      deriveCallerContext,
      fence,
      registry,
      createCorrelationId: randomUUID,
    });

    const callerIsTrusted = (event: IpcMainInvokeEvent): boolean => {
      const senderFrame = event.senderFrame;
      return (
        senderFrame !== null &&
        mainWindow === window &&
        isTrustedIpcCaller({
          senderId: event.sender.id,
          expectedSenderId: window.webContents.id,
          isTopFrame: senderFrame === event.sender.mainFrame,
          frameUrl: senderFrame.url,
          allowedFrameUrls: [allowedFrameUrl],
        })
      );
    };

    const agentCaller = Object.freeze({
      senderId: window.webContents.id,
      isTopFrame: true,
      appOrigin: appOrigin(allowedFrameUrl),
      navigationEpoch,
      appSessionId: sessionId,
      windowId,
      webContentsId: window.webContents.id,
      workspaceId: "workspace.main.v1",
      rootId: "root.main.v1",
    } satisfies AgentCallerContextV1);
    const agentCapabilities: readonly AgentCapabilityV1[] =
      options.buildProfile === "development"
        ? Object.freeze(["start_turn", "subscribe_run", "cancel_run", "resolve_artifact", "resolve_citation"])
        : Object.freeze([]);
    const agentInvocationFence = createAgentCallerFenceV1({
      caller: agentCaller,
      capabilities: agentCapabilities,
      generation: 1,
    });
    cleanup.register({ revoke() { agentInvocationFence.revoke({ reason: shutdownReason }); }, dispose() {} });
    const deriveAgentCallerContext = (eventValue: unknown): AgentCallerContextV1 | null => {
      const event = eventValue as IpcMainInvokeEvent;
      const senderFrame = event.senderFrame;
      if (senderFrame === null || mainWindow !== window || !callerIsTrusted(event)) return null;
      return Object.freeze({
        senderId: event.sender.id,
        isTopFrame: senderFrame === event.sender.mainFrame,
        appOrigin: appOrigin(senderFrame.url),
        navigationEpoch,
        appSessionId: sessionId,
        windowId,
        webContentsId: event.sender.id,
        workspaceId: "workspace.main.v1",
        rootId: "root.main.v1",
      });
    };
    const extension = options.registerExtension?.({ ipcMain: ownedIpc, owner: agentCaller, deriveCallerContext: deriveAgentCallerContext, registerCleanup: cleanup.register });
    if (extension) cleanup.register(extension);
    const windowMenu=process.platform==='win32'?registerWindowMenu({window,ipcMain:ownedIpc,owner:agentCaller,deriveCallerContext:deriveAgentCallerContext}):undefined;
    if (windowMenu) cleanup.register(windowMenu);
    const agentIpc = registerAgentIpcHandlersV1({
      ipcMain: ownedIpc,
      host: agentHost,
      invocationFence: agentInvocationFence,
      createSubscriptionFence: () => createAgentCallerFenceV1({
        caller: agentCaller,
        capabilities: agentCapabilities,
        generation: 1,
      }),
      deriveCallerContext: deriveAgentCallerContext,
      deriveCurrentCallerContext: () => {
        if (mainWindow !== window || window.isDestroyed() || window.webContents.isDestroyed()) return null;
        const currentUrl = window.webContents.getURL();
        if (currentUrl !== allowedFrameUrl) return null;
        return Object.freeze({
          senderId: window.webContents.id,
          isTopFrame: true,
          appOrigin: appOrigin(currentUrl),
          navigationEpoch,
          appSessionId: sessionId,
          windowId,
          webContentsId: window.webContents.id,
          workspaceId: "workspace.main.v1",
          rootId: "root.main.v1",
        });
      },
      createSubscriptionId: randomUUID,
      deliver: (channel, payload) => {
        if (!window.isDestroyed()) window.webContents.send(channel, payload);
      },
    });
    cleanup.register({ revoke() { agentIpc.revokeAll(shutdownReason); }, dispose() { agentIpc.dispose(); } });

    ownedIpc.removeHandler(GET_INFO_CHANNEL);
    ownedIpc.removeHandler(RESOLVE_REVIEWED_ARTIFACT_CHANNEL);
    ownedIpc.handle(
      GET_INFO_CHANNEL,
      (event, request: unknown): GetInfoResultV1 => {
        if (!callerIsTrusted(event)) {
          return safeError(
            "CAPABILITY_DENIED",
            "The requested capability is unavailable.",
          );
        }
        return createGetInfoResult({
          request,
          appVersion: options.applicationVersion ?? app.getVersion(),
          mode: modeForApp(smokeMode, isDevelopment),
        });
      },
    );
    ownedIpc.handle(
      RESOLVE_REVIEWED_ARTIFACT_CHANNEL,
      (event, request: unknown) => resolveReviewedArtifact(event, request),
    );

    let initialLoad = true;
    let windowCloseAllowed = false;
    window.webContents.on(
      "did-start-navigation",
      (_event, _url, _isInPlace, isMainFrame) => {
        if (!initialLoad && isMainFrame) {
          navigationEpoch += 1;
          shutdownReason = 'navigation';
          void shutdownWindow();
        }
      },
    );
    window.webContents.on("did-navigate-in-page", () => {
      if (!initialLoad) {
        navigationEpoch += 1;
        shutdownReason = 'navigation';
        void shutdownWindow();
      }
    });
    window.webContents.on("render-process-gone", () => {
      shutdownReason = 'render-process-gone';
      void shutdownWindow();
    });
    window.webContents.once("destroyed", () => {
      void shutdownWindow();
    });
    window.on('close', event => {
      if (windowCloseAllowed) return;
      event.preventDefault();
      const finish = () => {
        windowCloseAllowed = true;
        if (!window.isDestroyed()) window.close();
      };
      void shutdownWindow().then(finish, finish);
    });
    window.on("closed", () => {
      void shutdownWindow();
      if (mainWindow === window) mainWindow = null;
    });
    window.once("ready-to-show", () => {
      if (!smokeMode) window.show();
    });

    cleanup.completeConstruction();
    smokeObservation.loadStarted = true;
    if (isDevelopment && developmentUrl !== undefined) {
      await window.loadURL(developmentUrl);
    } else {
      await window.loadFile(rendererPath);
    }
    initialLoad = false;

    if (smokeMode) {
      await Promise.all(smokeObserverEnables);
      await runSmokeCheck(window, configuredSecurity, agentHost.registrySizes, smokeResourceRequests, smokeRuntimeContexts, smokeObservation);
    }
    } finally { cleanup.completeConstruction(); }
  }

  const singleInstanceLock = app.requestSingleInstanceLock();
  if (!singleInstanceLock) {
    app.quit();
    return;
  }
  app.on('before-quit', event => {
    if (quitAllowed) return;
    event.preventDefault();
    void requestQuit();
  });
  app.on("second-instance", () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createMainWindow).catch(() => {
    console.error('AAW_STARTUP_ERROR');
    void requestQuit(1);
  });
  app.on("window-all-closed", () => app.quit());
}
