import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  prepareSaveJournal,
  readSaveJournal,
  removeSaveJournal,
} from "../packages/windows-fs-native/save-journal.mjs";

const require = createRequire(import.meta.url);
const projectRoot = process.cwd();
const syntheticRoot = path.resolve(projectRoot, ".local", "test-workspaces");
const workerPath = path.join(projectRoot, "tools", "native-save-crash-worker.mjs");
const reconcileWorkerPath = path.join(
  projectRoot,
  "tools",
  "native-save-reconcile-worker.mjs",
);
const addon = require(
  path.join(
    projectRoot,
    ".local",
    "native-build",
    "windows-fs-native",
    "aaw_windows_fs_native.node",
  ),
);
const replacement = Buffer.from("replacement after restart\n", "utf8");
let caseCounter = 0;

function nextOperationId() {
  caseCounter += 1;
  return createHash("sha256")
    .update(`recovery-${process.pid}-${caseCounter}`)
    .digest("hex")
    .slice(0, 32);
}

async function withRecoveryWorkspace(run) {
  caseCounter += 1;
  const container = path.join(
    syntheticRoot,
    `p2-native-recovery-${process.pid}-${caseCounter}`,
  );
  const workspace = path.join(container, "workspace");
  const journalDirectory = path.join(container, "journal");
  assert.ok(container.startsWith(`${syntheticRoot}${path.sep}`));
  await mkdir(workspace, { recursive: true });
  await mkdir(journalDirectory, { recursive: true });
  try {
    await run({ workspace, journalDirectory });
  } finally {
    await rm(container, { recursive: true, force: true });
  }
}

async function assertNoNativeArtifacts(directory) {
  const names = await readdir(directory);
  assert.deepEqual(names.filter((name) => name.includes(".aaw-")), []);
}

async function runCrashCase({
  workspace,
  journalDirectory,
  operationId,
  faultPoint,
  expectedExit,
}) {
  const child = spawnSync(process.execPath, [workerPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AAW_SYNTHETIC_WORKSPACE: workspace,
      AAW_SYNTHETIC_JOURNAL_DIRECTORY: journalDirectory,
      AAW_SYNTHETIC_OPERATION_ID: operationId,
      AAW_SYNTHETIC_FAULT_POINT: faultPoint,
    },
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  });
  if (child.error) throw child.error;
  assert.equal(child.signal, null);
  assert.equal(child.status, expectedExit, child.stderr || child.stdout);
}

function runReconcileCase({ workspace, journalDirectory, operationId }) {
  const child = spawnSync(process.execPath, [reconcileWorkerPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AAW_SYNTHETIC_WORKSPACE: workspace,
      AAW_SYNTHETIC_JOURNAL_DIRECTORY: journalDirectory,
      AAW_SYNTHETIC_OPERATION_ID: operationId,
    },
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  });
  if (child.error) throw child.error;
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

for (const scenario of [
  ["crash-before-native", 72, "not_committed", "original before restart\n"],
  ["crash-before-replace", 73, "not_committed", "original before restart\n"],
  ["crash-after-replace", 73, "rolled_back", "original before restart\n"],
  [
    "target-change-crash-after-replace",
    73,
    "conflict_rolled_back",
    "external concurrent",
  ],
  ["crash-after-cleanup", 73, "committed", replacement.toString("utf8")],
]) {
  const [faultPoint, expectedExit, expectedOutcome, expectedText] = scenario;
  test(`fresh process reconciles ${faultPoint}`, async () => {
    await withRecoveryWorkspace(async ({ workspace, journalDirectory }) => {
      const operationId = nextOperationId();
      await writeFile(
        path.join(workspace, "notes.txt"),
        "original before restart\n",
      );
      await runCrashCase({
        workspace,
        journalDirectory,
        operationId,
        faultPoint,
        expectedExit,
      });

      const result = runReconcileCase({
        workspace,
        journalDirectory,
        operationId,
      });
      assert.equal(result.outcome, expectedOutcome);

      assert.equal(await readFile(path.join(workspace, "notes.txt"), "utf8"), expectedText);
      assert.deepEqual(await readdir(journalDirectory), []);
      await assertNoNativeArtifacts(workspace);
    });
  });
}

test("normal acknowledged save removes its prepared journal", async () => {
  await withRecoveryWorkspace(async ({ workspace, journalDirectory }) => {
    const operationId = nextOperationId();
    const target = path.join(workspace, "notes.txt");
    await writeFile(target, "original\n");
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      const before = addon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      await prepareSaveJournal({
        journalDirectory,
        operationId,
        relativeSegments: ["notes.txt"],
        expectedSnapshot: before.snapshot,
        replacementContentSha256: createHash("sha256")
          .update(replacement)
          .digest("hex"),
      });
      addon.replaceVerifiedText({
        root,
        operationId,
        relativeSegments: ["notes.txt"],
        expectedSnapshot: before.snapshot,
        bytes: replacement,
      });
      await removeSaveJournal({ journalDirectory, operationId });
    } finally {
      addon.closeRoot({ root });
    }
    assert.deepEqual(await readFile(target), replacement);
    assert.deepEqual(await readdir(journalDirectory), []);
    await assertNoNativeArtifacts(workspace);
  });
});

test("journal corruption fails closed before native reconciliation", async () => {
  await withRecoveryWorkspace(async ({ workspace, journalDirectory }) => {
    const operationId = nextOperationId();
    await writeFile(path.join(workspace, "notes.txt"), "original\n");
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    let snapshot;
    try {
      snapshot = addon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      }).snapshot;
    } finally {
      addon.closeRoot({ root });
    }
    const record = {
      schemaVersion: "aaw.native-save-journal/v1",
      contractVersion: "aaw.windows-fs-native/v1alpha1",
      state: "prepared",
      operationId,
      relativeSegments: ["notes.txt"],
      expectedSnapshot: snapshot,
      replacementContentSha256: createHash("sha256")
        .update(replacement)
        .digest("hex"),
    };
    await writeFile(
      path.join(journalDirectory, `${operationId}.json`),
      ` ${JSON.stringify(record)}\n`,
      "utf8",
    );
    await assert.rejects(() => readSaveJournal({ journalDirectory, operationId }));
    assert.equal(await readFile(path.join(workspace, "notes.txt"), "utf8"), "original\n");
    await assertNoNativeArtifacts(workspace);
  });
});
