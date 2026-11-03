/// <reference path="../schematic/cloud-raw-assets.d.ts" />
import path from 'node:path';
import {createCommandDiagnosticJournal} from '../agent-command/diagnostics';
import {inspectNativePath} from '../agent-command/native-files';
import productPackage from '../../../../../package.json';
import type { DesktopBootstrapOptionsV1 } from '../bootstrap';
import type { CloudProviderIdV2 } from '../../shared/agent/cloud-chat-api';
import type { ImageAttachment } from '../../shared/agent/image-attachment';
import { createProductionReviewedArtifactRegistryV1 } from '../schematic/reviewed-artifact-registry';
import { createEmptyAgentBackendV1 } from '../agent/empty-agent-backend';
import { readCloudCredentialFileV1 } from '../cloud/credential-file';
import { performCloudChatV1, performCloudChatV2, type CloudFetchV1 } from '../cloud/cloud-transport';
import { createModelSettings, type KeyEncryption, type ModelSettingsHost } from '../cloud/model-settings-host';
import { sessionExtension } from '../cloud/register-session-ipc';
import type { createSessionHost } from '../cloud/session-host';
import { createUnifiedChatCoordinator } from '../cloud/unified-chat-coordinator';
import { reviewedSaveExtension } from '../cloud/register-reviewed-save';
import { workspaceExtension } from '../cloud/register-workspace';
import { displayPathExtension } from '../cloud/register-display-paths';
import { projectFolderExtension } from '../cloud/register-project-folders';
import { reviewedSchematicExtension } from '../schematic/register-reviewed-schematic';
import { createReviewedSourceLoader } from '../schematic/reviewed-source-loader';
import { cloudSchematicExtension, type CloudSchematicHostOptions } from '../schematic/cloud-synthetic-schematic';
import { createPilotStore, PilotStorageError, type PilotStore } from '../engine-pilot/store';
import type { PilotEngine } from '../engine-pilot/engine';
import { pilotExtension } from '../engine-pilot/register-ipc';
import { createUnreadyOpenCodePilotEngine } from '../engine-pilot/opencode-client';
import { startOpenCodeSupervisor } from '../engine-pilot/opencode-supervisor';
import { registeredCommandDrivers } from '../agent-command/registered-profile';
import { createLiveRuntime } from './runtime';
import { createInitializationShutdown, type ShutdownFailureCode, type ShutdownParticipant } from './shutdown';
import { createAgentRuntimeArbiter } from '../agent-project-read/runtime-arbiter';
import { createArbitratedCalculationRuntime } from '../agent-project-read/calculation-runtime';
import { createProjectReadModelSnapshots, createProjectReadRuntime, type ProjectReadModelSnapshots } from '../agent-project-read/runtime';
import { createProjectReadModelSelection } from '../agent-project-read/model-selection';
import { createProjectReadStore, ProjectReadStoreError, type ProjectReadStore } from '../agent-project-read/store';
import { createWslResultsService } from '../wsl-results/service';
import { createWslResultsSettings } from '../wsl-results/settings';
import { createWaveformResultsService } from '../waveform-results/service';
import { prepareWaveformReaderDirectory } from '../agent-project-read/waveform-directory';
import { projectReadExtension } from '../agent-project-read/register-ipc';
import { createWorkCycleWorkspace } from '../agent-work-cycle/workspace';
import { createWorkCycleRunner } from '../agent-work-cycle/runner';
import { createOaReadRuntime } from '../oa-read/runtime';

