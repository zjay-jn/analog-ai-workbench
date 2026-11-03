import {
  AGENT_CHANNELS_V1,
  createAgentSafeFailureV1,
  parseAgentDesktopEventV1,
  parseAgentDesktopRequestV1,
  parseSubscribeControlV1,
  type AgentDesktopMethodV1,
  type CanonicalEventV1,
} from "../../../shared/agent/desktop-agent-api";
import { parseCanonicalEventV1 } from "../../../../../../packages/agent-adapters/src/canonical-contract";
import { parseResolveArtifactRequestV1, parseResolveCitationRequestV1 } from "../../../../../../packages/agent-adapters/src/public-contract";
import type { AgentCallerContextV1, AgentCallerFenceV1 } from "../../agent/agent-caller-fence";
import type { DesktopAgentHostV1 } from "../../agent/desktop-agent-host";

type IpcMainLike = Readonly<{
  removeHandler(channel: string): void;
  handle(channel: string, handler: (event: unknown, request: unknown) => unknown): void;
}>;

const CHANNEL_METHOD = Object.freeze({
  [AGENT_CHANNELS_V1[0]]: "startTurn",
  [AGENT_CHANNELS_V1[2]]: "cancelRun",
  [AGENT_CHANNELS_V1[3]]: "resolveArtifact",
  [AGENT_CHANNELS_V1[4]]: "resolveCitation",
} as const);

type SubscriptionV1 = {
  readonly generation: number;
  readonly caller: AgentCallerContextV1;
  readonly fence: AgentCallerFenceV1;
  readonly hostRunId: string;
  readonly replay: CanonicalEventV1[];
  readonly queued: CanonicalEventV1[];
  readonly delivered: Set<number>;
  readonly closeHostRegistration: () => void;
  nextHostSequence: number;
  terminal: boolean;
  active: boolean;
  revoked: boolean;
  draining: boolean;
};

