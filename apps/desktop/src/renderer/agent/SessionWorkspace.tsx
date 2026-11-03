import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {SESSION_VERSION,parseSessionResult,type SessionState,type SessionSummary,type SessionMethod,type SessionRequests,type SessionError,type WorkbenchSessionsApi} from '../../shared/agent/chat-sessions';
import {ReplyFooter} from './ReplyFooter';
import {ChatAgentTurn} from './ChatAgentTurn';
import {useChatAgent} from './use-chat-agent';
import {restoreBlockedChatDraft} from './chat-agent-controller';
import {ChatAgentParts,type ChatResultTarget} from './ChatAgentParts';
import {ChatInteractionDock,chatFilesystemRetry,emptyChatInteractionMemory,type ChatInteractionMemory} from './ChatInteractionDock';
import {ChatProjectConfiguration,chatProjectHasBinding} from './ChatProjectConfiguration';
import {createChatProjectBindingController} from './chat-project-binding-controller';
import {ChatAgentResults,chatResultIdentity,type ChatResultRequest} from './ChatAgentResults';
import {ChatToolsDialog,type ChatToolsSection} from './ChatToolsDialog';
import {SidebarShortcuts} from './SidebarShortcuts';
import type {ChatInteractionDecision} from '../../shared/agent/chat-turns';
import {ChatSearch} from './ChatSearch';
import {ChatCopyButton} from './ChatMarkdown';import {StreamingReply} from './StreamingReply';import {isChatNearBottom} from './chat-composer-state';import {cloudEnterSendsV2} from './cloud-controller';
import {MODEL_OPTIONS,defaultModel,modelOption} from '../../shared/agent/model-options';import {SETTINGS_VERSION} from '../../shared/agent/model-settings';import {ModelSettingsDialog} from './ModelSettingsDialog';import {ImagePreview,prepareImage} from './image-input';import type {ImageAttachment} from '../../shared/agent/image-attachment';
import {canContinue,CONTINUE_TEXT} from '../../shared/agent/continuation';
import {fileCitations,textBytes,type FileContext} from '../../shared/agent/file-context';
import {FileAttachmentPreview} from '../documents/FileAttachmentPreview';
import {ProjectFolderTree} from '../documents/ProjectFolderTree';
import {fileSizeLabel,planFileAttachments} from '../documents/attachment-plan';
import {type FileViewRequest} from '../documents/FileWorkbench';
import {CloudDocumentWorkspace,type SchematicViewRequest} from '../schematic/CloudDocumentWorkspace';
import {messageContextFits,schematicCitations} from '../../shared/schematic/schematic-context';
import type {SchematicContext,SchematicReference} from '../../shared/schematic/reviewed-schematic';
import {schematicQueryLinks,appendSchematicQuestion,type SchematicQueryLink,type SchematicQueryDestination} from '../schematic/schematic-query-links';
import {planSchematicAttachment,schematicAttachmentKey,updateDraftText,isCurrentSchematicPreview,type SchematicDraftPreview} from '../schematic/schematic-draft';
import {SchematicContextPreview} from '../schematic/SchematicContextPreview';
import {useEditProposals} from '../documents/EditProposals';
import {useChatScrollLayout} from './use-chat-scroll-layout';
import {ComposerModelPicker} from './ComposerModelPicker';
import {useProjectWorkspace} from './use-project-workspace';
import {ProjectPicker} from './ProjectPicker';
import {setSessionPinned,reconcileSessionPins} from './session-pins';
import {ProjectCreationDialog} from './ProjectCreationDialog';
import {projectChoiceSnapshot,type ToolProjectChoices} from './ProjectTaskScope';
import {createProjectCreationController} from './project-creation-controller';
import {useProjectFolderBindings,projectFolderTooltip} from './use-project-folder-titles';
import {SidebarContextMenu,sidebarMenuAnchor,type SidebarMenuAnchor} from './SidebarContextMenu';
import {emptyFiles,projectForSession,type ProposalJob} from '../../shared/agent/project-workspace';
import {useChatDrafts} from './use-chat-drafts';
import {ClearDraftDialog} from './ClearDraftDialog';
import {submittedTurnMatches} from '../../shared/agent/chat-drafts';
import {EXPORT_VERSION,parseChatExportResult,type ExportCode} from '../../shared/agent/chat-export';
import {runSessionOperation,type SessionOperationOutcome} from './session-operations';
const messages:Record<SessionError,string>={CONFIGURATION_REQUIRED:'当前项目尚未关联目录，请先选择目录或切换到已关联项目。',CONFIGURATION_UNAVAILABLE:'已关联目录不可用或已移动，请恢复原目录或切换到其他已关联项目。',CONFLICT:'记录已变化，请核对当前轮次后再试。',CONTEXT_LIMIT:'聊天历史和附件超过本次上下文容量，消息草稿已保留；请缩小内容或新建会话。',INVALID_REQUEST:'消息或名称格式超出限制，请缩短后再试。',CAPABILITY_DENIED:'连接已失效，请重新打开软件。',NOT_FOUND:'这个会话已不存在。',BUSY:'有回复正在生成，请先停止或等待完成。',LIMIT:'已达到会话或记录容量上限，请整理不再需要的会话后再试。',NOT_CONFIGURED:'所选模型尚未配置。',STORAGE_ERROR:'聊天记录保存失败，已暂停新操作。请先复制重要回复。',SCHEMATIC_UNAVAILABLE:'原理图引用已失效或会话项目不匹配，请重新预览选择，或在原项目使用会话。',INTERNAL:'暂时无法读取会话，请稍后重试。'};
const modelName=(provider:string)=>provider==='kimi'?'Kimi · kimi-k3':'DeepSeek · deepseek-v4-flash';
type Modal={kind:'create'|'rename'|'delete';sessionId:string;title:string;provider:'deepseek'|'kimi';model?:string;projectId?:string};
function SessionDialog({modal,pending,error,defaults,onClose,onSubmit}:{modal:Modal;pending:boolean;error:string;defaults:Record<'deepseek'|'kimi',string>;onClose:()=>void;onSubmit:(title:string,provider:'deepseek'|'kimi',model:string)=>void}){
 const ref=useRef<HTMLDialogElement>(null),[title,setTitle]=useState(modal.title),[provider,setProvider]=useState(modal.provider),[model,setModel]=useState(modal.model??defaults[modal.provider]);
 useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close();},[]);
 return <dialog ref={ref} className="session-dialog" aria-labelledby="session-dialog-title" onCancel={event=>{event.preventDefault();if(!pending)onClose();}}>
  <form onSubmit={event=>{event.preventDefault();onSubmit(title,provider,model);}}>
   <h2 id="session-dialog-title">{modal.kind==='create'?'新建会话':modal.kind==='rename'?'重命名会话':'删除会话'}</h2>
   {modal.kind==='delete'?<p>从工作台删除“{modal.title}”及关联的修改提案？删除后无法恢复；已生成的文件、执行记录及本地引擎保存的历史副本仍会保留。</p>:<label>会话名称<input aria-label="会话名称" value={title} maxLength={60} required autoFocus onChange={e=>setTitle(e.target.value)}/></label>}
   {modal.kind==='create'&&<><label>服务<select aria-label="新会话模型" value={provider} onChange={e=>{const value=e.target.value as 'deepseek'|'kimi';setProvider(value);setModel(defaults[value]);}}><option value="deepseek">DeepSeek</option><option value="kimi">Kimi</option></select></label><label>模型<select aria-label="新会话具体模型" value={model} onChange={e=>setModel(e.target.value)}>{MODEL_OPTIONS.filter(m=>m.provider===provider).map(m=><option key={m.id} value={m.id}>{m.label}{m.vision?' · 支持图片':' · 仅文字'}</option>)}</select></label></>}
   {error&&<p role="alert">{error}</p>}
   <div className="session-dialog-actions"><button type="button" onClick={onClose} disabled={pending} autoFocus={modal.kind==='delete'}>取消</button><button type="submit" className={modal.kind==='delete'?'session-delete-confirm':''} disabled={pending||!title.trim()}>{modal.kind==='delete'?'确认删除':modal.kind==='create'?'创建':'保存名称'}</button></div>
  </form>
 </dialog>;
}
export function SessionWorkspace({api,onProjectChoices,projectCreationRequest=0}:{api:WorkbenchSessionsApi;onProjectChoices?:(choices:ToolProjectChoices)=>void;projectCreationRequest?:number}):React.JSX.Element{
 const [recoveryProjectId,setRecoveryProjectId]=useState(''),[operationNotice,setOperationNotice]=useState('');
 const workspace=useProjectWorkspace(window.workbenchWorkspace,!!window.workbenchProjectFolders),project=workspace.disk?.projects.find(p=>p.id===(recoveryProjectId||workspace.disk?.activeId)),projectId=project?.id??'';
 useEffect(()=>{if(workspace.disk)onProjectChoices?.(projectChoiceSnapshot(projectId,workspace.disk.projects));},[projectId,workspace.disk?.projects,onProjectChoices]);
 const [folderRevision,setFolderRevision]=useState(0),folderStates=useProjectFolderBindings(window.workbenchProjectFolders,workspace.disk?.projects??[],folderRevision);
 const folderTitles=Object.fromEntries((workspace.disk?.projects??[]).map(item=>[item.id,projectFolderTooltip(item.name,folderStates[item.id])]));
 const [bindingController]=useState(()=>createChatProjectBindingController(window.workbenchProjectFolders,()=>setFolderRevision(value=>value+1))),bindingState=useSyncExternalStore(bindingController.subscribe,bindingController.snapshot);
 const [state,setState]=useState<SessionState|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false),[modal,setModal]=useState<Modal|null>(null),[showLatest,setShowLatest]=useState(false);
 const [sessionMenu,setSessionMenu]=useState<{id:string;anchor:SidebarMenuAnchor}|null>(null),menuSession=state?.sessions.find(s=>s.id===sessionMenu?.id);
 const draftStore=useChatDrafts(window.workbenchDrafts,state),drafts=draftStore.drafts,setDrafts=draftStore.change;
 const [sessionQuery,setSessionQuery]=useState(''),[clearDraftId,setClearDraftId]=useState(''),[exporting,setExporting]=useState(false),[exportNotice,setExportNotice]=useState('');
 const [searchOpen,setSearchOpen]=useState(false),searchInput=useRef<HTMLInputElement>(null),searchButton=useRef<HTMLButtonElement>(null);
 const [folderOpenRequest,setFolderOpenRequest]=useState({projectId:'',serial:0});
 useEffect(()=>{setFolderOpenRequest(current=>current.projectId?{...current,projectId:''}:current);},[projectId]);
 useEffect(()=>{if(searchOpen)searchInput.current?.focus();},[searchOpen]);
 const closeSessionSearch=()=>{setSessionQuery('');setSearchOpen(false);searchButton.current?.focus();};
 const interactionMemories=useRef(new Map<string,ChatInteractionMemory>()),configurationSession=useRef('');
 const [resumeConfiguration,setResumeConfiguration]=useState<{sessionId:string;projectId:string}|null>(null),[stopUnconfirmed,setStopUnconfirmed]=useState(false);
 const [toolsMenu,setToolsMenu]=useState<SidebarMenuAnchor|null>(null),[toolsSection,setToolsSection]=useState<ChatToolsSection|null>(null);
 const [resultRequest,setResultRequest]=useState<ChatResultRequest|null>(null),[resultActive,setResultActive]=useState(false),[stopRequested,setStopRequested]=useState('');
 const [settingsOpen,setSettingsOpen]=useState(false),[defaults,setDefaults]=useState({deepseek:defaultModel('deepseek') as string,kimi:defaultModel('kimi') as string}),[preparing,setPreparing]=useState(false),[fileView,setFileView]=useState<(FileViewRequest&{projectId:string})|null>(null);
 const [attachmentPreview,setAttachmentPreview]=useState<{projectId:string;sessionId:string;files:FileContext[]}|null>(null),[attachmentError,setAttachmentError]=useState('');
 const [creationController]=useState(()=>window.workbenchProjectFolders?createProjectCreationController(window.workbenchProjectFolders,workspace.runExternal,()=>{setFolderRevision(value=>value+1);setFileView(null);setSessionQuery('');const owner=configurationSession.current,target=workspace.current().disk?.activeId;if(owner&&target)setResumeConfiguration({sessionId:owner,projectId:target});configurationSession.current='';}):null);
 useEffect(()=>{if(workspace.disk&&creationController)void creationController.start();},[!!workspace.disk,creationController]);
 const [schematicView,setSchematicView]=useState<SchematicViewRequest|null>(null),[viewedSchematic,setViewedSchematic]=useState<SchematicDraftPreview|null>(null);
 const openFile=(file:FileContext,start=file.startLine,end=file.endLine)=>{setResultActive(false);setSchematicView(null);setFileView(current=>({file,start,end,projectId,serial:(current?.serial??0)+1}));};
 const openSchematicReference=(reference:SchematicReference)=>{if(reference.projectId!==projectId)return;setResultActive(false);setFileView(null);setViewedSchematic(null);setSchematicView(current=>({reference,serial:(current?.serial??0)+1}));};
 const openSchematic=(context:SchematicContext)=>openSchematicReference(context.reference);
 const settingsApi=window.workbenchModelSettings,fileInput=useRef<HTMLInputElement>(null),imageEpoch=useRef(0),preparingRef=useRef(false),selectedRef=useRef('');
 const refreshSettings=()=>{void settingsApi?.readSettings({contractVersion:SETTINGS_VERSION}).then(r=>{if(r.ok&&mounted.current)setDefaults({deepseek:r.value.providers.find(p=>p.provider==='deepseek')!.model,kimi:r.value.providers.find(p=>p.provider==='kimi')!.model});}).catch(()=>{});};
 const mounted=useRef(false),working=useRef(false),transcript=useRef<HTMLDivElement>(null),follow=useRef(true),composition=useRef(false);
 const scrollFooter=useRef<HTMLDivElement>(null);
 useChatScrollLayout(transcript,scrollFooter,follow);
 const accept=(raw:unknown)=>{const result=parseSessionResult(raw);if(result.ok){draftStore.reconcile(result.value);setState(current=>current&&current.revision>=result.value.revision?current:result.value);}return result;};
 const followReply=useCallback(()=>{const node=transcript.current;if(!node)return;if(follow.current)node.scrollTop=node.scrollHeight;else setShowLatest(!isChatNearBottom(node.scrollTop,node.clientHeight,node.scrollHeight));},[]);
 useEffect(()=>{
  mounted.current=true;let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
  refreshSettings();
  const poll=async()=>{let delay=500;try{const raw=await api.readState({contractVersion:SESSION_VERSION});if(alive){const r=accept(raw);if(!r.ok)setError(messages[r.error.code]);else if(r.value.runningSessionId)delay=80;}}catch{if(alive)setError(messages.INTERNAL);}finally{if(alive)timer=setTimeout(()=>{void poll();},delay);}};
  void poll();return()=>{alive=false;mounted.current=false;if(timer)clearTimeout(timer);};
 },[api]);
 const callDetailed=async<M extends Exclude<SessionMethod,'readTurnActivity'>>(method:M,request:SessionRequests[M],ownerProjectId=projectId,syncProject=true):Promise<SessionOperationOutcome>=>{
  if(working.current)return {status:'rejected',code:'BUSY'};working.current=true;setPending(true);setError('');
  try{const result=await runSessionOperation(()=>api[method](request),value=>{if(mounted.current)accept({ok:true,value});},async value=>{
   if(!syncProject)return true;if(!mounted.current)return false;
   if((method==='createSession'||method==='selectSession')&&value.selectedId){const sessionId=value.selectedId;if(!workspace.current().disk?.projects.some(p=>p.id===ownerProjectId))return false;return workspace.changeProject(ownerProjectId,p=>({...p,sessionIds:[...new Set([...p.sessionIds,sessionId])],selectedId:sessionId}),true);}
   if(method==='deleteSession'){const removed=(request as SessionRequests['deleteSession']).sessionId;return workspace.change(s=>({...reconcileSessionPins(s,value.sessions.map(row=>row.id)),projects:s.projects.map(p=>({...p,sessionIds:p.sessionIds.filter(sid=>sid!==removed),selectedId:p.selectedId===removed?null:p.selectedId,jobs:p.jobs.filter(j=>j.sessionId!==removed)}))}),true);}
   return true;
  });
  if(mounted.current){if(result.status==='rejected')setError(messages[result.code]);else if(result.status==='uncertain')setError('未收到可靠操作回执，请先核对现有记录，避免重复操作。');else if(result.status==='partial'){
   const disk=workspace.current().disk,target=result.state.selectedId;if(disk&&target&&(method==='createSession'||method==='selectSession')){setRecoveryProjectId(projectForSession(disk,target));setFileView(null);setSessionQuery('');}
   setOperationNotice(method==='createSession'?'会话已创建，但项目归属未能确认保存；已在当前窗口显示默认项目中的会话，请勿重复创建。工作区写入已暂停，重新打开后请核对归属。':method==='selectSession'?'会话已打开，但项目选择未能保存；当前为恢复浏览，工作区写入已暂停。':'会话已删除，但项目关联清理未能保存；请重新打开后核对项目状态。');
  }}return result;}finally{working.current=false;if(mounted.current)setPending(false);}
 };
 const call=async<M extends Exclude<SessionMethod,'readTurnActivity'>>(method:M,request:SessionRequests[M],ownerProjectId=projectId):Promise<boolean>=>(await callDetailed(method,request,ownerProjectId)).status==='accepted';
 const visibleSessions=state?.sessions.filter(s=>workspace.disk&&projectForSession(workspace.disk,s.id)===projectId)??[];
 const selected=state?.selected&&visibleSessions.some(s=>s.id===state.selected?.id)?state.selected:undefined,id=selected?.id??'',draft=drafts[id]??{text:'',revision:0,images:[],files:[]},running=!!state?.runningSessionId,blocked=!!recoveryProjectId||!state||state.storage==='error'||!project||workspace.status==='error'||draftStore.status==='loading'||draftStore.status==='error',vision=!!selected&&modelOption(selected.provider,selected.model??defaultModel(selected.provider)).vision,schematicScopeFits=(draft.schematics??[]).every(context=>context.reference.projectId===projectId),contextFits=schematicScopeFits&&messageContextFits(draft.text,draft.files,draft.schematics??[]),schematicSendReady=!!window.workbenchReviewedSchematic;
 selectedRef.current=id;
 const agent=useChatAgent(api,id,selected?.turns??[]),lastTurn=selected?.turns.at(-1);
 const lastActivity=lastTurn?agent.entries[lastTurn.id]?.activity:null;
 const lastExecution=lastActivity?.execution&&lastActivity.execution.version>=(lastTurn?.execution?.version??0)?lastActivity.execution:lastTurn?.execution;
 const interaction=lastExecution?.pendingInteraction??null;
 const filesystemRetry=chatFilesystemRetry(interaction,state?.capabilities);
 const interactionKey=interaction&&lastTurn?`${id}:${lastTurn.id}:${interaction.interactionId}`:'';
 let interactionMemory=interactionKey?interactionMemories.current.get(interactionKey):undefined;
 if(interactionKey&&!interactionMemory){interactionMemory=emptyChatInteractionMemory();interactionMemories.current.set(interactionKey,interactionMemory);if(interactionMemories.current.size>100)interactionMemories.current.delete(interactionMemories.current.keys().next().value!);}
 const activeTurn=state?.activeTurn??(state?.runningSessionId===id&&selected?.turns.find(turn=>turn.status==='running')?{sessionId:id,turnId:selected.turns.find(turn=>turn.status==='running')!.id,phase:'running' as const}:null);
 const stopKey=activeTurn?`${activeTurn.sessionId}:${activeTurn.turnId}`:'',stopping=!!stopKey&&(stopRequested===stopKey||activeTurn?.phase==='stopping');
 const stop=(retry=false)=>{if(!activeTurn||stopping&&!retry)return;const owner=activeTurn;setStopRequested(`${owner.sessionId}:${owner.turnId}`);setStopUnconfirmed(false);void callDetailed('cancelReply',{contractVersion:SESSION_VERSION,sessionId:owner.sessionId,turnId:owner.turnId}).then(outcome=>{if(outcome.status==='rejected')setStopRequested('');else if(outcome.status==='uncertain'||outcome.status==='partial')setStopUnconfirmed(true);});};
 useEffect(()=>{if(!activeTurn){setStopRequested('');setStopUnconfirmed(false);}},[stopKey]);
 useEffect(()=>{setResultRequest(null);setResultActive(false);},[projectId,id]);
 const openResult=(turnId:string,target:ChatResultTarget)=>{const activity=agent.entries[turnId]?.activity,execution=activity?.execution;if(!activity?.run||!execution?.runLink)return;setResultRequest({sessionId:id,turnId,executionId:execution.executionId,runId:execution.runLink.runId,workspaceId:execution.runLink.workspaceId,activity,target});setResultActive(true);};
 const resultActivity=resultRequest?(agent.entries[resultRequest.turnId]?.activity??resultRequest.activity):null;
 const queryLinks=schematicQueryLinks(id,projectId,selected?.turns??[],agent.entries);
 const navigateSchematicQuery=(link:SchematicQueryLink,destination:SchematicQueryDestination)=>{
  if(link.sessionId!==id||link.reference.projectId!==projectId||!selected?.turns.some(turn=>turn.id===link.turnId))return;
  const turn=Array.from(transcript.current?.querySelectorAll<HTMLElement>('[data-turn-id]')??[]).find(node=>node.dataset.turnId===link.turnId);
  if(!turn)return;follow.current=false;
  const tool=destination==='query'?Array.from(turn.querySelectorAll<HTMLElement>('[data-tool-call]')).find(node=>node.dataset.toolCall===link.callId):null;
  const disclosure=tool?.querySelector('details');if(disclosure)disclosure.open=true;
  const target=tool??turn;target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({block:'center'});
  if(destination==='query')openResult(link.turnId,{kind:'tool',callId:link.callId});
 };
 const askSchematic=()=>{
  if(!id||id!==selectedRef.current||workspace.current().disk?.activeId!==projectId||blocked||pending||working.current||draftStore.hasPending(id))return;
  setDrafts(current=>{
   const latest=current[id]??draft,nextText=appendSchematicQuestion(latest.text);
   if(!messageContextFits(nextText,latest.files,latest.schematics??[])){setError('当前草稿较长，请缩短内容后再加入电路查询目标。');return current;}
   return {...current,[id]:updateDraftText(latest,nextText)};
  });
  requestAnimationFrame(()=>transcript.current?.closest('.conversation-pane')?.querySelector<HTMLTextAreaElement>('textarea[aria-label="云端消息"]')?.focus());
 };
 useEffect(()=>{if(!resultRequest||resultRequest.workspaceId!==null)return;const activity=agent.entries[resultRequest.turnId]?.activity,execution=activity?.execution;if(activity&&execution?.executionId===resultRequest.executionId&&execution.runLink?.runId===resultRequest.runId&&execution.runLink.workspaceId)setResultRequest({...resultRequest,workspaceId:execution.runLink.workspaceId,activity});},[agent.entries,resultRequest]);
 const answerInteraction=async(decision:ChatInteractionDecision,requestId:string):Promise<SessionOperationOutcome>=>{
  if(!lastTurn||!interaction)return {status:'rejected',code:'CONFLICT'};const owner=id,original=lastTurn;
  if(decision.kind==='configuration'&&decision.decision==='retry'&&interaction.kind==='configuration'&&interaction.required==='project_directory'&&!filesystemRetry&&!interactionMemory?.uncertain&&!chatProjectHasBinding(projectId,folderStates))return {status:'rejected',code:'CONFIGURATION_REQUIRED'};
  const outcome=await callDetailed('answerInteraction',{contractVersion:SESSION_VERSION,sessionId:owner,turnId:original.id,interactionId:interaction.interactionId,requestId,decision});
  if(outcome.status==='rejected'&&(outcome.code==='CONFIGURATION_REQUIRED'||outcome.code==='CONFIGURATION_UNAVAILABLE'))setFolderRevision(value=>value+1);
  if(outcome.status==='accepted'&&decision.kind==='configuration'&&decision.decision==='cancel'&&!draftStore.hasPending(owner))setDrafts(current=>({...current,[owner]:restoreBlockedChatDraft(current[owner],original)}));
  return outcome;
 };
 const configureInteraction=()=>{if(interaction?.kind!=='configuration')return;if(interaction.action==='select_model')setSettingsOpen(true);else if(interaction.action==='select_project'){configurationSession.current=id;void creationController?.begin();}else setToolsSection('diagnostics');};
 useEffect(()=>{setSchematicView(null);setViewedSchematic(null);},[projectId,id]);
 const attachSchematic=(context:SchematicContext,ownerSessionId:string):{ok:true}|{ok:false;error:string}=>{
  if(!id||ownerSessionId!==id||ownerSessionId!==selectedRef.current||workspace.current().disk?.activeId!==projectId||blocked||pending||working.current||draftStore.hasPending(id))return {ok:false,error:'会话或保存状态已变化，请重新预览。'};
  const plan=planSchematicAttachment(draftStore.snapshot().records[id]?.draft,context,projectId);
  if(!plan.ok)return plan;
  setDrafts(current=>({...current,[id]:plan.draft}));return {ok:true};
 };
 useEffect(()=>{setAttachmentPreview(null);setAttachmentError('');},[projectId,id]);
 const previewAttachments=(files:FileContext[])=>{if(!id||blocked||working.current)return;setAttachmentError('');setAttachmentPreview({projectId,sessionId:id,files});};
 const attachmentPlan=attachmentPreview?planFileAttachments(draft,attachmentPreview.files):null;
 const confirmAttachments=()=>{
  if(!attachmentPreview||attachmentPreview.projectId!==projectId||attachmentPreview.sessionId!==id||blocked||working.current)return;
  const result=planFileAttachments(draftStore.snapshot().records[id]?.draft,attachmentPreview.files);
  if(!result.ok){setAttachmentError(result.error);return;}
  setDrafts(current=>({...current,[id]:result.draft}));setAttachmentPreview(null);setAttachmentError('');
 };
 const editBlocked=blocked||pending||running||!selected||!state?.configured[selected.provider];
 const composerError=error||draftStore.error||(state?.storage==='error'?messages.STORAGE_ERROR:selected&&!state?.configured[selected.provider]?'所选模型尚未配置，可先浏览已保存的对话。':'');
 const generatingTurn=selected?.turns.find(t=>t.status==='running');
 const modelChangedDuringReply=!!generatingTurn&&generatingTurn.model!==(selected?.model??defaultModel(selected!.provider));
 const changeModel=(provider:'deepseek'|'kimi',model:string)=>{
  if(blocked||pending||preparing||working.current||preparingRef.current||(draft.images.length&&!modelOption(provider,model).vision))return;
  if(id)void call('setSessionModel',{contractVersion:SESSION_VERSION,sessionId:id,provider,model});
  else void call('createSession',{contractVersion:SESSION_VERSION,title:'新会话',provider,model});
 };
 const edits=useEditProposals({scopeId:projectId,jobs:project?.jobs??[],setJobs:(update:(jobs:ProposalJob[])=>ProposalJob[])=>workspace.changeProject(projectId,p=>{const jobs=update(p.jobs);return jobs===p.jobs?p:{...p,jobs};},true),persistenceBlocked:workspace.status==='error'||workspace.status==='saving',sessionId:id,turns:selected?.turns??[],blocked:editBlocked,onSend:async(sessionId,requestId,text,file)=>{follow.current=true;const result=await callDetailed('sendMessage',{contractVersion:SESSION_VERSION,sessionId,requestId,text,images:[],files:[file]});return result.status==='partial'?'uncertain':result.status;},onSaved:file=>openFile(file)});
 useEffect(()=>{imageEpoch.current++;preparingRef.current=false;setPreparing(false);follow.current=true;setShowLatest(false);const node=transcript.current;if(node)node.scrollTop=node.scrollHeight;},[id]);
 useEffect(()=>{const node=transcript.current;if(node){if(follow.current)node.scrollTop=node.scrollHeight;else setShowLatest(!isChatNearBottom(node.scrollTop,node.clientHeight,node.scrollHeight));}},[state?.revision]);
 const send=async()=>{
  if(!id||running||blocked||working.current||preparingRef.current||draftStore.hasPending(id)||!contextFits||(!schematicSendReady&&!!draft.schematics?.length)||(!draft.text.trim()&&!draft.images.length&&!draft.files.length&&!draft.schematics?.length))return;const sessionId=id,submitted=draft,requestId=crypto.randomUUID();follow.current=true;
  if(!await draftStore.beginSend(sessionId,requestId,submitted))return;
  const ok=await call('sendMessage',{contractVersion:SESSION_VERSION,sessionId,requestId,text:submitted.text,images:submitted.images,files:submitted.files,schematics:submitted.schematics??[],...(lastTurn?.execution?.phase==='completed'&&lastTurn.execution.cleanupState==='idle'&&lastTurn.execution.acceptedContext.projectId===projectId?{followUp:{fromTurnId:lastTurn.id,expectedTurnVersion:lastTurn.execution.version}}:{})});
  if(ok){await draftStore.finishSend(sessionId,true);return;}
  try{const recovered=parseSessionResult(await api.readState({contractVersion:SESSION_VERSION}));if(recovered.ok&&recovered.value.storage!=='error'&&recovered.value.selected?.id===sessionId){const turn=recovered.value.selected.turns.find(t=>t.id===requestId);const matches=!!turn&&submittedTurnMatches(turn,submitted);await draftStore.finishSend(sessionId,matches,!turn||matches);accept(recovered);return;}}catch{/* Keep the durable marker until a fresh same-session read can reconcile. */}
  await draftStore.finishSend(sessionId,false,false);
 };
 const addImages=async(files:File[])=>{
  if(!id||preparingRef.current||working.current)return;if(!vision){setError('当前模型仅支持文字，请在输入框下方选择支持图片的模型。');return;}if(!files.length||files.length+draft.images.length>2){setError('每条消息最多添加2张图片。');return;}
  const owner=id,epoch=++imageEpoch.current;preparingRef.current=true;setPreparing(true);setError('');
  try{const images:ImageAttachment[]=[];for(const file of files)images.push(await prepareImage(file));if(mounted.current&&imageEpoch.current===epoch&&selectedRef.current===owner)setDrafts(current=>{const existing=current[owner]??{text:'',revision:0,images:[],files:[]};return {...current,[owner]:{...existing,images:[...existing.images,...images],revision:existing.revision+1}};});}catch(e){if(mounted.current&&imageEpoch.current===epoch)setError(e instanceof Error?e.message:'图片处理失败。');}finally{if(imageEpoch.current===epoch){preparingRef.current=false;if(mounted.current)setPreparing(false);}}
 };
 const restored=useRef('');
 useEffect(()=>{if(!state||!project||restored.current===projectId||recoveryProjectId)return;restored.current=projectId;const desired=visibleSessions.find(s=>s.id===project.selectedId)?.id??(visibleSessions.some(s=>s.id===state.selectedId)?state.selectedId:visibleSessions[0]?.id);if(desired&&desired!==state.selectedId)void call('selectSession',{contractVersion:SESSION_VERSION,sessionId:desired});},[projectId,!!state]);
 const switchProject=async(target:string,sessionId?:string)=>{if(pending||edits.busy||workspace.status==='saving'||workspace.status==='error')return false;if(!await workspace.flush())return false;setError('');setFileView(null);return workspace.change(s=>({...s,activeId:target,...(sessionId?{projects:s.projects.map(p=>p.id===target?{...p,sessionIds:[...new Set([...p.sessionIds,sessionId])],selectedId:sessionId}:p)}:{})}),true);};
 const moveSession=async(moving:string,target:string)=>{if(!workspace.disk||pending||edits.busy||workspace.status==='saving'||workspace.status==='error'||!state?.sessions.some(s=>s.id===moving)||target===projectForSession(workspace.disk,moving))return;if(!await workspace.flush())return;const followMoved=moving===id;if(followMoved)setFileView(null);await workspace.change(s=>{const source=s.projects.find(p=>p.id===projectForSession(s,moving))!,jobs=source.jobs.filter(j=>j.sessionId===moving);return {...s,activeId:followMoved?target:s.activeId,projects:s.projects.map(p=>p.id===target?{...p,sessionIds:[...new Set([...p.sessionIds,moving])],selectedId:followMoved?moving:p.selectedId,jobs:[...p.jobs,...jobs]}:{...p,sessionIds:p.sessionIds.filter(sid=>sid!==moving),selectedId:p.selectedId===moving?null:p.selectedId,jobs:p.jobs.filter(j=>j.sessionId!==moving)})};},true);};
 useEffect(()=>{if(!resumeConfiguration||pending||workspace.status==='saving'||workspace.status==='error')return;const resume=resumeConfiguration;setResumeConfiguration(null);void (async()=>{await moveSession(resume.sessionId,resume.projectId);const disk=workspace.current().disk;if(disk&&projectForSession(disk,resume.sessionId)===resume.projectId)await call('selectSession',{contractVersion:SESSION_VERSION,sessionId:resume.sessionId},resume.projectId);else setOperationNotice('新项目已创建；聊天归属尚未保存，请从聊天右键菜单移入新项目后继续。');})();},[resumeConfiguration,pending,workspace.status]);
 const openCreate=()=>{setSessionQuery('');setSearchOpen(false);setModal({kind:'create',sessionId:'',title:'新会话',provider:selected?.provider??'deepseek',projectId});};
 const exportChat=async(sessionId:string)=>{if(exporting||!window.workbenchChatExport)return;setExporting(true);setExportNotice('');const errors:Record<ExportCode,string>={INVALID_REQUEST:'无法导出这个会话。',CAPABILITY_DENIED:'窗口连接已失效，请重新打开软件。',NOT_FOUND:'这个会话已不存在。',BUSY:'另一个导出尚未结束。',CANCELLED:'已取消导出。',EXISTS:'这个文件已存在，请换一个新文件名。',UNSUPPORTED_FILE:'请选择普通本地文件夹中的新 .md 文件。',WRITE_FAILED:'导出未成功，请检查目标文件夹。',VERIFY_FAILED:'导出未能确认完整，目标位置可能留下部分文件，请检查。'};try{const result=parseChatExportResult(await window.workbenchChatExport.save({contractVersion:EXPORT_VERSION,sessionId}));setExportNotice(result.ok?'聊天已导出为 Markdown。':errors[result.error.code]);}catch{setExportNotice(errors.VERIFY_FAILED);}finally{setExporting(false);}};
 const query=sessionQuery.trim().toLocaleLowerCase(),matchingSessions=state?.sessions.filter(s=>s.title.toLocaleLowerCase().includes(query))??[];
 const pinnedIds=new Set(workspace.disk?.pinnedSessionIds??[]),pinnedSessions=(workspace.disk?.pinnedSessionIds??[]).flatMap(pin=>{const session=matchingSessions.find(s=>s.id===pin);return session?[session]:[];});
 useEffect(()=>{
  if(!state||state.storage!=='saved'||!workspace.disk||!['saved','memory'].includes(workspace.status)||pending||working.current||recoveryProjectId)return;
  const valid=state.sessions.map(row=>row.id);if(reconcileSessionPins(workspace.disk,valid)!==workspace.disk)void workspace.change(s=>reconcileSessionPins(s,valid),true);
 },[state?.sessions.map(row=>row.id).join('|'),state?.storage,workspace.disk?.pinnedSessionIds?.join('|'),workspace.status,pending,recoveryProjectId]);
 const visibleProjectIds=query&&workspace.disk?new Set(matchingSessions.filter(s=>!pinnedIds.has(s.id)).map(s=>projectForSession(workspace.disk!,s.id))):undefined;
 const changePin=async(sessionId:string,pinned:boolean)=>{if(pending||blocked||edits.busy||workspace.status==='saving')return;const saved=await workspace.change(s=>setSessionPinned(reconcileSessionPins(s,state!.sessions.map(row=>row.id)),sessionId,pinned),true);if(!saved&&mounted.current)setOperationNotice('置顶状态未能确认保存，请检查工作区状态。');};
 const renderSession=(session:SessionSummary)=>{
  const target=workspace.disk?projectForSession(workspace.disk,session.id):projectId;
  return <div className={`session-row${id===session.id?' session-row-active':''}`} key={session.id} onContextMenu={event=>setSessionMenu({id:session.id,anchor:sidebarMenuAnchor(event)})}>
   <button type="button" className="session-select" aria-current={id===session.id?'page':undefined} title={`${session.title}${pinnedIds.has(session.id)?' · 已置顶':''}${state?.runningSessionId===session.id?' · 正在回复':''}${drafts[session.id]&&(drafts[session.id]!.text||drafts[session.id]!.images.length||drafts[session.id]!.files.length||drafts[session.id]!.schematics?.length)?' · 草稿':''}`} disabled={pending||edits.busy||workspace.status==='saving'} onClick={()=>{if(workspace.status==='error'||recoveryProjectId){setRecoveryProjectId(target);setFileView(null);void callDetailed('selectSession',{contractVersion:SESSION_VERSION,sessionId:session.id},target,false);}else if(target===projectId)void call('selectSession',{contractVersion:SESSION_VERSION,sessionId:session.id});else void switchProject(target,session.id);}}><strong>{session.title}</strong></button>
   {pinnedIds.has(session.id)&&<button className="session-unpin" type="button" title="取消置顶" aria-label={'取消置顶 '+session.title} disabled={pending||blocked||edits.busy||workspace.status==='saving'} onClick={()=>{void changePin(session.id,false);}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m16 3 5 5-5 2-3 5-4-4 5-3 2-5Z M9 15l-6 6 M7 9l8 8"/></svg></button>}
  </div>;
 };
 const lastProjectCreationRequest=useRef(0);
 useEffect(()=>{
  if(!projectCreationRequest||projectCreationRequest===lastProjectCreationRequest.current||!creationController||!workspace.disk||pending||edits.busy||workspace.status==='saving'||workspace.status==='error')return;
  lastProjectCreationRequest.current=projectCreationRequest;
  const creation=creationController.snapshot();if(creation.uncertain||creation.creation?.status==='pending')void creationController.inspect();else void creationController.begin();
 },[projectCreationRequest,creationController,!!workspace.disk,pending,edits.busy,workspace.status]);
 return <>
  <aside className="task-rail session-rail" aria-label="聊天导航">
   <div className="session-rail-toolbar">
    <SidebarShortcuts projectName={project?.name??''} documents={project?.files.documents??[]} canBrowse={!!project&&!!window.workbenchProjectFolders&&!recoveryProjectId&&workspace.status!=='error'} onOpenDocument={openFile} onBrowse={()=>setFolderOpenRequest(current=>({projectId,serial:current.serial+1}))} session={selected??null} draftImages={draft.images} canAddImages={!!selected&&!blocked&&vision&&!pending&&!preparing&&draft.images.length<2} imageHint={!selected?'选择聊天后可查看或添加图片。':!vision?'当前模型仅支持文字，选择支持图片的模型后可添加。':draft.images.length>=2?'草稿已有2张图片，可在输入框中管理。':'显示当前聊天及草稿中的图片。添加的图片会先放入草稿，发送后才上传。'} onAddImages={()=>fileInput.current?.click()}/>
    <div className="session-rail-actions"><button ref={searchButton} type="button" className="icon-button session-search-toggle" aria-label="搜索聊天" title="搜索聊天" aria-expanded={searchOpen} aria-controls="session-search-input" onClick={()=>{if(searchOpen)closeSessionSearch();else setSearchOpen(true);}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></button><button aria-label="新建会话" title="新建会话" className="icon-button" type="button" disabled={blocked||pending} onClick={openCreate}>＋</button></div>
   </div>
   {searchOpen&&<input id="session-search-input" ref={searchInput} className="session-search" type="search" aria-label="查找会话" placeholder="查找会话" maxLength={60} value={sessionQuery} onChange={e=>setSessionQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeSessionSearch();}}}/>}
   {query&&!matchingSessions.length&&<p className="project-empty" role="status">没有匹配的会话。</p>}
   {(!query||pinnedSessions.length>0)&&<section className="pinned-sessions" aria-label="置顶聊天"><div className="pinned-sessions-heading">置顶</div><div className="pinned-sessions-list">{pinnedSessions.map(renderSession)}</div></section>}
   {creationController&&<ProjectCreationDialog controller={creationController}/>}
   {workspace.disk&&<ProjectPicker folderTitles={folderTitles} {...(visibleProjectIds?{visibleProjectIds,forceExpanded:true}:{})} state={{...workspace.disk,activeId:projectId}} disabled={!!recoveryProjectId||pending||edits.busy||workspace.status==='saving'||workspace.status==='error'} onSwitch={target=>{void switchProject(target);}} onCreate={()=>{configurationSession.current='';void creationController?.begin();}} onName={async(name,_create,renameId)=>workspace.change(s=>({...s,projects:s.projects.map(p=>p.id===renameId?{...p,name}:p)}),true)}
    onCreateSession={target=>{void (async()=>{if(target===projectId||await switchProject(target))setModal({kind:'create',sessionId:'',title:'新会话',provider:'deepseek',projectId:target});})();}}
    renderSessions={target=>matchingSessions.filter(s=>workspace.disk&&projectForSession(workspace.disk,s.id)===target&&!pinnedIds.has(s.id)).map(renderSession)}/>}
   {(operationNotice||workspace.error||workspace.status==='memory'||state?.storage==='error'||draftStore.error||draftStore.status==='memory'||exportNotice)&&<div className="session-rail-notices">
    {operationNotice&&<p role="alert">{operationNotice}</p>}
    {workspace.error?<p role="alert">{workspace.error}</p>:workspace.status==='memory'?<p role="status">当前为临时工作区。</p>:null}
    {state?.storage==='error'&&<p role="alert">记录无法保存或读取，原文件不会被重置。</p>}
    {draftStore.error?<p role="alert">{draftStore.error}</p>:draftStore.status==='memory'?<p role="status">当前草稿仅存内存。</p>:null}
    {exportNotice&&<p role="status">{exportNotice}</p>}
   </div>}
  </aside>
  {sessionMenu&&menuSession&&workspace.disk&&<SidebarContextMenu anchor={sessionMenu.anchor} onClose={()=>setSessionMenu(null)} items={[
   {label:pinnedIds.has(menuSession.id)?'取消置顶':'置顶聊天',disabled:pending||blocked||edits.busy||workspace.status==='saving',action:()=>{void changePin(menuSession.id,!pinnedIds.has(menuSession.id));}},
   {label:'重命名聊天',disabled:pending||blocked||edits.busy||workspace.status==='saving',action:()=>setModal({kind:'rename',sessionId:menuSession.id,title:menuSession.title,provider:menuSession.provider})},
   {label:'移动到项目',disabled:state?.runningSessionId===menuSession.id||pending||blocked||edits.busy||workspace.status==='saving'||workspace.disk.projects.length<2,children:workspace.disk.projects.filter(p=>p.id!==projectForSession(workspace.disk!,menuSession.id)).map(p=>({label:p.name,action:()=>{void moveSession(menuSession.id,p.id);}}))},
   {label:state?.runningSessionId===menuSession.id?'删除聊天（请先停止回复）':'删除聊天',danger:true,disabled:pending||blocked||edits.busy||workspace.status==='saving'||state?.runningSessionId===menuSession.id,action:()=>setModal({kind:'delete',sessionId:menuSession.id,title:menuSession.title,provider:menuSession.provider})},
   {label:exporting?'正在导出…':'导出 Markdown',disabled:exporting||!window.workbenchChatExport,action:()=>{void exportChat(menuSession.id);}},
   {label:'清空草稿',disabled:pending||!drafts[menuSession.id]||!(drafts[menuSession.id]!.text||drafts[menuSession.id]!.images.length||drafts[menuSession.id]!.files.length||drafts[menuSession.id]!.schematics?.length),action:()=>setClearDraftId(menuSession.id)},
  ]}/>}
  <main className="conversation-pane"><section className="agent-panel cloud-agent-panel session-agent-panel" aria-labelledby="cloud-agent-title" data-state={running?'running':'idle'}>
   <div className="agent-panel-heading"><h1 id="cloud-agent-title">{selected?.title??'云端对话'}</h1><button type="button" className="icon-button" aria-label="聊天菜单" aria-haspopup="menu" onClick={event=>setToolsMenu(sidebarMenuAnchor(event))}>···</button></div>
   <ChatSearch transcript={transcript} sessionId={id} onNavigate={()=>{follow.current=false;}}/>
   <div className="chat-scroll-layout">
   <div className="agent-transcript" ref={transcript} tabIndex={-1} aria-label="云端对话记录" onScroll={e=>{const node=e.currentTarget;follow.current=isChatNearBottom(node.scrollTop,node.clientHeight,node.scrollHeight);setShowLatest(!follow.current);}}>
    {!selected?<div className="agent-empty-message"><p>{state?'新建一个会话，开始对话。':'正在读取会话…'}</p><button className="session-new-inline" disabled={blocked||pending} onClick={openCreate}>新建会话</button></div>:!selected.turns.length?<p className="agent-empty-message">发送第一条消息，开始对话。<br/>本会话使用 {selected.model??modelName(selected.provider)}。</p>:null}
    {selected?.turns.map(turn=><ChatAgentTurn key={turn.id} turn={turn} onOpenFile={openFile} onPreviewSchematic={context=>setViewedSchematic({context,projectId,sessionId:id})}><ChatAgentParts turn={turn} activity={agent.entries[turn.id]?.activity??null} error={agent.entries[turn.id]?.error??null} reading={!!agent.entries[turn.id]?.reading} onRetry={()=>agent.retry(turn.id)} onOpen={target=>openResult(turn.id,target)} onAdvance={followReply} onSchematic={openSchematicReference}/><div className="file-citation-list">{fileCitations(turn.assistant,turn.files??[]).map(c=><button type="button" className="chat-copy-button" key={c.label} title={c.file.name+' · 查看已发送原文'} onClick={()=>openFile(c.file,c.start,c.end)}>{c.label} {c.file.name}</button>)}</div><div className="file-citation-list">{schematicCitations(turn.assistant,turn.schematics??[]).map(c=><button type="button" className="chat-copy-button" key={c.label} title="定位已发送摘录的原版本" onClick={()=>openSchematic(c.context)}>{c.label} {c.context.excerpt.title}</button>)}</div><ReplyFooter text={turn.assistant} model={modelOption(turn.provider??selected.provider,turn.model??selected.model??defaultModel(selected.provider)).label} status={turn.status} elapsedMs={turn.elapsedMs} limits={turn.limits} compact={!!turn.execution} error={turn.execution?undefined:turn.error}>{turn.continueFrom&&<small className="reply-metadata">续接上一条未完成的回答</small>}{selected.turns.at(-1)?.id===turn.id&&!turn.execution&&canContinue(turn)&&<button type="button" className="chat-copy-button" aria-label="继续回答" title="将原问题和已收到的内容发送给当前选定模型，发起一次新的续答请求" disabled={blocked||pending||running||!state?.configured[selected.provider]} onClick={()=>{follow.current=true;void call('sendMessage',{contractVersion:SESSION_VERSION,sessionId:id,requestId:crypto.randomUUID(),text:CONTINUE_TEXT,continueFrom:turn.id});}}>继续回答</button>}{selected.turns.at(-1)?.id===turn.id&&turn.execution?.runLink&&['failed','cancelled','interrupted'].includes(turn.execution.phase)&&<button type="button" className="chat-result-link chat-continue-button" disabled={blocked||pending||running||turn.execution.cleanupState!=='idle'} title={turn.execution.cleanupState!=='idle'?'执行收尾尚未确认，暂时不能继续':'继续处理尚未完成的工作'} onClick={()=>void call('sendMessage',{contractVersion:SESSION_VERSION,sessionId:id,requestId:crypto.randomUUID(),text:'继续处理上一轮尚未完成的工作。',followUp:{fromTurnId:turn.id,expectedTurnVersion:turn.execution!.version}})}>继续处理</button>}</ReplyFooter></ChatAgentTurn>)}
   </div>
   <div className="chat-scroll-footer" ref={scrollFooter}>
   {edits.ids.length>0&&<div className="proposal-actions">{edits.ids.map(turnId=><div key={turnId}>{edits.action(turnId)}</div>)}</div>}
   {edits.notice&&<p className="settings-note" role="status">{edits.notice}</p>}
   {showLatest&&<button className="cloud-jump-latest" onClick={()=>{follow.current=true;setShowLatest(false);const node=transcript.current;if(node)node.scrollTop=node.scrollHeight;}}>回到最新回复 ↓</button>}
   {composerError&&<div className="cloud-status" role="status">{composerError}</div>}
   {modelChangedDuringReply&&<div className="model-picker-note" role="status">已选择 {modelOption(selected!.provider,selected!.model??defaultModel(selected!.provider)).label}，下次发送生效；当前回复继续使用原模型。</div>}
   {!vision&&selected?.turns.some(t=>t.images?.length)&&<div className="model-picker-note">当前模型仅接收历史文字，图片仍保留在聊天记录中。</div>}
   {stopUnconfirmed&&activeTurn&&<p className="settings-note" role="status">停止回执尚未确认，仍在核对原轮次。<button type="button" disabled={pending} onClick={()=>stop(true)}>重试原停止请求</button></p>}
   {interaction&&lastTurn&&<ChatInteractionDock key={`${id}:${lastTurn.id}:${interaction.interactionId}`} interaction={interaction} {...(interactionMemory?{memory:interactionMemory}:{})}
    capabilities={state?.capabilities}
    configurationRetryDisabled={interaction.kind==='configuration'&&interaction.required==='project_directory'&&(!filesystemRetry&&!chatProjectHasBinding(projectId,folderStates)||workspace.status==='saving'||bindingState.busy||!!resumeConfiguration)}
    configurationTools={interaction.kind==='configuration'?(interaction.action==='select_model'?<ComposerModelPicker model={selected?.model??''} disabled={pending||blocked} hasDraftImages={draft.images.length>0} configured={state?.configured??{deepseek:false,kimi:false}} onSelect={changeModel}/>:interaction.action==='select_project'?<ChatProjectConfiguration projectId={projectId} projects={workspace.disk?.projects??[]} states={folderStates} disabled={pending||blocked||running||bindingState.busy||workspace.status==='saving'} bindingNotice={bindingState.projectId===projectId?bindingState.notice:''}
     onSelect={target=>{configurationSession.current='';void moveSession(id,target);}} onRefresh={()=>setFolderRevision(value=>value+1)}
     {...(window.workbenchProjectFolders?{onBind:()=>{if(folderStates[projectId]?.status!=='ready'||folderStates[projectId]?.binding||pending||blocked||running||workspace.status==='saving')return;configurationSession.current='';void bindingController.bind(projectId);}}:{})}/>:null):null}
    disabled={pending||blocked||bindingState.busy||workspace.status==='saving'||!!resumeConfiguration} onSubmit={answerInteraction} onConfigure={configureInteraction} onStop={()=>stop()} canStop={!!activeTurn} stopping={stopping}/> }
   <form hidden={!!interaction} className="agent-composer" onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault();void addImages(Array.from(e.dataTransfer.files));}} onPaste={e=>{const files=Array.from(e.clipboardData.files);if(files.length){e.preventDefault();void addImages(files);}}} onSubmit={event=>{event.preventDefault();void send();}}>
    <div className="file-context-list">{draft.files.map((file,i)=><div className="file-context-chip" key={file.id}><button type="button" className="chat-copy-button" title="查看将发送的文件摘录" onClick={()=>openFile(file)}>文件{i+1} · {file.name} · L{file.startLine}–L{file.endLine} · {fileSizeLabel(textBytes(file.text))}</button><button type="button" aria-label={'移除文件 '+file.name} onClick={()=>setDrafts(current=>{const value=current[id]??draft;return {...current,[id]:{...value,revision:value.revision+1,files:value.files.filter(f=>f.id!==file.id)}};})}>×</button></div>)}</div>
    <div className="file-context-list">{(draft.schematics??[]).map((context,i)=><div className="file-context-chip" key={schematicAttachmentKey(context)}><button type="button" className="chat-copy-button" title="查看原理图摘录" onClick={()=>setViewedSchematic({context,projectId,sessionId:id})}>原理图{i+1} · {context.excerpt.title}</button><button type="button" aria-label={'移除原理图 '+context.excerpt.title} onClick={()=>setDrafts(current=>{const value=current[id]??draft;return {...current,[id]:{...value,revision:value.revision+1,schematics:(value.schematics??[]).filter(item=>schematicAttachmentKey(item)!==schematicAttachmentKey(context))}};})}>×</button></div>)}</div>
    {!!draft.schematics?.length&&<p className="settings-note">{!schematicScopeFits?'原理图摘录来自其他项目，请移除后在当前项目重新选择。':!contextFits?'提问、文件和原理图摘录合计超过16 KiB，请缩短内容或移除附件。':!schematicSendReady?'原理图摘录当前仅支持本地预览和草稿，发送尚未启用。':'原理图摘录将在发送时上传，并随聊天保存。'}</p>}
    {draft.files.length>0&&<p className="settings-note">上述摘录将在发送时上传，并随聊天保存。{!contextFits?'提问和附件超出16 KiB上下文限制，请缩短提问或移除附件、缩小范围。':''}</p>}
    <div className="image-preview-list">{draft.images.map(image=><ImagePreview key={image.id} image={image} onRemove={()=>{imageEpoch.current++;preparingRef.current=false;setPreparing(false);setDrafts(current=>{const existing=current[id]??draft;return {...current,[id]:{...existing,images:existing.images.filter(i=>i.id!==image.id),revision:existing.revision+1}};});}}/>)}</div>
    {preparing&&<p className="settings-note" role="status">正在处理图片…</p>}{draft.images.length>0&&<p className="settings-note">图片已压缩，发送时上传并随聊天保存。</p>}
    <textarea aria-label="云端消息" placeholder={running?'可以提前写下一条消息，完成后再发送':vision?'输入文字或粘贴、拖入图片':'输入消息，Enter 发送，Shift+Enter 换行'} value={draft.text} disabled={!selected||draftStore.status==='loading'} maxLength={16384} onChange={e=>{const value=e.target.value;setDrafts(current=>({...current,[id]:updateDraftText(current[id],value)}));}} onCompositionStart={()=>{composition.current=true;}} onCompositionEnd={()=>{composition.current=false;}} onKeyDown={event=>{if(!running&&!pending&&cloudEnterSendsV2({key:event.key,shiftKey:event.shiftKey,isComposing:composition.current||event.nativeEvent.isComposing,keyCode:event.keyCode})){event.preventDefault();void send();}}}/>
    <input ref={fileInput} aria-label="选择图片文件" type="file" hidden accept="image/png,image/jpeg" multiple onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';void addImages(files);}}/>
    <div className="agent-composer-footer"><button className="image-add-button composer-add-button" type="button" aria-label="添加图片" title={vision?'添加图片':'当前模型仅支持文字，请先选择支持图片的模型'} disabled={!vision||pending||preparing} onClick={()=>fileInput.current?.click()}>＋</button><ComposerModelPicker model={selected?.model??(selected?defaultModel(selected.provider):'')} disabled={blocked||pending||preparing} hasDraftImages={draft.images.length>0} configured={state?.configured??{deepseek:false,kimi:false}} onSelect={changeModel} {...(settingsApi?{onSettings:()=>setSettingsOpen(true)}:{})}/>{activeTurn&&<button className="agent-composer-action agent-composer-stop" type="button" aria-label="停止当前轮次" disabled={stopping} onClick={()=>stop()}>{stopping?'正在停止…':'停止'}</button>}<button className="agent-composer-action agent-composer-send" type="submit" aria-label="发送云端消息" disabled={blocked||pending||preparing||running||draftStore.hasPending(id)||!contextFits||(!schematicSendReady&&!!draft.schematics?.length)||!selected||!state?.configured[selected.provider]||(!draft.text.trim()&&!draft.images.length&&!draft.files.length&&!draft.schematics?.length)}>发送</button></div>
   </form>
   </div>
   </div>
  </section></main>
  <CloudDocumentWorkspace
    projectFiles={project&&window.workbenchProjectFolders&&<ProjectFolderTree key={projectId+':'+folderRevision} projectId={projectId} sessionId={id} openRequest={folderOpenRequest.projectId===projectId?folderOpenRequest.serial:0} onOpenHandled={serial=>setFolderOpenRequest(current=>current.projectId===projectId&&current.serial===serial?{...current,projectId:''}:current)} api={window.workbenchProjectFolders} disabled={!!recoveryProjectId||workspace.status==='error'} canAttach={!!selected&&!blocked&&!pending} remaining={Math.max(0,2-draft.files.length)} onOpen={(file,segments)=>{const documents=workspace.current().disk?.projects.find(p=>p.id===projectId)?.files.documents??[];if(documents.length>=8&&!documents.some(doc=>doc.id===file.id))return false;setResultActive(false);setFileView(current=>({file,start:file.startLine,end:file.endLine,segments,projectId,serial:(current?.serial??0)+1}));return true;}} onPreview={previewAttachments} onInvalidate={()=>{setAttachmentPreview(null);setAttachmentError('');}}/>}
    {...(resultRequest&&resultActivity?{result:{title:'工具结果',active:resultActive,onSelect:()=>setResultActive(true),onClose:()=>{setResultRequest(null);setResultActive(false);},onSelectText:()=>setResultActive(false),content:<ChatAgentResults key={chatResultIdentity(resultRequest)} request={resultRequest} activity={resultActivity} api={window.workbenchAgentProjectRead} active={resultActive} onSchematic={openSchematicReference}/>}}:{})} projectId={projectId} sessionId={id} canAttachSchematic={!!selected&&!blocked&&!pending&&!draftStore.hasPending(id)} onAttachSchematic={attachSchematic} schematicView={schematicView} queryLinks={queryLinks} onNavigateQuery={navigateSchematicQuery} onAskSchematic={askSchematic} initial={project?.files??emptyFiles()} disabled={!project||!!recoveryProjectId||workspace.status==='error'} onChange={files=>{void workspace.changeProject(projectId,p=>JSON.stringify(p.files)===JSON.stringify(files)?p:{...p,files});}} view={fileView?.projectId===projectId?fileView:null} canEdit={!editBlocked} onRequestEdit={edits.request} onSave={edits.saveFile} canAttach={!!selected&&!blocked&&!pending} onAttach={file=>previewAttachments([file])}/>
  {viewedSchematic&&isCurrentSchematicPreview(viewedSchematic,projectId,id)&&<SchematicContextPreview context={viewedSchematic.context} onClose={()=>setViewedSchematic(null)} onLocate={()=>{if(isCurrentSchematicPreview(viewedSchematic,workspace.current().disk?.activeId??'',selectedRef.current))openSchematic(viewedSchematic.context);}} confirmDisabled={blocked||pending||draftStore.hasPending(id)||!planSchematicAttachment(draft,viewedSchematic.context,projectId).ok} onConfirm={()=>{if(!isCurrentSchematicPreview(viewedSchematic,workspace.current().disk?.activeId??'',selectedRef.current))return;const result=attachSchematic(viewedSchematic.context,viewedSchematic.sessionId);if(result.ok)setViewedSchematic(null);else setError(result.error);}}/>}
  {attachmentPreview&&attachmentPreview.projectId===projectId&&attachmentPreview.sessionId===id&&<FileAttachmentPreview files={attachmentPreview.files} error={attachmentError||(attachmentPlan&&!attachmentPlan.ok?attachmentPlan.error:blocked?'当前无法修改草稿，请先处理保存状态。':'')} onClose={()=>{setAttachmentPreview(null);setAttachmentError('');}} onConfirm={confirmAttachments}/>}
  {clearDraftId&&<ClearDraftDialog title={state?.sessions.find(s=>s.id===clearDraftId)?.title??'当前会话'} onClose={()=>setClearDraftId('')} onClear={()=>draftStore.clear(clearDraftId)}/>}
  {toolsMenu&&<SidebarContextMenu anchor={toolsMenu} onClose={()=>setToolsMenu(null)} items={[
   {label:'模型设置',disabled:!settingsApi,action:()=>setSettingsOpen(true)},
   {label:'旧工具记录',disabled:!window.workbenchAgentProjectRead,action:()=>setToolsSection('history')},
   {label:'存储用量',disabled:!window.workbenchAgentProjectRead,action:()=>setToolsSection('storage')},
   {label:'诊断与环境',disabled:!window.workbenchAgentProjectRead,action:()=>setToolsSection('diagnostics')},
  ]}/>}
  {toolsSection&&<ChatToolsDialog section={toolsSection} projectId={projectId} onClose={()=>setToolsSection(null)}/>}
  {edits.dialogs}
  {settingsOpen&&settingsApi&&<ModelSettingsDialog api={settingsApi} running={running} onClose={()=>setSettingsOpen(false)} onSaved={refreshSettings}/>}
  {modal&&<SessionDialog key={`${modal.kind}:${modal.sessionId}`} modal={modal} pending={pending} error={error} defaults={defaults} onClose={()=>setModal(null)} onSubmit={(title,provider,model)=>{void (async()=>{
   const result=modal.kind==='create'?await callDetailed('createSession',{contractVersion:SESSION_VERSION,title,provider,model},modal.projectId):modal.kind==='rename'?await callDetailed('renameSession',{contractVersion:SESSION_VERSION,sessionId:modal.sessionId,title}):await callDetailed('deleteSession',{contractVersion:SESSION_VERSION,sessionId:modal.sessionId});if(result.status==='accepted'||result.status==='partial'){if(modal.kind==='delete')setDrafts(current=>Object.fromEntries(Object.entries(current).filter(([key])=>key!==modal.sessionId)));setModal(null);}
  })();}}/>}
 </>;
}
