import type {DesktopBootstrapOptionsV1} from '../bootstrap';import {createAgentCallerFenceV1} from '../agent/agent-caller-fence';
import {draftChannel,draftFailure} from '../../shared/agent/chat-drafts';import {createDraftHost,createDraftStore,type DraftStore} from './draft-host';import type {ImageAttachment} from '../../shared/agent/image-attachment';
export function draftExtension(options:{root:string;directory:string;store?:DraftStore;validateImages?:(images:ImageAttachment[])=>void}):NonNullable<DesktopBootstrapOptionsV1['registerExtension']>{return context=>{
 const host=createDraftHost(options.store??createDraftStore(options.root,options.directory),options.validateImages),fence=createAgentCallerFenceV1({caller:context.owner,capabilities:['start_turn'],generation:1});
 for(const method of ['read','save'] as const){const channel=draftChannel(method);context.ipcMain.removeHandler(channel);context.ipcMain.handle(channel,(event:unknown,value:unknown)=>{try{return host[method](value,fence.authorizeInvocation({caller:context.deriveCallerContext(event),operation:'startTurn'}).allowed);}catch{return draftFailure('CAPABILITY_DENIED');}});}
 return {revoke(){host.revoke();},dispose(){host.revoke();for(const method of ['read','save'] as const)context.ipcMain.removeHandler(draftChannel(method));}};
};}
