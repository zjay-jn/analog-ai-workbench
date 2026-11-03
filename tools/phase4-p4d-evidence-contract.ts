export const P4D_EVIDENCE_STATUSES_V1 = Object.freeze(["PASS", "FAIL", "BLOCKED", "NOT_RUN"] as const);
export type P4dEvidenceStatusV1 = (typeof P4D_EVIDENCE_STATUSES_V1)[number];

const RESULT_KEYS = Object.freeze(["blocker", "caseId", "environment", "kind", "oracles", "rawLog", "required", "schemaVersion", "screenshot", "status"]);
const ENVIRONMENT_KEYS = Object.freeze(["deviceScaleFactor", "pageZoom", "physicalHeight", "physicalWidth", "platform"]);
const ORACLE_BOOLEAN_KEYS = Object.freeze([
  "apiExactSeven", "ariaContract", "artifactDigestUnchanged", "contextIsolation", "cspClosed", "expectedStateVisible",
  "focusVisible", "keyboardReachable", "noHorizontalOverflow", "noModelToolsLabelVisible", "noOrphans", "nodeIntegrationDisabled",
  "postActionPassed", "realElectron", "sandbox", "syntheticLabelVisible", "webviewDisabled", "zeroPostRevokeDelivery",
]);
const ORACLE_COUNTER_KEYS = Object.freeze([
  "externalNetworkCount", "fileMutationCount", "nativeSaveHelperCallCount", "oaEdaMutationCount", "postRevokeDeliveryCount", "processSpawnCount", "registryMutationCount",
]);

export class P4dEvidenceContractError extends Error {
  readonly code: "INVALID_RESULT" | "INVALID_STATUS" | "INVALID_ENVIRONMENT" | "INVALID_ORACLES" | "INCOMPLETE_PASS" | "REQUIRED_NOT_RUN" | "SIDE_EFFECT_DETECTED";

  constructor(code: "INVALID_RESULT" | "INVALID_STATUS" | "INVALID_ENVIRONMENT" | "INVALID_ORACLES" | "INCOMPLETE_PASS" | "REQUIRED_NOT_RUN" | "SIDE_EFFECT_DETECTED") {
    super("The P4-D evidence result is invalid.");
    this.name = "P4dEvidenceContractError";
    this.code = code;
  }
}

function exact(value: unknown, keys: readonly string[], code: P4dEvidenceContractError["code"]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new P4dEvidenceContractError(code);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new P4dEvidenceContractError(code);
  return value as Readonly<Record<string, unknown>>;
}
function relativePath(value: unknown): boolean { return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && !value.split("/").includes(".."); }
function sha(value: unknown): boolean { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }

export function validateP4dEvidenceResultV1<T>(value: T): T {
  const result = exact(value, RESULT_KEYS, "INVALID_RESULT");
  if (result.schemaVersion !== "aaw.phase4.p4d.evidence-result/v1" || !["visual", "lifecycle", "production"].includes(String(result.kind)) || typeof result.caseId !== "string" || result.caseId.length === 0 || typeof result.required !== "boolean") throw new P4dEvidenceContractError("INVALID_RESULT");
  if (typeof result.status !== "string" || !P4D_EVIDENCE_STATUSES_V1.includes(result.status as P4dEvidenceStatusV1)) throw new P4dEvidenceContractError("INVALID_STATUS");
  const environment = exact(result.environment, ENVIRONMENT_KEYS, "INVALID_ENVIRONMENT");
  if (environment.platform !== "win32" || environment.physicalWidth !== 1366 || environment.physicalHeight !== 768 || ![1, 1.25, 1.5].includes(Number(environment.deviceScaleFactor)) || ![1, 2].includes(Number(environment.pageZoom))) throw new P4dEvidenceContractError("INVALID_ENVIRONMENT");
  const oracles = exact(result.oracles, [...ORACLE_BOOLEAN_KEYS, ...ORACLE_COUNTER_KEYS], "INVALID_ORACLES");
  if (ORACLE_BOOLEAN_KEYS.some((key) => typeof oracles[key] !== "boolean") || ORACLE_COUNTER_KEYS.some((key) => !Number.isSafeInteger(oracles[key]) || Number(oracles[key]) < 0)) throw new P4dEvidenceContractError("INVALID_ORACLES");
  const screenshot = result.screenshot === null ? null : exact(result.screenshot, ["height", "relativePath", "sha256", "width"], "INVALID_RESULT");
  if (screenshot !== null && (!relativePath(screenshot.relativePath) || screenshot.width !== 1366 || screenshot.height !== 768 || !sha(screenshot.sha256))) throw new P4dEvidenceContractError("INVALID_RESULT");
  const rawLog = result.rawLog === null ? null : exact(result.rawLog, ["relativePath", "sha256"], "INVALID_RESULT");
  if (rawLog !== null && (!relativePath(rawLog.relativePath) || !sha(rawLog.sha256))) throw new P4dEvidenceContractError("INVALID_RESULT");
  const blocker = result.blocker === null ? null : exact(result.blocker, ["exitCondition", "owner", "reason"], "INVALID_RESULT");
  if (blocker !== null && Object.values(blocker).some((entry) => typeof entry !== "string" || entry.length === 0)) throw new P4dEvidenceContractError("INVALID_RESULT");
  if (ORACLE_COUNTER_KEYS.some((key) => Number(oracles[key]) !== 0)) throw new P4dEvidenceContractError("SIDE_EFFECT_DETECTED");
  if (result.status === "PASS") {
    if (ORACLE_BOOLEAN_KEYS.some((key) => oracles[key] !== true) || rawLog === null || blocker !== null || (result.kind === "visual" && screenshot === null)) throw new P4dEvidenceContractError("INCOMPLETE_PASS");
  } else if (result.required === true && result.status === "NOT_RUN") {
    if (blocker === null) throw new P4dEvidenceContractError("REQUIRED_NOT_RUN");
  }
  return value;
}

export function assertP4dExitCompleteV1(results: readonly unknown[]): void {
  if (results.length !== 16) throw new P4dEvidenceContractError("REQUIRED_NOT_RUN");
  for (const result of results) {
    validateP4dEvidenceResultV1(result);
    const row = result as Readonly<Record<string, unknown>>;
    if (row.required !== true || row.status !== "PASS") throw new P4dEvidenceContractError("REQUIRED_NOT_RUN");
  }
}
