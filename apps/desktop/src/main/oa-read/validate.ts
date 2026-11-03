import { createHash } from 'node:crypto';
import { OA_READ_LIMITS as L, OA_SNAPSHOT_SCHEMA } from '../../shared/agent/oa-read';
import type { OaCollectionStatus, OaFileObservation, OaLcv, OaReadQuery, OaSelector, OaSnapshotEnvelope } from '../../shared/agent/oa-read';
import { oaFail } from './types';
import type { OaCaptureBinding } from './types';

type RecordValue = Record<string, unknown>;
const bad = (): never => oaFail('OA_SNAPSHOT_UNPROVEN');
export function exact(value: unknown, keys: readonly string[], fail: () => never = bad): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const object = value as RecordValue;
  if (Object.keys(object).length !== keys.length || keys.some(key => !Object.hasOwn(object, key))) return fail();
  return object;
}
export function boundedText(value: unknown, max: number, empty = false, fail: () => never = bad): string {
  if (typeof value !== 'string' || (!empty && !value.length) || Buffer.byteLength(value, 'utf8') > max
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return fail();
  return value;
}
const id = (v: unknown) => boundedText(v, L.idBytes);
const name = (v: unknown) => boundedText(v, L.nameBytes);
function lcv(value: unknown): OaLcv {
  const x = exact(value, ['library', 'cell', 'view']);
  return { library: name(x.library), cell: name(x.cell), view: name(x.view) };
}
function sameLcv(a: OaLcv, b: OaLcv): boolean { return a.library === b.library && a.cell === b.cell && a.view === b.view; }
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return bad(); return value; }
function revision(value: unknown): string { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) return bad(); return value; }
function relative(value: unknown): string {
  const path = boundedText(value, L.nameBytes);
  if (/[\\:\u0000-\u001f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return bad();
  return path;
}
function status(value: unknown): OaCollectionStatus {
  if (value !== 'complete' && value !== 'partial' && value !== 'unsupported') return bad();
  return value;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > L.objects) return bad(); return value; }
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) bad(); }
const nullableName = (v: unknown) => v === null ? null : name(v);
const nullableId = (v: unknown) => v === null ? null : id(v);

