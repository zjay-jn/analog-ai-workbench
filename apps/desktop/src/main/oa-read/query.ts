import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { OA_READ_LIMITS as L } from '../../shared/agent/oa-read';
import type { OaCollectionStatus, OaCoverage, OaInstanceSummary, OaMemberDetail, OaNetSummary, OaParameter,
  OaReadData, OaReadQuery, OaReadToolResult, OaReadToolValue, OaRunBinding, OaRunRef, OaSelector, OaTerminal } from '../../shared/agent/oa-read';
import { OaReadError, oaFail } from './types';
import type { OaSnapshot } from './types';
import { boundedText, exact, validateOaQuery } from './validate';
import { freezeOaValue, oaDigest, retainOaSnapshot } from './snapshot';

type PageItem = OaInstanceSummary | OaNetSummary | OaMemberDetail | OaParameter | OaTerminal;
type SnapshotQuery = Exclude<OaReadQuery, {toolName:'oa_open_design'}>;
type Selection = {
  collection: OaCoverage['collection']; selector: OaSelector; status: OaCollectionStatus;
  examined: number; items: readonly PageItem[]; data(items: readonly PageItem[]): OaReadData;
};
const excludedScopes = ['hierarchy', 'master_contents', 'effective_cdf', 'device_semantic_roles'] as const;
function select<T extends { id: string; name: string | null }>(rows: readonly T[], selector: OaSelector): { items: readonly T[]; examined: number } {
  if (selector.kind === 'id') {
    const row = rows.find(row => row.id === selector.objectId);
    if (!row) return oaFail('OA_OBJECT_NOT_FOUND');
    return { items: [row], examined: rows.length };
  }
  return { items: selector.kind === 'all' ? rows : rows.filter(row => row.name === selector.name), examined: rows.length };
}
function fields(items: readonly PageItem[], collection: OaCoverage['collection']): { unknown: number; unsupported: number } {
  let unknown = 0, unsupported = 0;
  for (const item of items) {
    if (collection === 'instances') {
      const i = item as OaInstanceSummary;
      unsupported += Number(i.parameters.status === 'unsupported') + Number(i.terminals.status === 'unsupported');
    } else if (collection === 'nets') {
      const n = item as OaNetSummary;
      unknown += Number(n.name === null) + Number(n.memberCount === null);
      unsupported += Number(n.membersStatus === 'unsupported');
    } else if (collection === 'device_terminals') {
      const t = item as OaTerminal; unknown += 1 + Number(t.name === null) + Number(t.netId === null);
    } else if (collection === 'net_members') {
      const m = item as OaMemberDetail;
      unknown += m.kind === 'instance_terminal' ? 1 + Number(m.terminal.name === null)
        : Number(m.port.name === null) + Number(m.port.direction === null);
    }
  }
  return { unknown, unsupported };
}

