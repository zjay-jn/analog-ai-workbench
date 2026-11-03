import { createHash, randomUUID } from 'node:crypto';
import { OA_READ_LIMITS } from '../../shared/agent/oa-read';
import { oaFail } from './types';
import type { OaCaptureBinding, OaSnapshot } from './types';
import { validateOaEnvelope } from './validate';

/** Only validated, acyclic JSON values enter this deterministic serializer. */
export function oaCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(oaCanonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${oaCanonicalJson(object[key])}`).join(',')}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) return oaFail('INVALID_REQUEST');
  return text;
}
export function oaDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(oaCanonicalJson(value), 'utf8').digest('hex')}`;
}
export function freezeOaValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeOaValue(child);
    Object.freeze(value);
  }
  return value;
}
type SnapshotLife = { users: number; removed: boolean };
const admitted = new WeakMap<OaSnapshot, SnapshotLife>();
/** Query sessions pin their admitted snapshot until explicit close; removal cannot free a live selection. */
export function retainOaSnapshot(snapshot: OaSnapshot): () => void {
  const life = admitted.get(snapshot);
  if (!life || life.removed) return oaFail('NOT_BOUND');
  life.users += 1;
  let released = false;
  return () => { if (!released) { released = true; life.users -= 1; } };
}
export function createOaSnapshotStore() {
  const snapshots = new Map<string, OaSnapshot>();
  return Object.freeze({
    admit(wire: string, binding: OaCaptureBinding): OaSnapshot {
      if (snapshots.size >= OA_READ_LIMITS.snapshots) return oaFail('BUSY');
      const envelope = validateOaEnvelope(wire, binding);
      const snapshot = freezeOaValue({ snapshotId: `oa-snapshot-${randomUUID()}`, designId: binding.designId,
        factsDigest: oaDigest({ metadata: envelope.metadata, facts: envelope.facts }), envelope });
      admitted.set(snapshot, { users: 0, removed: false });
      snapshots.set(snapshot.snapshotId, snapshot);
      return snapshot;
    },
    get(snapshotId: string): OaSnapshot {
      return snapshots.get(snapshotId) ?? oaFail('NOT_BOUND');
    },
    remove(snapshotId: string): void {
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot) return oaFail('NOT_BOUND');
      const life = admitted.get(snapshot)!;
      if (life.users) return oaFail('BUSY');
      life.removed = true;
      snapshots.delete(snapshotId);
    },
    get size(): number { return snapshots.size; },
  });
}
