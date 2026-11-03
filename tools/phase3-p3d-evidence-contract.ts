export const P3D_EVIDENCE_STATUSES_V1 = Object.freeze([
  "PASS",
  "FAIL",
  "BLOCKED",
  "NOT_RUN",
] as const);

export type P3dEvidenceStatusV1 =
  (typeof P3D_EVIDENCE_STATUSES_V1)[number];

export function selectLatestApplicableP3dAttemptV1<T>(
  attempts: readonly T[],
  requiredStatuses: (attempt: T) => readonly P3dEvidenceStatusV1[],
): T {
  if (attempts.length === 0) {
    throw new P3dEvidenceContractError(
      "INVALID_RESULT",
      "P3-D evidence has no attempt to select.",
    );
  }
  let latestApplicable: T | undefined;
  for (const attempt of attempts) {
    const statuses = requiredStatuses(attempt);
    if (
      statuses.length === 0 ||
      statuses.some((status) => !P3D_EVIDENCE_STATUSES_V1.includes(status))
    ) {
      throw new P3dEvidenceContractError(
        "INVALID_RESULT",
        "P3-D attempt selection received an invalid required status set.",
      );
    }
    if (statuses.some((status) => status !== "NOT_RUN")) {
      latestApplicable = attempt;
    }
  }
  const latestAttempt = attempts.at(-1);
  if (latestAttempt === undefined) {
    throw new P3dEvidenceContractError(
      "INVALID_RESULT",
      "P3-D evidence has no latest attempt.",
    );
  }
  return latestApplicable ?? latestAttempt;
}

export const P3D_EVIDENCE_RESULT_SCHEMA_V1 = Object.freeze({
  schemaVersion: "aaw.phase3-p3d.evidence-result/v1",
  requiredKeys: Object.freeze([
    "schemaVersion",
    "phase",
    "caseId",
    "required",
    "status",
    "environment",
    "oracles",
    "screenshot",
    "rawLog",
    "blocker",
  ]),
  environmentKeys: Object.freeze([
    "platform",
    "physicalWidth",
    "physicalHeight",
    "deviceScaleFactor",
    "pageZoom",
    "forcedColorsActive",
  ]),
  blockerKeys: Object.freeze(["reason", "owner", "exitCondition"]),
  forbiddenStatusTokens: Object.freeze(["SKIP", "N/A", "NOT_AVAILABLE"]),
  additionalProperties: false,
});

export type P3dEvidenceContractErrorCodeV1 =
  | "INVALID_RESULT"
  | "INVALID_STATUS"
  | "INVALID_ENVIRONMENT"
  | "INVALID_SCREENSHOT"
  | "INVALID_RAW_LOG"
  | "INVALID_ORACLES"
  | "SIDE_EFFECT_DETECTED"
  | "INCOMPLETE_PASS_EVIDENCE"
  | "NOT_RUN_REQUIRES_BLOCKER"
  | "REQUIRED_CASE_NOT_RUN_AT_EXIT"
  | "BLOCKER_REQUIRED";

export class P3dEvidenceContractError extends Error {
  readonly code: P3dEvidenceContractErrorCodeV1;

  constructor(
    code: P3dEvidenceContractErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "P3dEvidenceContractError";
    this.code = code;
  }
}

type ExactRecord = Readonly<Record<string, unknown>>;

const ORACLE_KEYS = Object.freeze([
  "typedResolvePath",
  "exactRevisionBinding",
  "persistentBannerVisible",
  "overlayBannerVisible",
  "geometryAllowed",
  "noHorizontalOverflow",
  "focusContract",
  "ariaContract",
  "artifactDigestUnchanged",
  "registryMutationCount",
  "productDocumentFileMutationCount",
  "nativeSaveHelperCallCount",
  "oaEdaMutationCount",
  "externalNetworkRequestCount",
  "processSpawnCount",
]);

function fail(code: P3dEvidenceContractErrorCodeV1, message: string): never {
  throw new P3dEvidenceContractError(code, message);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: P3dEvidenceContractErrorCodeV1,
): ExactRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(code, "P3-D evidence object is invalid.");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return fail(code, "P3-D evidence object is not closed.");
  }
  return value as ExactRecord;
}

function nonEmptyText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= 2_048 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function validRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.split("/").includes("..") &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function parseEnvironment(value: unknown): ExactRecord {
  const environment = exactRecord(
    value,
    P3D_EVIDENCE_RESULT_SCHEMA_V1.environmentKeys,
    "INVALID_ENVIRONMENT",
  );
  if (
    environment.platform !== "win32" ||
    !nonNegativeInteger(environment.physicalWidth) ||
    environment.physicalWidth === 0 ||
    !nonNegativeInteger(environment.physicalHeight) ||
    environment.physicalHeight === 0 ||
    !positiveFinite(environment.deviceScaleFactor) ||
    !positiveFinite(environment.pageZoom) ||
    typeof environment.forcedColorsActive !== "boolean"
  ) {
    return fail("INVALID_ENVIRONMENT", "P3-D evidence requires a real Windows environment.");
  }
  return environment;
}

