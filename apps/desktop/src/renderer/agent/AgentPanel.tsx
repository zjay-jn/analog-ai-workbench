import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { AppMode, WorkbenchApiV1 } from "../../shared/app-info";
import type { AgentSubscriptionHandleV1, StartTurnRequestV1 } from "../../shared/agent/desktop-agent-api";
import type { AgentRecoveryActionV1 } from "../../../../../packages/agent-adapters/src/agent-contract";
import {
  createInitialAgentViewStateV1,
  reduceAgentViewStateV1,
  type AgentCitationCardV1,
  type AgentViewActionV1,
  type AgentViewStateV1,
} from "./agent-view-state";

type ControllerApiV1 = Pick<WorkbenchApiV1, "startTurn" | "subscribeRun" | "cancelRun" | "resolveArtifact" | "resolveCitation">;

export type AgentPanelControllerV1 = Readonly<{
  submitTurn: (request: unknown) => Promise<void>;
  requestCancel: () => Promise<void>;
  resolveCitation: (citationId: string) => Promise<void>;
  resume: () => Promise<void>;
  dispose: () => Promise<void>;
  snapshot: () => AgentViewStateV1;
}>;

export type AgentPanelPropsV1 = Readonly<{
  mode: AppMode;
  conversationTitle?: string;
  controller?: AgentPanelControllerV1;
}>;

const START_TURN_REQUEST_V1: StartTurnRequestV1 = Object.freeze({
  conversationId: "conversation.synthetic.middle-column",
  turnId: "turn.synthetic.middle-column.1",
  adapterProfileId: "profile.synthetic.deterministic",
  adapterProfileRevision: "rev-1",
  inputRefs: Object.freeze(["input.synthetic.fixed-turn"]),
  contextRefs: Object.freeze(["context.synthetic.reviewed-schematic"]),
});

const listenerRegistry = new WeakMap<AgentPanelControllerV1, Set<() => void>>();
const controllerMountEpochs = new WeakMap<AgentPanelControllerV1, number>();

function listenersFor(controller: AgentPanelControllerV1): Set<() => void> {
  let listeners = listenerRegistry.get(controller);
  if (listeners === undefined) {
    listeners = new Set();
    listenerRegistry.set(controller, listeners);
  }
  return listeners;
}

