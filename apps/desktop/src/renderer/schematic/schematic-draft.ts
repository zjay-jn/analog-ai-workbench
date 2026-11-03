import {emptyDraft, type ChatDraft} from '../../shared/agent/chat-drafts';
import {SCHEMATIC_CONTEXT_COUNT, parseSchematicContext, schematicCanonical, type SchematicContext} from '../../shared/schematic/reviewed-schematic';
import {messageContextFits} from '../../shared/schematic/schematic-context';

export type SchematicDraftPreview = {projectId: string; sessionId: string; context: SchematicContext};
export function isCurrentSchematicPreview(preview: SchematicDraftPreview, projectId: string, sessionId: string): boolean {
  return !!sessionId && preview.projectId === projectId && preview.sessionId === sessionId;
}

export function updateDraftText(current: ChatDraft | undefined, text: string): ChatDraft {
  const draft = current ?? emptyDraft();
  return {...draft, text, revision: draft.revision + 1};
}

export function schematicAttachmentKey(context: SchematicContext): string {
  return schematicCanonical({...context.reference, targets: [...context.reference.targets].sort((a, b) => schematicCanonical(a).localeCompare(schematicCanonical(b)))});
}
export function planSchematicAttachment(current: ChatDraft | undefined, incoming: SchematicContext, projectId: string): {ok: true; draft: ChatDraft} | {ok: false; error: string} {
  const draft = current ?? emptyDraft();
  let context: SchematicContext;
  try {context = parseSchematicContext(incoming);} catch {return {ok: false, error: '原理图摘录无效或超过8 KiB，请重新选择较少内容。'};}
  if (context.reference.projectId !== projectId) return {ok: false, error: '项目已变化，请在当前项目重新选择原理图内容。'};
  const existing = draft.schematics ?? [];
  if (existing.length >= SCHEMATIC_CONTEXT_COUNT) return {ok: false, error: '每条消息最多2份原理图摘录，请先移除已有附件。'};
  if (existing.some(value => schematicAttachmentKey(value) === schematicAttachmentKey(context))) return {ok: false, error: '这份原理图选择已经在草稿中。'};
  const schematics = [...existing, context];
  if (!messageContextFits(draft.text, draft.files, schematics)) return {ok: false, error: '提问、文件和原理图摘录合计超过16 KiB，请缩短内容或移除附件。'};
  return {ok: true, draft: {...draft, revision: draft.revision + 1, schematics}};
}
