import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(
  projectRoot,
  "packages",
  "windows-fs-native",
  "src",
  "addon.cc",
);
const binaryPath = path.join(
  projectRoot,
  ".local",
  "native-build",
  "windows-fs-native",
  "aaw_windows_fs_native.node",
);
const dumpbinPath = path.join(
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools",
  "VC",
  "Tools",
  "MSVC",
  "14.44.35207",
  "bin",
  "Hostx64",
  "x64",
  "dumpbin.exe",
);

function dumpbin(option) {
  const result = spawnSync(dumpbinPath, [option, binaryPath], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`dumpbin ${option} failed with ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

const source = readFileSync(sourcePath, "utf8");
const forbiddenSourceApis = [
  "LoadLibrary",
  "GetProcAddress",
  "CreateProcess",
  "ShellExecute",
  "WinExec",
  "system(",
  "WinHttp",
  "WSAStartup",
];
for (const api of forbiddenSourceApis) {
  assert.equal(source.includes(api), false, `project source must not call ${api}`);
}

const headers = dumpbin("/headers");
const imports = dumpbin("/imports");
const exports = dumpbin("/exports");
const loadConfig = dumpbin("/loadconfig");

for (const required of [
  "8664 machine (x64)",
  "File Type: DLL",
  "High Entropy Virtual Addresses",
  "Dynamic base",
  "NX compatible",
  "Control Flow Guard",
  "CET compatible",
]) {
  assert.match(headers, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
}
assert.match(loadConfig, /CF instrumented/u);
assert.match(loadConfig, /FID table present/u);

const importedLibraries = [...imports.matchAll(/^\s{4}([A-Za-z0-9_.-]+(?:\.dll|\.exe))\s*$/gmu)]
  .map((match) => match[1].toLowerCase())
  .filter((name, index, all) => all.indexOf(name) === index)
  .sort();
assert.deepEqual(importedLibraries, [
  "advapi32.dll",
  "bcrypt.dll",
  "kernel32.dll",
  "node.exe",
]);
assert.equal(
  readFileSync(binaryPath).includes(Buffer.from("replaceVerifiedTextTest", "utf8")),
  false,
  "production binary must not contain the test-only fault entry point",
);
for (const testOnlyEntryPoint of [
  "classifyDriveTypeTest",
  "rejectReparseMetadataTest",
]) {
  assert.equal(
    readFileSync(binaryPath).includes(Buffer.from(testOnlyEntryPoint, "utf8")),
    false,
    `production binary must not contain ${testOnlyEntryPoint}`,
  );
}
for (const testOnlyMarker of [
  "TEST_FAULT",
  "after-temp-create",
  "after-write",
  "after-flush",
  "before-replace",
  "after-replace",
  "corrupt-readback",
  "target-change-after-conflict",
  "target-change-crash-after-replace",
  "lock-target-before-replace",
  "temp-create-access-denied",
  "write-disk-full",
  "flush-disk-full",
  "backup-cleanup-failure",
  "rollback-restore-failure",
  "replace-error-1175",
  "replace-error-1176",
  "replace-error-1177",
  "crash-before-replace",
  "crash-after-replace",
  "crash-after-cleanup",
]) {
  assert.equal(
    readFileSync(binaryPath).includes(Buffer.from(testOnlyMarker, "utf8")),
    false,
    `production binary must not contain ${testOnlyMarker}`,
  );
}

for (const forbiddenImport of [
  "CreateProcessA",
  "CreateProcessW",
  "ShellExecuteA",
  "ShellExecuteW",
  "WinExec",
  "URLDownloadToFileW",
  "WinHttpOpen",
  "WSAStartup",
]) {
  assert.doesNotMatch(imports, new RegExp(`\\b${forbiddenImport}\\b`, "u"));
}

// node-gyp's generated win_delay_load_hook resolves Node-API from the actual
// Node/Electron host. The project source is separately proven not to call
// LoadLibrary/GetProcAddress, so these generated imports are not a public FFI.
for (const delayHookImport of ["LoadLibraryExA", "GetProcAddress", "FreeLibrary"]) {
  assert.match(imports, new RegExp(`\\b${delayHookImport}\\b`, "u"));
}

assert.match(exports, /napi_register_module_v1/u);
console.log(
  JSON.stringify({
    status: "PASS",
    machine: "x64",
    importedLibraries,
    mitigations: ["HIGH_ENTROPY_VA", "DYNAMIC_BASE", "NX", "CFG", "CET"],
    exportedEntry: "napi_register_module_v1",
    projectSourceDynamicLoading: false,
    generatedNodeDelayLoadHook: true,
    testFaultEntryPointPresent: false,
  }),
);
