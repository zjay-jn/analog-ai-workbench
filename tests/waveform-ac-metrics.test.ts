import test from 'node:test';
import assert from 'node:assert/strict';
import { AC_METRICS_ALGORITHM_VERSION, AC_METRICS_MAX_SAMPLES, calculateAcMetrics, deriveAcTransfer,
  type AcComplex, type AcMetricsComputed, type AcTransferInput, type AcTransferSample } from '../apps/desktop/src/main/waveform-results/ac-metrics';

const polar = (magnitude: number, phaseDeg: number): AcComplex => ({ real: magnitude * Math.cos(phaseDeg * Math.PI / 180), imag: magnitude * Math.sin(phaseDeg * Math.PI / 180) });
const input = (samples: readonly AcTransferSample[]): AcTransferInput => ({ analysis: 'ac', frequencyUnit: 'Hz',
  numerator: { positiveSignal: '/VOUT', negativeSignal: '0', unit: 'V' }, denominator: { positiveSignal: '/VIP', negativeSignal: '/VIN', unit: 'V' }, samples });
const point = (frequencyHz: number, magnitude: number, phase = 0): AcTransferSample => ({ frequencyHz, numerator: polar(magnitude, phase), denominator: { real: 1, imag: 0 } });
function computed(source: AcTransferInput): AcMetricsComputed {
  const result = calculateAcMetrics(source);
  if (result.status === 'invalid_input') assert.fail(JSON.stringify(result));
  return result;
}
function close(actual: number | null | undefined, expected: number, tolerance = 1e-10): void {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual! - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}
function rejected(candidate: unknown, code: string, sampleIndex: number | null = null): void {
  const result = calculateAcMetrics(candidate as AcTransferInput);
  assert.equal(result.status, 'invalid_input');
  if (result.status === 'invalid_input') { assert.equal(result.issue.code, code); assert.equal(result.issue.sampleIndex, sampleIndex); }
}

test('raw complex numerator divided by raw complex differential denominator keeps sign, phase and port identity', () => {
  // (40 - j30) / (3 + j4) = -j10, independently hand-derived.
  const source = input([1, 10].map(frequencyHz => ({ frequencyHz, numerator: { real: 40, imag: -30 }, denominator: { real: 3, imag: 4 } })));
  const before = JSON.stringify(source);
  const result = computed(source);
  close(result.firstFrequencyPoint?.gainDb, 20); close(result.firstFrequencyPoint?.phaseWrappedDeg, -90);
  assert.equal(result.algorithmVersion, AC_METRICS_ALGORITHM_VERSION);
  assert.deepEqual(result.definition.denominator, source.denominator);
  assert.equal(result.definition.phaseInterpretation, 'ac_screening_only_not_stb_or_stability_proof');
  assert.equal(JSON.stringify(source), before);
  assert.equal(Object.hasOwn(result, 'dcGainDb'), false);
  const reversed = computed(input(source.samples.map(s => ({ ...s, denominator: { real: -s.denominator.real, imag: -s.denominator.imag } }))));
  close(reversed.firstFrequencyPoint?.gainDb, 20); close(reversed.firstFrequencyPoint?.phaseWrappedDeg, 90);
});

test('unity interpolation uses log frequency and the same fraction for continuous phase', () => {
  const result = computed(input([point(10, 10, -80), point(1000, 0.1, -120)]));
  assert.equal(result.unityGain.status, 'single_crossing');
  const crossing = result.unityGain.crossings[0]!;
  close(crossing.frequencyHz, 100); close(crossing.phaseUnwrappedDeg, -100); close(crossing.screening180PlusPhaseDeg, 80);
  assert.equal(crossing.direction, 'falling'); assert.equal(crossing.bracket.method, 'linear_db_and_unwrapped_phase_in_log10_hz');
  assert.equal(crossing.bracket.lower.index, 0); assert.equal(crossing.bracket.upper.index, 1); close(crossing.bracket.fraction, 0.5);
  assert.notEqual(crossing.frequencyHz, 505);
});

