import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  link,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const projectRoot = process.cwd();
const addonPath = path.join(
  projectRoot,
  ".local",
  "native-build",
  "windows-fs-native",
  "aaw_windows_fs_native.node",
);
const addon = require(addonPath);
const testAddon = require(
  path.join(
    projectRoot,
    ".local",
    "native-build",
    "windows-fs-native",
    "aaw_windows_fs_native_test.node",
  ),
);
let counter = 0;
let operationCounter = 0;

function nextOperationId() {
  operationCounter += 1;
  return operationCounter.toString(16).padStart(32, "0");
}

async function withWorkspace(run) {
  counter += 1;
  const base = path.resolve(projectRoot, ".local", "test-workspaces");
  const container = path.join(base, `p2-native-${process.pid}-${counter}`);
  const workspace = path.join(container, "workspace");
  const outside = path.join(container, "outside");
  if (!container.startsWith(`${base}${path.sep}`)) {
    throw new Error("Synthetic native cleanup target escaped its base.");
  }
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    await run({ workspace, outside });
  } finally {
    await rm(container, { recursive: true, force: true });
  }
}

function hasCode(code) {
  return (error) => error instanceof Error && error.code === code;
}

async function assertNoNativeArtifacts(directory) {
  const names = await readdir(directory);
  assert.deepEqual(
    names.filter((name) => name.includes(".aaw-")),
    [],
    "native save must not leave temp, backup or recovery files",
  );
}

test("production surface is closed and advertises only proven replace", () => {
  assert.deepEqual(Object.getOwnPropertyNames(addon).sort(), [
    "closeRoot",
    "getCapabilities",
    "inspectRelative",
    "openValidatedRoot",
    "readVerifiedText",
    "reconcileVerifiedText",
    "replaceVerifiedText",
  ]);
  assert.deepEqual(addon.getCapabilities(), {
    contractVersion: "aaw.windows-fs-native/v1alpha1",
    napiVersion: 8,
    platform: "win32-x64",
    capabilities: {
      fixedDrive: true,
      fileId: true,
      reparseTag: true,
      openReparsePoint: true,
      verifiedRead: true,
      daclVerification: true,
      atomicReplace: true,
    },
  });
  assert.equal(
    Object.getOwnPropertyNames(addon).includes("replaceVerifiedTextTest"),
    false,
  );
  assert.equal(
    Object.getOwnPropertyNames(testAddon).includes("replaceVerifiedTextTest"),
    true,
  );
  assert.equal(
    Object.getOwnPropertyNames(testAddon).includes("classifyDriveTypeTest"),
    true,
  );
  assert.equal(
    Object.getOwnPropertyNames(testAddon).includes("rejectReparseMetadataTest"),
    true,
  );
});

test("drive classification accepts only DRIVE_FIXED", () => {
  const expected = new Map([
    [0, false],
    [1, false],
    [2, false],
    [3, true],
    [4, false],
    [5, false],
    [6, false],
    [0xffff, false],
  ]);
  for (const [driveType, allowed] of expected) {
    assert.equal(testAddon.classifyDriveTypeTest({ driveType }), allowed);
  }
});

test("all mount, symlink, cloud and third-party reparse metadata fails closed", () => {
  const fileAttributeReparsePoint = 0x400;
  const tags = [
    0xa0000003,
    0xa000000c,
    0x9000001a,
    0x9000101a,
    0x00000042,
  ];
  assert.doesNotThrow(() =>
    testAddon.rejectReparseMetadataTest({
      fileAttributes: 0,
      reparseTag: 0,
    }),
  );
  for (const reparseTag of tags) {
    assert.throws(
      () =>
        testAddon.rejectReparseMetadataTest({
          fileAttributes: fileAttributeReparsePoint,
          reparseTag,
        }),
      hasCode("REPARSE_POINT"),
    );
    assert.throws(
      () =>
        testAddon.rejectReparseMetadataTest({
          fileAttributes: 0,
          reparseTag,
        }),
      hasCode("REPARSE_POINT"),
    );
  }
});

