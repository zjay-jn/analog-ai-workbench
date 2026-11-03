import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { OA_READ_LIMITS as L } from '../apps/desktop/src/shared/agent/oa-read';
import type { OaReadCode, OaReadToolResult, OaReadToolValue, OaSnapshotEnvelope } from '../apps/desktop/src/shared/agent/oa-read';
import { createOaQuerySession } from '../apps/desktop/src/main/oa-read/query';
import { createOaSnapshotStore, oaDigest } from '../apps/desktop/src/main/oa-read/snapshot';
import { OaReadError } from '../apps/desktop/src/main/oa-read/types';
import { validateOaEnvelope } from '../apps/desktop/src/main/oa-read/validate';

/** Synthetic facts only: no OA files, backend, model, GUI or process runner. */
function fixture() {
  const lcv = { library: 'SYNTHETIC', cell: 'single', view: 'schematic' };
  const files = [
    { relativePath: 'master.tag', bytes: 35, sha256: '1'.repeat(64) },
    { relativePath: 'sch.oa', bytes: 50000, sha256: '2'.repeat(64) },
  ];
  // Independent oracle uses the agreed explicit key order, not implementation canonicalization.
  const revision = `sha256:${createHash('sha256').update(JSON.stringify(files), 'utf8').digest('hex')}`;
  const binding = { requestId: 'capture-synthetic', designId: 'synthetic', environmentBindingId: 'synthetic:fixture:v1',
    libraryMappingIdentity: `sha256:${'3'.repeat(64)}`, lcv, adapterVersion: 'synthetic-reader-v1', allowedFiles: ['master.tag', 'sch.oa'] };
  const instances = Array.from({ length: 130 }, (_, n) => ({ id: `i${n}`, name: n < 2 ? 'same-name' : `M${n}`,
    master: { library: 'unopened', cell: 'unresolved-device', view: 'symbol' },
    parameters: [{ name: 'w', valueType: 'string', valueText: '"wf * 1u"' }],
    terminals: [{ id: 't0', name: null, role: 'unknown' as const, netId: 'n0' }] }));
  const envelope = { schema: 'aaw.oa-saved-read.snapshot.v1' as const, requestId: binding.requestId,
    source: { sourceKind: 'saved_oa' as const, environmentBindingId: binding.environmentBindingId,
      libraryMappingIdentity: binding.libraryMappingIdentity, lcv, capturedAt: '2026-09-14T03:00:00.000Z',
      readMode: 'fresh_process_read_only' as const, savedRevision: revision,
      revisionMethod: 'copied-file-manifest-sha256-v1' as const, files,
      sourceObservation: { beforeDigest: revision, afterDigest: revision, copiedDigest: revision,
        state: 'observed_unchanged' as const, transactionLock: false as const },
      dirty: { status: 'unknown' as const, reason: 'not_observed' as const } },
    metadata: { adapterVersion: binding.adapterVersion, parameterEncoding: 'skill_stored_value_serialization' as const,
      coverage: { instances: 'complete' as const, nets: 'complete' as const, ports: 'complete' as const,
        parameters: 'complete' as const, terminals: 'complete' as const, netMembers: 'complete' as const,
        hierarchy: 'not_read' as const, masterContents: 'not_read' as const, cdf: 'not_read' as const } },
    facts: { instances, nets: [{ id: 'n0', name: 'raw-net', members: [
      ...instances.map(i => ({ kind: 'instance_terminal' as const, instanceId: i.id, terminalId: 't0' })),
      { kind: 'port' as const, portId: 'p0' },
    ] }], ports: [{ id: 'p0', name: 'OUT', direction: 'output', netId: 'n0' }] } };
  return { envelope, binding };
}
function success(result: OaReadToolResult): OaReadToolValue {
  assert.equal(result.ok, true);
  if (!result.ok) throw Error('Expected success');
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= L.toolResultBytes);
  const { resultDigest, ...body } = result.value;
  assert.equal(resultDigest, oaDigest(body));
  return result.value;
}
function failure(result: OaReadToolResult, code: OaReadCode): void {
  assert.deepEqual(result, { ok: false, error: { code }, coverage: null });
}
function throwsCode(action: () => unknown, code: OaReadCode): void {
  assert.throws(action, error => error instanceof OaReadError && error.code === code);
}

