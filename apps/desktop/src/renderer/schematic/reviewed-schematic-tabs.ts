import {REVIEWED_SCHEMATIC_VERSION, REVIEWED_SCHEMATIC_DATASET, SCHEMATIC_TARGET_COUNT,
  parseReviewedSchematicListResult, parseOpenReviewedResult, parseSchematicPreviewResult, parseResolveSchematicReferenceResult,
  type OpenReviewedValue, type ReviewedSchematicDescriptor, type ReviewedSchematicCode, type SchematicContext,
  type SchematicReference, type SchematicSelectionTarget, type WorkbenchReviewedSchematicApi} from '../../shared/schematic/reviewed-schematic';
import {CLOUD_SCHEMATIC_PROJECT_CACHE_LIMIT} from '../../shared/schematic/cloud-schematic';
import {createInitialViewerViewStateV1, type ViewerViewStateV1} from '../../../../../packages/schematic-workbench/src/viewer/view-state';
import type {SchematicViewerActionV1} from '../SchematicViewer';
import {applySchematicViewerAction} from './viewer-actions';
import {reviewedSelectionTargets} from './ReviewedSchematicInspector';

export const reviewedSchematicErrors: Record<ReviewedSchematicCode, string> = {
  INVALID_REQUEST: '原理图选择或引用无效，请重新选择。', CAPABILITY_DENIED: '当前项目无法访问这个原理图版本。',
  REVISION_UNAVAILABLE: '原理图的原版本已不可用，无法恢复定位。', DATA_UNAVAILABLE: '已核定的原理图数据暂不可用。',
  INTERNAL: '原理图操作未完成，请重试。', LIMIT: '选中内容超过摘录限制，请减少器件或选择较小的网络。',
};
type TabBase = {projectId: string; key: string; active: boolean; generation: number; used: number};
export type ReviewedSchematicTab = TabBase & ({status: 'loading'} | {status: 'error'; message: string}
  | {status: 'ready'; delivery: OpenReviewedValue; viewState: ViewerViewStateV1; measured: boolean});
type PreviewBase = {projectId: string; sessionId: string; documentKey: string; selectionKey: string; generation: number};
export type ReviewedPreview = PreviewBase & ({status: 'loading'} | {status: 'error'; message: string} | {status: 'ready'; context: SchematicContext});
export function reviewedDocumentKey(value: OpenReviewedValue) {
  return referenceKey(value);
}
function referenceKey(reference: Pick<SchematicReference, 'projectId' | 'datasetId' | 'documentRef' | 'artifactRef' | 'sourceDigest' | 'adaptedDigest'>) {
  return JSON.stringify([reference.projectId, reference.datasetId, reference.documentRef.documentId, reference.documentRef.revisionId, reference.documentRef.documentKind, reference.artifactRef.artifactId, reference.artifactRef.revisionId, reference.artifactRef.artifactKind, reference.sourceDigest, reference.adaptedDigest]);
}
const targetsKey = (targets: readonly SchematicSelectionTarget[]) => JSON.stringify(targets.map(target => JSON.stringify([target.kind, target.definitionId, target.occurrencePath, target.kind === 'instance' ? target.elementId : target.netId])).sort());
function sameReference(a: SchematicReference, b: SchematicReference) {
  return referenceKey(a) === referenceKey(b) && targetsKey(a.targets) === targetsKey(b.targets);
}
const selectionKey = (state: ViewerViewStateV1) => JSON.stringify([state.selection, state.netHighlight]);

