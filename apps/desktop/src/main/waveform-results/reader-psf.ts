import { WAVEFORM_RESULTS_LIMITS as L, type WaveformPoint, type WaveformResultsCode } from '../../shared/agent/waveform-results';

export class WaveformResultsError extends Error { constructor(readonly code: WaveformResultsCode) { super(code); this.name = 'WaveformResultsError'; } }
export type ParsedAcTrace = Readonly<{ signalName: string; unit: 'V' | 'A'; sampleType: 'complex'; points: readonly WaveformPoint[] }>;
export type ParsedAcResult = Readonly<{ analysis: 'ac'; frequencyUnit: 'Hz'; totalPoints: number; traces: readonly ParsedAcTrace[] }>;
type Token = { kind: 'string' | 'word' | 'number' | 'paren'; value: string | number };
const fail = (code: WaveformResultsCode = 'UNSUPPORTED_WAVEFORM'): never => { throw new WaveformResultsError(code); };
/** Exact supported subset of the inspected Cadence psf 1.4.0 ASCII output, never a binary decoder. */
export function parseCadenceAcAscii(ascii: string): ParsedAcResult {
  if (typeof ascii !== 'string' || Buffer.byteLength(ascii) > L.convertedBytes || ascii.includes('\u0000')) return fail('BUDGET_EXCEEDED');
  const tokens: Token[] = [];
  const token = /\s*("(?:[^"\\\u0000-\u001f]|\\["\\nrt])*"|[A-Za-z][A-Za-z0-9_]*|[-+]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][-+]?\d+)?|[()])/uy;
  let position = 0;
  while (position < ascii.length) {
    token.lastIndex = position; const match = token.exec(ascii);
    if (!match) { if (ascii.slice(position).trim() === '') break; return fail(); }
    position = token.lastIndex; const text = match[1]!;
    if (text.startsWith('"')) { let value: unknown; try { value = JSON.parse(text); } catch { return fail(); } if (typeof value !== 'string' || Buffer.byteLength(value) > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return fail(); tokens.push({ kind: 'string', value }); }
    else if (text === '(' || text === ')') tokens.push({ kind: 'paren', value: text });
    else if (/^[A-Za-z]/u.test(text)) tokens.push({ kind: 'word', value: text });
    else { const value = Number(text); if (!Number.isFinite(value)) return fail(); tokens.push({ kind: 'number', value }); }
    if (tokens.length > 300000) return fail('BUDGET_EXCEEDED');
  }
  let index = 0;
  const peek = (): Token | undefined => tokens[index];
  const eat = (kind: Token['kind'], value?: string): string | number => { const t = tokens[index++]; if (!t || t.kind !== kind || value !== undefined && t.value !== value) return fail(); return t.value; };
  const word = (v: string): void => { eat('word', v); };
  const name = (): string => eat('string') as string;
  const scalar = (): string | number => { const t = peek(); return t?.kind === 'string' ? name() : eat('number'); };
  const pairs = (stop: string): Map<string, string | number> => {
    const values = new Map<string, string | number>();
    while (peek()?.value !== stop) { const key = name(); if (values.has(key) || values.size >= 128) return fail(); values.set(key, scalar()); }
    return values;
  };
  const props = (): Map<string, string | number> => { if (peek()?.kind !== 'word' || peek()?.value !== 'PROP') return new Map(); word('PROP'); eat('paren', '('); const result = pairs(')'); eat('paren', ')'); return result; };
  word('HEADER'); const header = pairs('TYPE');
  if (header.get('PSFversion') !== '1.00') return fail('UNSUPPORTED_FORMAT');
  if (header.get('analysis type') !== 'ac' || header.get('analysis name') !== 'ac') return fail('UNSUPPORTED_ANALYSIS');
  if (header.get('xVecSorted') !== 'ascending') return fail('UNSUPPORTED_WAVEFORM');
  word('TYPE'); const types = new Map<string, { kind: 'FLOAT' | 'COMPLEX'; props: Map<string, string | number> }>();
  while (peek()?.value !== 'SWEEP') {
    const label = name(), kind = eat('word'); if (types.has(label) || types.size >= 64 || kind !== 'FLOAT' && kind !== 'COMPLEX') return fail(); word('DOUBLE'); types.set(label, { kind, props: props() });
  }
  word('SWEEP'); const sweepName = name(), sweepType = types.get(name()), sweepProps = props();
  if (!sweepType || sweepType.kind !== 'FLOAT' || sweepProps.get('units') !== 'Hz') return fail('UNSUPPORTED_UNIT');
  word('TRACE'); const descriptions: { signalName: string; unit: 'V' | 'A'; sampleType: 'complex'; points: WaveformPoint[] }[] = [], seen = new Set<string>();
  while (peek()?.value !== 'VALUE') {
    const signalName = name(), type = types.get(name()); props();
    if (!signalName || signalName.trim() !== signalName || Buffer.byteLength(signalName) > 256 || seen.has(signalName) || signalName === sweepName || descriptions.length >= L.traces) return fail();
    if (!type || type.kind !== 'COMPLEX') return fail('UNSUPPORTED_WAVEFORM'); const unit = type.props.get('units'); if (unit !== 'V' && unit !== 'A') return fail('UNSUPPORTED_UNIT');
    seen.add(signalName); descriptions.push({ signalName, unit, sampleType: 'complex', points: [] });
  }
  if (!descriptions.length) return fail(); word('VALUE'); let previous = 0, totalPoints = 0;
  while (peek()?.value !== 'END') {
    if (name() !== sweepName) return fail(); const frequencyHz = eat('number') as number;
    if (frequencyHz <= previous) return fail('AXIS_MISMATCH'); previous = frequencyHz; totalPoints++;
    if (totalPoints > L.totalPoints) return fail('BUDGET_EXCEEDED');
    for (const trace of descriptions) { if (name() !== trace.signalName) return fail('AXIS_MISMATCH'); eat('paren', '('); const real = eat('number') as number, imag = eat('number') as number; eat('paren', ')'); trace.points.push({ frequencyHz, real, imag }); }
  }
  word('END'); if (index !== tokens.length || totalPoints < 1) return fail();
  return { analysis: 'ac', frequencyUnit: 'Hz', totalPoints, traces: descriptions };
}
