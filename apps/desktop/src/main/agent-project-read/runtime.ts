import { PROJECT_READ_LIMITS as L, type ProjectReadModel } from '../../shared/agent/agent-project-read';
import type { ModelSettingsHost } from '../cloud/model-settings-host';
import { createOpenCodePilotClient, OpenCodePilotError } from '../engine-pilot/opencode-client';
import type { startOpenCodeSupervisor, OpenCodeSupervisor } from '../engine-pilot/opencode-supervisor';
import type { ProjectReadEngine, ProjectReadEngineInput, ProjectReadNativeEngine } from './engine';
import { createProjectReadProviderServices, type ProjectReadProviderServices } from './provider-gateway';
import { createProjectReadNativeEngine } from './opencode-engine';
import { PROJECT_READ_DEFAULT_MODEL, parseProjectReadModel } from '../../shared/agent/agent-project-model';
import {parseReplyLimits,type ReplyLimits} from '../../shared/agent/reply-limits';
import {validateUnifiedChatRequest} from '../cloud/unified-chat-context';
import {createNativeConversationStore} from './native-conversation-store';

const fail = (): never => { throw new OpenCodePilotError(); };
const validId = (id: string): boolean => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(id);
type Frozen = { apiKey: string; model: ProjectReadModel; maxRequests: number | null; maxOutputTokens: number; requestTimeoutMs: number; replyLimits?:ReplyLimits };

/** Cold main-only vault: status reads metadata; explicit acceptance freezes the key before asynchronous preparation. */
export function createProjectReadModelSnapshots(settings: Pick<ModelSettingsHost, 'read' | 'key' | 'defaultModel'>, selection?: Readonly<{load():ProjectReadModel;save(model:ProjectReadModel):void}>) {
  let closed = false; const snapshots = new Map<string, Frozen>();
  let selected: ProjectReadModel = PROJECT_READ_DEFAULT_MODEL, selectionFailed = false;
  try { if (selection) selected = parseProjectReadModel(selection.load()) ?? fail(); } catch { selectionFailed = true; }
  const available = (model: ProjectReadModel): boolean => {
    const current = settings.read();
    return current.ok && current.value.storage === 'ready' && settings.defaultModel(model.provider) === model.model
      && current.value.providers.some(provider=>provider.provider === model.provider && provider.configured && provider.model === model.model);
  };
  const status = () => {
    if (closed || selectionFailed) return Object.freeze({ model: null, canStart: false, reason: 'MODEL_UNAVAILABLE' as const });
    try {
      if (!available(selected)) return Object.freeze({ model: selected, canStart: false, reason: 'MODEL_UNAVAILABLE' as const });
      return Object.freeze({ model: selected, canStart: true, reason: null });
    } catch { return Object.freeze({ model: null, canStart: false, reason: 'MODEL_UNAVAILABLE' as const }); }
  };
  const forget = (runId: string): void => { const value = snapshots.get(runId); if (value) value.apiKey = ''; snapshots.delete(runId); };
  return Object.freeze({
    status,
    select(value: ProjectReadModel): ProjectReadModel {
      const model = parseProjectReadModel(value); if (closed || selectionFailed || !model) return fail();
      try { selection?.save(model); } catch { selectionFailed = true; return fail(); }
      selected = model; return model;
    },
    freeze(runId: string, model: ProjectReadModel): ProjectReadModel {
      const parsed = parseProjectReadModel(model); if (!validId(runId) || !parsed || closed || selectionFailed) return fail();
      const prior = snapshots.get(runId); if (prior) { if (prior.replyLimits || prior.model.provider !== parsed.provider || prior.model.model !== parsed.model) return fail(); return prior.model; }
      if (selected.provider !== parsed.provider || selected.model !== parsed.model || !status().canStart || snapshots.size >= L.runs) return fail();
      const apiKey = settings.key(parsed.provider); if (!apiKey || !/^sk-[A-Za-z0-9_-]{8,512}$/u.test(apiKey)) return fail();
      snapshots.set(runId, { apiKey, model: parsed, maxRequests: L.requests, maxOutputTokens: L.maxOutputTokens, requestTimeoutMs: L.requestMs }); return parsed;
    },
    freezeChat(runId:string,model:ProjectReadModel,limits:ReplyLimits):ProjectReadModel {
      const parsed=parseProjectReadModel(model),replyLimits=parseReplyLimits(limits.maxOutputTokens,limits.timeoutMs);
      if(!validId(runId)||!parsed||closed)return fail();
      const prior=snapshots.get(runId);
      if(prior){if(!prior.replyLimits||prior.model.provider!==parsed.provider||prior.model.model!==parsed.model||prior.replyLimits.maxOutputTokens!==replyLimits.maxOutputTokens||prior.replyLimits.timeoutMs!==replyLimits.timeoutMs)return fail();return prior.model;}
      // ChatSession's accepted model is authoritative. Tool-picker selection and the
      // provider's currently selected default model cannot silently replace it.
      const current=settings.read();
      if(!current.ok||current.value.storage!=='ready'||!current.value.providers.some(provider=>provider.provider===parsed.provider&&provider.configured)||snapshots.size>=L.runs)return fail();
      const apiKey=settings.key(parsed.provider);if(!apiKey||!/^sk-[A-Za-z0-9_-]{8,512}$/u.test(apiKey))return fail();
      snapshots.set(runId,{apiKey,model:parsed,maxRequests:null,maxOutputTokens:replyLimits.maxOutputTokens,requestTimeoutMs:replyLimits.timeoutMs,replyLimits:Object.freeze(replyLimits)});return parsed;
    },
    get(runId: string): Readonly<Frozen> { const value = snapshots.get(runId); if (closed || !value) return fail(); return { ...value,...(value.replyLimits?{replyLimits:{...value.replyLimits}}:{}) }; },
    forget,
    close(): void { closed = true; for (const runId of snapshots.keys()) forget(runId); },
  });
}
export type ProjectReadModelSnapshots = Omit<ReturnType<typeof createProjectReadModelSnapshots>, 'select'|'freezeChat'> & Partial<Pick<ReturnType<typeof createProjectReadModelSnapshots>, 'select'|'freezeChat'>>;

