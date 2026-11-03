import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");

async function read(relativePath) {
  return readFile(resolve(projectRoot, relativePath), "utf8");
}

const preload = await read("apps/desktop/src/preload/index.ts");
const main = await read("apps/desktop/src/main/index.ts");
const mainBootstrap = await read("apps/desktop/src/main/bootstrap.ts");
const mainRegistry = await read(
  "apps/desktop/src/main/schematic/reviewed-artifact-registry.ts",
);
const mainResolveHandler = await read(
  "apps/desktop/src/main/ipc/resolve-reviewed-artifact-handler.ts",
);
const agentApi = await read("apps/desktop/src/shared/agent/desktop-agent-api.ts");
const agentIpc = await read("apps/desktop/src/main/ipc/agent/register-agent-ipc.ts");
const emptyAgentBackend = await read("apps/desktop/src/main/agent/empty-agent-backend.ts");
const productionMainText = [main, mainBootstrap, mainRegistry, mainResolveHandler].join(
  "\n",
);
const rendererEntry = await read("apps/desktop/src/renderer/main.tsx");
const rendererHtml = await read("apps/desktop/index.html");
const viteConfig = await read("apps/desktop/vite.config.mts");
const mainViteConfig = await read("apps/desktop/vite.main.shared.mts");
const packageManifest = JSON.parse(await read("package.json"));
const rendererDirectory = resolve(projectRoot, "apps/desktop/src/renderer");
const fsSafetyContract = await read(
  "apps/desktop/src/main/document/fs-safety-contract.ts",
);
const pathPolicy = await read("apps/desktop/src/main/document/path-policy.ts");
const syntheticSpike = await read(
  "apps/desktop/src/main/document/synthetic-text-spike.ts",
);
const nativeSaveJournal = await read(
  "packages/windows-fs-native/save-journal.mjs",
);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      if (/\.(?:ts|tsx)$/u.test(entry.name)) return [target];
      return [];
    }),
  );
  return nested.flat();
}

const rendererFiles = await sourceFiles(rendererDirectory);
const rendererSources = await Promise.all(
  rendererFiles.map((file) => readFile(file, "utf8")),
);
const rendererText = rendererSources.join("\n");

