import assert from "node:assert/strict";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(packageRoot, "..", "..");
const syntheticRoot = path.join(projectRoot, ".local", "test-workspaces");
const operationPattern = /^[0-9a-f]{32}$/u;
const shaPattern = /^[0-9a-f]{64}$/u;

function assertSyntheticDirectory(directory) {
  const resolved = path.resolve(directory);
  assert.ok(
    resolved.startsWith(`${syntheticRoot}${path.sep}`),
    "save journal is synthetic-workspace-only",
  );
  return resolved;
}

function assertExactKeys(value, expected) {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertSnapshot(snapshot) {
  assertExactKeys(snapshot, [
    "contentSha256",
    "fileAttributes",
    "fileId",
    "fileSize",
    "isDirectory",
    "lastWriteTime",
    "numberOfLinks",
    "reparseTag",
    "volumeSerialNumber",
  ]);
  assert.match(snapshot.contentSha256, shaPattern);
  assert.match(snapshot.fileId, /^[0-9a-f]{32}$/u);
  for (const key of ["fileSize", "lastWriteTime", "numberOfLinks", "volumeSerialNumber"]) {
    assert.match(snapshot[key], /^(?:0|[1-9][0-9]*)$/u);
  }
  assert.equal(Number.isSafeInteger(snapshot.fileAttributes), true);
  assert.equal(Number.isSafeInteger(snapshot.reparseTag), true);
  assert.equal(typeof snapshot.isDirectory, "boolean");
}

function validateRecord(record) {
  assertExactKeys(record, [
    "contractVersion",
    "expectedSnapshot",
    "operationId",
    "relativeSegments",
    "replacementContentSha256",
    "schemaVersion",
    "state",
  ]);
  assert.equal(record.schemaVersion, "aaw.native-save-journal/v1");
  assert.equal(record.contractVersion, "aaw.windows-fs-native/v1alpha1");
  assert.equal(record.state, "prepared");
  assert.match(record.operationId, operationPattern);
  assert.match(record.replacementContentSha256, shaPattern);
  assert.equal(Array.isArray(record.relativeSegments), true);
  assert.ok(record.relativeSegments.length > 0 && record.relativeSegments.length <= 24);
  for (const segment of record.relativeSegments) {
    assert.equal(typeof segment, "string");
    assert.ok(Buffer.byteLength(segment, "utf8") > 0);
    assert.ok(Buffer.byteLength(segment, "utf8") <= 255);
    assert.match(segment, /^(?!\.{1,2}$)(?!.*[\\/:\u0000-\u001f\u007f])[^. ].*[^. ]$|^[^. \\/:\u0000-\u001f\u007f]$/u);
  }
  assertSnapshot(record.expectedSnapshot);
  return record;
}

function journalPaths(journalDirectory, operationId) {
  assert.match(operationId, operationPattern);
  const directory = assertSyntheticDirectory(journalDirectory);
  return {
    finalPath: path.join(directory, `${operationId}.json`),
    tempPath: path.join(directory, `.${operationId}.tmp`),
  };
}

export async function prepareSaveJournal({
  journalDirectory,
  operationId,
  relativeSegments,
  expectedSnapshot,
  replacementContentSha256,
}) {
  const record = validateRecord({
    schemaVersion: "aaw.native-save-journal/v1",
    contractVersion: "aaw.windows-fs-native/v1alpha1",
    state: "prepared",
    operationId,
    relativeSegments,
    expectedSnapshot,
    replacementContentSha256,
  });
  const { finalPath, tempPath } = journalPaths(journalDirectory, operationId);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, finalPath);
  const committed = await open(finalPath, "r+");
  try {
    await committed.sync();
  } finally {
    await committed.close();
  }
  return record;
}

export async function readSaveJournal({ journalDirectory, operationId }) {
  const { finalPath } = journalPaths(journalDirectory, operationId);
  const bytes = await readFile(finalPath);
  assert.ok(bytes.length > 0 && bytes.length <= 4096);
  const text = bytes.toString("utf8");
  assert.equal(Buffer.from(text, "utf8").equals(bytes), true);
  const parsed = JSON.parse(text);
  assert.equal(
    `${JSON.stringify(parsed)}\n`,
    text,
    "save journal must use the exact main-owned serialization",
  );
  return validateRecord(parsed);
}

export async function removeSaveJournal({ journalDirectory, operationId }) {
  const { finalPath } = journalPaths(journalDirectory, operationId);
  await unlink(finalPath);
}