test("root and request schemas fail closed", async () => {
  await withWorkspace(async ({ workspace }) => {
    assert.throws(
      () => addon.openValidatedRoot({ absolutePath: workspace, extra: true }),
      hasCode("INVALID_ARGUMENT"),
    );
    assert.throws(
      () => addon.openValidatedRoot({ absolutePath: path.parse(workspace).root }),
      hasCode("NOT_FIXED_DRIVE"),
    );
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    assert.throws(
      () =>
        addon.inspectRelative({
          root,
          relativeSegments: ["..", "escape.txt"],
          expectedKind: "file",
        }),
      hasCode("INVALID_PATH"),
    );
    assert.throws(
      () =>
        addon.readVerifiedText({
          root,
          relativeSegments: ["missing.txt"],
          maxBytes: 2 * 1024 * 1024,
          path: "C:\\forbidden.txt",
        }),
      hasCode("INVALID_ARGUMENT"),
    );
    addon.closeRoot({ root });
    assert.throws(
      () =>
        addon.inspectRelative({
          root,
          relativeSegments: ["missing.txt"],
          expectedKind: "file",
        }),
      hasCode("CAPABILITY_UNAVAILABLE"),
    );
    addon.closeRoot({ root });
  });
});

test("verified read returns bytes and stable Windows identity", async () => {
  await withWorkspace(async ({ workspace }) => {
    const content = Buffer.from("synthetic 中文\r\n", "utf8");
    await mkdir(path.join(workspace, "folder"));
    await writeFile(path.join(workspace, "folder", "notes.txt"), content);
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      const directory = addon.inspectRelative({
        root,
        relativeSegments: ["folder"],
        expectedKind: "directory",
      });
      assert.equal(directory.isDirectory, true);
      assert.equal(directory.reparseTag, 0);

      const result = addon.readVerifiedText({
        root,
        relativeSegments: ["folder", "notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      assert.deepEqual(result.bytes, content);
      assert.equal(result.snapshot.isDirectory, false);
      assert.equal(result.snapshot.numberOfLinks, "1");
      assert.equal(result.snapshot.fileSize, String(content.length));
      assert.match(result.snapshot.volumeSerialNumber, /^[0-9]+$/u);
      assert.match(result.snapshot.fileId, /^[0-9a-f]{32}$/u);
      assert.equal(
        await readFile(path.join(workspace, "folder", "notes.txt"), "utf8"),
        "synthetic 中文\r\n",
      );
    } finally {
      addon.closeRoot({ root });
    }
  });
});

test("atomic replace preserves the original creation time and named stream", async () => {
  await withWorkspace(async ({ workspace }) => {
    const target = path.join(workspace, "notes.txt");
    const original = Buffer.from("original synthetic bytes\r\n", "utf8");
    const replacement = Buffer.from(
      "\ufeffreplacement 中文 bytes\r\nsecond line\r\n",
      "utf8",
    );
    await writeFile(target, original);
    await writeFile(`${target}:aaw-metadata`, "synthetic stream");
    const beforeStat = await stat(target, { bigint: true });
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      const before = addon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      const after = addon.replaceVerifiedText({
        root,
        operationId: nextOperationId(),
        relativeSegments: ["notes.txt"],
        expectedSnapshot: before.snapshot,
        bytes: replacement,
      });
      assert.deepEqual(await readFile(target), replacement);
      assert.equal(await readFile(`${target}:aaw-metadata`, "utf8"), "synthetic stream");
      assert.equal((await stat(target, { bigint: true })).birthtimeNs, beforeStat.birthtimeNs);
      assert.equal(after.fileAttributes, before.snapshot.fileAttributes);
      assert.notEqual(after.fileId, before.snapshot.fileId);
      assert.equal(after.fileSize, String(replacement.length));
      await assertNoNativeArtifacts(workspace);
    } finally {
      addon.closeRoot({ root });
    }
  });
});

test("stale expected snapshot fails closed without overwriting external bytes", async () => {
  await withWorkspace(async ({ workspace }) => {
    const target = path.join(workspace, "notes.txt");
    await writeFile(target, "original");
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      const before = addon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      await writeFile(target, "external change");
      assert.throws(
        () =>
          addon.replaceVerifiedText({
            root,
            operationId: nextOperationId(),
            relativeSegments: ["notes.txt"],
            expectedSnapshot: before.snapshot,
            bytes: Buffer.from("must not win"),
          }),
        hasCode("DOCUMENT_CONFLICT"),
      );
      assert.equal(await readFile(target, "utf8"), "external change");
      await assertNoNativeArtifacts(workspace);
    } finally {
      addon.closeRoot({ root });
    }
  });
});

