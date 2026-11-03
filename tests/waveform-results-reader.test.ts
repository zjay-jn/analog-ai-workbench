import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { createWaveformResultsService } from '../apps/desktop/src/main/waveform-results/service';
import { parseCadenceAcAscii, WaveformResultsError } from '../apps/desktop/src/main/waveform-results/reader-psf';
import { createWaveformResultsTransport, waveformResultsInvocation, type WaveformReaderRequest } from '../apps/desktop/src/main/waveform-results/transport';
import { WAVEFORM_RESULTS_VERSION as VERSION, WAVEFORM_RESULTS_LIMITS as L, parseWaveformResultsToolArguments, parseWaveformResultsToolValue, waveformExcerptPayload, waveformSourceFingerprintPayload } from '../apps/desktop/src/shared/agent/waveform-results';
import type { WslResultsBinding } from '../apps/desktop/src/shared/agent/wsl-results';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const binding: WslResultsBinding = { id: 'wsl-synthetic', distro: 'ROCKY9_LLM_LAB', user: 'maxwell', rootPath: '/home/maxwell/simulation/synthetic-result', rootIdentity: '1:2', selectedAt: '2026-09-15T00:00:00.000Z', readerVersion: 'aaw.wsl-results.v1' };
const file = { relativePath: 'sample.ac', fileIdentity: '1:3', version: '1:3:1000:123:123', bytes: 1000, rawSha256: 'a'.repeat(64) };
const dir = 'C:\\work\\analog_ai_workbench\\.local\\quality-evidence\\20260915-waveform-results-01\\reader-unit-01\\empty-cwd';
const sig = () => new AbortController().signal;
function ascii(count = 3, long = false) {
  const start = 'HEADER\n"PSFversion" "1.00"\n"analysis type" "ac"\n"analysis name" "ac"\n"xVecSorted" "ascending"\nTYPE\n"sweep" FLOAT DOUBLE PROP("key" "sweep")\n"V" COMPLEX DOUBLE PROP("units" "V")\n"I" COMPLEX DOUBLE PROP("units" "A")\nSWEEP\n"freq" "sweep" PROP("units" "Hz")\nTRACE\n"OUT" "V"\n"IN" "V"\n"NEG" "V"\n"CURRENT" "I"\nVALUE\n';
  return start + Array.from({ length: count }, (_, i) => {
    const f = long ? 1.0000000000000002 + i * 0.12345678901234567 : 10 ** i;
    const re = long ? 1.2345678901234567 + i / 7 : [10, 1, 0.1][i % 3];
    const im = long ? -2.2345678901234567 - i / 11 : 0;
    return '"freq" ' + f + '\n"OUT" (' + re + ' ' + im + ')\n"IN" (0.5 0)\n"NEG" (-0.5 0)\n"CURRENT" (1 0)\n';
  }).join('') + 'END\n';
}
function response(request: WaveformReaderRequest, body = ascii(), rawFile = file) {
  return { ok: true, readerVersion: VERSION, value: { operation: request.operation, rootIdentity: binding.rootIdentity, file: rawFile, ascii: request.operation === 'convert' ? body : null, asciiSha256: request.operation === 'convert' ? hash(body) : null, converter: request.operation === 'convert' ? { exitCode: 0, processGroupGone: true } : null, physicalReadBytes: rawFile.bytes * (request.operation === 'convert' ? 3 : 2), scannedCandidates: 1 } };
}
const listArgs = { bindingId: binding.id, relativePath: file.relativePath, analysis: 'ac' as const, nameQuery: '', cursor: null };

