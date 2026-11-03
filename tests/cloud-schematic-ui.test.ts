import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';
import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {admitCloudDemo} from '../packages/schematic-workbench/src/cloud-demo-admission';
import {CLOUD_SCHEMATIC_VERSION,CLOUD_SCHEMATIC_PROJECT_CACHE_LIMIT,type CloudSchematicResult,type CloudSchematicValue,type WorkbenchSchematicApi} from '../apps/desktop/src/shared/schematic/cloud-schematic';
import {createCloudSchematicTabs,type CloudSchematicTab} from '../apps/desktop/src/renderer/schematic/cloud-schematic-tabs';
import {SchematicViewer} from '../apps/desktop/src/renderer/SchematicViewer';
import {buildSafeSvgSceneV1} from '../packages/schematic-workbench/src/viewer/svg-scene';
const fixture=admitCloudDemo(Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.manifest.json')),Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.json')));
function value(projectId:string):CloudSchematicValue{return {contractVersion:CLOUD_SCHEMATIC_VERSION,projectId,documentRef:fixture.documentRef,artifactRef:fixture.artifactRef,freshness:'current',reviewedCircuitIr:fixture.circuitIr};}
const api:WorkbenchSchematicApi={openSynthetic:async request=>({ok:true,value:value(request.projectId)})};
function ready(model:ReturnType<typeof createCloudSchematicTabs>,id:string):Extract<CloudSchematicTab,{status:'ready'}>{const tab=model.snapshot().find(e=>e.projectId===id);assert.ok(tab?.status==='ready');return tab;}
function deferred(){let resolve!:(r:CloudSchematicResult)=>void;return {promise:new Promise<CloudSchematicResult>(r=>resolve=r),resolve:(result:CloudSchematicResult)=>resolve(result)};}

