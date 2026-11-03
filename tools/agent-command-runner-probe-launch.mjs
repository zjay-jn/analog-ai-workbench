import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
const root = 'C:\\work\\analog_ai_workbench';
const evidence = path.join(root, '.local', 'quality-evidence', '20260914-agent-command-native-01');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const node = path.join(root, '.local', 'toolchains', 'node-v24.20.0-win-x64', 'node.exe');
const nodeSha = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
const ordinary = file => { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error('Aliased path: ' + file); return stat; };
if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.20.0' || process.argv.length !== 4 || !/^build-[0-9]{2}$/.test(process.argv[2]) || !/^[a-f0-9]{64}$/.test(process.argv[3]) || sha(node) !== nodeSha || sha(process.execPath) !== nodeSha) throw new Error('Pinned single compatibility launch required');
for (let directory = evidence; directory.length > 3; directory = path.dirname(directory)) ordinary(directory);
const proofPath = path.join(evidence, process.argv[2], 'build-proof.json');
if (sha(proofPath) !== process.argv[3]) throw new Error('Build proof not the reviewed exact bytes');
const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
if (proof.schema !== 'aaw.command.probe-build.v1' || proof.exitCode !== 0 || !proof.unchanged || !proof.output) throw new Error('No successful same-source probe build');
for (const item of proof.sources) { const file = path.resolve(root, item.path); if (!file.startsWith(root + path.sep) || ordinary(file).size !== item.bytes || sha(file) !== item.sha256) throw new Error('Build source changed'); }
const executable = path.resolve(root, proof.output.path);
if (executable !== path.join(evidence, process.argv[2], 'command-probe.exe') || ordinary(executable).size !== proof.output.bytes || sha(executable) !== proof.output.sha256) throw new Error('Probe binary changed');
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
if (sha(powershell) !== '8bb6fa8c283b4d92120b1ef249a9b311b0f804d4cabbe9981159976c8be76a5e') throw new Error('System PowerShell changed');
const nonce = crypto.randomBytes(16).toString('hex');
const run = path.join(evidence, 'probe-' + nonce);
fs.mkdirSync(run);
for (const leaf of ['control', 'runtime', 'work space 中文', 'home', 'temp', 'baseline']) fs.mkdirSync(path.join(run, leaf));
fs.writeFileSync(path.join(run, 'baseline', 'input.json'), '[19,23]\n', { flag: 'wx' });
const baselineHash = sha(path.join(run, 'baseline', 'input.json'));
for (const [source, destination] of [[node, 'node.exe'], [path.join(path.dirname(node), 'LICENSE'), 'LICENSE'], [path.join(root, 'tools', 'agent-command-runner-probe.ps1'), 'command.ps1'], [path.join(root, 'tools', 'agent-command-runner-probe.cjs'), 'probe.cjs']]) {
  ordinary(source); fs.copyFileSync(source, path.join(run, 'runtime', destination), fs.constants.COPYFILE_EXCL);
}
const commandHash = sha(path.join(run, 'runtime', 'command.ps1'));
const scriptHash = sha(path.join(run, 'runtime', 'probe.cjs'));
const admission = { schema: 'aaw.command.probe-admission.v1', createdAt: new Date().toISOString(), nonce, run, buildProofSha256: process.argv[3], executable, executableSha256: proof.output.sha256,
  shell: { path: powershell, bytes: 495616, sha256: sha(powershell) }, node: { bytes: 93381448, sha256: nodeSha }, commandHash, scriptHash, baselineHash,
  budgets: { nativeLaunches: 1, shellLaunches: 1, expectedNodeLaunches: 1, jobProcesses: 8, nativeDeadlineMs: 15000, logBytes: 1048576 },
  externalNetwork: false, realProjectAccess: false, credentials: false, bareHostShellFallback: false, scope: 'synthetic_compatibility_only' };
fs.writeFileSync(path.join(run, 'launcher-admission.json'), JSON.stringify(admission, null, 2) + '\n', { flag: 'wx' });
const child = spawn(executable, [nonce, commandHash, scriptHash], { cwd: run, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' } });
const stdout = [], stderr = []; let nativeBytes = 0, overflow = false;
for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => { nativeBytes += chunk.length; if (nativeBytes > 131072) { overflow = true; child.stdin.destroy(); } else chunks.push(chunk); });
let cancelledAt = null;
const guard = setTimeout(() => { cancelledAt = new Date().toISOString(); child.stdin.destroy(); }, 25000);
let forcedSupervisorExit = false;
const lastResort = setTimeout(() => { forcedSupervisorExit = true; child.kill(); }, 40000);
const outcome = await new Promise(resolve => { child.once('error', error => resolve({ code: null, signal: null, error: error.message })); child.once('close', (code, signal) => resolve({ code, signal, error: null })); });
clearTimeout(guard); clearTimeout(lastResort); child.stdin.destroy();
fs.writeFileSync(path.join(run, 'native.stdout.bin'), Buffer.concat(stdout), { flag: 'wx' });
fs.writeFileSync(path.join(run, 'native.stderr.bin'), Buffer.concat(stderr), { flag: 'wx' });
const resultFile = path.join(run, 'control', 'result.json');
const native = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
const result = { schema: 'aaw.command.probe-launch-result.v1', run, completedAt: new Date().toISOString(), outcome, overflow, cancelledAt, forcedSupervisorExit, native, baselineUnchanged: baselineHash === sha(path.join(run, 'baseline', 'input.json')),
  resultSha256: fs.existsSync(resultFile) ? sha(resultFile) : null, state: outcome.code === 0 && native?.cleanupConfirmed ? 'COMPATIBILITY_PROBE_COMPLETED' : 'COMPATIBILITY_PROBE_FAILED' };
fs.writeFileSync(path.join(run, 'launcher-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result) + '\n');
if (outcome.code !== 0 || !native?.cleanupConfirmed || overflow) process.exitCode = 1;
