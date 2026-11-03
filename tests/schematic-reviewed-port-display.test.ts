import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {adaptFoldedReviewedSources} from '../packages/schematic-workbench/src/folded-adapter';
import {FOLDED_SOURCE_FILES,type FoldedSourceFiles} from '../packages/schematic-workbench/src/folded-source-profile';
import {presentReviewedPorts,readableReviewedText,reviewedBasicPort,reviewedPortGeometry} from '../packages/schematic-workbench/src/viewer/reviewed-port-display';
import {layoutReviewedDisplayText,reviewedTextWorldBox} from '../packages/schematic-workbench/src/viewer/reviewed-text-layout';
import {buildReviewedSvgSceneV1} from '../packages/schematic-workbench/src/viewer/reviewed-svg-scene';
import {createInitialViewerViewStateV1} from '../packages/schematic-workbench/src/viewer/view-state';
import {schematicCanvasHitTargets,hitTestSchematicCanvas} from '../apps/desktop/src/renderer/schematic/schematic-canvas-hit';
import {devicesInSchematicBox} from '../apps/desktop/src/renderer/schematic/schematic-box-gestures';
import type {ReviewedGeometry} from '../packages/schematic-workbench/src/reviewed-display';

const files=Object.fromEntries(Object.keys(FOLDED_SOURCE_FILES).map(name=>[name,fs.readFileSync('.local/reviewed-schematic/folded-v1/'+name,'utf8')])) as FoldedSourceFiles;
const envelope=adaptFoldedReviewedSources(files),display=envelope.display;
const matches=display.devices.flatMap(device=>{const port=reviewedBasicPort(display,device);return port?[{device,port}]:[];});
type Text=Extract<ReviewedGeometry,{tag:'text'}>;
const isText=(p:ReviewedGeometry):p is Text=>p.tag==='text';
const overlap=(a:{minX:number;maxX:number;minY:number;maxY:number},b:typeof a)=>Math.max(0,Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX))*Math.max(0,Math.min(a.maxY,b.maxY)-Math.max(a.minY,b.minY));

test('six explicit master/direction/full-placement pairs resolve, while ambiguous or mismatched metadata stays a placeholder',()=>{
  assert.deepEqual(matches.map(({port})=>port.name),['VDDA','GNDA','IBIAS','VIP','VIN','VOUT']);
  const {device,port}=matches[0]!;
  assert.equal(reviewedBasicPort({...display,ports:[...display.ports,{...port,id:'duplicate'}]},device),null);
  assert.equal(reviewedBasicPort({...display,devices:[...display.devices,{...device,id:'duplicate'}]},device),null);
  assert.equal(reviewedBasicPort(display,{...device,placement:{...device.placement,origin:{...device.placement.origin,x:999}}}),null);
  assert.equal(reviewedBasicPort(display,{...device,master:{...device.master,library:'custom'}}),null);
  assert.equal(reviewedBasicPort(display,{...device,master:{...device.master,cell:'ipin'}}),null);
  assert.equal(reviewedBasicPort({...display,devices:display.devices.map(d=>d.id===device.id?{...d,name:'user-name'}:d)},{...device,name:'user-name'})?.id,port.id);
});