export function registerAgentIpcHandlersV1(options: Readonly<{
  ipcMain: IpcMainLike;
  host: DesktopAgentHostV1;
  invocationFence: AgentCallerFenceV1;
  createSubscriptionFence: () => AgentCallerFenceV1;
  deriveCallerContext: (event: unknown) => AgentCallerContextV1 | null;
  deriveCurrentCallerContext: () => AgentCallerContextV1 | null;
  createSubscriptionId: () => string;
  deliver: (channel: typeof AGENT_CHANNELS_V1[1], payload: unknown) => void;
}>) {
  const host = options.host;
  const subscriptions = new Map<string, SubscriptionV1>();

  function revoke(subscriptionId: string, subscription: SubscriptionV1, notify: boolean): void {
    if (subscription.revoked) return;
    subscription.fence.revoke({ reason: "subscription-closed" });
    subscription.revoked = true;
    subscription.active = false;
    subscription.replay.length = 0;
    subscription.queued.length = 0;
    subscription.closeHostRegistration();
    subscriptions.delete(subscriptionId);
    if (notify) options.deliver(AGENT_CHANNELS_V1[1], Object.freeze({ kind: "closed", subscriptionId, generation: subscription.generation }));
  }

  function drain(subscriptionId: string, subscription: SubscriptionV1): void {
    if (!subscription.active || subscription.revoked || subscription.draining) return;
    subscription.draining = true;
    try {
      while (!subscription.revoked) {
        const event = subscription.replay.shift() ?? subscription.queued.shift();
        if (event === undefined) break;
        if (subscription.delivered.has(event.hostSequence)) continue;
        if (event.hostSequence !== subscription.nextHostSequence) {
          revoke(subscriptionId, subscription, true);
          break;
        }
        const currentCaller = options.deriveCurrentCallerContext();
        if (currentCaller === null || !host.authorizeRun(currentCaller, subscription.hostRunId) || !subscription.fence.authorizeDelivery({ caller: currentCaller, hostSequence: event.hostSequence })) {
          revoke(subscriptionId, subscription, true);
          break;
        }
        const canonicalEvent = parseCanonicalEventV1(parseAgentDesktopEventV1(event));
        subscription.delivered.add(canonicalEvent.hostSequence);
        subscription.nextHostSequence += 1;
        options.deliver(AGENT_CHANNELS_V1[1], Object.freeze({ kind: "deliver", subscriptionId, generation: subscription.generation, event: canonicalEvent }));
      }
      if (!subscription.revoked && subscription.terminal && subscription.replay.length === 0 && subscription.queued.length === 0) revoke(subscriptionId, subscription, true);
    } finally {
      subscription.draining = false;
    }
  }

  const invoke = (method: AgentDesktopMethodV1, event: unknown, requestValue: unknown): unknown => {
    const caller = options.deriveCallerContext(event);
    if (caller === null || !options.invocationFence.authorizeInvocation({ operation: method, caller }).allowed) return createAgentSafeFailureV1("CAPABILITY_DENIED");
    try {
      const boundary = parseAgentDesktopRequestV1(requestValue, method);
      const request = method === "resolveArtifact" ? parseResolveArtifactRequestV1(boundary) : method === "resolveCitation" ? parseResolveCitationRequestV1(boundary) : boundary;
      return host.invoke(method, request, caller);
    } catch {
      return createAgentSafeFailureV1("INVALID_REQUEST");
    }
  };

  for (const [channel, method] of Object.entries(CHANNEL_METHOD)) {
    options.ipcMain.removeHandler(channel);
    options.ipcMain.handle(channel, (event, request) => invoke(method, event, request));
  }

  options.ipcMain.removeHandler(AGENT_CHANNELS_V1[1]);
  options.ipcMain.handle(AGENT_CHANNELS_V1[1], (event, value) => {
    const caller = options.deriveCallerContext(event);
    if (caller === null || !options.invocationFence.authorizeInvocation({ operation: "subscribeRun", caller }).allowed) return createAgentSafeFailureV1("CAPABILITY_DENIED");
    try {
      const control = parseSubscribeControlV1(value);
      if (control.kind === "open") {
        const after = control.request.afterHostSequence ?? 0;
        const subscriptionId = options.createSubscriptionId();
        if (!/^(?!latest$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(subscriptionId) || subscriptions.has(subscriptionId)) {
          return createAgentSafeFailureV1("INTERNAL");
        }
        let subscription: SubscriptionV1 | undefined;
        const opened = host.openSubscription(caller, control.request.hostRunId, after, (eventValue) => {
          if (subscription === undefined || subscription.revoked) return;
          const event = parseAgentDesktopEventV1(eventValue);
          if (event.hostSequence > openedHead) subscription.queued.push(event);
          if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") subscription.terminal = true;
          drain(subscriptionId, subscription);
        });
        if (!opened.ok) return opened;
        const openedHead = opened.value.head;
        const fence = options.createSubscriptionFence();
        const fenceResult = fence.openSubscription({ caller, hostRunId: control.request.hostRunId, snapshotHead: after });
        if (!fenceResult.opened) { opened.value.close(); return createAgentSafeFailureV1("CAPABILITY_DENIED"); }
        subscription = {
          generation: fenceResult.generation,
          caller,
          fence,
          hostRunId: control.request.hostRunId,
          replay: [...opened.value.events],
          queued: [],
          delivered: new Set(),
          closeHostRegistration: opened.value.close,
          nextHostSequence: after + 1,
          terminal: opened.value.terminal,
          active: false,
          revoked: false,
          draining: false,
        };
        subscriptions.set(subscriptionId, subscription);
        return Object.freeze({ ok: true as const, value: Object.freeze({ subscriptionId, generation: fenceResult.generation, snapshotHead: openedHead }) });
      }
      const subscription = subscriptions.get(control.subscriptionId);
      if (subscription === undefined || subscription.generation !== control.generation || !subscription.fence.authorizeSubscription({ caller }) || !host.authorizeRun(caller, subscription.hostRunId)) return createAgentSafeFailureV1("CAPABILITY_DENIED");
      if (control.kind === "activate") {
        const activated = subscription.fence.activateSubscription({ caller });
        if (!activated.activated) return createAgentSafeFailureV1("CAPABILITY_DENIED");
        subscription.active = true;
        drain(control.subscriptionId, subscription);
        return Object.freeze({ ok: true as const, value: Object.freeze({ closed: true as const }) });
      }
      revoke(control.subscriptionId, subscription, true);
      return Object.freeze({ ok: true as const, value: Object.freeze({ closed: true as const }) });
    } catch {
      return createAgentSafeFailureV1("INVALID_REQUEST");
    }
  });

  return Object.freeze({
    revokeAll(reason: string) {
      for (const [subscriptionId, subscription] of [...subscriptions]) {
        subscription.fence.revoke({ reason });
        subscription.revoked = true;
        subscription.active = false;
        subscription.replay.length = 0;
        subscription.queued.length = 0;
        subscription.closeHostRegistration();
        subscriptions.delete(subscriptionId);
      }
    },
    dispose() {
      for (const channel of AGENT_CHANNELS_V1) options.ipcMain.removeHandler(channel);
      for (const [subscriptionId, subscription] of [...subscriptions]) revoke(subscriptionId, subscription, false);
    },
  });
}
