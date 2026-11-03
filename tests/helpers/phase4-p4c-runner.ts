import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseConformanceTraceabilityManifestV1,
  type ConformanceTraceabilityManifestV1,
  type ConformanceVectorV1,
} from "../../packages/agent-adapters/src/conformance";
import type {
  createDesktopAgentHostV1 as P4cDesktopRunnerCompileReference,
} from "../../apps/desktop/src/main/agent/desktop-agent-host";
import type {
  AGENT_CHANNELS_V1 as P4cChannelsCompileReference,
} from "../../apps/desktop/src/shared/agent/desktop-agent-api";
import type {
  createAgentCallerFenceV1 as P4cCallerFenceCompileReference,
} from "../../apps/desktop/src/main/agent/agent-caller-fence";
import type {
  registerAgentIpcHandlersV1 as P4cIpcCompileReference,
} from "../../apps/desktop/src/main/ipc/agent/register-agent-ipc";
import type {
  createEmptyAgentBackendV1 as P4cEmptyBackendCompileReference,
} from "../../apps/desktop/src/main/agent/empty-agent-backend";
import type {
  createDevelopmentSyntheticAgentBackendV1 as P4cDevelopmentBackendCompileReference,
} from "../../apps/desktop/src/main/agent/development-synthetic-agent-backend";
import type {
  reduceAgentViewStateV1 as P4cViewStateCompileReference,
} from "../../apps/desktop/src/renderer/agent/agent-view-state";
import type {
  AgentPanel as P4cAgentPanelCompileReference,
} from "../../apps/desktop/src/renderer/agent/AgentPanel";
import { loadApprovedP4bSourceFrames } from "./phase4-p4b-runner";

export const P4C_DESKTOP_BOUNDARY_RUNNER_UNAVAILABLE =
  "P4C_DESKTOP_BOUNDARY_RUNNER_UNAVAILABLE" as const;
export const P4C_AGENT_API_SURFACE_UNAVAILABLE =
  "P4C_AGENT_API_SURFACE_UNAVAILABLE" as const;
export const P4C_CALLER_CONTEXT_FENCE_UNAVAILABLE =
  "P4C_CALLER_CONTEXT_FENCE_UNAVAILABLE" as const;
export const P4C_BUILD_PROFILE_SEPARATION_UNAVAILABLE =
  "P4C_BUILD_PROFILE_SEPARATION_UNAVAILABLE" as const;
export const P4C_RENDERER_AGENT_HOST_UNAVAILABLE =
  "P4C_RENDERER_AGENT_HOST_UNAVAILABLE" as const;

export type P4cAvailabilityCode =
  | typeof P4C_DESKTOP_BOUNDARY_RUNNER_UNAVAILABLE
  | typeof P4C_AGENT_API_SURFACE_UNAVAILABLE
  | typeof P4C_CALLER_CONTEXT_FENCE_UNAVAILABLE
  | typeof P4C_BUILD_PROFILE_SEPARATION_UNAVAILABLE
  | typeof P4C_RENDERER_AGENT_HOST_UNAVAILABLE;

type JsonRecord = Readonly<Record<string, unknown>>;
type ModuleRecord = Readonly<Record<string, unknown>>;
type PlannedP4cCompileReference =
  | typeof P4cDesktopRunnerCompileReference
  | typeof P4cChannelsCompileReference
  | typeof P4cCallerFenceCompileReference
  | typeof P4cIpcCompileReference
  | typeof P4cEmptyBackendCompileReference
  | typeof P4cDevelopmentBackendCompileReference
  | typeof P4cViewStateCompileReference
  | typeof P4cAgentPanelCompileReference;
type CompileReferencedModuleRecord = ModuleRecord & Readonly<{
  __compileReference?: PlannedP4cCompileReference;
}>;

export type FrozenP4cVector = Readonly<{
  id: string;
  oracleId: string;
  harness: "desktop_boundary";
  requiredStage: "P4-C";
  negotiatedCapabilities: readonly string[];
  preState: JsonRecord;
  steps: readonly unknown[];
  expected: JsonRecord;
}>;

