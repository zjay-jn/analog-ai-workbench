import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { calculateAcMetrics } from '../apps/desktop/src/main/waveform-results/ac-metrics';
import { createWaveformResultsTransport, type WaveformReaderRequest } from '../apps/desktop/src/main/waveform-results/transport';
import { createWaveformResultsService, WaveformResultsError } from '../apps/desktop/src/main/waveform-results/service';
import { parseWaveformResultsToolValue, WAVEFORM_CONVERTER, WAVEFORM_RESULTS_VERSION, WAVEFORM_RESULTS_LIMITS,
  type AcMetricsComputed, type WaveformMetricsValue } from '../apps/desktop/src/shared/agent/waveform-results';

/** Synthetic tool record only: no WSL, converter, engineering file, transport or disk persistence. */
function fixture(): WaveformMetricsValue & { metrics: AcMetricsComputed } {
  const metrics = calculateAcMetrics({ analysis: 'ac', frequencyUnit: 'Hz',
    numerator: { positiveSignal: 'OUT', negativeSignal: '0', unit: 'V' },
    denominator: { positiveSignal: 'IN', negativeSignal: '0', unit: 'V' },
    samples: [10, 100, 1000].map((frequencyHz, index) => ({ frequencyHz,
      numerator: { real: [10, 0.1, 0.01][index]!, imag: 0 }, denominator: { real: 1, imag: 0 } })) });
  assert.notEqual(metrics.status, 'invalid_input');
  if (metrics.status === 'invalid_input') throw new Error(metrics.issue.code);
  const value: WaveformMetricsValue & { metrics: AcMetricsComputed } = {
    kind: 'wsl_waveform_metrics',
    source: { binding: { distro: 'ROCKY9_LLM_LAB', user: 'maxwell', rootPath: '/home/maxwell/simulation/security-fixture',
      id: 'wsl-security-fixture', rootIdentity: '1:2', readerVersion: 'aaw.wsl-results.v1', selectedAt: '2026-09-15T00:00:00.000Z' },
      readerVersion: WAVEFORM_RESULTS_VERSION, format: 'psfbin-1.1', analysis: 'ac', sourceVersion: 'a'.repeat(64),
      files: [{ relativePath: 'ac.ac', fileIdentity: '1:3', version: '1:3:100:1789440000000000000:1789440000000000000', bytes: 100, rawSha256: 'b'.repeat(64) }], converter: WAVEFORM_CONVERTER },
    numerator: { positiveTraceId: 'wave-output', negativeTraceId: null },
    denominator: { positiveTraceId: 'wave-input', negativeTraceId: null },
    traces: [ { traceId: 'wave-output', signalName: 'OUT', unit: 'V', sampleType: 'complex', frequencyUnit: 'Hz', totalPoints: 3 },
      { traceId: 'wave-input', signalName: 'IN', unit: 'V', sampleType: 'complex', frequencyUnit: 'Hz', totalPoints: 3 } ],
    metrics, citationId: 'wave-security-citation', excerptSha256: 'c'.repeat(64), physicalReadBytes: 400, scannedCandidates: 2,
  };
  assert.ok(parseWaveformResultsToolValue(value), 'coherent baseline must be admitted before adversarial mutation');
  return value;
}

test('security: coherent synthetic metrics retain explicit signal identity and detached history values', () => {
  const value = fixture();
  const parsed = parseWaveformResultsToolValue(value)!;
  assert.equal(parsed.kind, 'wsl_waveform_metrics');
  if (parsed.kind !== 'wsl_waveform_metrics' || parsed.metrics.status === 'invalid_input') assert.fail('metrics expected');
  assert.equal(parsed.metrics.definition.numerator.positiveSignal, 'OUT');
  assert.equal(parsed.metrics.unityGain.crossings[0]!.bracket.lower.frequencyHz, 10);
  assert.equal(parsed.metrics.unityGain.crossings[0]!.bracket.upper.frequencyHz, 100);
  assert.ok(Object.isFrozen(parsed.metrics));
  assert.notEqual(parsed.metrics, value.metrics);
});

