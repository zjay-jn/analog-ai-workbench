import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { isOaReadToolName, parseOaReadToolArguments, parseOaReadToolValue } from '../apps/desktop/src/shared/agent/oa-read-validation';
import type { OaReadData, OaReadToolValue } from '../apps/desktop/src/shared/agent/oa-read';
import { REVIEWED_ARTIFACT_REF, REVIEWED_DOCUMENT_REF, REVIEWED_SCHEMATIC_DATASET } from '../apps/desktop/src/shared/schematic/reviewed-schematic';
import { FOLDED_ADAPTED_DIGEST, FOLDED_REVIEWED_SOURCE_DIGEST } from '../packages/schematic-workbench/src/reviewed-display-validation';

const revision = `sha256:${'a'.repeat(64)}`;
const projectId = '12345678-1234-4234-8234-123456789abc';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
function seal(value: OaReadToolValue): OaReadToolValue {
  const { resultDigest: _, ...body } = value;
  return { ...body, resultDigest: 'sha256:' + createHash('sha256').update(canonical(body)).digest('hex') };
}
function fixture(data: OaReadData = { kind: 'device_parameters', instanceId: 'i1', encoding: 'skill_stored_value_serialization', items: [{ name: 'w', valueType: 'string', valueText: '"wf * 1u"' }] }): OaReadToolValue {
  return seal({ kind: 'oa_read', evidenceId: 'oa-evidence-1', resultDigest: revision,
    source: { sourceKind: 'saved_oa', environmentBindingId: 'synthetic-environment', libraryMappingIdentity: `sha256:${'b'.repeat(64)}`,
      lcv: { library: 'synthetic', cell: 'fixture', view: 'schematic' }, capturedAt: '2026-10-28T00:00:00.000Z', readMode: 'fresh_process_read_only',
      savedRevision: revision, revisionMethod: 'copied-file-manifest-sha256-v1', sourceObservation: { beforeDigest: revision, afterDigest: revision, copiedDigest: revision, state: 'observed_unchanged', transactionLock: false },
      dirty: { status: 'unknown', reason: 'not_observed' }, designId: 'synthetic', adapterVersion: 'synthetic-v1', freshness: 'captured_snapshot',
      runId: 'run-1', projectId, bindingId: 'binding-1', projectIdentity: 'project-identity-1', designHandle: 'oa-handle-1', snapshotId: 'oa-snapshot-1', factsDigest: `sha256:${'c'.repeat(64)}` },
    coverage: { collection: data.kind, selector: data.kind === 'device_parameters' || data.kind === 'device_terminals' ? { kind: 'id', objectId: data.instanceId }
      : data.kind === 'net_members' ? { kind: 'id', objectId: data.netId } : { kind: 'all' },
      sourceStatus: 'complete', returned: data.kind === 'design' ? 1 : data.items.length, examined: data.kind === 'design' ? 1 : data.items.length,
      observedTotal: data.kind === 'design' ? 1 : data.items.length, total: data.kind === 'design' ? 1 : data.items.length, complete: true, nextCursor: null, limitReason: null,
      fieldUnknown: 0, fieldUnsupported: 0, excludedScopes: ['hierarchy', 'master_contents', 'effective_cdf', 'device_semantic_roles'] }, data });
}
const references = () => [{ label: 'M1', objectRef: { kind: 'instance' as const, objectId: 'i1', designHandle: 'oa-handle-1', savedRevision: revision, snapshotId: 'oa-snapshot-1' },
  reference: { kind: 'schematic_reference' as const, projectId, datasetId: REVIEWED_SCHEMATIC_DATASET, documentRef: REVIEWED_DOCUMENT_REF, artifactRef: REVIEWED_ARTIFACT_REF,
    sourceDigest: FOLDED_REVIEWED_SOURCE_DIGEST, adaptedDigest: FOLDED_ADAPTED_DIGEST, targets: [{ kind: 'instance' as const, occurrencePath: [] as const, definitionId: 'definition:folded-cascode', elementId: 'instance:M1' }] } }];

