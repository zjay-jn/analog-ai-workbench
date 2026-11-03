import type {CloudProviderIdV2} from './cloud-chat-api';
export const MODEL_OPTIONS=Object.freeze([
 {provider:'deepseek',id:'deepseek-v4-flash',label:'DeepSeek V4 Flash',vision:false},
 {provider:'deepseek',id:'deepseek-v4-flash-vision-exp',label:'DeepSeek V4 Flash Vision（实验）',vision:true},
 {provider:'kimi',id:'kimi-k3',label:'Kimi K3',vision:true},
] as const);
export const defaultModel=(provider:CloudProviderIdV2)=>provider==='deepseek'?'deepseek-v4-flash':'kimi-k3';
export function modelOption(provider:CloudProviderIdV2,model:string){const found=MODEL_OPTIONS.find(m=>m.provider===provider&&m.id===model);if(!found)throw new TypeError('Unsupported model');return found;}
export const serviceAddress=(provider:CloudProviderIdV2)=>provider==='deepseek'?'https://api.deepseek.com':'https://api.moonshot.cn/v1';
