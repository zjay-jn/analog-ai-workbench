import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {createReviewedSchematicHost} from '../apps/desktop/src/main/schematic/reviewed-schematic-host';
import {reviewedSchematicExtension} from '../apps/desktop/src/main/schematic/register-reviewed-schematic';
import {REVIEWED_SCHEMATIC_VERSION, REVIEWED_SCHEMATIC_DATASET, REVIEWED_DOCUMENT_REF, REVIEWED_ARTIFACT_REF, REVIEWED_SCHEMATIC_CHANNELS, type SchematicReference, type SchematicContext, type ReviewedSchematicDescriptor} from '../apps/desktop/src/shared/schematic/reviewed-schematic';
import {FOLDED_ADAPTED_DIGEST, FOLDED_REVIEWED_SOURCE_DIGEST} from '../packages/schematic-workbench/src/reviewed-display-validation';
import type {AgentCallerContextV1} from '../apps/desktop/src/main/agent/agent-caller-fence';

const projectId='11111111-1111-4111-8111-111111111111';
const request={contractVersion:REVIEWED_SCHEMATIC_VERSION,projectId};
const reference:SchematicReference={kind:'schematic_reference',projectId,datasetId:REVIEWED_SCHEMATIC_DATASET,documentRef:REVIEWED_DOCUMENT_REF,artifactRef:REVIEWED_ARTIFACT_REF,sourceDigest:FOLDED_REVIEWED_SOURCE_DIGEST,adaptedDigest:FOLDED_ADAPTED_DIGEST,targets:[{kind:'instance',definitionId:'definition:folded-cascode',occurrencePath:[],elementId:'instance:14'}]};
const {kind:_,...previewFields}=reference;
const preview={...request,...previewFields};
const calls=[['list',request],['openReviewed',{...request,datasetId:REVIEWED_SCHEMATIC_DATASET}],['previewSelection',preview],['resolveReference',{...request,reference}]] as const;

test('an unconfigured reviewed source lists no entries and never opens its loader',async()=>{
  let reads=0;
  const host=createReviewedSchematicHost({hasProject:id=>id===projectId,isConfigured:()=>false,loadEnvelope:()=>{reads++;throw Error('Must not load private data');}});
  for(const [method,value] of calls){
    const result=await host.invoke(method,value,()=>true);
    assert.deepEqual(result,method==='list'?{ok:true,value:[]}:{ok:false,error:{code:'DATA_UNAVAILABLE'}});
  }
  host.validateContextsForProject(projectId,[]);
  assert.throws(()=>host.validateContextsForProject(projectId,[{reference} as SchematicContext]),/Schematic reference unavailable/);
  assert.throws(()=>host.validateReference(projectId,reference),/Schematic reference unavailable/);
  assert.equal(reads,0);
});

test('source configuration never bypasses caller, project, or request validation',async()=>{
  let reads=0,checks=0;
  const host=createReviewedSchematicHost({hasProject:id=>id===projectId,isConfigured:()=>{checks++;return false;},loadEnvelope:()=>{reads++;throw Error('Must not read');}});
  assert.deepEqual(await host.invoke('list',request,()=>false),{ok:false,error:{code:'CAPABILITY_DENIED'}});
  assert.deepEqual(await host.invoke('list',{...request,projectId:'22222222-2222-4222-8222-222222222222'},()=>true),{ok:false,error:{code:'CAPABILITY_DENIED'}});
  assert.deepEqual(await host.invoke('list',{...request,isConfigured:true},()=>true),{ok:false,error:{code:'INVALID_REQUEST'}});
  assert.equal(checks,0);
  host.revoke();
  assert.deepEqual(await host.invoke('list',request,()=>true),{ok:false,error:{code:'CAPABILITY_DENIED'}});
  assert.equal(reads,0);
});

test('main may configure the source later; omitted configuration retains strict legacy loading',async()=>{
  let enabled=false,reads=0;
  const loader=()=>{reads++;throw Error('No source fixture supplied');};
  const host=createReviewedSchematicHost({hasProject:()=>true,isConfigured:()=>enabled,loadEnvelope:loader});
  assert.deepEqual(await host.invoke('list',request,()=>true),{ok:true,value:[]});
  enabled=true;
  assert.deepEqual(await host.invoke('list',request,()=>true),{ok:false,error:{code:'DATA_UNAVAILABLE'}});
  assert.equal(reads,1);
  enabled=false;
  assert.deepEqual(await host.invoke('list',request,()=>true),{ok:true,value:[]});
  assert.equal(reads,1);
  const legacy=createReviewedSchematicHost({hasProject:()=>true,loadEnvelope:loader});
  assert.deepEqual(await legacy.invoke('list',request,()=>true),{ok:false,error:{code:'DATA_UNAVAILABLE'}});
  assert.equal(reads,2);
  const failedConfig=createReviewedSchematicHost({hasProject:()=>true,isConfigured:()=>{throw Error('Unavailable');},loadEnvelope:loader});
  assert.deepEqual(await failedConfig.invoke('list',request,()=>true),{ok:true,value:[]});
  assert.equal(reads,2);
});

