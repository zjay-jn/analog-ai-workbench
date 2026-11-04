import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {runtimePaths} from '../runtime-paths';
import {nativeWindowsEnvironment} from '../native-environment';
import { PROJECT_READ_LIMITS } from '../../shared/agent/agent-project-read';
import { OA_READ_TOOL_NAMES } from '../../shared/agent/oa-read';
import { AGENT_SKILL_TOOL_NAMES } from '../../shared/agent/agent-skills';
import {FILESYSTEM_TOOL_NAMES} from '../../shared/agent/agent-filesystem-read';
import { engineGuardianIdentity, startEngineGuardian } from './engine-guardian';

const START_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 1000;
const STOP_TIMEOUT_MS = 3000;

/** Pins belong to this reviewed main module, never to a renderer request or discovered manifest. */
export const OPENCODE_SUPERVISOR_IDENTITY = Object.freeze({
  version: '1.18.17',
  get executable() { return runtimePaths().opencodeExecutable; },
  executableBytes: 178721160,
  executableSha256: '2d8ed451c4c3e4dd69b9dec026030ec5bd00814b8f2b81483f8d80e35d8dce54',
  get toolSource() { return path.join(runtimePaths().installationRoot, 'tools', 'agent-engine-pilot-sum.mjs'); },
  toolBytes: 2728,
  toolSha256: '71f1ffffe434107ee28282eb13eb364934ecfa927daf3c03d9c42dafcd34a1c6',
});
export const PROJECT_READ_NATIVE_TOOL_IDENTITY = Object.freeze({
  get source() { return path.join(runtimePaths().installationRoot, 'tools', 'agent-project-read-tools.mjs'); }, bytes: 15160,
  sha256: '96d30aed8315bb0b23bbaf8cc96171da04e7725779c2ba5e48ab0fefc9fbceeb',
});
const PROJECT_TOOL_NAMES = Object.freeze(['pilot_sum', 'project_list', 'project_find', 'project_search', 'project_read', 'wsl_results_list', 'wsl_results_read', 'wsl_waveform_list', 'wsl_waveform_read', 'wsl_waveform_metrics', ...OA_READ_TOOL_NAMES,...AGENT_SKILL_TOOL_NAMES,...FILESYSTEM_TOOL_NAMES]);
const WORK_TOOL_NAMES = Object.freeze([...PROJECT_TOOL_NAMES, 'work_list', 'work_read', 'work_write', 'work_edit', 'work_import', 'work_run', 'command_environment', 'command_start', 'command_status', 'command_log', 'command_stop']);

export type OpenCodeSupervisorExit = Readonly<{ exited: boolean; code: number | null; signal: string | null }>;
type DiagnosticMarker = 'npm_offline_cache_miss' | 'configuration_error';
export type OpenCodeSupervisorDiagnostics = Readonly<{ stdoutBytes: number; stderrBytes: number; outputLimitExceeded: boolean; markers: readonly DiagnosticMarker[] }>;
export type OpenCodeSupervisor = Readonly<{
  port: number;
  password: string;
  directory: string;
  conversationDirectory?: string;
  pid: number;
  controller?: import('../../shared/agent/agent-work-cycle').WorkCycleControllerRef;
  health(): Promise<boolean>;
  diagnostics(): OpenCodeSupervisorDiagnostics;
  stop(): Promise<OpenCodeSupervisorExit>;
  exited: Promise<OpenCodeSupervisorExit>;
}>;
type Services = Readonly<{ port: number; providerToken: string; toolToken: string }>;
type ExecutionProfile = 'live-deepseek'|'project-read'|'work-cycle';
type FailureCode = 'INVALID_CONFIGURATION' | 'IDENTITY_MISMATCH' | 'BUSY' | 'START_FAILED' | 'EXIT_UNCONFIRMED';
export class OpenCodeSupervisorError extends Error {
  constructor(readonly code: FailureCode, readonly diagnostics?: OpenCodeSupervisorDiagnostics) { super('OpenCode supervisor unavailable'); }
}
/** Main-only fixed ceiling. Each chat request still has its smaller frozen gateway timeout. */
export function openCodeProviderTimeout(profile?:ExecutionProfile,conversation?:boolean):number {
  if(profile!==undefined&&profile!=='live-deepseek'&&profile!=='project-read'&&profile!=='work-cycle'||conversation!==undefined&&typeof conversation!=='boolean'||conversation===true&&profile!=='work-cycle')throw new OpenCodeSupervisorError('INVALID_CONFIGURATION');
  return conversation===true?930000:profile===undefined?10000:600000;
}
/** Native owns compaction and loop termination for ordinary chat; old bounded profiles keep their recipe. */
export function openCodeConversationExecution() {
  return {
    compaction: { auto: true, prune: false, tail_turns: 0 },
    compactionAgent: { mode: 'subagent', permission: { '*': 'deny' } },
  } as const;
}
let starting = false;
let ownedProcess: object | undefined;