test("production replace schema rejects test hooks and malformed payloads", async () => {
  await withWorkspace(async ({ workspace }) => {
    const target = path.join(workspace, "notes.txt");
    await writeFile(target, "original");
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      const before = addon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      const base = {
        root,
        operationId: nextOperationId(),
        relativeSegments: ["notes.txt"],
        expectedSnapshot: before.snapshot,
        bytes: Buffer.from("replacement"),
      };
      assert.throws(
        () => addon.replaceVerifiedText({ ...base, faultPoint: "after-write" }),
        hasCode("INVALID_ARGUMENT"),
      );
      assert.throws(
        () => addon.replaceVerifiedText({ ...base, bytes: "replacement" }),
        hasCode("INVALID_ARGUMENT"),
      );
      assert.throws(
        () =>
          addon.replaceVerifiedText({
            ...base,
            expectedSnapshot: {
              ...before.snapshot,
              contentSha256: `A${before.snapshot.contentSha256.slice(1)}`,
            },
          }),
        hasCode("INVALID_ARGUMENT"),
      );
      assert.throws(
        () =>
          addon.replaceVerifiedText({
            ...base,
            bytes: Buffer.alloc(2 * 1024 * 1024 + 1),
          }),
        hasCode("DOCUMENT_TOO_LARGE"),
      );
      assert.equal(await readFile(target, "utf8"), "original");
      await assertNoNativeArtifacts(workspace);
    } finally {
      addon.closeRoot({ root });
    }
  });
});

test("read-only and sharing-lock failures preserve the original", async () => {
  await withWorkspace(async ({ workspace }) => {
    const target = path.join(workspace, "notes.txt");
    await writeFile(target, "original");
    const root = testAddon.openValidatedRoot({ absolutePath: workspace });
    try {
      let before = testAddon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      await chmod(target, 0o444);
      before = testAddon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      assert.throws(
        () =>
          testAddon.replaceVerifiedText({
            root,
            operationId: nextOperationId(),
            relativeSegments: ["notes.txt"],
            expectedSnapshot: before.snapshot,
            bytes: Buffer.from("replacement"),
          }),
        hasCode("DOCUMENT_READ_ONLY"),
      );
      await chmod(target, 0o666);
      before = testAddon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      assert.throws(
        () =>
          testAddon.replaceVerifiedTextTest({
            root,
            operationId: nextOperationId(),
            relativeSegments: ["notes.txt"],
            expectedSnapshot: before.snapshot,
            bytes: Buffer.from("replacement"),
            faultPoint: "lock-target-before-replace",
          }),
        hasCode("SAVE_FAILED"),
      );
      assert.equal(await readFile(target, "utf8"), "original");
      await assertNoNativeArtifacts(workspace);
    } finally {
      await chmod(target, 0o666).catch(() => undefined);
      testAddon.closeRoot({ root });
    }
  });
});

test("every pre-replace fault preserves original bytes and removes artifacts", async () => {
  for (const faultPoint of [
    "after-temp-create",
    "after-write",
    "after-flush",
    "before-replace",
  ]) {
    await withWorkspace(async ({ workspace }) => {
      const target = path.join(workspace, "notes.txt");
      const original = Buffer.from(`original ${faultPoint}`);
      await writeFile(target, original);
      const root = testAddon.openValidatedRoot({ absolutePath: workspace });
      try {
        const before = testAddon.readVerifiedText({
          root,
          relativeSegments: ["notes.txt"],
          maxBytes: 2 * 1024 * 1024,
        });
        assert.throws(
          () =>
            testAddon.replaceVerifiedTextTest({
              root,
              operationId: nextOperationId(),
              relativeSegments: ["notes.txt"],
              expectedSnapshot: before.snapshot,
              bytes: Buffer.from("replacement"),
              faultPoint,
            }),
          hasCode("TEST_FAULT"),
        );
        assert.deepEqual(await readFile(target), original);
        await assertNoNativeArtifacts(workspace);
      } finally {
        testAddon.closeRoot({ root });
      }
    });
  }
});

