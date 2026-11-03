import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseConformanceTraceabilityManifestV1,
  type ConformanceTraceabilityManifestV1,
  type ConformanceVectorV1,
} from "../../packages/agent-adapters/src/conformance";
import type {
  executeP4bLedgerRecoveryVectorV1 as P4bLedgerRecoveryRunnerCompileReference,
  RestartableAgentLedgerV1,
} from "../../packages/agent-adapters/src/agent-ledger-contract";
import type {
  executeP4bReducerVectorV1 as P4bReducerRunnerCompileReference,
} from "../../packages/agent-adapters/src/synthetic-agent-core";

export const P4B_REDUCER_RUNNER_UNAVAILABLE =
  "P4B_REDUCER_RUNNER_UNAVAILABLE" as const;
export const P4B_LEDGER_RECOVERY_RUNNER_UNAVAILABLE =
  "P4B_LEDGER_RECOVERY_RUNNER_UNAVAILABLE" as const;

export type P4bRunnerUnavailableCode =
  | typeof P4B_REDUCER_RUNNER_UNAVAILABLE
  | typeof P4B_LEDGER_RECOVERY_RUNNER_UNAVAILABLE;

export class P4bRunnerUnavailableError extends Error {
  constructor(readonly code: P4bRunnerUnavailableCode) {
    super(code);
    this.name = "P4bRunnerUnavailableError";
  }
}

type JsonRecord = Readonly<Record<string, unknown>>;

export type FrozenP4bVector = Readonly<{
  id: string;
  oracleId: string;
  harness: "reducer" | "ledger_recovery";
  requiredStage: "P4-B";
  negotiatedCapabilities: readonly string[];
  preState: JsonRecord;
  steps: readonly unknown[];
  faultPoint?: string;
  expected: JsonRecord;
}>;

export type P4bExecutionInput = Readonly<{
  vectorId: string;
  oracleId: string;
  harness: "reducer" | "ledger_recovery";
  negotiatedCapabilities: readonly string[];
  preState: JsonRecord;
  stateFixture: JsonRecord;
  steps: readonly unknown[];
  faultPoint?: string;
}>;

export type P4bSourceFrameV1 = Readonly<{
  fixtureId: string;
  sourceRunId: string;
  sourceEventId: string;
  sourceSequence: number;
  rawBytes: Uint8Array;
}>;

export type P4bHarnessDependenciesV1 = Readonly<{
  sourceFrames: readonly P4bSourceFrameV1[];
  ledger?: RestartableAgentLedgerV1;
}>;

export type P4bVectorRunner = (
  input: P4bExecutionInput,
  dependencies?: P4bHarnessDependenciesV1,
) => unknown | Promise<unknown>;

type PlannedP4bRunnerCompileReference =
  | typeof P4bReducerRunnerCompileReference
  | typeof P4bLedgerRecoveryRunnerCompileReference;

export type OptionalP4bRunner =
  | Readonly<{ available: true; runner: P4bVectorRunner }>
  | Readonly<{ available: false; code: P4bRunnerUnavailableCode }>;

const traceabilityPath = resolve(
  process.cwd(),
  "packages/agent-adapters/fixtures/n01-n30.traceability.json",
);
const approvedFixtureManifestPath = resolve(
  process.cwd(),
  "packages/agent-adapters/fixtures/approved-synthetic-agent-fixtures.manifest.json",
);

// The non-literal dynamic imports preserve the historical RED unavailable
// mapping. The type-only references above now add the implemented product
// modules and their dependencies to the tsc program, so GREEN loads emitted JS
// and never executes extensionless imports from the source .ts files.
const reducerModuleSpecifier = pathToFileURL(
  resolve(
    process.cwd(),
    ".local/test-build/packages/agent-adapters/src/synthetic-agent-core.js",
  ),
).href;
const ledgerRecoveryModuleSpecifier = pathToFileURL(
  resolve(
    process.cwd(),
    ".local/test-build/packages/agent-adapters/src/agent-ledger-contract.js",
  ),
).href;

let cachedManifest: ConformanceTraceabilityManifestV1 | undefined;
let cachedSourceFrames: readonly P4bSourceFrameV1[] | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
    Object.freeze(value as object);
  }
  return value;
}