function exact(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new OpenCodeSupervisorError('INVALID_CONFIGURATION');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key) || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new OpenCodeSupervisorError('INVALID_CONFIGURATION');
  return value as Record<string, unknown>;
}

function validateServices(options: unknown): Services {
  const live=!!options&&typeof options==='object'&&Object.hasOwn(options,'profile');
  const conversation=!!options&&typeof options==='object'&&Object.hasOwn(options,'conversation');
  const outer = exact(options, ['services',...(live?['profile']:[]),...(conversation?['conversation']:[])]), service = exact(outer.services, ['port', 'providerToken', 'toolToken']);
  if(live&&outer.profile!=='live-deepseek'&&outer.profile!=='project-read'&&outer.profile!=='work-cycle')throw new OpenCodeSupervisorError('INVALID_CONFIGURATION');
  openCodeProviderTimeout(outer.profile as ExecutionProfile|undefined,outer.conversation as boolean|undefined);
  if (!Number.isSafeInteger(service.port) || (service.port as number) < 1024 || (service.port as number) > 65535 ||
      typeof service.providerToken !== 'string' || !/^[0-9a-f]{64}$/u.test(service.providerToken) ||
      typeof service.toolToken !== 'string' || !/^[0-9a-f]{64}$/u.test(service.toolToken) || service.providerToken === service.toolToken) throw new OpenCodeSupervisorError('INVALID_CONFIGURATION');
  return { port: service.port as number, providerToken: service.providerToken, toolToken: service.toolToken };
}

