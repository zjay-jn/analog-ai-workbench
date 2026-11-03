import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {adaptFoldedReviewedSources} from '../packages/schematic-workbench/src/folded-adapter';
import {FOLDED_SOURCE_FILES,type FoldedSourceFiles} from '../packages/schematic-workbench/src/folded-source-profile';
import {layoutReviewedDisplayText,reviewedTextWorldBox} from '../packages/schematic-workbench/src/viewer/reviewed-text-layout';
import {buildReviewedSvgSceneV1} from '../packages/schematic-workbench/src/viewer/reviewed-svg-scene';
import {createInitialViewerViewStateV1} from '../packages/schematic-workbench/src/viewer/view-state';
import type {ReviewedGeometry} from '../packages/schematic-workbench/src/reviewed-display';

const files=Object.fromEntries(Object.keys(FOLDED_SOURCE_FILES).map(name=>[name,fs.readFileSync('.local/reviewed-schematic/folded-v1/'+name,'utf8')])) as FoldedSourceFiles;
const envelope=adaptFoldedReviewedSources(files),display=envelope.display;
const viewport=(zoom:number)=>({zoom,translateXCss:0,translateYCss:0,widthCss:670,heightCss:820});
type Text=Extract<ReviewedGeometry,{tag:'text'}>;
const text=(p:ReviewedGeometry):p is Text=>p.tag==='text';
const area=(a:ReturnType<typeof reviewedTextWorldBox>,b:ReturnType<typeof reviewedTextWorldBox>)=>Math.max(0,Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX))*Math.max(0,Math.min(a.maxY,b.maxY)-Math.max(a.minY,b.minY));
const problems=[['MB3-2','label:net:22'],['MB3-1','label:net:23'],['MB2-2','label:net:6'],['MB2-1','label:net:10']] as const;

