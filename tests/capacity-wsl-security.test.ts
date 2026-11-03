import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { WSL_RESULTS_LIMITS, WSL_RESULTS_VERSION } from '../apps/desktop/src/shared/agent/wsl-results';
import { createWslResultsTransport, type WslReaderRequest } from '../apps/desktop/src/main/wsl-results/transport';

// Independent delta: author tests cover abort, excess output and missing close.
// This target checks the deadline path against late successful output/exit.
// No process, filesystem source, WSL, model or product bootstrap is started.
test('security: WSL deadline remains unsettled until actual close and cannot become late success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = new EventEmitter();
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let kills = 0, settled = false;
  const child = Object.assign(events, {
    stdin, stdout, stderr, pid: 4242,
    kill() { kills++; return true; },
  }) as unknown as ChildProcessWithoutNullStreams;
  const transport = createWslResultsTransport({ platform: 'win32', spawn: () => child });
  const request: WslReaderRequest = {
    distro: 'ROCKY9_LLM_LAB', user: 'maxwell',
    rootPath: '/home/maxwell/simulation/security-synthetic-result',
    readerVersion: WSL_RESULTS_VERSION, rootIdentity: null, operation: 'select', arguments: {},
  };
  const outcome = transport.execute(request, new AbortController().signal).then(
    value => { settled = true; return { kind: 'success' as const, value }; },
    error => { settled = true; return { kind: 'error' as const, error }; },
  );
  t.mock.timers.tick(WSL_RESULTS_LIMITS.timeoutMs - 1);
  stdout.write('{"ok":true}');
  await setImmediate();
  assert.equal(kills, 0); assert.equal(settled, false);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(kills, 1); assert.equal(settled, false, 'kill request is not close evidence');
  stdout.write('{"ok":true,"late":true}');
  t.mock.timers.tick(999);
  await setImmediate();
  assert.equal(settled, false);
  events.emit('close', 0);
  const result = await outcome;
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.equal(result.error.code, 'BUDGET_EXCEEDED');
  t.mock.timers.tick(2);
  assert.equal(kills, 1);
});
