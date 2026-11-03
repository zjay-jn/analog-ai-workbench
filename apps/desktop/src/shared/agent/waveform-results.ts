/** Pure AC DTOs shared by the deterministic algorithm, ledger and read-only renderer. */
export const AC_METRICS_ALGORITHM_VERSION = 'aaw.ac-metrics/v1' as const;
export const AC_METRICS_MAX_SAMPLES = 100_000;

export interface AcComplex { readonly real: number; readonly imag: number }
export interface AcVoltagePort {
  readonly positiveSignal: string;
  /** The explicit reference name '0' may describe a grounded negative terminal. */
  readonly negativeSignal: string;
  readonly unit: 'V';
}
export interface AcTransferSample {
  readonly frequencyHz: number;
  /** Complex voltage positiveSignal - negativeSignal, not magnitude or dB. */
  readonly numerator: AcComplex;
  readonly denominator: AcComplex;
}
export interface AcTransferInput {
  readonly analysis: 'ac';
  readonly frequencyUnit: 'Hz';
  readonly numerator: AcVoltagePort;
  readonly denominator: AcVoltagePort;
  readonly samples: readonly AcTransferSample[];
}
export interface AcMetricIssue {
  readonly code: 'invalid_shape' | 'unsupported_analysis' | 'invalid_unit' | 'invalid_port'
    | 'sample_limit' | 'invalid_frequency' | 'frequency_not_increasing' | 'invalid_complex'
    | 'zero_denominator' | 'zero_numerator' | 'numeric_range';
  readonly sampleIndex: number | null;
  readonly field: string;
}
export interface AcDerivedPoint {
  readonly index: number;
  readonly frequencyHz: number;
  readonly gainDb: number;
  readonly phaseWrappedDeg: number;
  readonly phaseUnwrappedDeg: number;
}
export interface AcThresholdEvent {
  readonly kind: 'interpolated_crossing' | 'sample_crossing' | 'boundary_contact' | 'tangent_contact' | 'threshold_plateau';
  readonly direction: 'rising' | 'falling' | 'indeterminate';
  /** A plateau has an interval, never an arbitrarily selected single frequency. */
  readonly frequencyHz: number | null;
  readonly phaseUnwrappedDeg: number | null;
  /** AC arithmetic screening only: no loop sign, feedback factor or STB conclusion is implied. */
  readonly screening180PlusPhaseDeg: number | null;
  readonly bracket: {
    readonly lower: AcDerivedPoint;
    readonly upper: AcDerivedPoint;
    readonly fraction: number | null;
    readonly method: 'linear_db_and_unwrapped_phase_in_log10_hz' | 'exact_sample' | 'threshold_interval';
  };
}
export interface AcCrossingSummary {
  readonly status: 'insufficient_samples' | 'no_crossing' | 'single_crossing' | 'multiple_crossings' | 'indeterminate_contact';
  readonly targetGainDb: number;
  readonly crossings: readonly AcThresholdEvent[];
  readonly contacts: readonly AcThresholdEvent[];
}
export interface AcMetricsComputed {
  readonly algorithmVersion: typeof AC_METRICS_ALGORITHM_VERSION;
  readonly status: 'ok' | 'insufficient_samples';
  readonly definition: {
    readonly analysis: 'ac'; readonly frequencyUnit: 'Hz'; readonly gainUnit: 'dB'; readonly phaseUnit: 'deg';
    readonly transfer: 'numerator_voltage_difference_over_denominator_voltage_difference';
    readonly numerator: AcVoltagePort; readonly denominator: AcVoltagePort;
    readonly phaseInterpretation: 'ac_screening_only_not_stb_or_stability_proof';
  };
  readonly sampleCount: number;
  readonly frequencyRangeHz: { readonly first: number; readonly last: number } | null;
  readonly firstFrequencyPoint: AcDerivedPoint | null;
  readonly lastFrequencyPoint: AcDerivedPoint | null;
  readonly gainTrend: 'insufficient_samples' | 'non_increasing' | 'has_rising_steps';
  readonly phaseUnwrap: {
    readonly method: 'first_principal_phase_then_shortest_steps_in_minus180_to_180';
    readonly exact180StepIndices: readonly number[];
    readonly samplingCaveat: 'phase_turns_between_samples_cannot_be_recovered';
  };
  readonly bandwidth: {
    readonly definition: 'first_falling_crossing_3db_below_first_frequency_gain';
    readonly referenceGainDb: number | null;
    readonly targetGainDb: number | null;
    readonly status: 'insufficient_samples' | 'not_found_in_sweep' | 'found' | 'multiple_falling_crossings' | 'indeterminate_contact';
    readonly firstFallingCrossing: AcThresholdEvent | null;
    readonly threshold: AcCrossingSummary | null;
  };
  readonly unityGain: AcCrossingSummary;
}
export type AcMetricsResult = AcMetricsComputed | {
  readonly algorithmVersion: typeof AC_METRICS_ALGORITHM_VERSION;
  readonly status: 'invalid_input';
  readonly issue: AcMetricIssue;
};
export type AcTransferDerivation = { readonly status: 'ok'; readonly points: readonly AcDerivedPoint[]; readonly exact180StepIndices: readonly number[] }
  | { readonly status: 'invalid_input'; readonly issue: AcMetricIssue };


