import type {SessionTurn} from '../../shared/agent/chat-sessions';
import type {ChatTurnActivity} from '../../shared/agent/chat-turns';
import type {OaReadToolValue} from '../../shared/agent/oa-read';
import type {OpenReviewedValue, SchematicReference, SchematicSelectionTarget} from '../../shared/schematic/reviewed-schematic';
import {schematicCanonical} from '../../shared/schematic/reviewed-schematic';

export type SchematicQueryLink = Readonly<{
  sessionId: string; turnId: string; runId: string; callId: string; evidenceId: string;
  snapshotId: string; savedRevision: string; capturedAt: string;
  question: string; label: string; reference: SchematicReference;
}>;
export type SchematicQueryDestination = 'answer' | 'query';

/** Every source/version component participates. A matching name or object ID alone is insufficient. */
export function schematicReferenceSourceKey(reference: Pick<SchematicReference,
  'projectId' | 'datasetId' | 'documentRef' | 'artifactRef' | 'sourceDigest' | 'adaptedDigest'>): string {
  return JSON.stringify([reference.projectId, reference.datasetId,
    reference.documentRef.documentId, reference.documentRef.revisionId, reference.documentRef.documentKind,
    reference.artifactRef.artifactId, reference.artifactRef.revisionId, reference.artifactRef.artifactKind,
    reference.sourceDigest, reference.adaptedDigest]);
}
function targetKey(target: SchematicSelectionTarget): string {
  return JSON.stringify([target.kind, target.occurrencePath, target.definitionId,
    target.kind === 'instance' ? target.elementId : target.netId]);
}

export function oaDisplayReferences(value: OaReadToolValue) {
  return (value.displayReferences ?? []).filter(display => display.reference.projectId === value.source.projectId
    && display.objectRef.designHandle === value.source.designHandle && display.objectRef.savedRevision === value.source.savedRevision
    && display.objectRef.snapshotId === value.source.snapshotId);
}

/** Derives navigation only from persisted successful tool results in the selected chat. */
export function schematicQueryLinks(sessionId: string, projectId: string,
  turns: readonly Pick<SessionTurn, 'id' | 'user'>[], activities: Readonly<Record<string, {activity: ChatTurnActivity | null}>>): SchematicQueryLink[] {
  const links: SchematicQueryLink[] = [], seen = new Set<string>();
  for (const turn of turns) {
    const activity = activities[turn.id]?.activity;
    if (!activity || activity.sessionId !== sessionId || activity.turnId !== turn.id) continue;
    for (const part of activity.parts) {
      if (part.kind !== 'run_event' || part.event.type !== 'tool.completed') continue;
      const {result, callId} = part.event.data;
      if (!result.ok || result.value.kind !== 'oa_read') continue;
      const value = result.value;
      if (value.source.projectId !== projectId || value.source.runId !== part.event.runId
        || (activity.run && activity.run.runId !== part.event.runId)) continue;
      for (const display of oaDisplayReferences(value)) {
        const key = JSON.stringify([turn.id, callId, value.evidenceId, schematicReferenceSourceKey(display.reference), display.reference.targets.map(targetKey)]);
        if (seen.has(key)) continue;
        seen.add(key); links.push({sessionId, turnId: turn.id, runId: part.event.runId, callId,
          evidenceId: value.evidenceId, snapshotId: value.source.snapshotId, savedRevision: value.source.savedRevision,
          capturedAt: value.source.capturedAt, question: turn.user, label: display.label, reference: display.reference});
      }
    }
  }
  return links;
}

export function relatedSchematicQueries(document: Pick<OpenReviewedValue,
  'projectId' | 'datasetId' | 'documentRef' | 'artifactRef' | 'sourceDigest' | 'adaptedDigest'>,
  selection: readonly SchematicSelectionTarget[], links: readonly SchematicQueryLink[]): SchematicQueryLink[] {
  if (!selection.length) return [];
  const source = schematicReferenceSourceKey(document), selected = new Set(selection.map(targetKey));
  return links.filter(link => schematicReferenceSourceKey(link.reference) === source
    && link.reference.targets.some(target => selected.has(targetKey(target))));
}

/** Only successful results supplied by this turn can resolve an evidence token. */
export function schematicAnswerEvidence(text: string, values: readonly OaReadToolValue[]): OaReadToolValue[] {
  const ids = new Set([...text.matchAll(/\[原理图:([^\]\r\n]+)\]/gu)].map(match => match[1]));
  return values.filter(value => ids.has(value.evidenceId));
}

/** Parameter and terminal queries may cite one object twice. Preserve separate snapshots/versions. */
export function schematicAnswerReferences(text: string, values: readonly OaReadToolValue[]) {
  const seen = new Set<string>();
  return schematicAnswerEvidence(text, values).flatMap(value => oaDisplayReferences(value).flatMap(display => {
    const identityKey = schematicCanonical({source: value.source, objectRef: display.objectRef, reference: display.reference});
    if (seen.has(identityKey)) return [];
    seen.add(identityKey); return [{...display, evidenceId: value.evidenceId, identityKey}];
  }));
}

/** Valid evidence gets an adjacent location or result button; unknown evidence stays explicitly unverified. */
export function schematicAnswerText(text: string, values: readonly OaReadToolValue[]): string {
  const resolved = new Set(schematicAnswerEvidence(text, values).map(value => value.evidenceId));
  return text.replace(/\[原理图:([^\]\r\n]+)\]/gu, (_token, evidenceId: string) => resolved.has(evidenceId) ? '' : '〔原理图依据未核实〕');
}

export const FOLDED_QUERY_PROMPT = '请查询已登记的 FOLDED_CASCODE / FOLDED_CASCODE / schematic 本地电路副本，先核对保存版本，再回答：';
export function appendSchematicQuestion(text: string): string {
  return text.includes(FOLDED_QUERY_PROMPT) ? text : [text.trimEnd(), FOLDED_QUERY_PROMPT].filter(Boolean).join('\n\n');
}
