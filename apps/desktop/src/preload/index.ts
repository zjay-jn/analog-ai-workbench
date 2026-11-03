import { contextBridge, ipcRenderer, webUtils } from "electron";
import { WINDOW_MENU_CHANNEL, parseWindowMenuRequest, parseWindowMenuResult } from "../shared/window-menu";
import type { GetInfoResultV1, WorkbenchApiV1 } from "../shared/app-info";
import {
  parseAgentDesktopEventV1,
  parseAgentDesktopRequestV1,
  parseAgentDesktopResultV1,
  type AgentSafeErrorV1,
  type CanonicalEventV1,
  type CancelRunRequestV1,
  type CancelRunResultV1,
  type StartTurnRequestV1,
  type StartTurnResultV1,
  type SubscribeRunRequestV1,
  type SubscribeRunResultV1,
  type ResolveArtifactRequestV1,
  type ResolveCitationRequestV1,
  type ResolveResultV1,
} from "../shared/agent/desktop-agent-api";
import type {
  ResolveReviewedArtifactRequestV1,
  ResolveReviewedArtifactResultV1,
} from "../shared/schematic/reviewed-artifact-resolve";

const GET_INFO_CHANNEL = "workbench.app.getInfo.v1" as const;
const RESOLVE_REVIEWED_ARTIFACT_CHANNEL = "workbench.schematic.resolveReviewedArtifact.v1" as const;
const START_TURN_CHANNEL = "workbench.agent.startTurn.v1" as const;
const SUBSCRIBE_RUN_CHANNEL = "workbench.agent.subscribeRun.v1" as const;
const CANCEL_RUN_CHANNEL = "workbench.agent.cancelRun.v1" as const;
const RESOLVE_ARTIFACT_CHANNEL = "workbench.agent.resolveArtifact.v1" as const;
const RESOLVE_CITATION_CHANNEL = "workbench.agent.resolveCitation.v1" as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && [...expected].sort().every((key, index) => actual[index] === key);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && /^(?!latest$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isReviewedDocumentRef(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ["documentId", "revisionId", "documentKind"]) && isIdentity(value.documentId) && isIdentity(value.revisionId) && value.documentKind === "schematic_reviewed";
}

function isReviewedArtifactRef(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ["artifactId", "revisionId", "artifactKind"]) && isIdentity(value.artifactId) && isIdentity(value.revisionId) && value.artifactKind === "circuit_ir_reviewed";
}

function deepFreezeClone<T>(value: T): T {
  const clone = structuredClone(value);
  const visit = (candidate: unknown, seen: Set<object>): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (seen.has(candidate)) throw new Error("Cyclic IPC value is unavailable.");
    seen.add(candidate);
    if (Array.isArray(candidate)) for (const child of candidate) visit(child, seen);
    else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("Non-plain IPC value is unavailable.");
      for (const child of Object.values(candidate)) visit(child, seen);
    }
    seen.delete(candidate);
    Object.freeze(candidate);
  };
  visit(clone, new Set<object>());
  return clone;
}

function isReviewedResolveResult(value: unknown): value is ResolveReviewedArtifactResultV1 {
  if (!isPlainObject(value)) return false;
  if (value.ok === true) {
    if (!hasExactKeys(value, ["ok", "value"]) || !isPlainObject(value.value)) return false;
    const body = value.value;
    return hasExactKeys(body, ["contractVersion", "documentRef", "artifactRef", "freshness", "reviewedCircuitIr"]) && body.contractVersion === RESOLVE_REVIEWED_ARTIFACT_CHANNEL && (body.freshness === "current" || body.freshness === "historical") && isReviewedDocumentRef(body.documentRef) && isReviewedArtifactRef(body.artifactRef) && isPlainObject(body.reviewedCircuitIr);
  }
  if (value.ok !== false || !hasExactKeys(value, ["ok", "error"]) || !isPlainObject(value.error) || !hasExactKeys(value.error, ["code", "message", "correlationId", "retryability", "recoveryAction"])) return false;
  const error = value.error;
  return ["INVALID_REQUEST", "CAPABILITY_DENIED", "REVISION_UNAVAILABLE", "PAYLOAD_TOO_LARGE", "INTERNAL"].includes(error.code as string) && typeof error.message === "string" && error.message.length > 0 && error.message.length <= 160 && typeof error.correlationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(error.correlationId) && error.retryability === "never" && error.recoveryAction === "none";
}

