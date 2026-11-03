import {useEffect,useRef,useState} from 'react';
import type {WorkbenchCloudApiV2,CloudProviderIdV2} from '../../shared/agent/cloud-chat-api';
import {createCloudControllerV2,initialCloudViewV2,cloudEnterSendsV2} from './cloud-controller';
import {ReplyFooter} from './ReplyFooter';
import {modelOption,defaultModel} from '../../shared/agent/model-options';
import {ChatMarkdown,ChatCopyButton} from './ChatMarkdown';
import {clearAcceptedDraft,isChatNearBottom} from './chat-composer-state';
import {useChatScrollLayout} from './use-chat-scroll-layout';
export function CloudAgentPanel({api}:{readonly api:WorkbenchCloudApiV2}):React.JSX.Element {
  const [view,setView]=useState(initialCloudViewV2);
  const [drafts,setDrafts]=useState({deepseek:{text:'',revision:0},kimi:{text:'',revision:0}}),[showLatest,setShowLatest]=useState(false);
  const followTail=useRef(true);
  const controller=useRef<ReturnType<typeof createCloudControllerV2>|null>(null),composition=useRef(false),transcript=useRef<HTMLDivElement|null>(null);
  const scrollFooter=useRef<HTMLDivElement>(null);
  useChatScrollLayout(transcript,scrollFooter,followTail);
  useEffect(()=>{const value=createCloudControllerV2(api,setView);controller.current=value;void value.initialize();return()=>{value.dispose();controller.current=null;};},[api]);
  const turns=view.turns[view.selected],configured=view.providers.find(p=>p.providerId===view.selected)?.configured===true,text=drafts[view.selected].text;
  useEffect(()=>{followTail.current=true;setShowLatest(false);const node=transcript.current;if(node)node.scrollTop=node.scrollHeight;},[view.selected]);
  useEffect(()=>{const node=transcript.current;if(!node)return;if(followTail.current)node.scrollTop=node.scrollHeight;else setShowLatest(!isChatNearBottom(node.scrollTop,node.clientHeight,node.scrollHeight));},[turns]);
  const send=async()=>{
    if(view.busy)return;const provider=view.selected,submitted=drafts[provider];followTail.current=true;setShowLatest(false);
    if(await controller.current?.send(submitted.text))setDrafts(current=>({...current,[provider]:clearAcceptedDraft(current[provider],submitted.revision)}));
  };
  return <section className="agent-panel cloud-agent-panel" aria-labelledby="cloud-agent-title" data-state={view.busy?'running':'idle'}>
    <div className="agent-panel-heading"><h1 id="cloud-agent-title">云端对话</h1></div>
    <label className="cloud-model-label">模型<select aria-label="云端模型" value={view.selected} disabled={!view.ready||view.busy} onChange={event=>controller.current?.select(event.target.value as CloudProviderIdV2)}>{view.providers.map(p=><option key={p.providerId} value={p.providerId} disabled={!p.configured}>{p.displayName} · {p.modelId}{p.configured?'':'（未配置）'}</option>)}</select></label>
    <div className="chat-scroll-layout">
    <div className="agent-transcript" ref={transcript} aria-label="云端对话记录" onScroll={event=>{const node=event.currentTarget;followTail.current=isChatNearBottom(node.scrollTop,node.clientHeight,node.scrollHeight);setShowLatest(!followTail.current);}}>
      {!turns.length&&<p className="agent-empty-message">{view.ready?'发送第一条消息，开始对话。':'正在读取模型配置…'}<br/>各模型使用独立会话；关闭软件后不保留记录。</p>}
      {turns.map(turn=><div key={turn.id} className="cloud-turn" data-turn-state={turn.status}><div className="agent-message agent-user-message"><p>{turn.user}</p><div className="user-copy-actions"><ChatCopyButton text={turn.user} label="复制提问"/></div></div><div className="agent-message cloud-assistant-message">{turn.assistant?<ChatMarkdown text={turn.assistant}/>:<p>{turn.status==='running'?'等待模型回复…':'尚未收到回复。'}</p>}<ReplyFooter text={turn.assistant} model={modelOption(view.selected,defaultModel(view.selected)).label} status={turn.status} elapsedMs={turn.elapsedMs}/>{turn.error&&<p className="cloud-turn-error">{turn.error}</p>}{turn.status==='cancelled'&&<p className="cloud-turn-note">已保留收到的内容；这段未完成回复不会带入下一轮上下文。</p>}</div></div>)}
    </div>
    <div className="chat-scroll-footer" ref={scrollFooter}>
    {showLatest&&<button className="cloud-jump-latest" type="button" onClick={()=>{followTail.current=true;setShowLatest(false);const node=transcript.current;if(node)node.scrollTop=node.scrollHeight;}}>回到最新回复 ↓</button>}
    {view.error&&<div role="status" className="cloud-status">{view.error}</div>}
    <form className="agent-composer" onSubmit={event=>{event.preventDefault();void send();}}>
      <textarea aria-label="云端消息" placeholder={view.busy?'可以提前写下一条消息，完成后再发送':'输入消息，Enter 发送，Shift+Enter 换行'} value={text} disabled={!configured} onChange={event=>{const value=event.target.value,provider=view.selected;setDrafts(current=>({...current,[provider]:{text:value,revision:current[provider].revision+1}}));}} onCompositionStart={()=>{composition.current=true;}} onCompositionEnd={()=>{composition.current=false;}} onKeyDown={event=>{if(!view.busy&&cloudEnterSendsV2({key:event.key,shiftKey:event.shiftKey,isComposing:composition.current||event.nativeEvent.isComposing,keyCode:event.keyCode})){event.preventDefault();void send();}}}/>
      <div className="agent-composer-footer">{view.busy&&<button className="agent-composer-action agent-composer-stop" type="button" aria-label="停止接收回复" onClick={()=>{void controller.current?.cancel();}}>停止</button>}<button className="agent-composer-action agent-composer-send" type="submit" aria-label="发送云端消息" disabled={view.busy||!configured||!text.trim()}>发送</button></div>
    </form>
    </div>
    </div>
  </section>;
}