export function createReviewedSchematicTabs(api: WorkbenchReviewedSchematicApi | undefined) {
  const entries = new Map<string, ReviewedSchematicTab>(), listeners = new Set<() => void>();
  let projectId = '', sessionId = '', generation = 0, catalogGeneration = 0, clock = 0, disposed = false;
  let preview: ReviewedPreview | null = null, descriptors: readonly ReviewedSchematicDescriptor[] = [], catalogStatus: 'loading' | 'ready' | 'error' = 'ready', notice = '';
  const emit = () => {if (!disposed) for (const listener of listeners) listener();};
  const clearPreview = () => {preview = null;};
  const ready = () => {const tab = entries.get(projectId); return tab?.status === 'ready' ? tab : null;};
  function loadingTab(): ReviewedSchematicTab | null {
    if (!projectId || disposed) return null;
    if (!entries.has(projectId) && entries.size >= CLOUD_SCHEMATIC_PROJECT_CACHE_LIMIT) {
      const oldest = [...entries.values()].filter(entry => entry.projectId !== projectId).sort((a, b) => a.used - b.used)[0];
      if (oldest) entries.delete(oldest.projectId);
    }
    const tab: ReviewedSchematicTab = {projectId, key: JSON.stringify([projectId, REVIEWED_SCHEMATIC_DATASET]), active: true, generation: ++generation, used: ++clock, status: 'loading'};
    clearPreview(); notice = ''; entries.set(projectId, tab); emit(); return tab;
  }
  function currentRequest(tab: ReviewedSchematicTab) {return !disposed && projectId === tab.projectId && entries.get(projectId)?.generation === tab.generation;}
  function install(tab: ReviewedSchematicTab, delivery: OpenReviewedValue, reference?: SchematicReference) {
    if (!currentRequest(tab)) return;
    if (delivery.projectId !== tab.projectId || (reference && reviewedDocumentKey(delivery) !== referenceKey(reference))) throw new Error('Mismatched document');
    let viewState = createInitialViewerViewStateV1(delivery.reviewedCircuitIr, {width: 720, height: 520}, delivery.artifactRef);
    if (reference) {
      const nets = reference.targets.filter(target => target.kind === 'net');
      if (nets.length > 1) throw new Error('Multiple net reference is not supported');
      const targets = reference.targets.flatMap(target => target.kind === 'instance' ? [{artifactId: delivery.artifactRef.artifactId, revisionId: delivery.artifactRef.revisionId, occurrencePath: target.occurrencePath, definitionId: target.definitionId, elementKind: 'instance' as const, elementId: target.elementId}] : []);
      viewState = applySchematicViewerAction(delivery, viewState, {type: 'marquee-select', targets, ctrlKey: false});
      if (viewState.selection.length !== targets.length) throw new Error('Referenced devices unavailable');
      for (const target of nets) if (target.kind === 'net') viewState = applySchematicViewerAction(delivery, viewState, {type: 'select-net-from-list', occurrencePath: target.occurrencePath, definitionId: target.definitionId, netId: target.netId});
      if (nets.some(target => target.kind === 'net' && viewState.netHighlight?.netId !== target.netId)) throw new Error('Referenced network unavailable');
    }
    entries.set(tab.projectId, {...tab, active: entries.get(tab.projectId)!.active, key: reviewedDocumentKey(delivery), status: 'ready', delivery, viewState, measured: false}); emit();
  }
  function failed(tab: ReviewedSchematicTab, message: string) {
    if (currentRequest(tab)) {entries.set(tab.projectId, {...tab, active: entries.get(tab.projectId)!.active, status: 'error', message}); emit();}
  }
  return {
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    snapshot: () => ({tabs: [...entries.values()], preview, descriptors, catalogStatus, notice}),
    setProject(id: string) {
      if (disposed || projectId === id) return;
      for (const [key, entry] of entries) if (entry.status === 'loading') entries.set(key, {...entry, generation: ++generation, status: 'error', message: '上次加载已取消，请重试。'});
      projectId = id; clearPreview(); notice = ''; descriptors = []; catalogStatus = api && id ? 'loading' : 'ready';
      const tab = entries.get(id); if (tab) entries.set(id, {...tab, used: ++clock}); emit();
      if (api && id) {
        const token = ++generation;
        void api.list({contractVersion: REVIEWED_SCHEMATIC_VERSION, projectId: id}).then(raw => {
          if (disposed || projectId !== id || token !== catalogGeneration) return;
          const result = parseReviewedSchematicListResult(raw); catalogStatus = result.ok ? 'ready' : 'error'; descriptors = result.ok ? result.value : []; emit();
        }).catch(() => {if (!disposed && projectId === id && token === catalogGeneration) {catalogStatus = 'error'; emit();}});
        catalogGeneration = token;
      }
    },
    setSession(id: string) {if (sessionId !== id) {sessionId = id; clearPreview(); emit();}},
    selectText() {const tab = entries.get(projectId); if (!disposed && tab) {entries.set(projectId, {...tab, active: false}); clearPreview(); emit();}},
    select() {const tab = entries.get(projectId); if (!disposed && tab) {entries.set(projectId, {...tab, active: true, used: ++clock}); emit();}},
    close() {if (!disposed) {entries.delete(projectId); clearPreview(); ++generation; emit();}},
    async open(retry = false) {
      if (disposed || !projectId) return;
      const existing = entries.get(projectId);
      if (existing && !retry) {entries.set(projectId, {...existing, active: true, used: ++clock}); emit(); return;}
      const tab = loadingTab(); if (!tab) return;
      try {
        if (!api) throw new Error('Unavailable');
        const result = parseOpenReviewedResult(await api.openReviewed({contractVersion: REVIEWED_SCHEMATIC_VERSION, projectId: tab.projectId, datasetId: REVIEWED_SCHEMATIC_DATASET}));
        if (result.ok) install(tab, result.value); else failed(tab, reviewedSchematicErrors[result.error.code]);
      } catch {failed(tab, reviewedSchematicErrors.DATA_UNAVAILABLE);}
    },
    action(key: string, action: SchematicViewerActionV1) {
      const tab = ready(); if (disposed || !tab?.active || tab.key !== key) return;
      const viewState = applySchematicViewerAction(tab.delivery, tab.viewState, action);
      if (selectionKey(viewState) !== selectionKey(tab.viewState)) clearPreview();
      entries.set(projectId, {...tab, viewState, measured: tab.measured || action.type === 'resize-css'}); emit();
    },
    async previewSelection(targets: readonly SchematicSelectionTarget[]) {
      const tab = ready(); if (disposed || !api || !tab?.active) return;
      if (!sessionId) {notice = '请先选择一个会话，再预览要加入的内容。'; emit(); return;}
      const base: PreviewBase = {projectId, sessionId, documentKey: tab.key, selectionKey: selectionKey(tab.viewState), generation: ++generation};
      preview = !targets.length || targets.length > SCHEMATIC_TARGET_COUNT ? {...base, status: 'error', message: reviewedSchematicErrors.LIMIT} : {...base, status: 'loading'};
      const selected = reviewedSelectionTargets(tab.delivery, tab.viewState, targets[0]?.kind === 'net' ? 'net' : 'instances');
      if (targetsKey(targets) !== targetsKey(selected)) preview = {...base, status: 'error', message: '选择已变化，请重新预览当前选中内容。'};
      emit(); if (preview.status === 'error') return;
      const reference: SchematicReference = {kind: 'schematic_reference', projectId, datasetId: tab.delivery.datasetId, documentRef: tab.delivery.documentRef, artifactRef: tab.delivery.artifactRef, sourceDigest: tab.delivery.sourceDigest, adaptedDigest: tab.delivery.adaptedDigest, targets};
      const current = () => !disposed && preview?.generation === base.generation && projectId === base.projectId && sessionId === base.sessionId && ready()?.active && ready()?.key === base.documentKey && selectionKey(ready()!.viewState) === base.selectionKey;
      try {
        const result = parseSchematicPreviewResult(await api.previewSelection({contractVersion: REVIEWED_SCHEMATIC_VERSION, projectId, datasetId: reference.datasetId, documentRef: reference.documentRef, artifactRef: reference.artifactRef, sourceDigest: reference.sourceDigest, adaptedDigest: reference.adaptedDigest, targets}));
        if (!current()) return;
        if (result.ok && !sameReference(result.value.reference, reference)) throw new Error('Preview identity mismatch');
        preview = result.ok ? {...base, status: 'ready', context: result.value} : {...base, status: 'error', message: reviewedSchematicErrors[result.error.code]}; emit();
      } catch {if (current()) {preview = {...base, status: 'error', message: reviewedSchematicErrors.INVALID_REQUEST}; emit();}}
    },
    dismissPreview() {clearPreview(); emit();},
    clearNotice() {notice = ''; emit();},
    async locate(reference: SchematicReference) {
      if (disposed || !projectId) return;
      if (reference.projectId !== projectId) {notice = '引用来自其他项目，无法在当前项目恢复定位；仍可查看已发送摘录。'; emit(); return;}
      const tab = loadingTab(); if (!tab) return;
      try {
        if (!api) throw new Error('Unavailable');
        const result = parseResolveSchematicReferenceResult(await api.resolveReference({contractVersion: REVIEWED_SCHEMATIC_VERSION, projectId: tab.projectId, reference}));
        if (result.ok) {
          if (!sameReference(result.value.reference, reference)) throw new Error('Reference mismatch');
          install(tab, result.value.document, reference);
        } else failed(tab, reviewedSchematicErrors[result.error.code]);
      } catch {failed(tab, reviewedSchematicErrors.REVISION_UNAVAILABLE);}
    },
    dispose() {disposed = true; ++generation; entries.clear(); listeners.clear(); preview = null;},
  };
}
