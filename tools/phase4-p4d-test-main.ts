import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256CanonicalAawJsonV1 } from "../packages/schematic-workbench/src/canonical-json";
import { parseCanonicalEventV1 } from "../packages/agent-adapters/src/canonical-contract";
import { createDevelopmentSyntheticAgentBackendV1 } from "../apps/desktop/src/main/agent/development-synthetic-agent-backend";
import { createDesktopAgentHostV1 } from "../apps/desktop/src/main/agent/desktop-agent-host";
import {
  createAgentCallerFenceV1,
  type AgentCallerContextV1,
  type AgentCapabilityV1,
} from "../apps/desktop/src/main/agent/agent-caller-fence";
import { registerAgentIpcHandlersV1 } from "../apps/desktop/src/main/ipc/agent/register-agent-ipc";
import { createGetInfoResult, safeError } from "../apps/desktop/src/main/ipc/get-info-contract";
import { isTrustedIpcCaller } from "../apps/desktop/src/main/security/ipc-caller";
import { createWindowOptions, installWebContentsGuards } from "../apps/desktop/src/main/window-policy";
import { GET_INFO_CHANNEL } from "../apps/desktop/src/shared/app-info";
import { RESOLVE_REVIEWED_ARTIFACT_CHANNEL } from "../apps/desktop/src/shared/schematic/reviewed-artifact-resolve";
import type { P4dAgentCaseV1, P4dLifecycleCaseV1 } from "./phase4-p4d-matrix-contract";

const CAPTURE_DWELL_MS = 6_000;
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const AGENT_MANIFEST_PATH = "packages/agent-adapters/fixtures/approved-synthetic-agent-fixtures.manifest.json";
const AGENT_MANIFEST_SHA256 = "c71c984e1ae1b8500a55a6ddba67788d5c05e4cce51a7ec4670aa01325a88e8c";
const AGENT_SOURCE_PATHS = Object.freeze([
  "packages/agent-adapters/fixtures/source-events/message-delta.json",
  "packages/agent-adapters/fixtures/source-events/run-completed.json",
  "packages/agent-adapters/fixtures/source-events/citation-text.json",
  "packages/agent-adapters/fixtures/source-events/citation-schematic.json",
  "packages/agent-adapters/fixtures/source-events/citation-rag.json",
  "packages/agent-adapters/fixtures/source-events/invalid-source-time.json",
  "packages/agent-adapters/fixtures/source-events/cancel-acknowledged.json",
  "packages/agent-adapters/fixtures/source-events/run-failed.json",
] as const);
const FIXED_PATHS: readonly string[] = Object.freeze([AGENT_MANIFEST_PATH, ...AGENT_SOURCE_PATHS]);
const HOST_RUN_ID = "host.p4d.run.1";

