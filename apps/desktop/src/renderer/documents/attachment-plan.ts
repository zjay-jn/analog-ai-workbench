import {emptyDraft,type ChatDraft} from '../../shared/agent/chat-drafts';
import {FILE_CONTEXT_COUNT,parseFileContext,type FileContext} from '../../shared/agent/file-context';
import {messageContextFits} from '../../shared/schematic/schematic-context';
import {parseWorkspaceFile} from '../../shared/agent/project-workspace';
export type AttachmentPlan={ok:true;draft:ChatDraft}|{ok:false;error:string};
export function planFileAttachments(current:ChatDraft|undefined,incoming:readonly FileContext[]):AttachmentPlan{
 const draft=current??emptyDraft();
 if(!incoming.length)return {ok:false,error:'请先选择要加入的文件。'};
 if(draft.files.length+incoming.length>FILE_CONTEXT_COUNT)return {ok:false,error:'每条消息最多2份文件摘录，请先移除已有附件。'};
 let files:FileContext[];try{files=incoming.map(parseFileContext);}catch{return {ok:false,error:'文件内容或范围无效，每份最多12 KiB；请打开文件后选择较小行范围。'};}
 const combined=[...draft.files,...files];
 if(new Set(combined.map(file=>file.id)).size!==combined.length)return {ok:false,error:'这份文件摘录已经在草稿中。'};
 if(!messageContextFits(draft.text,combined,draft.schematics??[]))return {ok:false,error:'提问、文件和原理图摘录合计超过16 KiB发送预算，请缩短提问或选择较小范围。'};
 return {ok:true,draft:{...draft,files:combined,revision:draft.revision+1}};
}
export function fullFileAttachment(file:FileContext):FileContext{
 // Preview may show a full document; confirmation separately enforces excerpt budgets.
 return parseWorkspaceFile({...file,id:crypto.randomUUID()});
}
export function fileSizeLabel(bytes:number):string{return bytes<1024?`${bytes} B`:`${(bytes/1024).toFixed(1)} KiB`;}
