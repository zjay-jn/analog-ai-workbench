import { OA_READ_LIMITS as L, OA_READ_TOOL_NAMES } from './oa-read';
import type { OaCoverage, OaLcv, OaObjectRef, OaReadData, OaReadToolArguments, OaReadToolName, OaReadToolValue, OaRunRef, OaSelector, OaSourceCoverage, OaTerminal } from './oa-read';
import { parseSchematicReference } from '../schematic/reviewed-schematic';
import { boundReviewedJson, reviewedCanonical, reviewedExact, reviewedSha256 } from '../../../../../packages/schematic-workbench/src/reviewed-json';

const bad = (): never => { throw new TypeError('Invalid OA read contract'); };
const utf8 = new TextEncoder();
const exact = reviewedExact;
function text(value: unknown, maximum: number = L.idBytes, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || /\p{Surrogate}/u.test(value)
    || value.length > maximum || utf8.encode(value).length > maximum) return bad();
  return value;
}
const id = (value: unknown): string => text(value);
const name = (value: unknown): string => text(value, L.nameBytes);
const nullableId = (value: unknown): string | null => value === null ? null : id(value);
const nullableName = (value: unknown): string | null => value === null ? null : name(value);
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) return bad();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) return bad();
  return value;
}
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : bad(); }
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : bad();
}
const status = (value: unknown) => choice(value, ['complete', 'partial', 'unsupported'] as const);
function rows(value: unknown, maximum: number = L.pageItems): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return bad();
  return value;
}
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) bad(); }
function lcv(value: unknown): OaLcv {
  const x = exact(value, ['library', 'cell', 'view']);
  return { library: name(x.library), cell: name(x.cell), view: name(x.view) };
}
function selector(value: unknown): OaSelector {
  const tag = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'kind')?.value : null;
  if (tag === 'all') { exact(value, ['kind']); return { kind: 'all' }; }
  if (tag === 'id') { const x = exact(value, ['kind', 'objectId']); return { kind: 'id', objectId: id(x.objectId) }; }
  const x = exact(value, ['kind', 'name']);
  if (x.kind !== 'exact_name') return bad();
  return { kind: 'exact_name', name: name(x.name) };
}
function sourceCoverage(value: unknown): OaSourceCoverage {
  const x = exact(value, ['instances', 'nets', 'ports', 'parameters', 'terminals', 'netMembers', 'hierarchy', 'masterContents', 'cdf']);
  if (x.hierarchy !== 'not_read' || x.masterContents !== 'not_read' || x.cdf !== 'not_read') return bad();
  return { instances: status(x.instances), nets: status(x.nets), ports: status(x.ports), parameters: status(x.parameters),
    terminals: status(x.terminals), netMembers: status(x.netMembers), hierarchy: 'not_read', masterContents: 'not_read', cdf: 'not_read' };
}
function source(value: unknown): OaRunRef {
  const x = exact(value, ['sourceKind', 'environmentBindingId', 'libraryMappingIdentity', 'lcv', 'capturedAt', 'readMode',
    'savedRevision', 'revisionMethod', 'sourceObservation', 'dirty', 'designId', 'adapterVersion', 'freshness',
    'runId', 'projectId', 'bindingId', 'projectIdentity', 'designHandle', 'snapshotId', 'factsDigest']);
  if (x.sourceKind !== 'saved_oa' || x.readMode !== 'fresh_process_read_only'
    || x.revisionMethod !== 'copied-file-manifest-sha256-v1' || x.freshness !== 'captured_snapshot') return bad();
  const capturedAt = text(x.capturedAt, 40), savedRevision = digest(x.savedRevision);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt))) return bad();
  const observation = exact(x.sourceObservation, ['beforeDigest', 'afterDigest', 'copiedDigest', 'state', 'transactionLock']);
  if (observation.beforeDigest !== savedRevision || observation.afterDigest !== savedRevision || observation.copiedDigest !== savedRevision
    || observation.state !== 'observed_unchanged' || observation.transactionLock !== false) return bad();
  const dirty = exact(x.dirty, ['status', 'reason']);
  if (dirty.status !== 'unknown' || dirty.reason !== 'not_observed') return bad();
  return { sourceKind: 'saved_oa', environmentBindingId: id(x.environmentBindingId), libraryMappingIdentity: digest(x.libraryMappingIdentity),
    lcv: lcv(x.lcv), capturedAt, readMode: 'fresh_process_read_only', savedRevision, revisionMethod: 'copied-file-manifest-sha256-v1',
    sourceObservation: { beforeDigest: savedRevision, afterDigest: savedRevision, copiedDigest: savedRevision, state: 'observed_unchanged', transactionLock: false },
    dirty: { status: 'unknown', reason: 'not_observed' }, designId: id(x.designId), adapterVersion: id(x.adapterVersion), freshness: 'captured_snapshot',
    runId: id(x.runId), projectId: id(x.projectId), bindingId: id(x.bindingId), projectIdentity: id(x.projectIdentity), designHandle: id(x.designHandle),
    snapshotId: id(x.snapshotId), factsDigest: digest(x.factsDigest) };
}
const exclusions = ['hierarchy', 'master_contents', 'effective_cdf', 'device_semantic_roles'] as const;
function coverage(value: unknown): OaCoverage {
  const x = exact(value, ['collection', 'selector', 'sourceStatus', 'returned', 'examined', 'observedTotal', 'total', 'complete',
    'nextCursor', 'limitReason', 'fieldUnknown', 'fieldUnsupported', 'excludedScopes']);
  const result: OaCoverage = {
    collection: choice(x.collection, ['design', 'instances', 'nets', 'net_members', 'device_parameters', 'device_terminals'] as const),
    selector: selector(x.selector), sourceStatus: status(x.sourceStatus), returned: count(x.returned), examined: count(x.examined),
    observedTotal: count(x.observedTotal), total: x.total === null ? null : count(x.total), complete: bool(x.complete),
    nextCursor: x.nextCursor === null ? null : text(x.nextCursor, L.cursorBytes),
    limitReason: x.limitReason === null ? null : choice(x.limitReason, ['page', 'bytes', 'source_partial', 'unsupported'] as const),
    fieldUnknown: count(x.fieldUnknown), fieldUnsupported: count(x.fieldUnsupported), excludedScopes: exclusions,
  };
  if (reviewedCanonical(x.excludedScopes) !== reviewedCanonical(exclusions) || result.returned > L.pageItems
    || result.returned > result.observedTotal || result.observedTotal > result.examined
    || (result.sourceStatus === 'complete' ? result.total !== result.observedTotal : result.total !== null)
    || (result.complete ? result.sourceStatus !== 'complete' || result.nextCursor !== null || result.limitReason !== null
      : result.nextCursor === null ? result.limitReason !== (result.sourceStatus === 'partial' ? 'source_partial' : 'unsupported')
        : !['page', 'bytes'].includes(result.limitReason ?? '') || result.returned === 0)) return bad();
  return result;
}
function terminal(value: unknown): OaTerminal {
  const x = exact(value, ['id', 'name', 'role', 'netId']); if (x.role !== 'unknown') return bad();
  return { id: id(x.id), name: nullableName(x.name), role: 'unknown', netId: nullableId(x.netId) };
}
function data(value: unknown): OaReadData {
  const tag = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'kind')?.value : null;
  if (tag === 'design') {
    const x = exact(value, ['kind', 'coverage', 'observedCounts', 'parameterEncoding']);
    const n = exact(x.observedCounts, ['instances', 'nets', 'ports']);
    if (x.parameterEncoding !== 'skill_stored_value_serialization') return bad();
    return { kind: 'design', coverage: sourceCoverage(x.coverage), observedCounts: { instances: count(n.instances), nets: count(n.nets), ports: count(n.ports) }, parameterEncoding: 'skill_stored_value_serialization' };
  }
  if (tag === 'instances') {
    const x = exact(value, ['kind', 'items']);
    const items = rows(x.items).map(v => {
      const i = exact(v, ['id', 'name', 'master', 'parameters', 'terminals']);
      const p = exact(i.parameters, ['status', 'observedCount']), t = exact(i.terminals, ['status', 'observedCount']);
      const result = { id: id(i.id), name: name(i.name), master: lcv(i.master), parameters: { status: status(p.status), observedCount: count(p.observedCount) }, terminals: { status: status(t.status), observedCount: count(t.observedCount) } };
      if (result.parameters.status === 'unsupported' && result.parameters.observedCount || result.terminals.status === 'unsupported' && result.terminals.observedCount) return bad();
      return result;
    }); unique(items.map(i => i.id)); return { kind: 'instances', items };
  }
  if (tag === 'nets') {
    const x = exact(value, ['kind', 'items']);
    const items = rows(x.items).map(v => {
      const n = exact(v, ['id', 'name', 'membersStatus', 'observedMemberCount', 'memberCount']);
      const result = { id: id(n.id), name: nullableName(n.name), membersStatus: status(n.membersStatus), observedMemberCount: count(n.observedMemberCount), memberCount: n.memberCount === null ? null : count(n.memberCount) };
      if (result.membersStatus === 'complete' ? result.memberCount !== result.observedMemberCount : result.memberCount !== null) return bad();
      if (result.membersStatus === 'unsupported' && result.observedMemberCount !== 0) return bad();
      return result;
    }); unique(items.map(i => i.id)); return { kind: 'nets', items };
  }
  if (tag === 'net_members') {
    const x = exact(value, ['kind', 'netId', 'items']), netId = id(x.netId);
    const items = rows(x.items).map(v => {
      const memberTag = v && typeof v === 'object' ? Object.getOwnPropertyDescriptor(v, 'kind')?.value : null;
      if (memberTag === 'instance_terminal') {
        const m = exact(v, ['kind', 'instanceId', 'instanceName', 'terminal']), t = terminal(m.terminal);
        if (t.netId !== netId) return bad();
        return { kind: 'instance_terminal' as const, instanceId: id(m.instanceId), instanceName: name(m.instanceName), terminal: t };
      }
      const m = exact(v, ['kind', 'port']), p = exact(m.port, ['id', 'name', 'direction', 'netId']);
      if (m.kind !== 'port' || p.netId !== netId) return bad();
      return { kind: 'port' as const, port: { id: id(p.id), name: nullableName(p.name), direction: nullableName(p.direction), netId } };
    }); unique(items.map(i => i.kind === 'port' ? `port:${i.port.id}` : reviewedCanonical([i.instanceId, i.terminal.id])));
    return { kind: 'net_members', netId, items };
  }
  if (tag === 'device_parameters') {
    const x = exact(value, ['kind', 'instanceId', 'encoding', 'items']);
    if (x.encoding !== 'skill_stored_value_serialization') return bad();
    const items = rows(x.items).map(v => { const p = exact(v, ['name', 'valueType', 'valueText']); return { name: name(p.name), valueType: name(p.valueType), valueText: text(p.valueText, L.valueBytes, true) }; });
    unique(items.map(i => i.name)); return { kind: 'device_parameters', instanceId: id(x.instanceId), encoding: 'skill_stored_value_serialization', items };
  }
  if (tag === 'device_terminals') {
    const x = exact(value, ['kind', 'instanceId', 'items']), items = rows(x.items).map(terminal);
    unique(items.map(i => i.id)); return { kind: 'device_terminals', instanceId: id(x.instanceId), items };
  }
  return bad();
}
function objectRef(value: unknown, s: OaRunRef, d: OaReadData): OaObjectRef {
  // The current reviewed viewer can identify devices and nets, not electrical pin anchors.
  const x = exact(value, ['designHandle', 'savedRevision', 'snapshotId', 'objectId', 'kind']);
  const kind = choice(x.kind, ['instance', 'net'] as const), objectId = id(x.objectId);
  if (x.designHandle !== s.designHandle || x.savedRevision !== s.savedRevision || x.snapshotId !== s.snapshotId) return bad();
  let found = false;
  if (d.kind === 'instances') found = kind === 'instance' && d.items.some(i => i.id === objectId);
  else if (d.kind === 'nets') found = kind === 'net' && d.items.some(i => i.id === objectId);
  else if (d.kind === 'device_parameters' || d.kind === 'device_terminals') found = kind === 'instance' && d.instanceId === objectId;
  else if (d.kind === 'net_members') found = kind === 'net' ? d.netId === objectId : d.items.some(i => i.kind === 'instance_terminal' && i.instanceId === objectId);
  if (!found) return bad();
  return { kind, objectId, designHandle: s.designHandle, savedRevision: s.savedRevision, snapshotId: s.snapshotId };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function isOaReadToolName(value: unknown): value is OaReadToolName {
  return typeof value === 'string' && (OA_READ_TOOL_NAMES as readonly string[]).includes(value);
}
/** Strict shared parser: does not execute getters, retain caller-owned objects, or grant source text authority. */
export function parseOaReadToolArguments<K extends OaReadToolName>(toolName: K, value: unknown): OaReadToolArguments[K] | null {
  try {
    if (!isOaReadToolName(toolName)) return null;
    boundReviewedJson(value, L.requestBytes);
    if (toolName === 'oa_open_design') {
      const x = exact(value, ['designId', 'refresh']);
      return freeze({ designId: id(x.designId), refresh: bool(x.refresh) }) as OaReadToolArguments[K];
    }
    const fields = toolName === 'oa_inspect_design' ? [] : toolName === 'oa_query_instances' ? ['selector', 'cursor']
      : toolName === 'oa_query_nets' ? ['selector', 'section', 'cursor'] : ['instanceId', 'section', 'cursor'];
    const x = exact(value, ['designHandle', 'savedRevision', ...fields]);
    const bound = { designHandle: id(x.designHandle), savedRevision: digest(x.savedRevision) };
    if (toolName === 'oa_inspect_design') return freeze(bound) as OaReadToolArguments[K];
    const cursor = x.cursor === null ? null : text(x.cursor, L.cursorBytes);
    if (toolName === 'oa_describe_device') return freeze({ ...bound, instanceId: id(x.instanceId), section: choice(x.section, ['parameters', 'terminals'] as const), cursor }) as OaReadToolArguments[K];
    const selected = selector(x.selector);
    if (toolName === 'oa_query_instances') return freeze({ ...bound, selector: selected, cursor }) as OaReadToolArguments[K];
    const section = choice(x.section, ['summary', 'members'] as const);
    if (section === 'members' && selected.kind !== 'id') return null;
    return freeze({ ...bound, selector: selected, section, cursor }) as OaReadToolArguments[K];
  } catch { return null; }
}
/** The same page validator is used before provider delivery and on persisted-event reload. */
export function parseOaReadToolValue(value: unknown): OaReadToolValue | null {
  try {
    boundReviewedJson(value, L.toolResultBytes);
    const x = exact(value, ['kind', 'source', 'evidenceId', 'resultDigest', 'coverage', 'data'], ['displayReferences']);
    if (x.kind !== 'oa_read') return null;
    const s = source(x.source), c = coverage(x.coverage), d = data(x.data);
    if (c.collection !== d.kind || c.returned !== (d.kind === 'design' ? 1 : d.items.length)) return null;
    if (d.kind === 'design' && (c.selector.kind !== 'all' || c.examined !== 1 || c.observedTotal !== 1 || !c.complete)) return null;
    if ((d.kind === 'device_parameters' || d.kind === 'device_terminals') && (c.selector.kind !== 'id' || c.selector.objectId !== d.instanceId)) return null;
    if (d.kind === 'net_members' && (c.selector.kind !== 'id' || c.selector.objectId !== d.netId)) return null;
    if (d.kind === 'instances' || d.kind === 'nets') {
      const selected = c.selector;
      if (selected.kind === 'id' && d.items.some(i => i.id !== selected.objectId) || selected.kind === 'exact_name' && d.items.some(i => i.name !== selected.name)) return null;
    }
    let displayReferences: OaReadToolValue['displayReferences'];
    if (Object.hasOwn(x, 'displayReferences')) {
      displayReferences = rows(x.displayReferences, 8).map(v => {
        const r = exact(v, ['label', 'objectRef', 'reference']), object = objectRef(r.objectRef, s, d), reference = parseSchematicReference(r.reference);
        if (reference.projectId !== s.projectId || reference.targets.length !== 1 || reference.targets[0]!.kind !== object.kind) return bad();
        return { label: name(r.label), objectRef: object, reference };
      });
      unique(displayReferences.map(r => reviewedCanonical(r.objectRef)));
      unique(displayReferences.map(r => reviewedCanonical(r.reference)));
    }
    const body = { kind: 'oa_read' as const, source: s, evidenceId: id(x.evidenceId), coverage: c, data: d,
      ...(displayReferences === undefined ? {} : { displayReferences }) };
    const resultDigest = digest(x.resultDigest);
    if (`sha256:${reviewedSha256(reviewedCanonical(body))}` !== resultDigest) return null;
    return freeze({ ...body, resultDigest });
  } catch { return null; }
}
