import type {WorkspaceDisk} from '../../shared/agent/project-workspace';

/** Pins are workspace display metadata; moving a chat does not change its pin. */
export function setSessionPinned(state:WorkspaceDisk,sessionId:string,pinned:boolean):WorkspaceDisk{
 const current=state.pinnedSessionIds??[];
 if(current.includes(sessionId)===pinned)return state;
 return {...state,pinnedSessionIds:pinned?[...current,sessionId]:current.filter(id=>id!==sessionId)};
}

/** Chat storage is authoritative. Reconcile only against a confirmed session list. */
export function reconcileSessionPins(state:WorkspaceDisk,validSessionIds:readonly string[]):WorkspaceDisk{
 const current=state.pinnedSessionIds;
 if(!current?.length)return state;
 const valid=new Set(validSessionIds),next=current.filter(id=>valid.has(id));
 return next.length===current.length?state:{...state,pinnedSessionIds:next};
}