test("post-replace verification faults roll back the exact original", async () => {
  for (const faultPoint of ["after-replace", "corrupt-readback"]) {
    await withWorkspace(async ({ workspace }) => {
      const target = path.join(workspace, "notes.txt");
      const original = Buffer.from(`original ${faultPoint}`);
      await writeFile(target, original);
      const root = testAddon.openValidatedRoot({ absolutePath: workspace });
      try {
        const before = testAddon.readVerifiedText({
          root,
          relativeSegments: ["notes.txt"],
          maxBytes: 2 * 1024 * 1024,
        });
        assert.throws(
          () =>
            testAddon.replaceVerifiedTextTest({
              root,
              operationId: nextOperationId(),
              relativeSegments: ["notes.txt"],
              expectedSnapshot: before.snapshot,
              bytes: Buffer.from("replacement"),
              faultPoint,
            }),
          hasCode("SAVE_ROLLED_BACK"),
        );
        assert.deepEqual(await readFile(target), original);
        await assertNoNativeArtifacts(workspace);
      } finally {
        testAddon.closeRoot({ root });
      }
    });
  }
});

test("a change after the final preflight is restored as the winning version", async () => {
  await withWorkspace(async ({ workspace }) => {
    const target = path.join(workspace, "notes.txt");
    await writeFile(target, "original");
    const root = testAddon.openValidatedRoot({ absolutePath: workspace });
    try {
      const before = testAddon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      assert.throws(
        () =>
          testAddon.replaceVerifiedTextTest({
            root,
            operationId: nextOperationId(),
            relativeSegments: ["notes.txt"],
            expectedSnapshot: before.snapshot,
            bytes: Buffer.from("must lose"),
            faultPoint: "target-change-after-conflict",
          }),
        hasCode("DOCUMENT_CONFLICT"),
      );
      assert.equal(await readFile(target, "utf8"), "external concurrent");
      await assertNoNativeArtifacts(workspace);
    } finally {
      testAddon.closeRoot({ root });
    }
  });
});

test("ReplaceFile 1175, 1176 and 1177 branches have deterministic recovery", async () => {
  const cases = [
    ["replace-error-1175", "REPLACE_UNABLE_TO_REMOVE_REPLACED"],
    ["replace-error-1176", "REPLACE_UNABLE_TO_MOVE_REPLACEMENT"],
    ["replace-error-1177", "REPLACE_PARTIAL_MOVE_RECOVERED"],
  ];
  for (const [faultPoint, expectedCode] of cases) {
    await withWorkspace(async ({ workspace }) => {
      const target = path.join(workspace, "notes.txt");
      const original = Buffer.from(`original ${faultPoint}`);
      await writeFile(target, original);
      const root = testAddon.openValidatedRoot({ absolutePath: workspace });
      try {
        const before = testAddon.readVerifiedText({
          root,
          relativeSegments: ["notes.txt"],
          maxBytes: 2 * 1024 * 1024,
        });
        assert.throws(
          () =>
            testAddon.replaceVerifiedTextTest({
              root,
              operationId: nextOperationId(),
              relativeSegments: ["notes.txt"],
              expectedSnapshot: before.snapshot,
              bytes: Buffer.from("replacement"),
              faultPoint,
            }),
          hasCode(expectedCode),
        );
        assert.deepEqual(await readFile(target), original);
        await assertNoNativeArtifacts(workspace);
      } finally {
        testAddon.closeRoot({ root });
      }
    });
  }
});