/** Pure snapshot queries only. The host owns callId replay, budgets, publication and evidence persistence. */
export function createOaQuerySession(snapshot: OaSnapshot, binding: OaRunBinding) {
  const invalid = (): never => oaFail('INVALID_REQUEST');
  const raw = exact(binding, ['runId', 'projectId', 'bindingId', 'projectIdentity', 'designId', 'designHandle'], invalid);
  for (const value of Object.values(raw)) boundedText(value, L.idBytes, false, invalid);
  if (binding.designId !== snapshot.designId) return oaFail('NOT_BOUND');
  const release = retainOaSnapshot(snapshot), secret = randomBytes(32);
  const { files: _files, ...saved } = snapshot.envelope.source;
  const source: OaRunRef = freezeOaValue({ ...saved, ...binding, snapshotId: snapshot.snapshotId, factsDigest: snapshot.factsDigest,
    adapterVersion: snapshot.envelope.metadata.adapterVersion, freshness: 'captured_snapshot' });
  let closed = false;
  const facts = snapshot.envelope.facts, coverage = snapshot.envelope.metadata.coverage;
  const instances = new Map(facts.instances.map(i => [i.id, i])), ports = new Map(facts.ports.map(p => [p.id, p]));
  const terminals = new Map(facts.instances.map(i => [i.id, new Map(i.terminals.map(t => [t.id, t]))]));
  function resolve(query: SnapshotQuery): Selection {
    switch (query.toolName) {
      case 'oa_inspect_design': return {
        collection: 'design', selector: { kind: 'all' }, status: 'complete', examined: 1, items: [],
        data: () => ({ kind: 'design', coverage, parameterEncoding: 'skill_stored_value_serialization',
          observedCounts: { instances: facts.instances.length, nets: facts.nets.length, ports: facts.ports.length } }),
      };
      case 'oa_query_instances': {
        if (coverage.instances === 'unsupported') return oaFail('OA_UNSUPPORTED');
        const selected = select(facts.instances, query.arguments.selector);
        const items = selected.items.map(i => ({ id: i.id, name: i.name, master: i.master,
          parameters: { status: coverage.parameters, observedCount: i.parameters.length },
          terminals: { status: coverage.terminals, observedCount: i.terminals.length } }));
        return { collection: 'instances', selector: query.arguments.selector, status: coverage.instances, examined: selected.examined,
          items, data: items => ({ kind: 'instances', items: items as readonly OaInstanceSummary[] }) };
      }
      case 'oa_query_nets': {
        if (coverage.nets === 'unsupported') return oaFail('OA_UNSUPPORTED');
        const selected = select(facts.nets, query.arguments.selector);
        if (query.arguments.section === 'summary') {
          const items = selected.items.map(n => ({ id: n.id, name: n.name, membersStatus: coverage.netMembers,
            observedMemberCount: n.members.length, memberCount: coverage.netMembers === 'complete' ? n.members.length : null }));
          return { collection: 'nets', selector: query.arguments.selector, status: coverage.nets, examined: selected.examined,
            items, data: items => ({ kind: 'nets', items: items as readonly OaNetSummary[] }) };
        }
        if (coverage.netMembers === 'unsupported') return oaFail('OA_UNSUPPORTED');
        const net = selected.items[0]!;
        const items: OaMemberDetail[] = net.members.map(m => {
          if (m.kind === 'port') return { kind: 'port', port: ports.get(m.portId)! };
          const instance = instances.get(m.instanceId)!;
          return { kind: 'instance_terminal', instanceId: instance.id, instanceName: instance.name,
            terminal: terminals.get(instance.id)!.get(m.terminalId)! };
        });
        return { collection: 'net_members', selector: query.arguments.selector, status: coverage.netMembers,
          examined: net.members.length, items, data: items => ({ kind: 'net_members', netId: net.id, items: items as readonly OaMemberDetail[] }) };
      }
      case 'oa_describe_device': {
        if (coverage.instances === 'unsupported') return oaFail('OA_UNSUPPORTED');
        const instance = instances.get(query.arguments.instanceId);
        if (!instance) return oaFail('OA_OBJECT_NOT_FOUND');
        const selector: OaSelector = { kind: 'id', objectId: instance.id };
        if (query.arguments.section === 'parameters') {
          if (coverage.parameters === 'unsupported') return oaFail('OA_UNSUPPORTED');
          return { collection: 'device_parameters', selector, status: coverage.parameters, examined: instance.parameters.length,
            items: instance.parameters, data: items => ({ kind: 'device_parameters', instanceId: instance.id,
              encoding: 'skill_stored_value_serialization', items: items as readonly OaParameter[] }) };
        }
        if (coverage.terminals === 'unsupported') return oaFail('OA_UNSUPPORTED');
        return { collection: 'device_terminals', selector, status: coverage.terminals, examined: instance.terminals.length,
          items: instance.terminals, data: items => ({ kind: 'device_terminals', instanceId: instance.id, items: items as readonly OaTerminal[] }) };
      }
    }
  }
  function queryKey(query: SnapshotQuery): string {
    const args = { ...query.arguments } as Record<string, unknown>;
    delete args.cursor;
    return oaDigest({ source, toolName: query.toolName, arguments: args });
  }
  function cursor(key: string, offset: number): string {
    const body = Buffer.from(JSON.stringify({ key, offset }), 'utf8').toString('base64url');
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  }
  function offset(token: string | null, key: string, length: number): number {
    if (token === null) return 0;
    const stale = (): never => oaFail('CURSOR_STALE');
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return stale();
    const [body, signature] = token.split('.') as [string, string];
    const actual = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', secret).update(body).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return stale();
    let value: unknown;
    try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown; } catch { return stale(); }
    const point = exact(value, ['key', 'offset'], stale);
    if (point.key !== key || !Number.isSafeInteger(point.offset) || (point.offset as number) <= 0 || (point.offset as number) >= length) return stale();
    return point.offset as number;
  }
  function execute(query: SnapshotQuery): OaReadToolResult {
    if (query.arguments.designHandle !== source.designHandle) return oaFail('NOT_BOUND');
    if (query.arguments.savedRevision !== source.savedRevision) return oaFail('SOURCE_CHANGED');
    const selection = resolve(query), key = queryKey(query);
    const start = offset('cursor' in query.arguments ? query.arguments.cursor : null, key, selection.items.length);
    const evidenceId = `oa-evidence-${randomUUID()}`;
    function result(end: number, limit: 'page' | 'bytes' | null): OaReadToolResult {
      const items = selection.items.slice(start, end), more = end < selection.items.length;
      const unknown = fields(items, selection.collection), design = selection.collection === 'design';
      const observedTotal = design ? 1 : selection.items.length;
      const pageCoverage: OaCoverage = {
        collection: selection.collection, selector: selection.selector, sourceStatus: selection.status,
        returned: design ? 1 : items.length, examined: selection.examined, observedTotal,
        total: selection.status === 'complete' ? observedTotal : null,
        complete: !more && selection.status === 'complete', nextCursor: more ? cursor(key, end) : null,
        limitReason: more ? limit : selection.status === 'partial' ? 'source_partial' : null,
        fieldUnknown: unknown.unknown, fieldUnsupported: unknown.unsupported, excludedScopes,
      };
      const body = { kind: 'oa_read' as const, source, evidenceId, coverage: pageCoverage, data: selection.data(items) };
      const value: OaReadToolValue = { ...body, resultDigest: oaDigest(body) };
      return { ok: true, value };
    }
    let end = Math.min(start + L.pageItems, selection.items.length);
    let limit: 'page' | 'bytes' | null = end < selection.items.length ? 'page' : null;
    let page = result(end, limit);
    while (Buffer.byteLength(JSON.stringify(page), 'utf8') > L.toolResultBytes && end > start) {
      end -= 1; limit = 'bytes'; page = result(end, limit);
    }
    if ((end === start && start < selection.items.length) || Buffer.byteLength(JSON.stringify(page), 'utf8') > L.toolResultBytes) return oaFail('SCOPE_LIMIT');
    return freezeOaValue(page);
  }
  return Object.freeze({
    source,
    query(toolName: string, args: unknown): OaReadToolResult {
      try {
        if (closed) return oaFail('CANCELLED');
        return execute(validateOaQuery(toolName, args));
      } catch (error) {
        if (!(error instanceof OaReadError)) throw error;
        return freezeOaValue({ ok: false, error: { code: error.code }, coverage: null });
      }
    },
    close(): void { if (!closed) { closed = true; secret.fill(0); release(); } },
  });
}
