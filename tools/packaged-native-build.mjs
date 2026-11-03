import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ordinary,sha,hash,findToolchain,findPython,nodeGyp,sources,NODE_SHA256} from './portable-runtime-lib.mjs';

const sourceNames=['tools/agent-engine-lifecycle-guardian.cc','tools/agent-command-runner-native.cc','tools/agent-work-cycle-runner-native.cc','tools/agent-work-cycle-runner-native-security.h','tools/packaged-native-runtime.h','tools/packaged-command-profile.h','tools/agent-command-runner-bootstrap.ps1','tools/packaged-native-build.mjs','tools/portable-runtime-lib.mjs','packages/windows-fs-native/src/addon.cc','packages/windows-fs-native/binding.gyp','apps/desktop/src/shared/agent/agent-work-cycle.ts'];
const pin=file=>({path:path.resolve(file),bytes:ordinary(file).size,sha256:sha(file)});
function limitsHeader(root){
  const text=fs.readFileSync(path.join(root,'apps/desktop/src/shared/agent/agent-work-cycle.ts'),'utf8'),constants=Object.fromEntries([...text.matchAll(/const\s+([A-Z_]+)\s*=\s*([0-9]+)\s*;/gu)].map(match=>[match[1],Number(match[2])]));
  const body=text.match(/WORK_CYCLE_LIMITS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/u)?.[1];if(!body)throw Error('WORK_LIMITS_UNAVAILABLE');
  const keys=['files','fileBytes','workspaceBytes','artifactsPerExecution','relativePathBytes','pathDepth','logBytes','outputBytes','executionMs','cleanupMs','nativeCallMs','processes','processMemoryBytes','jobMemoryBytes'];
  return '#pragma once\n#include <cstddef>\nnamespace limits {\n'+keys.map(key=>{
    const expression=body.match(new RegExp('\\b'+key+'\\s*:\\s*([^,]+),','u'))?.[1]?.trim();if(!expression)throw Error('WORK_LIMIT_MISSING');
    const parts=expression.split('*').map(part=>part.trim());if(parts.some(part=>!/^\d+$/u.test(part)&&!Object.hasOwn(constants,part)))throw Error('WORK_LIMIT_EXPRESSION_UNSUPPORTED');
    const value=parts.map(part=>constants[part]??Number(part)).reduce((a,b)=>a*b,1);if(!Number.isSafeInteger(value)||value<1)throw Error('WORK_LIMIT_INVALID');return 'inline constexpr std::size_t '+key+'='+value+';';
  }).join('\n')+'\n}\n';
}
/** Build-machine operation only. Output has no developer roots or machine admission. */
export async function buildPackagedNative({root,outputDirectory}){
  root=path.resolve(root);outputDirectory=path.resolve(outputDirectory);ordinary(root,true);ordinary(path.dirname(outputDirectory),true);
  if(fs.existsSync(outputDirectory))throw Error('PACKAGED_NATIVE_NEW_OUTPUT_REQUIRED');
  if(process.platform!=='win32'||process.arch!=='x64'||sha(process.execPath)!==NODE_SHA256)throw Error('FIXED_WINDOWS_NODE_REQUIRED');
  const baseline=sources(root,sourceNames),toolchain=findToolchain(),python=findPython(),headers=path.join(root,'.local/runtime/node/headers');
  if(sha(path.join(headers,'include/node/node_api.h'))!=='2d4560831e525b47b060ec8a0864ab73993df9e20215ce9f0fe7b24cd31af32a'||sha(path.join(headers,'win-x64/node.lib'))!=='63ec831bbf164d1b23197d6fac1944dfb146534e332889ca0755d250e8dedff9')throw Error('FIXED_NODE_HEADERS_REQUIRED');
  fs.mkdirSync(outputDirectory);const native=path.join(outputDirectory,'native');fs.mkdirSync(native);
  const generated=path.join(outputDirectory,'generated');fs.mkdirSync(generated);
  fs.writeFileSync(path.join(generated,'runner-limits.h'),limitsHeader(root),{flag:'wx'});
  const bootstrap=pin(path.join(root,'tools/agent-command-runner-bootstrap.ps1'));
  fs.writeFileSync(path.join(generated,'command-profile.h'),'#pragma once\nnamespace profile {\ninline constexpr unsigned long long bootstrapBytes='+bootstrap.bytes+';\ninline constexpr char bootstrapSha256[]='+JSON.stringify(bootstrap.sha256)+';\n}\n',{flag:'wx'});
  const {vc,sdkRoot,sdk,compiler}=toolchain,artifacts={};
  for(const [id,name,source] of [['guardian','guardian','tools/agent-engine-lifecycle-guardian.cc'],['commandRunner','command-runner','tools/agent-command-runner-native.cc'],['workRunner','work-runner','tools/agent-work-cycle-runner-native.cc']]){
    const executable=path.join(native,name+'.exe'),args=['/nologo','/MT','/EHsc','/W4','/WX','/utf-8','/std:c++20','/DUNICODE','/D_UNICODE','/DAAW_PACKAGED_RUNTIME=1','/DAAW_PORTABLE_RUNTIME=1','/sdl','/guard:cf','/Brepro','/I'+path.join(vc,'include'),'/I'+generated,...['ucrt','shared','um'].map(part=>'/I'+path.join(sdkRoot,'Include',sdk,part)),'/Fo'+path.join(native,name+'.obj'),'/Fd'+path.join(native,name+'.pdb'),'/Fe'+executable,path.join(root,source),'/link','/LIBPATH:'+path.join(vc,'lib/x64'),'/LIBPATH:'+path.join(sdkRoot,'Lib',sdk,'ucrt/x64'),'/LIBPATH:'+path.join(sdkRoot,'Lib',sdk,'um/x64'),'userenv.lib','advapi32.lib','kernel32.lib','bcrypt.lib','ole32.lib','shell32.lib','/DYNAMICBASE','/NXCOMPAT','/CETCOMPAT','/guard:cf','/Brepro'];
    const result=spawnSync(compiler,args,{cwd:outputDirectory,shell:false,windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});fs.writeFileSync(path.join(native,name+'-compiler.log'),(result.stdout??'')+(result.stderr??''),{flag:'wx'});
    if(result.error||result.status!==0)throw Error('PACKAGED_NATIVE_COMPILE_FAILED_'+name);artifacts[id]=pin(executable);
  }
  const fsSource=path.join(outputDirectory,'fs-source');fs.mkdirSync(fsSource);fs.mkdirSync(path.join(fsSource,'src'));fs.copyFileSync(path.join(root,'packages/windows-fs-native/src/addon.cc'),path.join(fsSource,'src/addon.cc'),fs.constants.COPYFILE_EXCL);
  const recipe=JSON.parse(fs.readFileSync(path.join(root,'packages/windows-fs-native/binding.gyp'),'utf8'));for(const target of recipe.targets)target.msvs_settings.VCCLCompilerTool.RuntimeLibrary=0;
  fs.writeFileSync(path.join(fsSource,'binding.gyp'),JSON.stringify(recipe,null,2)+'\n',{flag:'wx'});
  const result=spawnSync(process.execPath,[nodeGyp(),'rebuild','--release','--directory='+fsSource,'--nodedir='+headers,'--msvs_version=2022','--python='+python.path],{cwd:outputDirectory,shell:false,windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,env:{...process.env,GYP_MSVS_VERSION:'2022'}});
  fs.writeFileSync(path.join(outputDirectory,'windows-fs-compiler.log'),(result.stdout??'')+(result.stderr??''),{flag:'wx'});if(result.error||result.status!==0)throw Error('PACKAGED_NODE_GYP_FAILED');
  const fsTarget=path.join(native,'windows-fs-native.node');fs.copyFileSync(path.join(fsSource,'build/Release/aaw_windows_fs_native.node'),fsTarget,fs.constants.COPYFILE_EXCL);artifacts.windowsFs=pin(fsTarget);
  if(baseline.some(source=>sha(path.join(root,source.path))!==source.sha256)||sha(compiler)!==toolchain.compilerSha256)throw Error('PACKAGED_BUILD_INPUT_CHANGED');
  const provenance={schema:'aaw.packaged-native-build/v1',compiler:{path:compiler,sha256:toolchain.compilerSha256},sdk,python,hostNode:pin(process.execPath),headers:{nodeApiSha256:sha(path.join(headers,'include/node/node_api.h')),importLibrarySha256:sha(path.join(headers,'win-x64/node.lib'))},generated:['runner-limits.h','command-profile.h'].map(name=>pin(path.join(generated,name))),addonRecipe:{runtimeLibrary:'MT',sha256:hash(fs.readFileSync(path.join(fsSource,'binding.gyp')))},scope:'Precompiled packaged runtime; no fixed deployment roots, user profile, old runtime proof or machine admission copied.'};
  const resultObject={artifacts,sources:baseline,provenance};fs.writeFileSync(path.join(outputDirectory,'build-result.json'),JSON.stringify(resultObject,null,2)+'\n',{flag:'wx'});return resultObject;
}
