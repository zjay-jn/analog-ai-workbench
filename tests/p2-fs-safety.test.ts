import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assessPureNodeWindowsCapabilities,
  FsSafetyError,
  MAX_TEXT_BYTES,
} from "../apps/desktop/src/main/document/fs-safety-contract";
import {
  createSyntheticWorkspaceBoundary,
  validateRelativeWindowsPath,
} from "../apps/desktop/src/main/document/path-policy";
import {
  experimentalSaveSyntheticText,
  readSyntheticText,
  type ExperimentalSaveFaultPoint,
} from "../apps/desktop/src/main/document/synthetic-text-spike";

let workspaceCounter = 0;

async function withSyntheticWorkspace(
  run: (context: {
    readonly container: string;
    readonly workspace: string;
    readonly outside: string;
    readonly boundary: Awaited<ReturnType<typeof createSyntheticWorkspaceBoundary>>;
  }) => Promise<void>,
): Promise<void> {
  workspaceCounter += 1;
  const projectRoot = process.cwd();
  const base = path.resolve(projectRoot, ".local", "test-workspaces");
  const container = path.resolve(
    base,
    `p2-fs-safety-${process.pid}-${workspaceCounter}`,
  );
  const workspace = path.join(container, "workspace");
  const outside = path.join(container, "outside");
  if (!container.startsWith(base + path.sep)) {
    throw new Error("Synthetic cleanup target escaped the test workspace base.");
  }

  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  const boundary = await createSyntheticWorkspaceBoundary({
    projectRoot,
    rootPath: workspace,
  });
  try {
    await run({ container, workspace, outside, boundary });
  } finally {
    await rm(container, { recursive: true, force: true });
  }
}

function assertFsSafetyCode(
  expected: FsSafetyError["code"],
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof FsSafetyError && error.code === expected;
}

test("pure Node capability assessment blocks production file IPC", () => {
  const oNoFollow = (
    constants as typeof constants & { readonly O_NOFOLLOW?: number }
  ).O_NOFOLLOW;
  const assessment = assessPureNodeWindowsCapabilities({
    platform: process.platform,
    oNoFollow,
  });

  assert.equal(process.platform, "win32");
  assert.equal(assessment.verdict, "BLOCKED_NATIVE_HELPER_GATE_REQUIRED");
  assert.equal(
    assessment.capabilities.genericReparseAttributeAndTag,
    "UNPROVEN",
  );
  assert.equal(
    assessment.capabilities.noFollowHandleOpenOnWindows,
    "UNPROVEN",
  );
  assert.equal(assessment.capabilities.fixedLocalDriveProof, "UNPROVEN");
  assert.equal(assessment.capabilities.replaceFileWWithBackup, "UNPROVEN");
});

test("Windows relative path policy rejects escape and namespace vectors", () => {
  const rejected = [
    "",
    "C:\\outside.txt",
    "C:outside.txt",
    "\\rooted.txt",
    "\\\\server\\share\\file.txt",
    "\\\\?\\C:\\file.txt",
    "file:///C:/file.txt",
    "..\\escape.txt",
    "folder\\..\\escape.txt",
    "folder/child.txt",
    "file.txt:secret",
    "CON.txt",
    "folder\\NUL",
    "trailing.\\file.txt",
    "trailing \\file.txt",
    "control\u0001.txt",
  ];
  for (const candidate of rejected) {
    assert.throws(
      () => validateRelativeWindowsPath(candidate),
      assertFsSafetyCode("INVALID_PATH"),
      candidate,
    );
  }
});

test("Windows relative path policy accepts bounded Unicode and long paths", () => {
  const unicode = validateRelativeWindowsPath(
    "设计 workspace\\notes 😀.txt",
  );
  const long = validateRelativeWindowsPath(
    [...Array.from({ length: 20 }, (_, index) => `level-${index}`), "file.txt"].join(
      "\\",
    ),
  );
  assert.deepEqual(unicode, ["设计 workspace", "notes 😀.txt"]);
  assert.equal(long.length, 21);
});

