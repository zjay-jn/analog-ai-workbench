import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectReadEventData } from '../../shared/agent/agent-project-read';
import type { WslResultsBinding } from '../../shared/agent/wsl-results';
import { isWaveformResultsToolName, waveformSourceFingerprintPayload, waveformExcerptPayload,
  type WaveformSource, type WaveformTrace, type WaveformResultsToolValue } from '../../shared/agent/waveform-results';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Replay only persisted facts. No source reads, parser launches, or algorithm re-execution. */
export function createWaveformHistoryAudit(binding: WslResultsBinding | undefined, fail: () => never, citationIds = new Set<string>()) {
  const listedFiles = new Set<string>();
  const issued = new Map<string, { source: WaveformSource; trace: WaveformTrace }>();
  const checkTrace = (source: WaveformSource, trace: WaveformTrace): void => {
    const prior = issued.get(trace.traceId);
    if (!prior || !isDeepStrictEqual(prior.source, source) || !isDeepStrictEqual(prior.trace, trace)) fail();
  };
  return (event: ProjectReadEventData['tool.completed']): void => {
    if (!event.result.ok) return;
    if (event.result.value.kind === 'wsl_results_list') {
      if (!binding || !isDeepStrictEqual(event.result.value.binding, binding)) fail();
      for (const item of event.result.value.entries) if (item.kind === 'file' && item.readability === 'binary_result') listedFiles.add(item.relativePath);
      return;
    }
    if (!isWaveformResultsToolName(event.result.value.kind)) return;
    const value = event.result.value as WaveformResultsToolValue;
    if (!binding || !isDeepStrictEqual(value.source.binding, binding)
      || hash(waveformSourceFingerprintPayload(value.source)) !== value.source.sourceVersion
      || value.source.files.some(file => !listedFiles.has(file.relativePath))) fail();
    if (value.kind === 'wsl_waveform_list') {
      for (const trace of value.traces) {
        const prior = issued.get(trace.traceId), next = { source: value.source, trace };
        if (prior && !isDeepStrictEqual(prior, next)) fail();
        issued.set(trace.traceId, next);
      }
      return;
    }
    if (citationIds.has(value.citationId) || hash(waveformExcerptPayload(value)) !== value.excerptSha256) fail();
    citationIds.add(value.citationId);
    if (value.kind === 'wsl_waveform_read') checkTrace(value.source, value.trace);
    else {
      for (const trace of value.traces) checkTrace(value.source, trace);
      const count = value.traces[0]!.totalPoints;
      if (value.traces.some(trace => trace.totalPoints !== count || trace.unit !== 'V')) fail();
      if (value.metrics.status !== 'invalid_input') {
        const name = (id: string | null): string => id === null ? '0' : value.traces.find(trace => trace.traceId === id)?.signalName ?? fail();
        const definition = value.metrics.definition;
        if (value.metrics.sampleCount !== count || definition.numerator.positiveSignal !== name(value.numerator.positiveTraceId)
          || definition.numerator.negativeSignal !== name(value.numerator.negativeTraceId)
          || definition.denominator.positiveSignal !== name(value.denominator.positiveTraceId)
          || definition.denominator.negativeSignal !== name(value.denominator.negativeTraceId)) fail();
      }
    }
  };
}
