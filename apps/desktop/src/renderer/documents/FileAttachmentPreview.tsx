import {useEffect,useRef} from 'react';
import {textBytes,type FileContext} from '../../shared/agent/file-context';
import {fileSizeLabel} from './attachment-plan';
export function FileAttachmentPreview({files,error,onClose,onConfirm}:{files:readonly FileContext[];error:string;onClose:()=>void;onConfirm:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 return <dialog ref={dialog} className="session-dialog attachment-preview" aria-label="文件附件预览" onCancel={event=>{event.preventDefault();onClose();}}>
  <h2>加入聊天草稿</h2><p>确认下面的内容，点击发送后才会上传。</p>
  <div className="attachment-preview-files">{files.map(file=><section key={file.id}><h3>{file.name}</h3><p>L{file.startLine}–L{file.endLine} · {fileSizeLabel(textBytes(file.text))}</p><pre tabIndex={0} aria-label={'预览 '+file.name}>{file.text}</pre></section>)}</div>
  {error&&<p role="alert">{error}</p>}<div className="session-dialog-actions"><button type="button" autoFocus onClick={onClose}>取消</button><button type="button" disabled={!!error} onClick={onConfirm}>确认加入草稿</button></div>
 </dialog>;
}
