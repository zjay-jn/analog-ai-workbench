import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseWslResultsBinding, type WslResultsBinding } from '../../shared/agent/wsl-results';
import { WAVEFORM_RESULTS_VERSION as VERSION, WAVEFORM_RESULTS_LIMITS as L, WAVEFORM_CONVERTER, parseWaveformResultsToolArguments, parseWaveformResultsToolValue, parseWaveformSource, waveformSourceFingerprintPayload, waveformExcerptPayload, type WaveformResultsCode, type WaveformSource, type WaveformSourceFile, type WaveformTrace, type WaveformResultsToolArguments, type WaveformListValue, type WaveformReadValue, type WaveformMetricsValue, type AcTransferInput } from '../../shared/agent/waveform-results';
import { calculateAcMetrics } from './ac-metrics';
import { parseCadenceAcAscii, WaveformResultsError, type ParsedAcResult, type ParsedAcTrace } from './reader-psf';
import { createWaveformResultsTransport, type WaveformResultsTransport, type WaveformReaderRequest } from './transport';
export { WaveformResultsError } from './reader-psf';
const makeId = (): string => 'wave-' + randomUUID();
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const fail = (code: WaveformResultsCode): never => { throw new WaveformResultsError(code); };
const codes: readonly WaveformResultsCode[] = ['INVALID_REQUEST', 'CAPABILITY_DENIED', 'ROOT_UNAVAILABLE', 'ROOT_CHANGED', 'FILE_UNAVAILABLE', 'SOURCE_CHANGED', 'UNSUPPORTED_PATH', 'UNSUPPORTED_FORMAT', 'UNSUPPORTED_ANALYSIS', 'UNSUPPORTED_UNIT', 'UNSUPPORTED_WAVEFORM', 'FILE_LIMIT', 'BUDGET_EXCEEDED', 'CONVERTER_UNAVAILABLE', 'ENGINE_FAILED', 'CLEANUP_FAILED', 'IO_ERROR'];
type TraceRef = { source: WaveformSource; trace: WaveformTrace };
type CursorRef = { binding: WslResultsBinding; path: string; query: string; sourceVersion: string; afterName: string };
const compareNames = (a: string, b: string): number => { const x = Array.from(a), y = Array.from(b); for (let i = 0; i < Math.min(x.length, y.length); i++) { const delta = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!; if (delta) return delta; } return x.length - y.length; };
/** Each run owns one service; only tiny issued identities are retained, never raw PSF or waveform arrays. */
export function createWaveformResultsService(options: Readonly<{ directory: string; transport?: WaveformResultsTransport }>) {
  const transport = options.transport ?? createWaveformResultsTransport({ directory: options.directory });
  const traces = new Map<string, TraceRef>(), cursors = new Map<string, CursorRef>(), shutdown = new AbortController();
  let busy = false, closed = false, cleanupFailed = false, active: Promise<unknown> | null = null;
  const alive = (signal: AbortSignal): void => { if (closed || signal.aborted) fail('CANCELLED'); if (cleanupFailed) fail('CLEANUP_FAILED'); };
  const binding = (v: unknown): WslResultsBinding => parseWslResultsBinding(v) ?? fail('INVALID_REQUEST');
  async function inspect(selected: WslResultsBinding, relativePath: string, operation: 'convert' | 'check', expectedFile: WaveformSourceFile | null, signal: AbortSignal): Promise<{ source: WaveformSource; parsed: ParsedAcResult | null; physicalReadBytes: number; scannedCandidates: number }> {
    alive(signal); if (busy) fail('BUSY'); busy = true;
    try {
      const request: WaveformReaderRequest = { readerVersion: VERSION, binding: selected, relativePath, operation, expectedFile };
      active = transport.execute(request, AbortSignal.any([signal, shutdown.signal]));
      const raw = await active; alive(signal);
      if (!object(raw) || raw.readerVersion !== VERSION) return fail('ENGINE_FAILED');
      if (raw.ok === false) { if (!exact(raw, ['ok', 'readerVersion', 'error']) || !codes.includes(raw.error as WaveformResultsCode)) return fail('ENGINE_FAILED'); return fail(raw.error as WaveformResultsCode); }
      if (raw.ok !== true || !exact(raw, ['ok', 'readerVersion', 'value']) || !object(raw.value)) return fail('ENGINE_FAILED');
      const v = raw.value;
      if (!exact(v, ['operation', 'rootIdentity', 'file', 'ascii', 'asciiSha256', 'converter', 'physicalReadBytes', 'scannedCandidates']) || v.operation !== operation || v.rootIdentity !== selected.rootIdentity || !object(v.file)) return fail('ENGINE_FAILED');
      const sourceBase = { binding: selected, readerVersion: VERSION, format: 'psfbin-1.1' as const, analysis: 'ac' as const, files: [v.file as WaveformSourceFile], converter: WAVEFORM_CONVERTER };
      const source = parseWaveformSource({ ...sourceBase, sourceVersion: hash(waveformSourceFingerprintPayload(sourceBase)) });
      if (!source || source.files[0]!.relativePath !== relativePath || expectedFile && !isDeepStrictEqual(source.files[0], expectedFile)) return fail('SOURCE_CHANGED');
      // Budget charge: two observed full-source hashes plus one source-length allowance for converter input.
      if (v.physicalReadBytes !== source.files[0]!.bytes * (operation === 'convert' ? 3 : 2) || v.scannedCandidates !== 1) return fail('ENGINE_FAILED');
      let parsed: ParsedAcResult | null = null;
      if (operation === 'check') { if (v.ascii !== null || v.asciiSha256 !== null || v.converter !== null) return fail('ENGINE_FAILED'); }
      else {
        if (typeof v.ascii !== 'string' || Buffer.byteLength(v.ascii) > L.convertedBytes || v.asciiSha256 !== hash(v.ascii) || !object(v.converter) || !exact(v.converter, ['exitCode', 'processGroupGone']) || v.converter.exitCode !== 0 || v.converter.processGroupGone !== true) return fail('ENGINE_FAILED');
        parsed = parseCadenceAcAscii(v.ascii);
      }
      alive(signal); return { source, parsed, physicalReadBytes: v.physicalReadBytes, scannedCandidates: 1 };
    } catch (error) { if (error instanceof WaveformResultsError && error.code === 'CLEANUP_FAILED') cleanupFailed = true; throw error; }
    finally { busy = false; active = null; }
  }
  function reference(selected: WslResultsBinding, traceId: string, sourceVersion: string): TraceRef {
    const ref = traces.get(traceId) ?? fail('TRACE_UNAVAILABLE'); if (!isDeepStrictEqual(ref.source.binding, selected)) return fail('CAPABILITY_DENIED'); if (ref.source.sourceVersion !== sourceVersion) return fail('SOURCE_CHANGED'); return ref;
  }
  function currentTrace(ref: TraceRef, source: WaveformSource, parsed: ParsedAcResult): ParsedAcTrace {
    if (!isDeepStrictEqual(ref.source, source)) return fail('SOURCE_CHANGED'); const trace = parsed.traces.find(t => t.signalName === ref.trace.signalName) ?? fail('TRACE_UNAVAILABLE');
    if (trace.unit !== ref.trace.unit || trace.sampleType !== ref.trace.sampleType || trace.points.length !== ref.trace.totalPoints) return fail('SOURCE_CHANGED'); return trace;
  }
  return {
    async list(input: WslResultsBinding, inputArgs: WaveformResultsToolArguments['wsl_waveform_list'], signal: AbortSignal): Promise<WaveformListValue> {
      const selected = binding(input), args = parseWaveformResultsToolArguments('wsl_waveform_list', inputArgs) ?? fail('INVALID_REQUEST'); if (selected.id !== args.bindingId) return fail('CAPABILITY_DENIED');
      const previous = args.cursor ? cursors.get(args.cursor) ?? fail('CURSOR_STALE') : null;
      if (previous && (!isDeepStrictEqual(previous.binding, selected) || previous.path !== args.relativePath || previous.query !== args.nameQuery)) return fail('CURSOR_STALE');
      const loaded = await inspect(selected, args.relativePath, 'convert', null, signal), parsed = loaded.parsed!;
      if (previous && previous.sourceVersion !== loaded.source.sourceVersion) return fail('CURSOR_STALE');
      const all = parsed.traces.filter(t => t.signalName.includes(args.nameQuery) && (!previous || compareNames(t.signalName, previous.afterName) > 0)).sort((a, b) => compareNames(a.signalName, b.signalName));
      const pending = all.slice(0, L.listEntries).map(t => ({ traceId: makeId(), signalName: t.signalName, unit: t.unit, sampleType: t.sampleType, frequencyUnit: 'Hz' as const, totalPoints: parsed.totalPoints }));
      const nextId = makeId(); let entries = pending;
      const value = (): WaveformListValue => ({ kind: 'wsl_waveform_list', source: loaded.source, relativePath: args.relativePath, nameQuery: args.nameQuery, traces: entries, nextCursor: entries.length < all.length ? nextId : null, complete: entries.length === all.length, physicalReadBytes: loaded.physicalReadBytes, scannedCandidates: loaded.scannedCandidates });
      while (entries.length && Buffer.byteLength(JSON.stringify({ ok: true, value: value() })) > L.toolResultBytes) entries = entries.slice(0, -1);
      if (!entries.length && all.length) return fail('BUDGET_EXCEEDED'); const result = parseWaveformResultsToolValue(value()); if (!result || result.kind !== 'wsl_waveform_list') return fail('ENGINE_FAILED');
      if (traces.size + entries.length > L.traces || result.nextCursor && cursors.size >= L.cursors) return fail('BUDGET_EXCEEDED');
      alive(signal); for (const trace of result.traces) traces.set(trace.traceId, { source: result.source, trace });
      if (result.nextCursor) cursors.set(result.nextCursor, { binding: selected, path: args.relativePath, query: args.nameQuery, sourceVersion: result.source.sourceVersion, afterName: result.traces.at(-1)!.signalName });
      if (args.cursor) cursors.delete(args.cursor); return result;
    },
    async read(input: WslResultsBinding, inputArgs: WaveformResultsToolArguments['wsl_waveform_read'], signal: AbortSignal): Promise<WaveformReadValue> {
      const selected = binding(input), args = parseWaveformResultsToolArguments('wsl_waveform_read', inputArgs) ?? fail('INVALID_REQUEST'); if (selected.id !== args.bindingId) return fail('CAPABILITY_DENIED');
      const ref = reference(selected, args.traceId, args.sourceVersion); if (args.startPoint >= ref.trace.totalPoints) return fail('INVALID_REQUEST');
      const loaded = await inspect(selected, ref.source.files[0]!.relativePath, 'convert', ref.source.files[0]!, signal), raw = currentTrace(ref, loaded.source, loaded.parsed!);
      let points = raw.points.slice(args.startPoint, args.startPoint + args.maxPoints); const citationId = makeId();
      const value = (): WaveformReadValue => { const endPoint = args.startPoint + points.length - 1; const v: WaveformReadValue = { kind: 'wsl_waveform_read', source: loaded.source, trace: ref.trace, startPoint: args.startPoint, endPoint, points, nextPoint: endPoint + 1 < ref.trace.totalPoints ? endPoint + 1 : null, complete: endPoint + 1 === ref.trace.totalPoints, citationId, excerptSha256: '', physicalReadBytes: loaded.physicalReadBytes, scannedCandidates: loaded.scannedCandidates }; return { ...v, excerptSha256: hash(waveformExcerptPayload(v)) }; };
      while (points.length && Buffer.byteLength(JSON.stringify({ ok: true, value: value() })) > L.toolResultBytes) points = points.slice(0, -1);
      if (!points.length) return fail('BUDGET_EXCEEDED'); const result = parseWaveformResultsToolValue(value()); if (!result || result.kind !== 'wsl_waveform_read') return fail('ENGINE_FAILED'); alive(signal); return result;
    },
    async metrics(input: WslResultsBinding, inputArgs: WaveformResultsToolArguments['wsl_waveform_metrics'], signal: AbortSignal): Promise<WaveformMetricsValue> {
      const selected = binding(input), args = parseWaveformResultsToolArguments('wsl_waveform_metrics', inputArgs) ?? fail('INVALID_REQUEST'); if (selected.id !== args.bindingId) return fail('CAPABILITY_DENIED');
      const ids = [...new Set([args.numerator.positiveTraceId, args.numerator.negativeTraceId, args.denominator.positiveTraceId, args.denominator.negativeTraceId].filter((id): id is string => id !== null))];
      const refs = ids.map(id => reference(selected, id, args.sourceVersion)); if (refs.some(r => r.trace.unit !== 'V')) return fail('UNSUPPORTED_UNIT'); const first = refs[0]!;
      if (refs.some(r => !isDeepStrictEqual(r.source, first.source))) return fail('SOURCE_CHANGED');
      const loaded = await inspect(selected, first.source.files[0]!.relativePath, 'convert', first.source.files[0]!, signal), parsed = loaded.parsed!, data = new Map(refs.map(ref => [ref.trace.traceId, currentTrace(ref, loaded.source, parsed)]));
      const port = (selection: typeof args.numerator) => ({ positiveSignal: data.get(selection.positiveTraceId)!.signalName, negativeSignal: selection.negativeTraceId === null ? '0' : data.get(selection.negativeTraceId)!.signalName, unit: 'V' as const });
      const difference = (selection: typeof args.numerator, i: number) => { const p = data.get(selection.positiveTraceId)!.points[i]!, n = selection.negativeTraceId === null ? null : data.get(selection.negativeTraceId)!.points[i]!; if (n && n.frequencyHz !== p.frequencyHz) return fail('AXIS_MISMATCH'); return { real: p.real - (n?.real ?? 0), imag: p.imag - (n?.imag ?? 0) }; };
      const axis = data.get(first.trace.traceId)!.points;
      for (const trace of data.values()) if (trace.points.length !== axis.length || trace.points.some((p, i) => p.frequencyHz !== axis[i]!.frequencyHz)) return fail('AXIS_MISMATCH');
      const transfer: AcTransferInput = { analysis: 'ac', frequencyUnit: 'Hz', numerator: port(args.numerator), denominator: port(args.denominator), samples: axis.map((p, i) => ({ frequencyHz: p.frequencyHz, numerator: difference(args.numerator, i), denominator: difference(args.denominator, i) })) };
      const value: WaveformMetricsValue = { kind: 'wsl_waveform_metrics', source: loaded.source, numerator: args.numerator, denominator: args.denominator, traces: refs.map(r => r.trace), metrics: calculateAcMetrics(transfer), citationId: makeId(), excerptSha256: '', physicalReadBytes: loaded.physicalReadBytes, scannedCandidates: loaded.scannedCandidates };
      const signed = { ...value, excerptSha256: hash(waveformExcerptPayload(value)) }; if (Buffer.byteLength(JSON.stringify({ ok: true, value: signed })) > L.toolResultBytes) return fail('BUDGET_EXCEEDED');
      const result = parseWaveformResultsToolValue(signed); if (!result || result.kind !== 'wsl_waveform_metrics') return fail('ENGINE_FAILED'); alive(signal); return result;
    },
    async checkSource(input: WslResultsBinding, savedSource: WaveformSource, signal: AbortSignal): Promise<{ source: WaveformSource; physicalReadBytes: number; scannedCandidates: number }> {
      const selected = binding(input), source = parseWaveformSource(savedSource) ?? fail('INVALID_REQUEST'); if (!isDeepStrictEqual(source.binding, selected) || source.sourceVersion !== hash(waveformSourceFingerprintPayload(source))) return fail('CAPABILITY_DENIED');
      const loaded = await inspect(selected, source.files[0]!.relativePath, 'check', source.files[0]!, signal); if (!isDeepStrictEqual(source, loaded.source)) return fail('SOURCE_CHANGED'); return { source: loaded.source, physicalReadBytes: loaded.physicalReadBytes, scannedCandidates: loaded.scannedCandidates };
    },
    async close(): Promise<void> { closed = true; shutdown.abort(); traces.clear(); cursors.clear(); const pending = active; if (pending) { try { await pending; } catch (error) { if (error instanceof WaveformResultsError && error.code === 'CLEANUP_FAILED') cleanupFailed = true; } } if (cleanupFailed) throw new WaveformResultsError('CLEANUP_FAILED'); },
  };
}
export type WaveformResultsService = ReturnType<typeof createWaveformResultsService>;
