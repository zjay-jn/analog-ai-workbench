import test from 'node:test';
import assert from 'node:assert/strict';
import { waveArguments } from './fixtures/waveform-results';
import { PROJECT_READ_LIMITS as L, type ProjectReadToolName } from '../apps/desktop/src/shared/agent/agent-project-read';
import { parseProjectReadToolArguments } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import { liveTools, parseLiveQuestionArguments } from '../apps/desktop/src/main/engine-live/protocol';
import { PROJECT_READ_MODEL, ProjectReadProtocolError, projectReadTools, validateProjectReadNativeTools, parseProjectReadSse, projectReadCanonicalSse, type ProjectReadCompletion } from '../apps/desktop/src/main/agent-project-read/protocol';

const model = 'deepseek-flash', completionId = 'completion_synthetic_1', done = 'data: [DONE]\n\n';
const chunk = (delta: unknown, finish_reason: string | null = null, extra: object = {}): string => `data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
const finalWire = (text = 'Synthetic complete answer.', extra: object = {}): string => chunk({ role: 'assistant', content: text }) + chunk({}, 'stop', extra) + done;
const list = { directoryId: null, cursor: null, refresh: false };
const samples = {
  ...waveArguments,
  project_list: list,
  project_find: { ...list, query: '测量.txt' },
  project_search: { ...list, query: 'literal \\"text' },
  project_read: { fileId: 'file_main_1', version: null, start: { line: 1, column: 1 }, cursor: null },
  pilot_sum: { values: [-1000000, 0, 1000000] },
  wsl_results_list: { bindingId: 'wsl-binding-test', relativeDirectory: '', nameQuery: '', cursor: null },
  wsl_results_read: { bindingId: 'wsl-binding-test', fileId: 'wsl-file-test', version: '1:2:3:4:5', startLine: 1, maxLines: 200 },
};
const question = { questions: [{ question: '请说明需要读取哪一份资料？', header: '澄清', options: [] }] };
function callWire(name: string, args: unknown, id = 'call_synthetic_1'): string {
  const serialized = JSON.stringify(args), split = Math.floor(serialized.length / 2);
  return chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: serialized.slice(0, split) } }] })
    + chunk({ tool_calls: [{ index: 0, function: { arguments: serialized.slice(split) } }] }) + chunk({}, 'tool_calls') + done;
}
const rawCall = (index: number, name = 'project_list', args: unknown = list, id = `call_${index}`) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const rejects = (wire: string): void => assert.throws(() => parseProjectReadSse(wire), ProjectReadProtocolError);

test('project schemas contain the admitted read/skill/WSL tools, shared file limits and original sum/question contracts', () => {
  assert.deepEqual(PROJECT_READ_MODEL, { provider: 'deepseek', model: 'deepseek-v4-flash' });
  const tools = projectReadTools() as { type: string; function: { name: string; parameters: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } } }[];
  assert.deepEqual(tools.map(tool => tool.function.name), ['fs_list', 'fs_find', 'fs_search', 'fs_read', 'skill_discover', 'skill_load', 'skill_read_reference', 'project_list', 'project_find', 'project_search', 'project_read', 'pilot_sum', 'question', 'oa_open_design', 'oa_inspect_design', 'oa_query_instances', 'oa_query_nets', 'oa_describe_device', 'wsl_results_list', 'wsl_results_read', 'wsl_waveform_list', 'wsl_waveform_read', 'wsl_waveform_metrics']);
  assert.deepEqual(tools.filter(t => ['pilot_sum','question'].includes(t.function.name)), liveTools());
  for (const tool of tools) { assert.equal(tool.type, 'function'); assert.equal(tool.function.parameters.additionalProperties, false); }
  assert.deepEqual(tools.find(t => t.function.name === 'project_list')!.function.parameters.required, ['directoryId', 'cursor', 'refresh']);
  assert.deepEqual(tools.find(t => t.function.name === 'project_read')!.function.parameters.required, ['fileId', 'version', 'start', 'cursor']);
  assert.equal((tools.find(t => t.function.name === 'project_find')!.function.parameters.properties.query as { maxLength: number }).maxLength, L.queryBytes);
  assert.deepEqual(tools.find(t=>t.function.name==='fs_read')!.function.parameters.required,['path','fileId','version','start','cursor']);
  assert.deepEqual([...tools.find(t=>t.function.name==='fs_search')!.function.parameters.required].sort(),['path','directoryId','fileId','query','cursor','refresh'].sort());
  tools[0]!.function.name = 'shell'; assert.equal((projectReadTools()[0] as { function: { name: string } }).function.name, 'fs_list');
});

test('native tools require the exact name set and safe object schema shells; native descriptions/schemas never replace main schemas', () => {
  assert.doesNotThrow(() => validateProjectReadNativeTools(projectReadTools()));
  const alternate = projectReadTools() as { function: { parameters: unknown; description: string; strict?: boolean } }[];
  alternate[0]!.function.parameters = { type: 'object', properties: { harmlessNativeSchemaSentinel: { type: 'string' } } }; alternate[0]!.function.description = 'native-description-sentinel'; alternate[0]!.function.strict = false;
  assert.doesNotThrow(() => validateProjectReadNativeTools(alternate)); assert.equal(JSON.stringify(projectReadTools()).includes('Sentinel'), false); assert.equal(JSON.stringify(projectReadTools()).includes('native-description-sentinel'), false);
  const variants = [[], projectReadTools().slice(1), [...projectReadTools(), projectReadTools()[0]], [projectReadTools()[0], ...projectReadTools().slice(0, 5)]];
  for (const value of variants) assert.throws(() => validateProjectReadNativeTools(value), ProjectReadProtocolError);
  for (const change of [{ name: 'shell' }, { strict: true }, { strict: 'false' }, { parameters: [] }, { parameters: { type: 'string' } }, { description: '界'.repeat(L.requestBytes) }, { endpoint: 'https://example.invalid' }]) {
    const value = projectReadTools() as { function: Record<string, unknown> }[]; Object.assign(value[0]!.function, change); assert.throws(() => validateProjectReadNativeTools(value), ProjectReadProtocolError);
  }
});

test('native and canonical object admission rejects getters, hooks, sparse arrays and prototype objects without invoking them', () => {
  let touched = 0; const tools = projectReadTools() as { function: Record<string, unknown> }[];
  Object.defineProperty(tools[0]!.function, 'description', { enumerable: true, get() { touched++; return 'unsafe'; } });
  assert.throws(() => validateProjectReadNativeTools(tools), ProjectReadProtocolError);
  const hooked = projectReadTools(); Object.defineProperty(hooked, 'toJSON', { value() { touched++; return []; } }); assert.throws(() => validateProjectReadNativeTools(hooked), ProjectReadProtocolError);
  const sparse = projectReadTools(); delete sparse[0]; assert.throws(() => validateProjectReadNativeTools(sparse), ProjectReadProtocolError);
  const value = { ...parseProjectReadSse(finalWire()) }; Object.defineProperty(value, 'text', { enumerable: true, get() { touched++; return 'unsafe'; } });
  assert.throws(() => projectReadCanonicalSse(value), ProjectReadProtocolError); assert.equal(touched, 0);
  assert.throws(() => projectReadCanonicalSse(Object.assign(Object.create({ foreign: true }), parseProjectReadSse(finalWire())) as ProjectReadCompletion), ProjectReadProtocolError);
});

test('fragmented four-file and sum calls release only fully parsed shared arguments with exact call identity', () => {
  for (const name of Object.keys(samples) as (keyof typeof samples)[]) {
    const parsed = parseProjectReadSse(callWire(name, samples[name])); assert.equal(parsed.finish, 'tool_calls'); assert.equal(parsed.responseModel, model);
    assert.deepEqual(parsed.calls[0], { id: 'call_synthetic_1', name, arguments: parseProjectReadToolArguments(name, samples[name]) });
    assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.calls)); assert.ok(Object.isFrozen(parsed.calls[0]!.arguments));
    assert.deepEqual(parseProjectReadSse(projectReadCanonicalSse(parsed)), parsed);
  }
});

test('all file/sum arguments use strict shared shape parsing and preserve refresh execution errors', () => {
  const cases: [string, unknown][] = [
    ['project_list', { ...list, path: 'C:/outside' }], ['project_list', { cursor: null, refresh: false }], ['project_list', { ...list, directoryId: '../escape' }],
    ['project_list', { ...list, refresh: 'false' }],
    ['project_find', { ...list, query: '' }], ['project_find', { ...list, query: '界'.repeat(86) }], ['project_find', { ...list, query: '\ud800' }],
    ['project_search', { ...list, query: 'one\ntwo' }], ['project_search', { ...list, query: 'nul\u0000' }],
    ['project_read', { ...samples.project_read, version: 'latest' }],
    ['project_read', { ...samples.project_read, start: { line: 0, column: 1 } }], ['project_read', { ...samples.project_read, start: { line: 1, column: L.fileBytes + 2 } }],
    ['pilot_sum', { values: [] }], ['pilot_sum', { values: Array(33).fill(1) }], ['pilot_sum', { values: [1000001] }], ['pilot_sum', { values: [1.5] }],
  ];
  for (const [name, args] of cases) rejects(callWire(name, args));
  const semanticError = { directoryId: 'signed_directory', cursor: null, refresh: true };
  assert.deepEqual(parseProjectReadSse(callWire('project_list', semanticError)).calls[0]?.arguments, semanticError);
  const valid = { ...samples.project_read, version: 'a'.repeat(64), cursor: 'cursor_main_1' }; assert.deepEqual(parseProjectReadSse(callWire('project_read', valid)).calls[0]?.arguments, valid);
  const preparation = { ...samples.project_read, version: null, cursor: 'cursor_main_rules_or_scan' };
  assert.deepEqual(parseProjectReadSse(callWire('project_read', preparation)).calls[0]?.arguments, preparation);
});

test('question reuses native canonical defaults and rejects multiple questions, fixed choices, or mixed tool batches', () => {
  const parsed = parseProjectReadSse(callWire('question', question)); assert.deepEqual(parsed.calls[0]?.arguments, parseLiveQuestionArguments(question));
  assert.deepEqual(parseProjectReadSse(projectReadCanonicalSse(parsed)), parsed);
  for (const questions of [[], [question.questions[0], question.questions[0]], [{ ...question.questions[0], options: [{ label: 'A', description: 'choice' }] }], [{ ...question.questions[0], custom: false }], [{ ...question.questions[0], multiple: true }], [{ ...question.questions[0], path: 'arbitrary' }]]) rejects(callWire('question', { questions }));
  rejects(chunk({ tool_calls: [rawCall(0, 'question', question), rawCall(1)] }, 'tool_calls') + done);
  rejects(chunk({ tool_calls: [rawCall(0, 'question', question), rawCall(1, 'question', question)] }, 'tool_calls') + done);
});

test('missing DONE, incomplete frames, unfinished tool JSON and early finish never release a call', () => {
  const valid = callWire('project_list', list), prefix = valid.slice(0, valid.indexOf(done));
  for (const wire of [prefix, prefix + 'data: [DONE]', prefix + 'data: [DONE]\n', done, chunk({ content: 'partial' }) + done, valid + chunk({ content: 'late' }), valid + done, valid.replace('"tool_calls"}\n', '"length"}\n') + 'invalid tail']) rejects(wire);
  rejects(chunk({ tool_calls: [{ index: 0, id: 'call_partial', type: 'function', function: { name: 'project_list', arguments: '{"directoryId":' } }] }, 'tool_calls') + done);
  assert.equal(parseProjectReadSse(valid).calls.length, 1);
});

test('response IDs, chunk objects, choices and changing models cannot be mixed, while the actual bounded model is preserved', () => {
  rejects(chunk({ content: 'a' }) + chunk({}, 'stop', { id: 'foreign_completion' }) + done);
  rejects(chunk({ content: 'a' }) + chunk({}, 'stop', { model: 'foreign_response_model' }) + done);
  rejects(chunk({ content: 'a' }, 'stop', { object: 'chat.completion' }) + done);
  rejects(chunk({ content: 'a' }, 'stop', { choices: [{ index: 1, delta: { content: 'a' }, finish_reason: 'stop' }] }) + done);
  rejects(chunk({}, null, { choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] }) + done);
  rejects(chunk({ content: 'a' }, 'stop', { error: { message: 'synthetic' } }) + done);
  rejects(chunk({ content: 'a' }, 'stop', { foreignObject: { text: 'ignored?' } }) + done);
  const actual = 'upstream-reported-version-9'; const wire = chunk({ content: 'Actual model is evidence.' }, 'stop', { model: actual }) + done;
  assert.equal(parseProjectReadSse(wire).responseModel, actual); assert.equal(PROJECT_READ_MODEL.model, 'deepseek-v4-flash');
  assert.equal(parseProjectReadSse(chunk({ content: 'Unknown model.' }, 'stop', { model: null }) + done).responseModel, null);
});

test('reasoning, alternate roles, legacy function calls and unsupported finish reasons reject the complete response', () => {
  for (const delta of [{ reasoning_content: 'unapproved thinking' }, { reasoning_content: 1 }, { reasoning: 'hidden' }, { role: 'system' }, { role: 'tool' }, { function_call: { name: 'project_list' } }, { content: ['multimodal'] }, { content: '\ud800' }]) rejects(chunk(delta) + finalWire());
  for (const finish of ['length', 'content_filter', 'function_call', 'error']) rejects(chunk({ content: 'partial' }, finish) + done);
  assert.equal(parseProjectReadSse(chunk({ reasoning_content: null }) + finalWire()).text, 'Synthetic complete answer.');
  assert.equal(parseProjectReadSse(chunk({ reasoning_content: '' }) + finalWire()).text, 'Synthetic complete answer.');
  rejects(chunk({ content: ' ' }, 'stop') + done); rejects(chunk({}, 'tool_calls') + done);
});

test('call fragments enforce known names, stable identity, dense indices, explicit function type and unique IDs', () => {
  for (const name of ['read', 'glob', 'grep', 'shell', 'fetch', 'constructor', 'project_unknown']) rejects(callWire(name, {}));
  for (const part of [
    { index: 0, id: 'x', type: 'function', function: { arguments: '{}' } }, { index: 0, type: 'function', function: { name: 'project_list', arguments: JSON.stringify(list) } },
    { index: 0, id: 'x', function: { name: 'project_list', arguments: JSON.stringify(list) } }, { ...rawCall(0), type: 'shell' }, rawCall(1),
    { ...rawCall(0), function: { name: 'project_list', arguments: list } }, { ...rawCall(0), extra: 'foreign' },
  ]) rejects(chunk({ tool_calls: [part] }, 'tool_calls') + done);
  rejects(chunk({ tool_calls: [rawCall(0)] }) + chunk({ tool_calls: [{ index: 0, id: 'changed' }] }, 'tool_calls') + done);
  rejects(chunk({ tool_calls: [rawCall(0)] }) + chunk({ tool_calls: [{ index: 0, function: { name: 'project_find' } }] }, 'tool_calls') + done);
  rejects(chunk({ tool_calls: [rawCall(0), rawCall(1, 'project_list', list, 'call_0')] }, 'tool_calls') + done);
  rejects(chunk({ tool_calls: [rawCall(0)] }, 'stop') + done);
});

test('the 64-call shared ceiling applies across streamed frames and accepts the exact boundary', () => {
  let prefix = ''; for (let n = 0; n < L.toolCalls; n++) prefix += chunk({ tool_calls: [rawCall(n)] });
  const parsed = parseProjectReadSse(prefix + chunk({}, 'tool_calls') + done); assert.equal(parsed.calls.length, L.toolCalls); assert.equal(parsed.calls.at(-1)?.id, 'call_63');
  assert.equal(parseProjectReadSse(projectReadCanonicalSse(parsed)).calls.length, L.toolCalls);
  rejects(prefix + chunk({ tool_calls: [rawCall(L.toolCalls)] }, 'tool_calls') + done);
  rejects(chunk({ tool_calls: Array.from({ length: L.toolCalls + 1 }, (_, n) => rawCall(n)) }, 'tool_calls') + done);
});

test('final and separate usage layouts preserve actual counters, zero counters and unknown null without guessing', () => {
  const usage = { prompt_tokens: 21, completion_tokens: 3, total_tokens: 24, prompt_cache_hit_tokens: 4, completion_tokens_details: { reasoning_tokens: 0 } };
  const final = parseProjectReadSse(finalWire('done', { usage })); assert.deepEqual(final.usage, { inputTokens: 21, outputTokens: 3 });
  const separated = finalWire().slice(0, -done.length) + `data: ${JSON.stringify({ id: completionId, model, choices: [], usage })}\n\n` + done;
  assert.deepEqual(parseProjectReadSse(separated).usage, final.usage); assert.deepEqual(parseProjectReadSse(projectReadCanonicalSse(final)), final);
  for (const input of [undefined, null]) { const parsed = parseProjectReadSse(finalWire('unknown', { usage: input })); assert.equal(parsed.usage, null); assert.equal(parseProjectReadSse(projectReadCanonicalSse(parsed)).usage, null); }
  assert.deepEqual(parseProjectReadSse(finalWire('zero', { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })).usage, { inputTokens: 0, outputTokens: 0 });
});

test('invalid, contradictory and oversized usage or output-token configurations fail instead of normalizing them', () => {
  for (const usage of [{}, { prompt_tokens: 1 }, { prompt_tokens: null, completion_tokens: null }, { prompt_tokens: -1, completion_tokens: 0 }, { prompt_tokens: 1.5, completion_tokens: 0 }, { prompt_tokens: 1, completion_tokens: L.maxOutputTokens + 1 }, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 9 }]) rejects(finalWire('result', { usage }));
  assert.throws(() => parseProjectReadSse(finalWire('result', { usage: { prompt_tokens: 1, completion_tokens: 3 } }), 2), ProjectReadProtocolError);
  for (const max of [0, -1, -0, 1.5, NaN, Infinity, L.maxOutputTokens + 1]) assert.throws(() => parseProjectReadSse(finalWire(), max), ProjectReadProtocolError);
  const beforeDone = finalWire('result', { usage: { prompt_tokens: 2, completion_tokens: 3 } }).slice(0, -done.length);
  rejects(beforeDone + `data: ${JSON.stringify({ id: completionId, model, choices: [], usage: { prompt_tokens: 2, completion_tokens: 4 } })}\n\n` + done);
  rejects(`data: ${JSON.stringify({ id: completionId, model, choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\n` + finalWire());
});

test('wire and assistant text are bounded by complete UTF-8 bytes at their exact shared limits', () => {
  const base = finalWire(), padding = L.wireBytes - Buffer.byteLength(base) - 4;
  const exact = ': ' + 'x'.repeat(padding) + '\n\n' + base; assert.equal(Buffer.byteLength(exact), L.wireBytes); assert.equal(parseProjectReadSse(exact).text, 'Synthetic complete answer.'); rejects('x' + exact);
  const content = '界'.repeat(Math.floor(L.outputBytes / 3)) + 'x'.repeat(L.outputBytes % 3); assert.equal(Buffer.byteLength(content), L.outputBytes); assert.equal(parseProjectReadSse(finalWire(content)).text, content); rejects(finalWire(content + 'x'));
  rejects(chunk({ content: 'x'.repeat(L.outputBytes) }) + chunk({ content: 'x' }, 'stop') + done);
});

test('tool argument fragment bytes are bounded before complete JSON is parsed', () => {
  const serialized = JSON.stringify(list), exact = ' '.repeat(L.requestBytes - Buffer.byteLength(serialized)) + serialized;
  const wire = (raw: string) => chunk({ tool_calls: [{ index: 0, id: 'call_bounded', type: 'function', function: { name: 'project_list', arguments: raw.slice(0, 8192) } }] }) + chunk({ tool_calls: [{ index: 0, function: { arguments: raw.slice(8192) } }] }, 'tool_calls') + done;
  assert.deepEqual(parseProjectReadSse(wire(exact)).calls[0]?.arguments, list); rejects(wire(' ' + exact));
});

test('canonical SSE rebuild drops upstream metadata and validates forged completion arguments before serialization', () => {
  const parsed = parseProjectReadSse(finalWire('quoted \\"text 😀', { system_fingerprint: 'upstream-sentinel' })), canonical = projectReadCanonicalSse(parsed);
  assert.equal(canonical.includes('upstream-sentinel'), false); assert.equal(canonical.includes('"created":0'), true); assert.deepEqual(parseProjectReadSse(canonical), parsed);
  const tool = parseProjectReadSse(callWire('project_list', list));
  for (const value of [
    { ...tool, calls: [{ id: 'x', name: 'shell', arguments: {} }] }, { ...tool, calls: [{ id: 'x', name: 'project_list', arguments: { ...list, path: 'outside' } }] },
    { ...tool, finish: 'stop' }, { ...parsed, finish: 'tool_calls' }, { ...parsed, foreign: 'unvalidated' }, { ...parsed, usage: { inputTokens: 1, outputTokens: L.maxOutputTokens + 1 } },
  ]) assert.throws(() => projectReadCanonicalSse(value as ProjectReadCompletion), ProjectReadProtocolError);
});

test('SSE accepts CRLF, keepalive comments and multiline JSON data but rejects alternate control fields and data after DONE', () => {
  assert.equal(parseProjectReadSse(': keepalive\n\n' + finalWire().replace(/\n/gu, '\r\n')).text, 'Synthetic complete answer.');
  const pretty = JSON.stringify({ id: completionId, model, choices: [{ index: 0, delta: { content: 'multiline JSON' }, finish_reason: 'stop' }] }, null, 2).split('\n').map(line => `data: ${line}`).join('\n');
  assert.equal(parseProjectReadSse(pretty + '\n\n' + done).text, 'multiline JSON');
  for (const field of ['event: completion', 'id: untrusted', 'retry: 3', 'foreign: value']) rejects(field + '\n\n' + finalWire());
  rejects(finalWire() + ': trailing frame\n\n'); rejects('data: invalid-json\n\n' + finalWire());
});

test('usage total overflow cannot produce a canonical response with an unsafe integer', () => {
  rejects(finalWire('overflow', { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 } }));
  const valid = parseProjectReadSse(finalWire('boundary', { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER - 1, completion_tokens: 1 } }));
  assert.deepEqual(parseProjectReadSse(projectReadCanonicalSse(valid)), valid);
  assert.throws(() => projectReadCanonicalSse({ ...valid, usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } }), ProjectReadProtocolError);
});