function samePath(first: string, second: string): boolean { return path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase(); }
function contained(filename: string): void {
  const roots = runtimePaths();
  if (![roots.installationRoot, roots.storageRoot].some(root => path.resolve(filename).toLowerCase().startsWith(root.toLowerCase() + path.sep))) throw new OpenCodeSupervisorError('IDENTITY_MISMATCH');
}
/** Check each ancestor, including the product root; junction/alias resolutions are rejected. */
function verifyPath(filename: string, regular: boolean): fs.Stats {
  const absolute = path.resolve(filename), chain: string[] = [];
  let cursor = absolute;
  for (;;) { chain.unshift(cursor); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  let result: fs.Stats | undefined;
  for (const entry of chain) {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || !samePath(fs.realpathSync(entry), entry)) throw new OpenCodeSupervisorError('IDENTITY_MISMATCH');
    if (entry === absolute && regular) {
      if (!stat.isFile() || stat.nlink !== 1) throw new OpenCodeSupervisorError('IDENTITY_MISMATCH');
    } else if (!stat.isDirectory()) throw new OpenCodeSupervisorError('IDENTITY_MISMATCH');
    result = stat;
  }
  return result!;
}
function pinnedFile(filename: string, expectedBytes: number, expectedHash: string): Buffer {
  contained(filename);
  const before = verifyPath(filename, true);
  if (before.size !== expectedBytes) throw new OpenCodeSupervisorError('IDENTITY_MISMATCH');
  const contents = fs.readFileSync(filename), digest = crypto.createHash('sha256').update(contents).digest('hex');
  const after = verifyPath(filename, true);
  if (digest !== expectedHash || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new OpenCodeSupervisorError('IDENTITY_MISMATCH');
  return contents;
}
function createDirectory(directory: string, fresh = false): void {
  contained(directory); verifyPath(path.dirname(directory), false);
  try { fs.mkdirSync(directory); }
  catch (error) { if (fresh || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  verifyPath(directory, false);
}
function writeNew(filename: string, contents: string | Buffer): void {
  contained(filename); verifyPath(path.dirname(filename), false);
  fs.writeFileSync(filename, contents, { flag: 'wx', mode: 0o600 });
  verifyPath(filename, true);
}

function prepareLaunch(services: Services, port: number, password: string, profile?:ExecutionProfile,conversation?:boolean) {
  const locations = runtimePaths(), PRODUCT = locations.installationRoot, PILOT_ROOT = locations.pilotRoot;
  const identity = OPENCODE_SUPERVISOR_IDENTITY;
  // Never discover another binary or accept the hash found beside a substituted candidate.
  pinnedFile(identity.executable, identity.executableBytes, identity.executableSha256);
  const module = pinnedFile(identity.toolSource, identity.toolBytes, identity.toolSha256);
  const projectModule = profile==='project-read'||profile==='work-cycle' ? pinnedFile(PROJECT_READ_NATIVE_TOOL_IDENTITY.source, PROJECT_READ_NATIVE_TOOL_IDENTITY.bytes, PROJECT_READ_NATIVE_TOOL_IDENTITY.sha256) : null;
  const toolNames = profile==='work-cycle' ? WORK_TOOL_NAMES : PROJECT_TOOL_NAMES;
  verifyPath(PRODUCT, false);
  verifyPath(locations.storageRoot, false);
  for (const directory of [locations.dataRoot, PILOT_ROOT, path.join(PILOT_ROOT, 'native')]) createDirectory(directory);
  const root = path.join(PILOT_ROOT, 'native', crypto.randomUUID());
  createDirectory(root, true);
  const dirs = Object.fromEntries(['cwd', 'home', 'config', 'data', 'cache', 'state', 'temp', 'managed', 'appdata', 'localappdata'].map(name => [name, path.join(root, name)])) as Record<string, string>;
  for (const directory of Object.values(dirs)) createDirectory(directory, true);
  let conversationDirectory:string|undefined;
  if(conversation){
    conversationDirectory=path.join(PILOT_ROOT,'conversations');createDirectory(conversationDirectory);
    for(const name of ['cwd','data','state']){const directory=path.join(conversationDirectory,name);createDirectory(directory);dirs[name]=directory;}
  }
  const configDirectory = path.join(dirs.config!, 'opencode'), toolsDirectory = path.join(configDirectory, 'tools');
  createDirectory(configDirectory, true); createDirectory(toolsDirectory, true);
  for (const directory of [dirs.cwd!, configDirectory]) {
    for(const name of ['package.json','tsconfig.json']){const filename=path.join(directory,name);if(conversation&&directory===dirs.cwd!&&fs.existsSync(filename)){verifyPath(filename,true);if(fs.readFileSync(filename,'utf8')!=='{}\n')throw new OpenCodeSupervisorError('IDENTITY_MISMATCH');}else writeNew(filename,'{}\n');}
  }
  const modelsFile = path.join(dirs.cache!, 'models.json'), userNpmrc = path.join(root, 'user.npmrc'), globalNpmrc = path.join(root, 'global.npmrc');
  writeNew(modelsFile, '{}\n'); writeNew(userNpmrc, ''); writeNew(globalNpmrc, '');
  const npmrc=path.join(dirs.cwd!,'.npmrc'),npmrcText='offline=true\naudit=false\nregistry=http://127.0.0.1:9\n';
  if(conversation&&fs.existsSync(npmrc)){verifyPath(npmrc,true);if(fs.readFileSync(npmrc,'utf8')!==npmrcText)throw new OpenCodeSupervisorError('IDENTITY_MISMATCH');}else writeNew(npmrc,npmrcText);
  if(projectModule){
    const helper=path.join(configDirectory,'project-read-native.mjs'); writeNew(helper,projectModule);
    pinnedFile(helper,PROJECT_READ_NATIVE_TOOL_IDENTITY.bytes,PROJECT_READ_NATIVE_TOOL_IDENTITY.sha256);
    for(const name of toolNames){
      const wrapper=`import { createProjectReadNativeTool } from '../project-read-native.mjs';\nexport default createProjectReadNativeTool('${name}');\n`;
      const installed=path.join(toolsDirectory,name+'.js');writeNew(installed,wrapper);
      pinnedFile(installed,Buffer.byteLength(wrapper),crypto.createHash('sha256').update(wrapper).digest('hex'));
    }
  }else{
    const installedTool = path.join(toolsDirectory, 'pilot_sum.js'); writeNew(installedTool, module); pinnedFile(installedTool, identity.toolBytes, identity.toolSha256);
  }
  const expectedTools=projectModule?toolNames.map(name=>name+'.js').sort().join(','):'pilot_sum.js';
  const expectedConfig=projectModule?'package.json,project-read-native.mjs,tools,tsconfig.json':'package.json,tools,tsconfig.json';
  if(fs.readdirSync(toolsDirectory).sort().join(',')!==expectedTools||fs.readdirSync(configDirectory).sort().join(',')!==expectedConfig)throw new OpenCodeSupervisorError('IDENTITY_MISMATCH');
  const disabledAgents = Object.fromEntries(['title', 'summary', 'compaction', 'general', 'explore', 'build', 'plan'].map(name => [name, { disable: true }]));
  const configuration:Record<string,unknown> = {
    username: 'pilot', autoupdate: false, snapshot: false, share: 'disabled', plugin: [], mcp: {}, instructions: [], enabled_providers: ['pilot'],
    skills: { paths: [], urls: [] }, lsp: false, formatter: false, compaction: { auto: false, prune: false },
    permission: { '*': 'deny', pilot_sum: 'allow', question: 'allow' },
    model: 'pilot/mock', small_model: 'pilot/mock', default_agent: 'pilot',
    provider: {
      pilot: {
        npm: '@ai-sdk/openai-compatible', name: 'Pilot loopback', env: [],
        options: { baseURL: `http://127.0.0.1:${services.port}/v1`, apiKey: services.providerToken, timeout: 10000 },
        models: { mock: { name: 'Pilot deterministic mock', tool_call: true, reasoning: false, attachment: false, limit: { context: 32768, output: 2048 }, modalities: { input: ['text'], output: ['text'] } } },
      },
    },
    agent: { ...disabledAgents, pilot: { mode: 'primary', model: 'pilot/mock', steps: 4, permission: { '*': 'deny', pilot_sum: 'allow', question: 'allow' } } },
  };
  // Fixed live recipe. Only this random loopback token reaches native; real credentials stay in main.
  if(profile==='live-deepseek'||profile==='project-read'||profile==='work-cycle')Object.assign(configuration,{
    enabled_providers:['workbench'],model:'workbench/deepseek-v4-flash',small_model:'workbench/deepseek-v4-flash',
    provider:{workbench:{npm:'@ai-sdk/openai-compatible',name:'Workbench restricted gateway',env:[],options:{baseURL:`http://127.0.0.1:${services.port}/v1`,apiKey:services.providerToken,timeout:openCodeProviderTimeout(profile,conversation),...(conversation?{headerTimeout:false}:{})},models:{'deepseek-v4-flash':{name:'DeepSeek requested alias',tool_call:true,reasoning:false,attachment:false,limit:{context:65536,output:16384},modalities:{input:['text'],output:['text']}}}}},
    agent:{...disabledAgents,pilot:{mode:'primary',model:'workbench/deepseek-v4-flash',steps:8,permission:{'*':'deny',pilot_sum:'allow',question:'allow'}}},
  });
  if(profile==='project-read'||profile==='work-cycle'){
    const provider=configuration.provider as Record<string,Record<string,unknown>>;
    const models=provider.workbench!.models as Record<string,unknown>;
    // The gateway keeps preserved reasoning in main; native receives only validated text and tool calls.
    models['kimi-k3']={name:'Kimi K3 requested alias',tool_call:true,reasoning:false,attachment:conversation===true,limit:{context:65536,output:16384},modalities:{input:conversation?['text','image']:['text'],output:['text']}};
    configuration.model='workbench/kimi-k3';configuration.small_model='workbench/kimi-k3';
    const permission={'*':'deny',question:'allow',...Object.fromEntries(toolNames.map(name=>[name,'allow']))};
    configuration.permission=permission;
    configuration.agent={...disabledAgents,pilot:{mode:'primary',model:'workbench/kimi-k3',...(conversation?{}:{steps:PROJECT_READ_LIMITS.nativeSteps}),permission}};
    if(conversation){
      const recipe=openCodeConversationExecution();
      configuration.compaction=recipe.compaction;
      // No explicit model: native compaction uses this session's frozen user model.
      configuration.agent={...configuration.agent as Record<string,unknown>,compaction:recipe.compactionAgent};
    }
  }
  const os = nativeWindowsEnvironment(), windows = os.SystemRoot!;
  // Construct from an empty object: no inherited keys, credential sources, proxies, NODE_OPTIONS or personal paths.
  const env: NodeJS.ProcessEnv = {
    SystemRoot: windows, WINDIR: windows, SystemDrive: os.SystemDrive!, PATH: path.join(windows, 'System32'),
    HOME: dirs.home!, USERPROFILE: dirs.home!, APPDATA: dirs.appdata!, LOCALAPPDATA: dirs.localappdata!, TEMP: dirs.temp!, TMP: dirs.temp!,
    XDG_CONFIG_HOME: dirs.config!, XDG_DATA_HOME: dirs.data!, XDG_CACHE_HOME: dirs.cache!, XDG_STATE_HOME: dirs.state!,
    OPENCODE_TEST_HOME: dirs.home!, OPENCODE_TEST_MANAGED_CONFIG_DIR: dirs.managed!, OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_MODELS_PATH: modelsFile, OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration),
    OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password,
    AAW_PILOT_TOOL_PORT: String(services.port), AAW_PILOT_TOOL_TOKEN: services.toolToken,
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_registry: 'http://127.0.0.1:9', npm_config_cache: dirs.cache!,
    npm_config_userconfig: userNpmrc, npm_config_globalconfig: globalNpmrc,
  };
  for (const name of ['OPENCODE_PURE', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'OPENCODE_DISABLE_LSP_DOWNLOAD', 'OPENCODE_DISABLE_EMBEDDED_WEB_UI', 'OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER']) env[name] = 'true';
  verifyPath(identity.executable, true); verifyPath(dirs.cwd!, false);
  return { root, directory: dirs.cwd!, env: Object.freeze(env), port,conversationDirectory };
}

async function choosePort(): Promise<number> {
  const server = net.createServer();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      const fail = () => { try { server.close(); } catch {} reject(new OpenCodeSupervisorError('START_FAILED')); };
      timer = setTimeout(fail, HEALTH_TIMEOUT_MS);
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string' || address.port < 1024 || address.port > 65535) { fail(); return; }
        server.close(error => { if (error) fail(); else resolve(address.port); });
      });
    });
  } finally { if (timer) clearTimeout(timer); }
}