export type P4cExecutionInput = Readonly<{
  harness: "desktop_boundary";
  negotiatedCapabilities: readonly string[];
  preState: JsonRecord;
  stateFixture: JsonRecord;
  steps: readonly unknown[];
}>;

export type P4cDesktopBoundaryRunner = (
  input: P4cExecutionInput,
) => unknown | Promise<unknown>;

export type FakeIpcHandlerV1 = (event: unknown, request: unknown) => unknown;

export type FakeIpcMainV1 = Readonly<{
  handlers: Map<string, FakeIpcHandlerV1>;
  handle(channel: string, handler: FakeIpcHandlerV1): void;
  removeHandler(channel: string): void;
}>;

export function createFakeIpcMainV1(): FakeIpcMainV1 {
  const handlers = new Map<string, FakeIpcHandlerV1>();
  return {
    handlers,
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error(`duplicate handler ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
}

export async function invokeFakeIpcV1(
  ipcMain: FakeIpcMainV1,
  channel: string,
  event: unknown,
  request: unknown,
): Promise<unknown> {
  const handler = ipcMain.handlers.get(channel);
  if (handler === undefined) throw new Error(`missing handler ${channel}`);
  return await handler(event, request);
}

export type OptionalP4cCapability<T> =
  | Readonly<{ available: true; value: T }>
  | Readonly<{ available: false; code: P4cAvailabilityCode }>;

const traceabilityPath = resolve(
  process.cwd(),
  "packages/agent-adapters/fixtures/n01-n30.traceability.json",
);
const subscribeFreezePath = resolve(
  process.cwd(),
  ".local/quality-evidence/20260902-phase4-p4c-entry-01/subscribe-run-contract-freeze.json",
);

const emittedModule = (relativePath: string): string =>
  pathToFileURL(resolve(process.cwd(), ".local/test-build", relativePath)).href;

const plannedModules = Object.freeze({
  host: emittedModule("apps/desktop/src/main/agent/desktop-agent-host.js"),
  api: emittedModule("apps/desktop/src/shared/agent/desktop-agent-api.js"),
  callerFence: emittedModule(
    "apps/desktop/src/main/agent/agent-caller-fence.js",
  ),
  ipc: emittedModule("apps/desktop/src/main/ipc/agent/register-agent-ipc.js"),
  emptyBackend: emittedModule(
    "apps/desktop/src/main/agent/empty-agent-backend.js",
  ),
  developmentBackend: emittedModule(
    "apps/desktop/src/main/agent/development-synthetic-agent-backend.js",
  ),
  viewState: emittedModule(
    "apps/desktop/src/renderer/agent/agent-view-state.js",
  ),
  panel: emittedModule("apps/desktop/src/renderer/agent/AgentPanel.js"),
});

let cachedManifest: ConformanceTraceabilityManifestV1 | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
    Object.freeze(value as object);
  }
  return value;
}

function frozenNullPrototypeJsonClone(value: unknown, label: string): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) =>
      frozenNullPrototypeJsonClone(item, `${label}[${index}]`)));
  }
  if (value !== null && typeof value === "object") {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new TypeError(`${label} must not contain symbol keys`);
    }
    const clone: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${label}.${key} must be an enumerable data property`);
      }
      Object.defineProperty(clone, key, {
        value: frozenNullPrototypeJsonClone(descriptor.value, `${label}.${key}`),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(clone);
  }
  return value;
}

function isFrozenP4cVector(
  vector: ConformanceVectorV1,
): vector is ConformanceVectorV1 & FrozenP4cVector {
  return vector.requiredStage === "P4-C" &&
    vector.harness === "desktop_boundary" &&
    isRecord(vector.preState) &&
    Array.isArray(vector.steps) &&
    isRecord(vector.expected);
}

export function loadFrozenP4cManifest(): ConformanceTraceabilityManifestV1 {
  cachedManifest ??= parseConformanceTraceabilityManifestV1(
    JSON.parse(readFileSync(traceabilityPath, "utf8")),
  );
  return cachedManifest;
}

export function loadFrozenP4cVectors(): readonly FrozenP4cVector[] {
  const vectors = loadFrozenP4cManifest().vectors.filter(isFrozenP4cVector);
  if (vectors.length !== 6 || new Set(vectors.map((vector) => vector.id)).size !== 6) {
    throw new Error(`P4-C desktop vector set drifted: expected 6, got ${vectors.length}`);
  }
  return Object.freeze(vectors);
}

export function loadSubscribeRunContractFreeze(): JsonRecord {
  return freezeDeep(
    requireRecord(
      JSON.parse(readFileSync(subscribeFreezePath, "utf8")),
      "subscribeRun contract freeze",
    ),
  );
}

export function executionInputForP4c(
  vector: FrozenP4cVector,
): P4cExecutionInput {
  const fixtureId = vector.preState.fixtureId;
  if (typeof fixtureId !== "string") {
    throw new TypeError(`${vector.id} preState fixtureId must be a string`);
  }
  const fixture = loadFrozenP4cManifest().stateFixtures.find(
    (candidate) => candidate.fixtureId === fixtureId,
  );
  if (fixture === undefined) {
    throw new Error(`${vector.id} references missing fixture ${fixtureId}`);
  }
  const input: P4cExecutionInput = {
    harness: "desktop_boundary",
    negotiatedCapabilities: structuredClone(vector.negotiatedCapabilities),
    preState: structuredClone(vector.preState),
    stateFixture: structuredClone(fixture) as unknown as JsonRecord,
    steps: structuredClone(vector.steps),
  };
  if ("expected" in input || "vectorId" in input || "oracleId" in input) {
    throw new Error("P4-C execution input contains an oracle/ID dispatcher field");
  }
  return freezeDeep(input);
}

function isMissingExactModule(error: unknown, moduleSpecifier: string): boolean {
  if (!isRecord(error)) return false;
  const code = error.code;
  const url = error.url;
  const message = typeof error.message === "string"
    ? (error.message.match(/^[^\r\n]*/u)?.[0] ?? "")
    : "";
  const modulePath = fileURLToPath(moduleSpecifier);
  const candidates = [
    moduleSpecifier,
    decodeURIComponent(moduleSpecifier),
    modulePath,
    modulePath.replace(/\\/gu, "/"),
  ];
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
    return false;
  }
  if (typeof url === "string") return candidates.includes(url);
  const missingTarget = message.match(
    /Cannot find (?:module|package) ['"]([^'"]+)['"]/u,
  )?.[1];
  return missingTarget !== undefined && candidates.includes(missingTarget);
}