test("synthetic boundary refuses every root outside project test-workspaces", async () => {
  await mkdir(path.resolve(".local", "test-workspaces"), { recursive: true });
  await assert.rejects(
    createSyntheticWorkspaceBoundary({
      projectRoot: process.cwd(),
      rootPath: path.resolve("docs"),
    }),
    assertFsSafetyCode("PATH_ESCAPE"),
  );
  await assert.rejects(
    createSyntheticWorkspaceBoundary({
      projectRoot: process.cwd(),
      rootPath: path.resolve(".local", "test-workspaces"),
    }),
    assertFsSafetyCode("PATH_ESCAPE"),
  );
});

test("synthetic reader preserves UTF-8 BOM/EOL and rejects invalid content", async () => {
  await withSyntheticWorkspace(async ({ workspace, boundary }) => {
    const validPath = path.join(workspace, "中文 notes.txt");
    await writeFile(
      validPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("第一行\r\nsecond line\r\n", "utf8"),
      ]),
    );
    const valid = await readSyntheticText(boundary, "中文 notes.txt");
    assert.equal(valid.text, "第一行\r\nsecond line\r\n");
    assert.equal(valid.revision.bom, "utf8");
    assert.equal(valid.revision.eol, "crlf");
    assert.match(valid.revision.contentSha256, /^sha256:[0-9a-f]{64}$/u);

    await writeFile(path.join(workspace, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await assert.rejects(
      readSyntheticText(boundary, "invalid.txt"),
      assertFsSafetyCode("UNSUPPORTED_ENCODING"),
    );

    await writeFile(
      path.join(workspace, "embedded-null.txt"),
      Buffer.from("a\0b"),
    );
    await assert.rejects(
      readSyntheticText(boundary, "embedded-null.txt"),
      assertFsSafetyCode("UNSUPPORTED_ENCODING"),
    );

    await writeFile(
      path.join(workspace, "too-large.txt"),
      Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61),
    );
    await assert.rejects(
      readSyntheticText(boundary, "too-large.txt"),
      assertFsSafetyCode("DOCUMENT_TOO_LARGE"),
    );
  });
});

test("junction and hard-link targets fail closed", async () => {
  await withSyntheticWorkspace(async ({ workspace, outside, boundary }) => {
    await writeFile(path.join(outside, "secret.txt"), "synthetic secret");
    await symlink(outside, path.join(workspace, "linked"), "junction");
    await assert.rejects(
      readSyntheticText(boundary, "linked\\secret.txt"),
      assertFsSafetyCode("REPARSE_POINT"),
    );

    const first = path.join(workspace, "first.txt");
    const second = path.join(workspace, "second.txt");
    await writeFile(first, "synthetic");
    await link(first, second);
    await assert.rejects(
      readSyntheticText(boundary, "first.txt"),
      assertFsSafetyCode("HARD_LINK"),
    );
    await assert.rejects(
      readSyntheticText(boundary, "second.txt"),
      assertFsSafetyCode("HARD_LINK"),
    );
  });
});

test("reader detects replacement before open and after handle open", async () => {
  await withSyntheticWorkspace(async ({ workspace, boundary }) => {
    const target = path.join(workspace, "race.txt");
    await writeFile(target, "original");
    await assert.rejects(
      readSyntheticText(boundary, "race.txt", {
        afterPathValidation: async (candidatePath) => {
          await rename(candidatePath, path.join(workspace, "old-before-open.txt"));
          await writeFile(candidatePath, "replacement");
        },
      }),
      assertFsSafetyCode("DOCUMENT_CONFLICT"),
    );

    await writeFile(target, "original-again");
    await assert.rejects(
      readSyntheticText(boundary, "race.txt", {
        afterOpen: async (candidatePath) => {
          await rename(candidatePath, path.join(workspace, "old-after-open.txt"));
          await writeFile(candidatePath, "replacement-again");
        },
      }),
      assertFsSafetyCode("DOCUMENT_CONFLICT"),
    );
  });
});

