export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type FsSafetyErrorCode =
  | "INVALID_PATH"
  | "PATH_ESCAPE"
  | "REPARSE_POINT"
  | "HARD_LINK"
  | "NOT_REGULAR_FILE"
  | "DOCUMENT_TOO_LARGE"
  | "UNSUPPORTED_ENCODING"
  | "DOCUMENT_CONFLICT"
  | "SAVE_FAILED"
  | "CAPABILITY_UNPROVEN";

const safeMessages: Readonly<Record<FsSafetyErrorCode, string>> = {
  INVALID_PATH: "The requested path is invalid.",
  PATH_ESCAPE: "The requested path is unavailable.",
  REPARSE_POINT: "The requested path is unavailable.",
  HARD_LINK: "The requested file is unavailable.",
  NOT_REGULAR_FILE: "The requested file is unavailable.",
  DOCUMENT_TOO_LARGE: "The document is too large.",
  UNSUPPORTED_ENCODING: "The document encoding is unsupported.",
  DOCUMENT_CONFLICT: "The document changed outside the workbench.",
  SAVE_FAILED: "The document could not be saved.",
  CAPABILITY_UNPROVEN: "The filesystem capability is unavailable.",
};

export class FsSafetyError extends Error {
  readonly code: FsSafetyErrorCode;

  constructor(code: FsSafetyErrorCode) {
    super(safeMessages[code]);
    this.name = "FsSafetyError";
    this.code = code;
  }
}

export type FileIdentityV1 = {
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly links: string;
  readonly size: string;
  readonly modifiedNanoseconds: string;
};

export type TextRevisionV1 = {
  readonly revisionId: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly identity: FileIdentityV1;
  readonly bom: "none" | "utf8";
  readonly eol: "lf" | "crlf" | "mixed" | "none";
};

export type SyntheticWorkspaceBoundary = {
  readonly scope: "p2-fs-safety-synthetic-only";
  readonly projectRoot: string;
  readonly testWorkspaceBase: string;
  readonly rootPath: string;
  readonly canonicalRootPath: string;
  readonly rootIdentity: FileIdentityV1;
};

export type PureNodeCapabilityStatus = "PROVEN" | "UNPROVEN";

export type PureNodeCapabilityAssessment = {
  readonly contractVersion: "aaw.p2-fs-safety/v1alpha1";
  readonly platform: NodeJS.Platform;
  readonly capabilities: {
    readonly symbolicLinkAndJunctionLstat: PureNodeCapabilityStatus;
    readonly fileHandleIdentityComparison: PureNodeCapabilityStatus;
    readonly hardLinkCount: PureNodeCapabilityStatus;
    readonly exclusiveTemporaryFile: PureNodeCapabilityStatus;
    readonly fileHandleFlush: PureNodeCapabilityStatus;
    readonly genericReparseAttributeAndTag: PureNodeCapabilityStatus;
    readonly noFollowHandleOpenOnWindows: PureNodeCapabilityStatus;
    readonly fixedLocalDriveProof: PureNodeCapabilityStatus;
    readonly replaceFileWWithBackup: PureNodeCapabilityStatus;
  };
  readonly verdict: "BLOCKED_NATIVE_HELPER_GATE_REQUIRED";
  readonly blockers: readonly string[];
};

export function assessPureNodeWindowsCapabilities(input: {
  readonly platform: NodeJS.Platform;
  readonly oNoFollow: number | undefined;
}): PureNodeCapabilityAssessment {
  const onWindows = input.platform === "win32";
  return {
    contractVersion: "aaw.p2-fs-safety/v1alpha1",
    platform: input.platform,
    capabilities: {
      symbolicLinkAndJunctionLstat: "PROVEN",
      fileHandleIdentityComparison: "PROVEN",
      hardLinkCount: "PROVEN",
      exclusiveTemporaryFile: "PROVEN",
      fileHandleFlush: "PROVEN",
      genericReparseAttributeAndTag: "UNPROVEN",
      noFollowHandleOpenOnWindows:
        onWindows && input.oNoFollow !== undefined ? "PROVEN" : "UNPROVEN",
      fixedLocalDriveProof: "UNPROVEN",
      replaceFileWWithBackup: "UNPROVEN",
    },
    verdict: "BLOCKED_NATIVE_HELPER_GATE_REQUIRED",
    blockers: [
      "NODE_NO_GENERIC_FILE_ATTRIBUTE_REPARSE_POINT",
      "NODE_NO_REPARSE_TAG_OR_OPEN_REPARSE_POINT_HANDLE",
      "NODE_NO_FIXED_LOCAL_DRIVE_PROOF",
      "NODE_NO_REPLACEFILEW_WITH_BACKUP",
    ],
  };
}
