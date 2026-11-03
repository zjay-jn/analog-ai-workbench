import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { WSL_RESULTS_LIMITS as L, WSL_RESULTS_VERSION, parseWslResultsSelection, type WslResultsCode, type WslResultsSelection } from '../../shared/agent/wsl-results';
import { WSL_RESULTS_READER } from './reader';

export class WslResultsError extends Error { constructor(readonly code: WslResultsCode) { super(code); this.name = 'WslResultsError'; } }
export type WslReaderRequest = WslResultsSelection & Readonly<{ readerVersion: typeof WSL_RESULTS_VERSION; rootIdentity: string | null; operation: 'select' | 'list' | 'read'; arguments: Readonly<Record<string, unknown>> }>;
export type WslResultsTransport = Readonly<{ execute(request: WslReaderRequest, signal: AbortSignal): Promise<unknown> }>;
export const WSL_RESULTS_EXECUTABLE = 'C:\\Windows\\System32\\wsl.exe';
export function wslResultsInvocation(request: WslReaderRequest): Readonly<{ executable: string; args: readonly string[]; stdin: string }> {
  if (!parseWslResultsSelection({ distro: request.distro, user: request.user, rootPath: request.rootPath }) || request.readerVersion !== WSL_RESULTS_VERSION || Buffer.byteLength(JSON.stringify(request)) > L.requestBytes) throw new WslResultsError('INVALID_REQUEST');
  return Object.freeze({ executable: WSL_RESULTS_EXECUTABLE, args: Object.freeze(['-d', 'ROCKY9_LLM_LAB', '-u', 'maxwell', '--exec', '/usr/bin/python3', '-I', '-', Buffer.from(JSON.stringify(request), 'utf8').toString('base64')]), stdin: WSL_RESULTS_READER });
}
type SpawnWsl = (file: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
/** No shell, no model program, no inherited Windows credential environment or arbitrary executable. */
export function createWslResultsTransport(options: Readonly<{ spawn?: SpawnWsl; platform?: string }> = {}): WslResultsTransport {
  let cleanupFailed = false;
  return { execute(request, signal) {
    if (cleanupFailed) return Promise.reject(new WslResultsError('CLEANUP_FAILED'));
    if (signal.aborted) return Promise.reject(new WslResultsError('CANCELLED'));
    if ((options.platform ?? process.platform) !== 'win32') return Promise.reject(new WslResultsError('CAPABILITY_DENIED'));
    const invocation = wslResultsInvocation(request);
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = (options.spawn ?? spawn)(invocation.executable, [...invocation.args], { shell: false, windowsHide: true, env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' } }); }
      catch { reject(new WslResultsError('ROOT_UNAVAILABLE')); return; }
      const stdout: Buffer[] = []; let outputBytes = 0, errorBytes = 0, failure: WslResultsCode | null = null, settled = false;
      const finish = (code?: WslResultsCode, value?: unknown): void => {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        stdout.length = 0; if (code) reject(new WslResultsError(code)); else resolve(value);
      };
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: WslResultsCode): void => { if (failure) return; failure = code; stdout.length = 0; child.stdin.destroy(); child.kill(); killTimer = setTimeout(() => { cleanupFailed = true; finish('CLEANUP_FAILED'); }, 1000); };
      const abort = (): void => stop('CANCELLED');
      const timer = setTimeout(() => stop('BUDGET_EXCEEDED'), L.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (data: Buffer) => { outputBytes += data.length; if (outputBytes > L.transportBytes) stop('BUDGET_EXCEEDED'); else if (!failure) stdout.push(Buffer.from(data)); });
      // WSL may emit a bounded UTF-16 network warning on stderr while returning valid JSON.
      child.stderr.on('data', (data: Buffer) => { errorBytes += data.length; if (errorBytes > L.transportBytes) stop('BUDGET_EXCEEDED'); });
      child.stdin.on('error', () => { if (!failure) stop('ENGINE_FAILED'); });
      child.on('error', () => { if (child.pid === undefined) finish(failure ?? 'ROOT_UNAVAILABLE'); else stop('ENGINE_FAILED'); });
      child.on('close', code => {
        if (failure || signal.aborted) { finish(failure ?? 'CANCELLED'); return; }
        if (code !== 0) { finish('ENGINE_FAILED'); return; }
        try { const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout)); const value: unknown = JSON.parse(text); finish(undefined, value); }
        catch { finish('ENGINE_FAILED'); }
      });
      if (signal.aborted) abort(); else child.stdin.end(invocation.stdin, 'utf8');
    });
  } };
}
