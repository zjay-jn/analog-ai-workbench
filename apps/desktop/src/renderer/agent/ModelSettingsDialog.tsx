import {useEffect,useRef,useState} from 'react';import {MODEL_OPTIONS} from '../../shared/agent/model-options';
import {SETTINGS_VERSION,parseSettingsResult,type WorkbenchSettingsApi,type SettingsView,type SaveSettingsRequest} from '../../shared/agent/model-settings';
import {OUTPUT_CHOICES,REQUEST_TIMEOUT_CHOICES,TIMEOUT_CHOICES,resolveChatTurnLimits,type ChatReplyLimits} from '../../shared/agent/reply-limits';
import {replyLimitDuration} from './reply-limit-presentation';
const errorText={INVALID_REQUEST:'密钥或模型格式不正确，请检查输入。',CAPABILITY_DENIED:'窗口连接已失效。',BUSY:'请等待回复结束或停止后再修改设置。',STORAGE_ERROR:'设置未保存，原配置保持不变。请检查本地存储。',ENCRYPTION_UNAVAILABLE:'Windows加密存储不可用，无法保存新密钥。'};
export function modelSettingsLimits(source:ChatReplyLimits):Required<ChatReplyLimits>{
 const limits=resolveChatTurnLimits(source);
 return {maxOutputTokens:limits.maxOutputTokens,timeoutMs:limits.requestTimeoutMs,requestTimeoutMs:limits.requestTimeoutMs,turnTimeoutMs:limits.turnTimeoutMs};
}
export function ModelReplyLimitsFields({limits,disabled,onChange}:{limits:Required<ChatReplyLimits>;disabled:boolean;onChange:(value:Required<ChatReplyLimits>)=>void}){
 return <>
  <label>最长回复<select aria-label="输出预算" disabled={disabled} value={limits.maxOutputTokens} onChange={e=>onChange({...limits,maxOutputTokens:Number(e.target.value)})}>{OUTPUT_CHOICES.map(n=><option key={n} value={n}>{n} tokens{n===8192?'（默认）':''}</option>)}</select></label>
  <label>单次模型请求上限<select aria-label="单次模型请求上限" disabled={disabled} value={limits.requestTimeoutMs} onChange={e=>onChange({...limits,requestTimeoutMs:Number(e.target.value),timeoutMs:Number(e.target.value)})}>{REQUEST_TIMEOUT_CHOICES.map(n=><option key={n} value={n}>{replyLimitDuration(n)}</option>)}</select></label>
  <label>整轮任务上限<select aria-label="整轮任务上限" disabled={disabled} value={limits.turnTimeoutMs??'off'} onChange={e=>onChange({...limits,turnTimeoutMs:e.target.value==='off'?null:Number(e.target.value)})}><option value="off">关闭（默认）</option>{TIMEOUT_CHOICES.map(n=><option key={n} value={n}>{replyLimitDuration(n)}</option>)}</select></label>
  <p className="settings-note">单次请求每次重新计时。整轮上限默认关闭；开启后从发送开始计时，包含模型请求、工具执行和等待你答复，工具进展不会延长上限。</p>
  <p className="settings-note">以上设置用于聊天的新轮次。关闭整轮上限时，单次请求、首段响应和接收停滞保护仍然有效；随时可以停止。</p>
 </>;
}
export function ModelSettingsDialog({api,running,onClose,onSaved,purpose='chat',initialProvider='deepseek'}:{api:WorkbenchSettingsApi;running:boolean;onClose:()=>void;onSaved:()=>void;purpose?:'chat'|'tools';initialProvider?:'deepseek'|'kimi'}){
 const dialog=useRef<HTMLDialogElement>(null),[view,setView]=useState<SettingsView|null>(null),[provider,setProvider]=useState<'deepseek'|'kimi'>(initialProvider),[model,setModel]=useState(''),[action,setAction]=useState<SaveSettingsRequest['keyAction']>('retain'),[key,setKey]=useState(''),[pending,setPending]=useState(false),[message,setMessage]=useState('');
 const [limits,setLimits]=useState<Required<ChatReplyLimits>|null>(null);
 useEffect(()=>{dialog.current?.showModal();let active=true;void api.readSettings({contractVersion:SETTINGS_VERSION}).then(raw=>{if(!active)return;const r=parseSettingsResult(raw);if(r.ok){setView(r.value);setProvider(initialProvider);setModel(r.value.providers.find(item=>item.provider===initialProvider)!.model);}else setMessage(errorText[r.error.code]);}).catch(()=>{if(active)setMessage('无法读取模型设置。');});return()=>{active=false;dialog.current?.close();};},[api,initialProvider]);
 const current=view?.providers.find(p=>p.provider===provider);
 useEffect(()=>{if(current)setLimits(modelSettingsLimits(current));},[current]);
 return <dialog className="session-dialog model-settings-dialog" ref={dialog} aria-labelledby="settings-title" onCancel={e=>{e.preventDefault();if(!pending)onClose();}}><form onSubmit={e=>{e.preventDefault();if(pending||running||!limits)return;const request:SaveSettingsRequest={contractVersion:SETTINGS_VERSION,provider,model,keyAction:action,apiKey:action==='replace'?key.trim():'',...limits};setKey('');setPending(true);setMessage('');void api.saveSettings(request).then(raw=>{const result=parseSettingsResult(raw);if(result.ok){setView(result.value);setAction('retain');setMessage(purpose==='tools'?'已保存。服务设置用于后续任务；等待上限用于聊天的新轮次。':'已保存，回复预算和等待上限从下一次发送生效，默认模型用于新会话。');onSaved();}else setMessage(errorText[result.error.code]);}).catch(()=>setMessage('设置保存失败。')).finally(()=>setPending(false));}}>
  <h2 id="settings-title">模型设置</h2>
  {purpose==='tools'&&<p className="settings-note">项目工具任务支持 Kimi K3 和 DeepSeek V4 Flash。在任务区选择下次任务模型；这里配置服务。旧版工具任务仍使用原有时限。</p>}
  <label>服务<select aria-label="设置服务" value={provider} disabled={pending||!view} onChange={e=>{const value=e.target.value as 'deepseek'|'kimi';setProvider(value);setModel(view?.providers.find(p=>p.provider===value)?.model??'');setAction('retain');setKey('');setMessage('');}}><option value="deepseek">DeepSeek</option><option value="kimi">Kimi</option></select></label>
  <label>官方 API 地址<input aria-label="服务地址" value={current?.address??''} readOnly/></label>
  <label>默认模型<select aria-label="默认模型" value={model} disabled={pending||!view} onChange={e=>setModel(e.target.value)}>{MODEL_OPTIONS.filter(m=>m.provider===provider).map(m=><option key={m.id} value={m.id}>{m.label}{purpose!=='tools'&&(m.vision?' · 支持图片':' · 仅文字')}</option>)}</select></label>
  <p className="settings-note">{current?.configured?'已配置':'未配置'} · {current?.source==='encrypted'?'Windows加密保存':current?.source==='file'?'使用原有本机文件':current?.source==='disabled'?'服务已停用':'没有可用密钥'}</p>
  {limits&&current&&<ModelReplyLimitsFields limits={limits} disabled={pending} onChange={setLimits}/>}
  <p className="settings-note">更长回复可能消耗更多额度，思考也可能占用输出预算。</p>
  <label>密钥操作<select aria-label="密钥操作" value={action} disabled={pending||!view} onChange={e=>{setAction(e.target.value as SaveSettingsRequest['keyAction']);setKey('');}}><option value="retain">保留现有密钥</option><option value="replace">输入并保存新密钥</option><option value="disable">停用此服务</option><option value="file">使用原有本机文件中的密钥</option></select></label>
  {action==='replace'&&<label>API 密钥<input aria-label="API 密钥" type="password" value={key} autoComplete="off" spellCheck={false} maxLength={515} disabled={pending} onChange={e=>setKey(e.target.value)}/></label>}
  <p className="settings-note">密钥保存后不回显。保存设置不会发起模型请求。模型是否可调用取决于账户权限。</p>
  {message&&<p role="status">{message}</p>}{running&&<p>有回复正在生成，暂不能保存设置。</p>}{view?.storage==='error'&&<p role="alert">已有设置无法安全读取，未启用文件密钥回退。</p>}
  <div className="session-dialog-actions"><button type="button" disabled={pending} onClick={onClose}>关闭</button><button type="submit" disabled={pending||running||!view||!limits||view.storage==='error'||(action==='replace'&&!key.trim())}>保存设置</button></div>
 </form></dialog>;
}
