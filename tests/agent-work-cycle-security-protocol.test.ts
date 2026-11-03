import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectReadEvent, parseProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read-validation';

const sourceHash = 'a'.repeat(64);
const artifactHash = 'b'.repeat(64);
function execution() {
  return {
    executionId: 'exec_security_1', language: 'javascript', isolation: 'windows-appcontainer',
    script: { fileId: 'file_program', version: sourceHash },
    inputs: [{ fileId: 'file_program', relativePath: 'analysis.js', version: sourceHash, bytes: 27 }],
    termination: 'exited', exitCode: 0, signal: null, durationMs: 32,
    stdout: '42', stderr: '', stdoutTruncated: false, stderrTruncated: false,
    artifacts: [{ fileId: 'file_result', relativePath: 'result.json', version: artifactHash,
      bytes: 10, confirmation: 'unconfirmed', origin: { kind: 'execution', executionId: 'exec_security_1' } }],
    verified: true, cleanupConfirmed: true,
  };
}
function envelope(value: unknown) { return { ok: true, value: { kind: 'work_run', execution: value } }; }
function completed(value: unknown, args = { fileId: 'file_program', version: sourceHash }) {
  return { runId: 'run_security_1', sequence: 2, time: '2026-09-13T07:00:00.000Z', type: 'tool.completed',
    data: { sessionId: 'session_security_1', messageId: 'message_security_1', callId: 'call_security_1',
      toolName: 'work_run', arguments: args, result: envelope(value) } };
}

test('C1 protocol admits a successful result only with bound script and cleanup evidence', () => {
  assert.notEqual(parseProjectReadToolResult(envelope(execution())), null);
  assert.notEqual(parseProjectReadEvent(completed(execution())), null);
});

test('C1 protocol cannot promote failed or unclean executions to verified delivery', () => {
  const good = execution();
  for (const value of [
    { ...good, cleanupConfirmed: false },
    { ...good, exitCode: 1 },
    { ...good, exitCode: null },
    ...['timed_out', 'cancelled', 'limit', 'isolation_failed'].map(termination => ({ ...good, termination })),
  ]) assert.equal(parseProjectReadToolResult(envelope(value)), null, JSON.stringify(value));
  assert.equal(parseProjectReadToolResult(envelope({ ...good, verified: false })), null,
    'unverified execution must not deliver artifacts');
  assert.notEqual(parseProjectReadToolResult(envelope({ ...good, verified: false, cleanupConfirmed: false,
    termination: 'isolation_failed', exitCode: null, artifacts: [] })), null,
    'a bounded failure remains representable without verified artifacts');
});

test('C1 protocol rejects substituted program versions and artifact execution provenance', () => {
  const good = execution();
  assert.equal(parseProjectReadEvent(completed(good, { fileId: 'other_program', version: sourceHash })), null);
  assert.equal(parseProjectReadEvent(completed(good, { fileId: 'file_program', version: artifactHash })), null);
  assert.equal(parseProjectReadToolResult(envelope({ ...good, inputs: [] })), null);
  assert.equal(parseProjectReadToolResult(envelope({ ...good, inputs: [{ ...good.inputs[0], version: artifactHash }] })), null);
  assert.equal(parseProjectReadToolResult(envelope({ ...good,
    artifacts: [{ ...good.artifacts[0], origin: { kind: 'execution', executionId: 'another_execution' } }] })), null);
  assert.equal(parseProjectReadToolResult(envelope({ ...good,
    artifacts: [{ ...good.artifacts[0], origin: { kind: 'write', changeId: 'unrelated_change' } }] })), null);
});

test('C1 protocol rejects host paths and unselected isolation labels in execution evidence', () => {
  const good = execution();
  for (const relativePath of ['../outside.json', 'C:/outside.json', 'result.json:stream', 'COM¹.txt']) {
    assert.equal(parseProjectReadToolResult(envelope({ ...good,
      artifacts: [{ ...good.artifacts[0], relativePath }] })), null, relativePath);
  }
  for (const isolation of ['none', 'node-vm', 'wasi', 'chromium-sandbox']) {
    assert.equal(parseProjectReadToolResult(envelope({ ...good, isolation })), null, isolation);
  }
});