type ExtensionContext = Parameters<NonNullable<DesktopBootstrapOptionsV1['registerExtension']>>[0];
type Credentials = Partial<Record<CloudProviderIdV2, string>>;
type ChooseFile = (name: string, context: ExtensionContext) => Promise<string | undefined>;
export type CloudDesktopDependencies = Readonly<{
  credentials: () => Credentials;
  encryption: KeyEncryption;
  chatV1: typeof performCloudChatV1;
  chatV2: typeof performCloudChatV2;
  providerFetch: CloudFetchV1;
  nativeFactory: typeof startOpenCodeSupervisor;
  liveBudget: Readonly<{ maxRequests: number; maxOutputTokens: number; requestTimeoutMs: number; deadlineMs: number; waitMs: number }>;
  loadReviewed: ReturnType<typeof createReviewedSourceLoader>;
  loadSynthetic: CloudSchematicHostOptions['loadRaw'];
  chooseExportFile?: ChooseFile;
  chooseEditFile?: ChooseFile;
  chooseFolder?: (context: ExtensionContext) => Promise<string | undefined>;
  validateImages?: (images: ImageAttachment[]) => void;
  onTraffic?: (value: unknown) => void;
  onShutdownFailure?: (code: ShutdownFailureCode) => void;
  appVersion?: string;
  revealDiagnostics?:()=>Promise<boolean>;
  createOaRuntime?: (scope: Readonly<{runId:string;projectId:string}>) => ReturnType<typeof createOaReadRuntime>;
}>;
export type CloudDesktopOptions = Readonly<{
  mode: 'production';
  applicationRoot: string;
}> | Readonly<{
  mode: 'qa';
  applicationRoot: string;
  dataRoot: string;
  profileRoot: string;
  dependencies: CloudDesktopDependencies;
}>;
type PreparedCloudOptions = Readonly<{
  mode: 'production' | 'qa';
  applicationRoot: string;
  dataRoot: string;
  profileRoot: string;
  dependencies: CloudDesktopDependencies;
}>;
const PRODUCT_ROOT = path.resolve('C:/work/analog_ai_workbench');
const fail = (): never => { throw Error('CLOUD_BOOTSTRAP_CONFIGURATION'); };
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function validate(options: PreparedCloudOptions): void {
  if (!options || !['production', 'qa'].includes(options.mode)) fail();
  for (const name of ['applicationRoot', 'dataRoot', 'profileRoot'] as const) {
    if (typeof options[name] !== 'string' || !path.isAbsolute(options[name]) || path.resolve(options[name]) !== options[name]) fail();
  }
  if (options.applicationRoot !== PRODUCT_ROOT && !inside(PRODUCT_ROOT, options.applicationRoot)) fail();
  if (options.mode === 'qa') {
    const relative = path.relative(PRODUCT_ROOT, options.dataRoot).replaceAll('\\', '/');
    if (!/^\.local\/agent-engine-live-tests\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(relative) || !inside(options.dataRoot, options.profileRoot)) fail();
  } else if (options.dataRoot !== path.join(PRODUCT_ROOT, '.local') || options.profileRoot !== path.join(options.dataRoot, 'cloud-user-data')) fail();
  const dependencies = options.dependencies;
  if (!dependencies || typeof dependencies !== 'object') fail();
  for (const name of ['credentials', 'chatV1', 'chatV2', 'providerFetch', 'nativeFactory', 'loadReviewed', 'loadSynthetic'] as const) {
    if (typeof dependencies[name] !== 'function') fail();
  }
  if (!dependencies.encryption || ['available', 'encrypt', 'decrypt'].some(name => typeof dependencies.encryption[name as keyof KeyEncryption] !== 'function')) fail();
  const caps = { maxRequests: 8, maxOutputTokens: 16384, requestTimeoutMs: 600_000, deadlineMs: 4_800_000, waitMs: 1_800_000 };
  if (!dependencies.liveBudget || typeof dependencies.liveBudget !== 'object' || Object.keys(dependencies.liveBudget).length !== Object.keys(caps).length) fail();
  for (const name of Object.keys(caps) as (keyof typeof caps)[]) {
    const value = dependencies.liveBudget[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > caps[name]) fail();
  }
  for (const name of ['chooseExportFile', 'chooseEditFile', 'chooseFolder', 'validateImages', 'onTraffic', 'onShutdownFailure', 'createOaRuntime'] as const) {
    if (dependencies[name] !== undefined && typeof dependencies[name] !== 'function') fail();
  }
}

