import type { ReviewedSchematicEnvelope } from '../../../../../packages/schematic-workbench/src/reviewed-display';
import { validateReviewedSchematicEnvelope } from '../../../../../packages/schematic-workbench/src/reviewed-display-validation';
import { REVIEWED_SCHEMATIC_DATASET, parseSchematicReference, type SchematicReference } from '../../shared/schematic/reviewed-schematic';
import { OA_READ_LIMITS, type OaReadToolValue } from '../../shared/agent/oa-read';
import type { OaSnapshot } from './types';
import { freezeOaValue, oaCanonicalJson, oaDigest } from './snapshot';

// Exact source identity recorded by the reviewed export, not a filename heuristic.
const REVIEWED_OA_SHA256 = '0764a15e79b078a76aae494dbe79d779af09e86df35fd3487c2b82e69091176b';
type Mapping = Readonly<{ instances: ReadonlyMap<string, string>; nets: ReadonlyMap<string, string>; display: ReviewedSchematicEnvelope['display'] }>;
const ordered = (values: readonly unknown[]) => values.map(oaCanonicalJson).sort();
const equalSet = (a: readonly unknown[], b: readonly unknown[]) => oaCanonicalJson(ordered(a)) === oaCanonicalJson(ordered(b));

/** Match one proven saved byte version, then independently compare every property
 * and all terminal/port membership multiplicities. No ordinal terminal pairing,
 * role inference, or name-only join is used to claim a drawing correspondence. */
export function mapOaToReviewed(snapshot: OaSnapshot, envelope: ReviewedSchematicEnvelope): Mapping | null {
  const { source, metadata, facts } = snapshot.envelope;
  if (source.files.find(f => f.relativePath === 'sch.oa')?.sha256 !== REVIEWED_OA_SHA256
    || Object.entries(metadata.coverage).some(([k, v]) => !['hierarchy', 'masterContents', 'cdf'].includes(k) && v !== 'complete')) return null;
  const { display } = validateReviewedSchematicEnvelope(envelope);
  if (source.lcv.library !== display.source.library || source.lcv.cell !== display.source.cell || source.lcv.view !== display.source.view
    || facts.instances.length !== display.devices.length || facts.nets.length !== display.nets.length || facts.ports.length !== display.ports.length) return null;
  const instances = new Map<string, string>(), nets = new Map<string, string>();
  for (const instance of facts.instances) {
    const candidates = display.devices.filter(d => d.name === instance.name
      && oaCanonicalJson(d.master) === oaCanonicalJson(instance.master)
      && equalSet(d.parameters, instance.parameters.map(({ name, valueText }) => ({ name, valueText }))));
    if (candidates.length !== 1 || [...instances.values()].includes(candidates[0]!.id)) return null;
    instances.set(instance.id, candidates[0]!.id);
  }
  for (const net of facts.nets) {
    const candidates = display.nets.filter(n => n.name !== null && n.name === net.name);
    if (candidates.length !== 1 || [...nets.values()].includes(candidates[0]!.id)) return null;
    nets.set(net.id, candidates[0]!.id);
  }
  for (const instance of facts.instances) {
    const actual = instance.terminals.map(t => ({ netId: t.netId === null ? null : nets.get(t.netId), name: t.name }));
    const expected = display.terminals.filter(t => t.instanceId === instances.get(instance.id)).map(t => ({ netId: t.netId, name: t.name }));
    if (!equalSet(actual, expected)) return null;
  }
  const ports = new Map<string, string>();
  for (const port of facts.ports) {
    // The reviewed exporter explicitly maps OA's inputOutput to its inout enum
    // (cadence_read_only_export.il, aalPortDirection). Retain raw OA in queries.
    const reviewedDirection = port.direction === 'inputOutput' ? 'inout' : port.direction;
    const candidates = display.ports.filter(p => p.name === port.name && p.direction === reviewedDirection && p.netId === nets.get(port.netId ?? ''));
    if (candidates.length !== 1 || [...ports.values()].includes(candidates[0]!.id)) return null;
    ports.set(port.id, candidates[0]!.id);
  }
  for (const net of facts.nets) {
    const actual = net.members.map(m => m.kind === 'port' ? { kind: 'port', id: ports.get(m.portId) }
      : { kind: 'instance', id: instances.get(m.instanceId) });
    const expectedNet = display.nets.find(n => n.id === nets.get(net.id))!;
    const expected = expectedNet.memberIds.map(id => {
      const t = display.terminals.find(t => t.id === id)!;
      return t.instanceId === null ? { kind: 'port', id: t.id } : { kind: 'instance', id: t.instanceId };
    });
    if (!equalSet(actual, expected)) return null;
  }
  return { instances, nets, display };
}

export function attachOaDisplayReferences(value: OaReadToolValue, mapping: Mapping | null): OaReadToolValue {
  const refs: NonNullable<OaReadToolValue['displayReferences']>[number][] = [];
  const { resultDigest: _oldDigest, displayReferences: _oldReferences, ...base } = value;
  const result = () => { const body = { ...base, ...(refs.length ? {displayReferences: refs} : {}) }; return { ...body, resultDigest: oaDigest(body) }; };
  if (!mapping) return freezeOaValue(result());
  const { source, data } = value;
  const candidates: {kind:'instance'|'net'; id:string; label:string}[] = [];
  if (data.kind === 'instances') candidates.push(...data.items.map(i => ({ kind:'instance' as const, id:i.id, label:i.name })));
  else if (data.kind === 'nets') candidates.push(...data.items.map(n => ({ kind:'net' as const, id:n.id, label:n.name ?? n.id })));
  else if (data.kind === 'device_parameters' || data.kind === 'device_terminals') candidates.push({kind:'instance',id:data.instanceId,label:mapping.display.devices.find(d=>d.id===mapping.instances.get(data.instanceId))?.name ?? data.instanceId});
  else if (data.kind === 'net_members') {
    candidates.push({kind:'net',id:data.netId,label:mapping.display.nets.find(n=>n.id===mapping.nets.get(data.netId))?.name ?? data.netId});
    for (const member of data.items) if(member.kind==='instance_terminal'&&!candidates.some(c=>c.kind==='instance'&&c.id===member.instanceId)) candidates.push({kind:'instance',id:member.instanceId,label:member.instanceName});
  }
  for (const candidate of candidates) {
    if (refs.length >= 8) break;
    const objectId = (candidate.kind === 'instance' ? mapping.instances : mapping.nets).get(candidate.id);
    if (!objectId) continue;
    const target = candidate.kind === 'instance' ? {kind:'instance' as const,elementId:objectId} : {kind:'net' as const,netId:objectId};
    const reference: SchematicReference = parseSchematicReference({kind:'schematic_reference',projectId:source.projectId,datasetId:REVIEWED_SCHEMATIC_DATASET,
      documentRef:mapping.display.documentRef,artifactRef:mapping.display.artifactRef,sourceDigest:mapping.display.sourceDigest,adaptedDigest:mapping.display.adaptedDigest,
      targets:[{...target,definitionId:mapping.display.definitionId,occurrencePath:[]}]});
    refs.push({label:candidate.label,objectRef:{kind:candidate.kind,objectId:candidate.id,designHandle:source.designHandle,savedRevision:source.savedRevision,snapshotId:source.snapshotId},reference});
    if(Buffer.byteLength(JSON.stringify({ok:true,value:result()}),'utf8')>OA_READ_LIMITS.toolResultBytes){refs.pop();break;}
  }
  return freezeOaValue(result());
}
