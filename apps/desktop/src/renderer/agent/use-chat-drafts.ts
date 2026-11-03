import {useEffect,useState,useSyncExternalStore} from 'react';import type {SessionState} from '../../shared/agent/chat-sessions';import type {WorkbenchDraftsApi} from '../../shared/agent/chat-drafts';import {createDraftController} from './draft-controller';
export function useChatDrafts(api:WorkbenchDraftsApi|undefined,state:SessionState|null){const [controller]=useState(()=>createDraftController(api)),snapshot=useSyncExternalStore(controller.subscribe,controller.snapshot);
 useEffect(()=>{void controller.start();return()=>controller.dispose();},[controller]);
 useEffect(()=>{if(state)controller.reconcile(state);},[controller,state,snapshot.status==='loading']);
 useEffect(()=>{const unload=(event:BeforeUnloadEvent)=>{if(controller.snapshot().status==='saving'){event.preventDefault();event.returnValue='';void controller.flush().then(ok=>{if(ok)window.close();});}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[controller]);
 return {...snapshot,...controller,drafts:Object.fromEntries(Object.entries(snapshot.records).map(([id,record])=>[id,record.draft]))};
}