test('security: whole-sweep metrics reject trace counts inconsistent with each other or computed sampleCount', () => {
  const admitted: string[] = [];
  for (const counts of [[3, 4], [4, 4]]) {
    const value = fixture();
    const candidate = { ...value, traces: value.traces.map((trace, index) => ({ ...trace, totalPoints: counts[index]! })) };
    if (parseWaveformResultsToolValue(candidate)) admitted.push(counts.join('/'));
  }
  assert.deepEqual(admitted, [], 'a full-waveform result must not accept incompatible coverage');
});

test('security: calculation port names and ground convention must match the selected trace IDs', () => {
  const admitted: string[] = [];
  for (const port of [ { positiveSignal: 'UNRELATED', negativeSignal: '0', unit: 'V' },
    { positiveSignal: 'IN', negativeSignal: 'OUT', unit: 'V' } ]) {
    const value = fixture();
    const candidate = { ...value, metrics: { ...value.metrics,
      definition: { ...value.metrics.definition, denominator: port } } };
    if (parseWaveformResultsToolValue(candidate)) admitted.push(port.positiveSignal + '/' + port.negativeSignal);
  }
  assert.deepEqual(admitted, [], 'selected IN-to-ground cannot describe another transfer function');
});

test('security: resolved crossing cannot lose numeric evidence or leave its own bracket during validation', () => {
  const admitted: string[] = [];
  for (const mutation of ['outside_bracket', 'null_phase', 'nonfinite_phase', 'null_fraction'] as const) {
    const value = fixture();
    const event = value.metrics.unityGain.crossings[0]!;
    const changed = mutation === 'outside_bracket' ? { ...event, frequencyHz: 1e8 }
      : mutation === 'null_phase' ? { ...event, phaseUnwrappedDeg: null }
      : mutation === 'nonfinite_phase' ? { ...event, phaseUnwrappedDeg: Number.NaN }
      : { ...event, bracket: { ...event.bracket, fraction: null } };
    const candidate = { ...value, metrics: { ...value.metrics,
      unityGain: { ...value.metrics.unityGain, crossings: [changed] } } };
    if (parseWaveformResultsToolValue(candidate)) admitted.push(mutation);
  }
  assert.deepEqual(admitted, [], 'serialization and shape checks must not turn invalid evidence into an accepted crossing');
});

// Lifecycle tests model an empty private directory and a launcher entirely in memory.
// They do not create files or prove the real filesystem/WSL isolation boundary.
const syntheticDirectory = 'C:\\work\\analog_ai_workbench\\.local\\waveform-reader-security-fixture';
function emptyDirectory(t: TestContext): void {
  const paths = new Set(['C:\\work\\analog_ai_workbench', 'C:\\work\\analog_ai_workbench\\.local', syntheticDirectory]);
  t.mock.method(fs, 'lstatSync', ((p: fs.PathLike) => {
    assert.ok(paths.has(String(p)), 'unexpected filesystem query');
    return { isDirectory: () => true, isSymbolicLink: () => false };
  }) as typeof fs.lstatSync);
  t.mock.method(fs.realpathSync, 'native', ((p: fs.PathLike) => {
    assert.ok(paths.has(String(p)), 'unexpected realpath query'); return String(p);
  }) as typeof fs.realpathSync.native);
  t.mock.method(fs, 'readdirSync', ((p: fs.PathLike) => { assert.equal(p, syntheticDirectory); return []; }) as typeof fs.readdirSync);
}
function processDouble() {
  let kills = 0;
  const child = Object.assign(new EventEmitter(), { pid: 991, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { kills++; return true; } });
  return { child, process: child as unknown as ChildProcessWithoutNullStreams, kills: () => kills };
}
const readerRequest = (): WaveformReaderRequest => ({ readerVersion: WAVEFORM_RESULTS_VERSION,
  binding: fixture().source.binding, relativePath: 'ac.ac', operation: 'convert', expectedFile: null });
