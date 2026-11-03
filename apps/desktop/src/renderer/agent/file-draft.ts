import {acceptImageDraft,type ImageDraft} from './image-draft';import type {FileContext} from '../../shared/agent/file-context';
import type {SchematicContext} from '../../shared/schematic/reviewed-schematic';
import {schematicAttachmentKey} from '../schematic/schematic-draft';
export type FileDraft=ImageDraft&{files:FileContext[];schematics?:SchematicContext[]};
export function acceptFileDraft(latest:FileDraft,submitted:FileDraft):FileDraft{
 const sent=new Set(submitted.files.map(f=>f.id)),sentSchematics=new Set((submitted.schematics??[]).map(schematicAttachmentKey));
 return {...latest,...acceptImageDraft(latest,submitted),files:latest.files.filter(f=>!sent.has(f.id)),...(latest.schematics?{schematics:latest.schematics.filter(context=>!sentSchematics.has(schematicAttachmentKey(context)))}:{})};
}