function parseInternalFailure(value: unknown): Readonly<{ ok: false; error: AgentSafeErrorV1 }> | null {
  try {
    const parsed = parseAgentDesktopResultV1(value);
    return parsed.ok ? null : parsed;
  } catch {
    return null;
  }
}

type Route = {
  active: boolean;
  closed: boolean;
  generation: number;
  callback: (event: CanonicalEventV1) => void;
  buffer: Readonly<Record<string, unknown>>[];
  tail: Promise<void>;
  unsubscribe: () => Promise<void>;
};
const routes = new Map<string, Route>();

function enqueue(route: Route, envelope: Readonly<Record<string, unknown>>): void {
  route.tail = route.tail.then(() => {
    if (route.closed) return;
    if (envelope.kind === "closed") {
      route.closed = true;
      route.buffer.length = 0;
      routes.delete(envelope.subscriptionId as string);
      return;
    }
    try {
      const event = parseAgentDesktopEventV1(envelope.event);
      route.callback(deepFreezeClone(event));
    } catch {
      void route.unsubscribe();
    }
  });
}

ipcRenderer.on(SUBSCRIBE_RUN_CHANNEL, (_electronEvent, rawEnvelope: unknown) => {
  const envelope = deepFreezeClone(rawEnvelope);
  if (!isPlainObject(envelope) || typeof envelope.subscriptionId !== "string" || !Number.isSafeInteger(envelope.generation)) return;
  const route = routes.get(envelope.subscriptionId);
  if (route === undefined || route.generation !== envelope.generation || route.closed) return;
  if (envelope.kind === "closed" && hasExactKeys(envelope, ["kind", "subscriptionId", "generation"])) {
    if (!route.active) route.buffer.push(envelope);
    else enqueue(route, envelope);
    return;
  }
  if (envelope.kind !== "deliver" || !hasExactKeys(envelope, ["kind", "subscriptionId", "generation", "event"])) return;
  if (!route.active) route.buffer.push(envelope);
  else enqueue(route, envelope);
});

async function invokeAgent(method: "startTurn" | "cancelRun" | "resolveArtifact" | "resolveCitation", channel: string, request: unknown): Promise<StartTurnResultV1 | CancelRunResultV1 | ResolveResultV1> {
  const parsedRequest = parseAgentDesktopRequestV1(request, method);
  const raw = await ipcRenderer.invoke(channel, deepFreezeClone(parsedRequest));
  return deepFreezeClone(parseAgentDesktopResultV1(deepFreezeClone(raw), method));
}