test('single-pole bandwidth is relative to the actual first sampled gain and reproducible from brackets', () => {
  const amplitude = 100; const poleHz = 1000;
  const source = input([100, 800, 1200, 80000, 120000].map(frequencyHz => {
    const r = frequencyHz / poleHz;
    return { frequencyHz, numerator: { real: amplitude / (1 + r * r), imag: -amplitude * r / (1 + r * r) }, denominator: { real: 1, imag: 0 } };
  }));
  const result = computed(source);
  close(result.firstFrequencyPoint?.gainDb, 20 * Math.log10(amplitude / Math.sqrt(1.01)));
  assert.notEqual(result.firstFrequencyPoint?.gainDb, 40);
  const target = 20 * Math.log10(amplitude / Math.sqrt(1.01)) - 3;
  close(result.bandwidth.targetGainDb, target);
  assert.equal(result.bandwidth.status, 'found');
  const event = result.bandwidth.firstFallingCrossing!;
  const lowerGain = 20 * Math.log10(amplitude / Math.sqrt(1 + 0.8 ** 2));
  const upperGain = 20 * Math.log10(amplitude / Math.sqrt(1 + 1.2 ** 2));
  const fraction = (target - lowerGain) / (upperGain - lowerGain);
  close(event.frequencyHz, 800 * (1200 / 800) ** fraction);
  assert.equal(event.bracket.lower.frequencyHz, 800); assert.equal(event.bracket.upper.frequencyHz, 1200);
  close(event.bracket.fraction, fraction);
});

test('principal phases unwrap continuously across the -180/180 boundary before crossing interpolation', () => {
  const source = input([point(1, 10, -170), point(10, 1, -190), point(100, 0.1, -210)]);
  const derived = deriveAcTransfer(source); assert.equal(derived.status, 'ok');
  if (derived.status === 'ok') {
    derived.points.forEach((p, i) => close(p.phaseUnwrappedDeg, -170 - 20 * i));
    close(derived.points[1]!.phaseWrappedDeg, 170); assert.deepEqual(derived.exact180StepIndices, []);
  }
  const crossing = computed(source).unityGain.crossings[0]!;
  close(crossing.phaseUnwrappedDeg, -190); close(crossing.screening180PlusPhaseDeg, -10);
});

test('exact 180 degree steps are deterministic and expressly ambiguous', () => {
  const source = input([{ frequencyHz: 1, numerator: { real: 10, imag: 0 }, denominator: { real: 1, imag: 0 } },
    { frequencyHz: 10, numerator: { real: -0.1, imag: 0 }, denominator: { real: 1, imag: 0 } }]);
  const result = computed(source); assert.deepEqual(result.phaseUnwrap.exact180StepIndices, [1]);
  close(result.lastFrequencyPoint?.phaseUnwrappedDeg, -180);
  assert.equal(result.phaseUnwrap.samplingCaveat, 'phase_turns_between_samples_cannot_be_recovered');
});

test('all rising and falling unity crossings are retained and exact samples are not double counted', () => {
  const result = computed(input([10, 1, 0.1, 1, 10, 0.1].map((m, i) => point(10 ** i, m))));
  assert.equal(result.unityGain.status, 'multiple_crossings');
  assert.deepEqual(result.unityGain.crossings.map(c => c.kind), ['sample_crossing', 'sample_crossing', 'interpolated_crossing']);
  assert.deepEqual(result.unityGain.crossings.map(c => c.direction), ['falling', 'rising', 'falling']);
  assert.deepEqual(result.unityGain.crossings.slice(0, 2).map(c => c.frequencyHz), [10, 1000]);
  assert.equal(result.gainTrend, 'has_rising_steps');
  assert.equal(result.bandwidth.status, 'multiple_falling_crossings');
  assert.ok(result.bandwidth.firstFallingCrossing!.frequencyHz! < 10);
});

test('threshold plateau is an interval and tangent/end-of-sweep contact is not a resolved crossing', () => {
  for (const [magnitudes, expectedKind] of [ [[10, 1, 1, 0.1], 'threshold_plateau'], [[10, 1, 10], 'tangent_contact'], [[10, 1], 'boundary_contact'], [[1, 0.1], 'boundary_contact'] ] as const) {
    const summary = computed(input(magnitudes.map((m, i) => point(10 ** i, m)))).unityGain;
    assert.equal(summary.status, 'indeterminate_contact'); assert.equal(summary.crossings.length, 0);
    const contact = summary.contacts[0]!; assert.equal(contact.kind, expectedKind);
    if (expectedKind === 'threshold_plateau') { assert.equal(contact.frequencyHz, null); assert.equal(contact.bracket.fraction, null); assert.equal(contact.bracket.lower.frequencyHz, 10); assert.equal(contact.bracket.upper.frequencyHz, 100); }
  }
});