import { parseWslResultsBinding, isWslResultsRelativePath, type WslResultsBinding, type WslResultsCode } from './wsl-results';

export const WAVEFORM_RESULTS_VERSION = 'aaw.waveform-results.v1' as const;
export const WAVEFORM_RESULTS_LIMITS = Object.freeze({ rawFileBytes: 4 * 1024 * 1024, convertedBytes: 2 * 1024 * 1024, transportBytes: 4 * 1024 * 1024, manifestBytes: 4096, toolResultBytes: 12288, requestBytes: 8192, traces: 256, totalPoints: 16384, pagePoints: 128, listEntries: 24, cursors: 128, timeoutMs: 15000 });
export const WAVEFORM_CONVERTER = Object.freeze({ method: 'cadence_psf_ascii', executablePath: '/opt/eda/cadence/IC251ISR4/tools.lnx86/dfII/bin/64bit/psf', executableSha256: '51fa49791e6e896c30ccb4e237d0966a3762051dad8b115bd7af08419dbd0635', precision: '%.17g' } as const);
export type WaveformResultsCode = WslResultsCode | 'UNSUPPORTED_FORMAT' | 'UNSUPPORTED_ANALYSIS' | 'UNSUPPORTED_UNIT' | 'UNSUPPORTED_WAVEFORM' | 'TRACE_UNAVAILABLE' | 'AXIS_MISMATCH' | 'CONVERTER_UNAVAILABLE' | 'METRIC_INPUT_INVALID';
export type WaveformSourceFile = Readonly<{ relativePath: string; fileIdentity: string; version: string; bytes: number; rawSha256: string }>;
export type WaveformSource = Readonly<{ binding: WslResultsBinding; readerVersion: typeof WAVEFORM_RESULTS_VERSION; format: 'psfbin-1.1'; analysis: 'ac'; sourceVersion: string; files: readonly WaveformSourceFile[]; converter: typeof WAVEFORM_CONVERTER }>;
export type WaveformTrace = Readonly<{ traceId: string; signalName: string; unit: 'V' | 'A'; sampleType: 'complex'; frequencyUnit: 'Hz'; totalPoints: number }>;
export type WaveformPoint = Readonly<{ frequencyHz: number; real: number; imag: number }>;
export type WaveformVoltageSelection = Readonly<{ positiveTraceId: string; negativeTraceId: string | null }>;
export type WaveformResultsToolArguments = {
  wsl_waveform_list: Readonly<{ bindingId: string; relativePath: string; analysis: 'ac'; nameQuery: string; cursor: string | null }>;
  wsl_waveform_read: Readonly<{ bindingId: string; traceId: string; sourceVersion: string; startPoint: number; maxPoints: number }>;
  wsl_waveform_metrics: Readonly<{ bindingId: string; sourceVersion: string; numerator: WaveformVoltageSelection; denominator: WaveformVoltageSelection }>;
};
export type WaveformResultsToolName = keyof WaveformResultsToolArguments;
export type WaveformListValue = Readonly<{ kind: 'wsl_waveform_list'; source: WaveformSource; relativePath: string; nameQuery: string; traces: readonly WaveformTrace[]; nextCursor: string | null; complete: boolean; physicalReadBytes: number; scannedCandidates: number }>;
export type WaveformReadValue = Readonly<{ kind: 'wsl_waveform_read'; source: WaveformSource; trace: WaveformTrace; startPoint: number; endPoint: number; points: readonly WaveformPoint[]; nextPoint: number | null; complete: boolean; citationId: string; excerptSha256: string; physicalReadBytes: number; scannedCandidates: number }>;
export type WaveformMetricsValue = Readonly<{ kind: 'wsl_waveform_metrics'; source: WaveformSource; numerator: WaveformVoltageSelection; denominator: WaveformVoltageSelection; traces: readonly WaveformTrace[]; metrics: AcMetricsResult; citationId: string; excerptSha256: string; physicalReadBytes: number; scannedCandidates: number }>;
export type WaveformResultsToolValue = WaveformListValue | WaveformReadValue | WaveformMetricsValue;