test("permission and disk-full-style save failures preserve the original", async () => {
  const cases = [
    ["temp-create-access-denied", "SAVE_PERMISSION_DENIED"],
    ["write-disk-full", "SAVE_DISK_FULL"],
    ["flush-disk-full", "SAVE_DISK_FULL"],
  ];
  for (const [faultPoint, expectedCode] of cases) {
    await withWorkspace(async ({ workspace }) => {
      const target = path.join(workspace, "notes.txt");
      const original = Buffer.from(`original ${faultPoint}\r\n`, "utf8");
      await writeFile(target, original);
      const root = testAddon.openValidatedRoot({ absolutePath: workspace });
      try {
        const before = testAddon.readVerifiedText({
          root,
          relativeSegments: ["notes.txt"],
          maxBytes: 2 * 1024 * 1024,
        });
        assert.throws(
          () =>
            testAddon.replaceVerifiedTextTest({
              root,
              operationId: nextOperationId(),
              relativeSegments: ["notes.txt"],
              expectedSnapshot: before.snapshot,
              bytes: Buffer.from("must not commit"),
              faultPoint,
            }),
          hasCode(expectedCode),
        );
        assert.deepEqual(await readFile(target), original);
        await assertNoNativeArtifacts(workspace);
      } finally {
        testAddon.closeRoot({ root });
      }
    });
  }
});

test("backup cleanup failure rolls back and leaves no save artifacts", async () => {
  await withWorkspace(async ({ workspace }) => {
    const target = path.join(workspace, "notes.txt");
    const original = Buffer.from("original cleanup failure\n", "utf8");
    await writeFile(target, original);
    const root = testAddon.openValidatedRoot({ absolutePath: workspace });
    try {
      const before = testAddon.readVerifiedText({
        root,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      assert.throws(
        () =>
          testAddon.replaceVerifiedTextTest({
            root,
            operationId: nextOperationId(),
            relativeSegments: ["notes.txt"],
            expectedSnapshot: before.snapshot,
            bytes: Buffer.from("replacement"),
            faultPoint: "backup-cleanup-failure",
          }),
        hasCode("SAVE_ROLLED_BACK"),
      );
      assert.deepEqual(await readFile(target), original);
      await assertNoNativeArtifacts(workspace);
    } finally {
      testAddon.closeRoot({ root });
    }
  });
});

test("unrecoverable rollback state fails closed without deleting evidence", async () => {
  await withWorkspace(async ({ workspace }) => {
    const target = path.join(workspace, "notes.txt");
    const original = Buffer.from("original recovery evidence\n", "utf8");
    const replacement = Buffer.from("ambiguous replacement\n", "utf8");
    await writeFile(target, original);
    const operationId = nextOperationId();
    let before;
    const testRoot = testAddon.openValidatedRoot({ absolutePath: workspace });
    try {
      before = testAddon.readVerifiedText({
        root: testRoot,
        relativeSegments: ["notes.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      assert.throws(
        () =>
          testAddon.replaceVerifiedTextTest({
            root: testRoot,
            operationId,
            relativeSegments: ["notes.txt"],
            expectedSnapshot: before.snapshot,
            bytes: replacement,
            faultPoint: "rollback-restore-failure",
          }),
        hasCode("SAVE_RECOVERY_REQUIRED"),
      );
    } finally {
      testAddon.closeRoot({ root: testRoot });
    }

    const backupName = `.aaw-backup-${operationId}`;
    const rollbackName = `.aaw-rollback-${operationId}`;
    assert.deepEqual(await readFile(target), replacement);
    assert.deepEqual(await readFile(path.join(workspace, backupName)), original);
    assert.equal((await stat(path.join(workspace, rollbackName))).isFile(), true);

    const productionRoot = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      assert.throws(
        () =>
          addon.reconcileVerifiedText({
            root: productionRoot,
            operationId,
            relativeSegments: ["notes.txt"],
            expectedSnapshot: before.snapshot,
            replacementContentSha256: createHash("sha256")
              .update(replacement)
              .digest("hex"),
          }),
        hasCode("SAVE_RECOVERY_REQUIRED"),
      );
    } finally {
      addon.closeRoot({ root: productionRoot });
    }
    assert.deepEqual(await readFile(target), replacement);
    assert.deepEqual(await readFile(path.join(workspace, backupName)), original);
  });
});

test("native path policy rejects ADS, devices, trailing syntax and bounds", async () => {
  await withWorkspace(async ({ workspace }) => {
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      const invalid = [
        ["notes.txt:stream"],
        ["CON.txt"],
        ["LPT9.log"],
        ["trailing."],
        ["trailing "],
        [".."],
        ["a/b"],
        ["a\\b"],
        ["\ud800"],
        ["a".repeat(256)],
        Array.from({ length: 25 }, () => "a"),
        Array.from({ length: 5 }, (_, index) => `${index}${"a".repeat(218)}`),
      ];
      for (const relativeSegments of invalid) {
        assert.throws(
          () =>
            addon.inspectRelative({
              root,
              relativeSegments,
              expectedKind: "file",
            }),
          hasCode("INVALID_PATH"),
        );
      }
    } finally {
      addon.closeRoot({ root });
    }
  });
});

test("native boundary reads Unicode, case variation and long paths", async () => {
  await withWorkspace(async ({ workspace }) => {
    const directories = Array.from(
      { length: 4 },
      (_, index) => `层${index}-${"a".repeat(75)}`,
    );
    const actualName = "MiXeD-中文-😀.TXT";
    const expected = Buffer.from("\ufeff第一行\r\nsecond line\r\n", "utf8");
    const parent = path.join(workspace, ...directories);
    await mkdir(parent, { recursive: true });
    await writeFile(path.join(parent, actualName), expected);
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      const result = addon.readVerifiedText({
        root,
        relativeSegments: [...directories, "mixed-中文-😀.txt"],
        maxBytes: 2 * 1024 * 1024,
      });
      assert.deepEqual(result.bytes, expected);
    } finally {
      addon.closeRoot({ root });
    }
  });
});

test("file symlink is rejected when host privilege permits creation", async (t) => {
  await withWorkspace(async ({ workspace, outside }) => {
    const outsideFile = path.join(outside, "outside.txt");
    const linkedFile = path.join(workspace, "linked.txt");
    await writeFile(outsideFile, "synthetic outside");
    try {
      await symlink(outsideFile, linkedFile, "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        t.skip("host cannot create an unprivileged Windows file symlink");
        return;
      }
      throw error;
    }
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      assert.throws(
        () =>
          addon.readVerifiedText({
            root,
            relativeSegments: ["linked.txt"],
            maxBytes: 2 * 1024 * 1024,
          }),
        hasCode("REPARSE_POINT"),
      );
    } finally {
      addon.closeRoot({ root });
    }
  });
});

