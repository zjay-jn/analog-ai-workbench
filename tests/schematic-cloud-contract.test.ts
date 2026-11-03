import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {admitCloudDemo,CLOUD_DEMO_CANONICAL_SHA256,CLOUD_DEMO_RAW_MAX_BYTES,CLOUD_DEMO_MANIFEST_MAX_BYTES} from '../packages/schematic-workbench/src/cloud-demo-admission';
import {createSyntheticAdmissionRegistryV1} from '../packages/schematic-workbench/src/synthetic-admission';
import {sha256CanonicalAawJsonV1} from '../packages/schematic-workbench/src/canonical-json';
import {createInitialViewerViewStateV1,reduceViewerViewStateV1} from '../packages/schematic-workbench/src/viewer/view-state';
import {buildSafeSvgSceneV1} from '../packages/schematic-workbench/src/viewer/svg-scene';
import {CLOUD_SCHEMATIC_VERSION,CLOUD_SCHEMATIC_FIXTURE_ID,CLOUD_SCHEMATIC_PROJECT_CACHE_LIMIT,parseCloudSchematicRequest,parseCloudSchematicResult} from '../apps/desktop/src/shared/schematic/cloud-schematic';

const projectId='00000000-0000-4000-8000-000000000001';
const request={contractVersion:CLOUD_SCHEMATIC_VERSION,projectId,fixtureId:CLOUD_SCHEMATIC_FIXTURE_ID};
const raw=()=>({manifest:Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.manifest.json')),fixture:Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.json'))});
function success(){const data=raw(),entry=admitCloudDemo(data.manifest,data.fixture);return {ok:true,value:{contractVersion:CLOUD_SCHEMATIC_VERSION,projectId,documentRef:entry.documentRef,artifactRef:entry.artifactRef,freshness:entry.freshness,reviewedCircuitIr:entry.circuitIr}};}

