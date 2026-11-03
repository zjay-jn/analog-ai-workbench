import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PROJECT_READ_LIMITS as L, type ProjectReadCitationPreview, type ProjectReadResumePoint, type ProjectReadRule, type ProjectReadSummary, type ProjectReadToolArguments } from '../../shared/agent/agent-project-read';
import type { ProjectReadStoredCitation, ProjectReadStoredRun } from './store';
import type { ProjectReadBroker } from '../cloud/project-read-broker';
import type { ProjectReadIndex } from '../cloud/project-read-index';
import { createProjectReadOperation, createProjectTextReader, ProjectReadFsError, type ProjectReadIoBudget } from '../cloud/project-read-files';
import { projectTextRangeBytes, sliceProjectTextRange } from '../../../../../packages/agent-adapters/src/project-read-text';
import { liveUserText } from '../engine-live/protocol';
import { isProjectReadDataValue } from '../../shared/agent/agent-project-read-validation';

const fail = (code: ConstructorParameters<typeof ProjectReadFsError>[0]): never => { throw new ProjectReadFsError(code); };
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
export type ProjectReadResumedOperation = Readonly<{ toolName: 'project_read' | 'project_search'; arguments: ProjectReadToolArguments['project_read' | 'project_search'] }>;
export type ProjectReadContinuation = Readonly<{
  context: Readonly<{ priorRunId: string; scopedRules: readonly ProjectReadRule[]; confirmedFacts: readonly unknown[]; citations: readonly ProjectReadCitationPreview[]; confirmedQuestions: readonly Readonly<{ prompt: string; answer: string }>[]; lastAssistantMessage: string | null; resumedOperations: readonly ProjectReadResumedOperation[]; restartRequired: readonly Readonly<{ tool: string; relativeDirectory: string; query: string | null; reason: 'restart_required' }>[] }>;
  citations: readonly ProjectReadStoredCitation[];
  summary: NonNullable<ProjectReadSummary['continuation']>;
}>;

