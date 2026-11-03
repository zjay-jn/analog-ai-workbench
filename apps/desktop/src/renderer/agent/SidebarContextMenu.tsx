import {useEffect,useLayoutEffect,useRef,useState,type MouseEvent as ReactMouseEvent} from 'react';
import {createPortal} from 'react-dom';
export type SidebarMenuAction={label:string;disabled?:boolean;danger?:boolean;action?:()=>void;children?:SidebarMenuAction[]};
export type SidebarMenuAnchor={x:number;y:number;origin:HTMLElement};
export function sidebarMenuAnchor(event:ReactMouseEvent<HTMLElement>):SidebarMenuAnchor{
 event.preventDefault();event.stopPropagation();
 const origin=event.currentTarget.querySelector<HTMLElement>('button')??event.currentTarget,r=origin.getBoundingClientRect();
 return {x:event.clientX||r.left,y:event.clientY||r.bottom,origin};
}
export function SidebarContextMenu({anchor,items,onClose}:{anchor:SidebarMenuAnchor;items:SidebarMenuAction[];onClose:()=>void}){
 const ref=useRef<HTMLDivElement>(null),[submenu,setSubmenu]=useState<number|null>(null);
 const close=(restore=false)=>{if(restore&&anchor.origin.isConnected)anchor.origin.focus();onClose();};
 const visible=submenu===null?items:items[submenu]?.children??[];
 useLayoutEffect(()=>{const node=ref.current;if(!node)return;const r=node.getBoundingClientRect();node.style.left=`${Math.max(6,Math.min(anchor.x,innerWidth-r.width-6))}px`;node.style.top=`${Math.max(6,Math.min(anchor.y,innerHeight-r.height-6))}px`;node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();},[anchor,submenu]);
 useEffect(()=>{
  const outside=(event:Event)=>{if(!ref.current?.contains(event.target as Node))close();};
  const resize=()=>close();
  document.addEventListener('pointerdown',outside,true);document.addEventListener('contextmenu',outside,true);document.addEventListener('scroll',outside,true);window.addEventListener('resize',resize);window.addEventListener('blur',resize);
  return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('contextmenu',outside,true);document.removeEventListener('scroll',outside,true);window.removeEventListener('resize',resize);window.removeEventListener('blur',resize);};
 },[anchor,onClose]);
 return createPortal(<div ref={ref} role="menu" aria-label={submenu===null?'列表操作':items[submenu]?.label} className="sidebar-context-menu" onContextMenu={e=>e.preventDefault()} onKeyDown={event=>{
  const buttons=Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();}
  if(event.key==='Escape'||event.key==='ArrowLeft'){event.preventDefault();event.stopPropagation();if(submenu!==null)setSubmenu(null);else close(true);}
  if(event.key==='ArrowRight'){event.preventDefault();if(document.activeElement?.getAttribute('aria-haspopup')==='menu')(document.activeElement as HTMLButtonElement).click();}
  if(event.key==='Tab'){event.preventDefault();close(true);}
 }}>
  {submenu!==null&&<button type="button" role="menuitem" className="sidebar-menu-back" onClick={()=>setSubmenu(null)}>‹ 返回</button>}
  {visible.map((item,index)=><button key={index} type="button" role="menuitem" className={item.danger?'sidebar-menu-danger':''} disabled={item.disabled} aria-haspopup={item.children?'menu':undefined} onClick={()=>{if(item.children){setSubmenu(index);return;}close(true);item.action?.();}}><span>{item.label}</span>{item.children&&<span aria-hidden="true">›</span>}</button>)}
 </div>,document.body);
}
