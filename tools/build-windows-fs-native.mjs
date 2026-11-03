import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(projectRoot, "packages", "windows-fs-native");
const transientBuild = path.join(nativeRoot, "build");
const outputRoot = path.join(projectRoot, ".local", "native-build", "windows-fs-native");
const nodeRoot = path.join(projectRoot, ".local", "toolchains", "node-v24.20.0-win-x64");
const nodeExecutable = path.join(nodeRoot, "node.exe");
const nodeGypEntry = path.join(
  nodeRoot,
  "node_modules",
  "npm",
  "node_modules",
  "node-gyp",
  "bin",
  "node-gyp.js",
);
const headersRoot = path.join(
  projectRoot,
  ".local",
  "toolchains",
  "node-v24.20.0-headers",
  "extracted",
  "node-v24.20.0",
);
const pythonExecutable = process.env.AAW_NATIVE_PYTHON;

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertInsideProject(target, expectedParent) {
  const resolved = path.resolve(target);
  const parent = path.resolve(expectedParent);
  if (resolved === parent || !resolved.startsWith(`${parent}${path.sep}`)) {
    throw new Error(`Refusing unsafe native build path: ${resolved}`);
  }
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The approved native helper build is Windows x64 only.");
}
if (!pythonExecutable || !path.isAbsolute(pythonExecutable)) {
  throw new Error("AAW_NATIVE_PYTHON must name the approved absolute Python path.");
}
if (process.version !== "v24.20.0" || process.versions.napi !== "10") {
  throw new Error(`Unexpected build runtime: ${process.version}, N-API ${process.versions.napi}`);
}
if (sha256(nodeExecutable) !== "5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5") {
  throw new Error("Approved Node executable hash mismatch.");
}
if (sha256(path.join(headersRoot, "win-x64", "node.lib")) !== "63ec831bbf164d1b23197d6fac1944dfb146534e332889ca0755d250e8dedff9") {
  throw new Error("Approved node.lib hash mismatch.");
}
if (sha256(path.join(headersRoot, "include", "node", "node_api.h")) !== "2d4560831e525b47b060ec8a0864ab73993df9e20215ce9f0fe7b24cd31af32a") {
  throw new Error("Approved Node-API header hash mismatch.");
}

assertInsideProject(transientBuild, nativeRoot);
assertInsideProject(outputRoot, path.join(projectRoot, ".local"));
const releaseImportLibraryDirectory = path.join(headersRoot, "Release");
mkdirSync(releaseImportLibraryDirectory, { recursive: true });
copyFileSync(
  path.join(headersRoot, "win-x64", "node.lib"),
  path.join(releaseImportLibraryDirectory, "node.lib"),
);
rmSync(transientBuild, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const build = spawnSync(
  nodeExecutable,
  [
    nodeGypEntry,
    "rebuild",
    "--release",
    `--directory=${nativeRoot}`,
    `--nodedir=${headersRoot}`,
    `--python=${pythonExecutable}`,
    "--msvs_version=2022",
  ],
  {
    cwd: projectRoot,
    env: { ...process.env, GYP_MSVS_VERSION: "2022" },
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  },
);
if (build.error) throw build.error;
if (build.status !== 0) {
  throw new Error(`node-gyp failed with exit code ${build.status}`);
}

const builtBinary = path.join(transientBuild, "Release", "aaw_windows_fs_native.node");
const outputBinary = path.join(outputRoot, "aaw_windows_fs_native.node");
copyFileSync(builtBinary, outputBinary);
const builtTestBinary = path.join(
  transientBuild,
  "Release",
  "aaw_windows_fs_native_test.node",
);
const outputTestBinary = path.join(
  outputRoot,
  "aaw_windows_fs_native_test.node",
);
copyFileSync(builtTestBinary, outputTestBinary);

const sourceFile = path.join(nativeRoot, "src", "addon.cc");
const bindingFile = path.join(nativeRoot, "binding.gyp");
const manifest = {
  schemaVersion: "aaw.native-build/v1",
  contractVersion: "aaw.windows-fs-native/v1alpha1",
  builtAt: new Date().toISOString(),
  runtime: { node: process.version, napi: process.versions.napi, arch: process.arch },
  sources: [
    { path: "packages/windows-fs-native/binding.gyp", sha256: sha256(bindingFile) },
    { path: "packages/windows-fs-native/src/addon.cc", sha256: sha256(sourceFile) },
  ],
  output: {
    path: ".local/native-build/windows-fs-native/aaw_windows_fs_native.node",
    sha256: sha256(outputBinary),
  },
  testOutput: {
    path: ".local/native-build/windows-fs-native/aaw_windows_fs_native_test.node",
    sha256: sha256(outputTestBinary),
    productionReachable: false,
  },
};
writeFileSync(
  path.join(outputRoot, "build-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

rmSync(transientBuild, { recursive: true, force: true });
console.log(JSON.stringify(manifest, null, 2));