/** Main-only. This is controlled process startup, not an OS sandbox or proof of zero network activity. */
export async function startOpenCodeSupervisor(options: Readonly<{ services: Services; profile?:ExecutionProfile; conversation?:boolean }>): Promise<OpenCodeSupervisor> {
  const services = validateServices(options);
  const profile=options.profile,conversation=options.conversation;
  if (process.platform !== 'win32') throw new OpenCodeSupervisorError('INVALID_CONFIGURATION');
  if (starting || ownedProcess) throw new OpenCodeSupervisorError('BUSY');
  starting = true;
  let cleanup: (() => Promise<OpenCodeSupervisorExit>) | undefined;
  let safeDiagnostics: (() => OpenCodeSupervisorDiagnostics) | undefined;
  try {
    const port = await choosePort(), password = crypto.randomBytes(32).toString('hex');
    if (port === services.port || password === services.providerToken || password === services.toolToken) throw new OpenCodeSupervisorError('INVALID_CONFIGURATION');
    const plan = prepareLaunch(services, port, password, profile, conversation);
    const guardian=startEngineGuardian({root:plan.root,port,env:plan.env,identity:engineGuardianIdentity()}),child=guardian.child;
    const ownership = {};
    ownedProcess = ownership;
    let exit: OpenCodeSupervisorExit | undefined, stopping = false, processFailed = false, stoppingPromise: Promise<OpenCodeSupervisorExit> | undefined;
    const healthControllers = new Set<AbortController>();
    const abortHealth = () => { for (const controller of healthControllers) controller.abort(); };
    let resolveExit!: (value: OpenCodeSupervisorExit) => void;
    const exited = new Promise<OpenCodeSupervisorExit>(resolve => { resolveExit = resolve; });
    let rejectProcess!: (error: Error) => void;
    const processFailure = new Promise<never>((_resolve, reject) => { rejectProcess = reject; });
    const recordExit = (value: OpenCodeSupervisorExit) => {
      if (exit) return;
      exit = Object.freeze(value);
      if (value.exited && ownedProcess === ownership) ownedProcess = undefined;
      abortHealth(); resolveExit(exit);
    };
    // A failed spawn with no PID has no owned process to wait for or kill. Its error may only be followed by close.
    child.on('error', () => { processFailed = true; rejectProcess(new OpenCodeSupervisorError('START_FAILED')); abortHealth(); });
    void guardian.exited.then(recordExit);
    void guardian.ready.catch(()=>{processFailed=true;rejectProcess(new OpenCodeSupervisorError('START_FAILED'));abortHealth();});
    void processFailure.catch(() => {});
    const stop = async (): Promise<OpenCodeSupervisorExit> => {
      if (exit) return exit;
      if (stoppingPromise) return stoppingPromise;
      stopping = true; abortHealth();
      stoppingPromise = (async () => {
        const value=await guardian.stop();if(value.exited)recordExit(value);return value;
      })();
      return stoppingPromise;
    };
    cleanup = stop;
    const byteCounts = { stdout: 0, stderr: 0 }, markers = new Set<DiagnosticMarker>();
    let outputLimitExceeded = false;
    const tails = { stdout: '', stderr: '' };
    const observeOutput = (kind: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (exit || stopping) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCounts[kind] = Math.min(8193, byteCounts[kind] + buffer.byteLength);
      if (byteCounts[kind] > 8192) { outputLimitExceeded = true; processFailed = true; tails.stdout = ''; tails.stderr = ''; rejectProcess(new OpenCodeSupervisorError('START_FAILED')); void stop(); return; }
      const text = tails[kind] + buffer.toString('utf8');
      // These are evidence hints only. No raw text leaves this closure, and neither marker proves OS/network isolation.
      if (text.includes('ENOTCACHED')) markers.add('npm_offline_cache_miss');
      if (text.includes('ConfigInvalidError') || text.includes('ConfigJsonError')) markers.add('configuration_error');
      tails[kind] = text.slice(-64);
    };
    child.stdout?.on('data', chunk => observeOutput('stdout', chunk));
    child.stderr?.on('data', chunk => observeOutput('stderr', chunk));
    void exited.then(() => { tails.stdout = ''; tails.stderr = ''; });
    const diagnostics = (): OpenCodeSupervisorDiagnostics => Object.freeze({ stdoutBytes: byteCounts.stdout, stderrBytes: byteCounts.stderr, outputLimitExceeded, markers: Object.freeze([...markers]) });
    safeDiagnostics = diagnostics;
    const health = async (): Promise<boolean> => {
      if (exit || stopping || processFailed) return false;
      const controller = new AbortController(); healthControllers.add(controller);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const url = `http://127.0.0.1:${port}/global/health`;
      try {
        const operation = (async () => {
          const response = await fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, Accept: 'application/json' } });
          if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !response.body) { void response.body?.cancel().catch(() => {}); return false; }
          const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
          try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 1024 || controller.signal.aborted) return false; chunks.push(chunk.value); } }
          finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
          const data = exact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), ['healthy', 'version']);
          return !exit && !stopping && !processFailed && !controller.signal.aborted && data.healthy === true && data.version === OPENCODE_SUPERVISOR_IDENTITY.version;
        })();
        return await Promise.race([operation, new Promise<boolean>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, HEALTH_TIMEOUT_MS); })]);
      } catch { return false; }
      finally { if (timer) clearTimeout(timer); controller.abort(); healthControllers.delete(controller); }
    };
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { await guardian.ready;for (;;) { if (exit || processFailed || stopping) throw new OpenCodeSupervisorError('START_FAILED'); if (await health()) return; await new Promise<void>(resolve => setTimeout(resolve, 100)); } })(),
        processFailure,
        exited.then(() => { throw new OpenCodeSupervisorError('START_FAILED'); }),
        new Promise<never>((_resolve, reject) => { startupTimer = setTimeout(() => reject(new OpenCodeSupervisorError('START_FAILED')), START_TIMEOUT_MS); }),
      ]);
    } finally { if (startupTimer) clearTimeout(startupTimer); }
    if (exit || stopping || processFailed || !Number.isSafeInteger(child.pid) || child.pid! < 1) throw new OpenCodeSupervisorError('START_FAILED');
    const engine=await guardian.ready;
    const controller=await guardian.controller;
    return Object.freeze({ port, password, directory: plan.directory,...(plan.conversationDirectory?{conversationDirectory:plan.conversationDirectory}:{}), pid: engine.pid, controller, health, diagnostics, stop, exited });
  } catch (error) {
    if (cleanup && !(await cleanup()).exited) throw new OpenCodeSupervisorError('EXIT_UNCONFIRMED', safeDiagnostics?.());
    throw new OpenCodeSupervisorError(error instanceof OpenCodeSupervisorError ? error.code : 'START_FAILED', safeDiagnostics?.());
  } finally { starting = false; }
}