type P4dKind = "visual" | "lifecycle";
type P4dCase = P4dAgentCaseV1["caseId"] | P4dLifecycleCaseV1["caseId"];

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function output(marker: string, value: unknown): void {
  process.stdout.write(`${marker}:${JSON.stringify(value)}\n`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appOrigin(value: string): string {
  try { return new URL(value).origin; } catch { return "null"; }
}

function readFixedRawAsset(applicationRoot: string, relativePath: string): Uint8Array {
  if (!FIXED_PATHS.includes(relativePath)) throw new Error("The P4-D raw fixture path is not approved.");
  const root = path.resolve(applicationRoot);
  const absolutePath = path.resolve(root, relativePath);
  const inside = path.relative(root, absolutePath);
  if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("The P4-D raw fixture escaped the harness root.");
  const size = statSync(absolutePath).size;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RAW_BYTES) throw new Error("The P4-D raw fixture exceeds its fixed byte budget.");
  return Uint8Array.from(readFileSync(absolutePath));
}

function loadApprovedAgentFrames(applicationRoot: string): readonly Uint8Array[] {
  const manifestRaw = readFixedRawAsset(applicationRoot, AGENT_MANIFEST_PATH);
  if (createHash("sha256").update(manifestRaw).digest("hex") !== AGENT_MANIFEST_SHA256) throw new Error("The P4-D Agent manifest pin is unavailable.");
  const manifest = JSON.parse(Buffer.from(manifestRaw).toString("utf8")) as { entries?: unknown };
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== 9) throw new Error("The P4-D Agent manifest is invalid.");
  const frames = new Map<string, Uint8Array>();
  for (const value of manifest.entries) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("The P4-D Agent manifest entry is invalid.");
    const entry = value as { path?: unknown; rawSha256?: unknown; byteLength?: unknown };
    if (typeof entry.path !== "string" || !AGENT_SOURCE_PATHS.includes(entry.path as typeof AGENT_SOURCE_PATHS[number]) || typeof entry.rawSha256 !== "string" || !Number.isSafeInteger(entry.byteLength)) throw new Error("The P4-D Agent fixture binding is invalid.");
    const frame = readFixedRawAsset(applicationRoot, entry.path);
    const digest = `sha256:${createHash("sha256").update(frame).digest("hex")}`;
    if (frame.byteLength !== entry.byteLength || digest !== entry.rawSha256) throw new Error("The P4-D Agent fixture bytes do not match their pin.");
    frames.set(entry.path, frame);
  }
  return Object.freeze([...frames.values()]);
}

function makeCanonicalEvent(sequence: number, type: "run.failed" | "citation.declared", payload: unknown) {
  return parseCanonicalEventV1({
    hostRunId: HOST_RUN_ID,
    eventId: `event.p4d.run.1.${sequence}`,
    hostSequence: sequence,
    acceptedAt: `2026-09-03T00:00:${String(sequence).padStart(2, "0")}Z`,
    canonicalPayloadDigest: sha256CanonicalAawJsonV1(payload),
    type,
    payload,
  });
}

function reviewedCitation(citationId: string, revisionId: string) {
  return Object.freeze({
    citationId,
    source: Object.freeze({ sourceKind: "reviewed_schematic" as const, artifactId: "synthetic.circuit-ir.flat-basic", revisionId }),
    locator: Object.freeze({ locatorKind: "whole_source" as const }),
    authorityStatus: "non_authoritative" as const,
    verificationStatus: "unverified" as const,
    preview: Object.freeze({ text: `Synthetic exact-revision citation ${revisionId}.`, truncated: false, authority: "non_authoritative" as const }),
  });
}

async function waitForDom(window: BrowserWindow, expression: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.isDestroyed()) throw new Error("The P4-D window closed before the DOM oracle completed.");
    const passed = await window.webContents.executeJavaScript(`Boolean(${expression})`, true) as boolean;
    if (passed) return;
    await wait(80);
  }
  const diagnostic = window.isDestroyed() ? { destroyed: true } : await window.webContents.executeJavaScript(`(() => ({
    url: location.href,
    title: document.title,
    bodyText: document.body?.innerText?.slice(0, 600),
    runtimeState: document.querySelector('[data-testid="runtime-status"]')?.getAttribute('data-state'),
    workbenchMethods: typeof window.workbench === 'object' && window.workbench !== null ? Object.keys(window.workbench) : null,
  }))()`, true);
  throw new Error(`The P4-D DOM oracle timed out: ${expression.slice(0, 120)} diagnostic=${JSON.stringify(diagnostic)}`);
}

async function clickButton(window: BrowserWindow, label: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const target = Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.trim() === ${JSON.stringify(label)});
    if (!(target instanceof HTMLButtonElement) || target.disabled) return false;
    target.focus(); target.click(); return document.activeElement === target;
  })()`, true) as boolean;
  if (!clicked) throw new Error(`The P4-D button is unavailable: ${label}`);
}

async function fillAgentComposer(window: BrowserWindow, text: string): Promise<void> {
  const filled = await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('textarea[aria-label="消息输入"]');
    if (!(target instanceof HTMLTextAreaElement) || target.disabled) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(target, ${JSON.stringify("请分析当前已审核电路。")});
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`, true) as boolean;
  if (!filled) throw new Error(`The P4-D Agent composer is unavailable: ${text}`);
}