async function importPlannedModule(
  moduleSpecifier: string,
  requiredExports: readonly string[],
  unavailableCode: P4cAvailabilityCode,
): Promise<CompileReferencedModuleRecord> {
  let namespace: unknown;
  try {
    namespace = await import(moduleSpecifier);
  } catch (error: unknown) {
    if (isMissingExactModule(error, moduleSpecifier)) {
      throw new P4cUnavailableError(unavailableCode);
    }
    throw error;
  }
  const moduleRecord = requireRecord(namespace, moduleSpecifier);
  if (requiredExports.some((name) => moduleRecord[name] === undefined)) {
    throw new P4cUnavailableError(unavailableCode);
  }
  return moduleRecord as CompileReferencedModuleRecord;
}

export class P4cUnavailableError extends Error {
  constructor(readonly code: P4cAvailabilityCode) {
    super(code);
    this.name = "P4cUnavailableError";
  }
}

async function optional<T>(
  code: P4cAvailabilityCode,
  load: () => Promise<T>,
): Promise<OptionalP4cCapability<T>> {
  try {
    return Object.freeze({ available: true, value: await load() });
  } catch (error: unknown) {
    if (error instanceof P4cUnavailableError && error.code === code) {
      return Object.freeze({ available: false, code });
    }
    throw error;
  }
}

export function optionalP4cDesktopBoundaryRunner(): Promise<
  OptionalP4cCapability<P4cDesktopBoundaryRunner>
