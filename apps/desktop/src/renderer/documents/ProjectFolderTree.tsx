import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {WorkbenchProjectFoldersApi} from '../../shared/agent/project-folders';
import type {FileContext} from '../../shared/agent/file-context';
import {fileSizeLabel,fullFileAttachment} from './attachment-plan';
import {createProjectFolderController,visibleFolderEntries} from './project-folder-controller';
import {windowsFolderPath} from '../agent/use-project-folder-titles';
export function ProjectFolderTree({projectId,sessionId,api,disabled,canAttach,remaining,onOpen,onPreview,onInvalidate,openRequest=0,onOpenHandled}:{projectId:string;sessionId:string;api:WorkbenchProjectFoldersApi;disabled:boolean;canAttach:boolean;remaining:number;onOpen:(file:FileContext,segments:readonly string[])=>boolean;onPreview:(files:FileContext[])=>void;onInvalidate:()=>void;openRequest?:number;onOpenHandled?:(request:number)=>void}){
 const [controller]=useState(()=>createProjectFolderController(projectId,api)),state=useSyncExternalStore(controller.subscribe,controller.snapshot),[expanded,setExpanded]=useState(new Set<string>()),[open,setOpen]=useState(false),[query,setQuery]=useState(''),[checked,setChecked]=useState(new Set<string>()),[error,setError]=useState('');
 const alive=useRef(true),scope=useRef(''),generation=useRef(0);scope.current=projectId+':'+sessionId;
 useEffect(()=>{alive.current=true;void controller.start();return()=>{alive.current=false;generation.current++;controller.dispose();};},[controller]);
 useEffect(()=>{generation.current++;setChecked(new Set());setError('');},[sessionId]);
 useEffect(()=>{setChecked(new Set());setExpanded(new Set());},[state.tree?.treeId,state.binding?.bindingId]);
 const handledOpenRequest=useRef(0),toggle=useRef<HTMLButtonElement>(null);
 useEffect(()=>{const current=controller.snapshot();if(!openRequest||handledOpenRequest.current===openRequest||current.busy)return;handledOpenRequest.current=openRequest;onOpenHandled?.(openRequest);setOpen(true);toggle.current?.focus();if(current.binding&&!current.tree&&!disabled&&!current.fatal)void controller.list();},[openRequest,state.busy,state.binding,state.tree,state.fatal,disabled,controller,onOpenHandled]);
 const invalidate=()=>{generation.current++;setChecked(new Set());setError('');onInvalidate();};
 const expand=()=>{const next=!open;setOpen(next);if(next&&state.binding&&!state.tree&&!state.busy)void controller.list();};
 const refresh=()=>{invalidate();void controller.list();};
 const readFiles=async(ids:string[],preview:boolean)=>{
  if(disabled||state.busy||!ids.length)return;if(preview&&(!canAttach||ids.length>remaining)){setError('每条消息最多2份文件摘录，请先移除已有附件。');return;}
  const owner=scope.current,token=++generation.current;setError('');const results=await controller.open(ids);
  if(!alive.current||token!==generation.current||owner!==scope.current||!results)return;
  if(!preview){const result=results[0]!;if(!onOpen(result.file,result.segments))setError('最多打开8个文档，请先关闭一个标签。');return;}
  try{onPreview(results.map(result=>fullFileAttachment(result.file)));}catch(reason){setError(reason instanceof Error?reason.message:'请打开文件后选择行范围。');}
 };
 const rows=visibleFolderEntries(state.tree?.entries??[],expanded,query),binding=state.binding,blocked=disabled||state.busy||state.fatal;
 return <section className="project-folder-pane" aria-label="项目文件夹" data-project-id={projectId}>
  <div className="project-folder-heading"><button ref={toggle} type="button" className="project-folder-toggle" aria-label={open?'收起项目文件树':'展开项目文件树'} aria-expanded={open} onClick={expand}><span aria-hidden="true">{open?'▾':'▸'}</span><span title={binding?windowsFolderPath(binding.segments):state.busy?'正在读取文件夹关联…':state.error||'未关联文件夹'}>项目文件{binding?' · '+binding.name:''}</span></button></div>
  {open&&<><div className="project-folder-tools"><input type="search" aria-label="查找项目文件名" placeholder="查找文件名" maxLength={120} value={query} disabled={!binding} onChange={event=>setQuery(event.target.value)}/><button type="button" className="icon-button" aria-label="刷新项目文件树" title="刷新文件树" disabled={blocked||!binding} onClick={refresh}>↻</button></div>
   {!binding&&!state.busy&&<p className="project-folder-note">此项目未关联文件夹。新建项目时可选择文件夹。</p>}
   <div className="project-folder-tree" aria-label="项目文件列表">{rows.map(({entry,depth})=><div key={entry.nodeId} className="project-folder-entry" style={{paddingLeft:Math.min(depth,12)*10}} data-node-id={entry.nodeId}>{entry.kind==='directory'?<button type="button" className="project-folder-name" title={entry.name} aria-expanded={expanded.has(entry.nodeId)||!!query} aria-label={(expanded.has(entry.nodeId)?'收起目录 ':'展开目录 ')+entry.name} onClick={()=>setExpanded(current=>{const next=new Set(current);if(next.has(entry.nodeId))next.delete(entry.nodeId);else next.add(entry.nodeId);return next;})}><span aria-hidden="true">{expanded.has(entry.nodeId)||query?'▾':'▸'}</span><span>{entry.name}</span></button>:<><input type="checkbox" aria-label={'选择文件 '+entry.name} checked={checked.has(entry.nodeId)} disabled={blocked||!canAttach} onChange={event=>{const next=new Set(checked);if(event.target.checked){if(next.size>=remaining){setError('每条消息最多2份文件摘录，请先移除附件或取消勾选。');return;}next.add(entry.nodeId);}else next.delete(entry.nodeId);setChecked(next);setError('');}}/><button type="button" className="project-folder-name" title={entry.name+' · '+fileSizeLabel(entry.size)} aria-label={'打开文件 '+entry.name} disabled={blocked} onClick={()=>{void readFiles([entry.nodeId],false);}}><span>{entry.name}</span></button><small>{fileSizeLabel(entry.size)}</small></>}</div>)}</div>
   {binding&&!state.busy&&!rows.length&&<p className="project-folder-note">{state.tree?query?'没有匹配的文件名。':'没有可显示的文本文件。':'点击刷新加载文件树。'}</p>}
   {binding&&<div className="project-folder-footer"><span title="仅列出支持的普通文本文件；隐藏、敏感、链接及超大文件会被排除。">仅支持的文本文件{state.tree?.truncated?' · 列表已达上限':''}</span><button type="button" disabled={blocked||!canAttach||!checked.size} onClick={()=>{void readFiles([...checked],true);}}>预览并加入（{checked.size}）</button></div>}
  </>}
  {(state.busy||state.error||error)&&<p className="project-folder-note" role="status">{state.busy?'正在读取项目文件信息…':error||state.error}</p>}
 </section>;
}