export function createProjectReadRuntime(options: Readonly<{
  models: ProjectReadModelSnapshots;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  startNative: typeof startOpenCodeSupervisor;
  workCycle?: boolean;
  /** Main-owned instance mode; never inferred from a renderer/native request. */
  conversation?: boolean;
  onTraffic?: (value: unknown) => void;
}>): ProjectReadEngine {
  if(options.conversation!==undefined&&typeof options.conversation!=='boolean'||options.conversation===true&&options.workCycle!==true)return fail();
  const conversation=options.conversation===true;
  let disposed = false, state: 'idle' | 'starting' | 'ready' | 'failed' = 'idle', disposeFailed = false;
  let native: ProjectReadNativeEngine | undefined, services: ProjectReadProviderServices | undefined, supervisor: OpenCodeSupervisor | undefined;
  let startup: Promise<void> | undefined, shutdown: Promise<void> | undefined, execution: Promise<void> | undefined, current: ProjectReadEngineInput | undefined;
  const stops = new Map<string, Promise<void>>();
  const status = (): ReturnType<ProjectReadEngine['status']> => {
    const model = options.models.status();
    return disposed || state === 'failed' ? { model: model.model, canStart: false, processState: 'failed', reason: 'ENGINE_FAILED' } : { ...model, processState: state };
  };
  function initialize(): Promise<void> {
    if (startup) return startup; state = 'starting';
    startup = (async () => {
      services = await createProjectReadProviderServices({ fetchImpl: options.fetchImpl, getRunCredentials: runId => {
        if (disposed || stops.has(runId) || current?.runId !== runId || current.signal.aborted) return fail(); const saved = options.models.get(runId);
        return { apiKey: saved.apiKey, model: saved.model, maxRequests: saved.maxRequests, maxOutputTokens: saved.maxOutputTokens, requestTimeoutMs: saved.requestTimeoutMs,...(saved.replyLimits?{replyLimits:saved.replyLimits}:{}) };
      }, onResponse: (runId, value) => { if (!disposed && current?.runId === runId && !current.signal.aborted) current.callbacks.notice({ type: 'response', ...value }); }, ...(options.onTraffic ? { onTraffic: options.onTraffic } : {}) });
      if (disposed || current?.signal.aborted || current && stops.has(current.runId)) { await services.close(); return; }
      supervisor = await options.startNative({ services: { port: services.port, providerToken: services.providerToken, toolToken: services.toolToken }, profile: options.workCycle ? 'work-cycle' : 'project-read',...(conversation?{conversation:true}:{}) });
      if (disposed || current?.signal.aborted || current && stops.has(current.runId)) { await services.close(); if (!(await supervisor.stop()).exited) return fail(); return; }
      native = createProjectReadNativeEngine({ client: createOpenCodePilotClient({ port: supervisor.port, password: supervisor.password, directory: supervisor.directory, profile: options.workCycle ? 'work-cycle' : 'project-read',...(conversation?{conversation:true}:{}) }), services,...(conversation?{conversationStore:createNativeConversationStore(supervisor.conversationDirectory)}:{}) }); state = 'ready';
      void supervisor.exited.then(() => { if (!disposed) { state = 'failed'; try { if (current && !current.signal.aborted) current.callbacks.notice({ type: 'failed' }); } finally { dispose(); } } }).catch(() => { state = 'failed'; dispose(); });
    })().catch(async () => { state = 'failed'; try { await services?.close(); } catch {} try { await supervisor?.stop(); } catch {} return fail(); });
    void startup.catch(() => {}); return startup;
  }
  function dispose(): void {
    if (disposed) return; disposed = true;
    try { if (current) services?.end(current.runId); } catch { disposeFailed = true; }
    try { native?.dispose(); } catch { disposeFailed = true; }
    if (current) options.models.forget(current.runId);
  }
  function stop(runId: string): Promise<void> {
    const prior = stops.get(runId); if (prior) return prior;
    let failed = false; try { services?.end(runId); } catch { failed = true; }
    const result = (startup ?? Promise.resolve()).then(async () => { await native?.stop(runId); if (failed) return fail(); }).finally(() => { options.models.forget(runId); });
    stops.set(runId, result); void result.catch(() => { state = 'failed'; }); return result;
  }
  return Object.freeze({
    status, health: async () => status().canStart,
    canReuse: () => !disposed && state !== 'failed' && (conversation||stops.size < L.runs),
    accept(runId, model) { if (disposed || state === 'failed' || stops.has(runId)) return fail(); return options.models.freeze(runId, model); },
    acceptChat(runId,model,limits){if(!conversation||disposed||state==='failed'||stops.has(runId)||!options.models.freezeChat)return fail();return options.models.freezeChat(runId,model,limits);},
    setProjectContext(runId,context){if(disposed||state==='failed'||stops.has(runId)||current?.runId!==runId||current.signal.aborted||!current.chatContext||!services?.setProjectContext)return fail();services.setProjectContext(runId,context);},
    canDeliver: (runId, publication) => !disposed && current?.runId === runId && !current.signal.aborted && !!services?.canDeliver(runId, publication),
    accounting(runId) { const evidence = services?.evidence(runId); return { providerAttempts: evidence?.attempts ?? 0, httpDispatches: evidence?.httpRequests ?? 0, contextBytes: evidence?.contextBytes ?? 0,...(evidence?.failureReason?{failureReason:evidence.failureReason}:{}),...(evidence?.failureDiagnostic?{failureDiagnostic:evidence.failureDiagnostic}:{}) }; },
    start(input) {
      if (!!input.workCycle !== !!options.workCycle) return fail();
      if(!!input.chatContext!==conversation)return fail();
      if (disposed || state === 'failed' || stops.has(input.runId) || current && !current.signal.aborted || input.signal.aborted || !validId(input.runId)) return fail();
      const saved = options.models.get(input.runId); if (saved.model.model !== input.model.model || saved.model.provider !== input.model.provider) return fail();
      if(!!saved.replyLimits!==!!input.chatContext)return fail();
      if(input.nativeConversation&&!conversation)return fail();
      if(input.chatContext){const chat=validateUnifiedChatRequest(input.chatContext,input.nativeConversation?{nativeHistory:true}:undefined);if(chat.provider!==saved.model.provider||chat.model!==saved.model.model||chat.maxOutputTokens!==saved.maxOutputTokens||chat.timeoutMs!==saved.requestTimeoutMs)return fail();input={...input,chatContext:structuredClone(chat)};}
      const operation = (execution ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (disposed || stops.has(input.runId) || input.signal.aborted) return; current = input;
        try { await initialize(); if (disposed || stops.has(input.runId) || input.signal.aborted) return; if (!native) return fail(); await native.start({...input,callbacks:{...input.callbacks,notice:event=>input.callbacks.notice(event.type==='started'&&supervisor?.controller?{...event,controller:supervisor.controller}:event)}}); }
        catch { if (!disposed && !input.signal.aborted) input.callbacks.notice({ type: 'failed' }); throw new OpenCodePilotError(); }
        finally { if (current === input) current = undefined; options.models.forget(input.runId); }
      }); execution = operation; return operation;
    },
    async answer(runId, questionId, answer) { if (disposed || current?.runId !== runId || current.signal.aborted || !native) return fail(); await native.answer(runId, questionId, answer); },
    stop, dispose,
    shutdown(): Promise<void> {
      if (shutdown) return shutdown; dispose();
      shutdown = (async () => {
        let failed = disposeFailed; try { await startup; } catch { failed = true; }
        try { await native?.shutdown(); } catch { failed = true; }
        try { await services?.close(); } catch { failed = true; }
        try { if (supervisor && !(await supervisor.stop()).exited) failed = true; } catch { failed = true; }
        if (failed || disposeFailed) return fail();
      })(); void shutdown.catch(() => {}); return shutdown;
    },
  });
}
