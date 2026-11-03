import { isDeepStrictEqual } from 'node:util';
import type { ProjectReadEventData, ProjectReadPosition } from '../../shared/agent/agent-project-read';
import type { AgentSkillDescriptor } from '../../shared/agent/agent-skills';

/** Replays only persisted facts; never opens a skill or grants a recovered run tool authority. */
export function createSkillHistoryAudit(invalid: () => never) {
  const discovered = new Map<string, { entry: AgentSkillDescriptor; snapshotId: string }>();
  const loaded = new Map<string, { version: string; snapshotId: string }>();
  const pending = new Map<string, { signature: object; snapshotId: string; start: ProjectReadPosition; version: string | null }>();
  return (event: ProjectReadEventData['tool.completed']): void => {
    if (!event.result.ok) return;
    const value = event.result.value;
    if (event.toolName === 'skill_discover') {
      if (value.kind !== 'skills') return invalid();
      for (const entry of value.entries) discovered.set(entry.skillId, { entry, snapshotId: value.snapshotId });
      return;
    }
    if (event.toolName !== 'skill_load' && event.toolName !== 'skill_read_reference') return;
    if (value.kind !== 'read' || !value.skill) return invalid();
    const args = event.arguments, source = value.skill, found = discovered.get(args.skillId);
    if (!found || found.snapshotId !== value.snapshotId || found.entry.entryRelativePath !== source.entryRelativePath
      || found.entry.discoveryVersion !== source.discoveryVersion) return invalid();
    const signature = event.toolName === 'skill_load'
      ? { toolName: event.toolName, skillId: args.skillId, discoveryVersion: event.arguments.discoveryVersion }
      : { toolName: event.toolName, skillId: args.skillId, skillVersion: event.arguments.skillVersion, fileId: event.arguments.fileId };
    if (args.cursor !== null) {
      const prior = pending.get(args.cursor);
      if (!prior || prior.snapshotId !== value.snapshotId || !isDeepStrictEqual(prior.signature, signature)
        || !isDeepStrictEqual(prior.start, args.start) || prior.version !== args.version) return invalid();
      pending.delete(args.cursor);
    } else if (event.toolName === 'skill_load' && (args.start.line !== 1 || args.start.column !== 1)) return invalid();
    if (event.toolName === 'skill_read_reference') {
      const entry = loaded.get(args.skillId);
      if (!entry || entry.snapshotId !== value.snapshotId || entry.version !== source.entryVersion) return invalid();
    }
    if (value.coverage.nextCursor) {
      if (!value.next) return invalid();
      pending.set(value.coverage.nextCursor, { signature, snapshotId: value.snapshotId, start: value.next, version: source.resourceVersion });
    }
    if (event.toolName === 'skill_load' && source.entryComplete) {
      if (!source.entryVersion) return invalid();
      loaded.set(args.skillId, { snapshotId: value.snapshotId, version: source.entryVersion });
    }
  };
}
