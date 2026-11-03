import {useEffect, useRef} from 'react';
import type {SchematicContext} from '../../shared/schematic/reviewed-schematic';

export function SchematicContextPreview({context, loading = false, error = '', onClose, onConfirm, confirmDisabled = false, onLocate}: {
  context?: SchematicContext; loading?: boolean; error?: string; onClose: () => void;
  onConfirm?: () => void; confirmDisabled?: boolean; onLocate?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const origin = document.activeElement;
    dialog.current?.showModal();
    return () => {dialog.current?.close(); if (origin instanceof HTMLElement && origin.isConnected) origin.focus({preventScroll: true});};
  }, []);
  return <dialog ref={dialog} className="schematic-context-preview" aria-label={onConfirm ? '预览原理图摘录' : '查看原理图摘录'} onCancel={event => {event.preventDefault(); onClose();}}>
    <div className="schematic-context-preview-heading"><h3>{onConfirm ? '预览原理图摘录' : '原理图摘录'}</h3><button type="button" aria-label="关闭原理图摘录" onClick={onClose}>×</button></div>
    {loading && <p role="status">正在核对选中内容…</p>}
    {error && <p role="alert">{error}</p>}
    {context && <>
      <p>{context.excerpt.title} · {context.reference.documentRef.revisionId}</p>
      <p>选中 {context.reference.targets.length} 个目标 · {new TextEncoder().encode(JSON.stringify(context)).length} 字节</p>
      {context.excerpt.nets.map(net => <p key={net.id}>网络 {net.name || net.id}：显示 {net.shownMembers} / {net.totalMembers} 个成员{net.truncated ? '（已截断）' : '（完整）'}</p>)}
      <p className="schematic-context-preview-note">端子角色和电气锚点未知。以下为这份摘录的完整内容。</p>
      <pre tabIndex={0} aria-label="原理图摘录完整内容">{JSON.stringify(context, null, 2)}</pre>
    </>}
    <div className="schematic-context-preview-actions"><button type="button" onClick={onClose}>{onConfirm ? '取消' : '关闭'}</button>
      {onLocate && context && <button type="button" onClick={onLocate}>定位原版本</button>}
      {onConfirm && <button type="button" disabled={confirmDisabled || loading || !context} onClick={onConfirm}>加入草稿</button>}
    </div>
    {onConfirm && <p className="schematic-context-preview-note">加入草稿不会发送；点击聊天输入框的发送按钮后才会上传，并随聊天保存。</p>}
  </dialog>;
}
