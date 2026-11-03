export type AgentCapabilityV1 =
  | "start_turn"
  | "subscribe_run"
  | "cancel_run"
  | "resolve_artifact"
  | "resolve_citation";

export type AgentCallerContextV1 = Readonly<{
  senderId: number;
  isTopFrame: boolean;
  appOrigin: string;
  navigationEpoch: number;
  appSessionId: string;
  windowId: string;
  webContentsId: number;
  workspaceId: string;
  rootId: string;
}>;

const REQUIRED_CALLER_KEYS = Object.freeze([
  "senderId", "isTopFrame", "appOrigin", "navigationEpoch", "appSessionId",
  "windowId", "webContentsId", "workspaceId", "rootId",
] as const);
const OPERATION_CAPABILITY = Object.freeze({
  startTurn: "start_turn",
  subscribeRun: "subscribe_run",
  cancelRun: "cancel_run",
  resolveArtifact: "resolve_artifact",
  resolveCitation: "resolve_citation",
} as const);

function caller(value: unknown): AgentCallerContextV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("CallerContext is invalid");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== REQUIRED_CALLER_KEYS.length || REQUIRED_CALLER_KEYS.some((key) => !(key in row))) throw new TypeError("CallerContext is invalid");
  if (!Number.isSafeInteger(row.senderId) || !Number.isSafeInteger(row.webContentsId) || !Number.isSafeInteger(row.navigationEpoch) || row.isTopFrame !== true || typeof row.appOrigin !== "string" || typeof row.appSessionId !== "string" || typeof row.windowId !== "string" || typeof row.workspaceId !== "string" || typeof row.rootId !== "string") throw new TypeError("CallerContext is invalid");
  return Object.freeze({ ...(row as AgentCallerContextV1) });
}

function sameCaller(left: AgentCallerContextV1, right: unknown): boolean {
  try {
    const candidate = caller(right);
    return REQUIRED_CALLER_KEYS.every((key) => candidate[key] === left[key]);
  } catch {
    return false;
  }
}

export function createAgentCallerFenceV1(input: Readonly<{
  caller: AgentCallerContextV1;
  capabilities: readonly AgentCapabilityV1[];
  generation: number;
}>) {
  const owner = caller(input.caller);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !Array.isArray(input.capabilities)) throw new TypeError("Agent caller fence configuration is invalid");
  const capabilities = new Set<AgentCapabilityV1>(input.capabilities);
  if (capabilities.size !== input.capabilities.length || [...capabilities].some((value) => !Object.values(OPERATION_CAPABILITY).includes(value))) throw new TypeError("Agent capabilities are invalid");
  let generation = input.generation;
  let subscription: { hostRunId: string; snapshotHead: number; active: boolean; queued: number } | undefined;

  const authorizeInvocation = (request: Readonly<{ operation: keyof typeof OPERATION_CAPABILITY; caller: unknown }>) => {
    const capability = OPERATION_CAPABILITY[request.operation];
    return sameCaller(owner, request.caller) && capabilities.has(capability)
      ? Object.freeze({ allowed: true as const })
      : Object.freeze({ allowed: false as const, errorCode: "CAPABILITY_DENIED" as const });
  };

  return Object.freeze({
    authorizeInvocation,
    openSubscription(request: Readonly<{ caller: unknown; hostRunId: string; snapshotHead: number }>) {
      if (!sameCaller(owner, request.caller) || !capabilities.has("subscribe_run") || typeof request.hostRunId !== "string" || !Number.isSafeInteger(request.snapshotHead) || request.snapshotHead < 0 || subscription !== undefined) return Object.freeze({ opened: false as const, errorCode: "CAPABILITY_DENIED" as const });
      subscription = { hostRunId: request.hostRunId, snapshotHead: request.snapshotHead, active: false, queued: 0 };
      return Object.freeze({ opened: true as const, generation });
    },
    activateSubscription(request: Readonly<{ caller: unknown }>) {
      if (!sameCaller(owner, request.caller) || subscription === undefined) return Object.freeze({ activated: false as const, errorCode: "CAPABILITY_DENIED" as const });
      subscription.active = true;
      return Object.freeze({ activated: true as const });
    },
    authorizeSubscription(request: Readonly<{ caller: unknown }>): boolean {
      return sameCaller(owner, request.caller) && subscription !== undefined;
    },
    authorizeDelivery(request: Readonly<{ caller: unknown; hostSequence: number }>): boolean {
      return sameCaller(owner, request.caller) && subscription?.active === true && Number.isSafeInteger(request.hostSequence) && request.hostSequence > subscription.snapshotHead;
    },
    queueDelivery(request: Readonly<{ caller: unknown }>): boolean {
      if (!sameCaller(owner, request.caller) || subscription === undefined || subscription.active) return false;
      subscription.queued += 1;
      return true;
    },
    revoke(request: Readonly<{ reason: string; nextNavigationEpoch?: number }>): void {
      if (typeof request.reason !== "string") throw new TypeError("Revocation reason is invalid");
      generation += 1;
      subscription = undefined;
    },
    snapshot() {
      return Object.freeze({
        generation,
        activeSubscriptionCount: subscription?.active === true ? 1 : 0,
        dormantSubscriptionCount: subscription?.active === false ? 1 : 0,
        queuedDeliveryCount: subscription?.queued ?? 0,
      });
    },
  });
}

export type AgentCallerFenceV1 = ReturnType<typeof createAgentCallerFenceV1>;