const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const size = (v: string): number => new TextEncoder().encode(v).length;
const str = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && (empty || v.length > 0) && size(v) <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(v) && !/[\ud800-\udfff]/u.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''));
const int = (v: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): v is number => Number.isSafeInteger(v) && !Object.is(v, -0) && (v as number) >= min && (v as number) <= max;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^wave-[a-z0-9-]{1,100}$/u.test(v);
const bindingId = (v: unknown): v is string => typeof v === 'string' && /^wsl-[a-z0-9-]{1,100}$/u.test(v);
const statVersion = (v: unknown): v is string => typeof v === 'string' && /^\d+:\d+:\d+:\d+:\d+$/u.test(v);
const nullable = (v: unknown, test: (x: unknown) => boolean): boolean => v === null || test(v);
const member = (v: unknown, values: readonly string[]): boolean => typeof v === 'string' && values.includes(v);
const signalName = (v: unknown): v is string => str(v, 256) && v.trim() === v;
const voltageSelection = (v: unknown): v is WaveformVoltageSelection => rec(v) && exact(v, ['positiveTraceId', 'negativeTraceId']) && id(v.positiveTraceId) && nullable(v.negativeTraceId, id) && v.positiveTraceId !== v.negativeTraceId;
const frozen = <T>(v: T): T => { if (v && typeof v === 'object') { for (const child of Object.values(v)) frozen(child); Object.freeze(v); } return v; };
function plainJson(v: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 30) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object' || !v || seen.has(v) || Object.getOwnPropertySymbols(v).length || (Array.isArray(v) ? Object.getPrototypeOf(v) !== Array.prototype : Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) return false;
  seen.add(v);
  const descriptors = Object.getOwnPropertyDescriptors(v);
  for (const [name, d] of Object.entries(descriptors)) { if (Array.isArray(v) && name === 'length') continue; if (!Object.hasOwn(d, 'value') || !d.enumerable || !plainJson(d.value, seen, depth + 1)) return false; }
  if (Array.isArray(v) && Object.keys(v).length !== v.length) return false;
  seen.delete(v); return true;
}
function detached(v: unknown, max: number): unknown { try { if (!plainJson(v)) return null; const json = JSON.stringify(v); return size(json) <= max ? JSON.parse(json) : null; } catch { return null; } }
const pathAc = (v: unknown): v is string => isWslResultsRelativePath(v) && v.endsWith('.ac');

