import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root='C:\\work\\analog_ai_workbench';
const batch=path.join(root,'.local','quality-evidence','20260914-agent-engine-lifecycle-01');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ordinary=file=>{const value=fs.lstatSync(file);if(value.isSymbolicLink()||fs.realpathSync(file).toLowerCase()!==file.toLowerCase())throw new Error('Aliased build input');return value;};
const ref=file=>({path:path.relative(root,file),bytes:ordinary(file).size,sha256:sha(file)});
const nodeSha='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
if(process.platform!=='win32'||process.arch!=='x64'||process.version!=='v24.20.0'||sha(process.execPath)!==nodeSha||process.argv.length!==3||!/^build-[0-9]{2}$/.test(process.argv[2]))throw new Error('Explicit fixed Windows build required');
for(let folder=root;folder.length>3;folder=path.dirname(folder))ordinary(folder);
const source=path.join(root,'tools','agent-engine-lifecycle-guardian.cc');
const security=path.join(root,'tools','agent-work-cycle-runner-native-security.h');
if(sha(security)!=='98c8ba8e661ad9b63d9a40f7d0462bab5d455e52656cc2dda808b3f433b19560')throw new Error('Immutable shared utility source changed');
const engine=ref(path.join(root,'.local','agent-engine-candidate-v1.18.17','opencode.exe'));
if(engine.bytes!==178721160||engine.sha256!=='2d8ed451c4c3e4dd69b9dec026030ec5bd00814b8f2b81483f8d80e35d8dce54')throw new Error('Fixed engine changed');
const output=path.join(batch,process.argv[2]);if(fs.existsSync(output))throw new Error('Preserve existing build');
fs.mkdirSync(output,{recursive:true});for(let folder=output;folder.length>root.length;folder=path.dirname(folder))ordinary(folder);
const generated=path.join(output,'runner-limits.h');
fs.writeFileSync(generated,'#pragma once\n#include <cstddef>\nnamespace limits { inline constexpr std::size_t files=32, fileBytes=65536, workspaceBytes=1048576, artifactsPerExecution=8, relativePathBytes=240, pathDepth=4; }\n',{flag:'wx'});
const sources=[source,security,generated,fileURLToPath(import.meta.url)].map(ref);
const vc='C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207';
const sdk='C:\\Program Files (x86)\\Windows Kits\\10';
const compiler=path.join(vc,'bin','Hostx64','x64','cl.exe');
const executable=path.join(output,'agent-engine-lifecycle-guardian.exe');
const args=['/nologo','/MT','/EHsc','/W4','/WX','/utf-8','/std:c++20','/DUNICODE','/D_UNICODE','/sdl','/guard:cf','/I'+path.join(vc,'include'),'/I'+output,
  ...['ucrt','shared','um'].map(part=>'/I'+path.join(sdk,'Include','10.0.26100.0',part)),
  '/Fo'+path.join(output,'guardian.obj'),'/Fd'+path.join(output,'guardian.pdb'),'/Fe'+executable,source,'/link',
  '/LIBPATH:'+path.join(vc,'lib','x64'),'/LIBPATH:'+path.join(sdk,'Lib','10.0.26100.0','ucrt','x64'),'/LIBPATH:'+path.join(sdk,'Lib','10.0.26100.0','um','x64'),
  'userenv.lib','advapi32.lib','kernel32.lib','bcrypt.lib','ole32.lib','shell32.lib','/DYNAMICBASE','/NXCOMPAT','/CETCOMPAT','/guard:cf'];
const build=spawnSync(compiler,args,{cwd:output,shell:false,windowsHide:true,encoding:'utf8',maxBuffer:262144,timeout:60000});
const unchanged=sources.every(file=>sha(path.join(root,file.path))===file.sha256);
const receipt={schema:'aaw.engine.guardian-build.v1',builtAt:new Date().toISOString(),scope:'fixed_engine_lifecycle_only',sources,unchanged,engine,
  toolchain:{compiler,sha256:sha(compiler),sdk:'10.0.26100.0',staticCrt:true},args,
  exitCode:build.status,error:build.error?.message??null,stdout:build.stdout,stderr:build.stderr,
  output:build.status===0&&unchanged?ref(executable):null,
  declaration:{argv:['<product .local/agent-engine-pilot/native/UUID>','<port1024..65535>'],engineArgv:['serve','--hostname','127.0.0.1','--port','<port>','--mdns=false'],cwd:'<root>/cwd',
    control:'stdin C or EOF; never inherited by engine',records:'<root>/guardian-control/{intent,ready,result}.json',recordPublishing:'write flush close then atomic rename without replacement',
    job:{atomic:true,killOnClose:true,breakawayAllowed:false},engineInheritedHandles:['NUL stdin','main stdout pipe','main stderr pipe'],
    environment:'existing main explicit plan.env passed unchanged; never logged',appContainerAdded:false,engineNetworkBoundaryChanged:false,engineResourceLimitsAdded:false,cleanupMs:2000,cleanupBudget:'one_deadline_shared_by_job_zero_and_engine_handle_wait; never_reset_in_catch',
    actualLifecycleAcceptance:'not-yet-run; root E1/E2/E3 only',changesToCommandRunner:false}};
fs.writeFileSync(path.join(output,'build-proof.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify(receipt)+'\n');if(build.status!==0||build.error||!unchanged)process.exitCode=1;