test('real input/output/inout symbols use oriented triangles or diamonds and retain instance selection identity',()=>{
  const expected:Record<string,number[][]>={VIN:[[.5,23.25],[13.5,31.25],[.5,39.25],[.5,23.25]],VIP:[[237,39.25],[224,31.25],[237,23.25],[237,39.25]],VOUT:[[487,4.5],[474,12.5],[487,20.5],[487,4.5]],IBIAS:[[-360,50],[-350,40],[-340,50],[-350,60],[-360,50]]};
  const placed=presentReviewedPorts(display);
  for(const {device,port} of matches){
    const glyph=placed.filter(p=>p.sourceKind==='instance'&&p.sourceId===device.id);
    assert.equal(glyph.length,2);assert.equal(glyph.some(isText),false);
    assert(glyph.every(p=>p.netId===port.netId));
    const outline=glyph[0]!;assert(outline.tag==='polyline');
    assert.equal(outline.points.length,port.direction==='inout'?5:4);
    if(expected[port.name])assert.deepEqual(outline.points.map(p=>[p.x,p.y]),expected[port.name]);
    assert.equal(placed.filter(p=>isText(p)&&p.sourceKind==='graphic'&&p.text===port.name).length,1);
  }
  const unrelated:Text={key:'unrelated-name',sourceKind:'graphic',sourceId:'unrelated',netId:null,tag:'text',text:'PIN3',position:{x:999,y:999},rotation:0,anchor:'start'};
  assert(presentReviewedPorts({...display,primitives:[...display.primitives,unrelated]}).includes(unrelated));
});

test('VIP and VBIAS labels become upright with corrected anchors, and readable vertical IBIAS stays unchanged',()=>{
  const placed=presentReviewedPorts(display).filter(isText);
  const vip=placed.find(p=>p.sourceKind==='graphic'&&p.text==='VIP')!;
  assert.equal(vip.rotation,0);assert.equal(vip.anchor,'start');assert.deepEqual(vip.position,{x:243.75,y:31.25});
  for(const name of ['VBIAS3','VBIAS2']){
    const labels=placed.filter(p=>p.sourceKind==='label'&&p.text===name);assert(labels.length>0);assert(labels.every(p=>p.rotation===0));
  }
  const ibias=display.primitives.find((p):p is Text=>isText(p)&&p.sourceKind==='graphic'&&p.text==='IBIAS')!;
  assert.equal(placed.find(p=>p.key===ibias.key),ibias);assert.equal(ibias.rotation,-90);
  const sample:Text={...ibias,rotation:0,anchor:'start'};
  assert.equal(readableReviewedText(sample,'MY').anchor,'end');
  assert.equal(readableReviewedText({...sample,rotation:180}).anchor,'end');
  assert.equal(readableReviewedText({...sample,rotation:-180}).rotation,0);
});

test('port names clear their symbols and upright source labels feed the existing MOS collision layout',()=>{
  const placed=layoutReviewedDisplayText(display,presentReviewedPorts(display));
  for(const {device,port} of matches){
    const shape=reviewedPortGeometry(device,port)[0]!;assert(shape.tag==='polyline');
    const box={minX:Math.min(...shape.points.map(p=>p.x)),maxX:Math.max(...shape.points.map(p=>p.x)),minY:Math.min(...shape.points.map(p=>p.y)),maxY:Math.max(...shape.points.map(p=>p.y))};
    const name=placed.find((p):p is Text=>isText(p)&&p.sourceKind==='graphic'&&p.text===port.name)!;
    assert.equal(overlap(box,reviewedTextWorldBox(name)),0,port.name);
  }
  const mos=new Set(display.devices.filter(d=>d.displayKind!=='placeholder').map(d=>d.id));
  const texts=placed.filter(isText),annotations=texts.filter(p=>mos.has(p.sourceId)),source=texts.filter(p=>!mos.has(p.sourceId));
  for(const item of annotations){
    for(const other of source)assert.equal(overlap(reviewedTextWorldBox(item),reviewedTextWorldBox(other)),0,item.sourceId+' / '+other.key);
    for(const other of annotations)if(other.sourceId!==item.sourceId)assert.equal(overlap(reviewedTextWorldBox(item),reviewedTextWorldBox(other)),0,item.sourceId+' / '+other.sourceId);
  }
});

