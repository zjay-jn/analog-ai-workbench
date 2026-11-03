import {MODEL_OPTIONS} from '../../shared/agent/model-options';
import type {CloudProviderIdV2} from '../../shared/agent/cloud-chat-api';

export function ComposerModelPicker({model,disabled,hasDraftImages,configured,onSelect,onSettings}:{
  model:string;disabled:boolean;hasDraftImages:boolean;
  configured:Record<CloudProviderIdV2,boolean>;
  onSelect:(provider:CloudProviderIdV2,model:string)=>void;
  onSettings?:()=>void;
}):React.JSX.Element {
  return <select className="composer-model-picker" aria-label="当前会话模型" value={model} disabled={disabled}
    title="选择下一次发送使用的模型；当前回复继续使用原模型。"
    onChange={event=>{
      const value=event.target.value;
      if(value==='__settings'){onSettings?.();return;}
      const option=MODEL_OPTIONS.find(item=>item.id===value);
      if(option&&!(hasDraftImages&&!option.vision))onSelect(option.provider,option.id);
    }}>
    {!model&&<option value="" disabled>选择模型</option>}
    {(['deepseek','kimi'] as const).map(provider=><optgroup key={provider} label={provider==='deepseek'?'DeepSeek':'Kimi'}>
      {MODEL_OPTIONS.filter(option=>option.provider===provider).map(option=><option key={option.id} value={option.id} disabled={hasDraftImages&&!option.vision}>
        {option.label}{!configured[provider]?'（未配置）':''}
      </option>)}
    </optgroup>)}
    {onSettings&&<option value="__settings">模型设置…</option>}
  </select>;
}
