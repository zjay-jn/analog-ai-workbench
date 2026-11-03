import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareSaveJournal } from "../packages/windows-fs-native/save-journal.mjs";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syntheticRoot = path.join(projectRoot, ".local", "test-workspaces");
const workspace = path.resolve(process.env.AAW_SYNTHETIC_WORKSPACE ?? "");
const journalDirectory = path.resolve(
  process.env.AAW_SYNTHETIC_JOURNAL_DIRECTORY ?? "",
);
const operationId = process.env.AAW_SYNTHETIC_OPERATION_ID ?? "";
const faultPoint = process.env.AAW_SYNTHETIC_FAULT_POINT ?? "";
const replacement = Buffer.from("replacement after restart\n", "utf8");

function assertSyntheticPath(candidate) {
  assert.ok(
    candidate.startsWith(`${syntheticRoot}${path.sep}`),
    "crash worker is synthetic-workspace-only",
  );
}

assertSyntheticPath(workspace);
assertSyntheticPath(journalDirectory);
assert.match(operationId, /^[0-9a-f]{32}$/u);
assert.ok(
  [
    "crash-before-native",
    "crash-before-replace",
    "crash-after-replace",
    "crash-after-cleanup",
    "target-change-crash-after-replace",
  ].includes(faultPoint),
);

const addon = require(
  path.join(
    projectRoot,
    ".local",
    "native-build",
    "windows-fs-native",
    "aaw_windows_fs_native_test.node",
  ),
);
const root = addon.openValidatedRoot({ absolutePath: workspace });
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
  replacementContentSha256: createHash("sha256").update(replacement).digest("hex"),
});

if (faultPoint === "crash-before-native") {
  process.exit(72);
}

addon.replaceVerifiedTextTest({
  root,
  operationId,
  relativeSegments: ["notes.txt"],
  expectedSnapshot: before.snapshot,
  bytes: replacement,
  faultPoint,
});
throw new Error("native crash fault unexpectedly returned");
