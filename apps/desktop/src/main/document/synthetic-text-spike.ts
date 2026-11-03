import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  FsSafetyError,
  MAX_TEXT_BYTES,
  type FileIdentityV1,
  type SyntheticWorkspaceBoundary,
  type TextRevisionV1,
} from "./fs-safety-contract";
import {
  fileIdentityFromStats,
  resolveSyntheticCandidate,
  sameFileIdentity,
  sameFileSnapshot,
} from "./path-policy";

export type SyntheticReadHook = {
  readonly afterPathValidation?: (candidatePath: string) => Promise<void>;
  readonly afterOpen?: (candidatePath: string) => Promise<void>;
};

export type ExperimentalSaveFaultPoint =
  | "after-validation"
  | "after-temp-create"
  | "after-write"
  | "after-sync"
  | "before-replace";

export type ExperimentalSaveHook = {
  readonly faultAt?: ExperimentalSaveFaultPoint;
  readonly beforeReplace?: (candidatePath: string) => Promise<void>;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function revisionId(
  identity: FileIdentityV1,
  contentSha256: string,
  byteLength: number,
): string {
  const digest = createHash("sha256")
    .update(
      [
        identity.device,
        identity.inode,
        identity.mode,
        identity.links,
        identity.size,
        identity.modifiedNanoseconds,
        contentSha256,
        byteLength.toString(10),
      ].join(":"),
    )
    .digest("hex");
  return `sha256:${digest}`;
}

function eolKind(text: string): TextRevisionV1["eol"] {
  const withoutCrLf = text.replaceAll("\r\n", "");
  const hasCrLf = text.includes("\r\n");
  const hasLf = withoutCrLf.includes("\n");
  if (hasCrLf && hasLf) return "mixed";
  if (hasCrLf) return "crlf";
  if (hasLf) return "lf";
  return "none";
}

async function assertRegularSingleLink(
  filePath: string,
): Promise<FileIdentityV1> {
  const stats = await lstat(filePath, { bigint: true }).catch(() => {
    throw new FsSafetyError("DOCUMENT_CONFLICT");
  });
  if (stats.isSymbolicLink()) throw new FsSafetyError("REPARSE_POINT");
  if (!stats.isFile()) throw new FsSafetyError("NOT_REGULAR_FILE");
  if (stats.nlink !== 1n) throw new FsSafetyError("HARD_LINK");
  return fileIdentityFromStats(stats);
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const result = await handle.read(buffer, 0, buffer.length, null);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
    if (total > MAX_TEXT_BYTES) {
      throw new FsSafetyError("DOCUMENT_TOO_LARGE");
    }
    chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
  }
  return Buffer.concat(chunks, total);
}

function decodeUtf8(bytes: Buffer): {
  readonly text: string;
  readonly bom: "none" | "utf8";
} {
  const hasBom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  const payload = hasBom ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new FsSafetyError("UNSUPPORTED_ENCODING");
  }
  if (text.includes("\u0000")) {
    throw new FsSafetyError("UNSUPPORTED_ENCODING");
  }
  return { text, bom: hasBom ? "utf8" : "none" };
}

export async function readSyntheticText(
  boundary: SyntheticWorkspaceBoundary,
  relativePath: string,
  hook: SyntheticReadHook = {},
): Promise<{ readonly text: string; readonly revision: TextRevisionV1 }> {
  const candidatePath = await resolveSyntheticCandidate(boundary, relativePath, {
    requireFinalEntry: true,
  });
  const beforeIdentity = await assertRegularSingleLink(candidatePath);
  await hook.afterPathValidation?.(candidatePath);

  const handle = await open(candidatePath, "r").catch(() => {
    throw new FsSafetyError("DOCUMENT_CONFLICT");
  });
  try {
    const handleIdentity = fileIdentityFromStats(
      await handle.stat({ bigint: true }),
    );
    const afterOpenIdentity = await assertRegularSingleLink(candidatePath);
    if (
      !sameFileSnapshot(beforeIdentity, handleIdentity) ||
      !sameFileSnapshot(handleIdentity, afterOpenIdentity)
    ) {
      throw new FsSafetyError("DOCUMENT_CONFLICT");
    }
    await hook.afterOpen?.(candidatePath);
    const bytes = await readBounded(handle);
    const afterReadIdentity = await assertRegularSingleLink(candidatePath);
    if (!sameFileSnapshot(handleIdentity, afterReadIdentity)) {
      throw new FsSafetyError("DOCUMENT_CONFLICT");
    }

    const decoded = decodeUtf8(bytes);
    const contentSha256 = sha256(bytes);
    const revision: TextRevisionV1 = {
      revisionId: revisionId(handleIdentity, contentSha256, bytes.length),
      contentSha256: `sha256:${contentSha256}`,
      byteLength: bytes.length,
      identity: handleIdentity,
      bom: decoded.bom,
      eol: eolKind(decoded.text),
    };
    return { text: decoded.text, revision };
  } finally {
    await handle.close();
  }
}