test('cloud viewer only opens explicitly, de-duplicates an active project and uses exact identity',async()=>{
 let calls=0;const model=createCloudSchematicTabs({openSynthetic:async request=>{calls++;return api.openSynthetic(request);}}),id=randomUUID();model.setProject(id);assert.equal(calls,0);assert.equal(model.snapshot().length,0);await model.open();await model.open();assert.equal(calls,1);const tab=ready(model,id);assert.equal(model.snapshot().length,1);assert.equal(tab.active,true);assert.ok(tab.key.includes(id)&&tab.key.includes(fixture.artifactRef.artifactId)&&tab.key.includes('rev-1'));assert.equal(tab.measured,false);
});
test('actual viewport fit, anchored zoom and pan preserve immutable geometry',async()=>{
 const model=createCloudSchematicTabs(api),id=randomUUID();model.setProject(id);await model.open();const initial=ready(model,id),before=JSON.stringify(initial.delivery.reviewedCircuitIr);
 model.action(initial.key,{type:'resize-css',width:500,height:300,fit:true});let tab=ready(model,id);assert.equal(tab.viewState.viewport.widthCss,500);assert.equal(tab.viewState.viewport.heightCss,300);assert.equal(tab.measured,true);
 const zoom=tab.viewState.viewport.zoom;model.action(tab.key,{type:'zoom-css',factor:1.2,anchorCss:{x:250,y:150}});tab=ready(model,id);assert.equal(tab.viewState.viewport.zoom,zoom*1.2);
 const x=tab.viewState.viewport.translateXCss;model.action(tab.key,{type:'pan-css',deltaCss:{x:37,y:-9}});tab=ready(model,id);assert.equal(tab.viewState.viewport.translateXCss,x+37);
 model.action(tab.key,{type:'resize-css',width:600,height:360,fit:false});tab=ready(model,id);assert.equal(tab.viewState.viewport.zoom,zoom*1.2);assert.equal(tab.viewState.viewport.translateXCss,x+37+50);assert.equal(JSON.stringify(tab.delivery.reviewedCircuitIr),before);
});
test('wire selection and explicit net highlight survive text switching; inactive actions ignored',async()=>{
 const model=createCloudSchematicTabs(api),id=randomUUID();model.setProject(id);await model.open();let tab=ready(model,id);const target={artifactId:tab.delivery.artifactRef.artifactId,revisionId:tab.delivery.artifactRef.revisionId,occurrencePath:[],definitionId:'definition.cloud-demo',elementKind:'wire' as const,elementId:'wire.signal.input'};
 model.action(tab.key,{type:'primary-select',target,ctrlKey:false});model.action(tab.key,{type:'toggle-selection-net'});tab=ready(model,id);assert.equal(tab.viewState.selection.length,1);assert.equal(tab.viewState.netHighlight?.netId,'net.signal');
 const stored=tab.viewState;model.selectText();model.action(tab.key,{type:'pan-css',deltaCss:{x:999,y:0}});assert.equal(ready(model,id).viewState,stored);model.select();assert.equal(ready(model,id).viewState,stored);
 const scene=buildSafeSvgSceneV1({circuitIr:tab.delivery.reviewedCircuitIr,artifactRef:tab.delivery.artifactRef,viewState:tab.viewState,renderState:{status:'ready',freshness:'current'}});assert.ok(scene.primitives.some(p=>p.styleToken==='net-highlight'));assert.ok(scene.primitives.some(p=>p.styleToken==='selection-highlight'));
});
test('projects retain independent state even with identical artifact refs; stale action key ignored',async()=>{
 const model=createCloudSchematicTabs(api),a=randomUUID(),b=randomUUID();model.setProject(a);await model.open();const first=ready(model,a);model.action(first.key,{type:'pan-css',deltaCss:{x:60,y:0}});const aState=ready(model,a).viewState;
 model.setProject(b);await model.open();const second=ready(model,b);assert.notEqual(first.key,second.key);assert.deepEqual(first.delivery.artifactRef,second.delivery.artifactRef);model.action(first.key,{type:'pan-css',deltaCss:{x:300,y:0}});assert.equal(ready(model,b).viewState,second.viewState);model.setProject(a);assert.equal(ready(model,a).viewState,aState);
});
test('close and reopen resolve afresh and reset the view',async()=>{
 let calls=0;const model=createCloudSchematicTabs({openSynthetic:async request=>{calls++;return api.openSynthetic(request);}}),id=randomUUID();model.setProject(id);await model.open();const tab=ready(model,id);model.action(tab.key,{type:'pan-css',deltaCss:{x:123,y:0}});model.close();assert.equal(model.snapshot().length,0);await model.open();assert.equal(calls,2);assert.equal(ready(model,id).viewState.viewport.translateXCss,tab.viewState.viewport.translateXCss);assert.equal(ready(model,id).measured,false);
});
test('late response after close cannot revive a tab',async()=>{
 const pending=deferred(),model=createCloudSchematicTabs({openSynthetic:()=>pending.promise}),id=randomUUID();model.setProject(id);const opening=model.open();assert.equal(model.snapshot()[0]?.status,'loading');model.close();pending.resolve({ok:true,value:value(id)});await opening;assert.equal(model.snapshot().length,0);
});
test('project switch cancels pending delivery and requires explicit retry',async()=>{
 const pending=deferred();let calls=0;const model=createCloudSchematicTabs({openSynthetic:request=>++calls===1?pending.promise:api.openSynthetic(request)}),a=randomUUID(),b=randomUUID();model.setProject(a);const opening=model.open();model.setProject(b);pending.resolve({ok:true,value:value(a)});await opening;assert.equal(model.snapshot().find(e=>e.projectId===a)?.status,'error');model.setProject(a);assert.equal(calls,1);await model.open(true);assert.equal(ready(model,a).status,'ready');assert.equal(calls,2);
});
test('new generation wins over a replaced opening request',async()=>{
 const first=deferred(),second=deferred();let calls=0;const model=createCloudSchematicTabs({openSynthetic:()=>++calls===1?first.promise:second.promise}),id=randomUUID();model.setProject(id);const old=model.open(),newer=model.open(true);second.resolve({ok:true,value:value(id)});await newer;const current=ready(model,id);first.resolve({ok:false,error:{code:'INTERNAL'}});await old;assert.equal(ready(model,id),current);
});
test('wrong project/revision or malformed response stays error without geometry and can retry',async()=>{
 for(const invalid of [{ok:true,value:value(randomUUID())},{ok:true,value:{...value(randomUUID()),artifactRef:{...fixture.artifactRef,revisionId:'rev-2'}}},{ok:true,value:{geometry:'untrusted'}},{ok:false,error:{code:'INTERNAL'}}]){
  let fail=true;const model=createCloudSchematicTabs({openSynthetic:async request=>fail?invalid as never:api.openSynthetic(request)}),id=randomUUID();model.setProject(id);await model.open();const tab=model.snapshot()[0]!;assert.equal(tab.status,'error');assert.equal('delivery'in tab,false);fail=false;await model.open(true);assert.equal(ready(model,id).status,'ready');
 }
});
test('cache is bounded and evicts least recently visited noncurrent project',async()=>{
 const model=createCloudSchematicTabs(api),ids=Array.from({length:CLOUD_SCHEMATIC_PROJECT_CACHE_LIMIT+1},randomUUID);
 for(const id of ids.slice(0,-1)){model.setProject(id);await model.open();}
 model.setProject(ids[0]!);model.setProject(ids.at(-1)!);await model.open();assert.equal(model.snapshot().length,CLOUD_SCHEMATIC_PROJECT_CACHE_LIMIT);assert.ok(model.snapshot().some(e=>e.projectId===ids[0]));assert.equal(model.snapshot().some(e=>e.projectId===ids[1]),false);assert.ok(ready(model,ids.at(-1)!));
});
test('dispose invalidates all pending requests and subscriptions',async()=>{
 const pending=deferred(),model=createCloudSchematicTabs({openSynthetic:()=>pending.promise}),id=randomUUID();let notifications=0;model.subscribe(()=>notifications++);model.setProject(id);const opening=model.open(),count=notifications;model.dispose();pending.resolve({ok:true,value:value(id)});await opening;await model.open();model.setProject(randomUUID());assert.equal(model.snapshot().length,0);assert.equal(notifications,count);
});
test('compact viewer has visible readonly identity and observable selection/zoom without edit actions',async()=>{
 const model=createCloudSchematicTabs(api),id=randomUUID();model.setProject(id);await model.open();const tab=ready(model,id);
 const html=renderToStaticMarkup(createElement(SchematicViewer,{compact:true,fitOnMount:false,circuitIr:tab.delivery.reviewedCircuitIr,artifactRef:tab.delivery.artifactRef,viewState:tab.viewState,renderState:{status:'ready',freshness:'current'},onAction:()=>{}}));
 assert.ok(html.includes('合成原理图 · 只读'));assert.ok(html.includes('data-view-zoom=')&&html.includes('data-selection-count="0"'));assert.ok(html.includes('data-schematic-canvas="true"'));assert.ok(!html.includes('contenteditable')&&!html.includes('保存原理图'));
 assert.ok(html.includes('当前 synthetic revision'));assert.ok(!html.includes('当前原理图导出版本'));
 assert.ok(/<text[^>]*scale\(/.test(html), 'synthetic text retains its existing fixed-size transform');
});
