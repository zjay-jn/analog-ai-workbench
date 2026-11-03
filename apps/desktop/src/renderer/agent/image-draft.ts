import type {ImageAttachment} from '../../shared/agent/image-attachment';
export type ImageDraft={text:string;revision:number;images:ImageAttachment[]};
export function acceptImageDraft(latest:ImageDraft,submitted:ImageDraft):ImageDraft{
 const sentIds=new Set(submitted.images.map(i=>i.id));return {text:latest.revision===submitted.revision?'':latest.text,images:latest.images.filter(i=>!sentIds.has(i.id)),revision:latest.revision+1};
}
