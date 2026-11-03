import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { COMMAND_LIMITS as L, type CommandEnvironment, type CommandRuntime, type WslCommandEnvironment } from '../apps/desktop/src/shared/agent/agent-command';
import { isCommandEnvironment } from '../apps/desktop/src/shared/agent/agent-command-validation';
import { createCommandRecord, validateCommandRecord, assertCommandTransition } from '../apps/desktop/src/main/agent-command/state';
import { parseWslTerminal, type WslTerminal } from '../apps/desktop/src/main/agent-command/wsl-protocol';
import { readWslCommandRecovery } from '../apps/desktop/src/main/agent-command/wsl-driver';
import type { CommandRecord } from '../apps/desktop/src/main/agent-command/types';
import type { WorkCycleBaseline } from '../apps/desktop/src/main/agent-work-cycle/types';
import { projectReadEndpoint, projectReadRequestBody } from '../apps/desktop/src/main/agent-project-read/models';
import { parseProjectReadSse, projectReadCanonicalSse } from '../apps/desktop/src/main/agent-project-read/protocol';
import { parseProjectReadModel, type ProjectReadModel } from '../apps/desktop/src/shared/agent/agent-project-model';

// Synthetic values only. No files, shells, WSL, native helpers, sockets or APIs are opened.
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const identity = digest('independent WSL security fixture');
const empty = digest('');
const created = '2026-09-15T00:00:00.000Z';
const started = '2026-09-15T00:00:01.000Z';
const completed = '2026-09-15T00:00:02.000Z';
const wsl: WslCommandEnvironment = {
  environmentId: 'security-wsl', revision: identity, displayName: 'Synthetic WSL; no execution', platform: 'wsl',
  shell: { kind: 'bash', version: 'synthetic', sha256: identity, scriptEncoding: 'utf8', interactive: false },
  tools: [], isolation: 'wsl-bubblewrap', profileRevision: identity, availability: 'ready', reason: null,
  projectAccess: 'declared_roots', baselineAccess: 'verified_copy', workAccess: 'execution_copy', network: 'inherited',
  hostEnvironment: 'controlled', packageInstallation: 'not_provided', executableScope: 'wsl_user_permissions', survivesAppClose: false,
  limits: { processes: 8, logBytes: L.logBytes, defaultTimeoutMs: L.defaultTimeoutMs, maxTimeoutMs: L.maxTimeoutMs },
  wsl: { distribution: 'SYNTHETIC_LAB', user: 'synthetic', homeDirectory: '/home/synthetic', shellPath: '/bin/bash',
    executionRoot: '/synthetic/executions', sourceRoots: [{ path: '/synthetic/source', access: 'read_only', enforcement: 'os_read_only' }] },
};
const windows: CommandEnvironment = {
  environmentId: 'security-windows', revision: identity, displayName: 'Synthetic Windows; no execution', platform: 'windows',
  shell: { kind: 'powershell', version: 'synthetic', sha256: identity, scriptEncoding: 'utf8_bom', interactive: false },
  tools: [], isolation: 'windows-appcontainer-job', profileRevision: identity, availability: 'ready', reason: null,
  projectAccess: 'none', baselineAccess: 'read_only', workAccess: 'execution_copy', network: 'denied',
  hostEnvironment: 'not_inherited', packageInstallation: 'unsupported', executableScope: 'appcontainer_os_acl', survivesAppClose: false,
  limits: { ...wsl.limits, processes: 8 },
};
const baseline: WorkCycleBaseline = { runId: 'security-run', workspaceId: 'security-work', version: identity, files: [] };
function record(environment: CommandEnvironment = wsl): CommandRecord {
  return createCommandRecord(baseline.runId, { requestId: 'security-request', environmentId: environment.environmentId,
    environmentRevision: environment.revision, workspaceId: baseline.workspaceId, baselineVersion: baseline.version,
    cwdRelativePath: '', commandText: "printf '合成\n'", timeoutMs: 120000 }, environment, baseline, Date.parse(created));
}
function runtime(row: CommandRecord): CommandRuntime {
  const root = wsl.wsl.executionRoot + '/' + row.execution.executionId;
  return { platform: 'wsl', distribution: wsl.wsl.distribution, user: wsl.wsl.user, cwd: root + '/work',
    workDirectory: root + '/work', baselineDirectory: root + '/baseline' };
}
function running(): CommandRecord {
  const initial = record();
  const row: CommandRecord = { ...initial, execution: { ...initial.execution, revision: 2, phase: 'running', startedAt: started, runtime: runtime(initial) } };
  assertCommandTransition(initial, row);
  return row;
}
function terminal(row: CommandRecord): WslTerminal {
  const log = { observedBytes: 0, persistedBytes: 0, sha256: empty, eof: true, coverage: 'complete' as const };
  return { schema: 'aaw.command.wsl.result.v1', identity: { executionId: row.execution.executionId, signature: row.execution.signature,
    nonce: row.intent.nonce, environmentRevision: row.execution.environment.revision, baselineVersion: row.execution.baselineVersion,
    scriptSha256: row.execution.scriptSha256 }, startedAt: started, completedAt: completed,
    exit: { shellExitCode: 0, shellExited: true, observedAt: completed, termination: 'exited' },
    job: { activeProcesses: 0, emptyConfirmed: true, observedAt: completed }, cleanupConfirmed: true,
    logs: { stdout: { ...log }, stderr: { ...log } }, error: null,
    lifecycle: { supervisorPid: 101, supervisorStartTicks: '100001', namespacePid: 102, namespaceStartTicks: '100002',
      namespaceInode: 'pid:[999999]', namespaceProcessesRemaining: 0, namespaceInitReaped: true },
    exported: [], deleted: [], skippedFiles: 0 };
}

