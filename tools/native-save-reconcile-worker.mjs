import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readSaveJournal,
  removeSaveJournal,
} from "../packages/windows-fs-native/save-journal.mjs";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syntheticRoot = path.join(projectRoot, ".local", "test-workspaces");
const workspace = path.resolve(process.env.AAW_SYNTHETIC_WORKSPACE ?? "");
const journalDirectory = path.resolve(
  process.env.AAW_SYNTHETIC_JOURNAL_DIRECTORY ?? "",
);
const operationId = process.env.AAW_SYNTHETIC_OPERATION_ID ?? "";

for (const candidate of [workspace, journalDirectory]) {
  assert.ok(
    candidate.startsWith(`${syntheticRoot}${path.sep}`),
    "reconcile worker is synthetic-workspace-only",
  );
}
assert.match(operationId, /^[0-9a-f]{32}$/u);

const addon = require(
  path.join(
    projectRoot,
    ".local",
    "native-build",
    "windows-fs-native",
    "aaw_windows_fs_native.node",
  ),
);
const record = await readSaveJournal({ journalDirectory, operationId });
const root = addon.openValidatedRoot({ absolutePath: workspace });
let result;
try {
  result = addon.reconcileVerifiedText({
    root,
    operationId: record.operationId,
    relativeSegments: record.relativeSegments,
    expectedSnapshot: record.expectedSnapshot,
    replacementContentSha256: record.replacementContentSha256,
  });
} finally {
  addon.closeRoot({ root });
}
await removeSaveJournal({ journalDirectory, operationId });
process.stdout.write(`${JSON.stringify({ outcome: result.outcome })}\n`);