/** Manifest algorithm is intentionally independent of generic object-key canonicalization. */
export function oaManifestDigest(files: readonly OaFileObservation[]): string {
  const ordered = [...files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
    .map(file => ({ relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 }));
  return createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex');
}

/** Accept only a bounded wire string. No caller-owned object or mutable arrays are retained. */
export function validateOaEnvelope(wire: string, binding: OaCaptureBinding): OaSnapshotEnvelope {
  if (typeof wire !== 'string') return bad();
  if (Buffer.byteLength(wire, 'utf8') > L.wireBytes) return oaFail('SCOPE_LIMIT');
  let parsed: unknown;
  try { parsed = JSON.parse(wire) as unknown; } catch { return bad(); }
  const root = exact(parsed, ['schema', 'requestId', 'source', 'metadata', 'facts']);
  if (root.schema !== OA_SNAPSHOT_SCHEMA || id(root.requestId) !== binding.requestId) return bad();
  id(binding.designId);
  const source = exact(root.source, ['sourceKind', 'environmentBindingId', 'libraryMappingIdentity', 'lcv', 'capturedAt',
    'readMode', 'savedRevision', 'revisionMethod', 'sourceObservation', 'files', 'dirty']);
  if (source.sourceKind !== 'saved_oa' || id(source.environmentBindingId) !== binding.environmentBindingId
    || id(source.libraryMappingIdentity) !== binding.libraryMappingIdentity || !sameLcv(lcv(source.lcv), binding.lcv)
    || source.readMode !== 'fresh_process_read_only' || source.revisionMethod !== 'copied-file-manifest-sha256-v1') return bad();
  const capturedAt = boundedText(source.capturedAt, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt))) return bad();
  const observation = exact(source.sourceObservation, ['beforeDigest', 'afterDigest', 'copiedDigest', 'state', 'transactionLock']);
  if (observation.state !== 'observed_unchanged' || observation.transactionLock !== false) return bad();
  const beforeDigest = revision(observation.beforeDigest), afterDigest = revision(observation.afterDigest), copiedDigest = revision(observation.copiedDigest);
  if (beforeDigest !== afterDigest) return oaFail('SOURCE_CHANGED');
  const files = array(source.files).map(value => {
    const file = exact(value, ['relativePath', 'bytes', 'sha256']);
    if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0) return bad();
    return { relativePath: relative(file.relativePath), bytes: file.bytes as number, sha256: digest(file.sha256) };
  });
  const paths = files.map(file => file.relativePath);
  unique(paths); unique(binding.allowedFiles);
  if (!paths.length || paths.length !== binding.allowedFiles.length || paths.some((path, i) => path !== [...binding.allowedFiles].sort()[i])
    || copiedDigest !== beforeDigest || copiedDigest !== `sha256:${oaManifestDigest(files)}` || source.savedRevision !== copiedDigest) return bad();
  const dirty = exact(source.dirty, ['status', 'reason']);
  if (dirty.status !== 'unknown' || dirty.reason !== 'not_observed') return bad();
  const metadata = exact(root.metadata, ['adapterVersion', 'parameterEncoding', 'coverage']);
  if (id(metadata.adapterVersion) !== binding.adapterVersion || metadata.parameterEncoding !== 'skill_stored_value_serialization') return bad();
  const c = exact(metadata.coverage, ['instances', 'nets', 'ports', 'parameters', 'terminals', 'netMembers', 'hierarchy', 'masterContents', 'cdf']);
  if (c.hierarchy !== 'not_read' || c.masterContents !== 'not_read' || c.cdf !== 'not_read') return bad();
  const coverage = { instances: status(c.instances), nets: status(c.nets), ports: status(c.ports), parameters: status(c.parameters),
    terminals: status(c.terminals), netMembers: status(c.netMembers), hierarchy: 'not_read', masterContents: 'not_read', cdf: 'not_read' } as const;
  const facts = exact(root.facts, ['instances', 'nets', 'ports']);
  let objects = 0;
  function counted(value: unknown): unknown[] {
    const rows = array(value); objects += rows.length;
    if (objects > L.objects) return oaFail('SCOPE_LIMIT');
    return rows;
  }
  const instances = counted(facts.instances).map(value => {
    const x = exact(value, ['id', 'name', 'master', 'parameters', 'terminals']);
    const parameters = counted(x.parameters).map(value => {
      const p = exact(value, ['name', 'valueType', 'valueText']);
      return { name: name(p.name), valueType: id(p.valueType), valueText: boundedText(p.valueText, L.valueBytes, true) };
    });
    const terminals = counted(x.terminals).map(value => {
      const t = exact(value, ['id', 'name', 'role', 'netId']);
      if (t.role !== 'unknown') return bad();
      return { id: id(t.id), name: nullableName(t.name), role: 'unknown' as const, netId: nullableId(t.netId) };
    });
    unique(parameters.map(p => p.name)); unique(terminals.map(t => t.id));
    return { id: id(x.id), name: name(x.name), master: lcv(x.master), parameters, terminals };
  });
  const nets = counted(facts.nets).map(value => {
    const x = exact(value, ['id', 'name', 'members']);
    const members = counted(x.members).map(value => {
      if (!value || typeof value !== 'object') return bad();
      if ((value as RecordValue).kind === 'instance_terminal') {
        const m = exact(value, ['kind', 'instanceId', 'terminalId']);
        return { kind: 'instance_terminal' as const, instanceId: id(m.instanceId), terminalId: id(m.terminalId) };
      }
      const m = exact(value, ['kind', 'portId']);
      if (m.kind !== 'port') return bad();
      return { kind: 'port' as const, portId: id(m.portId) };
    });
    unique(members.map(member => JSON.stringify(member)));
    return { id: id(x.id), name: nullableName(x.name), members };
  });
  const ports = counted(facts.ports).map(value => {
    const p = exact(value, ['id', 'name', 'direction', 'netId']);
    return { id: id(p.id), name: nullableName(p.name), direction: nullableName(p.direction), netId: nullableId(p.netId) };
  });
  unique(instances.map(x => x.id)); unique(nets.map(x => x.id)); unique(ports.map(x => x.id));
  const terminals = new Map(instances.flatMap(i => i.terminals.map(t => [JSON.stringify(['terminal', i.id, t.id]), t] as const)));
  const netById = new Map(nets.map(n => [n.id, n])), portById = new Map(ports.map(p => [p.id, p]));
  const membership = new Set<string>();
  for (const net of nets) for (const member of net.members) {
    const key = member.kind === 'port' ? JSON.stringify(['port', member.portId]) : JSON.stringify(['terminal', member.instanceId, member.terminalId]);
    const endpoint = member.kind === 'port' ? portById.get(member.portId) : terminals.get(key);
    if (!endpoint || endpoint.netId !== net.id || membership.has(key)) return bad();
    membership.add(key);
  }
  for (const [key, t] of terminals) if (t.netId !== null && (!netById.has(t.netId) || !membership.has(key))) return bad();
  for (const p of ports) if (p.netId !== null && (!netById.has(p.netId) || !membership.has(JSON.stringify(['port', p.id])))) return bad();
  const sizes = { instances: instances.length, nets: nets.length, ports: ports.length,
    parameters: instances.reduce((n, i) => n + i.parameters.length, 0), terminals: terminals.size,
    netMembers: nets.reduce((n, net) => n + net.members.length, 0) };
  for (const key of Object.keys(sizes) as (keyof typeof sizes)[]) if (coverage[key] === 'unsupported' && sizes[key]) return bad();
  return { schema: OA_SNAPSHOT_SCHEMA, requestId: binding.requestId,
    source: { sourceKind: 'saved_oa', environmentBindingId: source.environmentBindingId as string,
      libraryMappingIdentity: source.libraryMappingIdentity as string, lcv: lcv(source.lcv), capturedAt,
      readMode: 'fresh_process_read_only', savedRevision: source.savedRevision as string,
      revisionMethod: 'copied-file-manifest-sha256-v1', files,
      sourceObservation: { beforeDigest, afterDigest, copiedDigest, state: 'observed_unchanged', transactionLock: false },
      dirty: { status: 'unknown', reason: 'not_observed' } },
    metadata: { adapterVersion: metadata.adapterVersion as string, parameterEncoding: 'skill_stored_value_serialization', coverage },
    facts: { instances, nets, ports } };
}