> {
  return optional(P4C_DESKTOP_BOUNDARY_RUNNER_UNAVAILABLE, async () => {
    const [api, fenceModule, ipcModule, backendModule, hostModule] = await Promise.all([
      importPlannedModule(plannedModules.api, ["AGENT_CHANNELS_V1"], P4C_DESKTOP_BOUNDARY_RUNNER_UNAVAILABLE),
      importPlannedModule(plannedModules.callerFence, ["createAgentCallerFenceV1"], P4C_DESKTOP_BOUNDARY_RUNNER_UNAVAILABLE),
      importPlannedModule(plannedModules.ipc, ["registerAgentIpcHandlersV1"], P4C_DESKTOP_BOUNDARY_RUNNER_UNAVAILABLE),
      importPlannedModule(plannedModules.developmentBackend, ["createDevelopmentSyntheticAgentBackendV1"], P4C_DESKTOP_BOUNDARY_RUNNER_UNAVAILABLE),
      importPlannedModule(plannedModules.host, ["createDesktopAgentHostV1"], P4C_DESKTOP_BOUNDARY_RUNNER_UNAVAILABLE),
    ]);
    const channels = api.AGENT_CHANNELS_V1;
    if (!Array.isArray(channels) || channels.length !== 5) {
      throw new TypeError("AGENT_CHANNELS_V1 must contain five channels");
    }
    const channelByApi = Object.freeze({
      startTurn: channels[0], subscribeRun: channels[1], cancelRun: channels[2],
      resolveArtifact: channels[3], resolveCitation: channels[4],
    } as Readonly<Record<string, unknown>>);
    const createFence = fenceModule.createAgentCallerFenceV1 as (input: unknown) => unknown;
    const register = ipcModule.registerAgentIpcHandlersV1 as (input: unknown) => unknown;
    const createBackend = backendModule.createDevelopmentSyntheticAgentBackendV1 as (input: unknown) => unknown;
    const createHost = hostModule.createDesktopAgentHostV1 as (input: unknown) => Record<string, unknown>;
    const owner = Object.freeze({ senderId: 7, isTopFrame: true, appOrigin: "file://", navigationEpoch: 1,
      appSessionId: "session.p4c.conformance", windowId: "window.p4c.conformance", webContentsId: 7,
      workspaceId: "workspace.synthetic.1", rootId: "root.synthetic.1" });

    return async (input: P4cExecutionInput): Promise<unknown> => {
      const binding = requireRecord(input.stateFixture.binding, "state fixture binding");
      const authorized = binding.callerScope !== "unauthorized";
      const event = { caller: authorized ? owner : { ...owner, workspaceId: "workspace.other" } };
      const ipcMain = createFakeIpcMainV1();
      const backend = createBackend({
        sourceFrames: loadApprovedP4bSourceFrames().map((frame) => frame.rawBytes),
        desktopBoundaryFixture: structuredClone(input.stateFixture),
        negotiatedCapabilities: structuredClone(input.negotiatedCapabilities),
      });
      const host = createHost({ backend, createHostRunId: () => "p4c.conformance.1" });
      const invocationFence = createFence({
        caller: owner,
        capabilities: ["start_turn", "subscribe_run", "cancel_run", "resolve_artifact", "resolve_citation"],
        generation: 1,
      });
      register({
        ipcMain,
        host,
        invocationFence,
        createSubscriptionFence: () => createFence({ caller: owner, capabilities: ["subscribe_run"], generation: 1 }),
        deriveCallerContext: (candidate: unknown) => requireRecord(candidate, "IPC event").caller,
        deriveCurrentCallerContext: () => event.caller,
        createSubscriptionId: () => "subscription.p4c.conformance.1",
        deliver: () => undefined,
      });
      const step = requireRecord(input.steps[0], "P4-C step");
      const apiName = step.api;
      if (typeof apiName !== "string") throw new TypeError("P4-C step api must be a string");
      const channel = channelByApi[apiName];
      if (typeof channel !== "string") throw new TypeError(`missing channel for ${apiName}`);
      const publicResult = await invokeFakeIpcV1(ipcMain, channel, event, step.request);
      const snapshot = host.snapshotDesktopBoundaryDiagnosticsV1;
      if (typeof snapshot !== "function") {
        throw new Error("desktop host must expose snapshotDesktopBoundaryDiagnosticsV1 for black-box conformance telemetry");
      }
      const diagnostics = requireRecord(snapshot.call(host), "desktop boundary diagnostics");
      const result = requireRecord(publicResult, "desktop IPC result");
      const error = isRecord(result.error) ? result.error : undefined;
      const value = isRecord(result.value) ? result.value : undefined;
      return frozenNullPrototypeJsonClone({
        ...structuredClone(diagnostics),
        decision: result.ok === true ? "pass" : "reject",
        ...(error === undefined ? {} : {
          errorCode: error.code,
          retryability: error.retryability,
          recoveryAction: error.recoveryAction,
        }),
        ...(value?.freshness === undefined ? {} : { freshness: value.freshness }),
      }, "P4-C desktop observation") as JsonRecord;
    };
  });
}

