import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { WSL_RESULTS_VERSION } from '../apps/desktop/src/shared/agent/wsl-results';
import { createWslResultsTransport, type WslReaderRequest } from '../apps/desktop/src/main/wsl-results/transport';
const request: WslReaderRequest = { distro: 'ROCKY9_LLM_LAB', user: 'maxwell', rootPath: '/home/maxwell/simulation/synthetic-result', readerVersion: WSL_RESULTS_VERSION, rootIdentity: null, operation: 'select', arguments: {} };
function fakeChild(closeOnKill = true) {
  const events = new EventEmitter(); const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(); let kills = 0;
  const child = Object.assign(events, { stdin, stdout, stderr, pid: 321, kill: () => { kills++; if (closeOnKill) queueMicrotask(() => events.emit('close', null)); return true; } }) as unknown as ChildProcessWithoutNullStreams;
  return { child, stdin, stdout, stderr, events, kills: () => kills };
}
test('bounded stderr warning does not override valid JSON and no shell/environment can be injected', async () => {
  const f = fakeChild(); let invoked = false;
  const transport = createWslResultsTransport({ platform: 'win32', spawn(file, args, options) { invoked = true; assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.deepEqual(Object.keys(options.env!).sort(), ['SystemRoot', 'WINDIR']); assert.equal(args[4], '--exec'); assert.equal(file, 'C:\\Windows\\System32\\wsl.exe'); return f.child; } });
  const pending = transport.execute(request, new AbortController().signal);
  f.stderr.write(Buffer.from('localhost / NAT warning', 'utf16le')); f.stdout.write('{"ok":true}'); f.events.emit('close', 0);
  assert.deepEqual(await pending, { ok: true }); assert.equal(invoked, true); assert.equal(f.kills(), 0);
});
test('cancellation discards late output and resolves only after launcher close', async () => {
  const f = fakeChild(), controller = new AbortController();
  const transport = createWslResultsTransport({ platform: 'win32', spawn: () => f.child });
  const pending = transport.execute(request, controller.signal); controller.abort(); f.stdout.write('{"ok":true}');
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(f.kills(), 1);
});
test('unconfirmed launcher exit is cleanup failure and disables reuse', async () => {
  const f = fakeChild(false), controller = new AbortController();
  const transport = createWslResultsTransport({ platform: 'win32', spawn: () => f.child });
  const pending = transport.execute(request, controller.signal); controller.abort();
  await assert.rejects(pending, { code: 'CLEANUP_FAILED' });
  await assert.rejects(transport.execute(request, new AbortController().signal), { code: 'CLEANUP_FAILED' });
});
test('oversized transport output is rejected and launcher is stopped', async () => {
  const f = fakeChild(); const transport = createWslResultsTransport({ platform: 'win32', spawn: () => f.child });
  const pending = transport.execute(request, new AbortController().signal); f.stdout.write(Buffer.alloc(131073, 65));
  await assert.rejects(pending, { code: 'BUDGET_EXCEEDED' }); assert.equal(f.kills(), 1);
});