test('OA pure admission and queries: schema, observation, reverse refs, unknown, version and bounded pagination', () => {
  const { envelope, binding } = fixture();
  const wire = JSON.stringify(envelope), store = createOaSnapshotStore();
  const snapshot = store.admit(wire, binding);
  const again = store.admit(wire, binding);
  assert.notEqual(snapshot.snapshotId, again.snapshotId);
  assert.equal(snapshot.factsDigest, again.factsDigest);
  assert.notEqual(snapshot.factsDigest, snapshot.envelope.source.savedRevision);
  assert.equal(store.size, 2);
  throwsCode(() => store.admit(wire, binding), 'BUSY');
  assert.equal(Object.isFrozen(snapshot.envelope.facts.instances[0]!.parameters), true);
  envelope.facts.instances[0]!.parameters[0]!.valueText = 'caller changed';
  assert.equal(snapshot.envelope.facts.instances[0]!.parameters[0]!.valueText, '"wf * 1u"');
  const run = { runId: 'run-1', projectId: 'project-1', bindingId: 'binding-1', projectIdentity: 'identity-1',
    designId: binding.designId, designHandle: 'design-run-1' };
  const session = createOaQuerySession(snapshot, run), second = createOaQuerySession(again, run);
  const bound = { designHandle: run.designHandle, savedRevision: snapshot.envelope.source.savedRevision };
  throwsCode(() => store.remove(snapshot.snapshotId), 'BUSY');
  throwsCode(() => createOaQuerySession({ ...snapshot }, run), 'NOT_BOUND');
  const inspect = success(session.query('oa_inspect_design', bound));
  assert.equal(inspect.source.dirty.status, 'unknown');
  assert.equal(inspect.source.sourceObservation.transactionLock, false);
  assert.equal(inspect.source.freshness, 'captured_snapshot');
  assert.equal('files' in inspect.source, false);
  if (inspect.data.kind !== 'design') throw Error('Wrong design kind');
  assert.deepEqual(inspect.data.observedCounts, { instances: 130, nets: 1, ports: 1 });
  const duplicate = success(session.query('oa_query_instances', { ...bound, selector: { kind: 'exact_name', name: 'same-name' }, cursor: null }));
  if (duplicate.data.kind !== 'instances') throw Error('Wrong instances kind');
  assert.deepEqual(duplicate.data.items.map(i => i.id), ['i0', 'i1']);
  const empty = success(session.query('oa_query_instances', { ...bound, selector: { kind: 'exact_name', name: 'SAME-NAME' }, cursor: null }));
  assert.equal(empty.coverage.returned, 0); assert.equal(empty.coverage.complete, true);
  failure(session.query('oa_query_instances', { ...bound, selector: { kind: 'id', objectId: 'missing' }, cursor: null }), 'OA_OBJECT_NOT_FOUND');
  failure(session.query('oa_inspect_design', { ...bound, designHandle: 'other' }), 'NOT_BOUND');
  failure(session.query('oa_inspect_design', { ...bound, savedRevision: `sha256:${'a'.repeat(64)}` }), 'SOURCE_CHANGED');
  failure(session.query('oa_inspect_design', { ...bound, refresh: true }), 'INVALID_REQUEST');
  failure(session.query('work_run', bound), 'INVALID_REQUEST');
  failure(session.query('oa_query_nets', { ...bound, selector: { kind: 'all' }, section: 'members', cursor: null }), 'INVALID_REQUEST');

  const pageArgs = { ...bound, selector: { kind: 'all' }, cursor: null };
  const first = success(session.query('oa_query_instances', pageArgs));
  assert.equal(first.coverage.complete, false); assert.equal(first.coverage.limitReason, 'bytes');
  assert.ok(first.coverage.nextCursor); assert.ok(first.coverage.returned < 100);
  failure(second.query('oa_query_instances', { ...pageArgs, cursor: first.coverage.nextCursor }), 'CURSOR_STALE');
  failure(session.query('oa_query_instances', { ...pageArgs, selector: { kind: 'exact_name', name: 'same-name' }, cursor: first.coverage.nextCursor }), 'CURSOR_STALE');
  failure(session.query('oa_query_instances', { ...pageArgs, cursor: `${first.coverage.nextCursor!}x` }), 'CURSOR_STALE');
  const seen: string[] = [];
  let page = first, pages = 0;
  for (;;) {
    assert.ok(++pages < 10);
    if (page.data.kind !== 'instances') throw Error('Wrong page');
    seen.push(...page.data.items.map(i => i.id));
    assert.ok(page.coverage.returned <= 100);
    if (page.coverage.nextCursor === null) break;
    page = success(session.query('oa_query_instances', { ...pageArgs, cursor: page.coverage.nextCursor }));
  }
  assert.equal(page.coverage.complete, true);
  assert.deepEqual(seen, Array.from({ length: 130 }, (_, i) => `i${i}`));
  const parameters = success(session.query('oa_describe_device', { ...bound, instanceId: 'i0', section: 'parameters', cursor: null }));
  if (parameters.data.kind !== 'device_parameters') throw Error('Wrong parameters');
  assert.equal(parameters.data.items[0]!.valueText, '"wf * 1u"');
  assert.equal(parameters.data.encoding, 'skill_stored_value_serialization');
  const terms = success(session.query('oa_describe_device', { ...bound, instanceId: 'i0', section: 'terminals', cursor: null }));
  assert.equal(terms.coverage.fieldUnknown, 2);
  const netArgs = { ...bound, selector: { kind: 'id', objectId: 'n0' }, section: 'members', cursor: null };
  let netPage = success(session.query('oa_query_nets', netArgs)), memberCount = 0;
  for (;;) {
    memberCount += netPage.coverage.returned;
    if (!netPage.coverage.nextCursor) break;
    failure(session.query('oa_query_nets', { ...netArgs, section: 'summary', cursor: netPage.coverage.nextCursor }), 'CURSOR_STALE');
    netPage = success(session.query('oa_query_nets', { ...netArgs, cursor: netPage.coverage.nextCursor }));
  }
  assert.equal(memberCount, 131);
  if (netPage.data.kind !== 'net_members') throw Error('Wrong members');
  const port = netPage.data.items.at(-1)!;
  assert.equal(port.kind, 'port');
  if (port.kind === 'port') assert.equal(port.port.direction, 'output');

  function reject(change: (v: ReturnType<typeof fixture>['envelope']) => void, code: OaReadCode = 'OA_SNAPSHOT_UNPROVEN') {
    const { envelope: v } = fixture(); change(v);
    throwsCode(() => validateOaEnvelope(JSON.stringify(v), binding), code);
  }
  reject(v => { Object.assign(v, { execute: 'untrusted' }); });
  reject(v => { v.facts.instances[1]!.id = v.facts.instances[0]!.id; });
  reject(v => { v.facts.nets[0]!.members.pop(); });
  reject(v => { v.facts.instances[0]!.terminals[0]!.netId = 'missing'; });
  reject(v => { v.facts.nets[0]!.members.push({ kind: 'instance_terminal', instanceId: 'foreign', terminalId: 't0' }); });
  reject(v => { v.source.files.reverse(); });
  reject(v => { v.source.files[0]!.sha256 = 'b'.repeat(64); });
  reject(v => { v.source.sourceObservation.afterDigest = `sha256:${'b'.repeat(64)}`; }, 'SOURCE_CHANGED');
  reject(v => { v.source.sourceObservation.beforeDigest = v.source.sourceObservation.beforeDigest.slice(7); });
  throwsCode(() => validateOaEnvelope(wire, { ...binding, environmentBindingId: 'foreign' }), 'OA_SNAPSHOT_UNPROVEN');
  throwsCode(() => validateOaEnvelope(' '.repeat(L.wireBytes + 1), binding), 'SCOPE_LIMIT');
  throwsCode(() => validateOaEnvelope('{', binding), 'OA_SNAPSHOT_UNPROVEN');
  second.close(); store.remove(again.snapshotId);
  throwsCode(() => createOaQuerySession(again, run), 'NOT_BOUND');
  const partial = JSON.parse(wire) as OaSnapshotEnvelope;
  const partialWire = JSON.stringify({ ...partial, metadata: { ...partial.metadata,
    coverage: { ...partial.metadata.coverage, instances: 'partial' } } });
  const partialSnapshot = store.admit(partialWire, binding), partialSession = createOaQuerySession(partialSnapshot, run);
  assert.notEqual(partialSnapshot.factsDigest, snapshot.factsDigest);
  const partialEmpty = success(partialSession.query('oa_query_instances', { ...bound, selector: { kind: 'exact_name', name: 'absent' }, cursor: null }));
  assert.equal(partialEmpty.coverage.complete, false); assert.equal(partialEmpty.coverage.total, null);
  assert.equal(partialEmpty.coverage.nextCursor, null); assert.equal(partialEmpty.coverage.limitReason, 'source_partial');
  partialSession.close(); store.remove(partialSnapshot.snapshotId);
  const large = fixture(); large.envelope.facts.instances[0]!.parameters[0]!.valueText = 'x'.repeat(13000);
  const largeSnapshot = store.admit(JSON.stringify(large.envelope), binding), largeSession = createOaQuerySession(largeSnapshot, run);
  failure(largeSession.query('oa_describe_device', { ...bound, instanceId: 'i0', section: 'parameters', cursor: null }), 'SCOPE_LIMIT');
  largeSession.close(); store.remove(largeSnapshot.snapshotId);
  session.close(); session.close(); store.remove(snapshot.snapshotId);
  failure(session.query('oa_inspect_design', bound), 'CANCELLED');
  assert.equal(store.size, 0);
});