function encodeText(
  content: string,
  bom: "none" | "utf8",
): Buffer {
  if (content.includes("\u0000")) {
    throw new FsSafetyError("UNSUPPORTED_ENCODING");
  }
  const body = Buffer.from(content, "utf8");
  const bytes =
    bom === "utf8"
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
      : body;
  if (bytes.length > MAX_TEXT_BYTES) {
    throw new FsSafetyError("DOCUMENT_TOO_LARGE");
  }
  return bytes;
}

function injectFault(
  hook: ExperimentalSaveHook,
  point: ExperimentalSaveFaultPoint,
): void {
  if (hook.faultAt === point) throw new FsSafetyError("SAVE_FAILED");
}

export async function experimentalSaveSyntheticText(input: {
  readonly boundary: SyntheticWorkspaceBoundary;
  readonly relativePath: string;
  readonly baseRevisionId: string;
  readonly content: string;
  readonly bom: "none" | "utf8";
  readonly hook?: ExperimentalSaveHook;
}): Promise<TextRevisionV1> {
  const hook = input.hook ?? {};
  const current = await readSyntheticText(input.boundary, input.relativePath);
  if (current.revision.revisionId !== input.baseRevisionId) {
    throw new FsSafetyError("DOCUMENT_CONFLICT");
  }
  injectFault(hook, "after-validation");

  const candidatePath = await resolveSyntheticCandidate(
    input.boundary,
    input.relativePath,
    { requireFinalEntry: true },
  );
  const parentPath = path.win32.dirname(candidatePath);
  const canonicalParent = await realpath(parentPath);
  if (
    path.win32.relative(input.boundary.canonicalRootPath, canonicalParent)
      .startsWith("..")
  ) {
    throw new FsSafetyError("PATH_ESCAPE");
  }
  const parentIdentity = fileIdentityFromStats(
    await lstat(parentPath, { bigint: true }),
  );
  const bytes = encodeText(input.content, input.bom);
  const tempName = `.aaw-${randomBytes(16).toString("hex")}.tmp`;
  const tempPath = path.win32.join(parentPath, tempName);
  let tempExists = false;
  let replaced = false;

  try {
    const tempHandle = await open(tempPath, "wx");
    tempExists = true;
    try {
      const tempHandleIdentity = fileIdentityFromStats(
        await tempHandle.stat({ bigint: true }),
      );
      const tempPathIdentity = await assertRegularSingleLink(tempPath);
      if (!sameFileIdentity(tempHandleIdentity, tempPathIdentity)) {
        throw new FsSafetyError("SAVE_FAILED");
      }
      injectFault(hook, "after-temp-create");
      await tempHandle.writeFile(bytes);
      injectFault(hook, "after-write");
      await tempHandle.sync();
      injectFault(hook, "after-sync");
    } finally {
      await tempHandle.close();
    }

    await hook.beforeReplace?.(candidatePath);
    injectFault(hook, "before-replace");
    const beforeReplace = await readSyntheticText(
      input.boundary,
      input.relativePath,
    );
    if (beforeReplace.revision.revisionId !== input.baseRevisionId) {
      throw new FsSafetyError("DOCUMENT_CONFLICT");
    }
    const currentParentIdentity = fileIdentityFromStats(
      await lstat(parentPath, { bigint: true }),
    );
    if (!sameFileIdentity(parentIdentity, currentParentIdentity)) {
      throw new FsSafetyError("DOCUMENT_CONFLICT");
    }

    // P2-B experiment only. Node rename is intentionally not accepted as the
    // production ReplaceFileW contract and this function is not wired to IPC.
    await rename(tempPath, candidatePath);
    tempExists = false;
    replaced = true;
    const saved = await readSyntheticText(input.boundary, input.relativePath);
    if (
      saved.revision.contentSha256 !== `sha256:${sha256(bytes)}` ||
      saved.revision.byteLength !== bytes.length
    ) {
      throw new FsSafetyError("SAVE_FAILED");
    }
    return saved.revision;
  } catch (error) {
    if (error instanceof FsSafetyError) throw error;
    throw new FsSafetyError(replaced ? "CAPABILITY_UNPROVEN" : "SAVE_FAILED");
  } finally {
    if (tempExists) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}