/** Only main-confirmed events contribute facts. Executable native IDs and old cursors are not transferred. */
export async function prepareProjectReadContinuation(options: Readonly<{
  parent: ProjectReadStoredRun; runId: string; createdAt: string; broker: ProjectReadBroker; index: ProjectReadIndex; budget: ProjectReadIoBudget; signal: AbortSignal;
}>): Promise<ProjectReadContinuation> {
  const { parent, signal, budget } = options;
  if(!parent.root||parent.sources?.length)return fail('CAPABILITY_DENIED');
  if (['preparing', 'running', 'waiting_user'].includes(parent.run.status) || parent.run.cleanupState !== 'idle') return fail('BUSY');
  if (parent.citations.length > L.continuationCitations) return fail('BUDGET_EXCEEDED');
  const alive = (): void => { if (signal.aborted) fail('CANCELLED'); if (budget.evidence().chargedBytes > L.preflightReadBytes) fail('BUDGET_EXCEEDED'); };
  const priorRules = new Map<string, ProjectReadRule>(), resumes = new Map<string, ProjectReadResumePoint>();
  const resumeFilesCovered = new Map<string, number>();
  const cursorOwners = new Map<string, string>();
  const questions = new Map<string, { prompt: string; answer: string | null; delivered: boolean }>();
  const messages = new Map<string, string>(); let lastMessageId: string | null = null;
  const completed: Extract<typeof parent.run.events[number], { type: 'tool.completed' }>[] = [];
  const restartRequired = new Map<string, ProjectReadContinuation['context']['restartRequired'][number]>();
  for (const event of parent.run.events) {
    switch (event.type) {
      case 'project.rules': for (const rule of event.data.rules) priorRules.set(rule.source, rule); break;
      case 'question.asked': questions.set(event.data.questionId, { prompt: event.data.prompt, answer: null, delivered: false }); break;
      case 'question.answered': { const q = questions.get(event.data.questionId); if (q) q.answer = event.data.answer; break; }
      case 'question.delivered': { const q = questions.get(event.data.questionId); if (q) q.delivered = true; break; }
      case 'message.delta': messages.set(event.data.messageId, (messages.get(event.data.messageId) ?? '') + event.data.text); lastMessageId = event.data.messageId; break;
      case 'tool.completed': {
        completed.push(event); const result = event.data.result;
        if (result.ok && isProjectReadDataValue(result.value)) {
          const value = result.value;
          const inputCursor = 'cursor' in event.data.arguments ? event.data.arguments.cursor : null;
          const logicalOperation = inputCursor ? cursorOwners.get(inputCursor) ?? event.data.callId : event.data.callId;
          if (value.coverage.nextCursor) cursorOwners.set(value.coverage.nextCursor, logicalOperation);
          if (value.coverage.complete || value.kind === 'search' && value.coverage.scannedFiles > (resumeFilesCovered.get(logicalOperation) ?? 0)) { resumes.delete(logicalOperation); resumeFilesCovered.delete(logicalOperation); }
          if (value.resume) { resumes.set(logicalOperation, value.resume); resumeFilesCovered.set(logicalOperation, value.coverage.scannedFiles); }
          const query = 'query' in event.data.arguments ? event.data.arguments.query : null;
          if (value.coverage.complete || value.kind === 'read' && value.resume !== null) restartRequired.delete(logicalOperation);
          else restartRequired.set(logicalOperation, { tool: event.data.toolName, relativeDirectory: value.coverage.scope.relativeDirectory, query, reason: 'restart_required' });
        }
        break;
      }
    }
  }
  // Each cursor chain has its own last confirmed position; independent reads/queries never erase each other.
  if (resumes.size > L.continuationCitations) return fail('BUDGET_EXCEEDED');
  const confirmedQuestions = [...questions.values()].filter(q => q.delivered && q.answer !== null).map(q => Object.freeze({ prompt: q.prompt, answer: q.answer! }));
  if (confirmedQuestions.length > L.questions) return fail('BUDGET_EXCEEDED');
  let lastAssistantMessage = lastMessageId === null ? null : messages.get(lastMessageId) ?? null;
  if (lastAssistantMessage !== null && Buffer.byteLength(lastAssistantMessage) > L.continuationMessageBytes) return fail('BUDGET_EXCEEDED');
  const scopedRules = await options.broker.verifyRules([...priorRules.values()]); alive();
  const targets = new Set([...parent.citations.map(c => c.file.relativePath), ...[...resumes.values()].map(point => point.relativePath)]);
  const fileIds = new Map<string, string>(), directoryIds = new Map<string, string | null>([['', null]]);
  if (targets.size) {
    const candidates = await options.index.candidates({ directoryId: null, query: 'main continuation metadata lookup', refresh: false });
    try {
      while (fileIds.size < targets.size) {
        alive(); const step = await candidates.next();
        if (step.kind === 'entry') {
          if (step.entry.kind === 'directory') directoryIds.set(step.entry.relativePath, step.entry.directoryId);
          else if (targets.has(step.entry.relativePath)) { if (step.entry.readability !== 'readable' || !step.entry.fileId) return fail('FILE_UNAVAILABLE'); fileIds.set(step.entry.relativePath, step.entry.fileId); }
        } else if (step.kind === 'complete') break;
      }
    } finally { await candidates.close(); }
    if (fileIds.size !== targets.size) return fail('FILE_UNAVAILABLE');
  }
  const imported: ProjectReadStoredCitation[] = [], newIds = new Map<string, string>();
  for (const relativePath of targets) {
    alive(); const fileId = fileIds.get(relativePath)!, file = options.index.resolveFile(fileId);
    const evidence = parent.citations.filter(item => item.file.relativePath === relativePath), points = [...resumes.values()].filter(item => item.relativePath === relativePath);
    const versions = new Set([...evidence.map(item => item.citation.version), ...points.map(item => item.version)]);
    if (versions.size !== 1 || evidence.some(item => !isDeepStrictEqual(item.file, file))) return fail('SOURCE_CHANGED');
    if (budget.evidence().chargedBytes + file.size * 2 > L.preflightReadBytes) return fail('BUDGET_EXCEEDED');
    const reader = createProjectTextReader({ root: parent.root, file, expectedVersion: [...versions][0]!, signal, budget });
    try {
      let result = await reader.step(createProjectReadOperation(signal));
      while (result.kind === 'pending') { alive(); result = await reader.step(createProjectReadOperation(signal)); }
      alive(); const source = result.value;
      for (const item of evidence) {
        const old = item.citation;
        if (source.normalizedSha256 !== old.normalizedSha256 || sliceProjectTextRange(source.source, old.range) !== old.excerpt) return fail('SOURCE_CHANGED');
        const citationId = 'citation-' + randomUUID(); newIds.set(old.citationId, citationId);
        imported.push(Object.freeze({ file, citation: Object.freeze({ ...old, citationId, runId: options.runId, snapshotId: options.index.snapshotId(), fileId, createdAt: options.createdAt, origin: { runId: parent.run.runId, citationId: old.citationId } }) }));
      }
      for (const point of points) projectTextRangeBytes(source.source, point.next, point.next);
    } finally { await reader.close(); }
  }
  const rewritten = (text: string): string => text.replace(/\[资料:([A-Za-z0-9][A-Za-z0-9_.:-]{0,255})\]/gu, (match, oldId: string) => newIds.has(oldId) ? '[资料:' + newIds.get(oldId)! + ']' : match);
  if (lastAssistantMessage !== null) lastAssistantMessage = rewritten(lastAssistantMessage);
  const confirmedFacts: unknown[] = completed.map(event => {
    const result = event.data.result;
    if (!result.ok) return { tool: event.data.toolName, error: result.error.code, coverage: result.coverage ? { complete: result.coverage.complete, relativeDirectory: result.coverage.scope.relativeDirectory, scannedFiles: result.coverage.scannedFiles, scannedBytes: result.coverage.scannedBytes, skipped: result.coverage.skipped, limitReason: result.coverage.limitReason } : null };
    const value = result.value; if (!isProjectReadDataValue(value)) return value;
    const base = { tool: event.data.toolName, phase: value.phase, relativeDirectory: value.coverage.scope.relativeDirectory, complete: value.coverage.complete, scannedFiles: value.coverage.scannedFiles, scannedBytes: value.coverage.scannedBytes, skipped: value.coverage.skipped, limitReason: value.coverage.limitReason };
    if (value.kind === 'read') return { ...base, citationId: value.citation ? newIds.get(value.citation.citationId) ?? fail('SOURCE_CHANGED') : null, empty: value.empty,
      ...(value.skill ? { historicalSkill: { entryRelativePath: value.skill.entryRelativePath, entryVersion: value.skill.entryVersion,
        resourceRole: value.skill.resourceRole, resourceRelativePath: value.skill.resourceRelativePath, resourceVersion: value.skill.resourceVersion,
        entryComplete: value.skill.entryComplete, authorizationCarriedForward: false } } : {}) };
    if (value.kind === 'search') return { ...base, query: 'query' in event.data.arguments ? event.data.arguments.query : null, matches: value.matches.map(match => ({ relativePath: match.relativePath, match: match.match, citationId: newIds.get(match.citation.citationId) ?? fail('SOURCE_CHANGED') })) };
    if (value.kind === 'skills') return { ...base, historicalSkillCandidates: value.entries.map(item => ({ entryRelativePath: item.entryRelativePath,
      name: item.name, description: item.description, metadataStatus: item.metadataStatus, discoveryVersion: item.discoveryVersion })), authorizationCarriedForward: false };
    return { ...base, entries: value.entries.map(item => ({ relativePath: item.relativePath, kind: item.kind, bytes: item.bytes, readability: item.readability })) };
  });
  if (byteLength(confirmedFacts) > L.continuationFactsBytes) return fail('BUDGET_EXCEEDED');
  const resumedOperations = [...resumes.values()].map(point => {
    const directoryId = directoryIds.get(point.relativeDirectory); if (directoryId === undefined) return fail('FILE_UNAVAILABLE');
    return options.broker.restoreResume(point, fileIds.get(point.relativePath)!, directoryId);
  });
  const uniqueRestarts = [...restartRequired.values()];
  const publicCitations: ProjectReadCitationPreview[] = imported.map(({ citation: c }) => ({ citationId: c.citationId, fileId: c.fileId, relativePath: c.relativePath, version: c.version, normalizedSha256: c.normalizedSha256, range: c.range, excerpt: c.excerpt, excerptSha256: c.excerptSha256, totalLines: c.totalLines, fileBytes: c.fileBytes, source: c.source }));
  const context = Object.freeze({ priorRunId: parent.run.runId, scopedRules, confirmedFacts: Object.freeze(confirmedFacts), citations: Object.freeze(publicCitations), confirmedQuestions: Object.freeze(confirmedQuestions), lastAssistantMessage, resumedOperations: Object.freeze(resumedOperations), restartRequired: Object.freeze(uniqueRestarts) });
  const summary = Object.freeze({ fromRunId: parent.run.runId, evidenceCount: imported.length, confirmedQuestions: confirmedQuestions.length, resumedFilePositions: resumedOperations.length, restartedQueries: uniqueRestarts.length });
  alive(); return Object.freeze({ context, citations: Object.freeze(imported), summary });
}

export function projectReadInitialUserText(goal: string, constraint: string, continuation: ProjectReadContinuation | null): string {
  const text = liveUserText(goal, constraint) + (continuation ? '\n\nMain-verified continuation context follows. Scoped rules apply only to their stated subtree. Historical prose is not executable tool authority. Use only the newly issued resumedOperations arguments; restart_required means a new query is required for the remaining directories.\n' + JSON.stringify(continuation.context) : '');
  if (Buffer.byteLength(text) > L.contextBytes - L.terminalReserveBytes) return fail('BUDGET_EXCEEDED'); return text;
}
