import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root='C:\\work\\analog_ai_workbench';
const batch=path.join(root,'.local','quality-evidence','20260914-agent-command-native-01');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sha=file=>digest(fs.readFileSync(file));
const ordinary=file=>{const value=fs.lstatSync(file);if(value.isSymbolicLink()||fs.realpathSync(file).toLowerCase()!==file.toLowerCase())throw new Error('Aliased path');return value;};
const nativeNodeSha='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
if(process.platform!=='win32'||process.arch!=='x64'||process.version!=='v24.20.0'||sha(process.execPath)!==nativeNodeSha||process.argv.length!==4||!/^native-build-[0-9]{2}$/.test(process.argv[2])||!/^[a-f0-9]{64}$/.test(process.argv[3]))throw new Error('Exact completed build proof required');
for(let folder=batch;folder.length>3;folder=path.dirname(folder))ordinary(folder);
const output=path.join(batch,process.argv[2]),proofPath=path.join(output,'build-proof.json');
if(sha(proofPath)!==process.argv[3])throw new Error('Build proof bytes mismatch');
const build=JSON.parse(fs.readFileSync(proofPath,'utf8'));
if(build.schema!=='aaw.command.native-build.v1'||build.exitCode!==0||!build.unchanged||!build.output)throw new Error('No successful production build');
const verify=ref=>{if(path.isAbsolute(ref.path))throw new Error('Product file ref required');const file=path.resolve(root,ref.path);if(!file.startsWith(root+path.sep)||ordinary(file).size!==ref.bytes||sha(file)!==ref.sha256)throw new Error('Build identity changed');return file;};
for(const ref of build.sources)verify(ref);
const native=verify(build.output);if(native!==path.join(output,'agent-command-runner-native.exe'))throw new Error('Wrong production binary');
const sourceProfile=JSON.parse(fs.readFileSync(verify(build.profile),'utf8'));
if(sourceProfile.profileRevision!==build.profileRevision)throw new Error('Base profile revision mismatch');
const binding={profile:build.profile,native:build.output};
const environmentRevision=digest(Buffer.from(JSON.stringify(binding)));
// Independent output after compilation: it cannot mutate any compiled source/header/profile.
// Availability and review status deliberately remain pending; this file is not admission.
const candidate={schema:'aaw.command.runtime-profile-candidate.v1',status:'AWAITING_PRODUCTION_COMPATIBILITY_AND_SECURITY',createdAt:new Date().toISOString(),
  baseProfileRevision:build.profileRevision,baseProfile:build.profile,native:build.output,environmentRevision,
  buildProof:{path:path.relative(root,proofPath),bytes:fs.statSync(proofPath).size,sha256:process.argv[3]},
  runtime:{node:sourceProfile.node,license:sourceProfile.license,bootstrap:sourceProfile.bootstrap,systemFiles:sourceProfile.systemFiles},
  declaration:sourceProfile,
  commandEnvironmentCandidate:{environmentId:'windows-powershell51-node24-appcontainer',revision:environmentRevision,displayName:'Windows PowerShell 5.1 · Node 24',platform:'windows',
    shell:{kind:'powershell',version:sourceProfile.shellVersion,sha256:sourceProfile.systemFiles[0].sha256,scriptEncoding:'utf8_bom',interactive:false},
    tools:[{name:'node',version:'24.20.0',sha256:sourceProfile.node.sha256}],isolation:'windows-appcontainer-job',profileRevision:build.profileRevision,
    availability:'unavailable',reason:'Production compatibility and independent security admission pending',projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,
    limits:{processes:8,logBytes:16777216,defaultTimeoutMs:120000,maxTimeoutMs:600000}},
  evidence:{compatibility:null,security:null},productionReady:false};
const file=path.join(output,'runtime-profile-candidate.json');fs.writeFileSync(file,JSON.stringify(candidate,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({schema:'aaw.command.runtime-profile-created.v1',profile:{path:path.relative(root,file),bytes:fs.statSync(file).size,sha256:sha(file)},environmentRevision,native:build.output,productionReady:false})+'\n');