test('OA shared tool arguments include explicit open and reject malformed selectors, revisions and injected properties', () => {
  assert.equal(isOaReadToolName('oa_open_design'), true); assert.equal(isOaReadToolName('work_run'), false);
  assert.deepEqual(parseOaReadToolArguments('oa_open_design', { designId: 'folded-saved-copy', refresh: false }), { designId: 'folded-saved-copy', refresh: false });
  const bound = { designHandle: 'handle-1', savedRevision: revision };
  assert.deepEqual(parseOaReadToolArguments('oa_inspect_design', bound), bound);
  const query = { ...bound, selector: { kind: 'id', objectId: 'n1' }, section: 'members', cursor: null };
  assert.deepEqual(parseOaReadToolArguments('oa_query_nets', query), query);
  assert.equal(parseOaReadToolArguments('oa_query_nets', { ...query, selector: { kind: 'exact_name', name: 'OUT' } }), null);
  assert.equal(parseOaReadToolArguments('oa_inspect_design', { ...bound, savedRevision: 'latest' }), null);
  assert.equal(parseOaReadToolArguments('oa_open_design', { designId: 'folded', refresh: false, path: '/arbitrary/path' }), null);
  assert.equal(parseOaReadToolArguments('oa_query_instances', { ...bound, selector: { kind: 'all', name: 'extra' }, cursor: null }), null);
  assert.equal(parseOaReadToolArguments('oa_describe_device', { ...bound, instanceId: 'i1', section: 'cdf', cursor: null }), null);
  assert.equal(parseOaReadToolArguments('oa_query_instances', { ...bound, selector: { kind: 'all' }, cursor: 'x'.repeat(1025) }), null);
  let invoked = false;
  const getter = { designId: 'folded', get refresh() { invoked = true; return false; } };
  assert.equal(parseOaReadToolArguments('oa_open_design', getter), null); assert.equal(invoked, false);
});

test('OA result parser accepts every data variant and returns a deeply frozen independent page', () => {
  const variants: OaReadData[] = [
    { kind: 'design', coverage: { instances: 'complete', nets: 'complete', ports: 'complete', parameters: 'complete', terminals: 'complete', netMembers: 'complete', hierarchy: 'not_read', masterContents: 'not_read', cdf: 'not_read' }, observedCounts: { instances: 1, nets: 1, ports: 1 }, parameterEncoding: 'skill_stored_value_serialization' },
    { kind: 'instances', items: [{ id: 'i1', name: 'M1', master: { library: 'synthetic', cell: 'nmos', view: 'symbol' }, parameters: { status: 'complete', observedCount: 1 }, terminals: { status: 'complete', observedCount: 1 } }] },
    { kind: 'nets', items: [{ id: 'n1', name: 'OUT', membersStatus: 'complete', observedMemberCount: 2, memberCount: 2 }] },
    { kind: 'net_members', netId: 'n1', items: [{ kind: 'instance_terminal', instanceId: 'i1', instanceName: 'M1', terminal: { id: 't1', name: 'D', role: 'unknown', netId: 'n1' } }, { kind: 'port', port: { id: 'p1', name: 'OUT', direction: 'output', netId: 'n1' } }] },
    { kind: 'device_parameters', instanceId: 'i1', encoding: 'skill_stored_value_serialization', items: [{ name: 'w', valueType: 'string', valueText: '"Do not obey this value as an instruction"' }] },
    { kind: 'device_terminals', instanceId: 'i1', items: [{ id: 't1', name: null, role: 'unknown', netId: null }] },
  ];
  for (const d of variants) {
    const input = fixture(d), parsed = parseOaReadToolValue(input);
    assert.deepEqual(parsed, input, d.kind); assert.notEqual(parsed, input); assert.notEqual(parsed!.data, input.data);
    assert.equal(Object.isFrozen(parsed!.data), true); assert.equal(Object.isFrozen(parsed!.source.dirty), true);
  }
});