test('WSL security: platform declarations cannot borrow Windows isolation, network or encoding', () => {
  assert.equal(isCommandEnvironment(wsl), true);
  assert.equal(isCommandEnvironment(windows), true);
  for (const change of [{ network: 'denied' }, { isolation: 'windows-appcontainer-job' },
    { hostEnvironment: 'not_inherited' }, { shell: windows.shell }]) {
    assert.equal(isCommandEnvironment({ ...wsl, ...change }), false);
  }
  assert.equal(isCommandEnvironment({ ...wsl, wsl: { ...wsl.wsl, sourceRoots: [{ path: '/synthetic/source', access: 'read_write', enforcement: 'os_read_only' }] } }), false);
});

test('WSL security: exact script bytes keep legacy BOM and reject cross-platform stored hashes', () => {
  const linux = record(), legacy = record(windows);
  const source = Buffer.from(linux.execution.commandText, 'utf8');
  assert.equal(linux.execution.scriptSha256, digest(source));
  assert.equal(legacy.execution.scriptSha256, digest(Buffer.concat([Buffer.from([239, 187, 191]), source])));
  assert.equal(Object.hasOwn(legacy.execution, 'runtime'), false);
  validateCommandRecord(legacy);
  assert.throws(() => validateCommandRecord({ ...linux, execution: { ...linux.execution, scriptSha256: legacy.execution.scriptSha256 } }));
  assert.throws(() => validateCommandRecord({ ...legacy, execution: { ...legacy.execution, scriptSha256: linux.execution.scriptSha256 } }));
});

test('WSL security: observed runtime is bound to exact execution, target and immutable directory', () => {
  const row = running();
  validateCommandRecord(row);
  for (const change of [{ user: 'another-user' }, { distribution: 'ANOTHER_LAB' },
    { cwd: '/synthetic/source' }, { workDirectory: '/synthetic/executions/another/work' }]) {
    assert.throws(() => validateCommandRecord({ ...row, execution: { ...row.execution, runtime: { ...row.execution.runtime, ...change } } }));
  }
  assert.throws(() => assertCommandTransition(row, { ...row, execution: { ...row.execution, revision: 3, runtime: null } }));
});

test('WSL security: coherent receipt accepted; another intent or live namespace rejected', () => {
  const row = running(), receipt = terminal(row);
  assert.deepEqual(parseWslTerminal(receipt, row), receipt);
  assert.throws(() => parseWslTerminal({ ...receipt, identity: { ...receipt.identity, nonce: '11111111-1111-4111-8111-111111111111' } }, row));
  assert.throws(() => parseWslTerminal({ ...receipt, lifecycle: { ...receipt.lifecycle, namespaceProcessesRemaining: 1 } }, row));
});

test('WSL security: successful cleanup must identify the namespace that actually ran', () => {
  const row = running(), receipt = terminal(row);
  assert.throws(() => parseWslTerminal({ ...receipt, lifecycle: { ...receipt.lifecycle,
    namespacePid: null, namespaceStartTicks: null, namespaceInode: null } }, row));
});

test('WSL security: terminal exit code cannot coexist with an unobserved shell exit', () => {
  const row = running(), receipt = terminal(row);
  assert.throws(() => parseWslTerminal({ ...receipt, exit: { ...receipt.exit, shellExited: false } }, row));
});