export function createAgentPanelControllerV1({ api }: Readonly<{ api: ControllerApiV1 }>): AgentPanelControllerV1 {
  let state = createInitialAgentViewStateV1();
  let generation = 0;
  let replaying = false;
  let disposed = false;
  let handle: AgentSubscriptionHandleV1 | null = null;
  let unsubscribePromise: Promise<void> | null = null;
  let ariaFlushSequence = 0;
  let pendingAriaFlush: number | null = null;
  let controller!: AgentPanelControllerV1;

  const reduce = (action: AgentViewActionV1): void => {
    if (disposed && action.type !== "unmount") return;
    const next = reduceAgentViewStateV1(state, action);
    if (next === state) return;
    state = next;
    for (const listener of listenersFor(controller)) listener();
  };

  const unsubscribeOnce = (): Promise<void> => {
    if (unsubscribePromise !== null) return unsubscribePromise;
    const current = handle;
    handle = null;
    unsubscribePromise = current === null ? Promise.resolve() : current.unsubscribe().catch(() => undefined);
    return unsubscribePromise;
  };

  const invalidateAriaFlush = (): void => {
    ariaFlushSequence += 1;
    pendingAriaFlush = null;
  };

  const scheduleAriaFlush = (flushGeneration: number): void => {
    if (pendingAriaFlush !== null) return;
    const flushSequence = ++ariaFlushSequence;
    pendingAriaFlush = flushSequence;
    queueMicrotask(() => {
      if (pendingAriaFlush === flushSequence) pendingAriaFlush = null;
      if (disposed || flushSequence !== ariaFlushSequence || flushGeneration !== generation) return;
      reduce({ type: "aria-flush", generation: flushGeneration });
    });
  };

  const subscribe = async (hostRunId: string, afterHostSequence: number): Promise<void> => {
    await unsubscribeOnce();
    unsubscribePromise = null;
    if (disposed) return;
    const subscriptionGeneration = generation;
    reduce({ type: "subscription-opened", generation: subscriptionGeneration });
    replaying = true;
    const result = await api.subscribeRun(
      afterHostSequence === 0 ? { hostRunId } : { hostRunId, afterHostSequence },
      (event) => {
        if (disposed || subscriptionGeneration !== generation) return;
        const replayed = replaying;
        reduce({ type: "canonical-event", event, replayed, generation: subscriptionGeneration });
        if (!replayed && event.type === "message.delta") scheduleAriaFlush(subscriptionGeneration);
        if (state.terminal) {
          handle = null;
          unsubscribePromise = null;
        }
      },
    );
    replaying = false;
    if (disposed || subscriptionGeneration !== generation) {
      if (result.ok) {
        handle = result.value;
        unsubscribePromise = null;
        await unsubscribeOnce();
      }
      return;
    }
    if (!result.ok) {
      reduce({ type: "start-failed", retryability: result.error.retryability, recoveryAction: result.error.recoveryAction });
      return;
    }
    handle = state.terminal ? null : result.value;
    reduce({ type: "subscription-live", generation: subscriptionGeneration });
  };

  const submitTurn = async (_request: unknown): Promise<void> => {
    if (disposed) return;
    invalidateAriaFlush();
    generation += 1;
    await unsubscribeOnce();
    unsubscribePromise = null;
    if (disposed) return;
    reduce({ type: "start-requested" });
    const result = await api.startTurn(START_TURN_REQUEST_V1);
    if (disposed) return;
    if (!result.ok) {
      reduce({ type: "start-failed", retryability: result.error.retryability, recoveryAction: result.error.recoveryAction });
      return;
    }
    reduce({ type: "run-started", hostRunId: result.value.hostRunId });
    await subscribe(result.value.hostRunId, 0);
  };

  const requestCancel = async (): Promise<void> => {
    if (disposed || state.hostRunId === undefined || !state.cancelEnabled) return;
    const hostRunId = state.hostRunId;
    reduce({ type: "cancel-requested" });
    const result = await api.cancelRun({ hostRunId });
    if (!disposed && !result.ok) reduce({ type: "cancel-failed" });
  };

  const resolveCitation = async (citationId: string): Promise<void> => {
    if (disposed) return;
    const citation = state.citations.find((candidate) => candidate.citationId === citationId);
    if (citation === undefined) return;
    const requestGeneration = generation;
    reduce({ type: "citation-loading", generation: requestGeneration, citationId });
    const result = await api.resolveCitation({ source: citation.source, locator: citation.locator, intent: "preview_source" });
    if (disposed || requestGeneration !== generation) return;
    if (!result.ok) {
      reduce({
        type: "citation-failed",
        generation: requestGeneration,
        citationId,
        freshness: result.error.code === "CAPABILITY_DENIED" ? "unauthorized" : result.error.code === "INTERNAL" ? "quarantined" : "unavailable",
      });
      return;
    }
    reduce({ type: "citation-resolved", generation: requestGeneration, citationId, revisionId: citation.revisionId, freshness: result.value.freshness });
  };

  const resume = async (): Promise<void> => {
    if (disposed || state.recoveryPending || !state.recoveryRequiresUserAction || state.recoveryAction !== "resume_from_cursor" || state.hostRunId === undefined) return;
    const hostRunId = state.hostRunId;
    const afterHostSequence = state.lastHostSequence;
    reduce({ type: "recovery-requested" });
    invalidateAriaFlush();
    generation += 1;
    await subscribe(hostRunId, afterHostSequence);
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return unsubscribePromise ?? Promise.resolve();
    disposed = true;
    invalidateAriaFlush();
    generation += 1;
    replaying = false;
    state = reduceAgentViewStateV1(state, { type: "unmount", generation });
    for (const listener of listenersFor(controller)) listener();
    await unsubscribeOnce();
  };

  controller = Object.freeze({ submitTurn, requestCancel, resolveCitation, resume, dispose, snapshot: () => state });
  listenersFor(controller);
  return controller;
}

function recoveryLabel(action: AgentRecoveryActionV1): string {
  if (action === "resume_from_cursor") return "Resume synthetic run";
  if (action === "retry_same_request") return "Retry synthetic request";
  if (action === "start_new_run") return "Start a new synthetic run";
  if (action === "reconfigure") return "Review local configuration";
  return "";
}

function sourceLabel(card: AgentCitationCardV1): string {
  if (card.source.sourceKind === "rag_source") return "Synthetic RAG source";
  if (card.source.sourceKind === "reviewed_schematic") return "Reviewed schematic";
  if (card.source.sourceKind === "artifact") return "Synthetic artifact";
  return "Synthetic document";
}

function CitationCard({ card, onResolve }: Readonly<{ card: AgentCitationCardV1; onResolve: (citationId: string) => void }>): React.JSX.Element {
  const unavailable = ["loading", "unavailable", "unauthorized", "revoked", "quarantined"].includes(card.freshness);
  return <article className="agent-citation-card">
    <div className="agent-card-heading"><strong>{sourceLabel(card)}</strong><span>{card.freshness}</span></div>
    {card.source.sourceKind === "rag_source" ? <p className="synthetic-rag-label">SYNTHETIC RAG SOURCE</p> : null}
    <p className="agent-card-revision">Exact revision: {card.revisionId}</p>
    {card.freshness === "historical" ? <p className="agent-card-warning" role="note">Historical revision · no latest fallback</p> : null}
    {card.previewText === undefined ? null : <p className="agent-citation-preview">{card.previewText}</p>}
    <button disabled={unavailable} onClick={() => onResolve(card.citationId)} type="button">{card.freshness === "loading" ? "Resolving…" : "Open exact source"}</button>
  </article>;
}