async function visualDomSnapshot(window: BrowserWindow, caseId: P4dAgentCaseV1["caseId"]) {
  window.show(); window.focus(); window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await wait(80);
  return await window.webContents.executeJavaScript(`(() => {
    const methods = Object.keys(window.workbench ?? {}).sort();
    const expected = ['cancelRun','getInfo','resolveArtifact','resolveCitation','resolveReviewedArtifact','startTurn','subscribeRun'];
    const text = document.body.innerText;
    const buttons = Array.from(document.querySelectorAll('button'));
    const enabled = buttons.filter((button) => !button.disabled);
    const enabledAgentButtons = Array.from(document.querySelectorAll('.agent-panel button')).filter((button) => !button.disabled);
    const focusTarget = enabled.find((button) => button.textContent?.trim().length);
    focusTarget?.focus();
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
    const cards = Array.from(document.querySelectorAll('.agent-citation-card'));
    const lifecycle = document.querySelector('.agent-lifecycle')?.getAttribute('data-lifecycle');
    const visible = (selector) => {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) return false;
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return box.width > 2 && box.height > 2 && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && style.clipPath === 'none' && style.clip === 'auto' && parseFloat(style.fontSize) > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    };
    const caseId = ${JSON.stringify(caseId)};
    const expectedStateVisible = caseId === 'running-stream-cancel'
      ? lifecycle === 'running' && text.includes('Synthetic response text.') && buttons.some((button) => button.textContent?.trim() === 'Cancel' && !button.disabled)
      : caseId === 'replay-recovery'
        ? lifecycle === 'error' && text.includes('Recovery is available only after your explicit action.') && text.includes('Resume synthetic run')
        : cards.length === 2 && cards[0].querySelector('.agent-card-heading span')?.textContent === 'historical' && cards[1].querySelector('.agent-card-heading span')?.textContent === 'unavailable' && cards[1].querySelector('button')?.disabled === true;
    return {
      apiExactSeven: JSON.stringify(methods) === JSON.stringify(expected),
      ariaContract: document.querySelector('[aria-live="polite"]') !== null && document.querySelector('[role="status"]') !== null,
      cspClosed: ["connect-src 'none'", "img-src 'none'", "font-src 'none'", "worker-src 'none'", "object-src 'none'", "frame-src 'none'"].every((token) => csp.includes(token)),
      expectedStateVisible: expectedStateVisible && visible('.agent-lifecycle'),
      focusVisible: focusTarget instanceof HTMLButtonElement && document.activeElement === focusTarget && getComputedStyle(focusTarget).outlineStyle !== 'none' && parseFloat(getComputedStyle(focusTarget).outlineWidth) > 0,
      keyboardReachable: enabledAgentButtons.length >= 1 && enabledAgentButtons.every((button) => button.tabIndex >= 0) && document.querySelector('[role="tab"][tabindex="0"]') !== null,
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      noModelToolsLabelVisible: visible('.agent-safety-label') && text.includes('SYNTHETIC AGENT · NO MODEL · NO TOOLS'),
      nodeIntegrationDisabled: typeof process === 'undefined' && typeof require === 'undefined',
      syntheticLabelVisible: visible('.agent-safety-label') && text.includes('SYNTHETIC AGENT · NO MODEL · NO TOOLS'),
      lifecycleVisible: visible('.agent-lifecycle'),
      forcedColorsActive: matchMedia('(forced-colors: active)').matches,
      visibilityMeasurements: ['.agent-safety-label','.agent-lifecycle','.agent-composer'].map(selector => { const node=document.querySelector(selector); const box=node?.getBoundingClientRect(); const style=node ? getComputedStyle(node) : null; return {selector,width:box?.width,height:box?.height,clipPath:style?.clipPath,clip:style?.clip,visible:visible(selector)}; }),
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      lifecycle,
      cardCount: cards.length,
      citationStates: cards.map(card => ({ freshness: card.querySelector('.agent-card-heading span')?.textContent, buttonDisabled: card.querySelector('button')?.disabled })),
    };
  })()`, true) as Readonly<Record<string, unknown>>;
}