test('SCH cloud request exact shape, project UUID and fixed profile',()=>{
  assert.deepEqual(parseCloudSchematicRequest(request),request);assert.equal(CLOUD_SCHEMATIC_PROJECT_CACHE_LIMIT,12);
  for(const value of [null,[],{}, {...request,fixtureId:'flat-basic'},{...request,projectId:'latest'},{...request,contractVersion:'v2'}, {...request,path:'fake'}, {...request,rawFrame:[]}])assert.throws(()=>parseCloudSchematicRequest(value));
});
test('SCH cloud request rejects accessors/symbol/non-enumerable fields without invoking getter',()=>{
  let calls=0;const value={...request};Object.defineProperty(value,'projectId',{enumerable:true,get(){calls++;return projectId;}});
  assert.throws(()=>parseCloudSchematicRequest(value));assert.equal(calls,0);
  assert.throws(()=>parseCloudSchematicRequest({...request,[Symbol('extra')]:true}));
  const hidden={...request};Object.defineProperty(hidden,'extra',{value:1});assert.throws(()=>parseCloudSchematicRequest(hidden));
});
test('SCH fixed raw profile verifies complete independent raw/canonical hash',()=>{
  const data=raw(),entry=admitCloudDemo(data.manifest,data.fixture);
  assert.equal(entry.payloadDigest,CLOUD_DEMO_CANONICAL_SHA256);assert.equal(entry.dirty,false);
  data.fixture.fill(0);data.manifest.fill(0);
  assert.equal(sha256CanonicalAawJsonV1(entry.circuitIr),CLOUD_DEMO_CANONICAL_SHA256);
  assert.throws(()=>{(entry.circuitIr.definitions as unknown[]).push({});});
});
test('SCH profile rejects forged manifest, mutated valid IR, invalid bytes and old manifest',()=>{
  const data=raw();assert.throws(()=>admitCloudDemo(new Uint8Array(CLOUD_DEMO_MANIFEST_MAX_BYTES+1),data.fixture));
  assert.throws(()=>admitCloudDemo(data.manifest,new Uint8Array(CLOUD_DEMO_RAW_MAX_BYTES+1)));
  const corrupted=Uint8Array.from(data.fixture);corrupted[100]=0xff;assert.throws(()=>admitCloudDemo(data.manifest,corrupted));
  const changed=JSON.parse(new TextDecoder().decode(data.fixture));changed.bounds.maxX=401;assert.throws(()=>admitCloudDemo(data.manifest,new TextEncoder().encode(JSON.stringify(changed))));
  const old=Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/approved-synthetic-fixtures.manifest.json'));
  assert.throws(()=>admitCloudDemo(old,data.fixture));assert.throws(()=>createSyntheticAdmissionRegistryV1(data.manifest));
});
test('SCH response binds fixed refs and requested project and freezes cloned IR',()=>{
  const value=success(),parsed=parseCloudSchematicResult(value,projectId);assert.equal(parsed.ok,true);assert.ok(parsed.ok);
  assert.notEqual(parsed.value.reviewedCircuitIr,value.value.reviewedCircuitIr);assert.ok(Object.isFrozen(parsed.value.reviewedCircuitIr.definitions[0]));
  assert.throws(()=>parseCloudSchematicResult(value,'00000000-0000-4000-8000-000000000002'));
  for(const change of [{freshness:'historical'},{documentRef:{...value.value.documentRef,revisionId:'rev-2'}},{artifactRef:{...value.value.artifactRef,artifactKind:'text'}},{receipt:{trusted:true}}])assert.throws(()=>parseCloudSchematicResult({...value,value:{...value.value,...change}}));
});
test('SCH response rejects corrupted graph, unsafe clone and response budget overflow',()=>{
  const value=success(),badIr=JSON.parse(JSON.stringify(value.value.reviewedCircuitIr));badIr.definitions[0].nets[0].memberElementIds.push('missing');
  assert.throws(()=>parseCloudSchematicResult({...value,value:{...value.value,reviewedCircuitIr:badIr}}));
  assert.throws(()=>parseCloudSchematicResult({...value,extra:'x'.repeat(65537)}));
  assert.throws(()=>parseCloudSchematicResult({ok:false,error:{code:'INTERNAL',stack:'secret'}}));
  assert.throws(()=>parseCloudSchematicResult({ok:false,error:{code:'OTHER'}}));
  assert.throws(()=>parseCloudSchematicResult({ok:false,error:{code:'INTERNAL'},extra:new Array(1000000)}));
});
test('SCH cloud geometry selects exact net membership and keeps duplicate labels distinct',()=>{
  const data=raw(),entry=admitCloudDemo(data.manifest,data.fixture),ir=entry.circuitIr;
  const initial=createInitialViewerViewStateV1(ir,{width:800,height:500},entry.artifactRef);
  const before=sha256CanonicalAawJsonV1(ir);
  const selected=reduceViewerViewStateV1(ir,initial,{type:'select-net',target:{...entry.artifactRef,occurrencePath:[],definitionId:'definition.cloud-demo',netId:'net.signal'}});
  const scene=buildSafeSvgSceneV1({artifactRef:entry.artifactRef,circuitIr:ir,viewState:selected,renderState:{status:'ready',freshness:'current'}});
  assert.equal(scene.geometryVisible,true);assert.equal(scene.layers.find(layer=>layer.kind==='base')?.primitives.length,16);
  assert.deepEqual(scene.layers.find(layer=>layer.kind==='net')?.primitives.map(p=>p.target.elementId).sort(),['port.input','pin.left.signal','pin.right.signal','wire.signal.input','wire.signal.link'].sort());
  assert.equal(ir.definitions[0]?.labels.filter(label=>label.text==='同名标注').length,2);
  assert.equal(sha256CanonicalAawJsonV1(ir),before);assert.equal(initial.netHighlight,null);
});
