import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseWslResultsBinding, isWslResultsRelativePath, type WslResultsBinding } from '../../shared/agent/wsl-results';
import { WAVEFORM_RESULTS_VERSION as VERSION, WAVEFORM_RESULTS_LIMITS as L, type WaveformSourceFile, type WaveformResultsCode } from '../../shared/agent/waveform-results';
import { WaveformResultsError } from './reader-psf';
import { WAVEFORM_RESULTS_READER } from './reader';
export type WaveformReaderRequest = Readonly<{ readerVersion: typeof VERSION; binding: WslResultsBinding; relativePath: string; operation: 'convert' | 'check'; expectedFile: WaveformSourceFile | null }>;
export type WaveformResultsTransport = Readonly<{ execute(request: WaveformReaderRequest, signal: AbortSignal): Promise<unknown> }>;
const fail = (code: WaveformResultsCode): never => { throw new WaveformResultsError(code); };
export function waveformResultsInvocation(request: WaveformReaderRequest, directory: string): Readonly<{ executable: string; args: readonly string[]; stdin: string }> {
  if (!parseWslResultsBinding(request.binding) || request.readerVersion !== VERSION || !isWslResultsRelativePath(request.relativePath) || !request.relativePath.endsWith('.ac') || !['convert', 'check'].includes(request.operation)) return fail('INVALID_REQUEST');
  const root = 'C:\\work\\analog_ai_workbench', absolute = path.win32.resolve(directory), relative = path.win32.relative(root, absolute);
  if (relative !== '.local' && !relative.startsWith('.local\\') || relative.includes('..') || absolute !== directory) return fail('CAPABILITY_DENIED');
  let current = root;
  for (const part of ['', ...relative.split('\\')]) { if (part) current = path.win32.join(current, part); const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) return fail('CAPABILITY_DENIED'); }
  if (fs.readdirSync(absolute).length !== 0) return fail('CAPABILITY_DENIED');
  const data = { ...request, directory: '/mnt/c/' + absolute.slice(3).replaceAll('\\', '/') }, json = JSON.stringify(data);
  if (Buffer.byteLength(json) > L.requestBytes) return fail('INVALID_REQUEST');
  return Object.freeze({ executable: 'C:\\Windows\\System32\\wsl.exe', args: Object.freeze(['-d', 'ROCKY9_LLM_LAB', '-u', 'maxwell', '--exec', '/usr/bin/python3', '-I', '-', Buffer.from(json, 'utf8').toString('base64')]), stdin: WAVEFORM_RESULTS_READER });
}
type SpawnWsl = (file: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
/** Cancellation withdraws admission immediately, then awaits bounded helper/group cleanup, without discarding its ACK. */
export function createWaveformResultsTransport(options: Readonly<{ directory: string; spawn?: SpawnWsl; platform?: string }>): WaveformResultsTransport {
  let cleanupFailed = false;
  return { execute(request, signal) {
    if (cleanupFailed) return Promise.reject(new WaveformResultsError('CLEANUP_FAILED'));
    if (signal.aborted) return Promise.reject(new WaveformResultsError('CANCELLED'));
    if ((options.platform ?? process.platform) !== 'win32') return Promise.reject(new WaveformResultsError('CAPABILITY_DENIED'));
    const invocation = waveformResultsInvocation(request, options.directory);
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = (options.spawn ?? spawn)(invocation.executable, [...invocation.args], { shell: false, windowsHide: true, cwd: options.directory, env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' } }); }
      catch { reject(new WaveformResultsError('ROOT_UNAVAILABLE')); return; }
      let failure: WaveformResultsCode | null = null, settled = false, outputBytes = 0, errorBytes = 0, killed = false;
      const chunks: Buffer[] = []; let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (code?: WaveformResultsCode, result?: unknown): void => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', abort); chunks.length = 0; if (code === 'CLEANUP_FAILED') cleanupFailed = true; if (code) reject(new WaveformResultsError(code)); else resolve(result); };
      const kill = (): void => { if (killed) return; killed = true; child.stdin.destroy(); child.kill(); killTimer = setTimeout(() => finish('CLEANUP_FAILED'), 1000); };
      const abort = (): void => { failure ??= 'CANCELLED'; };
      const timer = setTimeout(() => { failure ??= 'BUDGET_EXCEEDED'; kill(); }, L.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes > L.transportBytes) { failure ??= 'BUDGET_EXCEEDED'; kill(); } else chunks.push(Buffer.from(bytes)); });
      child.stderr.on('data', (bytes: Buffer) => { errorBytes += bytes.length; if (errorBytes > 128 * 1024) { failure ??= 'BUDGET_EXCEEDED'; kill(); } });
      child.stdin.on('error', () => { failure ??= 'ENGINE_FAILED'; kill(); });
      child.on('error', () => { if (child.pid === undefined) finish('ROOT_UNAVAILABLE'); else { failure ??= 'ENGINE_FAILED'; kill(); } });
      child.on('close', code => {
        if (killed || code !== 0) { finish('CLEANUP_FAILED'); return; }
        try {
          const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!result || typeof result !== 'object' || !('readerVersion' in result) || result.readerVersion !== VERSION || !('ok' in result) || typeof result.ok !== 'boolean') { finish('CLEANUP_FAILED'); return; }
          const envelope = result as Record<string, unknown>;
          if (envelope.ok === false) {
            const allowed = ['INVALID_REQUEST', 'CAPABILITY_DENIED', 'ROOT_CHANGED', 'FILE_UNAVAILABLE', 'SOURCE_CHANGED', 'UNSUPPORTED_PATH', 'UNSUPPORTED_FORMAT', 'FILE_LIMIT', 'BUDGET_EXCEEDED', 'CONVERTER_UNAVAILABLE', 'ENGINE_FAILED', 'CLEANUP_FAILED', 'CANCELLED'];
            if (Object.keys(envelope).sort().join(',') !== 'error,ok,readerVersion' || typeof envelope.error !== 'string' || !allowed.includes(envelope.error)) { finish('CLEANUP_FAILED'); return; }
          } else {
            const value = envelope.value;
            if (Object.keys(envelope).sort().join(',') !== 'ok,readerVersion,value' || !value || typeof value !== 'object' || !('operation' in value) || value.operation !== request.operation || !('converter' in value)) { finish('CLEANUP_FAILED'); return; }
            const converter = value.converter;
            if (request.operation === 'check' ? converter !== null : !converter || typeof converter !== 'object' || !('exitCode' in converter) || converter.exitCode !== 0 || !('processGroupGone' in converter) || converter.processGroupGone !== true) { finish('CLEANUP_FAILED'); return; }
          }
          if ('error' in result && result.error === 'CLEANUP_FAILED') { finish('CLEANUP_FAILED'); return; }
          finish(failure ?? (signal.aborted ? 'CANCELLED' : undefined), result);
        } catch { finish('CLEANUP_FAILED'); }
      });
      if (signal.aborted) abort(); child.stdin.end(invocation.stdin, 'utf8');
    });
  } };
}