function isFrozenP4bVector(
  vector: ConformanceVectorV1,
): vector is ConformanceVectorV1 & FrozenP4bVector {
  return (
    vector.requiredStage === "P4-B" &&
    (vector.harness === "reducer" || vector.harness === "ledger_recovery") &&
    isRecord(vector.preState) &&
    Array.isArray(vector.steps) &&
    isRecord(vector.expected) &&
    (vector.harness !== "ledger_recovery" ||
      typeof vector.faultPoint === "string")
  );
}

export function loadFrozenP4bManifest(): ConformanceTraceabilityManifestV1 {
  cachedManifest ??= parseConformanceTraceabilityManifestV1(
    JSON.parse(readFileSync(traceabilityPath, "utf8")),
  );
  return cachedManifest;
}

export function loadFrozenP4bVectors(): readonly FrozenP4bVector[] {
  const vectors = loadFrozenP4bManifest().vectors.filter(isFrozenP4bVector);
  if (vectors.length !== 40) {
    throw new Error(`P4-B vector count drifted: expected 40, got ${vectors.length}`);
  }
  const reducerCount = vectors.filter(
    (vector) => vector.harness === "reducer",
  ).length;
  const recoveryCount = vectors.filter(
    (vector) => vector.harness === "ledger_recovery",
  ).length;
  if (reducerCount !== 31 || recoveryCount !== 9) {
    throw new Error(
      `P4-B harness split drifted: expected 31/9, got ${reducerCount}/${recoveryCount}`,
    );
  }
  return Object.freeze(vectors);
}

export function loadApprovedP4bSourceFrames(): readonly P4bSourceFrameV1[] {
  if (cachedSourceFrames !== undefined) {
    return cachedSourceFrames.map((frame) =>
      Object.freeze({ ...frame, rawBytes: Uint8Array.from(frame.rawBytes) }),
    );
  }
  const manifest = requireRecord(
    JSON.parse(readFileSync(approvedFixtureManifestPath, "utf8")),
    "approved synthetic fixture manifest",
  );
  if (!Array.isArray(manifest.entries)) {
    throw new TypeError("approved synthetic fixture manifest entries must be an array");
  }
  const frames = manifest.entries.map((entryValue, index): P4bSourceFrameV1 => {
    const entry = requireRecord(entryValue, `approved fixture entry ${index}`);
    if (
      typeof entry.fixtureId !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.byteLength !== "number" ||
      typeof entry.rawSha256 !== "string" ||
      typeof entry.sourceRunId !== "string" ||
      typeof entry.sourceEventId !== "string" ||
      typeof entry.sourceSequence !== "number"
    ) {
      throw new TypeError(`approved fixture entry ${index} is invalid`);
    }
    const bytes = Uint8Array.from(
      readFileSync(resolve(process.cwd(), entry.path)),
    );
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== entry.byteLength || digest !== entry.rawSha256) {
      throw new Error(`approved fixture ${entry.fixtureId} byte binding drifted`);
    }
    return Object.freeze({
      fixtureId: entry.fixtureId,
      sourceRunId: entry.sourceRunId,
      sourceEventId: entry.sourceEventId,
      sourceSequence: entry.sourceSequence,
      rawBytes: bytes,
    });
  });
  cachedSourceFrames = Object.freeze(frames);
  return loadApprovedP4bSourceFrames();
}

export function createP4bHarnessDependencies(
  ledger?: RestartableAgentLedgerV1,
): P4bHarnessDependenciesV1 {
  return Object.freeze({
    sourceFrames: loadApprovedP4bSourceFrames(),
    ...(ledger === undefined ? {} : { ledger }),
  });
}

export function executionInputFor(
  vector: FrozenP4bVector,
): P4bExecutionInput {
  const fixtureId = vector.preState.fixtureId;
  if (typeof fixtureId !== "string") {
    throw new TypeError(`${vector.id} preState.fixtureId must be a string`);
  }
  const fixture = loadFrozenP4bManifest().stateFixtures.find(
    (candidate) => candidate.fixtureId === fixtureId,
  );
  if (fixture === undefined) {
    throw new Error(`${vector.id} references missing state fixture ${fixtureId}`);
  }

  const input: P4bExecutionInput = {
    vectorId: vector.id,
    oracleId: vector.oracleId,
    harness: vector.harness,
    negotiatedCapabilities: structuredClone(vector.negotiatedCapabilities),
    preState: structuredClone(vector.preState),
    stateFixture: structuredClone(fixture) as unknown as JsonRecord,
    steps: structuredClone(vector.steps),
    ...(vector.faultPoint === undefined
      ? {}
      : { faultPoint: vector.faultPoint }),
  };
  if ("expected" in input) {
    throw new Error("P4-B execution input must never contain the expected oracle");
  }
  return freezeDeep(input);
}