test("junction and hard link are rejected by handle metadata", async () => {
  await withWorkspace(async ({ workspace, outside }) => {
    await writeFile(path.join(outside, "secret.txt"), "synthetic only");
    await symlink(outside, path.join(workspace, "linked"), "junction");
    const first = path.join(workspace, "first.txt");
    const second = path.join(workspace, "second.txt");
    await writeFile(first, "synthetic");
    await link(first, second);
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      assert.throws(
        () =>
          addon.readVerifiedText({
            root,
            relativeSegments: ["linked", "secret.txt"],
            maxBytes: 2 * 1024 * 1024,
          }),
        hasCode("REPARSE_POINT"),
      );
      assert.throws(
        () =>
          addon.readVerifiedText({
            root,
            relativeSegments: ["first.txt"],
            maxBytes: 2 * 1024 * 1024,
          }),
        hasCode("HARD_LINK"),
      );
    } finally {
      addon.closeRoot({ root });
    }
  });
});

test("size and numeric bounds are enforced before delivery", async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeFile(path.join(workspace, "large.txt"), Buffer.alloc(1025, 0x61));
    const root = addon.openValidatedRoot({ absolutePath: workspace });
    try {
      assert.throws(
        () =>
          addon.readVerifiedText({
            root,
            relativeSegments: ["large.txt"],
            maxBytes: 1024,
          }),
        hasCode("DOCUMENT_TOO_LARGE"),
      );
      const invalidValues = [
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        2 * 1024 * 1024 + 1,
      ];
      for (const invalid of invalidValues) {
        assert.throws(
          () =>
            addon.readVerifiedText({
              root,
              relativeSegments: ["large.txt"],
              maxBytes: invalid,
            }),
          hasCode("INVALID_ARGUMENT"),
        );
      }
    } finally {
      addon.closeRoot({ root });
    }
  });
});
