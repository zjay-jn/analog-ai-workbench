import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WSL_RESULTS_VERSION, WSL_RESULTS_LIMITS, parseWslResultsSelection, parseWslResultsBinding, parseWslResultsToolArguments, parseWslResultsToolValue, type WslResultsBinding } from '../apps/desktop/src/shared/agent/wsl-results';
import { createWslResultsService, WslResultsError } from '../apps/desktop/src/main/wsl-results/service';
import { wslResultsInvocation, type WslReaderRequest, type WslResultsTransport } from '../apps/desktop/src/main/wsl-results/transport';
import { WSL_RESULTS_READER } from '../apps/desktop/src/main/wsl-results/reader';
const selection = { distro: 'ROCKY9_LLM_LAB', user: 'maxwell', rootPath: '/home/maxwell/virtuoso_workspace_180nm/_codex_runs/synthetic-result' } as const;
const binding: WslResultsBinding = { ...selection, id: 'wsl-test-binding', rootIdentity: '2096:101', readerVersion: WSL_RESULTS_VERSION, selectedAt: '2026-09-15T01:02:03.000Z' };
const signal = (): AbortSignal => new AbortController().signal;
const fileVersion = '2096:102:8:123:456';
const digest = (s: string): string => createHash('sha256').update(s).digest('hex');
const ok = (value: object) => ({ ok: true, readerVersion: WSL_RESULTS_VERSION, value });
const readPage = (text = 'gain\n', rawSha256 = digest('gain\n42\n')) => ({ operation: 'read', rootIdentity: binding.rootIdentity, fileIdentity: '2096:102', version: fileVersion, rawSha256, excerptSha256: digest(text), startLine: 1, endLine: 1, totalLines: 2, fileBytes: 8, text, nextLine: 2, physicalReadBytes: 8, scannedCandidates: 1 });
const row = (name = 'gain.txt') => ({ name, relativePath: name, kind: 'file', readability: 'text_result', bytes: 8, version: fileVersion });
const listing = (entries: unknown[] = [row()], hasMore = false) => ({ operation: 'list', rootIdentity: binding.rootIdentity, directoryVersion: '2096:101:4096:11:12', entries, hasMore, physicalReadBytes: 0, scannedCandidates: entries.length });
const listArgs = { bindingId: binding.id, relativeDirectory: '', nameQuery: '', cursor: null } as const;
function mock(handler: (r: WslReaderRequest, s: AbortSignal) => unknown | Promise<unknown>) { const calls: WslReaderRequest[] = []; const transport: WslResultsTransport = { async execute(r, s) { calls.push(r); return handler(r, s); } }; return { service: createWslResultsService({ transport }), calls }; }
test('WSL admission is explicit experimental distro/user and selected result root only', () => {
  assert.deepEqual(parseWslResultsSelection(selection), selection);
  for (const candidate of [{ ...selection, distro: 'ROCKY9_WSL2' }, { ...selection, user: 'root' }, { ...selection, rootPath: '/home/maxwell' }, { ...selection, rootPath: '/home/maxwell/simulation' }, { ...selection, rootPath: selection.rootPath + '/../other' }, { ...selection, rootPath: selection.rootPath + '/.ssh' }, { ...selection, rootPath: selection.rootPath + '/models' }, { ...selection, rootPath: selection.rootPath + '/nested\\other' }, { ...selection, shell: 'bash' }]) assert.equal(parseWslResultsSelection(candidate), null);
  assert.ok(parseWslResultsBinding(binding)); assert.equal(parseWslResultsBinding({ ...binding, readerVersion: 'v0' }), null);
});
test('model arguments cannot supply a distro, root, absolute file, shell or extra key', () => {
  assert.ok(parseWslResultsToolArguments('wsl_results_list', listArgs));
  for (const candidate of [{ ...listArgs, distro: 'ROCKY9_WSL2' }, { ...listArgs, relativeDirectory: '../other' }, { ...listArgs, relativeDirectory: '/home/maxwell' }, { ...listArgs, shell: 'cat' }]) assert.equal(parseWslResultsToolArguments('wsl_results_list', candidate), null);
  assert.equal(parseWslResultsToolArguments('wsl_results_read', { bindingId: binding.id, fileId: '/home/maxwell/a.txt', version: fileVersion, startLine: 1, maxLines: 200 }), null);
});
test('fixed invocation carries immutable source on stdin and model paths only as base64 JSON argv', () => {
  const request: WslReaderRequest = { ...selection, readerVersion: WSL_RESULTS_VERSION, rootIdentity: null, operation: 'select', arguments: {} };
  const result = wslResultsInvocation(request);
  assert.equal(result.executable, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(result.args.slice(0, -1), ['-d', 'ROCKY9_LLM_LAB', '-u', 'maxwell', '--exec', '/usr/bin/python3', '-I', '-']);
  assert.deepEqual(JSON.parse(Buffer.from(result.args.at(-1)!, 'base64').toString()), request);
  assert.equal(result.stdin, WSL_RESULTS_READER); assert.match(result.stdin, /signal\.alarm\(8\)/u); assert.match(result.stdin, /os\.O_NOFOLLOW/u); assert.match(result.stdin, /os\.O_NONBLOCK/u);
  assert.throws(() => wslResultsInvocation({ ...request, distro: 'ROCKY9_WSL2' } as unknown as WslReaderRequest), WslResultsError);
});
test('list to read pins real source, version and hash, and disallows unlisted/cross-binding IDs', async () => {
  const { service, calls } = mock(r => r.operation === 'list' ? ok(listing()) : ok(readPage()));
  const page = await service.list(binding, listArgs, signal());
  const file = page.entries[0]!; assert.ok(file.fileId); assert.equal(file.version, fileVersion);
  assert.deepEqual(Object.keys(calls[0]!).sort(), ['arguments', 'distro', 'operation', 'readerVersion', 'rootIdentity', 'rootPath', 'user']);
  const args = { bindingId: binding.id, fileId: file.fileId!, version: fileVersion, startLine: 1, maxLines: 1 };
  const first = await service.read(binding, args, signal());
  assert.equal(first.source.absolutePath, selection.rootPath + '/gain.txt'); assert.equal(first.rawSha256, digest('gain\n42\n')); assert.equal(first.text, 'gain\n');
  assert.equal(first.complete, false); assert.equal(first.nextLine, 2); assert.ok(parseWslResultsToolValue(first));
  await service.read(binding, args, signal()); assert.equal(calls[2]!.arguments.rawSha256, first.rawSha256);
  await assert.rejects(service.read(binding, { ...args, fileId: 'wsl-unlisted' }, signal()), { code: 'FILE_UNAVAILABLE' });
  await assert.rejects(service.read({ ...binding, id: 'wsl-other' }, { ...args, bindingId: 'wsl-other' }, signal()), { code: 'CAPABILITY_DENIED' });
  await assert.rejects(service.read(binding, { ...args, version: '2096:102:8:999:456' }, signal()), { code: 'SOURCE_CHANGED' });
  assert.equal(calls.length, 3);
});
test('binary PSF metadata has no file capability; text .out remains readable', async () => {
  const { service } = mock(() => ok(listing([{ name: 'ac.ac', relativePath: 'ac.ac', kind: 'file', readability: 'binary_result', bytes: 128, version: null }, row('spectre.out')])));
  const page = await service.list(binding, listArgs, signal()); assert.equal(page.entries[0]!.fileId, null); assert.equal(page.entries[1]!.readability, 'text_result'); assert.ok(page.entries[1]!.fileId);
});
test('source changes, root changes and a forged excerpt hash fail before publication', async () => {
  for (const raw of [{ ...readPage(), rawSha256: 'x' }, { ...readPage(), excerptSha256: '0'.repeat(64) }, { ...readPage(), rootIdentity: '2096:999' }, { ...readPage(), physicalReadBytes: 0 }]) {
    const { service } = mock(r => r.operation === 'list' ? ok(listing()) : ok(raw));
    const page = await service.list(binding, listArgs, signal());
    await assert.rejects(service.read(binding, { bindingId: binding.id, fileId: page.entries[0]!.fileId!, version: fileVersion, startLine: 1, maxLines: 1 }, signal()), WslResultsError);
  }
});
test('cursor is single-use and bound to directory/query/root identity', async () => {
  const { service, calls } = mock(r => ok(listing([row(r.arguments.afterName === null ? 'a.txt' : 'b.txt')], r.arguments.afterName === null)));
  const first = await service.list(binding, listArgs, signal()); assert.ok(first.nextCursor);
  await assert.rejects(service.list(binding, { ...listArgs, cursor: first.nextCursor, nameQuery: 'x' }, signal()), { code: 'CURSOR_STALE' });
  const second = await service.list(binding, { ...listArgs, cursor: first.nextCursor }, signal()); assert.equal(second.complete, true); assert.equal(calls[1]!.arguments.afterName, 'a.txt');
  await assert.rejects(service.list(binding, { ...listArgs, cursor: first.nextCursor }, signal()), { code: 'CURSOR_STALE' });
});
test('cancelled late transport responses never produce file capabilities', async () => {
  const controller = new AbortController(); let release: ((v: unknown) => void) | undefined;
  const { service } = mock(() => new Promise(resolve => { release = resolve; }));
  const pending = service.list(binding, listArgs, controller.signal); controller.abort(); release!(ok(listing()));
  await assert.rejects(pending, { code: 'CANCELLED' }); await service.close();
  await assert.rejects(service.list(binding, listArgs, signal()), { code: 'CANCELLED' });
});
test('cleanup failure remains observable after the failed call already settled', async () => {
  const { service } = mock(() => { throw new WslResultsError('CLEANUP_FAILED'); });
  await assert.rejects(service.list(binding, listArgs, signal()), { code: 'CLEANUP_FAILED' });
  await assert.rejects(service.close(), { code: 'CLEANUP_FAILED' });
});
test('delta: fixed reader sensitive-name and quoted-JSON credential patterns exclude data', () => {
  const namePattern = WSL_RESULTS_READER.match(/def sensitive\(name\):\n    return bool\(re\.search\(r'([^']+)'/u)![1]!;
  const bodyPattern = WSL_RESULTS_READER.match(/if re\.search\(r'([^']+)', text, re\.I\)/u)![1]!;
  // These two literal patterns use a shared Python/ECMAScript regex subset. No Python or WSL is executed.
  const names = new RegExp(namePattern, 'i'), body = new RegExp(bodyPattern, 'i');
  for (const name of ['api.txt', 'auth.json', 'private-key.txt', 'models.json', 'configuration.json', 'netlist.out']) assert.equal(names.test(name), true, name);
  for (const name of ['ac_metrics_v2.json', 'ac_gain_phase.txt', 'spectre.out']) assert.equal(names.test(name), false, name);
  for (const content of ['{"api_key":"fixture-only-synthetic-value"}', "{'password': 'fixture-only-synthetic-value'}", 'access_token=fixture-only-synthetic-value']) assert.equal(body.test(content), true, content);
  assert.equal(body.test('{"gain_dB":67.1,"bandwidth_Hz":15941}'), false);
});
test('delta: result parser rejects nested entry names, contradictory stat sizes and circular input', async () => {
  const { service } = mock(() => ok(listing())); const page = await service.list(binding, listArgs, signal());
  assert.equal(parseWslResultsToolValue({ ...page, entries: [{ ...page.entries[0], name: 'nested/gain.txt', relativePath: 'nested/gain.txt' }] }), null);
  assert.equal(parseWslResultsToolValue({ ...page, entries: [{ ...page.entries[0], bytes: 9 }] }), null);
  const circular: Record<string, unknown> = {}; circular.self = circular; assert.equal(parseWslResultsToolValue(circular), null);
});
test('delta: Linux name order preserves case distinctions and Unicode scalar order', async () => {
  const names = ['A.txt', 'a.txt', '\uffff.txt', '\u{10000}.txt'];
  const { service } = mock(() => ok(listing(names.map(n => row(n)))));
  assert.deepEqual((await service.list(binding, listArgs, signal())).entries.map(e => e.name), names);
});
test('immutability delta: list and read values detach caller aliases and freeze every nested source', async () => {
  const { service } = mock(r => r.operation === 'list' ? ok(listing()) : ok(readPage()));
  const listed = await service.list(binding, listArgs, signal()), listInput = structuredClone(listed);
  const listValue = parseWslResultsToolValue(listInput); assert(listValue?.kind === 'wsl_results_list');
  assert.notEqual(listValue, listInput); assert.notEqual(listValue.binding, listInput.binding); assert.notEqual(listValue.entries, listInput.entries); assert.notEqual(listValue.entries[0], listInput.entries[0]);
  assert(Object.isFrozen(listValue) && Object.isFrozen(listValue.binding) && Object.isFrozen(listValue.entries) && Object.isFrozen(listValue.entries[0]));
  assert.equal(Reflect.set(listValue.binding, 'rootPath', '/changed'), false); assert.equal(Reflect.set(listValue.entries[0]!, 'name', 'changed.txt'), false);
  Reflect.set(listInput.binding, 'rootPath', '/caller-changed'); Reflect.set(listInput.entries[0]!, 'name', 'caller-changed.txt');
  assert.equal(listValue.binding.rootPath, selection.rootPath); assert.equal(listValue.entries[0]!.name, 'gain.txt');
  const read = await service.read(binding, { bindingId: binding.id, fileId: listed.entries[0]!.fileId!, version: fileVersion, startLine: 1, maxLines: 1 }, signal());
  const readInput = structuredClone(read), readValue = parseWslResultsToolValue(readInput); assert(readValue?.kind === 'wsl_results_read');
  assert.notEqual(readValue, readInput); assert.notEqual(readValue.source, readInput.source); assert(Object.isFrozen(readValue) && Object.isFrozen(readValue.source));
  Reflect.set(readInput.source, 'rootIdentity', '1:2'); Reflect.set(readInput, 'text', 'changed');
  assert.equal(readValue.source.rootIdentity, binding.rootIdentity); assert.equal(readValue.text, 'gain\n'); assert.equal(Reflect.set(readValue, 'text', 'changed'), false);
});
test('long paths shrink to result budget without skipping omitted names', async () => {
  const names = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + 'x'.repeat(230) + '.txt');
  const { service, calls } = mock(r => ok(listing(names.filter(n => r.arguments.afterName === null || n > (r.arguments.afterName as string)).map(n => row(n)))));
  const first = await service.list(binding, listArgs, signal()); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= WSL_RESULTS_LIMITS.toolResultBytes); assert.ok(first.nextCursor); assert.ok(first.entries.length < 24);
  const second = await service.list(binding, { ...listArgs, cursor: first.nextCursor }, signal());
  assert.equal(calls[1]!.arguments.afterName, first.entries.at(-1)!.name); assert.deepEqual([...first.entries, ...second.entries].map(e => e.name), names);
});
