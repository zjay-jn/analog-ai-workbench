import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';

export const NODE_VERSION = '24.20.0';
export const NODE_SHA256 = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
export const NODE_LICENSE_SHA256 = 'ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9';
export const OPENCODE_SHA256 = '2d8ed451c4c3e4dd69b9dec026030ec5bd00814b8f2b81483f8d80e35d8dce54';
export const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const hash = data => crypto.createHash('sha256').update(data).digest('hex');
export const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
export function ordinary(file, directory = false, allowSystemHardLinks = false) {
  const resolved = path.resolve(file);
  for (let current = resolved;; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) throw Error('RUNTIME_ALIASED_PATH');
    if (current === resolved && (directory ? !stat.isDirectory() : !stat.isFile() || (!allowSystemHardLinks && stat.nlink !== 1))) throw Error('RUNTIME_NOT_ORDINARY');
    if (path.dirname(current) === current) return fs.statSync(resolved);
  }
}
export function mkdir(file) {
  if (!fs.existsSync(file)) { mkdir(path.dirname(file)); fs.mkdirSync(file); }
  ordinary(file, true);
}
export function layout(root, storageRoot) {
  root = path.resolve(root);
  if (!storageRoot && !process.env.APPDATA) throw Error('APPDATA_UNAVAILABLE');
  storageRoot = path.resolve(storageRoot ?? path.join(process.env.APPDATA, 'AnalogAIWorkbench'));
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== `v${NODE_VERSION}` || sha(process.execPath) !== NODE_SHA256) throw Error('WINDOWS_X64_NODE_24_20_0_REQUIRED');
  for (const target of [root, storageRoot]) if (!/^[A-Za-z]:\\/u.test(target) || target.slice(2).includes(':') || /[\u0000-\u001f]/u.test(target)) throw Error('LOCAL_ABSOLUTE_ROOT_REQUIRED');
  ordinary(root, true);
  if (within(root, storageRoot) || within(storageRoot, root)) throw Error('INSTALL_AND_STORAGE_ROOTS_MUST_BE_SEPARATE');
  return {root, storageRoot, dataRoot: path.join(storageRoot, '.local'), runtimeRoot: path.join(root, '.local/runtime')};
}
export function run(program, args, options = {}) {
  const result = spawnSync(program, args, {shell: false, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 4*1024*1024, ...options});
  if (result.error || result.status !== 0) { const error = Error('RUNTIME_TOOL_FAILED'); error.details = {program, exitCode: result.status, code: result.error?.code ?? null, stdout: result.stdout, stderr: result.stderr}; throw error; }
  return result.stdout;
}
export function ref(root, file) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (!within(root, file)) throw Error('RUNTIME_REFERENCE_ESCAPED');
  return {path: relative, bytes: ordinary(file).size, sha256: sha(file)};
}
export function sources(root, names) { return names.map(name => ({path: name, sha256: sha(path.join(root, name))})); }
export async function download(url, file, expected, maxBytes) {
  if (fs.existsSync(file)) { ordinary(file); if (sha(file) !== expected) throw Error('EXISTING_DOWNLOAD_HASH_MISMATCH'); return; }
  mkdir(path.dirname(file));
  const temporary = `${file}.${crypto.randomUUID()}.partial`;
  const timeoutMs=Number(process.env.AAW_DOWNLOAD_TIMEOUT_MS??1800000);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<30000||timeoutMs>1800000)throw Error('DOWNLOAD_TIMEOUT_CONFIGURATION_INVALID');
  const curl = path.join(process.env.SystemRoot??'C:/Windows','System32/curl.exe');
  const source = new URL(url); if(source.hostname==='github.com')source.searchParams.set('aaw-download',crypto.randomUUID());
  console.log(JSON.stringify({event:'download-start',file:path.basename(file)}));
  if(fs.existsSync(curl)){
    ordinary(curl,false,true);
    const code=await new Promise((resolve,reject)=>{
      const child=spawn(curl,['--fail','--location','--silent','--show-error','--retry','0','--connect-timeout','30','--max-time',String(Math.ceil(timeoutMs/1000)),'--max-filesize',String(maxBytes),'--proto','=https','--proto-redir','=https','--output',temporary,source.href],{shell:false,windowsHide:true,stdio:['ignore','ignore','pipe']});
      child.stderr.resume();const progress=setInterval(()=>{let bytes=0;try{bytes=fs.statSync(temporary).size;}catch{}console.log(JSON.stringify({event:'download-progress',file:path.basename(file),bytes}));},30000);
      const timer=setTimeout(()=>{child.kill();reject(Error('DOWNLOAD_TIMEOUT'));},timeoutMs+10000);
      const clear=()=>{clearTimeout(timer);clearInterval(progress);};
      child.once('error',error=>{clear();reject(error);});child.once('close',value=>{clear();resolve(value);});
    });
    if(code!==0)throw Error('DOWNLOAD_TRANSPORT_FAILED_'+path.basename(file));
    if(ordinary(temporary).size>maxBytes||sha(temporary)!==expected)throw Error('DOWNLOAD_HASH_MISMATCH');
    fs.renameSync(temporary,file);console.log(JSON.stringify({event:'download-verified',file:path.basename(file),bytes:fs.statSync(file).size}));return;
  }
  const response = await fetch(source, {signal: AbortSignal.timeout(timeoutMs),cache:'no-store'});
  if (!response.ok || !response.body) throw Error(`DOWNLOAD_HTTP_${response.status}`);
  const descriptor = fs.openSync(temporary, 'wx'), digest = crypto.createHash('sha256');
  let count = 0;
  try {
    for await (const chunk of response.body) { count += chunk.length; if (count > maxBytes) throw Error('DOWNLOAD_TOO_LARGE'); digest.update(chunk); fs.writeSync(descriptor, chunk); }
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  if (digest.digest('hex') !== expected) throw Error('DOWNLOAD_HASH_MISMATCH');
  fs.renameSync(temporary, file);
  console.log(JSON.stringify({event:'download-verified',file:path.basename(file),bytes:count}));
}
export function publish(root, source, target, buildId) {
  if (!within(path.join(root, '.local/runtime'), target)) throw Error('PUBLISH_OUTSIDE_RUNTIME');
  ordinary(source); mkdir(path.dirname(target));
  if (fs.existsSync(target)) {
    ordinary(target);
    if (sha(source) === sha(target)) return;
    const backup = path.join(root, '.local/runtime/backups', buildId, path.relative(path.join(root, '.local/runtime'), target));
    mkdir(path.dirname(backup)); fs.renameSync(target, backup);
    try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (!fs.existsSync(target)) fs.renameSync(backup, target); throw error; }
  } else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  if (sha(source) !== sha(target)) throw Error('PUBLISHED_BYTES_CHANGED');
}
export function findToolchain() {
  const programFiles = process.env['ProgramFiles(x86)'];
  if (!programFiles) throw Error('VISUAL_STUDIO_BUILD_TOOLS_REQUIRED');
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe'); ordinary(vswhere);
  const installation = run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']).trim();
  if (!installation) throw Error('VISUAL_STUDIO_CPP_WORKLOAD_REQUIRED');
  const versions = fs.readdirSync(path.join(installation, 'VC/Tools/MSVC')).filter(name => /^\d+\.\d+\.\d+$/u.test(name)).sort((a,b) => a.localeCompare(b, 'en', {numeric:true}));
  const vc = path.join(installation, 'VC/Tools/MSVC', versions.at(-1) ?? 'missing');
  const sdkRoot = path.join(programFiles, 'Windows Kits/10');
  const sdks = fs.readdirSync(path.join(sdkRoot, 'Include')).filter(name => /^\d+\.\d+\.\d+\.\d+$/u.test(name) && fs.existsSync(path.join(sdkRoot, 'Lib', name, 'um/x64/kernel32.lib'))).sort((a,b) => a.localeCompare(b, 'en', {numeric:true}));
  const sdk = sdks.at(-1); if (!sdk) throw Error('WINDOWS_SDK_REQUIRED');
  const compiler = path.join(vc, 'bin/Hostx64/x64/cl.exe'); ordinary(compiler);
  return {vc, sdkRoot, sdk, compiler, compilerSha256:sha(compiler)};
}
export function nodeGyp() {
  const npmRoot = path.join(path.dirname(process.execPath), 'node_modules/npm');
  const manifest = JSON.parse(fs.readFileSync(path.join(npmRoot, 'package.json'), 'utf8'));
  if (manifest.version !== '11.19.0') throw Error('NPM_11_19_0_REQUIRED');
  const entry = path.join(npmRoot, 'node_modules/node-gyp/bin/node-gyp.js'); ordinary(entry); return entry;
}
export function findPython() {
  const candidates = process.env.AAW_NATIVE_PYTHON ? [process.env.AAW_NATIVE_PYTHON] : [];
  if (!candidates.length) for (const name of ['python3.exe', 'python.exe']) {
    const found=spawnSync(path.join(process.env.SystemRoot??'C:/Windows','System32/where.exe'),[name],{shell:false,windowsHide:true,encoding:'utf8',timeout:5000});
    if(found.status===0)candidates.push(...found.stdout.trim().split(/\r?\n/u));
  }
  for(const file of candidates)try{
    if(!path.isAbsolute(file)||/\\WindowsApps\\/iu.test(file))continue;
    ordinary(file);const version=run(file,['-c','import sys; print(".".join(map(str, sys.version_info[:3])))']).trim();
    if(/^3\.(?:1[0-9]|[2-9][0-9])\.\d+$/u.test(version))return {path:file,version,sha256:sha(file)};
  }catch{}
  throw Error('PYTHON_3_REQUIRED_SET_AAW_NATIVE_PYTHON');
}
export function parseOptions(arguments_) {
  let storageRoot,opencodeFile,nodeHeadersArchive,nodeLibFile;
  for (const value of arguments_) {
    if(value.startsWith('--storage-root=')&&!storageRoot&&path.isAbsolute(value.slice(15)))storageRoot=value.slice(15);
    else if(value.startsWith('--opencode-file=')&&!opencodeFile&&path.isAbsolute(value.slice(16)))opencodeFile=value.slice(16);
    else if(value.startsWith('--node-headers-archive=')&&!nodeHeadersArchive&&path.isAbsolute(value.slice(23)))nodeHeadersArchive=value.slice(23);
    else if(value.startsWith('--node-lib-file=')&&!nodeLibFile&&path.isAbsolute(value.slice(16)))nodeLibFile=value.slice(16);
    else throw Error('USAGE_STORAGE_ROOT_OR_OPENCODE_FILE');
  }
  return {storageRoot,opencodeFile,nodeHeadersArchive,nodeLibFile};
}