export function validateOaQuery(toolName: string, value: unknown): Exclude<OaReadQuery, {toolName:'oa_open_design'}> {
  const invalid = (): never => oaFail('INVALID_REQUEST');
  let wire: string | undefined;
  try { wire = JSON.stringify(value); } catch { return invalid(); }
  if (!wire || Buffer.byteLength(wire, 'utf8') > L.requestBytes) return invalid();
  const fields = toolName === 'oa_inspect_design' ? [] : toolName === 'oa_query_instances' ? ['selector', 'cursor']
    : toolName === 'oa_query_nets' ? ['selector', 'section', 'cursor']
    : toolName === 'oa_describe_device' ? ['instanceId', 'section', 'cursor'] : null;
  if (!fields) return invalid();
  const x = exact(value, ['designHandle', 'savedRevision', ...fields], invalid);
  const text = (v: unknown, max: number = L.idBytes) => boundedText(v, max, false, invalid);
  const bound = { designHandle: text(x.designHandle), savedRevision: text(x.savedRevision) };
  if (!/^sha256:[a-f0-9]{64}$/.test(bound.savedRevision)) return invalid();
  if (toolName === 'oa_inspect_design') return { toolName, arguments: bound };
  const cursor = x.cursor === null ? null : text(x.cursor, L.cursorBytes);
  if (toolName === 'oa_describe_device') {
    if (x.section !== 'parameters' && x.section !== 'terminals') return invalid();
    return { toolName, arguments: { ...bound, instanceId: text(x.instanceId), section: x.section, cursor } };
  }
  const s = x.selector as RecordValue | null;
  let selector: OaSelector;
  if (s?.kind === 'all') { exact(s, ['kind'], invalid); selector = { kind: 'all' }; }
  else if (s?.kind === 'id') { exact(s, ['kind', 'objectId'], invalid); selector = { kind: 'id', objectId: text(s.objectId) }; }
  else { const n = exact(s, ['kind', 'name'], invalid); if (n.kind !== 'exact_name') return invalid(); selector = { kind: 'exact_name', name: text(n.name, L.nameBytes) }; }
  if (toolName === 'oa_query_instances') return { toolName, arguments: { ...bound, selector, cursor } };
  if (x.section !== 'summary' && x.section !== 'members') return invalid();
  if (x.section === 'members' && selector.kind !== 'id') return invalid();
  return { toolName: 'oa_query_nets', arguments: { ...bound, selector, section: x.section, cursor } };
}
