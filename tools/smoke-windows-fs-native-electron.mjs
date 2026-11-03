import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const addonPath = path.join(
  projectRoot,
  ".local",
  "native-build",
  "windows-fs-native",
  "aaw_windows_fs_native.node",
);

if (!process.versions.electron) {
  const electronExecutable = path.join(
    projectRoot,
    "node_modules",
    "electron",
    "dist",
    "electron.exe",
  );
  const result = spawnSync(electronExecutable, [scriptPath], {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else {
  const require = createRequire(import.meta.url);
  const addon = require(addonPath);
  const capabilities = addon.getCapabilities();
  assert.equal(process.versions.electron, "43.4.0");
  assert.equal(process.arch, "x64");
  assert.equal(capabilities.contractVersion, "aaw.windows-fs-native/v1alpha1");
  assert.equal(capabilities.napiVersion, 8);
  assert.equal(capabilities.capabilities.atomicReplace, true);
  assert.equal(capabilities.capabilities.daclVerification, true);
  const syntheticBase = path.join(projectRoot, ".local", "test-workspaces");
  const syntheticContainer = path.join(
    syntheticBase,
    `p2-native-electron-${process.pid}`,
  );
  const workspace = path.join(syntheticContainer, "workspace");
  if (!syntheticContainer.startsWith(`${syntheticBase}${path.sep}`)) {
    throw new Error("Synthetic Electron native workspace escaped its base.");
  }
  mkdirSync(workspace, { recursive: true });
  const target = path.join(workspace, "notes.txt");
  try {
    writeFileSync(target, "before");
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      const before = addon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      const after = addon.replaceVerifiedText({
        root,
        operationId: "00000000000000000000000000000001",
        relativeSegments: ["notes.txt"],
        expectedSnapshot: before.snapshot,
        bytes: Buffer.from("after"),
      });
      assert.equal(readFileSync(target, "utf8"), "after");
      assert.equal(after.fileSize, "5");
    } finally {
      addon.closeRoot({ root });
    }
  } finally {
    rmSync(syntheticContainer, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      status: "PASS",
      electron: process.versions.electron,
      node: process.versions.node,
      napi: process.versions.napi,
      addonContract: capabilities.contractVersion,
      atomicReplace: true,
      daclVerification: true,
    }),
  );
}