export function optionalP4cApiSurface(): Promise<
  OptionalP4cCapability<ModuleRecord>
> {
  return optional(P4C_AGENT_API_SURFACE_UNAVAILABLE, () =>
    importPlannedModule(
      plannedModules.api,
      [
        "WORKBENCH_API_METHODS_V1",
        "AGENT_CHANNELS_V1",
        "parseAgentDesktopRequestV1",
        "parseAgentDesktopResultV1",
        "parseAgentDesktopEventV1",
      ],
      P4C_AGENT_API_SURFACE_UNAVAILABLE,
    ));
}

export function optionalP4cCallerFence(): Promise<
  OptionalP4cCapability<Readonly<{ fence: ModuleRecord; ipc: ModuleRecord; host: ModuleRecord }>>
> {
  return optional(P4C_CALLER_CONTEXT_FENCE_UNAVAILABLE, async () => ({
    fence: await importPlannedModule(
      plannedModules.callerFence,
      ["createAgentCallerFenceV1"],
      P4C_CALLER_CONTEXT_FENCE_UNAVAILABLE,
    ),
    ipc: await importPlannedModule(
      plannedModules.ipc,
      ["registerAgentIpcHandlersV1"],
      P4C_CALLER_CONTEXT_FENCE_UNAVAILABLE,
    ),
    host: await importPlannedModule(
      plannedModules.host,
      ["createDesktopAgentHostV1"],
      P4C_CALLER_CONTEXT_FENCE_UNAVAILABLE,
    ),
  }));
}

export function optionalP4cBuildProfiles(): Promise<
  OptionalP4cCapability<Readonly<{ empty: ModuleRecord; development: ModuleRecord }>>
> {
  return optional(P4C_BUILD_PROFILE_SEPARATION_UNAVAILABLE, async () => ({
    empty: await importPlannedModule(
      plannedModules.emptyBackend,
      ["createEmptyAgentBackendV1"],
      P4C_BUILD_PROFILE_SEPARATION_UNAVAILABLE,
    ),
    development: await importPlannedModule(
      plannedModules.developmentBackend,
      ["createDevelopmentSyntheticAgentBackendV1"],
      P4C_BUILD_PROFILE_SEPARATION_UNAVAILABLE,
    ),
  }));
}

export function optionalP4cRendererHost(): Promise<
  OptionalP4cCapability<Readonly<{ state: ModuleRecord; panel: ModuleRecord }>>
> {
  return optional(P4C_RENDERER_AGENT_HOST_UNAVAILABLE, async () => ({
    state: await importPlannedModule(
      plannedModules.viewState,
      ["createInitialAgentViewStateV1", "reduceAgentViewStateV1"],
      P4C_RENDERER_AGENT_HOST_UNAVAILABLE,
    ),
    panel: await importPlannedModule(
      plannedModules.panel,
      ["AgentPanel", "createAgentPanelControllerV1"],
      P4C_RENDERER_AGENT_HOST_UNAVAILABLE,
    ),
  }));
}

export async function runP4cVector(
  runner: P4cDesktopBoundaryRunner,
  vector: FrozenP4cVector,
): Promise<JsonRecord> {
  return requireRecord(
    await runner(executionInputForP4c(vector)),
    `${vector.id} actual result`,
  );
}