function parseOracles(value: unknown): ExactRecord {
  const oracles = exactRecord(value, ORACLE_KEYS, "INVALID_ORACLES");
  for (const key of [
    "typedResolvePath",
    "exactRevisionBinding",
    "persistentBannerVisible",
    "overlayBannerVisible",
    "geometryAllowed",
    "noHorizontalOverflow",
    "focusContract",
    "ariaContract",
    "artifactDigestUnchanged",
  ]) {
    if (typeof oracles[key] !== "boolean") {
      return fail("INVALID_ORACLES", `P3-D oracle ${key} is invalid.`);
    }
  }
  for (const key of [
    "registryMutationCount",
    "productDocumentFileMutationCount",
    "nativeSaveHelperCallCount",
    "oaEdaMutationCount",
    "externalNetworkRequestCount",
    "processSpawnCount",
  ]) {
    if (!nonNegativeInteger(oracles[key])) {
      return fail("INVALID_ORACLES", `P3-D counter ${key} is invalid.`);
    }
  }
  return oracles;
}

function parseScreenshot(
  value: unknown,
  environment: ExactRecord,
): ExactRecord | null {
  if (value === null) return null;
  const screenshot = exactRecord(
    value,
    ["relativePath", "width", "height", "sha256"],
    "INVALID_SCREENSHOT",
  );
  if (
    !validRelativePath(screenshot.relativePath) ||
    !nonNegativeInteger(screenshot.width) ||
    !nonNegativeInteger(screenshot.height) ||
    screenshot.width !== environment.physicalWidth ||
    screenshot.height !== environment.physicalHeight ||
    !validSha256(screenshot.sha256)
  ) {
    return fail("INVALID_SCREENSHOT", "P3-D screenshot evidence is invalid.");
  }
  return screenshot;
}

function parseRawLog(value: unknown): ExactRecord | null {
  if (value === null) return null;
  const rawLog = exactRecord(
    value,
    ["relativePath", "sha256"],
    "INVALID_RAW_LOG",
  );
  if (!validRelativePath(rawLog.relativePath) || !validSha256(rawLog.sha256)) {
    return fail("INVALID_RAW_LOG", "P3-D raw log evidence is invalid.");
  }
  return rawLog;
}

function parseBlocker(value: unknown): ExactRecord | null {
  if (value === null) return null;
  const blocker = exactRecord(
    value,
    P3D_EVIDENCE_RESULT_SCHEMA_V1.blockerKeys,
    "BLOCKER_REQUIRED",
  );
  if (
    !nonEmptyText(blocker.reason) ||
    !nonEmptyText(blocker.owner) ||
    !nonEmptyText(blocker.exitCondition)
  ) {
    return fail("NOT_RUN_REQUIRES_BLOCKER", "P3-D blocker ownership is incomplete.");
  }
  return blocker;
}

export function validateP3dEvidenceResultV1<T>(value: T): T {
  const result = exactRecord(
    value,
    P3D_EVIDENCE_RESULT_SCHEMA_V1.requiredKeys,
    "INVALID_RESULT",
  );
  if (result.schemaVersion !== P3D_EVIDENCE_RESULT_SCHEMA_V1.schemaVersion) {
    return fail("INVALID_RESULT", "P3-D evidence schema version is invalid.");
  }
  if (result.phase !== "work" && result.phase !== "exit") {
    return fail("INVALID_RESULT", "P3-D evidence phase is invalid.");
  }
  if (!nonEmptyText(result.caseId) || typeof result.required !== "boolean") {
    return fail("INVALID_RESULT", "P3-D evidence identity is invalid.");
  }
  if (
    typeof result.status !== "string" ||
    !P3D_EVIDENCE_STATUSES_V1.includes(
      result.status as (typeof P3D_EVIDENCE_STATUSES_V1)[number],
    )
  ) {
    return fail("INVALID_STATUS", "P3-D evidence status is invalid.");
  }

  const environment = parseEnvironment(result.environment);
  const oracles = parseOracles(result.oracles);
  const screenshot = parseScreenshot(result.screenshot, environment);
  const rawLog = parseRawLog(result.rawLog);
  const blocker = parseBlocker(result.blocker);

  const sideEffectCounters = [
    oracles.registryMutationCount,
    oracles.productDocumentFileMutationCount,
    oracles.nativeSaveHelperCallCount,
    oracles.oaEdaMutationCount,
    oracles.externalNetworkRequestCount,
    oracles.processSpawnCount,
  ];
  if (sideEffectCounters.some((counter) => counter !== 0)) {
    return fail("SIDE_EFFECT_DETECTED", "P3-D evidence reports a forbidden side effect.");
  }

  if (result.status === "PASS") {
    const lifecycleWindowClose =
      result.caseId === "windows-lifecycle/window-close";
    if (
      (!lifecycleWindowClose && screenshot === null) ||
      rawLog === null ||
      blocker !== null ||
      oracles.typedResolvePath !== true ||
      oracles.exactRevisionBinding !== true ||
      (!lifecycleWindowClose &&
        (oracles.persistentBannerVisible !== true ||
          oracles.noHorizontalOverflow !== true ||
          oracles.focusContract !== true ||
          oracles.ariaContract !== true)) ||
      oracles.artifactDigestUnchanged !== true
    ) {
      return fail(
        "INCOMPLETE_PASS_EVIDENCE",
        "P3-D PASS evidence is incomplete.",
      );
    }
  } else if (result.status === "NOT_RUN") {
    if (blocker === null) {
      return fail(
        "NOT_RUN_REQUIRES_BLOCKER",
        "P3-D NOT_RUN requires an owned blocker and exit condition.",
      );
    }
    if (result.required === true && result.phase === "exit") {
      return fail(
        "REQUIRED_CASE_NOT_RUN_AT_EXIT",
        "A required P3-D exit case cannot be NOT_RUN.",
      );
    }
  } else if (blocker === null) {
    return fail("BLOCKER_REQUIRED", "P3-D failure evidence requires an owned blocker.");
  }

  return value;
}