const hasCode = (code: string) => (error: unknown): boolean => error instanceof WaveformResultsError && error.code === code;
function successfulHelperReply(): string {
  const value = fixture();
  return JSON.stringify({ ok: true, readerVersion: WAVEFORM_RESULTS_VERSION,
    value: { operation: 'convert', rootIdentity: value.source.binding.rootIdentity, file: value.source.files[0],
      ascii: '', asciiSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      converter: { exitCode: 0, processGroupGone: true }, physicalReadBytes: 300, scannedCandidates: 1 } });
}

test('security: abort waits for helper completion and rejects a subsequently successful result', async t => {
  emptyDirectory(t);
  const stub = processDouble(), abort = new AbortController();
  const transport = createWaveformResultsTransport({ directory: syntheticDirectory, platform: 'win32', spawn: () => stub.process });
  const pending = transport.execute(readerRequest(), abort.signal);
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, hasCode('CANCELLED'));
  abort.abort(); await Promise.resolve();
  assert.equal(settled, false, 'cancellation cannot claim helper cleanup before its completion');
  assert.equal(stub.kills(), 0, 'bounded helper keeps its opportunity to produce cleanup acknowledgement');
  stub.child.stdout.write(successfulHelperReply());
  stub.child.emit('close', 0);
  await rejected;
});

test('security: outer deadline makes late exit zero cleanup-unknown and poisons transport reuse', async t => {
  emptyDirectory(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stub = processDouble(); let launches = 0;
  const transport = createWaveformResultsTransport({ directory: syntheticDirectory, platform: 'win32', spawn: () => { launches++; return stub.process; } });
  const pending = transport.execute(readerRequest(), new AbortController().signal);
  const rejected = assert.rejects(pending, hasCode('CLEANUP_FAILED'));
  t.mock.timers.tick(WAVEFORM_RESULTS_LIMITS.timeoutMs);
  assert.equal(stub.kills(), 1);
  stub.child.stdout.write(successfulHelperReply());
  stub.child.emit('close', 0);
  await rejected;
  await assert.rejects(transport.execute(readerRequest(), new AbortController().signal), hasCode('CLEANUP_FAILED'));
  assert.equal(launches, 1, 'unknown Linux lifecycle cannot admit another launcher');
});

test('security: service close preserves a concurrent transport cleanup failure instead of reporting cancellation', async () => {
  let rejectReader!: (error: unknown) => void;
  const service = createWaveformResultsService({ directory: syntheticDirectory,
    transport: { execute: () => new Promise((_resolve, reject) => { rejectReader = reject; }) } });
  const binding = fixture().source.binding;
  const pending = service.list(binding, { bindingId: binding.id, relativePath: 'ac.ac', analysis: 'ac', nameQuery: '', cursor: null }, new AbortController().signal);
  const rejectedRead = assert.rejects(pending, hasCode('CLEANUP_FAILED'));
  const rejectedClose = assert.rejects(service.close(), hasCode('CLEANUP_FAILED'));
  rejectReader(new WaveformResultsError('CLEANUP_FAILED'));
  await Promise.all([rejectedRead, rejectedClose]);
});

test('security: cancelled launcher with missing cleanup acknowledgement is cleanup-unknown, not cleanly cancelled', async t => {
  emptyDirectory(t);
  const stub = processDouble(), abort = new AbortController();
  const transport = createWaveformResultsTransport({ directory: syntheticDirectory, platform: 'win32', spawn: () => stub.process });
  const pending = transport.execute(readerRequest(), abort.signal);
  const rejected = assert.rejects(pending, hasCode('CLEANUP_FAILED'));
  abort.abort();
  stub.child.stdout.write(JSON.stringify({ ok: true, readerVersion: WAVEFORM_RESULTS_VERSION, value: {} }));
  stub.child.emit('close', 0);
  await rejected;
  await assert.rejects(transport.execute(readerRequest(), new AbortController().signal), hasCode('CLEANUP_FAILED'));
});
