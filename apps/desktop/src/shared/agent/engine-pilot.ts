export const PILOT_VERSION = 'workbench.engine-pilot.v1' as const;
export const PILOT_RULES_REVISION = 'pilot-rules-1' as const;
export const PILOT_METHODS = ['getStatus', 'listRuns', 'startRun', 'readRun', 'answerQuestion', 'stopRun'] as const;
export type PilotMethod = typeof PILOT_METHODS[number];
export const pilotChannel = (method: PilotMethod): string => `workbench.enginePilot.${method}.v1`;
export const PILOT_LIMITS = Object.freeze({ runs: 32, events: 512, batch: 32, batchBytes: 262144, goalBytes: 4096, answerBytes: 4096, deltaBytes: 2048, outputBytes: 65536, contextBytes: 65536, eventBytes: 16384, runBytes: 1048576, diskBytes: 33554432, steps: 4, calls: 8, questions: 4, deadlineMs: 120000, waitMs: 1800000 });
export const LIVE_LIMITS = Object.freeze({steps:8,requests:8,maxOutputTokens:16384,requestTimeoutMs:600000,deadlineMs:4800000});
export type PilotKind = 'fake' | 'opencode';
/** Requested service identity. Provider response identity is recorded separately, never inferred. */
export type PilotModel = Readonly<{ provider:'deepseek'; model:'deepseek-v4-flash' }>;
export type PilotLiveStatus = Readonly<{ model?:PilotModel; canStart:boolean; processState:'idle'|'starting'|'ready'|'failed'; availability:'available'|'not_configured'|'unsupported_model'|'unavailable' }>;
export type PilotState = 'running' | 'waiting_user' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export const PILOT_ERRORS = ['INVALID_REQUEST','CAPABILITY_DENIED','NOT_READY','BUSY','SESSION_LIMIT','NOT_FOUND','STALE_QUESTION','STORAGE_FAILED','ENGINE_FAILED','LIMIT_EXCEEDED','INTERNAL'] as const;
export type PilotError = typeof PILOT_ERRORS[number];
export type PilotFailure = Readonly<{ ok: false; error: Readonly<{ code: PilotError }> }>;
export type PilotResult<T> = Readonly<{ ok: true; value: T }> | PilotFailure;
export type SumArguments = Readonly<{ values: readonly number[] }>;
export type SumValue = Readonly<{ sum: number; count: number; source: 'deterministic-local'; toolVersion: 'pilot.sum.v1' }>;
export type PilotUsage = Readonly<{ inputTokens: number; outputTokens: number }> | null;
export type PilotEventData = {
  'run.accepted': Readonly<{ goal: string; constraint: string; engineKind: PilotKind; engineVersion: string; rulesRevision: typeof PILOT_RULES_REVISION; model?:PilotModel }>;
  'engine.started': Readonly<{ sessionId: string }>;
  'model.step': Readonly<{ step: number; usage: PilotUsage }>;
  'model.response': Readonly<{ request:number; responseModel:string|null; usage:PilotUsage }>;
  'message.delta': Readonly<{ text: string }>;
  'tool.started': Readonly<{ callId: string; toolName: 'pilot.sum.v1'; arguments: SumArguments }>;
  'tool.completed': Readonly<{ callId: string; result: SumValue }>;
  'question.asked': Readonly<{ questionId: string; prompt: string }>;
  'question.answered': Readonly<{ questionId: string; answer: string }>;
  'run.completed': Readonly<Record<string, never>>;
  'run.failed': Readonly<{ code: 'ENGINE_FAILED' | 'LIMIT_EXCEEDED' | 'PROTOCOL_ERROR' | 'NO_PROGRESS'; stage: 'engine' | 'tool' | 'context' | 'deadline' }>;
  'run.stopped': Readonly<{ reason: 'user' }>;
  'run.interrupted': Readonly<{ reason: 'restart' | 'window' | 'question_timeout' }>;
};
export type PilotEvent = { [K in keyof PilotEventData]: Readonly<{ runId: string; sequence: number; time: string; type: K; data: PilotEventData[K] }> }[keyof PilotEventData];
export type PilotRun = Readonly<{ runId: string; clientRequestId: string; goal: string; constraint: string; status: PilotState; createdAt: string; updatedAt: string; engineKind: PilotKind; engineVersion: string; model?:PilotModel; events: readonly PilotEvent[] }>;
export type PilotDisk = Readonly<{ version: 1; runs: readonly PilotRun[] }>;
export type PilotSummary = Omit<PilotRun, 'constraint' | 'clientRequestId' | 'events' | 'engineVersion'>;
export type PilotStatus = Readonly<{ engineKind: PilotKind; engineVersion: string; ready: boolean; capabilities: readonly ['pilot.sum.v1']; maxRuns: 32 }> & Partial<PilotLiveStatus>;
export type PilotRead = Readonly<{ runId: string; events: readonly PilotEvent[]; nextSequence: number; terminal: boolean }>;
export type PilotRequests = {
  getStatus: Readonly<{ contractVersion: typeof PILOT_VERSION }>;
  listRuns: Readonly<{ contractVersion: typeof PILOT_VERSION }>;
  startRun: Readonly<{ contractVersion: typeof PILOT_VERSION; clientRequestId: string; goal: string; constraint: string; model?:PilotModel }>;
  readRun: Readonly<{ contractVersion: typeof PILOT_VERSION; runId: string; afterSequence: number }>;
  answerQuestion: Readonly<{ contractVersion: typeof PILOT_VERSION; runId: string; questionId: string; answer: string }>;
  stopRun: Readonly<{ contractVersion: typeof PILOT_VERSION; runId: string }>;
};
export type PilotValues = { getStatus: PilotStatus; listRuns: Readonly<{ runs: readonly PilotSummary[] }>; startRun: Readonly<{ runId: string }>; readRun: PilotRead; answerQuestion: Readonly<{ accepted: true }>; stopRun: Readonly<{ status: 'stopped' | 'already_terminal' }> };
export type EnginePilotApi = { readonly [K in PilotMethod]: (request: PilotRequests[K]) => Promise<PilotResult<PilotValues[K]>> };
export const pilotFailure = (code: PilotError): PilotFailure => Object.freeze({ ok: false, error: Object.freeze({ code }) });
export const pilotBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
export const pilotTerminal = (state: PilotState): boolean => state !== 'running' && state !== 'waiting_user';
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
function invalid(): never { throw new TypeError('Invalid engine pilot contract'); }
const optionalKey=(value:unknown,key:string):string[]=>value!==null&&typeof value==='object'&&Object.hasOwn(value,key)?[key]:[];
export function parsePilotModel(value:unknown):PilotModel {const v=pilotExact(value,['provider','model']);if(v.provider!=='deepseek'||v.model!=='deepseek-v4-flash')invalid();return Object.freeze({provider:v.provider,model:v.model});}
const modelField=(value:Record<string,unknown>):{model?:PilotModel}=>Object.hasOwn(value,'model')?{model:parsePilotModel(value.model)}:{};
export function pilotExact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) invalid();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid(); out[key] = descriptor.value; }
  return out;
}
export function pilotText(value: unknown, max: number, nonblank = true): string {
  if (typeof value !== 'string' || (nonblank && !value.trim()) || new TextEncoder().encode(value).length > max || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid();
  return value;
}
function integer(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < min || (value as number) > max) invalid(); return value as number; }
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T { if (typeof value !== 'string' || !choices.includes(value as T)) invalid(); return value as T; }
export function pilotId(value: unknown, kind: 'run' | 'uuid' | 'native'): string {
  const pattern = kind === 'native' ? /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u : new RegExp(`^${kind === 'run' ? 'pilot\\.' : ''}${uuidPattern}$`, 'u');
  if (typeof value !== 'string' || !pattern.test(value)) invalid(); return value;
}
function timestamp(value: unknown): string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value; }
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  return Array.from({ length: value.length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !('value' in d)) invalid(); return d.value; });
}
export function parseSumArguments(value: unknown): SumArguments { const v = pilotExact(value, ['values']); const values = array(v.values, 32).map(n => integer(n, -1000000, 1000000)); if (!values.length) invalid(); return Object.freeze({ values: Object.freeze(values) }); }
export function parseSumValue(value: unknown): SumValue { const v = pilotExact(value, ['sum','count','source','toolVersion']); if (v.source !== 'deterministic-local' || v.toolVersion !== 'pilot.sum.v1') invalid(); return Object.freeze({ sum: integer(v.sum, -32000000, 32000000), count: integer(v.count, 1, 32), source: v.source, toolVersion: v.toolVersion }); }
export function parsePilotUsage(value: unknown): PilotUsage { if (value === null) return null; const v = pilotExact(value, ['inputTokens','outputTokens']); return Object.freeze({ inputTokens: integer(v.inputTokens, 0, Number.MAX_SAFE_INTEGER), outputTokens: integer(v.outputTokens, 0, Number.MAX_SAFE_INTEGER) }); }
export function parsePilotRequest<K extends PilotMethod>(method: K, value: unknown): PilotRequests[K] {
  const keys: Record<PilotMethod, readonly string[]> = { getStatus: [], listRuns: [], startRun: ['clientRequestId','goal','constraint'], readRun: ['runId','afterSequence'], answerQuestion: ['runId','questionId','answer'], stopRun: ['runId'] };
  const v = pilotExact(value, ['contractVersion', ...keys[method], ...(method==='startRun'?optionalKey(value,'model'):[])]); if (v.contractVersion !== PILOT_VERSION) invalid();
  const out: Record<string, unknown> = { contractVersion: PILOT_VERSION };
  if ('runId' in v) out.runId = pilotId(v.runId, 'run');
  if (method === 'startRun') Object.assign(out, { clientRequestId: pilotId(v.clientRequestId, 'uuid'), goal: pilotText(v.goal, 4096), constraint: pilotText(v.constraint, 4096, false), ...modelField(v) });
  if (method === 'readRun') out.afterSequence = integer(v.afterSequence, 0, 512);
  if (method === 'answerQuestion') Object.assign(out, { questionId: pilotId(v.questionId, 'native'), answer: pilotText(v.answer, 4096) });
  return Object.freeze(out) as PilotRequests[K];
}
export function parsePilotEvent(value: unknown): PilotEvent {
  const v = pilotExact(value, ['runId','sequence','time','type','data']);
  const type = oneOf(v.type, ['run.accepted','engine.started','model.step','model.response','message.delta','tool.started','tool.completed','question.asked','question.answered','run.completed','run.failed','run.stopped','run.interrupted'] as const);
  let data: unknown;
  switch (type) {
    case 'run.accepted': { const d = pilotExact(v.data, ['goal','constraint','engineKind','engineVersion','rulesRevision',...optionalKey(v.data,'model')]); if (d.rulesRevision !== PILOT_RULES_REVISION || (Object.hasOwn(d,'model')&&d.engineKind!=='opencode')) invalid(); data = { goal: pilotText(d.goal,4096), constraint: pilotText(d.constraint,4096,false), engineKind: oneOf(d.engineKind,['fake','opencode']), engineVersion: pilotText(d.engineVersion,128), rulesRevision: d.rulesRevision, ...modelField(d) }; break; }
    case 'engine.started': { const d = pilotExact(v.data,['sessionId']); data = { sessionId: pilotId(d.sessionId,'native') }; break; }
    case 'model.step': { const d = pilotExact(v.data,['step','usage']); data = { step: integer(d.step,1,LIVE_LIMITS.steps), usage: parsePilotUsage(d.usage) }; break; }
    case 'model.response': {const d=pilotExact(v.data,['request','responseModel','usage']);data={request:integer(d.request,1,LIVE_LIMITS.requests),responseModel:d.responseModel===null?null:pilotText(d.responseModel,128),usage:parsePilotUsage(d.usage)};break;}
    case 'message.delta': { const d = pilotExact(v.data,['text']); data = { text: pilotText(d.text,2048,false) }; break; }
    case 'tool.started': { const d = pilotExact(v.data,['callId','toolName','arguments']); if (d.toolName !== 'pilot.sum.v1') invalid(); data = { callId: pilotId(d.callId,'native'), toolName: d.toolName, arguments: parseSumArguments(d.arguments) }; break; }
    case 'tool.completed': { const d = pilotExact(v.data,['callId','result']); data = { callId: pilotId(d.callId,'native'), result: parseSumValue(d.result) }; break; }
    case 'question.asked': { const d = pilotExact(v.data,['questionId','prompt']); data = { questionId: pilotId(d.questionId,'native'), prompt: pilotText(d.prompt,4096) }; break; }
    case 'question.answered': { const d = pilotExact(v.data,['questionId','answer']); data = { questionId: pilotId(d.questionId,'native'), answer: pilotText(d.answer,4096) }; break; }
    case 'run.completed': pilotExact(v.data,[]); data = {}; break;
    case 'run.failed': { const d = pilotExact(v.data,['code','stage']); data = { code: oneOf(d.code,['ENGINE_FAILED','LIMIT_EXCEEDED','PROTOCOL_ERROR','NO_PROGRESS']), stage: oneOf(d.stage,['engine','tool','context','deadline']) }; break; }
    case 'run.stopped': { const d = pilotExact(v.data,['reason']); data = { reason: oneOf(d.reason,['user']) }; break; }
    case 'run.interrupted': { const d = pilotExact(v.data,['reason']); data = { reason: oneOf(d.reason,['restart','window','question_timeout']) }; break; }
  }
  const event = Object.freeze({ runId: pilotId(v.runId,'run'), sequence: integer(v.sequence,1,512), time: timestamp(v.time), type, data: Object.freeze(data as object) }) as PilotEvent;
  if (pilotBytes(event) > PILOT_LIMITS.eventBytes) invalid(); return event;
}
export function pilotEventState(event: PilotEvent): PilotState | undefined { return event.type === 'run.accepted' || event.type === 'question.answered' ? 'running' : event.type === 'question.asked' ? 'waiting_user' : event.type === 'run.completed' ? 'completed' : event.type === 'run.failed' ? 'failed' : event.type === 'run.stopped' ? 'stopped' : event.type === 'run.interrupted' ? 'interrupted' : undefined; }
function summary(value: unknown): PilotSummary { const v = pilotExact(value,['runId','goal','status','createdAt','updatedAt','engineKind',...optionalKey(value,'model')]); if(Object.hasOwn(v,'model')&&v.engineKind!=='opencode')invalid(); return Object.freeze({ runId: pilotId(v.runId,'run'), goal: pilotText(v.goal,4096), status: oneOf(v.status,['running','waiting_user','completed','failed','stopped','interrupted']), createdAt: timestamp(v.createdAt), updatedAt: timestamp(v.updatedAt), engineKind: oneOf(v.engineKind,['fake','opencode']), ...modelField(v) }); }
export function parsePilotResult<K extends PilotMethod>(method: K, value: unknown): PilotResult<PilotValues[K]> {
  if (value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value,'ok')?.value === false) { const v = pilotExact(value,['ok','error']); const e = pilotExact(v.error,['code']); return pilotFailure(oneOf(e.code,PILOT_ERRORS)); }
  const v = pilotExact(value,['ok','value']); if (v.ok !== true) invalid(); let result: unknown;
  if (method === 'getStatus') { const live=optionalKey(v.value,'canStart').length>0; const d = pilotExact(v.value,['engineKind','engineVersion','ready','capabilities','maxRuns',...(live?['canStart','processState','availability',...optionalKey(v.value,'model')]:[])]); const capabilities=array(d.capabilities,1); if (typeof d.ready !== 'boolean' || d.maxRuns !== 32 || capabilities.length!==1 || capabilities[0]!=='pilot.sum.v1') invalid(); let extra:Partial<PilotLiveStatus>={};if(live){if(d.engineKind!=='opencode'||typeof d.canStart!=='boolean')invalid();const processState=oneOf(d.processState,['idle','starting','ready','failed']),availability=oneOf(d.availability,['available','not_configured','unsupported_model','unavailable']);if(d.canStart!==(availability==='available')||(d.canStart&&!Object.hasOwn(d,'model'))||d.ready!==(processState==='ready'&&d.canStart))invalid();extra={...modelField(d),canStart:d.canStart,processState,availability};} result = { engineKind: oneOf(d.engineKind,['fake','opencode']), engineVersion: pilotText(d.engineVersion,128), ready: d.ready, capabilities: Object.freeze(['pilot.sum.v1']), maxRuns:32,...extra }; }
  else if (method === 'listRuns') { const d = pilotExact(v.value,['runs']); const runs = array(d.runs,32).map(summary); if (new Set(runs.map(r=>r.runId)).size !== runs.length) invalid(); result = { runs: Object.freeze(runs) }; }
  else if (method === 'startRun') { const d = pilotExact(v.value,['runId']); result = { runId: pilotId(d.runId,'run') }; }
  else if (method === 'readRun') { const d = pilotExact(v.value,['runId','events','nextSequence','terminal']); const runId = pilotId(d.runId,'run'), nextSequence = integer(d.nextSequence,0,512), events = array(d.events,32).map(parsePilotEvent); if (typeof d.terminal !== 'boolean' || events.some((e,i)=>e.runId!==runId || e.sequence!==nextSequence-events.length+i+1)) invalid(); result = { runId, events: Object.freeze(events), nextSequence, terminal:d.terminal }; }
  else if (method === 'answerQuestion') { const d = pilotExact(v.value,['accepted']); if (d.accepted !== true) invalid(); result = { accepted:true }; }
  else { const d = pilotExact(v.value,['status']); result = { status:oneOf(d.status,['stopped','already_terminal']) }; }
  const parsed = Object.freeze({ ok:true, value:Object.freeze(result as object) }) as PilotResult<PilotValues[K]>;
  if (pilotBytes(parsed) > PILOT_LIMITS.batchBytes) invalid(); return parsed;
}
export function parsePilotDisk(value: unknown): PilotDisk {
  const d = pilotExact(value,['version','runs']); if (d.version !== 1) invalid();
  const runs = array(d.runs,32).map(value=>{
    const v = pilotExact(value,['runId','clientRequestId','goal','constraint','status','createdAt','updatedAt','engineKind','engineVersion','events',...optionalKey(value,'model')]);
    const base = summary({ runId:v.runId, goal:v.goal, status:v.status, createdAt:v.createdAt, updatedAt:v.updatedAt, engineKind:v.engineKind,...modelField(v) });
    const events = array(v.events,512).map(parsePilotEvent); let state: PilotState = 'running'; const calls = new Map<string, SumArguments>(); const completed = new Set<string>(); const questions = new Set<string>(); let pending: string | undefined, steps=0, session=false, output=0;
    for (let i=0;i<events.length;i++) { const e=events[i]!; if (e.runId!==base.runId || e.sequence!==i+1 || (i>0 && pilotTerminal(state))) invalid();
      if(i===0 && (e.type!=='run.accepted' || e.data.goal!==base.goal || e.data.constraint!==v.constraint || e.data.engineKind!==base.engineKind || e.data.engineVersion!==v.engineVersion || JSON.stringify(e.data.model)!==JSON.stringify(base.model) || e.time!==base.createdAt)) invalid();
      if(i>0 && e.type==='run.accepted') invalid();
      if(e.type==='engine.started') { if(session) invalid(); session=true; }
      if(e.type==='model.step') { if(!session || e.data.step!==++steps || steps>(base.model?LIVE_LIMITS.steps:PILOT_LIMITS.steps)) invalid(); }
      if(e.type==='model.response'){const prior=events.slice(0,i).filter(x=>x.type==='model.response').at(-1);if(!session||!base.model||e.data.request<=(prior?.data.request??0))invalid();}
      if(e.type==='tool.started') { if(!session || pending || calls.has(e.data.callId) || calls.size>=8) invalid(); calls.set(e.data.callId,e.data.arguments); }
      if(e.type==='tool.completed') { const args=calls.get(e.data.callId); if(!args || completed.has(e.data.callId) || e.data.result.count!==args.values.length || e.data.result.sum!==args.values.reduce((a,b)=>a+b,0)) invalid(); completed.add(e.data.callId); }
      if(e.type==='question.asked') { if(!session || pending || questions.has(e.data.questionId) || questions.size>=4) invalid(); pending=e.data.questionId; questions.add(pending); }
      if(e.type==='question.answered') { if(pending!==e.data.questionId) invalid(); pending=undefined; }
      if(e.type==='message.delta') { output+=new TextEncoder().encode(e.data.text).length; if(!session || output>65536) invalid(); }
      if(e.type==='run.completed' && (!session || pending || calls.size!==completed.size || !events.filter(x=>x.type==='message.delta').map(x=>x.data.text).join('').trim())) invalid();
      state=pilotEventState(e)??state;
    }
    if(!events.length || state!==base.status || events.at(-1)!.time!==base.updatedAt) invalid();
    const run=Object.freeze({ ...base, clientRequestId:pilotId(v.clientRequestId,'uuid'), constraint:pilotText(v.constraint,4096,false), engineVersion:pilotText(v.engineVersion,128), events:Object.freeze(events) });
    if(pilotBytes(run)>PILOT_LIMITS.runBytes) invalid(); return run;
  });
  if(new Set(runs.map(r=>r.runId)).size!==runs.length || new Set(runs.map(r=>r.clientRequestId)).size!==runs.length || runs.filter(r=>!pilotTerminal(r.status)).length>1) invalid();
  const parsed=Object.freeze({ version:1 as const, runs:Object.freeze(runs) }); if(pilotBytes(parsed)>PILOT_LIMITS.diskBytes) invalid(); return parsed;
}