test('each displayed port supports body clicks and tight marquee after zoom/pan without adding electrical hit targets',()=>{
  const initial=createInitialViewerViewStateV1(envelope.reviewedCircuitIr,{width:670,height:820},display.artifactRef);
  for(const zoom of [.5,2,8]){
    const viewState={...initial,viewport:{...initial.viewport,zoom,translateXCss:31,translateYCss:-27}};
    const scene=buildReviewedSvgSceneV1({envelope,artifactRef:display.artifactRef,viewState,renderState:{status:'ready',freshness:'current'}});
    const corrected={...scene,hitTargets:schematicCanvasHitTargets(scene,true)};
    assert.deepEqual(corrected.hitTargets.map(h=>h.target),scene.hitTargets.map(h=>h.target));
    assert(!corrected.hitTargets.some(h=>h.target.elementKind==='port'||h.target.elementKind==='pin'));
    for(const {device,port} of matches){
      const point={x:port.displayPlacement.origin.x*100*zoom+31,y:-port.displayPlacement.origin.y*100*zoom-27};
      assert.equal(hitTestSchematicCanvas(corrected,point,6,true)?.target.elementId,device.id);
      const glyph=reviewedPortGeometry(device,port)[0]!;assert(glyph.tag==='polyline');
      const xs=glyph.points.map(p=>p.x*zoom+31),ys=glyph.points.map(p=>p.y*zoom-27);
      // Include the display-origin circle at the triangle tip, not any source annotation bounds.
      xs.push(point.x-2.5*zoom,point.x+2.5*zoom);ys.push(point.y-2.5*zoom,point.y+2.5*zoom);
      const box={x:Math.min(...xs)-1,y:Math.min(...ys)-1,width:Math.max(...xs)-Math.min(...xs)+2,height:Math.max(...ys)-Math.min(...ys)+2};
      assert.deepEqual(devicesInSchematicBox(corrected,box).map(t=>t.elementId),[device.id]);
      const selected=buildReviewedSvgSceneV1({envelope,artifactRef:display.artifactRef,viewState:{...viewState,selection:[corrected.hitTargets.find(h=>h.target.elementId===device.id)!.target]},renderState:{status:'ready',freshness:'current'}});
      assert.equal(selected.layers.find(l=>l.kind==='selection')!.primitives.length,2);
      assert.deepEqual(schematicCanvasHitTargets(selected,true),corrected.hitTargets);
    }
  }
});

test('VIN name clears the reproduced neighboring VBIAS3 wire without moving any other port name or source geometry',()=>{
  const placed=presentReviewedPorts(display).filter(isText);
  const original=display.primitives.find((p):p is Text=>isText(p)&&p.sourceKind==='graphic'&&p.text==='VIN')!;
  const fixed=placed.find(p=>p.key===original.key)!;
  const wire=display.primitives.find(p=>p.key==='wire:39')!;assert(wire.tag==='polyline');
  assert.deepEqual(wire.points,[{x:-50,y:25},{x:-12.5,y:25}]);
  const wireBox={minX:-51.5,maxX:-11,minY:23.5,maxY:26.5};
  assert(overlap(reviewedTextWorldBox(original),wireBox)>0);
  assert.equal(overlap(reviewedTextWorldBox(fixed),wireBox),0);
  assert.deepEqual(fixed.position,{x:-12.5,y:39.25});
  for(const {port} of matches){
    const source=display.primitives.find((p):p is Text=>isText(p)&&p.sourceKind==='graphic'&&p.text===port.name)!;
    if(port.name!=='VIN')assert.deepEqual(placed.find(p=>p.key===source.key)!.position,source.position,port.name);
  }
});

test('presentation changes no admitted source bytes, identities, counts or unknown electrical anchors',()=>{
  const before=JSON.stringify(envelope);
  assert.equal(presentReviewedPorts(display).length,524);
  assert.equal(display.primitives.length,530);
  assert.equal(display.devices.length,33);assert.equal(display.terminals.length,114);
  assert(display.terminals.every(t=>t.position===null&&t.positionStatus==='unavailable_in_current_view'));
  assert.equal(JSON.stringify(envelope),before);
  assert.equal(display.adaptedDigest,'098a4eec59b22dee954816a4b49440eee18d8370b5d54413a428d7d146c67b30');
});
