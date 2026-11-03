import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {createProjectFolderTitleReader,projectFolderTooltip,windowsFolderPath} from '../apps/desktop/src/renderer/agent/use-project-folder-titles';
import {ProjectPicker} from '../apps/desktop/src/renderer/agent/ProjectPicker';
import {newProject,emptyWorkspace} from '../apps/desktop/src/shared/agent/project-workspace';
import type {ProjectFolderBinding,ProjectFolderBindingResult} from '../apps/desktop/src/shared/agent/project-folders';
const binding=(projectId:string,drive:string,name:string):ProjectFolderBinding=>({projectId,bindingId:randomUUID(),name,segments:[drive,'synthetic',name]});
type States=Record<string,Parameters<typeof projectFolderTooltip>[1]>;
test('all project titles read only binding metadata and restore the Windows drive separator',async()=>{
 const a=randomUUID(),b=randomUUID(),rows={[a]:binding(a,'C','Alpha'),[b]:binding(b,'D','Beta')},calls:string[]=[];let states:States={};
 const api={readBinding:async({projectId}:{projectId:string})=>{calls.push('read:'+projectId);return {ok:true as const,projectId,binding:rows[projectId]!};},list:async()=>{throw Error('must not list');},open:async()=>{throw Error('must not open');}};
 await createProjectFolderTitleReader(api).read([a,b],value=>states=value);assert.deepEqual(calls,['read:'+a,'read:'+b]);assert.equal(projectFolderTooltip('A',states[a]),'A\nC:\\synthetic\\Alpha');assert.equal(projectFolderTooltip('B',states[b]),'B\nD:\\synthetic\\Beta');assert.equal(windowsFolderPath(['C','one','two']),'C:\\one\\two');
});
test('metadata refresh after rebind and unbind updates each project without cross-attribution',async()=>{
 const a=randomUUID(),b=randomUUID();let rows:Record<string,ProjectFolderBinding|null>={[a]:binding(a,'C','Alpha'),[b]:binding(b,'D','Beta')},states:States={};const api={readBinding:async({projectId}:{projectId:string})=>({ok:true as const,projectId,binding:rows[projectId]!})},reader=createProjectFolderTitleReader(api);
 await reader.read([a,b],v=>states=v);rows={[a]:binding(a,'E','Changed'),[b]:null};await reader.read([a,b],v=>states=v);assert.equal(projectFolderTooltip('A',states[a]),'A\nE:\\synthetic\\Changed');assert.equal(projectFolderTooltip('B',states[b]),'B\n未关联文件夹');
 let restarted:States={};await createProjectFolderTitleReader(api).read([a,b],v=>restarted=v);assert.deepEqual(restarted,states);
});
test('late replies from before a binding refresh cannot overwrite the latest unbound title',async()=>{
 const id=randomUUID();let resolve!:(v:ProjectFolderBindingResult)=>void,old=true,states:States={};const reader=createProjectFolderTitleReader({readBinding:async()=>old?new Promise(r=>resolve=r):{ok:true,projectId:id,binding:null}}),first=reader.read([id],v=>states=v);assert.match(projectFolderTooltip('A',states[id]),/正在读取/);old=false;await reader.read([id],v=>states=v);resolve({ok:true,projectId:id,binding:binding(id,'C','Old')});await first;assert.equal(projectFolderTooltip('A',states[id]),'A\n未关联文件夹');
});
test('failure, malformed owner and unavailable metadata are never reported as unbound',async()=>{
 const id=randomUUID();for(const readBinding of [async()=>({ok:false as const,error:{code:'STORAGE_ERROR' as const}}),async()=>({ok:true as const,projectId:randomUUID(),binding:null}),async()=>{throw Error('lost read');}]){let states:States={};await createProjectFolderTitleReader({readBinding}).read([id],v=>states=v);const title=projectFolderTooltip('A',states[id]);assert.match(title,/读取失败/);assert.ok(!title.includes('未关联'));}
 let states:States={};await createProjectFolderTitleReader(undefined).read([id],v=>states=v);assert.match(projectFolderTooltip('A',states[id]),/读取失败/);
});
test('actual project row, expand button and name receive each project title including inactive projects',()=>{
 const disk=emptyWorkspace(),a=disk.activeId,b=randomUUID();disk.projects=[newProject(a,'A'),newProject(b,'B')];const titles={[a]:'A\nC:\\synthetic\\Alpha',[b]:'B\nD:\\synthetic\\Beta'};
 const html=renderToStaticMarkup(createElement(ProjectPicker,{state:disk,disabled:false,onSwitch:()=>{},onName:async()=>true,onCreateSession:()=>{},renderSessions:()=>null,folderTitles:titles}));
 for(const title of Object.values(titles))assert.equal(html.split('title="'+title+'"').length-1,3);assert.ok(html.includes('aria-label="收起项目 A"'));assert.ok(html.includes('aria-label="收起项目 B"'));assert.ok(html.includes('aria-current="true"'));
});