test('reported four local-view MOS summaries no longer overlap their unchanged VDDA/GNDA source names',()=>{
  const placed=layoutReviewedDisplayText(display);
  for(const [name,netLabel] of problems){
    const device=display.devices.find(d=>d.name===name)!;
    const original=display.primitives.find((p):p is Text=>text(p)&&p.sourceId===device.id&&p.text.startsWith('W='))!;
    const fixed=placed.find((p):p is Text=>text(p)&&p.key===original.key)!;
    const source=display.primitives.find((p):p is Text=>text(p)&&p.key===netLabel)!;
    assert(area(reviewedTextWorldBox(original),reviewedTextWorldBox(source))>0,name+' reproduces the original collision');
    assert.equal(area(reviewedTextWorldBox(fixed),reviewedTextWorldBox(source)),0,name+' clears the source text');
    assert.equal(fixed.text,original.text);assert.equal(placed.find(p=>p.key===netLabel),source);
  }
});
test('view layout changes only generated MOS text positions and leaves the admitted digest and all original values intact',()=>{
  const before=JSON.stringify(envelope),hash=createHash('sha256').update(before).digest('hex');
    const placed=layoutReviewedDisplayText(display);assert.equal(placed.length,530);
    placed.forEach((p,index)=>{
      const original=display.primitives[index]!;const device=display.devices.find(d=>d.id===p.sourceId);
      if(p.tag==='text'&&p.sourceKind==='instance'&&device?.displayKind!=='placeholder'){
        assert(original.tag==='text');const {position:_,...rest}=p,{position:__,...originalRest}=original;assert.deepEqual(rest,originalRest);assert(Math.abs(p.position.x-original.position.x)<=24);
      }else assert.equal(p,original);
    });
  assert.equal(createHash('sha256').update(JSON.stringify(envelope)).digest('hex'),hash);
  assert.equal(display.adaptedDigest,'098a4eec59b22dee954816a4b49440eee18d8370b5d54413a428d7d146c67b30');
});
test('generated name/parameter rows retain 14 world-unit spacing and bounded world shifts',()=>{
    const placed=layoutReviewedDisplayText(display);
    for(const device of display.devices.filter(d=>d.displayKind!=='placeholder')){
      const rows=placed.filter((p):p is Text=>text(p)&&p.sourceId===device.id),original=display.primitives.filter((p):p is Text=>text(p)&&p.sourceId===device.id);
      assert.equal(rows.length,2);assert(Math.abs((rows[1]!.position.y-rows[0]!.position.y)-14)<1e-9);
      assert(Math.abs((rows[0]!.position.y-original[0]!.position.y))<=42+1e-9);
    }
});
test('all generated MOS annotations clear source text and other device annotations under conservative world boxes',()=>{
  const mos=new Set(display.devices.filter(d=>d.displayKind!=='placeholder').map(d=>d.id));
  const texts=layoutReviewedDisplayText(display).filter(text),annotations=texts.filter(p=>mos.has(p.sourceId)),source=texts.filter(p=>!mos.has(p.sourceId));
  for(const item of annotations){
    for(const other of source)assert.equal(area(reviewedTextWorldBox(item),reviewedTextWorldBox(other)),0,item.sourceId+' / '+other.key);
    for(const other of annotations)if(other.sourceId!==item.sourceId)assert.equal(area(reviewedTextWorldBox(item),reviewedTextWorldBox(other)),0,item.sourceId+' / '+other.sourceId);
  }
});
test('over-displaced MB5 annotations return close to their symbol and clear the power wire with no name-specific rule',()=>{
  const before=JSON.stringify(envelope),device=display.devices.find(d=>d.name==='MB5')!;
  const original=display.primitives.filter((p):p is Text=>text(p)&&p.sourceId===device.id);
  const old=original.map((p,index)=>({...p,position:{x:p.position.x,y:original[0]!.position.y-42+index*14}}));
  const power={minX:-169.75,maxX:-49,minY:-151,maxY:-149};
  assert(area(reviewedTextWorldBox(old[1]!),power)>0,'old maximum upward shift places parameters across VDDA');
  const placed=layoutReviewedDisplayText(display),rows=placed.filter((p):p is Text=>text(p)&&p.sourceId===device.id);
  assert.equal(rows.length,2);assert.equal(rows[1]!.position.y-rows[0]!.position.y,14);
  assert(Math.abs(rows[0]!.position.y-original[0]!.position.y)<=18);
  assert(rows[0]!.position.x-(-168.75)<=24,'name stays beside the right-hand symbol edge');
  for(const row of rows){
    assert.equal(area(reviewedTextWorldBox(row),power),0);
    for(const primitive of display.primitives)if(primitive.sourceKind==='wire'&&primitive.tag==='polyline'){
      for(let i=1;i<primitive.points.length;i++){
        const a:{x:number;y:number}=primitive.points[i-1]!,b:{x:number;y:number}=primitive.points[i]!;
        assert.equal(area(reviewedTextWorldBox(row),{minX:Math.min(a.x,b.x)-1,maxX:Math.max(a.x,b.x)+1,minY:Math.min(a.y,b.y)-1,maxY:Math.max(a.y,b.y)+1}),0,primitive.key);
      }
    }
  }
  const renamed={...display,devices:display.devices.map(d=>d.id===device.id?{...d,name:'Q17'}:d),
    primitives:display.primitives.map(p=>p.tag==='text'&&p.sourceId===device.id&&p.text==='MB5'?{...p,text:'Q17'}:p)};
  const other=layoutReviewedDisplayText(renamed).filter((p):p is Text=>text(p)&&p.sourceId===device.id);
  assert.deepEqual(other.map(p=>p.position),rows.map(p=>p.position));
  assert.equal(JSON.stringify(envelope),before);
});

test('layout is deterministic, pan invariant and selection-independent without input mutation',()=>{
  const initial=createInitialViewerViewStateV1(envelope.reviewedCircuitIr,{width:670,height:820},display.artifactRef);
  const base=buildReviewedSvgSceneV1({envelope,artifactRef:display.artifactRef,viewState:initial,renderState:{status:'ready',freshness:'current'}});
  const textAttributes=(scene:typeof base)=>scene.layers.find(l=>l.kind==='base')!.primitives.filter(p=>p.tag==='text').map(p=>({key:p.key,text:p.text,attributes:p.attributes}));
  for(const zoom of [.1,.65,2,32]){
    const viewState={...initial,viewport:{...viewport(zoom),translateXCss:1717.375,translateYCss:-886.625},selection:[base.hitTargets[0]!.target]};
    const scene=buildReviewedSvgSceneV1({envelope,artifactRef:display.artifactRef,viewState,renderState:{status:'ready',freshness:'current'}});
    assert.deepEqual(textAttributes(scene),textAttributes(base));assert(scene.layers.find(l=>l.kind==='selection')!.primitives.length>0);
  }
});