/** Importing this module and preparing options never open credentials, stores, Electron or native. */
export function createCloudDesktopOptions(options: PreparedCloudOptions): DesktopBootstrapOptionsV1 {
  validate(options);
  // Capture main-only references once so later caller mutation cannot swap transports.
  const dependencies = Object.freeze({ ...options.dependencies, encryption: Object.freeze({ ...options.dependencies.encryption }), liveBudget: Object.freeze({ ...options.dependencies.liveBudget }) });
  const { applicationRoot, dataRoot } = options;
  return {
    applicationRoot, applicationVersion: '0.1.0-alpha.0', buildProfile: 'production', preloadEntry: 'sessions.js',
    ...(dependencies.onShutdownFailure ? { onShutdownFailure: dependencies.onShutdownFailure } : {}),
    createReviewedRegistry: () => createProductionReviewedArtifactRegistryV1(),
    createAgentBackend: () => createEmptyAgentBackendV1(),
    registerExtension: context => {
      const keys: Credentials = {};
      let runtime: PilotEngine | undefined, tools: ShutdownParticipant | undefined, toolStore: PilotStore | undefined, sharedSettings: ModelSettingsHost | undefined;
      const arbiter = createAgentRuntimeArbiter();
      let projectTools: ShutdownParticipant | undefined, projectStore: ProjectReadStore | undefined, projectModels: ProjectReadModelSnapshots | undefined;
      let sessionHost: ReturnType<typeof createSessionHost> | undefined;
      const clearKeys = () => { delete keys.deepseek; delete keys.kimi; };
      const report = (code: ShutdownFailureCode) => { console.error(code); dependencies.onShutdownFailure?.(code); };
      const cleanup = createInitializationShutdown({ timeoutMs: 45_000, onFailure: report });
      const extension = { revoke: cleanup.revoke, shutdown: cleanup.shutdown, dispose() { cleanup.revoke(); void cleanup.shutdown().catch(() => {}); } };
      try {
        // Enroll before credentials or any store/host constructor can throw.
        context.registerCleanup?.(extension);
        cleanup.register({ revoke() { tools?.revoke(); projectTools?.revoke(); }, shutdown: () => projectTools?.shutdown?.() ?? Promise.resolve(), dispose() { tools?.dispose(); projectTools?.dispose(); } });
        cleanup.register({ revoke() { runtime?.dispose(); }, shutdown: () => runtime?.shutdown?.() ?? Promise.resolve(), dispose() { runtime?.dispose(); } });
        cleanup.register({ revoke() {}, async shutdown() {
          // Task owners persist their cleanup outcome before the arbiter revokes lease mutation.
          await Promise.allSettled([projectTools?.shutdown?.(), runtime?.shutdown?.()]); await arbiter.close();
        }, dispose() {} });
        cleanup.register({ revoke() {}, dispose() { toolStore?.close(); projectStore?.close(); projectModels?.close(); } });
        const clearSettings = () => { sharedSettings?.dispose(); clearKeys(); };
        cleanup.register({ revoke: clearSettings, dispose: clearSettings });
        const supplied = dependencies.credentials();
        cleanup.assertOpen();
        if (supplied.deepseek) keys.deepseek = supplied.deepseek;
        if (supplied.kimi) keys.kimi = supplied.kimi;
        const settings = sharedSettings = createModelSettings({ root: PRODUCT_ROOT, directory: path.join(dataRoot, 'model-settings'), legacyKeys: keys, encryption: dependencies.encryption });
        cleanup.assertOpen();
        // Tool-only initialization failure must leave the cloud chat available.
        try { runtime = createArbitratedCalculationRuntime({ arbiter, create: () => createLiveRuntime({ settings, fetchImpl: dependencies.providerFetch, startNative: dependencies.nativeFactory, budget: dependencies.liveBudget, ...(dependencies.onTraffic ? { onTraffic: dependencies.onTraffic } : {}) }) }); }
        catch { runtime = { ...createUnreadyOpenCodePilotEngine(), liveStatus: () => ({ canStart: false, processState: 'failed' as const, availability: 'unavailable' as const }) }; }
        try { toolStore = createPilotStore(PRODUCT_ROOT, path.join(dataRoot, 'agent-engine-live')); }
        catch { toolStore = { load() { throw new PilotStorageError(); }, save() { throw new PilotStorageError(); }, close() {} }; }
        tools = pilotExtension({ store: toolStore, engine: runtime })(context);
        const workspace = workspaceExtension({ root: PRODUCT_ROOT, directory: path.join(dataRoot, 'project-workspace'), activeSessionId: () => sessionHost?.activeSessionId() ?? null })(context);
        cleanup.register(workspace);
        const reviewed = reviewedSchematicExtension({ hasProject: workspace.hasProject, loadEnvelope: dependencies.loadReviewed })(context);
        cleanup.register(reviewed);
        cleanup.register(reviewedSaveExtension(name => dependencies.chooseEditFile?.(name, context) ?? Promise.resolve(undefined))(context));
        cleanup.register(displayPathExtension({ root: PRODUCT_ROOT, directory: path.join(dataRoot, 'display-paths') })(context));
        const folders = projectFolderExtension({ root: PRODUCT_ROOT, directory: path.join(dataRoot, 'project-folders'), hasProject: workspace.hasProject, workspace, chooseFolder: () => dependencies.chooseFolder?.(context) ?? Promise.resolve(undefined) })(context);
        cleanup.register(folders);
        const models = projectModels = createProjectReadModelSnapshots(settings,createProjectReadModelSelection(PRODUCT_ROOT,dataRoot));
        try { projectStore = createProjectReadStore(PRODUCT_ROOT, path.join(dataRoot, 'agent-project-read')); }
        catch { projectStore = { load() { throw new ProjectReadStoreError(); }, save() { throw new ProjectReadStoreError(); }, close() {} }; }
        const project = projectReadExtension({ store: projectStore, bindings: folders, models, arbiter,
          ...(dependencies.createOaRuntime?{createOaRuntime:dependencies.createOaRuntime}:{}),
          protectedRoots:Object.freeze([
            ...[dataRoot,path.join(PRODUCT_ROOT,'.local')].flatMap(root=>['model-settings','chat-history','chat-drafts','project-workspace','project-folders','display-paths','agent-engine-live','agent-project-read','agent-project-read-model','agent-work-cycle','agent-command','diagnostics','wsl-results'].map(name=>path.join(root,name))),
            options.profileRoot,path.join(PRODUCT_ROOT,'.local','cloud-user-data'),
            ...['agent-engine-pilot','agent-engine-candidate-v1.18.17','agent-work-cycle-runner','agent-command-runner'].map(name=>path.join(PRODUCT_ROOT,'.local',name)),
          ]),
          chatReferences: () => {
            // Fail closed during construction/revocation; unavailable chat history is not an empty reference set.
            if (!sessionHost) throw Error('CHAT_REFERENCES_UNAVAILABLE');
            return sessionHost.referencedRunIds();
          },
          workCycle: {directory:path.join(dataRoot,'agent-work-cycle','workspaces'),createWorkspace:createWorkCycleWorkspace,createRunner:createWorkCycleRunner},
          commands:{directory:path.join(dataRoot,'agent-command','runs'),drivers:registeredCommandDrivers(),diagnostics:createCommandDiagnosticJournal({directory:path.join(dataRoot,'diagnostics'),appVersion:dependencies.appVersion??'0.0.0-synthetic-qa'}),...(dependencies.revealDiagnostics?{revealDiagnostics:dependencies.revealDiagnostics}:{})},
          capacity:{workExecutions:path.join(PRODUCT_ROOT,'.local','agent-work-cycle-runner','executions'),commandExecutions:path.join(PRODUCT_ROOT,'.local','agent-command-runner','executions')},
          wslResults:{settings:createWslResultsSettings({directory:path.join(dataRoot,'wsl-results')}),createService:()=>createWslResultsService(),createWaveformService:()=>createWaveformResultsService({directory:prepareWaveformReaderDirectory(PRODUCT_ROOT,dataRoot)})},
          createEngine: (workCycle=false, conversation=false) => createProjectReadRuntime({ models, workCycle, conversation, fetchImpl: dependencies.providerFetch, startNative: dependencies.nativeFactory, ...(dependencies.onTraffic ? { onTraffic: dependencies.onTraffic } : {}) }) })(context);
        projectTools = project;
        const turns = createUnifiedChatCoordinator({
          project: project.host, arbiter, workspace: () => {
            const snapshot = workspace.creationSnapshot();
            if (!snapshot.ok) throw Error('CHAT_WORKSPACE_UNAVAILABLE');
            return snapshot.value;
          },
          getSession: id => sessionHost?.getSession(id),
          plain: (request, execution) => dependencies.chatV2(request, { ...execution, unifiedContext: true, apiKey: settings.key(request.provider) ?? '' }),
        });
        const sessions = sessionExtension({
          root: PRODUCT_ROOT, directory: path.join(dataRoot, 'chat-history'), draftDirectory: path.join(dataRoot, 'chat-drafts'),
          configured: settings.configured(), settingsFactory: () => settings, turns,
          execute: (request, execution) => dependencies.chatV1(request, { ...execution, apiKey: settings.key(request.provider) ?? '' }),
          executeMultimodal: (request, execution) => dependencies.chatV2(request, { ...execution, apiKey: settings.key(request.provider) ?? '' }),
          validateSchematicContexts: (sessionId, contexts) => {
            const projectId = workspace.projectForSession(sessionId);
            if (!projectId) throw Error('Schematic project unavailable');
            reviewed.validateContextsForProject(projectId, contexts);
          },
          chooseExportFile: name => dependencies.chooseExportFile?.(name, context) ?? Promise.resolve(undefined),
          validateImages: dependencies.validateImages ?? (images => { if (images.length) throw Error('Invalid image'); }),
          clearCredentials: clearKeys,
        })(context);
        sessionHost = sessions.host;
        cleanup.register(sessions);
        cleanup.register(cloudSchematicExtension({ hasProject: workspace.hasProject, loadRaw: dependencies.loadSynthetic })(context));
        return extension;
      } catch {
        void cleanup.shutdown().catch(() => {});
        throw Error('CLOUD_BOOTSTRAP_INITIALIZATION');
      } finally { cleanup.completeConstruction(); }
    },
  };
}