test('reader accepts explicit AC complex units and complete original samples without dB reconstruction', () => {
  const result = parseCadenceAcAscii(ascii()); assert.equal(result.totalPoints, 3); assert.equal(result.traces.length, 4);
  assert.deepEqual(result.traces[0]!.points[1], { frequencyHz: 10, real: 1, imag: 0 }); assert.equal(result.traces[3]!.unit, 'A');
});
test('reader rejects unsupported analysis/unit, truncation, duplicate signal and mismatched point blocks', () => {
  const body = ascii();
  for (const bad of [body.replace('"analysis type" "ac"', '"analysis type" "tran"'), body.replace('"units" "Hz"', '"units" "s"'), body.replace('"units" "V"', '"units" "mV"'), body.replace('"OUT" "V"', '"IN" "V"'), body.replace('"OUT" (1 0)', '"MISSING" (1 0)'), body.replace('"freq" 10', '"freq" 1'), body.replace('END', ''), body.replace('"OUT" (1 0)', '"OUT" (1e999 0)')]) assert.throws(() => parseCadenceAcAscii(bad), WaveformResultsError);
});
test('service signs same-source differential metrics and keeps historical reads detached', async () => {
  let calls = 0; const service = createWaveformResultsService({ directory: dir, transport: { async execute(req) { calls++; return response(req); } } });
  const list = await service.list(binding, listArgs, sig()); const out = list.traces.find(t => t.signalName === 'OUT')!, input = list.traces.find(t => t.signalName === 'IN')!, neg = list.traces.find(t => t.signalName === 'NEG')!;
  assert.equal(list.source.sourceVersion, hash(waveformSourceFingerprintPayload(list.source))); assert.equal(list.physicalReadBytes, 3000);
  const read = await service.read(binding, { bindingId: binding.id, traceId: out.traceId, sourceVersion: list.source.sourceVersion, startPoint: 0, maxPoints: 2 }, sig()); assert.equal(read.nextPoint, 2); assert.equal(read.excerptSha256, hash(waveformExcerptPayload(read))); assert(Object.isFrozen(read.points[0]));
  const metrics = await service.metrics(binding, { bindingId: binding.id, sourceVersion: list.source.sourceVersion, numerator: { positiveTraceId: out.traceId, negativeTraceId: null }, denominator: { positiveTraceId: input.traceId, negativeTraceId: neg.traceId } }, sig());
  assert.notEqual(metrics.metrics.status, 'invalid_input'); if (metrics.metrics.status === 'invalid_input') assert.fail(); assert.equal(metrics.metrics.firstFrequencyPoint?.gainDb, 20); assert.equal(metrics.metrics.definition.denominator.negativeSignal, 'NEG'); assert.equal(metrics.metrics.sampleCount, 3); assert.equal(metrics.excerptSha256, hash(waveformExcerptPayload(metrics)));
  const checked = await service.checkSource(binding, list.source, sig()); assert.equal(checked.physicalReadBytes, 2000); assert.equal(calls, 4); await service.close();
});
test('service fresh-checks source for each call and rejects a same-stat altered raw hash', async () => {
  let changed = false; const service = createWaveformResultsService({ directory: dir, transport: { async execute(req) { return response(req, ascii(), changed ? { ...file, rawSha256: 'b'.repeat(64) } : file); } } });
  const list = await service.list(binding, listArgs, sig()); changed = true;
  await assert.rejects(service.read(binding, { bindingId: binding.id, traceId: list.traces[0]!.traceId, sourceVersion: list.source.sourceVersion, startPoint: 0, maxPoints: 2 }, sig()), { code: 'SOURCE_CHANGED' }); await service.close();
});
test('read pagination budgets the entire success envelope and retains exact whole point coverage', async () => {
  const service = createWaveformResultsService({ directory: dir, transport: { async execute(req) { return response(req, ascii(150, true)); } } });
  const list = await service.list(binding, listArgs, sig()), out = list.traces.find(t => t.signalName === 'OUT')!; let next = 0, total = 0, pages = 0;
  do { const read = await service.read(binding, { bindingId: binding.id, traceId: out.traceId, sourceVersion: list.source.sourceVersion, startPoint: next, maxPoints: 128 }, sig()); assert(Buffer.byteLength(JSON.stringify({ ok: true, value: read })) <= L.toolResultBytes); assert.equal(read.startPoint, total); total += read.points.length; pages++; if (read.nextPoint === null) break; next = read.nextPoint; } while (pages < 10);
  assert.equal(total, 150); assert(pages > 1); await service.close();
});
test('tool arguments reject live getters, symbols, inherited data and negative-zero pagination', () => {
  let getter = 0; const bad = { ...listArgs, get nameQuery() { getter++; return ''; } }; assert.equal(parseWaveformResultsToolArguments('wsl_waveform_list', bad), null); assert.equal(getter, 0);
  assert.equal(parseWaveformResultsToolArguments('wsl_waveform_list', { ...listArgs, [Symbol('x')]: 1 }), null);
  assert.equal(parseWaveformResultsToolArguments('wsl_waveform_list', Object.assign(Object.create({ x: 1 }), listArgs)), null);
  assert.equal(parseWaveformResultsToolArguments('wsl_waveform_read', { bindingId: binding.id, traceId: 'wave-a', sourceVersion: 'b'.repeat(64), startPoint: -0, maxPoints: 1 }), null);
});
test('envelope regression reaches the narrow boundary where another point fits value but not ok/value envelope', async () => {
  const body = ascii(150, true), rawPoints = parseCadenceAcAscii(body).traces.find(t => t.signalName === 'OUT')!.points; let witnessed = false;
  for (let padding = 0; padding < 128 && !witnessed; padding++) {
    const selected = { ...binding, rootPath: binding.rootPath + 'x'.repeat(padding) };
    const service = createWaveformResultsService({ directory: dir, transport: { async execute(req) { return response(req, body); } } });
    const list = await service.list(selected, listArgs, sig()), out = list.traces.find(t => t.signalName === 'OUT')!;
    const read = await service.read(selected, { bindingId: binding.id, traceId: out.traceId, sourceVersion: list.source.sourceVersion, startPoint: 0, maxPoints: 128 }, sig());
    assert(Buffer.byteLength(JSON.stringify({ ok: true, value: read })) <= L.toolResultBytes);
    if (read.points.length < 128) {
      const candidate = { ...read, endPoint: read.endPoint + 1, points: [...read.points, rawPoints[read.points.length]!], nextPoint: read.nextPoint! + 1 };
      witnessed = Buffer.byteLength(JSON.stringify(candidate)) <= L.toolResultBytes && Buffer.byteLength(JSON.stringify({ ok: true, value: candidate })) > L.toolResultBytes;
    }
    await service.close();
  }
  assert(witnessed, 'the fixture must exercise the envelope-only overrun rather than an ordinary point limit');
});
test('a late settled cleanup failure remains sticky when service closes after the failed read', async () => {
  const service = createWaveformResultsService({ directory: dir, transport: { async execute() { throw new WaveformResultsError('CLEANUP_FAILED'); } } }); await assert.rejects(service.list(binding, listArgs, sig()), { code: 'CLEANUP_FAILED' }); await assert.rejects(service.close(), { code: 'CLEANUP_FAILED' });
});
class FakeChild extends EventEmitter { stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 4242; kills = 0; kill() { this.kills++; return true; } }
test('transport fixed argv has no shell/data interpolation and cancellation waits for cleanup ACK plus close', async () => {
  const request: WaveformReaderRequest = { readerVersion: VERSION, binding, relativePath: file.relativePath, operation: 'convert', expectedFile: null };
  const invocation = waveformResultsInvocation(request, dir); assert.deepEqual(invocation.args.slice(0, 9), ['-d', 'ROCKY9_LLM_LAB', '-u', 'maxwell', '--exec', '/usr/bin/python3', '-I', '-', invocation.args[8]]); assert.equal(invocation.args.length, 9);
  const child = new FakeChild(); const controller = new AbortController(); let settled = false;
  const transport = createWaveformResultsTransport({ directory: dir, platform: 'win32', spawn: ((_file: string, _args: readonly string[], options: SpawnOptionsWithoutStdio) => { assert.equal(options.shell, false); assert.equal(options.windowsHide, true); return child; }) as never });
  const pending = transport.execute(request, controller.signal).finally(() => { settled = true; }); controller.abort(); await Promise.resolve(); assert.equal(settled, false); assert.equal(child.kills, 0);
  child.stdout.write(JSON.stringify(response(request))); child.emit('close', 0); await assert.rejects(pending, { code: 'CANCELLED' });
});
test('transport never considers launcher close without process-group evidence a successful cleanup', async () => {
  const request: WaveformReaderRequest = { readerVersion: VERSION, binding, relativePath: file.relativePath, operation: 'convert', expectedFile: null }, child = new FakeChild();
  const transport = createWaveformResultsTransport({ directory: dir, platform: 'win32', spawn: (() => child) as never }); const pending = transport.execute(request, sig()); const bad = response(request); bad.value.converter!.processGroupGone = false; child.stdout.write(JSON.stringify(bad)); child.emit('close', 0); await assert.rejects(pending, { code: 'CLEANUP_FAILED' }); await assert.rejects(transport.execute(request, sig()), { code: 'CLEANUP_FAILED' });
});
