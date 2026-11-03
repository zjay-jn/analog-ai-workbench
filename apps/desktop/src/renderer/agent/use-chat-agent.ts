import {useEffect,useRef,useState} from 'react';
import {SESSION_VERSION,parseSessionMethodResult,type SessionTurn,type WorkbenchSessionsApi} from '../../shared/agent/chat-sessions';
import {createChatAgentController,type ChatActivityState} from './chat-agent-controller';

export function useChatAgent(api:WorkbenchSessionsApi,sessionId:string,turns:readonly SessionTurn[]){
 const [state,setState]=useState<ChatActivityState>({sessionId:'',entries:{}}),controller=useRef<ReturnType<typeof createChatAgentController>|null>(null);
 useEffect(()=>{
  const model=createChatAgentController(async(sessionId,turnId,afterSequence)=>{
   const result=parseSessionMethodResult('readTurnActivity',await api.readTurnActivity({contractVersion:SESSION_VERSION,sessionId,turnId,afterSequence}));
   if(!result.ok)throw Error(result.error.code);return result.value;
  });controller.current=model;const off=model.subscribe(()=>setState(model.snapshot()));
  return()=>{off();model.dispose();if(controller.current===model)controller.current=null;};
 },[api]);
 const version=turns.map(turn=>`${turn.id}:${turn.execution?.version??0}`).join('|');
 useEffect(()=>{controller.current?.setSession(sessionId,turns);},[api,sessionId,version]);
 return {entries:state.sessionId===sessionId?state.entries:{},retry:(turnId:string)=>controller.current?.retry(turnId)};
}
