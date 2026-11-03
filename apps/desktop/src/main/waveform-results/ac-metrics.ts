/** Pure arithmetic only. Source identity, trace ownership and exact axis joins belong to the reader. */
import { AC_METRICS_ALGORITHM_VERSION, AC_METRICS_MAX_SAMPLES,
  type AcComplex, type AcTransferInput, type AcMetricIssue, type AcDerivedPoint, type AcThresholdEvent,
  type AcCrossingSummary, type AcMetricsResult, type AcTransferDerivation } from '../../shared/agent/waveform-results';
export { AC_METRICS_ALGORITHM_VERSION, AC_METRICS_MAX_SAMPLES } from '../../shared/agent/waveform-results';
export type { AcComplex, AcVoltagePort, AcTransferSample, AcTransferInput, AcMetricIssue, AcDerivedPoint,
  AcThresholdEvent, AcCrossingSummary, AcMetricsComputed, AcMetricsResult, AcTransferDerivation } from '../../shared/agent/waveform-results';

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const issue = (code: AcMetricIssue['code'], field: string, sampleIndex: number | null = null): AcMetricIssue => ({ code, field, sampleIndex });
const signalName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && v === v.trim() && !/[\u0000-\u001f\u007f]/u.test(v);
function validate(input: unknown): AcMetricIssue | null {
  if (!record(input) || !Array.isArray(input.samples)) return issue('invalid_shape', 'input');
  if (input.analysis !== 'ac') return issue('unsupported_analysis', 'analysis');
  if (input.frequencyUnit !== 'Hz') return issue('invalid_unit', 'frequencyUnit');
  for (const field of ['numerator', 'denominator'] as const) {
    const port = input[field];
    if (!record(port) || !signalName(port.positiveSignal) || !signalName(port.negativeSignal) || port.positiveSignal === port.negativeSignal) return issue('invalid_port', field);
    if (port.unit !== 'V') return issue('invalid_unit', field + '.unit');
  }
  if (input.samples.length > AC_METRICS_MAX_SAMPLES) return issue('sample_limit', 'samples');
  let previous = 0;
  for (let i = 0; i < input.samples.length; i++) {
    const sample: unknown = input.samples[i];
    if (!record(sample)) return issue('invalid_shape', 'samples', i);
    if (!finite(sample.frequencyHz) || sample.frequencyHz <= 0) return issue('invalid_frequency', 'frequencyHz', i);
    if (sample.frequencyHz <= previous) return issue('frequency_not_increasing', 'frequencyHz', i);
    previous = sample.frequencyHz;
    for (const field of ['numerator', 'denominator'] as const) {
      const z = sample[field];
      if (!record(z) || !finite(z.real) || !finite(z.imag)) return issue('invalid_complex', field, i);
      if (z.real === 0 && z.imag === 0) return issue(field === 'denominator' ? 'zero_denominator' : 'zero_numerator', field, i);
    }
  }
  return null;
}

/** log10(abs(z)) with scaling avoids overflow of x*x + y*y and of the voltage ratio. */
function logMagnitude(z: AcComplex): number {
  const scale = Math.max(Math.abs(z.real), Math.abs(z.imag));
  return Math.log10(scale) + Math.log10(Math.hypot(z.real / scale, z.imag / scale));
}
/** Deterministic principal convention: [-180, 180), including +180 -> -180. */
function principal(degrees: number): number {
  const phase = ((degrees + 180) % 360 + 360) % 360 - 180;
  return Object.is(phase, -0) ? 0 : phase;
}
function deriveValidated(input: AcTransferInput): AcTransferDerivation {
  const points: AcDerivedPoint[] = [];
  const exact180StepIndices: number[] = [];
  for (let i = 0; i < input.samples.length; i++) {
    const sample = input.samples[i]!;
    const gainDb = 20 * (logMagnitude(sample.numerator) - logMagnitude(sample.denominator));
    const phaseWrappedDeg = principal((Math.atan2(sample.numerator.imag, sample.numerator.real) - Math.atan2(sample.denominator.imag, sample.denominator.real)) * 180 / Math.PI);
    const previous = points.at(-1);
    const step = previous ? principal(phaseWrappedDeg - previous.phaseWrappedDeg) : 0;
    if (previous && Math.abs(step) === 180) exact180StepIndices.push(i);
    const phaseUnwrappedDeg = previous ? previous.phaseUnwrappedDeg + step : phaseWrappedDeg;
    if (![gainDb, phaseWrappedDeg, phaseUnwrappedDeg].every(Number.isFinite)) return { status: 'invalid_input', issue: issue('numeric_range', 'transfer', i) };
    points.push({ index: i, frequencyHz: sample.frequencyHz, gainDb, phaseWrappedDeg, phaseUnwrappedDeg });
  }
  return { status: 'ok', points, exact180StepIndices };
}
/** Separate full derived series for callers needing waveform display; metrics below stays compact. */
export function deriveAcTransfer(input: AcTransferInput): AcTransferDerivation {
  const invalid = validate(input);
  return invalid ? { status: 'invalid_input', issue: invalid } : deriveValidated(input);
}

