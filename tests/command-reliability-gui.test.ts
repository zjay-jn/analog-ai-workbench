import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,isValidElement,type ChangeEvent,type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ModelReplyLimitsFields,modelSettingsLimits} from '../apps/desktop/src/renderer/agent/ModelSettingsDialog';
import {ReplyFooter} from '../apps/desktop/src/renderer/agent/ReplyFooter';
import {replyLimitDuration,replyTurnLimit} from '../apps/desktop/src/renderer/agent/reply-limit-presentation';
import {DEFAULT_CHAT_REPLY_LIMITS,REQUEST_TIMEOUT_CHOICES,type ChatReplyLimits} from '../apps/desktop/src/shared/agent/reply-limits';
import {parseSettingsResult,parseSettingsSave,SETTINGS_VERSION} from '../apps/desktop/src/shared/agent/model-settings';
import {serviceAddress} from '../apps/desktop/src/shared/agent/model-options';
import {parseSessionDisk,type SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';

const no=()=>{},sessionId='11111111-1111-4111-8111-111111111111',turnId='22222222-2222-4222-8222-222222222222',now='2026-09-16T13:00:00.000Z';
type Limits=Required<ChatReplyLimits>;
const fields=(limits:Limits,disabled=false)=>renderToStaticMarkup(createElement(ModelReplyLimitsFields,{limits,disabled,onChange:no}));
const selectHtml=(html:string,label:string)=>html.match(new RegExp(`<select[^>]*aria-label="${label}"[^>]*>(.*?)</select>`))?.[1]??'';
function savedProviders(timeoutMs:number){
 const raw={ok:true,value:{storage:'ready',encryptionAvailable:false,providers:[
  {provider:'deepseek',address:serviceAddress('deepseek'),model:'deepseek-v4-flash',configured:true,source:'file',maxOutputTokens:8192,timeoutMs},
  {provider:'kimi',address:serviceAddress('kimi'),model:'kimi-k3',configured:false,source:'none',maxOutputTokens:16384,timeoutMs:30000},
 ]}};
 const before=JSON.stringify(raw),parsed=parseSettingsResult(raw);assert(parsed.ok);assert.equal(JSON.stringify(raw),before);return parsed.value.providers;
}
type SelectProps={'aria-label'?:string;children?:ReactNode;value?:number|string;disabled?:boolean;onChange?:(event:ChangeEvent<HTMLSelectElement>)=>void};
function selectNode(node:ReactNode,label:string):ReactElement<SelectProps>|undefined{
 if(Array.isArray(node)){for(const child of node){const found=selectNode(child,label);if(found)return found;}return;}
 if(!isValidElement<SelectProps>(node))return;
 return node.type==='select'&&node.props['aria-label']===label?node:selectNode(node.props.children,label);
}
function reopen(turn:SessionTurn){
 return parseSessionDisk({version:6,selectedId:sessionId,sessions:[{id:sessionId,title:'合成时限',provider:'kimi',model:'kimi-k3',createdAt:now,updatedAt:now,turns:[turn]}]}).sessions[0]!.turns[0]!;
}
const footer=(turn:SessionTurn)=>renderToStaticMarkup(createElement(ReplyFooter,{text:turn.assistant,model:'Kimi K3',status:turn.status,elapsedMs:turn.elapsedMs,limits:turn.limits,error:turn.error}));

test('legacy waiting values remain request limits without creating a whole-turn budget or mutating the read view',()=>{
 for(const timeoutMs of REQUEST_TIMEOUT_CHOICES){
  const providers=savedProviders(timeoutMs),source=providers[0]!,before=JSON.stringify(providers),draft=modelSettingsLimits(source);
  assert.equal(source.requestTimeoutMs,undefined);assert.equal(draft.timeoutMs,timeoutMs);assert.equal(draft.requestTimeoutMs,timeoutMs);assert.equal(draft.turnTimeoutMs,null);
  const html=fields(draft);
  assert.match(selectHtml(html,'单次模型请求上限'),new RegExp(`<option value="${timeoutMs}" selected="">`));
  assert.match(selectHtml(html,'整轮任务上限'),/<option value="off" selected="">关闭（默认）<\/option>/);
  assert.doesNotMatch(html,/两项上限|未自动调长|无自动重试/);
  const other=modelSettingsLimits(providers[1]!);assert.equal(other.timeoutMs,30000);assert.equal(other.requestTimeoutMs,30000);assert.equal(other.maxOutputTokens,16384);
  assert.deepEqual(modelSettingsLimits(source),draft);assert.equal(JSON.stringify(providers),before);
  const saved=parseSettingsSave({contractVersion:SETTINGS_VERSION,provider:'deepseek',model:source.model,keyAction:'retain',apiKey:'',...draft});
  assert.equal(saved.timeoutMs,timeoutMs);assert.equal(saved.requestTimeoutMs,timeoutMs);assert.equal(saved.turnTimeoutMs,null);assert.equal(saved.apiKey,'');
 }
});

test('legacy split settings prefer the recorded request limit and only an explicit new turn field enables the total budget',()=>{
 const legacy={maxOutputTokens:8192,timeoutMs:1800000,requestTimeoutMs:120000},before=JSON.stringify(legacy);
 assert.deepEqual(modelSettingsLimits(legacy),{maxOutputTokens:8192,timeoutMs:120000,requestTimeoutMs:120000,turnTimeoutMs:null});
 assert.equal(JSON.stringify(legacy),before);
 for(const turnTimeoutMs of [null,120000,1800000,14400000]){
  const draft=modelSettingsLimits({...legacy,turnTimeoutMs}),saved=parseSettingsSave({contractVersion:SETTINGS_VERSION,provider:'kimi',model:'kimi-k3',keyAction:'retain',apiKey:'',...draft});
  assert.equal(saved.timeoutMs,120000);assert.equal(saved.requestTimeoutMs,120000);assert.equal(saved.turnTimeoutMs,turnTimeoutMs);
  assert.equal(modelSettingsLimits(draft).turnTimeoutMs,turnTimeoutMs);
 }
});

test('new configuration shows a 10 minute request and whole-turn off with separate scope explanations',()=>{
 const draft=modelSettingsLimits(DEFAULT_CHAT_REPLY_LIMITS),html=fields(draft);
 assert.equal(draft.requestTimeoutMs,600000);assert.equal(draft.timeoutMs,600000);assert.equal(draft.turnTimeoutMs,null);
 assert.match(selectHtml(html,'单次模型请求上限'),/<option value="600000" selected="">10 分钟<\/option>/);
 assert.match(selectHtml(html,'整轮任务上限'),/<option value="off" selected="">关闭（默认）<\/option>/);
 assert.doesNotMatch(selectHtml(html,'单次模型请求上限'),/value="14400000"/);assert.match(selectHtml(html,'整轮任务上限'),/value="14400000">4 小时/);
 assert.match(html,/单次请求每次重新计时/);assert.match(html,/开启后从发送开始计时/);assert.match(html,/工具进展不会延长上限/);assert.match(html,/以上设置用于聊天的新轮次/);
 assert.match(html,/关闭整轮上限时，单次请求、首段响应和接收停滞保护仍然有效/);
 assert.doesNotMatch(html,/旧配置|总等待上限|首段模型内容最多等待120秒|无自动重试|(?<!\d)0 (?:秒|小时)/);
});

test('actual select handlers change only the chosen limit and pending controls stay disabled',()=>{
 const initial=modelSettingsLimits(DEFAULT_CHAT_REPLY_LIMITS),changes:Limits[]=[];
 const tree=ModelReplyLimitsFields({limits:initial,disabled:false,onChange:value=>changes.push(value)});
 const request=selectNode(tree,'单次模型请求上限')!,turn=selectNode(tree,'整轮任务上限')!;
 request.props.onChange!({target:{value:'120000'}} as ChangeEvent<HTMLSelectElement>);
 assert.deepEqual(changes[0],{maxOutputTokens:8192,requestTimeoutMs:120000,timeoutMs:120000,turnTimeoutMs:null});
 turn.props.onChange!({target:{value:'14400000'}} as ChangeEvent<HTMLSelectElement>);
 assert.deepEqual(changes[1],{maxOutputTokens:8192,requestTimeoutMs:600000,timeoutMs:600000,turnTimeoutMs:14400000});
 const enabled=ModelReplyLimitsFields({limits:changes[1]!,disabled:false,onChange:value=>changes.push(value)});
 selectNode(enabled,'整轮任务上限')!.props.onChange!({target:{value:'off'}} as ChangeEvent<HTMLSelectElement>);
 assert.deepEqual(changes[2],initial);
 selectNode(enabled,'单次模型请求上限')!.props.onChange!({target:{value:'30000'}} as ChangeEvent<HTMLSelectElement>);
 assert.deepEqual(changes[3],{maxOutputTokens:8192,requestTimeoutMs:30000,timeoutMs:30000,turnTimeoutMs:14400000});
 for(const limits of changes){const saved=parseSettingsSave({contractVersion:SETTINGS_VERSION,provider:'kimi',model:'kimi-k3',keyAction:'retain',apiKey:'',...limits});assert.equal(saved.timeoutMs,saved.requestTimeoutMs);}
 assert.deepEqual(initial,modelSettingsLimits(DEFAULT_CHAT_REPLY_LIMITS));
 const disabled=ModelReplyLimitsFields({limits:initial,disabled:true,onChange:no});
 for(const label of ['输出预算','单次模型请求上限','整轮任务上限'])assert.equal(selectNode(disabled,label)!.props.disabled,true);
});

test('per-turn limits reopen from the accepted snapshot and do not follow subsequently edited settings',()=>{
 const turn:SessionTurn={id:turnId,user:'合成任务',assistant:'保留内容',status:'completed',error:'',elapsedMs:65321,limits:{maxOutputTokens:16384,requestTimeoutMs:120000,turnTimeoutMs:300000}};
 const editedSettings=modelSettingsLimits(DEFAULT_CHAT_REPLY_LIMITS);editedSettings.turnTimeoutMs=14400000;editedSettings.requestTimeoutMs=900000;editedSettings.timeoutMs=900000;
 const html=footer(reopen(turn));
 assert.match(html,/<details class="reply-limits" aria-label="本轮使用的设置">/);assert.doesNotMatch(html,/<details[^>]* open=/);
 assert.match(html,/单次模型请求上限：2 分钟 · 整轮任务上限：5 分钟/);assert.match(html,/输出预算：16384 tokens/);
 assert.match(html,/title="本轮从开始到结束的耗时"/);assert.match(html,/1分5秒/);assert.doesNotMatch(html,/4 小时|15 分钟|本次请求从开始到结束/);
});

test('a new running turn keeps its accepted off snapshot and is not shown as failed while later settings enable a deadline',()=>{
 const turn:SessionTurn={id:turnId,user:'合成任务',assistant:'',status:'running',error:'',limits:{maxOutputTokens:8192,requestTimeoutMs:120000,turnTimeoutMs:null}};
 const laterSettings=modelSettingsLimits({maxOutputTokens:8192,timeoutMs:900000,requestTimeoutMs:900000,turnTimeoutMs:300000});
 assert.equal(laterSettings.turnTimeoutMs,300000);
 const reopened=reopen(turn),html=footer(reopened);assert.deepEqual(reopened.limits,turn.limits);
 assert.match(html,/正在回复/);assert.match(html,/单次模型请求上限：2 分钟 · 整轮任务上限：关闭/);
 assert.doesNotMatch(html,/回复未完成|cloud-turn-error|0 秒|0 小时|5 分钟|15 分钟/);
});

test('old history preserves its original timeout explanation and does not acquire guessed limits or timing',()=>{
 const old:SessionTurn={id:turnId,user:'旧合成问题',assistant:'已收到的片段',status:'failed',stopReason:'total_timeout',error:'回复超过120秒等待上限，已保留收到的内容。'};
 const parsed=reopen(old),html=footer(parsed);assert.equal(parsed.limits,undefined);assert.equal(parsed.elapsedMs,undefined);
 assert.match(html,/回复超过120秒等待上限，已保留收到的内容。/);assert.equal((html.match(/class="cloud-turn-error"/g)??[]).length,1);
 assert.doesNotMatch(html,/本轮设置|单次模型请求上限|整轮任务上限|本轮从开始到结束的耗时|30 分钟/);
});

test('recorded final timeout explanations stay authoritative; cancellation stays distinct',()=>{
 const reasons:[NonNullable<SessionTurn['stopReason']>,string][]=[
  ['total_timeout','单次模型请求超过120秒上限，已保留收到的内容。'],
  ['first_response_timeout','等待首段模型响应超过120秒，已停止本次请求。'],
  ['idle_timeout','接收连续60秒无进展，已保留收到的内容。'],
  ['turn_timeout','整轮任务超过300秒上限，已保留收到的内容。'],
 ];
 for(const [stopReason,error] of reasons){
  const turn:SessionTurn={id:turnId,user:'合成任务',assistant:'',status:'failed',stopReason,error,limits:{maxOutputTokens:8192,requestTimeoutMs:120000,turnTimeoutMs:300000}};
  const parsed=reopen(turn),html=footer(parsed);assert.equal(parsed.error,error);assert.equal(parsed.stopReason,stopReason);assert(html.includes(error));assert.equal((html.match(/class="cloud-turn-error"/g)??[]).length,1);
  assert.doesNotMatch(html,/记录已经改变|单条命令已超时/);
 }
 const cancelled=footer({id:turnId,user:'停止合成任务',assistant:'保留',status:'cancelled',error:''});assert.match(cancelled,/已停止/);assert.doesNotMatch(cancelled,/超时|cloud-turn-error/);
 const escaped=footer({id:turnId,user:'合成任务',assistant:'',status:'failed',error:'旧错误 <script>原文</script>'});assert.match(escaped,/&lt;script&gt;原文&lt;\/script&gt;/);assert.doesNotMatch(escaped,/<script/);
});

test('duration labels preserve short legacy values and the admitted four hour ceiling',()=>{
 assert.equal(replyLimitDuration(30000),'30 秒');assert.equal(replyLimitDuration(120000),'2 分钟');assert.equal(replyLimitDuration(900000),'15 分钟');assert.equal(replyLimitDuration(14400000),'4 小时');
 assert.equal(replyTurnLimit(null),'关闭');assert.equal(replyTurnLimit(120000),'2 分钟');
});
