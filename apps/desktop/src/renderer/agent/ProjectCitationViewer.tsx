import {useEffect,useId,useRef,type ReactNode} from 'react';
import {workspaceIsVisible} from './ToolWorkspaceModes';

/** Display frame only. The caller supplies a host-validated, versioned fragment. */
export function ProjectCitationViewer({title,context,children,onClose,restoreFocus,closeLabel='关闭引用片段',contentLabel='读取时的引用片段'}:{title:string;context:ReactNode;children:ReactNode;onClose:()=>void;restoreFocus:HTMLElement|null;closeLabel?:string;contentLabel?:string}){
  const headingId=useId(),root=useRef<HTMLElement>(null),closeButton=useRef<HTMLButtonElement>(null),close=useRef(onClose);
  close.current=onClose;
  useEffect(()=>{
    const origin=restoreFocus;closeButton.current?.focus();
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.defaultPrevented||!workspaceIsVisible(root.current)||document.querySelector('dialog[open]'))return;
      event.preventDefault();event.stopPropagation();close.current();
    };
    document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('keydown',escape);if(origin?.isConnected&&workspaceIsVisible(origin))origin.focus();};
  },[]);
  return <aside ref={root} className="project-citation-viewer" aria-labelledby={headingId}>
    <header><h2 id={headingId}>{title}</h2><button type="button" ref={closeButton} onClick={onClose} aria-label={closeLabel} title="关闭（Esc）">×</button></header>
    <div className="project-citation-context">{context}</div>
    <div className="project-citation-content" role="region" aria-label={contentLabel} tabIndex={0}>{children}</div>
  </aside>;
}