export function AgentPanel({ mode, conversationTitle = "软件产品主控", controller: injectedController }: AgentPanelPropsV1): React.JSX.Element {
  const controller = useMemo(() => injectedController ?? createAgentPanelControllerV1({ api: window.workbench }), [injectedController]);
  const [draft, setDraft] = useState("");
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const state = useSyncExternalStore(
    (listener) => { const listeners = listenersFor(controller); listeners.add(listener); return () => listeners.delete(listener); },
    controller.snapshot,
    controller.snapshot,
  );
  useEffect(() => {
    const mountEpoch = (controllerMountEpochs.get(controller) ?? 0) + 1;
    controllerMountEpochs.set(controller, mountEpoch);
    return () => {
      queueMicrotask(() => {
        if (controllerMountEpochs.get(controller) !== mountEpoch) return;
        controllerMountEpochs.delete(controller);
        void controller.dispose();
      });
    };
  }, [controller]);
  const productionUnavailable = mode === "production";
  const busy = ["starting", "running", "cancelling"].includes(state.lifecycle) || state.recoveryPending;
  const canSubmit = !productionUnavailable && !busy && draft.trim().length > 0;
  const submitDraft = (): void => {
    const prompt = draft.trim();
    if (!canSubmit || prompt.length === 0) return;
    setSubmittedPrompt(prompt);
    setDraft("");
    void controller.submitTurn({});
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submitDraft();
  };
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submitDraft();
  };
  return <section className="agent-panel" aria-labelledby="agent-panel-title">
    <div className="agent-panel-heading"><h1 id="agent-panel-title">{conversationTitle}</h1><span className="agent-safety-label" id="agent-safety-label">SYNTHETIC AGENT · NO MODEL · NO TOOLS</span></div>
    <span className="agent-lifecycle" data-lifecycle={state.lifecycle}>{state.lifecycle}</span>
    {productionUnavailable ? <div className="agent-unavailable" role="status"><strong>Synthetic Agent is not configured.</strong><p>Production keeps the Agent, RAG and tool registries empty.</p></div> : <>
      <div className="agent-transcript" aria-label="Synthetic Agent transcript">
        {submittedPrompt.length === 0 && state.messageText.length === 0 ? <p className="agent-empty-message">在下方输入消息开始对话。</p> : null}
        {submittedPrompt.length === 0 ? null : <article aria-label="你的消息" className="agent-message agent-user-message"><p>{submittedPrompt}</p></article>}
        {state.messageText.length === 0 ? null : <article aria-label="Agent 回复" className="agent-message"><p>{state.messageText}</p></article>}
        {state.citations.length === 0 ? null : <div className="agent-citation-list" aria-label="Synthetic citations">{state.citations.map((card) => <CitationCard card={card} key={card.citationId} onResolve={(citationId) => void controller.resolveCitation(citationId)} />)}</div>}
      </div>
      {state.recoveryRequiresUserAction ? <div className="agent-recovery" role="group" aria-label="Synthetic run recovery"><p>Recovery is available only after your explicit action.</p><button disabled={state.recoveryPending} onClick={() => void controller.resume()} type="button">{state.recoveryPending ? "Working…" : recoveryLabel(state.recoveryAction)}</button></div> : null}
    </>}
    <form className="agent-composer" onSubmit={handleSubmit}>
      <textarea
        aria-describedby="agent-safety-label"
        aria-label="消息输入"
        disabled={productionUnavailable || busy}
        maxLength={4000}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={handleComposerKeyDown}
        placeholder={productionUnavailable ? "Agent 后端尚未配置" : "输入消息"}
        rows={3}
        value={draft}
      />
      <div className="agent-composer-footer">
        {state.cancelEnabled ? <button aria-label="停止生成" className="agent-composer-action agent-composer-stop" onClick={() => void controller.requestCancel()} type="button">Cancel</button> : <button aria-label="发送消息" className="agent-composer-action agent-composer-send" disabled={!canSubmit} type="submit">Start synthetic turn</button>}
      </div>
    </form>
    <div className="agent-aria-polite" aria-atomic="true" aria-live="polite">{state.politeAnnouncement}</div>
    <div className="agent-aria-status" aria-atomic="true" role="status">{state.statusAnnouncement}</div>
  </section>;
}
