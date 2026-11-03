import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createProjectReadNativeEngine, PilotNativeCleanupError } from '../apps/desktop/src/main/agent-project-read/opencode-engine';
import type { ProjectReadEngineInput, ProjectReadEngineNotice } from '../apps/desktop/src/main/agent-project-read/engine';
import type { ProjectReadBegin, ProjectReadProviderServices } from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import type { ProjectReadToolCall, ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';
import { liveQuestionResult } from '../apps/desktop/src/main/engine-live/protocol';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const model = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const sum: ProjectReadToolResult = { ok: true, value: { kind: 'sum', sum: 3, count: 2, source: 'deterministic-local', toolVersion: 'pilot.sum.v1' } };
type Services = Parameters<typeof createProjectReadNativeEngine>[0]['services'];

/** The real projection adapter reads only these synthetic in-memory native snapshots. */
function fixture(options: { mode?: 'question' | 'tool' | 'final' | 'retry'; createGate?: Promise<string>; answerGate?: Promise<void>; deliveredGate?: Promise<void>; cleanupGate?: Promise<void>; cleanupFails?: boolean; toolGate?: Promise<ProjectReadToolResult> } = {}) {
  const session = 'session_project_read', runId = 'project_read.synthetic', initial = '请读取合成项目并确认单位。';
  const mode = options.mode ?? 'question', controller = new AbortController();
  const questionArgs = { questions: [{ question: '结果使用什么单位？', header: '单位', options: [], multiple: false, custom: true }] };
  const events: ProjectReadEngineNotice[] = [], registered: unknown[] = [], nativeAnswers: unknown[] = [], toolCalls: ProjectReadToolCall[] = [], rejected: string[] = [];
  const stats = { create: 0, prompt: 0, abort: 0, dispose: 0, close: 0, delivered: 0, finalized: 0 };
  const questionSeen = deferred<void>(), deliveredEntered = deferred<void>(), cleanupEntered = deferred<void>(), toolEntered = deferred<void>();
  const pollWaiters: Array<ReturnType<typeof deferred<void>>> = [];
  let begin: ProjectReadBegin | undefined, pending = mode === 'question', answer: string | undefined, final = mode === 'final';
  let tamperQuestion = false, tamperOutput = false, toolCompleted = false, terminalError=false, controlFailure=false, foreignError=false, delivery: Promise<void> | undefined;
  const failedFinalizations:number[]=[];
  const part = (id: string, messageID: string, extra: object) => ({ id, sessionID: session, messageID, ...extra });
  const assistant = (id: string, created: number) => ({ id, sessionID: session, role: 'assistant', parentID: 'user_native', agent: 'pilot', providerID: 'workbench', modelID: model.model, time: { created } });
  const question = () => ({ id: 'question_native', sessionID: session, questions: questionArgs.questions, tool: { messageID: tamperQuestion ? 'foreign_message' : 'assistant_native', callID: 'call_native' } });
  const rows = () => [
    { info: { id: 'user_native', sessionID: session, role: 'user', time: { created: 1 } }, parts: [part('part_user', 'user_native', { type: 'text', text: initial })] },
    ...(mode==='retry'?[{info:{...assistant('assistant_retry',2),...(terminalError?{error:{name:'APIError',data:{message:'synthetic terminal',statusCode:foreignError?400:504,responseBody:JSON.stringify({error:{message:'Upstream request timed out'}})}}}:{})},parts:[]}]:[]),
    ...(mode === 'final'||mode==='retry' ? [] : [{ info: assistant('assistant_native', 2), parts: [
      part('part_step', 'assistant_native', { type: 'step-start' }),
      part('part_tool', 'assistant_native', { type: 'tool', tool: mode === 'question' ? 'question' : 'pilot_sum', callID: 'call_native', state: mode === 'question'
        ? answer === undefined ? { status: 'running', input: questionArgs } : { status: 'completed', input: questionArgs, output: liveQuestionResult(questionArgs.questions[0]!.question, answer), metadata: { answers: [[answer]] } }
        : toolCompleted ? { status: 'completed', input: { values: [1, 2] }, output: JSON.stringify(tamperOutput ? { ...sum, value: { kind: 'sum', sum: 99, count: 2, source: 'deterministic-local', toolVersion: 'pilot.sum.v1' } } : sum) } : { status: 'running', input: { values: [1, 2] } }, }),
    ] }]),
    ...(final ? [{ info: { ...assistant('assistant_final', 3), finish: 'stop', time: { created: 3, completed: 4 } }, parts: [part('part_final', 'assistant_final', { type: 'text', text: '合成任务完成。', time: { start: 3, end: 4 } })] }] : []),
  ];
  const client = {
    health: async () => true,
    async createSession() { stats.create++; return options.createGate ? await options.createGate : session; },
    async prompt() { stats.prompt++; },
    async messages() { for (const waiter of pollWaiters.splice(0)) waiter.resolve();if(controlFailure)throw Error('synthetic control transport fault'); return structuredClone(rows()); },
    questions: async () => pending ? [question()] : [],
    async answer(sessionID: string, questionID: string, text: string) { nativeAnswers.push({ sessionID, questionID, text }); await options.answerGate; answer = text; pending = false; final = true; },
    async abort() { stats.abort++; cleanupEntered.resolve(); await options.cleanupGate; if (options.cleanupFails) throw Error('synthetic private cleanup detail'); },
    async reject(_sessionID: string, questionID: string) { rejected.push(questionID); pending = false; },
    dispose() { stats.dispose++; },
  };
  const oracle = {
    bindSession(id: string) { assert.equal(id, session); },
    question(binding: unknown) { registered.push(structuredClone(binding)); },
    answer(text: string, questionID?: string) { assert.equal(questionID, 'question_native'); assert.equal(typeof text, 'string'); },
    answerDelivery(questionID: string, promise: Promise<void>) { assert.equal(questionID, 'question_native'); delivery = promise; void promise.catch(() => {}); },
    evidence: () => ({ complete: final,...(mode==='retry'?{recoverableReason:'IDLE_TIMEOUT'}:{}) }),
  };
  const services: Services = {
    begin(input) { begin = input; return oracle as unknown as ReturnType<ProjectReadProviderServices['begin']>; },
    end() {}, async close() { stats.close++; }, finalizeFailure(){stats.finalized++;},
  };
  const engine = createProjectReadNativeEngine({ client, services });
  const input: ProjectReadEngineInput = {
    runId, model, signal: controller.signal, prompt: { goal: initial, constraint: '', rules: '仅合成资料', systemText: '合成系统说明', initialUserText: initial },
    callbacks: {
      notice(event) { if(event.type==='failed')failedFinalizations.push(stats.finalized);events.push(event); if (event.type === 'question') questionSeen.resolve(); },
      async tool(call) { toolCalls.push(call); toolEntered.resolve(); return options.toolGate ? await options.toolGate : sum; },
      async questionDelivered(questionID) { assert.equal(questionID, 'question_native'); stats.delivered++; deliveredEntered.resolve(); await options.deliveredGate; },
    },
  };
  const call: ProjectReadToolCall = { sessionId: session, messageId: 'assistant_native', callId: 'call_native', toolName: 'pilot_sum', arguments: { values: [1, 2] } };
  return {
    engine, runId, input, controller, events, registered, nativeAnswers, rejected, stats, toolCalls, call,
    questionSeen: questionSeen.promise, deliveredEntered: deliveredEntered.promise, cleanupEntered: cleanupEntered.promise, toolEntered: toolEntered.promise,
    start() { const result = engine.start(input); void result.catch(() => {}); return result; },
    onTool(value = call) { assert.ok(begin); return begin.onTool(value); },
    nextPoll() { const value = deferred<void>(); pollWaiters.push(value); return value.promise; },
    delivery() { assert.ok(delivery); return delivery; },
    tamperQuestion() { tamperQuestion = true; },
    finishTool(tamper = false) { toolCompleted = true; final = true; tamperOutput = tamper; },
    finishRetry(error=false,foreign=false){terminalError=error;foreignError=foreign;final=!error;},
    failControl(){controlFailure=true;},failedFinalizations,
  };
}

for(const outcome of ['success','exhausted','cancelled','control_failure','foreign_error'] as const)test('native adapter retry snapshot remains live until '+outcome,{timeout:4000},async()=>{
 const f=fixture({mode:'retry'}),started=f.start();await f.nextPoll();
 assert.equal(f.stats.finalized,0);assert.equal(f.events.some(e=>e.type==='failed'||e.type==='completed'),false);assert.equal(f.stats.prompt,1);
 if(outcome==='cancelled'){f.controller.abort();await f.engine.stop(f.runId);}else if(outcome==='control_failure')f.failControl();else f.finishRetry(outcome==='exhausted'||outcome==='foreign_error',outcome==='foreign_error');
 await started;const failed=['exhausted','control_failure','foreign_error'].includes(outcome);assert.equal(f.stats.finalized,outcome==='exhausted'?1:0);assert.equal(f.events.filter(e=>e.type==='failed').length,failed?1:0);assert.deepEqual(f.failedFinalizations,failed?[outcome==='exhausted'?1:0]:[]);assert.equal(f.events.filter(e=>e.type==='completed').length,outcome==='success'?1:0);
 assert.equal(f.stats.abort,1);assert.equal(f.stats.prompt,1);assert.equal(f.toolCalls.length,0);await f.engine.shutdown();
});

test('project native completion waits for both answer acknowledgement and confirmed question persistence', { timeout: 4000 }, async () => {
  const acknowledgement = deferred<void>(), persistence = deferred<void>();
  const f = fixture({ answerGate: acknowledgement.promise, deliveredGate: persistence.promise }), started = f.start();
  try {
    await f.questionSeen;
    await assert.rejects(f.engine.answer('foreign_run', 'question_native', '不可发送'));
    await assert.rejects(f.engine.answer(f.runId, 'foreign_question', '不可发送'));
    assert.equal(f.nativeAnswers.length, 0);
    const answering = f.engine.answer(f.runId, 'question_native', '毫安\n保留小数');
    await assert.rejects(f.engine.answer(f.runId, 'question_native', '重复不可发送'));
    assert.equal(f.stats.delivered, 0); assert.equal(f.events.some(e => e.type === 'completed'), false);
    let released = false; void f.delivery().then(() => { released = true; });
    acknowledgement.resolve(); await f.deliveredEntered; await f.nextPoll(); await setImmediate();
    assert.equal(released, false); assert.equal(f.events.some(e => e.type === 'completed'), false);
    persistence.resolve(); await answering; await started;
    assert.equal(released, true); assert.equal(f.stats.delivered, 1); assert.equal(f.registered.length, 1);
    assert.deepEqual(f.nativeAnswers, [{ sessionID: 'session_project_read', questionID: 'question_native', text: '毫安\n保留小数' }]);
    assert.equal(f.events.at(-1)?.type, 'completed'); assert.equal(f.events.some(e => e.type === 'failed'), false);
    assert.equal(f.events.filter(e => e.type === 'text').map(e => e.text).join(''), '合成任务完成。');
    assert.equal(f.stats.abort, 1); assert.deepEqual(f.rejected, []);
    await assert.rejects(f.engine.answer(f.runId, 'question_native', '迟到不可发送'));
  } finally { acknowledgement.resolve(); persistence.resolve(); f.controller.abort(); await f.engine.shutdown(); }
});

test('project native stop waits for a late create and aborts its session without submitting a prompt', { timeout: 4000 }, async () => {
  const creation = deferred<string>(), f = fixture({ createGate: creation.promise, mode: 'tool' }), started = f.start();
  await setImmediate(); assert.equal(f.stats.create, 1);
  const stopping = f.engine.stop(f.runId); assert.equal(stopping, f.engine.stop(f.runId));
  let settled = false; void stopping.then(() => { settled = true; }); await setImmediate();
  assert.equal(settled, false); creation.resolve('session_project_read'); await stopping; await started;
  assert.equal(f.stats.prompt, 0); assert.equal(f.stats.abort, 1); assert.deepEqual(f.events, []);
  await assert.rejects(f.engine.start(f.input)); await f.engine.shutdown();
});

test('project native cancelled answer cannot confirm delivery or successful completion', { timeout: 4000 }, async () => {
  const acknowledgement = deferred<void>(), f = fixture({ answerGate: acknowledgement.promise }), started = f.start();
  await f.questionSeen;
  const answering = f.engine.answer(f.runId, 'question_native', '毫安'); void answering.catch(() => {});
  f.controller.abort(); const stopping = f.engine.stop(f.runId); void stopping.catch(() => {});
  acknowledgement.resolve(); await assert.rejects(answering); await assert.rejects(stopping, PilotNativeCleanupError); await assert.rejects(started, PilotNativeCleanupError);
  assert.equal(f.stats.delivered, 0); assert.equal(f.events.some(e => e.type === 'completed'), false);
  assert.equal(await f.engine.health(), false); assert.deepEqual(f.rejected, []); await assert.rejects(f.engine.shutdown(), PilotNativeCleanupError);
});

test('project native cleanup never rejects a changed question tuple and blocks reuse after uncertainty', { timeout: 4000 }, async () => {
  const f = fixture(), started = f.start(); await f.questionSeen; f.tamperQuestion();
  const stopping = f.engine.stop(f.runId); await assert.rejects(stopping, PilotNativeCleanupError); await assert.rejects(started, PilotNativeCleanupError);
  assert.deepEqual(f.rejected, []); assert.equal(f.stats.abort, 1); assert.equal(await f.engine.health(), false);
  await assert.rejects(f.engine.answer(f.runId, 'question_native', '不可发送')); assert.deepEqual(f.nativeAnswers, []);
  await assert.rejects(f.engine.start({ ...f.input, runId: 'new_run' })); await assert.rejects(f.engine.shutdown(), PilotNativeCleanupError);
});

test('project native tool dispatch binds the complete native tuple and compares completed output to the saved main result', { timeout: 4000 }, async () => {
  const f = fixture({ mode: 'tool' }), started = f.start(); await setImmediate();
  for (const call of [{ ...f.call, sessionId: 'other_session' }, { ...f.call, messageId: 'other_message' }, { ...f.call, callId: 'other_call' }, { ...f.call, arguments: { values: [1, 3] } }]) await assert.rejects(f.onTool(call));
  assert.deepEqual(f.toolCalls, []);
  assert.deepEqual(await f.onTool(), sum); assert.deepEqual(await f.onTool(), sum); assert.equal(f.toolCalls.length, 1);
  f.finishTool(true); await started;
  assert.equal(f.events.some(e => e.type === 'failed'), true); assert.equal(f.events.some(e => e.type === 'completed'), false);
  await f.engine.shutdown();
});

test('project native cancelled broker result is not released even when its deferred callback completes', { timeout: 4000 }, async () => {
  const result = deferred<ProjectReadToolResult>(), f = fixture({ mode: 'tool', toolGate: result.promise }), started = f.start(); await setImmediate();
  const runningTool = f.onTool(); void runningTool.catch(() => {}); await f.toolEntered;
  f.controller.abort(); await f.engine.stop(f.runId); result.resolve(sum); await assert.rejects(runningTool); await started;
  assert.equal(f.events.some(e => e.type === 'completed'), false); await f.engine.shutdown();
});

test('project native final completion is withheld until cleanup succeeds', { timeout: 4000 }, async t => {
  for (const fail of [false, true]) await t.test(fail ? 'abort failure' : 'successful cleanup', async () => {
    const cleanup = deferred<void>(), f = fixture({ mode: 'final', cleanupGate: cleanup.promise, cleanupFails: fail }), started = f.start(); await f.cleanupEntered;
    assert.equal(f.events.some(e => e.type === 'completed'), false);
    assert.equal(f.events.filter(e => e.type === 'text').map(e => e.text).join(''), '合成任务完成。');
    cleanup.resolve();
    if (fail) { await assert.rejects(started, PilotNativeCleanupError); assert.equal(f.events.some(e => e.type === 'completed'), false); await assert.rejects(f.engine.shutdown(), PilotNativeCleanupError); }
    else { await started; assert.equal(f.events.at(-1)?.type, 'completed'); await f.engine.shutdown(); }
    assert.equal(f.stats.abort, 1); assert.equal(f.stats.dispose, 1); assert.equal(f.stats.close, 1);
  });
});

test('project native finalization closes services after client disposal throws and shares one sanitized failure', async () => {
  const closeGate = deferred<void>(), entered = deferred<void>(); let disposed = 0, closed = 0, operations = 0;
  const forbidden = async (): Promise<never> => { operations++; throw Error('No native transport in finalization test'); };
  const client = { health: forbidden, createSession: forbidden, prompt: forbidden, messages: forbidden, questions: forbidden, answer: forbidden, abort: forbidden, dispose() { disposed++; throw Error('synthetic secret detail'); } };
  const services: Services = { begin() { throw Error('No active run'); }, end() {}, async close() { closed++; entered.resolve(); await closeGate.promise; } };
  const engine = createProjectReadNativeEngine({ client, services }), first = engine.shutdown(); void first.catch(() => {});
  await entered.promise; assert.equal(disposed, 1); assert.equal(closed, 1); assert.equal(engine.shutdown(), first);
  closeGate.resolve(); await assert.rejects(first, error => error instanceof PilotNativeCleanupError && error.message === 'OpenCode pilot unavailable');
  assert.equal(await engine.health(), false); assert.equal(operations, 0); engine.dispose(); assert.equal(engine.shutdown(), first);
});
