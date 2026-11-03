import {useEffect,useRef,useState} from 'react';
import type {FileContext} from '../../shared/agent/file-context';
import type {ChatSession} from '../../shared/agent/chat-sessions';
import type {ImageAttachment} from '../../shared/agent/image-attachment';
import {ImagePreview} from './image-input';

type Section='schedule'|'library'|'plugins'|'images';
const labels:Record<Section,string>={schedule:'定时任务',library:'资料库',plugins:'插件',images:'图片'};
function ShortcutIcon({section}:{section:Section}){
 return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  {section==='schedule'?<><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2 M5 3 2 6 M19 3l3 3"/></>
   :section==='library'?<><rect x="3" y="4" width="5" height="16" rx="1"/><path d="M11 4v16 M14 5l4-1 4 15-4 1-4-15Z M3 8h5"/></>
   :section==='plugins'?<path d="M9 3H4v6a3 3 0 1 1 0 6v5h5a3 3 0 1 1 6 0h5v-5a3 3 0 1 0 0-6V3h-5a3 3 0 1 1-6 0Z"/>
   :<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></>}
 </svg>;
}
type ShortcutProps={projectName:string;documents:readonly FileContext[];canBrowse:boolean;onBrowse:()=>void;onOpenDocument:(file:FileContext)=>void;session:ChatSession|null;draftImages:readonly ImageAttachment[];canAddImages:boolean;imageHint:string;onAddImages:()=>void};
function ShortcutDialog({section,onClose,...props}:ShortcutProps&{section:Section;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 const savedImages=section==='images'?[...new Map(props.session?.turns.flatMap(turn=>(turn.images??[]).map(image=>[image.id,image] as const))??[]).values()]:[];
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 return <dialog ref={dialog} className="session-dialog sidebar-shortcut-dialog" aria-labelledby="sidebar-shortcut-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <header><h2 id="sidebar-shortcut-title">{labels[section]}</h2><button type="button" className="icon-button" aria-label={'关闭'+labels[section]} onClick={onClose}>×</button></header>
  {section==='schedule'&&<><p>定时执行功能尚未接入。</p><p className="sidebar-shortcut-note">这里将用于设置执行时间和管理定时任务。</p></>}
  {section==='plugins'&&<><p>插件管理功能尚未接入。</p><p className="sidebar-shortcut-note">当前版本暂不支持在这里安装或管理插件。</p></>}
  {section==='library'&&<><p className="sidebar-shortcut-note">当前项目 · {props.projectName||'未选择项目'}</p>
   <div className="sidebar-library-list">{props.documents.map(file=><button key={file.id} type="button" disabled={!props.canBrowse} onClick={()=>{onClose();props.onOpenDocument(file);}} title={file.name}>{file.name}</button>)}</div>
   <p className="sidebar-shortcut-note">这里列出当前项目已打开的文档。可从项目文件中浏览并打开更多资料。</p>
   <div className="session-dialog-actions"><button type="button" disabled={!props.canBrowse} onClick={()=>{onClose();props.onBrowse();}}>浏览项目文件</button></div>
  </>}
  {section==='images'&&<><p className="sidebar-shortcut-note">当前聊天 · {props.session?.title??'未选择聊天'}</p>
   <div className="sidebar-images-grid">{savedImages.map(image=><ImagePreview key={image.id} image={image}/>)}</div>
   {props.draftImages.length>0&&<><h3>草稿中的图片</h3><div className="sidebar-images-grid">{props.draftImages.map(image=><ImagePreview key={image.id} image={image}/>)}</div></>}
   <p className="sidebar-shortcut-note">{props.imageHint}</p>
   <div className="session-dialog-actions"><button type="button" disabled={!props.canAddImages} onClick={()=>{onClose();props.onAddImages();}}>添加到当前聊天</button></div>
  </>}
 </dialog>;
}
/** Shortcuts only project existing local files and attachments; no scheduling or plugin install is started here. */
export function SidebarShortcuts(props:ShortcutProps){
 const [section,setSection]=useState<Section|null>(null);
 return <><div className="sidebar-shortcuts" aria-label="工作区入口">
  {(Object.keys(labels) as Section[]).map(item=><button key={item} type="button" className="icon-button sidebar-shortcut" aria-label={labels[item]} title={labels[item]+(item==='schedule'||item==='plugins'?'（待接入）':'')} aria-haspopup="dialog" onClick={()=>setSection(item)}><ShortcutIcon section={item}/></button>)}
 </div>{section&&<ShortcutDialog {...props} section={section} onClose={()=>setSection(null)}/>}</>;
}