const workbenchApi: WorkbenchApiV1 = Object.freeze({
  getInfo: async (): Promise<GetInfoResultV1> => deepFreezeClone(await ipcRenderer.invoke(GET_INFO_CHANNEL, {})) as GetInfoResultV1,
  resolveReviewedArtifact: async (request: ResolveReviewedArtifactRequestV1): Promise<ResolveReviewedArtifactResultV1> => {
    const result = deepFreezeClone(await ipcRenderer.invoke(RESOLVE_REVIEWED_ARTIFACT_CHANNEL, deepFreezeClone(request)));
    if (!isReviewedResolveResult(result)) throw new Error("Reviewed artifact response is unavailable.");
    return result;
  },
  startTurn: async (request: StartTurnRequestV1): Promise<StartTurnResultV1> =>
    await invokeAgent("startTurn", START_TURN_CHANNEL, request) as StartTurnResultV1,
  subscribeRun: async (request: SubscribeRunRequestV1, callback: (event: CanonicalEventV1) => void): Promise<SubscribeRunResultV1> => {
    if (typeof callback !== "function") throw new TypeError("subscribeRun callback is invalid");
    const parsedRequest = parseAgentDesktopRequestV1(request, "subscribeRun");
    const openRaw = deepFreezeClone(await ipcRenderer.invoke(SUBSCRIBE_RUN_CHANNEL, deepFreezeClone({ kind: "open", request: parsedRequest })));
    const failure = parseInternalFailure(openRaw);
    if (failure !== null) return deepFreezeClone(failure);
    if (!isPlainObject(openRaw) || openRaw.ok !== true || !hasExactKeys(openRaw, ["ok", "value"]) || !isPlainObject(openRaw.value) || !hasExactKeys(openRaw.value, ["subscriptionId", "generation", "snapshotHead"]) || !isIdentity(openRaw.value.subscriptionId) || !Number.isSafeInteger(openRaw.value.generation) || !Number.isSafeInteger(openRaw.value.snapshotHead)) throw new Error("Subscription response is unavailable.");
    const subscriptionId = openRaw.value.subscriptionId;
    const generation = openRaw.value.generation as number;
    let unsubscribePromise: Promise<void> | undefined;
    const route: Route = {
      active: false,
      closed: false,
      generation,
      callback,
      buffer: [],
      tail: Promise.resolve(),
      unsubscribe: () => {
        unsubscribePromise ??= (async () => {
          route.closed = true;
          route.buffer.length = 0;
          routes.delete(subscriptionId);
          const result = deepFreezeClone(await ipcRenderer.invoke(SUBSCRIBE_RUN_CHANNEL, deepFreezeClone({ kind: "unsubscribe", subscriptionId, generation })));
          if (parseInternalFailure(result) !== null) return;
          if (!isPlainObject(result) || result.ok !== true) throw new Error("Subscription revoke response is unavailable.");
        })();
        return unsubscribePromise;
      },
    };
    routes.set(subscriptionId, route);
    const activate = deepFreezeClone(await ipcRenderer.invoke(SUBSCRIBE_RUN_CHANNEL, deepFreezeClone({ kind: "activate", subscriptionId, generation })));
    const activateFailure = parseInternalFailure(activate);
    if (activateFailure !== null) {
      await route.unsubscribe();
      return deepFreezeClone(activateFailure);
    }
    if (!isPlainObject(activate) || activate.ok !== true) {
      await route.unsubscribe();
      throw new Error("Subscription activation response is unavailable.");
    }
    route.active = true;
    for (const envelope of route.buffer.splice(0)) enqueue(route, envelope);
    return Object.freeze({ ok: true as const, value: Object.freeze({ unsubscribe: route.unsubscribe }) });
  },
  cancelRun: async (request: CancelRunRequestV1): Promise<CancelRunResultV1> =>
    await invokeAgent("cancelRun", CANCEL_RUN_CHANNEL, request) as CancelRunResultV1,
  resolveArtifact: async (request: ResolveArtifactRequestV1): Promise<ResolveResultV1> =>
    await invokeAgent("resolveArtifact", RESOLVE_ARTIFACT_CHANNEL, request) as ResolveResultV1,
  resolveCitation: async (request: ResolveCitationRequestV1): Promise<ResolveResultV1> =>
    await invokeAgent("resolveCitation", RESOLVE_CITATION_CHANNEL, request) as ResolveResultV1,
});

contextBridge.exposeInMainWorld("workbench", workbenchApi);

// Display-only metadata for a File the user already supplied; no path-based I/O.
contextBridge.exposeInMainWorld('workbenchFilePath',Object.freeze({describe:(file:File):string[]=>{
 try{const path=webUtils.getPathForFile(file);if(!path||path.length>32768||/[\u0000-\u001f\u007f]/u.test(path))return [];
 const parts=path.replace(/\\/gu,'/').split('/').filter(Boolean);if(parts.at(-1)!==file.name)return [];
 return parts.map((part,index)=>index===0&&/^[A-Za-z]:$/u.test(part)?part.slice(0,-1).toUpperCase():part);
 }catch{return [];}
}}));

// Separate title-bar bridge; the existing seven-method workbench surface stays exact.
if(process.platform==='win32')contextBridge.exposeInMainWorld('workbenchWindowMenu',Object.freeze({open:async(value:unknown)=>{
 try{return parseWindowMenuResult(await ipcRenderer.invoke(WINDOW_MENU_CHANNEL,parseWindowMenuRequest(value)));}catch{return {ok:false};}
}}));