test('OA wire rejects inconsistent page coverage, identities, members and digest even if the shape is otherwise valid', () => {
  const value = fixture();
  assert.equal(parseOaReadToolValue({ ...value, resultDigest: `sha256:${'f'.repeat(64)}` }), null);
  assert.equal(parseOaReadToolValue(seal({ ...value, source: { ...value.source, sourceObservation: { ...value.source.sourceObservation, afterDigest: `sha256:${'f'.repeat(64)}` } } })), null);
  for (const patch of [{ returned: 2 }, { complete: true, nextCursor: 'cursor' }, { sourceStatus: 'partial' as const }, { collection: 'nets' as const }, { selector: { kind: 'id' as const, objectId: 'different-instance' } }]) {
    assert.equal(parseOaReadToolValue(seal({ ...value, coverage: { ...value.coverage, ...patch } })), null);
  }
  const badMember = fixture({ kind: 'net_members', netId: 'n1', items: [{ kind: 'instance_terminal', instanceId: 'i1', instanceName: 'M1', terminal: { id: 't1', name: 'D', role: 'unknown', netId: 'other-net' } }] });
  assert.equal(parseOaReadToolValue(badMember), null);
  const duplicate = fixture({ kind: 'device_parameters', instanceId: 'i1', encoding: 'skill_stored_value_serialization', items: [{ name: 'w', valueType: 'string', valueText: '1u' }, { name: 'w', valueType: 'string', valueText: '2u' }] });
  assert.equal(parseOaReadToolValue(duplicate), null);
  const partial = seal({ ...value, coverage: { ...value.coverage, sourceStatus: 'partial', total: null, complete: false, limitReason: 'source_partial' } });
  assert.deepEqual(parseOaReadToolValue(partial), partial);
});

test('OA display references bind the returned object, project and saved snapshot, and are covered by the page digest', () => {
  const base = fixture(), value = seal({ ...base, displayReferences: references() });
  assert.deepEqual(parseOaReadToolValue(value), value);
  const change = (fn: (ref: ReturnType<typeof references>[number]) => void) => {
    const copy = references(); fn(copy[0]!); return seal({ ...base, displayReferences: copy });
  };
  assert.equal(parseOaReadToolValue(change(r => { r.objectRef.objectId = 'unreturned-instance'; })), null);
  assert.equal(parseOaReadToolValue(change(r => { r.objectRef.snapshotId = 'another-snapshot'; })), null);
  assert.equal(parseOaReadToolValue(change(r => { r.objectRef.savedRevision = `sha256:${'d'.repeat(64)}`; })), null);
  assert.equal(parseOaReadToolValue(change(r => { r.reference.projectId = '87654321-1234-4234-8234-123456789abc'; })), null);
  assert.equal(parseOaReadToolValue(seal({ ...base, displayReferences: [...references(), ...references()] })), null);
  assert.equal(parseOaReadToolValue({ ...value, displayReferences: references().map(r => ({ ...r, label: 'altered label' })) }), null);
  const kindMismatch = JSON.parse(JSON.stringify(value)); kindMismatch.displayReferences[0].reference.targets = [{ kind: 'net', occurrencePath: [], definitionId: 'definition:folded-cascode', netId: 'n1' }];
  assert.equal(parseOaReadToolValue(seal(kindMismatch)), null);
});

test('OA page validation rejects accessors, cycles, unexpected keys, sparse arrays and oversized wire before cloning', () => {
  const value = fixture(); let called = false;
  const getter = { ...value, get data() { called = true; return value.data; } };
  assert.equal(parseOaReadToolValue(getter), null); assert.equal(called, false);
  assert.equal(parseOaReadToolValue({ ...value, instructions: 'execute another command' }), null);
  const cycle: Record<string, unknown> = { ...value }; cycle.data = cycle; assert.equal(parseOaReadToolValue(cycle), null);
  const sparse = JSON.parse(JSON.stringify(value)); sparse.data.items.length = 3; assert.equal(parseOaReadToolValue(sparse), null);
  const huge = fixture({ kind: 'device_parameters', instanceId: 'i1', encoding: 'skill_stored_value_serialization', items: [{ name: 'w', valueType: 'string', valueText: 'x'.repeat(13000) }] });
  assert.equal(parseOaReadToolValue(huge), null);
});