/** Normal cloud and isolated QA use this same bootstrap and extension composition. */
export async function startCloudDesktop(options: CloudDesktopOptions): Promise<void> {
  let prepared: PreparedCloudOptions;
  if (options.mode === 'qa') {
    prepared = options;
    validate(prepared);
  } else if (options.mode === 'production') {
    const electron = await import('electron');
    const chooseWindow = (context: ExtensionContext) => {
      const contents = electron.webContents.fromId(context.owner.webContentsId);
      return contents ? electron.BrowserWindow.fromWebContents(contents) : null;
    };
    prepared = {
      ...options, dataRoot: path.join(PRODUCT_ROOT, '.local'), profileRoot: path.join(PRODUCT_ROOT, '.local', 'cloud-user-data'),
      dependencies: {
        appVersion:productPackage.version,
        revealDiagnostics:async()=>{const file=path.join(PRODUCT_ROOT,'.local','diagnostics','diagnostics.jsonl');try{inspectNativePath(file,false);electron.shell.showItemInFolder(file);return true;}catch{return false;}},
        credentials: () => {
          const keys: Credentials = {};
          for (const provider of ['deepseek', 'kimi'] as const) {
            try { keys[provider] = readCloudCredentialFileV1({ provider, filePath: 'D:/api.txt', authorizedFilePath: 'D:/api.txt' }); } catch { /* configured=false */ }
          }
          return keys;
        },
        encryption: { available: () => process.platform === 'win32' && electron.safeStorage.isEncryptionAvailable(), encrypt: text => electron.safeStorage.encryptString(text).toString('base64'), decrypt: ciphertext => electron.safeStorage.decryptString(Buffer.from(ciphertext, 'base64')) },
        chatV1: performCloudChatV1, chatV2: performCloudChatV2,
        providerFetch: (url, init) => fetch(url, init), nativeFactory: startOpenCodeSupervisor,
        liveBudget: { maxRequests: 8, maxOutputTokens: 16384, requestTimeoutMs: 600_000, deadlineMs: 4_800_000, waitMs: 1_800_000 },
        loadReviewed: createReviewedSourceLoader(PRODUCT_ROOT),
        createOaRuntime: scope => createOaReadRuntime({...scope,loadReviewed:createReviewedSourceLoader(PRODUCT_ROOT)}),
        loadSynthetic: async () => {
          const [fixture, manifest] = await Promise.all([
            import('../../../../../packages/schematic-workbench/fixtures/cloud-demo.json?raw'),
            import('../../../../../packages/schematic-workbench/fixtures/cloud-demo.manifest.json?raw'),
          ]);
          return { fixtureRawFrame: new TextEncoder().encode(fixture.default), manifestRawFrame: new TextEncoder().encode(manifest.default) };
        },
        chooseExportFile: async (name, context) => {
          const window = chooseWindow(context); if (!window) return undefined;
          const chosen = await electron.dialog.showSaveDialog(window, { title: '导出聊天为 Markdown（请选择新文件名）', defaultPath: name, buttonLabel: '导出', filters: [{ name: 'Markdown', extensions: ['md'] }] });
          return chosen.canceled ? undefined : chosen.filePath;
        },
        chooseEditFile: async (name, context) => {
          const window = chooseWindow(context); if (!window) return undefined;
          const chosen = await electron.dialog.showOpenDialog(window, { title: '用已接受的修改稿覆盖所选原文件：' + name, buttonLabel: '保存到此文件', properties: ['openFile'], filters: [{ name: '原文件', extensions: [path.extname(name).slice(1)] }] });
          return chosen.canceled ? undefined : chosen.filePaths[0];
        },
        chooseFolder: async context => {
          const window = chooseWindow(context); if (!window) return undefined;
          const chosen = await electron.dialog.showOpenDialog(window, { title: '新建项目：浏览文件夹', buttonLabel: '选择文件夹', properties: ['openDirectory'] });
          return chosen.canceled ? undefined : chosen.filePaths[0];
        },
        validateImages: images => {
          for (const image of images) {
            const decoded = electron.nativeImage.createFromBuffer(Buffer.from(image.data, 'base64')), size = decoded.getSize();
            if (decoded.isEmpty() || size.width !== image.width || size.height !== image.height) throw Error('Invalid image');
          }
        },
      },
    };
  } else { return fail(); }
  const bootstrapOptions = createCloudDesktopOptions(prepared);
  const { app } = await import('electron');
  const { startDesktopAppV1 } = await import('../bootstrap.js');
  app.setName('Analog AI Workbench');
  app.setPath('userData', prepared.profileRoot);
  startDesktopAppV1(bootstrapOptions);
}
