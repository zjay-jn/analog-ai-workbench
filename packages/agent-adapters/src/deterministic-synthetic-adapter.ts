import {
  decodeAgentSourceEventFrameV1,
  type DecodedAgentSourceFrameV1,
} from "./agent-contract";

export const P4B_ZERO_SIDE_EFFECT_COUNTERS_V1 = Object.freeze({
  toolBrokerInvocationCount: 0,
  capabilityGrantCount: 0,
  productDocumentFileMutationCount: 0,
  nativeSaveHelperCallCount: 0,
  oaEdaMutationCallCount: 0,
  externalNetworkCount: 0,
  processSpawnCount: 0,
  pythonBridgeCallCount: 0,
  credentialReadCount: 0,
} as const);

export type P4bExecutionInputV1 = Readonly<{
  vectorId: string;
  oracleId: string;
  harness: "reducer" | "ledger_recovery";
  negotiatedCapabilities: readonly string[];
  preState: Readonly<Record<string, unknown>>;
  stateFixture: Readonly<Record<string, unknown>>;
  steps: readonly unknown[];
  faultPoint?: string;
}>;

export type P4bSourceFrameEvidenceV1 = Readonly<{
  fixtureId: string;
  sourceRunId: string;
  sourceEventId: string;
  sourceSequence: number;
  rawBytes: Uint8Array;
}>;

export type P4bHarnessDependenciesV1 = Readonly<{
  sourceFrames: readonly P4bSourceFrameEvidenceV1[];
  ledger?: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertP4bExecutionInputV1(
  input: unknown,
  harness: P4bExecutionInputV1["harness"],
): asserts input is P4bExecutionInputV1 {
  if (!isRecord(input)) throw new TypeError("P4-B execution input must be an object");
  const allowed = new Set([
    "vectorId", "oracleId", "harness", "negotiatedCapabilities", "preState",
    "stateFixture", "steps", "faultPoint",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)) || "expected" in input) {
    throw new TypeError("P4-B execution input contains a forbidden field");
  }
  if (
    typeof input.vectorId !== "string" ||
    typeof input.oracleId !== "string" ||
    input.harness !== harness ||
    !Array.isArray(input.negotiatedCapabilities) ||
    !input.negotiatedCapabilities.every((value) => typeof value === "string") ||
    !isRecord(input.preState) ||
    !isRecord(input.stateFixture) ||
    !Array.isArray(input.steps) ||
    (input.faultPoint !== undefined && typeof input.faultPoint !== "string")
  ) {
    throw new TypeError("P4-B execution input is invalid");
  }
}

function copyRawBytes(rawFrame: unknown): Uint8Array {
  if (
    !(rawFrame instanceof Uint8Array) ||
    Object.getPrototypeOf(rawFrame) !== Uint8Array.prototype
  ) {
    throw new TypeError("Synthetic source ingress accepts only raw Uint8Array bytes");
  }
  return Uint8Array.from(rawFrame);
}

export function decodeSyntheticSourceFrameV1(
  rawFrame: unknown,
): DecodedAgentSourceFrameV1 {
  return decodeAgentSourceEventFrameV1(copyRawBytes(rawFrame));
}

export function requireSyntheticSourceFrameV1(
  dependencies: P4bHarnessDependenciesV1,
  identity: Readonly<{
    fixtureId?: string;
    sourceRunId?: string;
    sourceEventId?: string;
    sourceSequence?: number;
  }>,
): DecodedAgentSourceFrameV1 {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    !Array.isArray(dependencies.sourceFrames)
  ) {
    throw new TypeError("P4-B harness sourceFrames are required");
  }
  const matches = dependencies.sourceFrames.filter((frame) =>
    (identity.fixtureId === undefined || frame.fixtureId === identity.fixtureId) &&
    (identity.sourceRunId === undefined || frame.sourceRunId === identity.sourceRunId) &&
    (identity.sourceEventId === undefined || frame.sourceEventId === identity.sourceEventId) &&
    (identity.sourceSequence === undefined || frame.sourceSequence === identity.sourceSequence)
  );
  if (matches.length !== 1) {
    throw new TypeError("P4-B source identity must select exactly one raw frame");
  }
  const evidence = matches[0]!;
  const decoded = decodeSyntheticSourceFrameV1(evidence.rawBytes);
  if (
    decoded.event.sourceRunId !== evidence.sourceRunId ||
    decoded.event.sourceEventId !== evidence.sourceEventId ||
    decoded.event.sourceSequence !== evidence.sourceSequence
  ) {
    throw new TypeError("P4-B raw frame identity does not match fixture evidence");
  }
  return decoded;
}

export type DeterministicSyntheticAdapterV1 = Readonly<{
  nextRawFrame(): Uint8Array | undefined;
  dispatchCancel(commandId: string): boolean;
  sideEffectCounters: typeof P4B_ZERO_SIDE_EFFECT_COUNTERS_V1;
}>;

/** Test-only byte transport. It has no registry, network, model, tool, or file API. */
export function createDeterministicSyntheticAdapterV1(
  rawFrames: readonly Uint8Array[],
): DeterministicSyntheticAdapterV1 {
  const frames = rawFrames.map(copyRawBytes);
  const dispatched = new Set<string>();
  let cursor = 0;
  return Object.freeze({
    nextRawFrame(): Uint8Array | undefined {
      const frame = frames[cursor];
      cursor += frame === undefined ? 0 : 1;
      return frame === undefined ? undefined : Uint8Array.from(frame);
    },
    dispatchCancel(commandId: string): boolean {
      if (typeof commandId !== "string" || commandId.length === 0) {
        throw new TypeError("cancel command identity is required");
      }
      if (dispatched.has(commandId)) return false;
      dispatched.add(commandId);
      return true;
    },
    sideEffectCounters: P4B_ZERO_SIDE_EFFECT_COUNTERS_V1,
  });
}

export function cloneFrozenP4bResultV1<T>(value: T): T {
  const materialize = (
    candidate: unknown,
    useNullPrototype: boolean,
  ): unknown => {
    if (Array.isArray(candidate)) {
      return Object.freeze(candidate.map((item) => materialize(item, false)));
    }
    if (candidate === null || typeof candidate !== "object") {
      return candidate;
    }

    const output = Object.create(
      useNullPrototype ? null : Object.prototype,
    ) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("P4-B result objects may contain only data properties");
      }
      Object.defineProperty(output, key, {
        value: materialize(
          descriptor.value,
          key === "sideEffectCounters",
        ),
        enumerable: descriptor.enumerable === true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(output);
  };

  return materialize(value, true) as T;
}
