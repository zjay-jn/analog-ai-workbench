import {useEffect, useMemo, useRef, useState, type ComponentProps} from 'react';
import {FileWorkbench} from '../documents/FileWorkbench';
import {SchematicViewer} from '../SchematicViewer';
import {createCloudSchematicTabs, type CloudSchematicTab} from './cloud-schematic-tabs';
import {createReviewedSchematicTabs, type ReviewedSchematicTab} from './reviewed-schematic-tabs';
import {ReviewedSchematicInspector, reviewedElementLabels, reviewedSelectionTargets} from './ReviewedSchematicInspector';
import {SchematicContextPreview} from './SchematicContextPreview';
import {buildReviewedSvgSceneV1} from '../../../../../packages/schematic-workbench/src/viewer/reviewed-svg-scene';
import {validateReviewedSchematicEnvelope} from '../../../../../packages/schematic-workbench/src/reviewed-display-validation';
import type {SchematicContext, SchematicReference, SchematicSelectionTarget} from '../../shared/schematic/reviewed-schematic';
import {relatedSchematicQueries, type SchematicQueryLink, type SchematicQueryDestination} from './schematic-query-links';
import {SchematicRelatedQueries} from './SchematicRelatedQueries';

export type SchematicViewRequest = {reference: SchematicReference; serial: number};
type ReviewedReady = Extract<ReviewedSchematicTab, {status: 'ready'}>;
function ReviewedCanvas({tab, canPreview, onAction, onPreview, queryLinks = [], onNavigateQuery, onAskSchematic}: {tab: ReviewedReady; canPreview: boolean;
  onAction: ComponentProps<typeof SchematicViewer>['onAction']; onPreview: (targets: SchematicSelectionTarget[]) => void;
  queryLinks?: readonly SchematicQueryLink[]; onNavigateQuery?: (link: SchematicQueryLink, destination: SchematicQueryDestination) => void; onAskSchematic?: () => void}) {
  const [navigation, setNavigation] = useState<{link: SchematicQueryLink; destination: SchematicQueryDestination} | null>(null);
  useEffect(() => {
    if (!navigation || tab.viewState.inspector !== null) return;
    // Let the viewer finish restoring its own focus before navigation moves focus to chat.
    const timer = setTimeout(() => {setNavigation(null); onNavigateQuery?.(navigation.link, navigation.destination);}, 0);
    return () => clearTimeout(timer);
  }, [navigation, tab.viewState.inspector, onNavigateQuery]);
  const labels = useMemo(() => reviewedElementLabels(tab.delivery), [tab.delivery]);
  const envelope = useMemo(() => {
    try {return validateReviewedSchematicEnvelope({reviewedCircuitIr: tab.delivery.reviewedCircuitIr, display: tab.delivery.display});}
    catch {return null;}
  }, [tab.delivery]);
  const scene = useMemo(() => {
    if (!envelope) return null;
    try {return buildReviewedSvgSceneV1({envelope, artifactRef: tab.delivery.artifactRef, viewState: tab.viewState, renderState: {status: 'ready', freshness: tab.delivery.freshness}});}
    catch {return null;}
  }, [envelope, tab.delivery, tab.viewState]);
  if (!scene) return <p className="cloud-schematic-empty" role="alert">原理图显示数据无法验证，内容未显示。请关闭标签后重试。</p>;
  const instances = reviewedSelectionTargets(tab.delivery, tab.viewState, 'instances'), nets = reviewedSelectionTargets(tab.delivery, tab.viewState, 'net');
  const related = relatedSchematicQueries(tab.delivery, [...instances, ...nets], queryLinks);
  return <SchematicViewer compact fitOnMount={!tab.measured} circuitIr={tab.delivery.reviewedCircuitIr} artifactRef={tab.delivery.artifactRef}
    viewState={tab.viewState} renderState={{status: 'ready', freshness: tab.delivery.freshness}} onAction={onAction}
    reviewedPresentation={{title: tab.delivery.display.source.cell, scene, elementLabels: labels.elements, netLabels: labels.nets,
      inspector: <>{onNavigateQuery && <SchematicRelatedQueries links={related} onNavigate={(link, destination) => {
          setNavigation({link, destination}); onAction({type: 'close-inspector'});
        }}/>}<ReviewedSchematicInspector document={tab.delivery} viewState={tab.viewState}/></>,
      toolbar: <>{onAskSchematic && <button type="button" disabled={!canPreview} onClick={onAskSchematic} title="将电路查询目标加入当前草稿，发送后核对本地副本">用这张电路提问</button>}
        <button type="button" aria-label="预览选中器件" disabled={!canPreview || !instances.length} onClick={() => onPreview(instances)}>预览器件</button>
        {nets.length > 0 && <button type="button" aria-label="预览选中网络" disabled={!canPreview} onClick={() => onPreview(nets)}>预览所属网络</button>}
        {nets.length === 1 && nets[0]?.kind === 'net' && <button type="button" onClick={() => {const net = nets[0]; if (net?.kind === 'net') onAction({type: 'select-net-from-list', definitionId: net.definitionId, occurrencePath: net.occurrencePath, netId: net.netId});}}>高亮整个网络</button>}</>,
    }}/>;
}