const checks = {
  preloadUsesContextBridge: preload.includes("contextBridge.exposeInMainWorld"),
  preloadDoesNotExposeRawIpc: !/exposeInMainWorld\([^,]+,\s*ipcRenderer/u.test(preload),
  publicApiHasExactSevenMethods:
    ["getInfo", "resolveReviewedArtifact", "startTurn", "subscribeRun", "cancelRun", "resolveArtifact", "resolveCitation"].every(
      (method) => preload.includes(`${method}: async`),
    ) &&
    !/\b(?:send|on|once|invoke|execute)\s*:/u.test(preload),
  sandboxPreloadHasNoLocalRuntimeImport:
    !/import\s+[^;]+from\s+["']\.\//u.test(preload),
  mainHasExactSevenIpcChannels:
    mainBootstrap.includes("GET_INFO_CHANNEL") &&
    mainBootstrap.includes("RESOLVE_REVIEWED_ARTIFACT_CHANNEL") &&
    (mainBootstrap.match(/ownedIpc\.handle\(/gu) ?? []).length === 2 &&
    /ownedIpc\.handle\(\s*GET_INFO_CHANNEL\s*,/u.test(mainBootstrap) &&
    /ownedIpc\.handle\(\s*RESOLVE_REVIEWED_ARTIFACT_CHANNEL\s*,/u.test(mainBootstrap) &&
    !/ipcMain\.handle\(/u.test(mainBootstrap) &&
    mainBootstrap.includes('const ownedIpc = new Proxy(ipcMain,') &&
    mainBootstrap.includes('cleanup.assertOpen();') &&
    mainBootstrap.includes('ownedChannels.add(args[0]);') &&
    mainBootstrap.includes('return target.handle(...args);') &&
    [
      "workbench.agent.startTurn.v1",
      "workbench.agent.subscribeRun.v1",
      "workbench.agent.cancelRun.v1",
      "workbench.agent.resolveArtifact.v1",
      "workbench.agent.resolveCitation.v1",
    ].every((channel) => agentApi.includes(channel)) &&
    !agentIpc.includes("ipcMain.on(") &&
    !productionMainText.includes("ipcMain.on(") &&
    !productionMainText.includes("shell.openExternal") &&
    !productionMainText.includes("child_process"),
  productionReviewedRegistryIsStaticallyEmpty:
    main.includes("createProductionReviewedArtifactRegistryV1") &&
    !main.includes("development-synthetic-reviewed-registry") &&
    !main.includes("synthetic-admission") &&
    !main.includes("strict-source-frame") &&
    !productionMainText.includes("node:fs"),
  productionAgentRegistryIsStaticallyEmpty:
    main.includes("createEmptyAgentBackendV1") &&
    emptyAgentBackend.includes("agent: 0") &&
    emptyAgentBackend.includes("rag: 0") &&
    emptyAgentBackend.includes("toolBroker: 0") &&
    !main.includes("development-synthetic-agent-backend") &&
    !mainBootstrap.includes("development-synthetic-agent-backend") &&
    !main.includes("process.env") &&
    !main.includes("process.argv") &&
    !mainBootstrap.includes("process.env") &&
    !mainBootstrap.includes("process.argv"),
  agentBoundaryHasNoGenericIpcOrPrivilegedBroker:
    !agentIpc.includes("child_process") &&
    !agentIpc.includes("node:fs") &&
    !agentIpc.includes("shell.openExternal") &&
    !/\b(?:send|on|once|invoke)\s*:/u.test(preload),
  productionRendererUrlUsesCompileTimeBuildGate:
    mainBootstrap.includes(
      "const isDevelopment = __AAW_MAIN_DEVELOPMENT__;",
    ) &&
    mainBootstrap.includes("const developmentUrl = isDevelopment") &&
    mainBootstrap.includes(
      "if (isDevelopment && developmentUrl !== undefined)",
    ) &&
    mainViteConfig.includes(
      '__AAW_MAIN_DEVELOPMENT__: JSON.stringify(profile === "development")',
    ),
  phase2AHasNoFileIpcOrPreloadApi:
    !productionMainText.includes("openTextDocument") &&
    !productionMainText.includes("saveTextDocument") &&
    !productionMainText.includes("dialog.showOpenDialog") &&
    !preload.includes("openTextDocument") &&
    !preload.includes("saveTextDocument") &&
    !preload.includes("attachTextWorkspace"),
  p2FsSpikeIsNotWiredToRuntime:
    !productionMainText.includes("./document/") &&
    !preload.includes("p2-fs-safety") &&
    !preload.includes("SyntheticWorkspace"),
  nativeFsHelperIsNotWiredToRuntime:
    !productionMainText.includes("windows-fs-native") &&
    !productionMainText.includes("aaw_windows_fs_native") &&
    !preload.includes("windows-fs-native") &&
    !preload.includes("aaw_windows_fs_native"),
  nativeSaveJournalIsSyntheticAndNotWiredToRuntime:
    nativeSaveJournal.includes('\"test-workspaces\"') &&
    !productionMainText.includes("save-journal") &&
    !preload.includes("save-journal") &&
    !rendererText.includes("save-journal") &&
    !productionMainText.includes("reconcileVerifiedText") &&
    !preload.includes("reconcileVerifiedText"),
  nativeFsBuildHasNoLifecycleHook:
    packageManifest.scripts["build:native:fs"] ===
      "node tools/build-windows-fs-native.mjs" &&
    packageManifest.scripts.preinstall === undefined &&
    packageManifest.scripts.install === undefined &&
    packageManifest.scripts.postinstall === undefined &&
    packageManifest.dependencies["node-gyp"] === undefined &&
    packageManifest.devDependencies["node-gyp"] === undefined,
  p2FsSpikeIsSyntheticScoped:
    fsSafetyContract.includes("p2-fs-safety-synthetic-only") &&
    pathPolicy.includes('"test-workspaces"') &&
    !syntheticSpike.includes("child_process") &&
    !syntheticSpike.includes("powershell") &&
    !syntheticSpike.includes("cmd.exe"),
  p2FsAssessmentFailsClosed:
    fsSafetyContract.includes("BLOCKED_NATIVE_HELPER_GATE_REQUIRED") &&
    fsSafetyContract.includes("NODE_NO_GENERIC_FILE_ATTRIBUTE_REPARSE_POINT") &&
    fsSafetyContract.includes("NODE_NO_REPLACEFILEW_WITH_BACKUP"),
  rendererHasNoPrivilegedImports:
    !/from\s+["'](?:electron|node:|fs|path|child_process)/u.test(rendererText) &&
    !/\brequire\s*\(/u.test(rendererText) &&
    !/\bipcRenderer\b/u.test(rendererText),
  rendererStylesUseExternalCspCompatibleLink:
    /<link\s+rel="stylesheet"\s+href="\/src\/renderer\/styles\.css"\s*\/>/u.test(
      rendererHtml,
    ) && !/import\s+["'].\/styles\.css["']/u.test(rendererEntry),
  codeMirrorUsesExplicitCspStyleNonce:
    rendererHtml.includes('name="aaw-style-nonce"') &&
    viteConfig.includes("style-src 'self' 'nonce-") &&
    rendererText.includes("EditorView.cspNonce.of"),
  cspDoesNotAllowUnsafeInlineScriptOrStyle:
    viteConfig.includes('"script-src \'self\'"') &&
    !viteConfig.includes("unsafe-inline"),
  phase3ProductionCspDeniesExternalResources:
    viteConfig.includes('"connect-src \'none\'"') &&
    viteConfig.includes('"img-src \'none\'"') &&
    viteConfig.includes('"font-src \'none\'"') &&
    viteConfig.includes('"media-src \'none\'"') &&
    viteConfig.includes('"worker-src \'none\'"') &&
    viteConfig.includes('"child-src \'none\'"') &&
    viteConfig.includes("http://127.0.0.1:5173") &&
    viteConfig.includes("ws://127.0.0.1:5173") &&
    !viteConfig.includes("img-src 'self' data:"),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => value !== true)) {
  process.exitCode = 1;
}