test('a flat high gain sweep reports no crossing without extrapolating bandwidth or unity frequency', () => {
  const result = computed(input([point(1, 10), point(10, 10), point(100, 10)]));
  assert.equal(result.unityGain.status, 'no_crossing'); assert.equal(result.unityGain.crossings.length, 0);
  assert.equal(result.bandwidth.status, 'not_found_in_sweep'); assert.equal(result.bandwidth.firstFallingCrossing, null);
});

test('zero and one samples report insufficiency; one point may report only first-frequency gain', () => {
  for (const samples of [[], [point(100, 10)]]) {
    const result = computed(input(samples)); assert.equal(result.status, 'insufficient_samples');
    assert.equal(result.unityGain.status, 'insufficient_samples'); assert.equal(result.bandwidth.status, 'insufficient_samples');
    assert.equal(result.bandwidth.firstFallingCrossing, null); assert.equal(result.sampleCount, samples.length);
  }
  assert.equal(computed(input([])).firstFrequencyPoint, null);
  close(computed(input([point(100, 10)])).firstFrequencyPoint?.gainDb, 20);
});

test('unit, analysis, port and shape admission rejects ambiguous raw data', () => {
  const valid = input([point(1, 10), point(10, 0.1)]);
  rejected(null, 'invalid_shape'); rejected({ ...valid, samples: {} }, 'invalid_shape');
  rejected({ ...valid, analysis: 'stb' }, 'unsupported_analysis'); rejected({ ...valid, frequencyUnit: 'kHz' }, 'invalid_unit');
  rejected({ ...valid, numerator: { ...valid.numerator, unit: 'A' } }, 'invalid_unit');
  for (const denominator of [{ ...valid.denominator, negativeSignal: '/VIP' }, { ...valid.denominator, negativeSignal: '' }, { ...valid.denominator, positiveSignal: ' /VIP' }, { ...valid.denominator, positiveSignal: '/VIP\n' }]) rejected({ ...valid, denominator }, 'invalid_port');
  rejected({ ...valid, samples: [null] }, 'invalid_shape', 0);
  rejected({ ...valid, samples: [{ frequencyHz: 1, gainDb: 42, phaseDeg: -20 }] }, 'invalid_complex', 0);
});

test('nonpositive, nonfinite, descending and duplicate frequency axes fail at the offending index', () => {
  for (const f of [0, -1, NaN, Infinity]) rejected(input([point(f, 1)]), 'invalid_frequency', 0);
  for (const f of [1, 0.5]) rejected(input([point(1, 1), point(f, 1)]), 'frequency_not_increasing', 1);
});

test('zero input and zero output fail explicitly without skipping samples or serializing infinities', () => {
  rejected(input([{ ...point(1, 1), denominator: { real: 0, imag: 0 } }]), 'zero_denominator', 0);
  rejected(input([point(1, 0)]), 'zero_numerator', 0);
  rejected(input([{ ...point(1, 1), numerator: { real: NaN, imag: 1 } }]), 'invalid_complex', 0);
  rejected(input([{ ...point(1, 1), denominator: { real: 1, imag: Infinity } }]), 'invalid_complex', 0);
});

test('scaled log magnitude handles finite extreme voltages and subnormal inputs without overflow', () => {
  const result = computed(input([{ frequencyHz: 1, numerator: { real: 1e308, imag: 1e308 }, denominator: { real: 1e308, imag: -1e308 } },
    { frequencyHz: 10, numerator: { real: Number.MIN_VALUE, imag: 0 }, denominator: { real: Number.MIN_VALUE, imag: 0 } }]));
  close(result.firstFrequencyPoint?.gainDb, 0); close(result.firstFrequencyPoint?.phaseUnwrappedDeg, 90);
  close(result.lastFrequencyPoint?.gainDb, 0);
  assert.equal(JSON.stringify(result).includes('Infinity'), false);
  const extremeRatio = computed(input([{ frequencyHz: 1, numerator: { real: 1e308, imag: 0 }, denominator: { real: 1e-308, imag: 0 } }]));
  close(extremeRatio.firstFrequencyPoint?.gainDb, 12320);
});

test('sample count is bounded before per-sample traversal and pure results are deterministic', () => {
  rejected(input(new Array<AcTransferSample>(AC_METRICS_MAX_SAMPLES + 1)), 'sample_limit');
  const source = input([point(1, 10, -10), point(100, 0.1, -200)]);
  assert.deepEqual(calculateAcMetrics(source), calculateAcMetrics(source));
});