function isMissingPlannedModule(error: unknown, moduleSpecifier: string): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const code = error.code;
  const message = error.message;
  const missingUrl = error.url;
  const modulePath = fileURLToPath(moduleSpecifier);
  const candidates = [
    moduleSpecifier,
    decodeURIComponent(moduleSpecifier),
    modulePath,
    modulePath.replace(/\\/gu, "/"),
  ];
  if (
    code === "ERR_MODULE_NOT_FOUND" &&
    typeof missingUrl === "string"
  ) {
    return candidates.includes(missingUrl);
  }
  const firstLine =
    typeof message === "string"
      ? (message.match(/^[^\r\n]*/u)?.[0] ?? "")
      : "";
  return (
    (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    candidates.some((candidate) => firstLine.includes(candidate))
  );
}

async function requirePlannedRunner(
  moduleSpecifier: string,
  exportName: string,
  unavailableCode: P4bRunnerUnavailableCode,
): Promise<P4bVectorRunner> {
  let namespace: unknown;
  try {
    namespace = await import(moduleSpecifier);
  } catch (error: unknown) {
    if (isMissingPlannedModule(error, moduleSpecifier)) {
      throw new P4bRunnerUnavailableError(unavailableCode);
    }
    throw error;
  }
  const moduleRecord = requireRecord(namespace, moduleSpecifier);
  const candidate = moduleRecord[exportName];
  if (typeof candidate !== "function") {
    throw new P4bRunnerUnavailableError(unavailableCode);
  }
  return candidate as P4bVectorRunner & PlannedP4bRunnerCompileReference;
}

export function requireP4bReducerRunner(): Promise<P4bVectorRunner> {
  return requirePlannedRunner(
    reducerModuleSpecifier,
    "executeP4bReducerVectorV1",
    P4B_REDUCER_RUNNER_UNAVAILABLE,
  );
}

export function requireP4bLedgerRecoveryRunner(): Promise<P4bVectorRunner> {
  return requirePlannedRunner(
    ledgerRecoveryModuleSpecifier,
    "executeP4bLedgerRecoveryVectorV1",
    P4B_LEDGER_RECOVERY_RUNNER_UNAVAILABLE,
  );
}

async function optionalRunner(
  load: () => Promise<P4bVectorRunner>,
  unavailableCode: P4bRunnerUnavailableCode,
): Promise<OptionalP4bRunner> {
  try {
    return Object.freeze({ available: true, runner: await load() });
  } catch (error: unknown) {
    if (
      error instanceof P4bRunnerUnavailableError &&
      error.code === unavailableCode
    ) {
      return Object.freeze({ available: false, code: unavailableCode });
    }
    throw error;
  }
}

export function optionalP4bReducerRunner(): Promise<OptionalP4bRunner> {
  return optionalRunner(
    requireP4bReducerRunner,
    P4B_REDUCER_RUNNER_UNAVAILABLE,
  );
}

export function optionalP4bLedgerRecoveryRunner(): Promise<OptionalP4bRunner> {
  return optionalRunner(
    requireP4bLedgerRecoveryRunner,
    P4B_LEDGER_RECOVERY_RUNNER_UNAVAILABLE,
  );
}

export async function runAndRequireRecord(
  runner: P4bVectorRunner,
  vector: FrozenP4bVector,
  dependencies: P4bHarnessDependenciesV1 = createP4bHarnessDependencies(),
): Promise<JsonRecord> {
  return runInputAndRequireRecord(runner, executionInputFor(vector), dependencies);
}

export async function runInputAndRequireRecord(
  runner: P4bVectorRunner,
  input: P4bExecutionInput,
  dependencies: P4bHarnessDependenciesV1 = createP4bHarnessDependencies(),
): Promise<JsonRecord> {
  return requireRecord(
    await runner(input, dependencies),
    `${input.vectorId} actual result`,
  );
}