export function CloudDocumentWorkspace({projectId, sessionId = '', canAttachSchematic = false, onAttachSchematic, schematicView, queryLinks, onNavigateQuery, onAskSchematic, ...props}:
  ComponentProps<typeof FileWorkbench> & {projectId: string; sessionId?: string; canAttachSchematic?: boolean;
    onAttachSchematic?: (context: SchematicContext, sessionId: string) => {ok: true} | {ok: false; error: string}; schematicView?: SchematicViewRequest | null;
    queryLinks?: readonly SchematicQueryLink[]; onNavigateQuery?: (link: SchematicQueryLink, destination: SchematicQueryDestination) => void;
    onAskSchematic?: () => void}) {
  const controller = useRef<ReturnType<typeof createCloudSchematicTabs> | null>(null), [tabs, setTabs] = useState<CloudSchematicTab[]>([]);
  const reviewedController = useRef<ReturnType<typeof createReviewedSchematicTabs> | null>(null);
  const [reviewed, setReviewed] = useState<ReturnType<ReturnType<typeof createReviewedSchematicTabs>['snapshot']>>({tabs: [], preview: null, descriptors: [], catalogStatus: 'ready', notice: ''});
  const [attachmentError, setAttachmentError] = useState('');
  const api = window.workbenchSchematic, reviewedApi = window.workbenchReviewedSchematic;
  useEffect(() => {
    const model = createCloudSchematicTabs(api); controller.current = model;
    const unsubscribe = model.subscribe(() => setTabs(model.snapshot())); setTabs([]);
    return () => {unsubscribe(); model.dispose(); controller.current = null;};
  }, [api]);
  useEffect(() => {
    const model = createReviewedSchematicTabs(reviewedApi); reviewedController.current = model;
    const unsubscribe = model.subscribe(() => setReviewed(model.snapshot())); setReviewed(model.snapshot());
    return () => {unsubscribe(); model.dispose(); reviewedController.current = null;};
  }, [reviewedApi]);
  useEffect(() => {controller.current?.setProject(projectId);}, [projectId, api]);
  useEffect(() => {reviewedController.current?.setProject(projectId);}, [projectId, reviewedApi]);
  useEffect(() => {reviewedController.current?.setSession(sessionId); setAttachmentError('');}, [projectId, sessionId, reviewedApi]);
  useEffect(() => {setAttachmentError('');}, [reviewed.preview?.generation]);
  useEffect(() => {
    if (!schematicView) return;
    if (schematicView.reference.projectId === projectId) controller.current?.selectText();
    void reviewedController.current?.locate(schematicView.reference);
  }, [schematicView, projectId, reviewedApi]);
  const tab = tabs.find(entry => entry.projectId === projectId), realTab = reviewed.tabs.find(entry => entry.projectId === projectId);
  const selectText = () => {controller.current?.selectText(); reviewedController.current?.selectText();};
  const openSynthetic = () => {reviewedController.current?.selectText(); void controller.current?.open();};
  const selectSynthetic = () => {reviewedController.current?.selectText(); controller.current?.select();};
  const openReviewed = () => {controller.current?.selectText(); void reviewedController.current?.open();};
  const selectReviewed = () => {controller.current?.selectText(); reviewedController.current?.select();};
  const activeReviewed = !!realTab?.active, activeSynthetic = !!tab?.active && !activeReviewed;
  const reviewedDescriptor = reviewed.catalogStatus === 'ready' ? reviewed.descriptors[0] : undefined;
  const realName = realTab?.status === 'ready' ? realTab.delivery.display.source.cell : reviewed.descriptors[0]?.displayName ?? 'FOLDED_CASCODE';
  const preview = reviewed.preview;
  const confirm = () => {
    const current = reviewedController.current?.snapshot().preview;
    if (!canAttachSchematic || !onAttachSchematic || !preview || current !== preview || current.status !== 'ready'
      || current.projectId !== projectId || current.sessionId !== sessionId) return;
    const result = onAttachSchematic(current.context, current.sessionId);
    if (result.ok) {reviewedController.current?.dismissPreview(); setAttachmentError('');} else setAttachmentError(result.error);
  };
  return <>
    <FileWorkbench {...props} key={projectId} schematic={{
      opened: !!tab || !!realTab, active: activeReviewed || activeSynthetic, onOpen: openSynthetic,
      onSelect: activeReviewed ? selectReviewed : selectSynthetic,
      onClose: () => activeReviewed ? reviewedController.current?.close() : controller.current?.close(), onSelectText: selectText,
      tabs: [...(tab ? [{key: 'synthetic', title: '合成原理图', active: activeSynthetic, onSelect: selectSynthetic, onClose: () => controller.current?.close()}] : []),
        ...(realTab ? [{key: 'reviewed', title: realName, active: activeReviewed, onSelect: selectReviewed, onClose: () => reviewedController.current?.close()}] : [])],
      openOptions: [...(reviewedApi && reviewedDescriptor ? [{label: `打开 ${reviewedDescriptor.displayName}`, disabled: !!props.disabled, action: openReviewed}] : []),
        ...(reviewedApi && reviewedDescriptor && onAskSchematic ? [{label: `查询 ${reviewedDescriptor.displayName} 本地副本`, disabled: !canAttachSchematic || !sessionId, action: onAskSchematic}] : []),
        {label: '打开合成原理图', disabled: !!props.disabled, action: openSynthetic}],
      notice: reviewed.notice ? <div className="schematic-notice" role="alert"><span>{reviewed.notice}</span><button type="button" aria-label="关闭原理图提示" onClick={() => reviewedController.current?.clearNotice()}>×</button></div> : null,
      content: activeReviewed && realTab ? <section className="cloud-schematic-panel" aria-label="已导出原理图工作区" data-schematic-kind="reviewed" data-project-id={projectId} data-status={realTab.status} data-document-key={realTab.key}>
        {realTab.status === 'ready' ? <ReviewedCanvas key={realTab.key} tab={realTab} canPreview={canAttachSchematic && !!sessionId}
          {...(queryLinks ? {queryLinks} : {})} {...(onNavigateQuery ? {onNavigateQuery} : {})} {...(onAskSchematic ? {onAskSchematic} : {})}
          onAction={action => reviewedController.current?.action(realTab.key, action)} onPreview={targets => {void reviewedController.current?.previewSelection(targets);}}/>
          : <div className="cloud-schematic-empty" role="status"><p>{realName} · 只读</p><p>{realTab.status === 'loading' ? '正在核对原理图版本…' : realTab.message}</p>
            {realTab.status === 'error' && <button type="button" aria-label="重试打开真实原理图" onClick={() => {void reviewedController.current?.open(true);}}>重试</button>}</div>}
      </section> : activeSynthetic && tab ? <section className="cloud-schematic-panel" aria-label="合成原理图工作区" data-schematic-kind="synthetic" data-project-id={projectId} data-status={tab.status} data-document-key={tab.key}>
        {tab.status === 'ready' ? <SchematicViewer key={tab.key} compact fitOnMount={!tab.measured} circuitIr={tab.delivery.reviewedCircuitIr} artifactRef={tab.delivery.artifactRef} viewState={tab.viewState} renderState={{status: 'ready', freshness: tab.delivery.freshness}} onAction={action => controller.current?.action(tab.key, action)}/>
          : <div className="cloud-schematic-empty" role="status"><p className="cloud-schematic-readonly">合成原理图 · 只读</p><p>{tab.status === 'loading' ? '正在打开原理图…' : tab.message}</p>{tab.status === 'error' && <button type="button" aria-label="重试打开原理图" onClick={() => {void controller.current?.open(true);}}>重试</button>}</div>}
      </section> : null,
    }}/>
    {preview && preview.projectId === projectId && preview.sessionId === sessionId && <SchematicContextPreview key={preview.generation}
      {...(preview.status === 'ready' ? {context: preview.context} : {})} loading={preview.status === 'loading'} error={preview.status === 'error' ? preview.message : attachmentError}
      onClose={() => reviewedController.current?.dismissPreview()} onConfirm={confirm} confirmDisabled={!canAttachSchematic || preview.status !== 'ready'}/>}
  </>;
}
