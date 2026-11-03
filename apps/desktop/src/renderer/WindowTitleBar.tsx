import {useEffect,useRef,useState} from 'react';
import {WINDOW_MENUS,type WindowMenu,type WorkbenchWindowMenuApi} from '../shared/window-menu';
const names={file:'文件',edit:'编辑',view:'视图',window:'窗口',help:'帮助'};
export function WindowTitleBar({api}:{api:WorkbenchWindowMenuApi}):React.JSX.Element{
 const nav=useRef<HTMLElement>(null),previous=useRef<HTMLElement|null>(null),altAlone=useRef(false),pending=useRef(false),[opened,setOpened]=useState<WindowMenu|null>(null);
 const focusFirst=()=>{if(!nav.current?.contains(document.activeElement))previous.current=document.activeElement as HTMLElement;nav.current?.querySelector<HTMLButtonElement>('button')?.focus();};
 const restore=()=>{previous.current?.focus();};
 const open=async(menu:WindowMenu,button:HTMLButtonElement)=>{
  if(pending.current)return;pending.current=true;setOpened(menu);const r=button.getBoundingClientRect();
  // Native editing roles must act on the editor that opened the menu.
  previous.current?.focus();
  try{await api.open({menu,x:Math.max(0,Math.round(r.left)),y:Math.max(0,Math.round(r.bottom))});}catch{/* A closed/revoked window cannot open a menu. */}finally{pending.current=false;setOpened(null);if(button.isConnected)button.focus();}
 };
 useEffect(()=>{
  const keydown=(event:KeyboardEvent)=>{
   if(event.key==='Alt'){altAlone.current=true;return;}altAlone.current=false;
   if(event.key==='F10'&&!event.shiftKey){event.preventDefault();focusFirst();}
   if(event.altKey&&!event.ctrlKey&&!event.metaKey){const index=['f','e','v','w','h'].indexOf(event.key.toLowerCase());if(index>=0){event.preventDefault();focusFirst();nav.current?.querySelectorAll<HTMLButtonElement>('button')[index]?.click();}}
  };
  const keyup=(event:KeyboardEvent)=>{if(event.key==='Alt'&&altAlone.current){event.preventDefault();if(nav.current?.contains(document.activeElement))restore();else focusFirst();altAlone.current=false;}};
  document.addEventListener('keydown',keydown);document.addEventListener('keyup',keyup);
  return()=>{document.removeEventListener('keydown',keydown);document.removeEventListener('keyup',keyup);};
 },[api]);
 return <header className="window-titlebar"><div className="window-titlebar-safe"><span className="window-app-name">Analog AI Workbench</span><nav ref={nav} className="window-menu" aria-label="应用菜单" role="menubar" onFocusCapture={event=>{if(event.relatedTarget instanceof HTMLElement&&!nav.current?.contains(event.relatedTarget))previous.current=event.relatedTarget;}} onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();restore();return;}
  const buttons=Array.from(nav.current?.querySelectorAll<HTMLButtonElement>('button')??[]),index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();buttons[(index+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length]?.focus();}
  if(event.key==='ArrowDown'){event.preventDefault();buttons[index]?.click();}
 }}>{WINDOW_MENUS.map(menu=><button key={menu} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={opened===menu} onMouseDown={()=>{if(!nav.current?.contains(document.activeElement))previous.current=document.activeElement as HTMLElement;}} onClick={event=>{void open(menu,event.currentTarget);}}>{names[menu]}</button>)}</nav></div></header>;
}