function thresholdSummary(points: readonly AcDerivedPoint[], targetGainDb: number): AcCrossingSummary {
  const crossings: AcThresholdEvent[] = [];
  const contacts: AcThresholdEvent[] = [];
  if (points.length < 2) return { status: 'insufficient_samples', targetGainDb, crossings, contacts };
  for (let i = 0; i < points.length; i++) {
    const lower = points[i]!;
    if (lower.gainDb === targetGainDb) {
      let end = i;
      while (points[end + 1]?.gainDb === targetGainDb) end++;
      const upper = points[end]!;
      const before = points[i - 1];
      const after = points[end + 1];
      const direction = before && after && (before.gainDb < targetGainDb) !== (after.gainDb < targetGainDb)
        ? (before.gainDb > after.gainDb ? 'falling' : 'rising') : 'indeterminate';
      const kind = end > i ? 'threshold_plateau' : !before || !after ? 'boundary_contact' : direction === 'indeterminate' ? 'tangent_contact' : 'sample_crossing';
      const single = end === i;
      const event: AcThresholdEvent = {
        kind, direction, frequencyHz: single ? lower.frequencyHz : null,
        phaseUnwrappedDeg: single ? lower.phaseUnwrappedDeg : null,
        screening180PlusPhaseDeg: single ? 180 + lower.phaseUnwrappedDeg : null,
        bracket: { lower, upper, fraction: single ? 0 : null, method: single ? 'exact_sample' : 'threshold_interval' },
      };
      (kind === 'sample_crossing' ? crossings : contacts).push(event);
      i = end;
      continue;
    }
    const upper = points[i + 1];
    if (!upper || upper.gainDb === targetGainDb || (lower.gainDb < targetGainDb) === (upper.gainDb < targetGainDb)) continue;
    const fraction = (targetGainDb - lower.gainDb) / (upper.gainDb - lower.gainDb);
    const logLower = Math.log10(lower.frequencyHz);
    const frequencyHz = Math.min(upper.frequencyHz, Math.max(lower.frequencyHz, 10 ** (logLower + fraction * (Math.log10(upper.frequencyHz) - logLower))));
    const phaseUnwrappedDeg = lower.phaseUnwrappedDeg + fraction * (upper.phaseUnwrappedDeg - lower.phaseUnwrappedDeg);
    crossings.push({ kind: 'interpolated_crossing', direction: lower.gainDb > upper.gainDb ? 'falling' : 'rising', frequencyHz, phaseUnwrappedDeg,
      screening180PlusPhaseDeg: 180 + phaseUnwrappedDeg,
      bracket: { lower, upper, fraction, method: 'linear_db_and_unwrapped_phase_in_log10_hz' } });
  }
  return { status: contacts.length ? 'indeterminate_contact' : crossings.length === 0 ? 'no_crossing' : crossings.length === 1 ? 'single_crossing' : 'multiple_crossings', targetGainDb, crossings, contacts };
}

export function calculateAcMetrics(input: AcTransferInput): AcMetricsResult {
  const derived = deriveAcTransfer(input);
  if (derived.status === 'invalid_input') return { algorithmVersion: AC_METRICS_ALGORITHM_VERSION, ...derived };
  const { points, exact180StepIndices } = derived;
  const first = points[0] ?? null;
  const last = points.at(-1) ?? null;
  const threshold = first ? thresholdSummary(points, first.gainDb - 3) : null;
  const falling = threshold?.crossings.filter(c => c.direction === 'falling') ?? [];
  // An earlier falling plateau can hide the first bandwidth; do not skip it for a later crossing.
  const ambiguousEarlierContact = threshold?.contacts.some(c => c.bracket.lower.index <= (falling[0]?.bracket.lower.index ?? Infinity)) ?? false;
  const bandwidthStatus = points.length < 2 ? 'insufficient_samples' : ambiguousEarlierContact ? 'indeterminate_contact'
    : falling.length > 1 ? 'multiple_falling_crossings' : falling.length === 1 ? 'found' : 'not_found_in_sweep';
  return {
    algorithmVersion: AC_METRICS_ALGORITHM_VERSION, status: points.length < 2 ? 'insufficient_samples' : 'ok',
    definition: { analysis: 'ac', frequencyUnit: 'Hz', gainUnit: 'dB', phaseUnit: 'deg', transfer: 'numerator_voltage_difference_over_denominator_voltage_difference',
      numerator: { ...input.numerator }, denominator: { ...input.denominator }, phaseInterpretation: 'ac_screening_only_not_stb_or_stability_proof' },
    sampleCount: points.length, frequencyRangeHz: first && last ? { first: first.frequencyHz, last: last.frequencyHz } : null,
    firstFrequencyPoint: first, lastFrequencyPoint: last,
    gainTrend: points.length < 2 ? 'insufficient_samples' : points.some((p, i) => i > 0 && p.gainDb > points[i - 1]!.gainDb) ? 'has_rising_steps' : 'non_increasing',
    phaseUnwrap: { method: 'first_principal_phase_then_shortest_steps_in_minus180_to_180', exact180StepIndices, samplingCaveat: 'phase_turns_between_samples_cannot_be_recovered' },
    bandwidth: { definition: 'first_falling_crossing_3db_below_first_frequency_gain', referenceGainDb: first?.gainDb ?? null, targetGainDb: threshold?.targetGainDb ?? null,
      status: bandwidthStatus, firstFallingCrossing: ambiguousEarlierContact ? null : falling[0] ?? null, threshold },
    unityGain: thresholdSummary(points, 0),
  };
}
