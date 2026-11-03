import {useEffect,useRef,useState,type ReactNode} from 'react';import {readTextDocument,excerpt,type TextDocument} from './file-input';import type {FileContext} from '../../shared/agent/file-context';
import {emptyFiles,type FilePaneState} from '../../shared/agent/project-workspace';
import {FileSearch} from './FileSearch';
import {FIND_EVENT,requestFind} from '../agent/ChatSearch';
import {ChatMarkdown} from '../agent/ChatMarkdown';
import {FilePathBar} from './FilePathBar';
import {useDisplayPaths} from './use-display-paths';
import {workspaceIsVisible} from '../agent/ToolWorkspaceModes';
import {SidebarContextMenu,sidebarMenuAnchor,type SidebarMenuAnchor,type SidebarMenuAction} from '../agent/SidebarContextMenu';
export type SchematicDocumentTab={key:string;title:string;active:boolean;onSelect:()=>void;onClose:()=>void};
export type SchematicFileSlot={notice?:ReactNode;tabs?:SchematicDocumentTab[];openOptions?:SidebarMenuAction[];opened:boolean;active:boolean;onOpen:()=>void;onSelect:()=>void;onClose:()=>void;onSelectText:()=>void;content:ReactNode};
export type AgentResultSlot={title:string;active:boolean;onSelect:()=>void;onClose:()=>void;onSelectText:()=>void;content:ReactNode};
export type FileViewRequest={file:FileContext;start:number;end:number;serial:number;segments?:readonly string[]};
export function FileWorkbench({onAttach,canAttach,view,onRequestEdit,onSave,canEdit=false,initial=emptyFiles(),onChange,disabled=false,schematic,result,projectFiles}:{result?:AgentResultSlot;schematic?:SchematicFileSlot;projectFiles?:ReactNode;initial?:FilePaneState;onChange?:(state:FilePaneState)=>void;disabled?:boolean;onAttach:(file:FileContext)=>void;canAttach:boolean;view:FileViewRequest|null;onRequestEdit?:(document:TextDocument,excerpt:FileContext)=>void;canEdit?:boolean;onSave?:(document:TextDocument)=>boolean}){
 const workspaceRoot=useRef<HTMLElement>(null);
 const [documents,setDocuments]=useState<TextDocument[]>(initial.documents),[active,setActive]=useState(initial.active),[start,setStart]=useState(initial.start),[end,setEnd]=useState(initial.end),[error,setError]=useState(''),[reading,setReading]=useState(false),[highlight,setHighlight]=useState<{start:number;end:number}|null>(null);
 const [searchOpen,setSearchOpen]=useState(false),searchButton=useRef<HTMLButtonElement>(null);
 const [openMenu,setOpenMenu]=useState<SidebarMenuAnchor|null>(null);
 const resultActive=!!result?.active,schematicActive=!!schematic?.active&&!resultActive,documentActive=!resultActive&&!schematicActive;
 const schematicTabs=schematic?.tabs??(schematic?.opened?[{key:"synthetic",title:"合成原理图",active:schematicActive,onSelect:schematic.onSelect,onClose:schematic.onClose}]:[]);
 useEffect(()=>{setOpenMenu(null);setFileMenu(null);setRangeOpen(false);if(schematicActive)setSearchOpen(false);},[schematicActive]);
 const [fileMenu,setFileMenu]=useState<SidebarMenuAnchor|null>(null),[saveNotice,setSaveNotice]=useState('');
 useEffect(()=>{if(!saveNotice)return;const timer=setTimeout(()=>setSaveNotice(''),2500);return()=>clearTimeout(timer);},[saveNotice]);
 const [rangeOpen,setRangeOpen]=useState(false),rangePanel=useRef<HTMLDivElement>(null);
 useEffect(()=>{setRangeOpen(false);setFileMenu(null);setSaveNotice('');},[active,view]);
 useEffect(()=>{if(!rangeOpen)return;const outside=(event:PointerEvent)=>{if(!rangePanel.current?.contains(event.target as Node))setRangeOpen(false);};const escape=(event:KeyboardEvent)=>{if(workspaceIsVisible(workspaceRoot.current)&&event.key==='Escape'){event.preventDefault();setRangeOpen(false);viewer.current?.focus();}};document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);rangePanel.current?.querySelector('input')?.focus();return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);};},[rangeOpen]);
 const input=useRef<HTMLInputElement>(null),alive=useRef(true),busy=useRef(false),viewer=useRef<HTMLDivElement>(null),sequence=useRef(0);
 const displayPaths=useDisplayPaths(documents);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);

 const [sourceMode,setSourceMode]=useState(false);
 const selected=documents.find(d=>d.id===active);
 const isMarkdown=!!selected&&/\.md$/iu.test(selected.name),preview=isMarkdown&&!sourceMode;
 const openSearch=()=>requestFind(resultActive?'result':'file');
 useEffect(()=>{const find=(event:Event)=>{if(!workspaceIsVisible(workspaceRoot.current))return;const isFile=(event as CustomEvent).detail==='file';setSearchOpen(isFile);if(isFile&&(schematicActive||resultActive)){requestFind('chat');return;}if(isFile)requestAnimationFrame(()=>{if(!workspaceIsVisible(workspaceRoot.current))return;const field=workspaceRoot.current?.querySelector<HTMLInputElement>('.file-search input');field?.focus();field?.select();});};window.addEventListener(FIND_EVENT,find);return()=>window.removeEventListener(FIND_EVENT,find);},[schematicActive,resultActive]);
 const saveCurrent=()=>{if(disabled||!documentActive)return;if(selected&&!onSave?.(selected))setSaveNotice('当前文件没有待保存的修改。');};
 useEffect(()=>{const shortcut=(event:KeyboardEvent)=>{if(!workspaceIsVisible(workspaceRoot.current)||event.defaultPrevented||!event.ctrlKey||event.altKey||event.metaKey||event.isComposing||document.querySelector('dialog[open]'))return;const key=event.key.toLowerCase();if(key==='s'&&!event.shiftKey){event.preventDefault();if(!event.repeat)saveCurrent();}};window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);});

 const changeRef=useRef(onChange),lastSaved=useRef(JSON.stringify(initial));changeRef.current=onChange;
 useEffect(()=>{if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<(selected?.startLine??1)||end<start||end>(selected?.endLine??1))return;const state:FilePaneState={documents,active,start,end},key=JSON.stringify(state);if(key!==lastSaved.current){lastSaved.current=key;changeRef.current?.(state);}},[documents,active,start,end]);

 const activate=(file:TextDocument)=>{schematic?.onSelectText();result?.onSelectText();if(file.id===active)return;setActive(file.id);setStart(file.startLine);setEnd(file.endLine);setHighlight(null);setSourceMode(false);setError('');};
 useEffect(()=>{if(!view)return;schematic?.onSelectText();result?.onSelectText();if(view.segments)void displayPaths.remember(view.file.id,view.file.name,view.segments);setDocuments(current=>[...current.filter(f=>f.id!==view.file.id).slice(-7),view.file]);setActive(view.file.id);setStart(view.file.startLine);setEnd(view.file.endLine);setHighlight({start:view.start,end:view.end});setSourceMode(true);setError('');},[view]);
 useEffect(()=>{if(highlight&&!preview)viewer.current?.querySelector('[data-line="'+highlight.start+'"]')?.scrollIntoView({block:'center'});else if(viewer.current)viewer.current.scrollTop=0;},[active,highlight,preview]);
 let snapshot:FileContext|undefined;try{if(selected)snapshot=excerpt(selected,start,end);}catch{/* Invalid/oversized ranges stay disabled. */}
 const open=async(file:File)=>{
  if(busy.current||disabled)return;if(documents.length>=8){setError('最多打开8个文档，请先关闭一个标签。');return;}
  busy.current=true;setReading(true);setError('');const token=++sequence.current;
  try{const doc=await readTextDocument(file);if(alive.current&&sequence.current===token){void displayPaths.remember(doc.id,doc.name,window.workbenchFilePath?.describe(file)??[]);setDocuments(current=>[...current,doc].slice(-8));activate(doc);}}catch(e){if(alive.current&&sequence.current===token)setError(e instanceof Error?e.message:'无法读取文件。');}finally{busy.current=false;if(alive.current)setReading(false);}
 };
 const close=(id:string)=>{sequence.current++;const remaining=documents.filter(d=>d.id!==id);setDocuments(remaining);if(active===id){const next=remaining.at(-1);if(next)activate(next);else {setActive('');setStart(1);setEnd(1);}}};
 const cycleTab=(direction:number)=>{const keys=[...documents.map(d=>d.id),...schematicTabs.map(tab=>'schematic:'+tab.key),...(result?['agent-result']:[])];if(!keys.length)return;const index=keys.indexOf(resultActive?'agent-result':schematicActive?'schematic:'+schematicTabs.find(tab=>tab.active)?.key:active),key=keys[(index+direction+keys.length)%keys.length];if(key==='agent-result'){schematic?.onSelectText();result?.onSelect();}else if(key?.startsWith('schematic:')){result?.onSelectText();schematicTabs.find(tab=>'schematic:'+tab.key===key)?.onSelect();}else{const file=documents.find(d=>d.id===key);if(file)activate(file);}requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('.file-tab-bar [role="tab"][aria-selected="true"]')?.focus());};
 const openText=()=>{schematic?.onSelectText();result?.onSelectText();input.current?.click();};
 return <aside ref={workspaceRoot} className="document-pane file-workbench" aria-label="真实文件工作区" onKeyDownCapture={e=>{if(!e.ctrlKey||e.altKey||e.metaKey)return;if(e.key.toLowerCase()==='w'&&!e.shiftKey){if(resultActive){e.preventDefault();e.stopPropagation();result?.onClose();}else if(schematicActive){e.preventDefault();e.stopPropagation();schematic?.onClose();}else if(selected){e.preventDefault();e.stopPropagation();close(selected.id);}}if(e.key==='Tab'){e.preventDefault();e.stopPropagation();cycleTab(e.shiftKey?-1:1);}}}>
  <div className="file-tab-bar"><div className="document-tabs" role="tablist" aria-label="文件标签" onKeyDown={e=>{if(e.target instanceof Element&&e.target.getAttribute("role")==="tab"&&(e.key==="ArrowLeft"||e.key==="ArrowRight")){e.preventDefault();cycleTab(e.key==="ArrowLeft"?-1:1);}}}>{documents.map(doc=><div className="document-tab-item" key={doc.id}><button type="button" role="tab" className={'document-tab'+(documentActive&&active===doc.id?' document-tab-active':'')} aria-selected={documentActive&&active===doc.id} aria-controls="file-text-panel" onClick={()=>activate(doc)} title={doc.name}>{doc.name}</button><button type="button" className="document-tab-close" aria-label={'关闭文件 '+doc.name} onClick={()=>close(doc.id)}>×</button></div>)}{schematicTabs.map(tab=><div className="document-tab-item" key={tab.key}><button type="button" role="tab" aria-label={tab.title} aria-controls="file-schematic-panel" aria-selected={!resultActive&&tab.active} className={'document-tab'+(!resultActive&&tab.active?' document-tab-active':'')} title={tab.title+' · 只读'} onClick={()=>{result?.onSelectText();tab.onSelect();}}>{tab.title}</button><button type="button" className="document-tab-close" aria-label={'关闭'+tab.title} onClick={tab.onClose}>×</button></div>)}<span hidden={!result} className="document-tab-item">{result&&<><button type="button" role="tab" aria-controls="file-result-panel" aria-selected={resultActive} className={'document-tab'+(resultActive?' document-tab-active':'')} onClick={()=>{schematic?.onSelectText();result.onSelect();}}>{result.title}</button><button type="button" className="document-tab-close" aria-label="关闭工具结果" onClick={result.onClose}>×</button></>}</span><button type="button" className="document-tab file-open-button" aria-label={schematic?"打开文档":"打开文本文件"} title="打开文档" aria-haspopup={schematic?"menu":undefined} aria-expanded={!!openMenu} disabled={reading||disabled} onClick={event=>{if(schematic)setOpenMenu(sidebarMenuAnchor(event));else openText();}}><span aria-hidden="true">＋</span></button></div><button ref={searchButton} type="button" className="document-tab file-search-toggle" aria-label="查找当前文件" disabled={schematicActive} aria-pressed={searchOpen} title="查找当前文件" onClick={()=>{if(searchOpen)setSearchOpen(false);else openSearch();}}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button></div>
  {openMenu&&<SidebarContextMenu anchor={openMenu} onClose={()=>setOpenMenu(null)} items={[{label:'打开文本文件',action:openText},...((schematic?.openOptions?.map(item=>({...item,action:()=>{result?.onSelectText();item.action?.();}})))??[{label:'打开合成原理图',disabled:disabled,action:()=>{result?.onSelectText();schematic?.onOpen();}}])]}/>}
  {schematic?.notice}
  {projectFiles&&<div className="file-project-browser">{projectFiles}</div>}
  <div className="file-text-panel" id="file-text-panel" role="tabpanel" aria-label="文本文件" hidden={!documentActive}>
  {searchOpen&&<FileSearch key={active} documents={selected?[selected]:[]} onClose={()=>{setSearchOpen(false);searchButton.current?.focus();}} onChoose={hit=>{const doc=documents.find(d=>d.id===hit.documentId);if(!doc)return;setActive(doc.id);setStart(hit.line);setEnd(hit.line);setHighlight({start:hit.line,end:hit.line});setSourceMode(true);setError('');}}/>}
  <input ref={input} type="file" hidden aria-label="选择文本文件" accept=".md,.txt,.js,.ts,.jsx,.tsx,.py,.c,.h,.cpp,.hpp,.css,.html,.json,.yaml,.yml,.toml,.rs,.go,.java,.sql,.csv" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void open(file);}}/>
  {selected&&<FilePathBar name={selected.name} segments={displayPaths.paths.get(selected.id)??[]}/>}
   {rangeOpen&&selected&&<div ref={rangePanel} id="file-range-panel" className="file-range-panel file-range-floating" role="dialog" aria-label="选择文件行范围">
    <div className="file-range-heading"><span>行范围 · 共 {selected.totalLines} 行</span><button type="button" aria-label="关闭行范围" onClick={()=>{setRangeOpen(false);viewer.current?.focus();}}>×</button></div>
    <div className="file-range"><label>起始行<input type="number" aria-label="文件起始行" min={selected.startLine} max={selected.endLine} value={start} onChange={e=>setStart(Number(e.target.value))}/></label><span aria-hidden="true">–</span><label>结束行<input type="number" aria-label="文件结束行" min={start} max={selected.endLine} value={end} onChange={e=>setEnd(Number(e.target.value))}/></label><button type="button" onClick={()=>{setStart(selected.startLine);setEnd(selected.endLine);}}>全部</button></div>
    {!snapshot&&<p className="file-range-error" role="status">请选择有效范围，摘录最多 12 KiB。</p>}
   </div>}
  {displayPaths.error&&<p className="file-error" role="status">{displayPaths.error}</p>}
  {(error||reading)&&<p className="file-error" role="status">{reading?'正在读取本地文件…':error}</p>}
  <div ref={viewer} className={'file-source'+(preview?' file-markdown-preview':'')} role="region" aria-label={preview?'Markdown 预览':'文件原文'} tabIndex={0} onContextMenu={event=>{if(!selected)return;const anchor=sidebarMenuAnchor(event);setFileMenu({...anchor,origin:viewer.current??anchor.origin});}}>{selected?preview?<ChatMarkdown text={selected.text}/>:selected.text.split('\n').map((line,i)=>{const number=selected.startLine+i;return <div className={'file-source-line'+(highlight&&number>=highlight.start&&number<=highlight.end?' file-line-highlight':'')} data-line={number} key={number}><span className="file-line-number" aria-hidden="true">{number}</span><pre>{line||' '}</pre></div>;}):<div className="document-empty-state"><p>打开 .md、.txt 或代码文件</p><p>支持UTF-8，单文件最多256 KiB。可以选择指定行与模型讨论。</p></div>}</div>

  {saveNotice&&<div className="file-save-notice" role="status">{saveNotice}</div>}
  {fileMenu&&selected&&<SidebarContextMenu anchor={fileMenu} onClose={()=>setFileMenu(null)} items={[
   {label:'查找 · Ctrl+F',action:()=>openSearch()},
   {label:'保存 · Ctrl+S',disabled:disabled||!onSave,action:saveCurrent},
   {label:'选择行范围…',action:()=>{setSourceMode(true);setRangeOpen(true);}},
   {label:'加入对话',disabled:!canAttach||!snapshot,action:()=>{if(snapshot){onAttach(snapshot);setSourceMode(true);setHighlight({start,end});}}},
   ...(onRequestEdit?[{label:'请求修改…',disabled:!canEdit||!snapshot||selected.startLine!==1||selected.endLine!==selected.totalLines,action:()=>{if(snapshot)onRequestEdit(selected,snapshot);}}]:[]),
   ...(isMarkdown?[{label:preview?'查看原文':'Markdown 预览',action:()=>{setSourceMode(value=>!value);setRangeOpen(false);}}]:[]),
  ]}/>}
  </div>
  {schematic?.opened&&<div className="file-schematic-panel" id="file-schematic-panel" role="tabpanel" aria-label="原理图标签内容" hidden={!schematicActive}>{schematic.content}</div>}
  {result&&<div className="file-result-panel" id="file-result-panel" role="tabpanel" aria-label="工具结果标签内容" hidden={!resultActive}>{result.content}</div>}
 </aside>;
}
