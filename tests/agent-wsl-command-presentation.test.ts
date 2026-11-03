import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CommandEnvironment,CommandExecution} from '../apps/desktop/src/shared/agent/agent-command';
import {CommandEnvironmentResults,CommandExecutionView} from '../apps/desktop/src/renderer/agent/CommandExecutionResults';

const digest='a'.repeat(64),now='2026-09-15T00:00:00.000Z';
const environment:CommandEnvironment={environmentId:'synthetic-wsl',revision:digest,displayName:'Synthetic Linux',platform:'wsl',
 shell:{kind:'bash',version:'5.1',sha256:digest,scriptEncoding:'utf8',interactive:false},tools:[],isolation:'wsl-user-process-supervisor',profileRevision:digest,
 availability:'ready',reason:null,projectAccess:'declared_roots',baselineAccess:'verified_copy',workAccess:'execution_copy',network:'inherited',hostEnvironment:'controlled',packageInstallation:'not_provided',executableScope:'wsl_user_permissions',survivesAppClose:false,
 limits:{processes:8,logBytes:16777216,defaultTimeoutMs:120000,maxTimeoutMs:600000},
 wsl:{distribution:'SYNTHETIC_LINUX',user:'fixture-user',homeDirectory:'/home/fixture-user',shellPath:'/bin/bash',executionRoot:'/synthetic/executions',sourceRoots:[
  {path:'/synthetic/notes <source>',access:'read_only',enforcement:'authorization_only'},
  {path:'/synthetic/output',access:'read_write',enforcement:'authorization_only'},
  {path:'/synthetic/mapped',access:'read_only',enforcement:'os_read_only'},
 ]}};
const execution:CommandExecution={executionId:'synthetic-command',runId:'synthetic-run',workspaceId:'synthetic-work',requestId:'synthetic-request',signature:digest,
 environment:{environmentId:environment.environmentId,revision:digest,displayName:environment.displayName},runtime:null,baselineVersion:digest,cwdRelativePath:'input dir',commandText:'printf "<output>"',commandSha256:digest,scriptSha256:digest,revision:1,phase:'starting',createdAt:now,deadlineAt:now,startedAt:null,completedAt:null,stopRequested:null,exit:null,job:{activeProcesses:null,emptyConfirmed:false,observedAt:null},cleanup:{state:'pending',observedAt:null,proofSha256:null},
 logs:{stdout:{stream:'stdout',persistedBytes:0,observedBytes:0,prefixVersion:digest,closed:false,coverage:'open',sha256:null},stderr:{stream:'stderr',persistedBytes:0,observedBytes:0,prefixVersion:digest,closed:false,coverage:'open',sha256:null}},artifacts:[],changes:{state:'pending',manifestVersion:null,count:null,acceptance:'not_requested'},error:null};
const never=()=>{throw Error('Static rendering must not execute commands');};

test('WSLCUI environment shows Bash target and distinguishes authorized access from OS enforcement',()=>{
 const html=renderToStaticMarkup(createElement(CommandEnvironmentResults,{environments:[environment]}));
 assert.match(html,/Bash 5.1/);assert.match(html,/非交互执行/);assert.match(html,/SYNTHETIC_LINUX · fixture-user/);
 assert.match(html,/\/synthetic\/executions/);assert.match(html,/notes &lt;source&gt; · 只读（授权约定）/);
 assert.match(html,/output · 可写（授权约定）/);assert.match(html,/mapped · 只读（系统只读映射）/);
 assert.match(html,/网络沿用 WSL 环境/);assert.doesNotMatch(html,/PowerShell|AppContainer|网络已禁用|<source>/);assert(!html.includes(digest));
 const unavailable=renderToStaticMarkup(createElement(CommandEnvironmentResults,{environments:[{...environment,availability:'unavailable',reason:'尚未核定'}]}));
 assert.match(unavailable,/尚未就绪：尚未核定/);assert.doesNotMatch(unavailable,/>可用</);
});

test('WSLCUI explicit observe-only process policy is readable; legacy count remains visible',()=>{
 const unrestricted=renderToStaticMarkup(createElement(CommandEnvironmentResults,{environments:[{...environment,limits:{...environment.limits,processes:null}}]}));
 assert.match(unrestricted,/不按进程数量终止/);assert.match(unrestricted,/运行上限：600 秒/);assert.doesNotMatch(unrestricted,/最多 null|最多  个进程/);
 const legacy=renderToStaticMarkup(createElement(CommandEnvironmentResults,{environments:[environment]}));assert.match(legacy,/最多 8 个进程/);
});

test('WSLCUI actual cwd requires a runtime observation and legacy history stays platform neutral',()=>{
 const render=(value:CommandExecution)=>renderToStaticMarkup(createElement(CommandExecutionView,{execution:value,onRefresh:never,onStop:never,onReadLog:never}));
 const pending=render(execution);assert.match(pending,/实际 WSL 工作目录尚未确认/);assert.doesNotMatch(pending,/实际工作目录：/);
 const started={...execution,phase:'running' as const,runtime:{platform:'wsl' as const,distribution:'SYNTHETIC_LINUX',user:'fixture-user',cwd:'/synthetic/executions/synthetic-command/work/input dir',workDirectory:'/synthetic/executions/synthetic-command/work',baselineDirectory:null}};
 const html=render(started);assert.match(html,/实际工作目录：\/synthetic\/executions\/synthetic-command\/work\/input dir/);assert.match(html,/SYNTHETIC_LINUX · fixture-user/);
 assert.match(html,/>停止这次执行</);assert.match(html,/>读取标准输出</);assert.match(html,/>读取错误输出</);assert.match(html,/&lt;output&gt;/);assert.doesNotMatch(html,/尚未确认|<output>/);
 const {runtime:_runtime,...legacy}=execution;const old=render({...legacy,environment:{...legacy.environment,displayName:'Windows PowerShell'}});
 assert.match(old,/环境：Windows PowerShell/);assert.match(old,/工作目录（本次执行副本）：input dir/);assert.doesNotMatch(old,/WSL|实际工作目录/);
});

test('WSLCUI bounded artifact exports report skipped entries even with no returned artifacts',()=>{
 for(const skippedEntries of [7]){
  const html=renderToStaticMarkup(createElement(CommandExecutionView,{execution:{...execution,artifactCollection:{scope:'bounded_text_exports',skippedEntries}}}));
  assert.match(html,new RegExp(`已省略 ${skippedEntries} 个文件或目录条目`));assert.match(html,/仅包含限额内的文本文件/);
  assert.match(html,/目录按一个条目计数/);assert.match(html,/不代表整个外部实验目录的全部成果/);
 }
 const empty=renderToStaticMarkup(createElement(CommandExecutionView,{execution:{...execution,artifactCollection:{scope:'bounded_text_exports',skippedEntries:0}}}));assert.doesNotMatch(empty,/成果回传|已省略/);
 const legacy=renderToStaticMarkup(createElement(CommandExecutionView,{execution}));assert.doesNotMatch(legacy,/成果回传：|已省略/);
});