test('WSL security: cold receipt recovery needs matching durable identity and raw log bytes', () => {
  const row = running(), receipt = terminal(row), stdout = Buffer.from('合成历史\n');
  const saved: WslTerminal = { ...receipt, logs: { ...receipt.logs,
    stdout: { observedBytes: stdout.length, persistedBytes: stdout.length, sha256: digest(stdout), eof: true, coverage: 'complete' } } };
  const files = new Map([['wsl-linux-result.json', Buffer.from(JSON.stringify(saved))], ['wsl-stdout.bin', stdout], ['wsl-stderr.bin', Buffer.alloc(0)]]);
  const reads: string[] = [];
  const read = (name: string, max: number): Buffer => {
    reads.push(name);
    const bytes = files.get(name);
    if (!bytes || bytes.length > max) throw Error('missing or oversized synthetic mirror');
    return Buffer.from(bytes);
  };
  const recovered = readWslCommandRecovery(row, read);
  assert.ok(recovered);
  assert.deepEqual(recovered.logs.stdout, stdout);
  assert.equal(recovered.outcome.cleanup.state, 'confirmed');
  assert.deepEqual(reads, ['wsl-linux-result.json', 'wsl-stdout.bin', 'wsl-stderr.bin']);
  files.set('wsl-stdout.bin', Buffer.from('changed'));
  assert.equal(readWslCommandRecovery(row, read), null);
  files.set('wsl-stdout.bin', stdout);
  files.set('wsl-linux-result.json', Buffer.from(JSON.stringify({ ...saved, identity: { ...saved.identity, signature: digest('another command') } })));
  assert.equal(readWslCommandRecovery(row, read), null);
  files.delete('wsl-linux-result.json');
  assert.equal(readWslCommandRecovery(row, read), null);
});

const kimi: ProjectReadModel = { provider: 'kimi', model: 'kimi-k3' };
const deepseek: ProjectReadModel = { provider: 'deepseek', model: 'deepseek-v4-flash' };
function providerFrame(delta: unknown, finish: string | null = null): string {
  return 'data: ' + JSON.stringify({ id: 'synthetic-completion', object: 'chat.completion.chunk', model: 'kimi-k3',
    choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
}
const providerArgs = '{ "waitMs": 0, "afterRevision": null, "executionId": "\\u0063md-01" }';
function providerWire(): string {
  return providerFrame({ role: 'assistant', reasoning_content: 'SYNTHETIC_PRIVATE_REASONING/' })
    + providerFrame({ reasoning_content: '续接' })
    + providerFrame({ tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function',
      function: { name: 'command_status', arguments: providerArgs.slice(0, 23) } }] })
    + providerFrame({ tool_calls: [{ index: 0, function: { arguments: providerArgs.slice(23) } }] })
    + providerFrame({}, 'tool_calls') + 'data: [DONE]\n\n';
}

test('K3 security: provider/model pair fixes endpoint and cannot disable thinking or exceed output cap', () => {
  assert.equal(projectReadEndpoint(kimi), 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(projectReadEndpoint(deepseek), 'https://api.deepseek.com/chat/completions');
  const mismatch = { provider: 'kimi', model: 'deepseek-v4-flash' };
  assert.equal(parseProjectReadModel(mismatch), null);
  assert.throws(() => projectReadEndpoint(mismatch as ProjectReadModel));
  assert.equal(parseProjectReadModel({ ...kimi, endpoint: 'https://synthetic.invalid' }), null);
  const request = projectReadRequestBody(kimi, [], [], 32);
  assert.equal(request.model, 'kimi-k3');
  assert.equal(request.max_completion_tokens, 32);
  assert.equal(Object.hasOwn(request, 'thinking'), false);
  assert.equal(Object.hasOwn(request, 'max_tokens'), false);
  assert.throws(() => projectReadRequestBody(kimi, [], [], Number.MAX_SAFE_INTEGER));
});

test('K3 security: preserve private reasoning and raw argument bytes while executing validated arguments', () => {
  const parsed = parseProjectReadSse(providerWire(), 32, kimi);
  assert.equal(parsed.reasoningContent, 'SYNTHETIC_PRIVATE_REASONING/续接');
  assert.deepEqual(parsed.providerArguments, [providerArgs]);
  assert.deepEqual(parsed.calls, [{ id: 'synthetic-call', name: 'command_status',
    arguments: { waitMs: 0, afterRevision: null, executionId: 'cmd-01' } }]);
  const native = projectReadCanonicalSse(parsed);
  assert.equal(native.includes('SYNTHETIC_PRIVATE_REASONING'), false, 'private provider context does not enter native/renderer stream');
  assert.deepEqual(parseProjectReadSse(native, 32, kimi).calls, parsed.calls);
  assert.throws(() => projectReadCanonicalSse({ ...parsed, providerArguments: ['{"executionId":"changed","afterRevision":null,"waitMs":0}'] }));
});

test('K3 security: incomplete response and cross-provider reasoning never release a tool call', () => {
  const wire = providerWire();
  assert.throws(() => parseProjectReadSse(wire.replace('data: [DONE]\n\n', ''), 32, kimi));
  assert.throws(() => parseProjectReadSse(wire, 32, deepseek));
  assert.throws(() => parseProjectReadSse(wire.replace('command_status', 'unregistered_shell'), 32, kimi));
});