export const isWaveformResultsToolName = (v: unknown): v is WaveformResultsToolName => member(v, ['wsl_waveform_list', 'wsl_waveform_read', 'wsl_waveform_metrics']);
export function parseWaveformResultsToolArguments<K extends WaveformResultsToolName>(name: K, input: unknown): WaveformResultsToolArguments[K] | null {
  if (rec(input) && name === 'wsl_waveform_read' && (Object.is(Object.getOwnPropertyDescriptor(input, 'startPoint')?.value, -0) || Object.is(Object.getOwnPropertyDescriptor(input, 'maxPoints')?.value, -0))) return null;
  const v = detached(input, WAVEFORM_RESULTS_LIMITS.requestBytes); if (!rec(v) || !bindingId(v.bindingId)) return null;
  if (name === 'wsl_waveform_list' && exact(v, ['bindingId', 'relativePath', 'analysis', 'nameQuery', 'cursor']) && pathAc(v.relativePath) && v.analysis === 'ac' && str(v.nameQuery, 128, true) && nullable(v.cursor, id)) return frozen(v) as WaveformResultsToolArguments[K];
  if (name === 'wsl_waveform_read' && exact(v, ['bindingId', 'traceId', 'sourceVersion', 'startPoint', 'maxPoints']) && id(v.traceId) && hex(v.sourceVersion) && int(v.startPoint, WAVEFORM_RESULTS_LIMITS.totalPoints - 1) && int(v.maxPoints, WAVEFORM_RESULTS_LIMITS.pagePoints, 1)) return frozen(v) as WaveformResultsToolArguments[K];
  if (name === 'wsl_waveform_metrics' && exact(v, ['bindingId', 'sourceVersion', 'numerator', 'denominator']) && hex(v.sourceVersion) && voltageSelection(v.numerator) && voltageSelection(v.denominator)) return frozen(v) as WaveformResultsToolArguments[K];
  return null;
}
function sourceShape(v: unknown): v is WaveformSource {
  if (!rec(v) || !exact(v, ['binding', 'readerVersion', 'format', 'analysis', 'sourceVersion', 'files', 'converter']) || !parseWslResultsBinding(v.binding) || v.readerVersion !== WAVEFORM_RESULTS_VERSION || v.format !== 'psfbin-1.1' || v.analysis !== 'ac' || !hex(v.sourceVersion) || !Array.isArray(v.files) || v.files.length !== 1 || !rec(v.converter)) return false;
  const converter = v.converter;
  if (!exact(converter, Object.keys(WAVEFORM_CONVERTER)) || Object.entries(WAVEFORM_CONVERTER).some(([k, x]) => converter[k] !== x)) return false;
  const seen = new Set<string>();
  for (const f of v.files) {
    if (!rec(f) || !exact(f, ['relativePath', 'fileIdentity', 'version', 'bytes', 'rawSha256']) || !pathAc(f.relativePath) || typeof f.fileIdentity !== 'string' || !/^\d+:\d+$/u.test(f.fileIdentity) || !statVersion(f.version) || !f.version.startsWith(f.fileIdentity + ':') || !int(f.bytes, WAVEFORM_RESULTS_LIMITS.rawFileBytes, 1) || Number(f.version.split(':')[2]) !== f.bytes || !hex(f.rawSha256) || seen.has(f.relativePath)) return false;
    seen.add(f.relativePath);
  }
  return size(JSON.stringify(v)) <= WAVEFORM_RESULTS_LIMITS.manifestBytes;
}
export function parseWaveformSource(input: unknown): WaveformSource | null { const v = detached(input, WAVEFORM_RESULTS_LIMITS.manifestBytes); return sourceShape(v) ? frozen(v) : null; }
/** UTF-8 SHA256 is computed in main; lexicographic object-key ordering is independent of caller insertion order. */
function canonical(v: unknown): string { if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'; if (rec(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'; return JSON.stringify(v); }
export function waveformSourceFingerprintPayload(source: Omit<WaveformSource, 'sourceVersion'> | WaveformSource): string { return canonical({ binding: source.binding, readerVersion: source.readerVersion, format: source.format, analysis: source.analysis, files: source.files, converter: source.converter }); }
export function waveformExcerptPayload(value: WaveformReadValue | WaveformMetricsValue): string {
  return value.kind === 'wsl_waveform_read'
    ? canonical({ kind: value.kind, sourceVersion: value.source.sourceVersion, trace: value.trace, startPoint: value.startPoint, endPoint: value.endPoint, points: value.points, nextPoint: value.nextPoint, complete: value.complete })
    : canonical({ kind: value.kind, sourceVersion: value.source.sourceVersion, numerator: value.numerator, denominator: value.denominator, traces: value.traces, metrics: value.metrics });
}
function trace(v: unknown): v is WaveformTrace { return rec(v) && exact(v, ['traceId', 'signalName', 'unit', 'sampleType', 'frequencyUnit', 'totalPoints']) && id(v.traceId) && signalName(v.signalName) && member(v.unit, ['V', 'A']) && v.sampleType === 'complex' && v.frequencyUnit === 'Hz' && int(v.totalPoints, WAVEFORM_RESULTS_LIMITS.totalPoints, 1); }
function point(v: unknown): v is WaveformPoint { return rec(v) && exact(v, ['frequencyHz', 'real', 'imag']) && positive(v.frequencyHz) && finite(v.real) && finite(v.imag); }
function voltagePort(v: unknown): boolean { return rec(v) && exact(v, ['positiveSignal', 'negativeSignal', 'unit']) && signalName(v.positiveSignal) && signalName(v.negativeSignal) && v.positiveSignal !== v.negativeSignal && v.unit === 'V'; }
function derived(v: unknown, count: number): boolean { return rec(v) && exact(v, ['index', 'frequencyHz', 'gainDb', 'phaseWrappedDeg', 'phaseUnwrappedDeg']) && int(v.index, count - 1) && positive(v.frequencyHz) && finite(v.gainDb) && finite(v.phaseWrappedDeg) && v.phaseWrappedDeg >= -180 && v.phaseWrappedDeg < 180 && finite(v.phaseUnwrappedDeg); }
function thresholdEvent(v: unknown, count: number): boolean {
  if (!rec(v) || !exact(v, ['kind', 'direction', 'frequencyHz', 'phaseUnwrappedDeg', 'screening180PlusPhaseDeg', 'bracket']) || !member(v.kind, ['interpolated_crossing', 'sample_crossing', 'boundary_contact', 'tangent_contact', 'threshold_plateau']) || !member(v.direction, ['rising', 'falling', 'indeterminate']) || !nullable(v.frequencyHz, positive) || !nullable(v.phaseUnwrappedDeg, finite) || !nullable(v.screening180PlusPhaseDeg, finite) || !rec(v.bracket)) return false;
  const b = v.bracket; if (!exact(b, ['lower', 'upper', 'fraction', 'method']) || !derived(b.lower, count) || !derived(b.upper, count) || !nullable(b.fraction, x => finite(x) && x >= 0 && x <= 1) || !member(b.method, ['linear_db_and_unwrapped_phase_in_log10_hz', 'exact_sample', 'threshold_interval'])) return false;
  const lower = b.lower as AcDerivedPoint, upper = b.upper as AcDerivedPoint;
  if (lower.index > upper.index || lower.frequencyHz > upper.frequencyHz) return false;
  if (v.kind === 'threshold_plateau') return b.method === 'threshold_interval' && lower.index < upper.index && lower.frequencyHz < upper.frequencyHz && b.fraction === null && v.frequencyHz === null && v.phaseUnwrappedDeg === null && v.screening180PlusPhaseDeg === null;
  if (!positive(v.frequencyHz) || !finite(v.phaseUnwrappedDeg) || !finite(v.screening180PlusPhaseDeg) || v.frequencyHz < lower.frequencyHz || v.frequencyHz > upper.frequencyHz || v.screening180PlusPhaseDeg !== 180 + v.phaseUnwrappedDeg || !finite(b.fraction)) return false;
  if (v.kind === 'interpolated_crossing') return b.method === 'linear_db_and_unwrapped_phase_in_log10_hz' && upper.index === lower.index + 1 && lower.frequencyHz < upper.frequencyHz && b.fraction > 0 && b.fraction < 1;
  return b.method === 'exact_sample' && canonical(lower) === canonical(upper) && b.fraction === 0 && v.frequencyHz === lower.frequencyHz && v.phaseUnwrappedDeg === lower.phaseUnwrappedDeg;
}
function crossingSummary(v: unknown, count: number): boolean { return rec(v) && exact(v, ['status', 'targetGainDb', 'crossings', 'contacts']) && member(v.status, ['insufficient_samples', 'no_crossing', 'single_crossing', 'multiple_crossings', 'indeterminate_contact']) && finite(v.targetGainDb) && Array.isArray(v.crossings) && Array.isArray(v.contacts) && v.crossings.every(x => thresholdEvent(x, count)) && v.contacts.every(x => thresholdEvent(x, count)); }
export function isAcMetricsResult(v: unknown): v is AcMetricsResult {
  if (!rec(v) || v.algorithmVersion !== AC_METRICS_ALGORITHM_VERSION) return false;
  if (v.status === 'invalid_input') return exact(v, ['algorithmVersion', 'status', 'issue']) && rec(v.issue) && exact(v.issue, ['code', 'field', 'sampleIndex']) && member(v.issue.code, ['invalid_shape', 'unsupported_analysis', 'invalid_unit', 'invalid_port', 'sample_limit', 'invalid_frequency', 'frequency_not_increasing', 'invalid_complex', 'zero_denominator', 'zero_numerator', 'numeric_range']) && str(v.issue.field, 128) && nullable(v.issue.sampleIndex, x => int(x, AC_METRICS_MAX_SAMPLES));
  if (!member(v.status, ['ok', 'insufficient_samples']) || !exact(v, ['algorithmVersion', 'status', 'definition', 'sampleCount', 'frequencyRangeHz', 'firstFrequencyPoint', 'lastFrequencyPoint', 'gainTrend', 'phaseUnwrap', 'bandwidth', 'unityGain']) || !int(v.sampleCount, AC_METRICS_MAX_SAMPLES) || !rec(v.definition) || !rec(v.phaseUnwrap) || !rec(v.bandwidth)) return false;
  const d = v.definition, p = v.phaseUnwrap, b = v.bandwidth, n = v.sampleCount;
  if (!exact(d, ['analysis', 'frequencyUnit', 'gainUnit', 'phaseUnit', 'transfer', 'numerator', 'denominator', 'phaseInterpretation']) || d.analysis !== 'ac' || d.frequencyUnit !== 'Hz' || d.gainUnit !== 'dB' || d.phaseUnit !== 'deg' || d.transfer !== 'numerator_voltage_difference_over_denominator_voltage_difference' || !voltagePort(d.numerator) || !voltagePort(d.denominator) || d.phaseInterpretation !== 'ac_screening_only_not_stb_or_stability_proof') return false;
  if (!nullable(v.frequencyRangeHz, x => rec(x) && exact(x, ['first', 'last']) && positive(x.first) && positive(x.last) && x.first <= x.last) || !nullable(v.firstFrequencyPoint, x => derived(x, n)) || !nullable(v.lastFrequencyPoint, x => derived(x, n)) || !member(v.gainTrend, ['insufficient_samples', 'non_increasing', 'has_rising_steps'])) return false;
  if (!exact(p, ['method', 'exact180StepIndices', 'samplingCaveat']) || p.method !== 'first_principal_phase_then_shortest_steps_in_minus180_to_180' || p.samplingCaveat !== 'phase_turns_between_samples_cannot_be_recovered' || !Array.isArray(p.exact180StepIndices) || !p.exact180StepIndices.every(i => int(i, n - 1, 1))) return false;
  return exact(b, ['definition', 'referenceGainDb', 'targetGainDb', 'status', 'firstFallingCrossing', 'threshold']) && b.definition === 'first_falling_crossing_3db_below_first_frequency_gain' && nullable(b.referenceGainDb, finite) && nullable(b.targetGainDb, finite) && member(b.status, ['insufficient_samples', 'not_found_in_sweep', 'found', 'multiple_falling_crossings', 'indeterminate_contact']) && nullable(b.firstFallingCrossing, x => thresholdEvent(x, n)) && nullable(b.threshold, x => crossingSummary(x, n)) && crossingSummary(v.unityGain, n);
}
export function parseWaveformResultsToolValue(input: unknown): WaveformResultsToolValue | null {
  const v = detached(input, WAVEFORM_RESULTS_LIMITS.toolResultBytes);
  if (!rec(v) || !sourceShape(v.source) || !int(v.physicalReadBytes, WAVEFORM_RESULTS_LIMITS.rawFileBytes * 4) || !int(v.scannedCandidates, WAVEFORM_RESULTS_LIMITS.traces)) return null;
  if (v.kind === 'wsl_waveform_list') {
    if (!exact(v, ['kind', 'source', 'relativePath', 'nameQuery', 'traces', 'nextCursor', 'complete', 'physicalReadBytes', 'scannedCandidates']) || !pathAc(v.relativePath) || v.source.files[0]!.relativePath !== v.relativePath || !str(v.nameQuery, 128, true) || !Array.isArray(v.traces) || v.traces.length > WAVEFORM_RESULTS_LIMITS.listEntries || !v.traces.every(trace) || !nullable(v.nextCursor, id) || v.complete !== (v.nextCursor === null)) return null;
    const names = v.traces.map(t => t.signalName); if (new Set(names).size !== names.length || names.some(n => !n.includes(v.nameQuery as string))) return null;
    return frozen(v) as WaveformListValue;
  }
  if (v.kind === 'wsl_waveform_read') {
    if (!exact(v, ['kind', 'source', 'trace', 'startPoint', 'endPoint', 'points', 'nextPoint', 'complete', 'citationId', 'excerptSha256', 'physicalReadBytes', 'scannedCandidates']) || !trace(v.trace) || !int(v.startPoint, v.trace.totalPoints - 1) || !int(v.endPoint, v.trace.totalPoints - 1, v.startPoint) || !Array.isArray(v.points) || v.points.length < 1 || v.points.length > WAVEFORM_RESULTS_LIMITS.pagePoints || v.points.length !== v.endPoint - v.startPoint + 1 || !v.points.every(point) || !id(v.citationId) || !hex(v.excerptSha256) || v.complete !== (v.nextPoint === null)) return null;
    if (v.complete ? v.endPoint !== v.trace.totalPoints - 1 : v.nextPoint !== v.endPoint + 1) return null;
    if (v.points.some((p, i) => i > 0 && p.frequencyHz <= (v.points as WaveformPoint[])[i - 1]!.frequencyHz)) return null;
    return frozen(v) as WaveformReadValue;
  }
  if (v.kind === 'wsl_waveform_metrics') {
    if (!exact(v, ['kind', 'source', 'numerator', 'denominator', 'traces', 'metrics', 'citationId', 'excerptSha256', 'physicalReadBytes', 'scannedCandidates']) || !voltageSelection(v.numerator) || !voltageSelection(v.denominator) || !Array.isArray(v.traces) || v.traces.length < 1 || v.traces.length > 4 || !v.traces.every(trace) || v.traces.some(t => t.unit !== 'V') || !isAcMetricsResult(v.metrics) || !id(v.citationId) || !hex(v.excerptSha256)) return null;
    const selected = new Set([v.numerator.positiveTraceId, v.numerator.negativeTraceId, v.denominator.positiveTraceId, v.denominator.negativeTraceId].filter(x => x !== null));
    if (v.traces.length !== selected.size || new Set(v.traces.map(t => t.traceId)).size !== selected.size || v.traces.some(t => !selected.has(t.traceId))) return null;
    const count = v.traces[0]!.totalPoints;
    if (v.traces.some(t => t.totalPoints !== count)) return null;
    if (v.metrics.status !== 'invalid_input') {
      const metrics = v.metrics;
      if (metrics.sampleCount !== count || (metrics.status === 'insufficient_samples') !== (count < 2) || !metrics.firstFrequencyPoint || !metrics.lastFrequencyPoint || !metrics.frequencyRangeHz || metrics.firstFrequencyPoint.index !== 0 || metrics.lastFrequencyPoint.index !== count - 1 || metrics.frequencyRangeHz.first !== metrics.firstFrequencyPoint.frequencyHz || metrics.frequencyRangeHz.last !== metrics.lastFrequencyPoint.frequencyHz) return null;
      const byId = new Map(v.traces.map(t => [t.traceId, t]));
      for (const key of ['numerator', 'denominator'] as const) { const selection = v[key] as WaveformVoltageSelection, port = metrics.definition[key]; if (port.positiveSignal !== byId.get(selection.positiveTraceId)!.signalName || port.negativeSignal !== (selection.negativeTraceId === null ? '0' : byId.get(selection.negativeTraceId)!.signalName)) return null; }
    }
    return frozen(v) as WaveformMetricsValue;
  }
  return null;
}
const obj = (properties: object) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const stringId = { type: 'string', minLength: 1, maxLength: 128 };
const hashId = { type: 'string', minLength: 64, maxLength: 64 };
const nullableId = { anyOf: [stringId, { type: 'null' }] };
const voltage = obj({ positiveTraceId: stringId, negativeTraceId: nullableId });
export const WAVEFORM_RESULTS_TOOLS = Object.freeze([
  { type: 'function', function: { name: 'wsl_waveform_list', description: 'Inspect supported binary AC signals in an exact result file already listed by wsl_results_list. Copy relativePath and bindingId; analysis is ac. Begin nameQuery="" and cursor=null, then preserve arguments for nextCursor. Returns issued trace IDs, original complex units and sourceVersion. Only the fixed verified Cadence reader is used; unknown formats and non-AC data are unsupported. No simulation is run.', parameters: obj({ bindingId: stringId, relativePath: { type: 'string', minLength: 1, maxLength: 1024 }, analysis: { const: 'ac', type: 'string' }, nameQuery: { type: 'string', maxLength: 128 }, cursor: nullableId }) } },
  { type: 'function', function: { name: 'wsl_waveform_read', description: 'Read a page of original complex AC samples using an issued traceId and exact sourceVersion. startPoint is zero-based; start at 0 and follow nextPoint. complete describes coverage only from the requested start. Units and original PSF identity/hash remain attached. Cite citationId and the exact point range; this is historical data, not a new simulation.', parameters: obj({ bindingId: stringId, traceId: stringId, sourceVersion: hashId, startPoint: { type: 'integer', minimum: 0, maximum: WAVEFORM_RESULTS_LIMITS.totalPoints - 1 }, maxPoints: { type: 'integer', minimum: 1, maximum: WAVEFORM_RESULTS_LIMITS.pagePoints } }) } },
  { type: 'function', function: { name: 'wsl_waveform_metrics', description: 'Compute deterministic AC V/V gain metrics from complete same-source traces. Explicitly select numerator positive-minus-negative and denominator positive-minus-negative; a null negativeTraceId means reference ground. All non-null IDs must be issued voltage traces with the same Hz axis and sourceVersion. No expression, guessed unit input, interpolation beyond the sweep or partial trace is accepted. AC 180+phase is a screening quantity, not STB or stability proof. Cite the returned calculation citationId.', parameters: obj({ bindingId: stringId, sourceVersion: hashId, numerator: voltage, denominator: voltage }) } },
]);
