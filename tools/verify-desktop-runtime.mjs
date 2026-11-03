import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {build} from 'vite';
import {layout,parseOptions,mkdir,ordinary,sha,ref,sources,within,NODE_SHA256,NODE_LICENSE_SHA256} from './portable-runtime-lib.mjs';

const root=path.resolve(import.meta.dirname,'..');
const paths=layout(root,parseOptions(process.argv.slice(2)).storageRoot);
const manifestFile=path.join(paths.runtimeRoot,'runtime-manifest.json');
const admissionFile=path.join(paths.runtimeRoot,'command-admission.json');
function read(file,max=1024*1024){const stat=ordinary(file);if(stat.size>max)throw Error('VERIFICATION_INPUT_TOO_LARGE');return fs.readFileSync(file);}
function matches(file,pin){const stat=ordinary(file);return stat.size<=256*1024*1024&&stat.size===pin.bytes&&sha(file)===pin.sha256;}
const manifestBefore=read(manifestFile),admissionBefore=read(admissionFile,512*1024);
const manifest=JSON.parse(manifestBefore),admission=JSON.parse(admissionBefore);
if(manifest.schemaVersion!=='aaw.desktop-runtime/v1'||manifest.platform!=='win32'||manifest.arch!=='x64'||manifest.nodeVersion!=='24.20.0'||manifest.dataRoot!==paths.dataRoot||manifest.build?.exitCode!==0)throw Error('RUNTIME_MANIFEST_INVALID');
if(admission.schema!=='aaw.command.runtime-admission.v1'||admission.status!=='BUILT_ONLY'||admission.environment?.platform!=='windows'||admission.environment?.availability!=='ready')throw Error('COMMAND_BUILT_CANDIDATE_REQUIRED');
const locations={commandRunner:'.local/runtime/native/command-runner.exe',node:'.local/runtime/node/node.exe',nodeLicense:'.local/runtime/node/LICENSE',commandBootstrap:'tools/agent-command-runner-bootstrap.ps1',commandAdmission:'.local/runtime/command-admission.json'};
const componentFile=id=>{
  const pin=manifest.components?.[id];
  if(!pin||pin.path!==locations[id]||!Number.isSafeInteger(pin.bytes)||pin.bytes<1||!/^[a-f0-9]{64}$/u.test(pin.sha256))throw Error('RUNTIME_COMPONENT_INVALID');
  if(id==='node'&&(pin.bytes!==93381448||pin.sha256!==NODE_SHA256)||id==='nodeLicense'&&pin.sha256!==NODE_LICENSE_SHA256)throw Error('FIXED_NODE_RUNTIME_CHANGED');
  const file=path.resolve(root,...pin.path.split('/'));
  if(!within(root,file)||!matches(file,pin))throw Error('RUNTIME_COMPONENT_CHANGED');
  return file;
};
for(const id of ['commandRunner','node','nodeLicense','commandBootstrap','commandAdmission'])componentFile(id);
if(componentFile('commandAdmission')!==admissionFile)throw Error('COMMAND_ADMISSION_LOCATION_INVALID');
for(const [item,id] of [[admission.native,'commandRunner'],[admission.runtime?.node,'node'],[admission.runtime?.license,'nodeLicense'],[admission.runtime?.bootstrap,'commandBootstrap']]){
  const expected=manifest.components[id];
  if(item?.path!==expected.path||item.bytes!==expected.bytes||item.sha256!==expected.sha256)throw Error('COMMAND_PROFILE_COMPONENT_MISMATCH');
}
const verificationSources=sources(root,['tools/verify-desktop-runtime.mjs','tools/portable-command-smoke.ts']);
const directory=path.join(paths.runtimeRoot,'verification','command-'+randomUUID());mkdir(directory);
const input={installationRoot:root,storageRoot:paths.storageRoot,directory,manifestSha256:sha(manifestFile),admissionSha256:sha(admissionFile)};
fs.writeFileSync(path.join(directory,'input.json'),JSON.stringify(input,null,2)+'\n',{flag:'wx'});
await build({configFile:false,root,define:{__AAW_MAIN_DEVELOPMENT__:'false'},build:{emptyOutDir:false,minify:false,outDir:path.join(directory,'bundle'),ssr:path.join(root,'tools/portable-command-smoke.ts'),target:'node24',rollupOptions:{output:{format:'cjs',entryFileNames:'smoke.cjs'}}},ssr:{noExternal:true,target:'node'}});
const executed=spawnSync(componentFile('node'),[path.join(directory,'bundle','smoke.cjs'),path.join(directory,'input.json')],{cwd:root,shell:false,windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
fs.writeFileSync(path.join(directory,'stdout.log'),executed.stdout??'',{flag:'wx'});
fs.writeFileSync(path.join(directory,'stderr.log'),executed.stderr??'',{flag:'wx'});
if(executed.error||executed.status!==0){console.error(JSON.stringify({status:'FAIL',evidence:directory,code:executed.error?.code??null,exitCode:executed.status}));throw Error('COMMAND_SMOKE_FAILED');}
const smoke=JSON.parse(read(path.join(directory,'smoke-result.json')));
if(smoke.schema!=='aaw.desktop-command-smoke/v1'||smoke.status!=='PASS'||smoke.executions?.length!==2||smoke.environmentRevision!==admission.environment.revision||smoke.manifestSha256!==input.manifestSha256||smoke.admissionSha256!==input.admissionSha256||smoke.closure?.hadOutstanding!==false||smoke.closure?.cleanupConfirmed!==true)throw Error('COMMAND_SMOKE_EVIDENCE_INVALID');
for(const id of Object.keys(locations))componentFile(id);
for(const source of verificationSources)if(sha(path.join(root,source.path))!==source.sha256)throw Error('VERIFICATION_SOURCE_CHANGED');
if(!read(manifestFile).equals(manifestBefore)||!read(admissionFile,512*1024).equals(admissionBefore))throw Error('RUNTIME_CHANGED_DURING_VERIFICATION');
const smokePin=ref(root,path.join(directory,'smoke-result.json'));
const admitted={...admission,status:'SCOPED_NATIVE_READY_FOR_INTEGRATION',verification:{schema:'aaw.desktop-command-verification/v1',verifiedAt:new Date().toISOString(),environmentRevision:admission.environment.revision,proof:smokePin,commands:[0,7],eachExecutedOnce:true,sourceFiles:verificationSources}};
const candidate=path.join(directory,'command-admission.verified.json');
fs.writeFileSync(candidate,JSON.stringify(admitted,null,2)+'\n',{flag:'wx'});
const sourcePins=[...manifest.components.commandAdmission.sources.filter(source=>!verificationSources.some(item=>item.path===source.path)),...verificationSources];
const next={...manifest,components:{...manifest.components,commandAdmission:{...ref(root,candidate),path:path.relative(root,admissionFile).replaceAll('\\','/'),sources:sourcePins}},build:{...manifest.build,commandStatus:'verified',commandVerification:smokePin}};
const nextFile=path.join(directory,'runtime-manifest.verified.json');
fs.writeFileSync(nextFile,JSON.stringify(next,null,2)+'\n',{flag:'wx'});
// Preserve the previous pair. Publish admission first: the old manifest then
// rejects its changed hash until the new manifest is atomically committed.
fs.writeFileSync(path.join(directory,'runtime-manifest.before.json'),manifestBefore,{flag:'wx'});
fs.writeFileSync(path.join(directory,'command-admission.before.json'),admissionBefore,{flag:'wx'});
fs.renameSync(candidate,admissionFile);
fs.renameSync(nextFile,manifestFile);
if(!matches(admissionFile,next.components.commandAdmission))throw Error('PROMOTED_ADMISSION_CHANGED');
const receipt={schema:'aaw.desktop-runtime-verification/v1',status:'PASS',verifiedAt:new Date().toISOString(),installationRoot:root,storageRoot:paths.storageRoot,environmentRevision:admission.environment.revision,evidence:smokePin,manifest:ref(root,manifestFile),admission:ref(root,admissionFile),sources:verificationSources,scope:smoke.scope};
fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'VERIFIED',commandAdmission:admitted.status,evidence:path.relative(root,path.join(directory,'verification.json')).replaceAll('\\','/')}));