async function runHarness(): Promise<void> {
  const kind = argument("aaw-p4d-kind") as P4dKind | undefined;
  const caseId = argument("aaw-p4d-case") as P4dCase | undefined;
  const pageZoom = Number(argument("aaw-p4d-page-zoom") ?? "1");
  if ((kind !== "visual" && kind !== "lifecycle") || caseId === undefined || ![1, 2].includes(pageZoom)) throw new Error("The P4-D harness arguments are invalid.");

  const applicationRoot = app.getAppPath();
  app.setPath("userData", path.join(applicationRoot, ".local", "user-data", `electron-${process.pid}`));
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => undefined);
  await app.whenReady();

  const preloadPath = path.join(applicationRoot, "dist", "preload", "preload", "index.js");
  const rendererPath = path.join(applicationRoot, "dist", "renderer", "index.html");
  const allowedFrameUrl = pathToFileURL(rendererPath).toString();
  const baseOptions = createWindowOptions({ preloadPath, isDevelopment: false, show: true });
  const window = new BrowserWindow({
    ...baseOptions,
    width: 1366,
    height: 768,
    minWidth: 1,
    minHeight: 1,
    webPreferences: { ...baseOptions.webPreferences, partition: `aaw-p4d-${process.pid}` },
  });
  window.webContents.on("preload-error", (_event, preload, error) => {
    output("AAW_P4D_PRELOAD_ERROR", Object.freeze({ preload, message: error.message, stack: error.stack }));
  });
  window.webContents.on("console-message", (_event, details) => {
    if (details.level === "error") output("AAW_P4D_RENDERER_CONSOLE_ERROR", Object.freeze({ message: details.message, sourceId: details.sourceId, lineNumber: details.lineNumber }));
  });
  installWebContentsGuards(window.webContents);
  const runtimeContexts: Array<{ name: string; isDefault: boolean }> = [];
  const securityObservation = { installedBeforeLoad: true, logEnabled: false, errors: [] as string[], cspOrSecurityErrors: 0, navigationEvents: 0, webviewAttachEvents: 0 };
  window.webContents.on("will-navigate", () => { securityObservation.navigationEvents += 1; });
  window.webContents.on("will-attach-webview", () => { securityObservation.webviewAttachEvents += 1; });
  window.webContents.debugger.attach("1.3");
  window.webContents.debugger.on("message", (_event, method, parameters) => {
    if (method === "Runtime.executionContextCreated") runtimeContexts.push({ name: String(parameters.context.name), isDefault: parameters.context.auxData?.isDefault === true });
    if (method === "Log.entryAdded" && parameters.entry?.source === "security" && parameters.entry?.level === "error") securityObservation.cspOrSecurityErrors += 1;
  });
  void window.webContents.debugger.sendCommand("Runtime.enable").catch(() => { runtimeContexts.push({ name: "observer-enable-failed", isDefault: false }); });
  void window.webContents.debugger.sendCommand("Log.enable").then(() => { securityObservation.logEnabled = true; }).catch(() => { securityObservation.errors.push("Log.enable failed"); });
  const configuredSecurity = Object.freeze({
    sandbox: baseOptions.webPreferences?.sandbox === true,
    contextIsolation: baseOptions.webPreferences?.contextIsolation === true,
    nodeIntegrationDisabled: baseOptions.webPreferences?.nodeIntegration === false,
    webviewDisabled: baseOptions.webPreferences?.webviewTag === false,
  });

  let navigationEpoch = 1;
  let authorityActive = true;
  let deliveryCount = 0;
  let postRevokeDeliveryCount = 0;
  let externalNetworkCount = 0;
  const resourceRequestCounters: Record<string, number> = Object.fromEntries(["mainFrame", "subFrame", "stylesheet", "script", "image", "font", "object", "xhr", "ping", "cspReport", "media", "webSocket", "other"].map(type => [type, 0]));
  const resourceObservation = { installedBeforeLoad: true, allowed: { mainFrame: 0, script: 0, stylesheet: 0 } as Record<string, number> };
  const sessionId = "session.workbench.p4d.test-only.v1";
  const windowId = `window.p4d.${window.id}`;
  const workspaceId = "workspace.p4d.synthetic.v1";
  const rootId = "root.p4d.synthetic.v1";

  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowedDocument = details.resourceType === "mainFrame" && details.url === allowedFrameUrl;
    const allowedResource = ["script", "stylesheet"].includes(details.resourceType) && details.url.startsWith(pathToFileURL(path.dirname(rendererPath) + path.sep).toString());
    if (!allowedDocument && !allowedResource) {
      resourceRequestCounters[details.resourceType] = (resourceRequestCounters[details.resourceType] ?? 0) + 1;
      externalNetworkCount += 1;
      callback({ cancel: true }); return;
    }
    resourceObservation.allowed[details.resourceType] = (resourceObservation.allowed[details.resourceType] ?? 0) + 1;
    callback({ cancel: false });
  });

  const backend = createDevelopmentSyntheticAgentBackendV1({
    sourceFrames: loadApprovedAgentFrames(applicationRoot),
    negotiatedCapabilities: Object.freeze(["resolve_artifact", "resolve_citation"]),
    desktopBoundaryFixture: Object.freeze({ binding: Object.freeze({
      callerScope: "authorized",
      artifactId: "synthetic.circuit-ir.flat-basic",
      artifactRevisionId: "rev-historical",
      artifactKind: "circuit_ir_reviewed",
      revisionAvailable: true,
      sourceLocatorValid: true,
      intentAuthorized: true,
      resolutionAvailable: true,
      revisionFreshness: "historical",
    }) }),
  });
  const rawHost = createDesktopAgentHostV1({ backend, createHostRunId: () => "p4d.run.1" });
  let activeHostRegistrations = 0;
  let closeHostRegistrationCount = 0;
  let duplicateCloseCount = 0;
  const host = Object.freeze({
    ...rawHost,
    openSubscription(...args: Parameters<typeof rawHost.openSubscription>) {
      const opened = rawHost.openSubscription(...args);
      if (!opened.ok) return opened;
      activeHostRegistrations += 1;
      let closed = false;
      return Object.freeze({ ...opened, value: Object.freeze({ ...opened.value, close: () => {
        if (closed) duplicateCloseCount += 1;
        else { closed = true; activeHostRegistrations -= 1; closeHostRegistrationCount += 1; }
        opened.value.close();
      } }) });
    },
  });

  const agentCaller = (): AgentCallerContextV1 => Object.freeze({
    senderId: window.webContents.id,
    isTopFrame: true,
    appOrigin: appOrigin(allowedFrameUrl),
    navigationEpoch,
    appSessionId: sessionId,
    windowId,
    webContentsId: window.webContents.id,
    workspaceId,
    rootId,
  });
  const capabilities: readonly AgentCapabilityV1[] = Object.freeze(["start_turn", "subscribe_run", "cancel_run", "resolve_artifact", "resolve_citation"]);
  const invocationFence = createAgentCallerFenceV1({ caller: agentCaller(), capabilities, generation: 1 });
  const callerIsTrusted = (event: IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame;
    return authorityActive && frame !== null && event.sender === window.webContents && isTrustedIpcCaller({
      senderId: event.sender.id,
      expectedSenderId: window.webContents.id,
      isTopFrame: frame === event.sender.mainFrame,
      frameUrl: frame.url,
      allowedFrameUrls: [allowedFrameUrl],
    });
  };
  const deriveCaller = (eventValue: unknown): AgentCallerContextV1 | null => callerIsTrusted(eventValue as IpcMainInvokeEvent) ? agentCaller() : null;
  const deriveCurrentCaller = (): AgentCallerContextV1 | null => {
    if (!authorityActive || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.getURL() !== allowedFrameUrl) return null;
    return agentCaller();
  };
  const agentIpc = registerAgentIpcHandlersV1({
    ipcMain,
    host,
    invocationFence,
    createSubscriptionFence: () => createAgentCallerFenceV1({ caller: agentCaller(), capabilities, generation: 1 }),
    deriveCallerContext: deriveCaller,
    deriveCurrentCallerContext: deriveCurrentCaller,
    createSubscriptionId: () => `subscription.p4d.${randomUUID()}`,
    deliver: (channel, payload) => {
      if (!authorityActive) postRevokeDeliveryCount += 1;
      deliveryCount += 1;
      if (authorityActive && !window.isDestroyed()) window.webContents.send(channel, payload);
    },
  });

  ipcMain.removeHandler(GET_INFO_CHANNEL);
  ipcMain.handle(GET_INFO_CHANNEL, (event, request: unknown) => callerIsTrusted(event) ? createGetInfoResult({ request, appVersion: "0.1.0-p4d", mode: "test" }) : safeError("CAPABILITY_DENIED", "The requested capability is unavailable."));
  ipcMain.removeHandler(RESOLVE_REVIEWED_ARTIFACT_CHANNEL);
  ipcMain.handle(RESOLVE_REVIEWED_ARTIFACT_CHANNEL, () => Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "CAPABILITY_DENIED" as const, message: "Requested artifact is unavailable", correlationId: randomUUID(), retryability: "never" as const, recoveryAction: "none" as const }),
  }));

  let initialLoad = true;
  const revoke = (reason: string): void => {
    if (!authorityActive) return;
    authorityActive = false;
    navigationEpoch += 1;
    invocationFence.revoke({ reason, nextNavigationEpoch: navigationEpoch });
    agentIpc.revokeAll(reason);
  };
  window.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => { if (!initialLoad && mainFrame) revoke("navigation"); });
  window.webContents.on("did-navigate-in-page", () => { if (!initialLoad) revoke("navigation"); });
  window.webContents.on("render-process-gone", () => revoke("render-process-gone"));
  window.on("closed", () => revoke("window-close"));

  await window.loadFile(rendererPath);
  initialLoad = false;
  window.webContents.setZoomFactor(pageZoom);
  window.setSize(1366, 768);
  await waitForDom(window, `document.querySelector('[data-testid="runtime-status"]')?.getAttribute('data-state') === 'ready'`);
  await waitForDom(window, `Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Start synthetic turn')`);
  await fillAgentComposer(window, "请分析当前已审核电路。");
  await waitForDom(window, `Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Start synthetic turn' && !button.disabled)`);
  await clickButton(window, "Start synthetic turn");
  await waitForDom(window, `document.querySelector('.agent-lifecycle')?.getAttribute('data-lifecycle') === 'running'`);
  await waitForDom(window, `document.body.innerText.includes('Synthetic response text.')`);
  const runtimeBoundary = await window.webContents.executeJavaScript("({ noNode: typeof process === 'undefined' && typeof require === 'undefined', webviewDisabled: typeof document.createElement('webview').getWebContentsId === 'undefined' })", true) as { noNode: boolean; webviewDisabled: boolean };
  const runtimeSecurity = Object.freeze({
    sandbox: app.getAppMetrics().find(metric => metric.pid === window.webContents.getOSProcessId())?.sandboxed === true,
    contextIsolation: runtimeContexts.some(context => /electron.*isolated/iu.test(context.name) && !context.isDefault),
    nodeIntegrationDisabled: runtimeBoundary.noNode,
    webviewDisabled: runtimeBoundary.webviewDisabled,
  });

  if (kind === "visual") {
    const readyFile = argument("aaw-p4d-resize-ready");
    if (readyFile === undefined || !path.resolve(readyFile).startsWith(path.resolve(applicationRoot, "../../quality-evidence") + path.sep)) throw new Error("Resize handshake escaped evidence root.");
    const resizeDeadline = Date.now() + 15_000;
    while (!existsSync(readyFile) && Date.now() < resizeDeadline) await wait(100);
    if (!existsSync(readyFile)) throw new Error("Exact physical resize handshake unavailable.");
    window.show(); window.focus(); window.webContents.focus();
    await wait(600);
    const visualCase = caseId as P4dAgentCaseV1["caseId"];
    if (visualCase === "replay-recovery") {
      const payload = Object.freeze({ errorCode: "STREAM_INTERRUPTED", retryability: "safe_resume", recoveryAction: "resume_from_cursor" });
      backend.commitCanonicalEventV1(makeCanonicalEvent(3, "run.failed", payload));
      await waitForDom(window, `document.body.innerText.includes('Resume synthetic run')`);
    } else if (visualCase === "citation-historical-unavailable") {
      backend.commitCanonicalEventV1(makeCanonicalEvent(3, "citation.declared", reviewedCitation("citation.p4d.historical", "rev-historical")));
      backend.commitCanonicalEventV1(makeCanonicalEvent(4, "citation.declared", reviewedCitation("citation.p4d.unavailable", "rev-missing")));
      await waitForDom(window, `document.querySelectorAll('.agent-citation-card').length === 2`);
      const buttons = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.agent-citation-card button')).map((button) => button.textContent)`, true) as readonly string[];
      if (buttons.length !== 2) throw new Error("The P4-D citation cards are incomplete.");
      await window.webContents.executeJavaScript(`document.querySelectorAll('.agent-citation-card button')[0].click()`, true);
      await waitForDom(window, `document.body.innerText.includes('Historical revision · no latest fallback')`);
      await window.webContents.executeJavaScript(`document.querySelectorAll('.agent-citation-card button')[1].click()`, true);
      await waitForDom(window, `document.querySelectorAll('.agent-citation-card')[1]?.querySelector('.agent-card-heading span')?.textContent === 'unavailable' && document.querySelectorAll('.agent-citation-card')[1]?.querySelector('button')?.disabled === true`);
    }

    const dom = await visualDomSnapshot(window, visualCase);
    await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))", true);
    await wait(250);
    const captureTarget = argument("aaw-p4d-client-capture");
    if (captureTarget === undefined || !path.resolve(captureTarget).startsWith(path.resolve(applicationRoot, "../../quality-evidence") + path.sep)) throw new Error("Exact client capture target escaped evidence root.");
    let clientCapture: Readonly<Record<string, unknown>>;
    try {
      const clientImage = (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG();
      writeFileSync(captureTarget, clientImage, { flag: "wx" });
      clientCapture = { width: clientImage.readUInt32BE(16), height: clientImage.readUInt32BE(20), sha256: createHash("sha256").update(clientImage).digest("hex"), mechanism: "exact-webContents.capturePage", status: "PASS" };
    } catch (error) {
      clientCapture = { mechanism: "exact-webContents.capturePage", status: "BLOCKED", reason: error instanceof Error ? error.message : "Capture unavailable" };
    }
    const artifactDigestBefore = createHash("sha256").update(readFileSync(path.join(applicationRoot, AGENT_MANIFEST_PATH))).digest("hex");
    const marker = Object.freeze({
      schemaVersion: "aaw.phase4.p4d.capture-ready/v1",
      kind,
      caseId: visualCase,
      dom,
      clientCapture,
      configuredSecurity,
      runtimeSecurity,
      runtimeContexts,
      postRevokeDeliveryCount,
      pageZoom: window.webContents.getZoomFactor(),
      counters: Object.freeze({ deliveryCount, externalNetworkCount }),
      resourceRequestCounters: Object.freeze({ ...resourceRequestCounters }),
      resourceObservation,
      securityObservation,
      boundaryDiagnostics: backend.snapshotDesktopBoundaryDiagnosticsV1(),
      registrySizes: backend.registrySizes,
      artifactDigestBefore,
    });
    output("AAW_P4D_CAPTURE_READY", marker);
    await wait(CAPTURE_DWELL_MS);
    let postActionPassed = true;
    if (visualCase === "running-stream-cancel") {
      await clickButton(window, "Cancel");
      await waitForDom(window, `document.querySelector('.agent-lifecycle')?.getAttribute('data-lifecycle') === 'terminal'`);
    } else if (visualCase === "replay-recovery") {
      await clickButton(window, "Resume synthetic run");
      await wait(250);
      postActionPassed = !window.isDestroyed();
    }
    const artifactDigestAfter = createHash("sha256").update(readFileSync(path.join(applicationRoot, AGENT_MANIFEST_PATH))).digest("hex");
    output("AAW_P4D_CASE_RESULT", Object.freeze({ ...marker, postActionPassed, artifactDigestAfter, finalDeliveryCount: deliveryCount }));
  } else {
    const lifecycleCase = caseId as P4dLifecycleCaseV1["caseId"];
    const dom = await visualDomSnapshot(window, "running-stream-cancel");
    const lifecyclePageZoom = window.webContents.getZoomFactor();
    const before = deliveryCount;
    if (lifecycleCase === "navigation") {
      await window.webContents.executeJavaScript(`location.hash = 'p4d-revoked'`, true);
      await wait(100);
    } else if (lifecycleCase === "reload") {
      window.webContents.reload();
      await wait(100);
    } else {
      revoke(lifecycleCase);
      if (lifecycleCase === "window-close") window.destroy();
    }
    const afterRevoke = deliveryCount;
    const payload = Object.freeze({
      citationId: "citation.p4d.late",
      source: Object.freeze({ sourceKind: "reviewed_schematic" as const, artifactId: "synthetic.circuit-ir.flat-basic", revisionId: "rev-1" }),
      locator: Object.freeze({ locatorKind: "whole_source" as const }),
      authorityStatus: "non_authoritative" as const,
      verificationStatus: "unverified" as const,
    });
    backend.commitCanonicalEventV1(makeCanonicalEvent(3, "citation.declared", payload));
    await wait(250);
    output("AAW_P4D_LIFECYCLE_RESULT", Object.freeze({
      schemaVersion: "aaw.phase4.p4d.lifecycle-result/v1",
      kind,
      caseId: lifecycleCase,
      deliveriesBeforeRevoke: before,
      deliveriesAtRevoke: afterRevoke,
      deliveriesAfterLateCommit: deliveryCount,
      postRevokeDeliveryCount: deliveryCount - afterRevoke,
      zeroPostRevokeDelivery: deliveryCount === afterRevoke,
      externalNetworkCount,
      resourceRequestCounters: Object.freeze({ ...resourceRequestCounters }),
      resourceObservation,
      securityObservation,
      boundaryDiagnostics: backend.snapshotDesktopBoundaryDiagnosticsV1(),
      registrySizes: backend.registrySizes,
      dom,
      configuredSecurity,
      runtimeSecurity,
      runtimeContexts,
      pageZoom: lifecyclePageZoom,
    }));
  }

  agentIpc.dispose();
  output("AAW_P4D_CLEANUP", { activeHostRegistrations, closeHostRegistrationCount, duplicateCloseCount, postRevokeDeliveryCount, boundaryDiagnostics: backend.snapshotDesktopBoundaryDiagnosticsV1() });
  if (!window.isDestroyed()) window.destroy();
  app.exit(0);
}

runHarness().catch((error: unknown) => {
  output("AAW_P4D_FATAL", Object.freeze({ message: error instanceof Error ? error.message : "Unknown P4-D harness failure" }));
  app.exit(1);
});
