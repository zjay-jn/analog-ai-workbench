import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  FsSafetyError,
  type FileIdentityV1,
  type SyntheticWorkspaceBoundary,
} from "./fs-safety-contract";

const reservedWindowsName =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const controlCharacter = /[\u0000-\u001f\u007f]/u;

export function fileIdentityFromStats(stats: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}): FileIdentityV1 {
  return {
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    mode: stats.mode.toString(10),
    links: stats.nlink.toString(10),
    size: stats.size.toString(10),
    modifiedNanoseconds: stats.mtimeNs.toString(10),
  };
}

export function sameFileIdentity(
  left: FileIdentityV1,
  right: FileIdentityV1,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode
  );
}

export function sameFileSnapshot(
  left: FileIdentityV1,
  right: FileIdentityV1,
): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.links === right.links &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds
  );
}

function within(base: string, candidate: string): boolean {
  const relative = path.win32.relative(base, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..\\") &&
      relative !== ".." &&
      !path.win32.isAbsolute(relative))
  );
}

function assertPathSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.length > 255 ||
    controlCharacter.test(segment) ||
    segment.includes(":") ||
    /[. ]$/u.test(segment) ||
    reservedWindowsName.test(segment)
  ) {
    throw new FsSafetyError("INVALID_PATH");
  }
}

export function validateRelativeWindowsPath(relativePath: string): readonly string[] {
  if (
    relativePath.length === 0 ||
    relativePath.length > 1024 ||
    path.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/u.test(relativePath) ||
    /^[\\/]/u.test(relativePath) ||
    /^file:/iu.test(relativePath) ||
    relativePath.includes("/")
  ) {
    throw new FsSafetyError("INVALID_PATH");
  }

  const segments = relativePath.split("\\");
  for (const segment of segments) assertPathSegment(segment);
  return segments;
}

async function assertExistingComponentIsPlain(
  componentPath: string,
  expectedKind: "directory" | "file-or-directory",
): Promise<FileIdentityV1> {
  const stats = await lstat(componentPath, { bigint: true }).catch(() => {
    throw new FsSafetyError("INVALID_PATH");
  });
  if (stats.isSymbolicLink()) {
    throw new FsSafetyError("REPARSE_POINT");
  }
  if (expectedKind === "directory" && !stats.isDirectory()) {
    throw new FsSafetyError("NOT_REGULAR_FILE");
  }
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new FsSafetyError("NOT_REGULAR_FILE");
  }
  return fileIdentityFromStats(stats);
}

export async function createSyntheticWorkspaceBoundary(input: {
  readonly projectRoot: string;
  readonly rootPath: string;
}): Promise<SyntheticWorkspaceBoundary> {
  if (process.platform !== "win32") {
    throw new FsSafetyError("CAPABILITY_UNPROVEN");
  }
  const projectRoot = path.win32.resolve(input.projectRoot);
  const testWorkspaceBase = path.win32.resolve(
    projectRoot,
    ".local",
    "test-workspaces",
  );
  const rootPath = path.win32.resolve(input.rootPath);
  if (
    rootPath.toLocaleLowerCase("en-US") ===
      testWorkspaceBase.toLocaleLowerCase("en-US") ||
    !within(testWorkspaceBase, rootPath)
  ) {
    throw new FsSafetyError("PATH_ESCAPE");
  }

  await assertExistingComponentIsPlain(testWorkspaceBase, "directory");
  const rootIdentity = await assertExistingComponentIsPlain(
    rootPath,
    "directory",
  );
  const canonicalRootPath = await realpath(rootPath);
  if (!within(testWorkspaceBase, canonicalRootPath)) {
    throw new FsSafetyError("PATH_ESCAPE");
  }

  return {
    scope: "p2-fs-safety-synthetic-only",
    projectRoot,
    testWorkspaceBase,
    rootPath,
    canonicalRootPath,
    rootIdentity,
  };
}

export async function resolveSyntheticCandidate(
  boundary: SyntheticWorkspaceBoundary,
  relativePath: string,
  options: { readonly requireFinalEntry: boolean },
): Promise<string> {
  const segments = validateRelativeWindowsPath(relativePath);
  const candidate = path.win32.join(boundary.rootPath, ...segments);
  if (!within(boundary.rootPath, candidate)) {
    throw new FsSafetyError("PATH_ESCAPE");
  }

  const rootIdentity = await assertExistingComponentIsPlain(
    boundary.rootPath,
    "directory",
  );
  if (!sameFileIdentity(rootIdentity, boundary.rootIdentity)) {
    throw new FsSafetyError("DOCUMENT_CONFLICT");
  }

  let current = boundary.rootPath;
  for (const [index, segment] of segments.entries()) {
    current = path.win32.join(current, segment);
    const isFinal = index === segments.length - 1;
    if (isFinal && !options.requireFinalEntry) break;
    await assertExistingComponentIsPlain(
      current,
      isFinal ? "file-or-directory" : "directory",
    );
  }

  return candidate;
}