test("experimental save succeeds only after flush, replace and readback", async () => {
  await withSyntheticWorkspace(async ({ workspace, boundary }) => {
    await writeFile(path.join(workspace, "save.txt"), "before\r\n");
    const opened = await readSyntheticText(boundary, "save.txt");
    const saved = await experimentalSaveSyntheticText({
      boundary,
      relativePath: "save.txt",
      baseRevisionId: opened.revision.revisionId,
      content: "after 中文\r\n",
      bom: "utf8",
    });
    const bytes = await readFile(path.join(workspace, "save.txt"));

    assert.notEqual(saved.revisionId, opened.revision.revisionId);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(
      new TextDecoder().decode(bytes.subarray(3)),
      "after 中文\r\n",
    );
    assert.equal(
      (await readdir(workspace)).some((name) => name.startsWith(".aaw-")),
      false,
    );
  });
});

test("stale revision and before-replace race preserve external bytes", async () => {
  await withSyntheticWorkspace(async ({ workspace, boundary }) => {
    const target = path.join(workspace, "conflict.txt");
    await writeFile(target, "baseline");
    const opened = await readSyntheticText(boundary, "conflict.txt");
    await writeFile(target, "external-before-call");
    await assert.rejects(
      experimentalSaveSyntheticText({
        boundary,
        relativePath: "conflict.txt",
        baseRevisionId: opened.revision.revisionId,
        content: "workbench",
        bom: "none",
      }),
      assertFsSafetyCode("DOCUMENT_CONFLICT"),
    );
    assert.equal(await readFile(target, "utf8"), "external-before-call");

    await writeFile(target, "baseline-two");
    const reopened = await readSyntheticText(boundary, "conflict.txt");
    await assert.rejects(
      experimentalSaveSyntheticText({
        boundary,
        relativePath: "conflict.txt",
        baseRevisionId: reopened.revision.revisionId,
        content: "workbench-two",
        bom: "none",
        hook: {
          beforeReplace: async () => {
            await writeFile(target, "external-before-replace");
          },
        },
      }),
      assertFsSafetyCode("DOCUMENT_CONFLICT"),
    );
    assert.equal(await readFile(target, "utf8"), "external-before-replace");
    assert.equal(
      (await readdir(workspace)).some((name) => name.startsWith(".aaw-")),
      false,
    );
  });
});

test("all pre-replace fault points preserve original bytes and clean temp files", async () => {
  const faultPoints: readonly ExperimentalSaveFaultPoint[] = [
    "after-validation",
    "after-temp-create",
    "after-write",
    "after-sync",
    "before-replace",
  ];

  for (const faultAt of faultPoints) {
    await withSyntheticWorkspace(async ({ workspace, boundary }) => {
      const target = path.join(workspace, "fault.txt");
      const original = `original-${faultAt}`;
      await writeFile(target, original);
      const opened = await readSyntheticText(boundary, "fault.txt");
      await assert.rejects(
        experimentalSaveSyntheticText({
          boundary,
          relativePath: "fault.txt",
          baseRevisionId: opened.revision.revisionId,
          content: "new content",
          bom: "none",
          hook: { faultAt },
        }),
        assertFsSafetyCode("SAVE_FAILED"),
      );
      assert.equal(await readFile(target, "utf8"), original);
      assert.equal(
        (await readdir(workspace)).some((name) => name.startsWith(".aaw-")),
        false,
      );
    });
  }
});

test("safe errors never expose synthetic absolute paths", async () => {
  await withSyntheticWorkspace(async ({ boundary }) => {
    await assert.rejects(
      readSyntheticText(boundary, "missing.txt"),
      (error: unknown) =>
        error instanceof FsSafetyError &&
        error.code === "INVALID_PATH" &&
        !error.message.includes(boundary.rootPath) &&
        !/[A-Za-z]:\\/u.test(error.message),
    );
  });
});