test('IPC registration preserves the main-only unconfigured source and caller fence',async()=>{
  let reads=0;
  const owner:AgentCallerContextV1={senderId:7,isTopFrame:true,appOrigin:'file://',navigationEpoch:1,appSessionId:'session.synthetic',windowId:'window.synthetic',webContentsId:7,workspaceId:'workspace.synthetic',rootId:'root.synthetic'};
  const handlers=new Map<string,(event:unknown,value:unknown)=>Promise<unknown>>();
  let caller:AgentCallerContextV1|null=owner;
  const extension=reviewedSchematicExtension({hasProject:id=>id===projectId,isConfigured:()=>false,loadEnvelope:()=>{reads++;throw Error('Must not read');}})({owner,deriveCallerContext:()=>caller,ipcMain:{removeHandler:(channel:string)=>handlers.delete(channel),handle:(channel:string,handler:(event:unknown,value:unknown)=>Promise<unknown>)=>handlers.set(channel,handler)}} as never);
  const list=handlers.get(REVIEWED_SCHEMATIC_CHANNELS.list)!;
  assert.deepEqual(await list({},request),{ok:true,value:[]});
  caller=null;
  assert.deepEqual(await list({},request),{ok:false,error:{code:'CAPABILITY_DENIED'}});
  assert.equal(reads,0);
  extension.dispose();
  assert.equal(handlers.size,0);
});

type MenuOption={label:string;disabled:boolean;action:()=>void};
function workspaceOptions(descriptors:readonly ReviewedSchematicDescriptor[],catalogStatus='ready',withApi=true):MenuOption[]{
  const source=readFileSync('apps/desktop/src/renderer/schematic/CloudDocumentWorkspace.tsx','utf8');
  const emitted=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const jsx=(type:unknown,props:Record<string,unknown>)=>({type,props});
  const module={exports:{}};
  const sandbox={module,exports:module.exports,window:{workbenchSchematic:{},...(withApi?{workbenchReviewedSchematic:{}}:{})},require:(name:string)=>{
    if(name==='react')return {createElement:jsx,useRef:()=>({current:null}),useEffect:()=>{},useMemo:(fn:()=>unknown)=>fn(),useState:(initial:unknown)=>[initial&&typeof initial==='object'&&!Array.isArray(initial)&&'descriptors'in initial?{tabs:[],preview:null,descriptors,catalogStatus,notice:''}:initial,()=>{}]};
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
    return new Proxy({},{get:(_target,key)=>key==='FileWorkbench'?'FileWorkbench':undefined});
  }};
  vm.runInNewContext(emitted,sandbox);
  const component=(module.exports as {CloudDocumentWorkspace:(props:unknown)=>{props:{children:{props:{schematic:{openOptions:MenuOption[]}}}[]}}}).CloudDocumentWorkspace;
  const tree=component({projectId,sessionId:'session.synthetic',canAttachSchematic:true,onAskSchematic:()=>{},disabled:false});
  return tree.props.children[0]!.props.schematic.openOptions;
}

test('an empty, loading or failed reviewed catalog leaves the synthetic entry available without a FOLDED placeholder',()=>{
  const descriptor:ReviewedSchematicDescriptor={datasetId:REVIEWED_SCHEMATIC_DATASET,displayName:'Configured circuit',kind:'reviewed',documentRef:REVIEWED_DOCUMENT_REF,artifactRef:REVIEWED_ARTIFACT_REF,sourceDigest:FOLDED_REVIEWED_SOURCE_DIGEST,adaptedDigest:FOLDED_ADAPTED_DIGEST,availability:'available'};
  for(const options of [workspaceOptions([]),workspaceOptions([descriptor],'loading'),workspaceOptions([descriptor],'error'),workspaceOptions([descriptor],'ready',false)]){
    assert.deepEqual(Array.from(options,option=>option.label),['打开合成原理图']);
    assert.equal(options[0]!.disabled,false);
  }
  assert.deepEqual(Array.from(workspaceOptions([descriptor]),option=>option.label),['打开 Configured circuit','查询 Configured circuit 本地副本','打开合成原理图']);
});
