import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AAW_CANONICAL_MAX_BYTES,
  AAW_CANONICAL_MAX_DEPTH,
  AAW_CANONICAL_MAX_STRING_BYTES,
  AawCanonicalJsonError,
  canonicalizeAawJsonV1,
  sha256CanonicalAawJsonV1,
  type AawCanonicalJsonErrorCode,
} from "../packages/schematic-workbench/src/canonical-json";
import {
  resolveOccurrenceNetV1,
  ReviewedCircuitIrError,
  validateReviewedCircuitIrV1,
  type ReviewedCircuitIrErrorCode,
  type ReviewedCircuitIrV1,
} from "../packages/schematic-workbench/src/reviewed-circuit-ir";
import {
  decodeStrictSourceFrameV1,
  snapshotStrictSourceFrameV1,
  STRICT_SOURCE_FRAME_MAX_BYTES,
  STRICT_SOURCE_FRAME_MAX_DEPTH,
  STRICT_SOURCE_FRAME_MAX_STRING_BYTES,
  StrictSourceFrameError,
  type StrictSourceFrameErrorCode,
} from "../packages/schematic-workbench/src/strict-source-frame";
import {
  APPROVED_SYNTHETIC_FIXTURE_MANIFEST_SHA256,
  createSyntheticAdmissionRegistryV1,
  SyntheticAdmissionError,
  type SyntheticAdmissionErrorCode,
} from "../packages/schematic-workbench/src/synthetic-admission";

const manifestPath =
  "packages/schematic-workbench/fixtures/approved-synthetic-fixtures.manifest.json";
const fixtureIds = [
  "flat-basic",
  "repeated-hierarchy",
  "same-label-different-net",
  "blackbox-child",
  "explicit-port-mapping",
  "empty-minimum",
  "max-boundary",
  "unicode-labels",
] as const;
const circuitIrTopLevelKeys = [
  "schemaVersion",
  "canonicalizationVersion",
  "coordinateUnit",
  "bounds",
  "rootDefinitionId",
  "definitions",
] as const;

type ManifestEntry = {
  fixtureId: string;
  relativePath: string;
  byteLength: number;
  rawSha256: string;
  payloadDigest: string;
  documentRef: {
    documentId: string;
    revisionId: string;
    documentKind: string;
  };
  artifactRef: {
    artifactId: string;
    revisionId: string;
    artifactKind: string;
  };
  receiptId: string;
  limitOracle: {
    mode: "inline-small" | "generated-boundary";
    declaredBoundary: string;
  };
  expectedSemanticOracleIds: string[];
};

type ApprovedManifest = {
  entries: ManifestEntry[];
};

function standardBytes(relativePath: string): Uint8Array {
  return Uint8Array.from(readFileSync(relativePath));
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function strictFrameError(
  code: StrictSourceFrameErrorCode,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof StrictSourceFrameError);
    assert.equal(error.code, code);
    return true;
  };
}

function canonicalError(
  code: AawCanonicalJsonErrorCode,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AawCanonicalJsonError);
    assert.equal(error.code, code);
    return true;
  };
}

function admissionError(
  code: SyntheticAdmissionErrorCode,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof SyntheticAdmissionError);
    assert.equal(error.code, code);
    assert.equal(error.retryability, "never");
    assert.equal(error.recoveryAction, "none");
    return true;
  };
}

function circuitError(
  code: ReviewedCircuitIrErrorCode,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ReviewedCircuitIrError);
    assert.equal(error.code, code);
    return true;
  };
}

function nestedArrays(depth: number): unknown {
  let value: unknown = 0;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function exactAsciiStringArrayJsonBytes(
  targetBytes: number,
  objectEnvelope: boolean,
): Uint8Array {
  const fullStringCount = 2_046;
  const itemCount = fullStringCount + 1;
  const fixedArrayBytes = fullStringCount * AAW_CANONICAL_MAX_STRING_BYTES +
    3 * itemCount + 1;
  const envelopeBytes = objectEnvelope ? 6 : 0;
  const tailBytes = targetBytes - fixedArrayBytes - envelopeBytes;
  assert.ok(tailBytes > 0 && tailBytes <= AAW_CANONICAL_MAX_STRING_BYTES);
  const values = Array.from(
    { length: fullStringCount },
    () => "a".repeat(AAW_CANONICAL_MAX_STRING_BYTES),
  );
  values.push("a".repeat(tailBytes));
  const text = objectEnvelope ? JSON.stringify({ a: values }) : JSON.stringify(values);
  const bytes = new TextEncoder().encode(text);
  assert.equal(bytes.byteLength, targetBytes);
  return bytes;
}

function exactCanonicalStringArray(targetBytes: number): string[] {
  const fullStringCount = 2_046;
  const itemCount = fullStringCount + 1;
  const fixedBytes = fullStringCount * AAW_CANONICAL_MAX_STRING_BYTES +
    3 * itemCount + 1;
  const tailBytes = targetBytes - fixedBytes;
  assert.ok(tailBytes > 0 && tailBytes <= AAW_CANONICAL_MAX_STRING_BYTES);
  const values = Array.from(
    { length: fullStringCount },
    () => "a".repeat(AAW_CANONICAL_MAX_STRING_BYTES),
  );
  values.push("a".repeat(tailBytes));
  return values;
}

type SemanticOracle = (
  circuitIr: ReviewedCircuitIrV1,
  manifestEntry: ManifestEntry,
) => void;

const semanticOracles: Readonly<Record<string, SemanticOracle>> = Object.freeze({
  "oracle.flat-net": (circuitIr) => {
    assert.deepEqual(resolveOccurrenceNetV1(circuitIr, [], "net.flat"), {
      definitionId: "definition.flat",
      occurrencePath: [],
      netId: "net.flat",
    });
  },
  "oracle.repeated-occurrence-paths": (circuitIr) => {
    const left = resolveOccurrenceNetV1(
      circuitIr,
      ["instance.left"],
      "net.reused",
    );
    const right = resolveOccurrenceNetV1(
      circuitIr,
      ["instance.right"],
      "net.reused",
    );
    assert.deepEqual(left.occurrencePath, ["instance.left"]);
    assert.deepEqual(right.occurrencePath, ["instance.right"]);
    assert.notDeepEqual(left.occurrencePath, right.occurrencePath);
  },
  "oracle.same-label-distinct-net": (circuitIr) => {
    const definition = circuitIr.definitions[0]!;
    assert.deepEqual(
      definition.labels.map((label) => label.text),
      ["SAME", "SAME"],
    );
    assert.deepEqual(
      definition.labels.map((label) => label.targetElementId),
      ["wire.left", "wire.right"],
    );
    assert.deepEqual(
      definition.wires.map((wire) => [wire.wireId, wire.netId]),
      [
        ["wire.left", "net.left"],
        ["wire.right", "net.right"],
      ],
    );
  },
  "oracle.blackbox-nonnavigable": (circuitIr) => {
    const instance = circuitIr.definitions[0]!.instances[0]!;
    assert.equal(instance.blackbox, true);
    assert.equal(instance.childDefinitionId, undefined);
    assert.throws(
      () => resolveOccurrenceNetV1(circuitIr, [instance.instanceId], "net.any"),
      circuitError("OCCURRENCE_UNAVAILABLE"),
    );
  },
  "oracle.parent-terminal-port-mapping": (circuitIr) => {
    const root = circuitIr.definitions.find(
      (definition) => definition.definitionId === "definition.mapping-root",
    );
    const child = circuitIr.definitions.find(
      (definition) => definition.definitionId === "definition.mapping-child",
    );
    assert.ok(root);
    assert.ok(child);
    assert.deepEqual(root.instances[0]!.terminalMappings, [
      {
        terminalId: "terminal.in",
        parentNetId: "net.parent",
        childPortId: "port.in",
        childNetId: "net.child",
      },
    ]);
    assert.deepEqual(root.pins, [
      {
        pinId: "pin.parent",
        instanceId: "instance.child",
        terminalId: "terminal.in",
        netId: "net.parent",
        x: 5,
        y: 6,
      },
    ]);
    assert.deepEqual(child.ports, [
      { portId: "port.in", netId: "net.child", x: 0, y: 4 },
    ]);
  },
  "oracle.empty-minimum": (circuitIr) => {
    const definition = circuitIr.definitions[0]!;
    assert.equal(circuitIr.definitions.length, 1);
    assert.deepEqual(
      [
        definition.instances.length,
        definition.ports.length,
        definition.nets.length,
        definition.wires.length,
        definition.labels.length,
        definition.renderOrder.length,
      ],
      [0, 0, 0, 0, 0, 0],
    );
  },
  "oracle.generated-eight-mibibyte-boundary": (_circuitIr, manifestEntry) => {
    assert.equal(manifestEntry.limitOracle.mode, "generated-boundary");
    assert.match(manifestEntry.limitOracle.declaredBoundary, /8388608-byte/u);
    const exactBoundary = exactAsciiStringArrayJsonBytes(
      STRICT_SOURCE_FRAME_MAX_BYTES,
      true,
    );
    assert.doesNotThrow(() =>
      decodeStrictSourceFrameV1(exactBoundary, { allowedTopLevelKeys: ["a"] }),
    );
  },
  "oracle.coordinate-max-boundary": (circuitIr) => {
    assert.deepEqual(circuitIr.bounds, {
      minX: -1_000_000_000,
      minY: -1_000_000_000,
      maxX: 1_000_000_000,
      maxY: 1_000_000_000,
    });
    assert.deepEqual(circuitIr.definitions[0]!.bounds, circuitIr.bounds);
  },
  "oracle.unicode-label-plain-text": (circuitIr) => {
    const label = circuitIr.definitions[0]!.labels[0]!;
    assert.equal(label.text, "合成节点✨");
    assert.equal(label.targetElementId, "wire.unicode");
    assert.equal(typeof label.text, "string");
  },
});

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      assertDeepFrozen(descriptor.value, seen);
    }
  }
}

test("P3-A strict source codec rejects byte, key, Unicode, number and prototype ambiguity", () => {
  const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
  const cases: ReadonlyArray<
    readonly [string, Uint8Array, StrictSourceFrameErrorCode]
  > = [
    ["invalid UTF-8", Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xc3, 0x28, 0x7d]), "INVALID_UTF8"],
    ["UTF-8 BOM", Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('{"a":1}')]), "BOM_FORBIDDEN"],
    ["nested escaped duplicate", utf8('{"a":{"x":1,"\\u0078":2}}'), "DUPLICATE_KEY"],
    ["escaped prototype", utf8('{"a":{"\\u005f\\u005fproto\\u005f\\u005f":1}}'), "PROTOTYPE_KEY"],
    ["lone surrogate", utf8('{"a":"\\ud800"}'), "INVALID_STRING"],
    ["negative zero", utf8('{"a":-0}'), "INVALID_NUMBER"],
    ["negative zero fraction", utf8('{"a":-0.0}'), "INVALID_NUMBER"],
    ["negative zero exponent", utf8('{"a":-0e0}'), "INVALID_NUMBER"],
    ["negative zero uppercase exponent", utf8('{"a":-0E-3}'), "INVALID_NUMBER"],
    ["unsafe integer", utf8('{"a":9007199254740992}'), "INVALID_NUMBER"],
    ["unknown top-level field", utf8('{"b":1}'), "UNKNOWN_TOP_LEVEL_KEY"],
  ];
  for (const [label, rawFrame, code] of cases) {
    assert.throws(
      () =>
        decodeStrictSourceFrameV1(rawFrame, {
          maxBytes: 1_024,
          allowedTopLevelKeys: ["a"],
        }),
      strictFrameError(code),
      label,
    );
  }

  const exactBytes = utf8('{"a":1}');
  assert.equal(
    decodeStrictSourceFrameV1(exactBytes, {
      maxBytes: exactBytes.byteLength,
      allowedTopLevelKeys: ["a"],
    }).a,
    1,
  );
  assert.throws(
    () =>
      decodeStrictSourceFrameV1(exactBytes, {
        maxBytes: exactBytes.byteLength - 1,
        allowedTopLevelKeys: ["a"],
      }),
    strictFrameError("PAYLOAD_TOO_LARGE"),
  );

  assert.doesNotThrow(() =>
    decodeStrictSourceFrameV1(utf8('{"a":{"b":1}}'), {
      maxBytes: 1_024,
      maxDepth: 2,
      allowedTopLevelKeys: ["a"],
    }),
  );
  assert.throws(
    () =>
      decodeStrictSourceFrameV1(utf8('{"a":{"b":{"c":1}}}'), {
        maxBytes: 1_024,
        maxDepth: 2,
        allowedTopLevelKeys: ["a"],
      }),
    strictFrameError("MAX_DEPTH_EXCEEDED"),
  );
  assert.doesNotThrow(() =>
    decodeStrictSourceFrameV1(utf8('{"a":"1234"}'), {
      maxBytes: 1_024,
      maxStringBytes: 4,
      allowedTopLevelKeys: ["a"],
    }),
  );
  assert.throws(
    () =>
      decodeStrictSourceFrameV1(utf8('{"a":"12345"}'), {
        maxBytes: 1_024,
        maxStringBytes: 4,
        allowedTopLevelKeys: ["a"],
      }),
    strictFrameError("INVALID_STRING"),
  );

  const shared = new Uint8Array(new SharedArrayBuffer(exactBytes.byteLength));
  shared.set(exactBytes);
  assert.throws(
    () => snapshotStrictSourceFrameV1(shared),
    strictFrameError("INVALID_FRAME"),
  );
});

test("P3-A raw frame byte, nesting and UTF-8 string budgets close at limit-1/limit/limit+1", () => {
  const exactFrame = exactAsciiStringArrayJsonBytes(
    STRICT_SOURCE_FRAME_MAX_BYTES,
    true,
  );
  assert.doesNotThrow(() =>
    decodeStrictSourceFrameV1(exactFrame, { allowedTopLevelKeys: ["a"] }),
  );

  const oversizedFrame = exactAsciiStringArrayJsonBytes(
    STRICT_SOURCE_FRAME_MAX_BYTES + 1,
    true,
  );
  let untrustedGetterReads = 0;
  let observableCopyEntryCalls = 0;
  Object.defineProperty(oversizedFrame, "byteLength", {
    configurable: true,
    get() {
      untrustedGetterReads += 1;
      return 1;
    },
  });
  Object.defineProperty(oversizedFrame, "buffer", {
    configurable: true,
    get() {
      untrustedGetterReads += 1;
      return new ArrayBuffer(1);
    },
  });
  for (const methodName of ["slice", "subarray"] as const) {
    Object.defineProperty(oversizedFrame, methodName, {
      configurable: true,
      value() {
        observableCopyEntryCalls += 1;
        throw new Error(`${methodName} must remain unreachable`);
      },
    });
  }
  Object.defineProperty(oversizedFrame, Symbol.iterator, {
    configurable: true,
    value() {
      observableCopyEntryCalls += 1;
      throw new Error("iterator must remain unreachable");
    },
  });
  assert.equal(Object.getPrototypeOf(oversizedFrame), Uint8Array.prototype);
  const originalConstructorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Uint8Array",
  );
  assert.ok(originalConstructorDescriptor);
  const NativeUint8Array = globalThis.Uint8Array;
  let destinationAllocations = 0;
  const CountingUint8Array = new Proxy(NativeUint8Array, {
    construct(target, argumentsList, newTarget) {
      destinationAllocations += 1;
      return Reflect.construct(target, argumentsList, newTarget);
    },
  }) as typeof Uint8Array;
  try {
    Object.defineProperty(globalThis, "Uint8Array", {
      ...originalConstructorDescriptor,
      value: CountingUint8Array,
    });
    assert.throws(
      () =>
        decodeStrictSourceFrameV1(oversizedFrame, {
          allowedTopLevelKeys: ["a"],
        }),
      strictFrameError("PAYLOAD_TOO_LARGE"),
    );
    assert.equal(
      destinationAllocations,
      0,
      "oversized input must be rejected before destination allocation or copy",
    );
    assert.equal(untrustedGetterReads, 0);
    assert.equal(
      observableCopyEntryCalls,
      0,
      "oversized input must not reach slice/subarray/iterator copy seams",
    );
  } finally {
    Object.defineProperty(globalThis, "Uint8Array", originalConstructorDescriptor);
  }

  const nestedObjectFrame = (levels: number): Uint8Array => {
    let text = "0";
    for (let index = 0; index < levels; index += 1) text = `{"a":${text}}`;
    return new TextEncoder().encode(text);
  };
  for (const levels of [
    STRICT_SOURCE_FRAME_MAX_DEPTH - 1,
    STRICT_SOURCE_FRAME_MAX_DEPTH,
  ]) {
    assert.doesNotThrow(() =>
      decodeStrictSourceFrameV1(nestedObjectFrame(levels), {
        allowedTopLevelKeys: ["a"],
      }),
    );
  }
  assert.throws(
    () =>
      decodeStrictSourceFrameV1(
        nestedObjectFrame(STRICT_SOURCE_FRAME_MAX_DEPTH + 1),
        { allowedTopLevelKeys: ["a"] },
      ),
    strictFrameError("MAX_DEPTH_EXCEEDED"),
  );

  const multibyteLimitMinusOne = "界".repeat(1_365);
  const multibyteAtLimit = `${multibyteLimitMinusOne}a`;
  const multibyteOverLimit = `${multibyteLimitMinusOne}ab`;
  assert.equal(
    new TextEncoder().encode(multibyteLimitMinusOne).byteLength,
    STRICT_SOURCE_FRAME_MAX_STRING_BYTES - 1,
  );
  assert.equal(
    new TextEncoder().encode(multibyteAtLimit).byteLength,
    STRICT_SOURCE_FRAME_MAX_STRING_BYTES,
  );
  for (const value of [multibyteLimitMinusOne, multibyteAtLimit]) {
    assert.doesNotThrow(() =>
      decodeStrictSourceFrameV1(
        new TextEncoder().encode(JSON.stringify({ a: value })),
        { allowedTopLevelKeys: ["a"] },
      ),
    );
  }
  assert.throws(
    () =>
      decodeStrictSourceFrameV1(
        new TextEncoder().encode(JSON.stringify({ a: multibyteOverLimit })),
        { allowedTopLevelKeys: ["a"] },
      ),
    strictFrameError("INVALID_STRING"),
  );
});

test("P3-A canonical byte, nesting and UTF-8 string budgets close at limit-1/limit/limit+1", () => {
  const values = exactCanonicalStringArray(AAW_CANONICAL_MAX_BYTES - 1);
  assert.equal(
    new TextEncoder().encode(canonicalizeAawJsonV1(values)).byteLength,
    AAW_CANONICAL_MAX_BYTES - 1,
  );
  values[values.length - 1] += "a";
  assert.equal(
    new TextEncoder().encode(canonicalizeAawJsonV1(values)).byteLength,
    AAW_CANONICAL_MAX_BYTES,
  );
  values[values.length - 1] += "a";
  assert.throws(
    () => canonicalizeAawJsonV1(values),
    canonicalError("PAYLOAD_TOO_LARGE"),
  );

  for (const depth of [AAW_CANONICAL_MAX_DEPTH - 1, AAW_CANONICAL_MAX_DEPTH]) {
    assert.doesNotThrow(() => canonicalizeAawJsonV1(nestedArrays(depth)));
  }
  assert.throws(
    () => canonicalizeAawJsonV1(nestedArrays(AAW_CANONICAL_MAX_DEPTH + 1)),
    canonicalError("MAX_DEPTH_EXCEEDED"),
  );

  const limitMinusOne = "界".repeat(1_365);
  const atLimit = `${limitMinusOne}a`;
  const overLimit = `${limitMinusOne}ab`;
  assert.equal(
    new TextEncoder().encode(limitMinusOne).byteLength,
    AAW_CANONICAL_MAX_STRING_BYTES - 1,
  );
  assert.equal(
    new TextEncoder().encode(atLimit).byteLength,
    AAW_CANONICAL_MAX_STRING_BYTES,
  );
  assert.doesNotThrow(() => canonicalizeAawJsonV1(limitMinusOne));
  assert.doesNotThrow(() => canonicalizeAawJsonV1(atLimit));
  assert.throws(
    () => canonicalizeAawJsonV1(overLimit),
    canonicalError("INVALID_STRING"),
  );
});

test("P3-A canonical JSON fixes UTF-16 order and full UTF-8 digest without normalization", () => {
  const input = { "\uE000": 2, "\u{10000}": 1, a: 0 };
  const expectedCanonical = '{"a":0,"𐀀":1,"":2}';
  const expectedDigest =
    "sha256:571551b135224225b3e13a93a6d309f8f52742a7e9babc43069987f9a4c67303";
  const before = JSON.stringify(input);
  const canonical = canonicalizeAawJsonV1(input);
  assert.equal(canonical, expectedCanonical);
  assert.equal(
    sha256Bytes(new TextEncoder().encode(expectedCanonical)),
    expectedDigest,
  );
  assert.equal(sha256CanonicalAawJsonV1(input), expectedDigest);
  assert.equal(JSON.stringify(input), before);

  const nfc = canonicalizeAawJsonV1({ label: "é" });
  const nfd = canonicalizeAawJsonV1({ label: "e\u0301" });
  assert.equal(nfc, '{"label":"é"}');
  assert.equal(nfd, '{"label":"é"}');
  assert.notEqual(nfc, nfd);
  assert.notEqual(
    sha256CanonicalAawJsonV1({ payload: "synthetic-tail-a" }),
    sha256CanonicalAawJsonV1({ payload: "synthetic-tail-b" }),
  );
});

test("P3-A RFC 8785 ECMAScript number goldens preserve codec-schema-semantic layering", () => {
  const aawAcceptedCoordinateGoldens: ReadonlyArray<
    readonly [number, string]
  > = [
    [333_333_333.33333329, "333333333.3333333"],
    [4.5, "4.5"],
    [2e-3, "0.002"],
    [1e-27, "1e-27"],
    [1e-6, "0.000001"],
    [1e-7, "1e-7"],
    [Number.MIN_VALUE, "5e-324"],
    [1_000_000_000, "1000000000"],
  ];
  for (const [value, expected] of aawAcceptedCoordinateGoldens) {
    assert.equal(canonicalizeAawJsonV1(value), expected);
    const coordinateIr = JSON.parse(
      readFileSync(
        "packages/schematic-workbench/fixtures/empty-minimum.json",
        "utf8",
      ),
    ) as {
      bounds: { maxX: number };
      definitions: Array<{ bounds: { maxX: number } }>;
    };
    coordinateIr.bounds.maxX = value;
    coordinateIr.definitions[0]!.bounds.maxX = value;
    assert.doesNotThrow(() => validateReviewedCircuitIrV1(coordinateIr));
  }

  const ecmascriptReferenceOnly: ReadonlyArray<readonly [number, string]> = [
    [1e30, "1e+30"],
    [Number.MAX_VALUE, "1.7976931348623157e+308"],
    [9_007_199_254_740_992, "9007199254740992"],
  ];
  for (const [value, expectedEcmascriptSerialization] of ecmascriptReferenceOnly) {
    assert.equal(JSON.stringify(value), expectedEcmascriptSerialization);
    assert.equal(Number.isInteger(value), true);
    assert.equal(Number.isSafeInteger(value), false);
    assert.throws(
      () => canonicalizeAawJsonV1(value),
      canonicalError("INVALID_NUMBER"),
    );
  }

  assert.throws(
    () =>
      decodeStrictSourceFrameV1(
        new TextEncoder().encode('{"a":-0}'),
        { allowedTopLevelKeys: ["a"] },
      ),
    strictFrameError("INVALID_NUMBER"),
  );

  const zeroCoordinate = JSON.parse(
    readFileSync(
      "packages/schematic-workbench/fixtures/empty-minimum.json",
      "utf8",
    ),
  ) as { bounds: { minX: number } };
  assert.doesNotThrow(() => validateReviewedCircuitIrV1(zeroCoordinate));
  zeroCoordinate.bounds.minX = -0;
  assert.throws(
    () => validateReviewedCircuitIrV1(zeroCoordinate),
    circuitError("INVALID_VALUE"),
  );
});

test("P3-A canonical JSON rejects named, symbol and accessor array/object state", () => {
  const namedArray = [1] as number[] & { named?: number };
  namedArray.named = 2;
  const symbolArray = [1];
  Object.defineProperty(symbolArray, Symbol("hidden"), { value: 2 });
  const accessorArray = [1];
  let getterReads = 0;
  Object.defineProperty(accessorArray, "0", {
    configurable: true,
    enumerable: true,
    get: () => {
      getterReads += 1;
      return 1;
    },
  });
  const accessorObject: Record<string, unknown> = {};
  Object.defineProperty(accessorObject, "value", {
    configurable: true,
    enumerable: true,
    get: () => {
      getterReads += 1;
      return 1;
    },
  });

  for (const [label, value] of [
    ["named array", namedArray],
    ["symbol array", symbolArray],
    ["accessor array", accessorArray],
  ] as const) {
    assert.throws(
      () => canonicalizeAawJsonV1(value),
      canonicalError("INVALID_VALUE"),
      label,
    );
  }
  assert.throws(
    () => canonicalizeAawJsonV1(accessorObject),
    canonicalError("INVALID_OBJECT"),
  );
  assert.equal(getterReads, 0);
});

test("P3-A admission never invokes outer getters and fails proxy/accessor inputs closed", () => {
  const rawManifestBytes = standardBytes(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ApprovedManifest;
  const flat = manifest.entries.find((entry) => entry.fixtureId === "flat-basic");
  assert.ok(flat);
  const rawFrame = standardBytes(flat.relativePath);

  let accessorReads = 0;
  const accessorInput: Record<string, unknown> = { rawFrame };
  Object.defineProperty(accessorInput, "fixtureId", {
    configurable: true,
    enumerable: true,
    get() {
      accessorReads += 1;
      return flat.fixtureId;
    },
  });
  assert.throws(
    () => createSyntheticAdmissionRegistryV1(rawManifestBytes).admit(accessorInput),
    admissionError("INVALID_REQUEST"),
  );
  assert.equal(accessorReads, 0);

  let proxyReads = 0;
  const proxyInput = new Proxy(
    { fixtureId: flat.fixtureId, rawFrame },
    {
      get() {
        proxyReads += 1;
        throw new Error("outer get trap must remain unreachable");
      },
    },
  );
  const proxyAdmission = createSyntheticAdmissionRegistryV1(rawManifestBytes).admit(
    proxyInput,
  );
  assert.equal(proxyAdmission.receipt.receiptId, flat.receiptId);
  assert.equal(proxyReads, 0);

  const hostileProxy = new Proxy(
    { fixtureId: flat.fixtureId, rawFrame },
    {
      ownKeys() {
        throw new Error("hostile ownKeys trap");
      },
      get() {
        proxyReads += 1;
        throw new Error("hostile get trap must remain unreachable");
      },
    },
  );
  assert.throws(
    () => createSyntheticAdmissionRegistryV1(rawManifestBytes).admit(hostileProxy),
    admissionError("INVALID_REQUEST"),
  );
  assert.equal(proxyReads, 0);

  let rawProxyReads = 0;
  const proxiedFrame = new Proxy(rawFrame, {
    get() {
      rawProxyReads += 1;
      throw new Error("raw frame get trap must remain unreachable");
    },
  });
  assert.throws(
    () =>
      createSyntheticAdmissionRegistryV1(rawManifestBytes).admit({
        fixtureId: flat.fixtureId,
        rawFrame: proxiedFrame,
      }),
    admissionError("INVALID_REQUEST"),
  );
  assert.equal(rawProxyReads, 0);
});

test("P3-A approved manifest owns all eight exact fixture admissions", () => {
  const rawManifestBytes = standardBytes(manifestPath);
  assert.equal(
    sha256Bytes(rawManifestBytes),
    APPROVED_SYNTHETIC_FIXTURE_MANIFEST_SHA256,
  );
  assert.equal(
    APPROVED_SYNTHETIC_FIXTURE_MANIFEST_SHA256,
    "sha256:b446b2063c9c580dd4009f43759f42e02bba851dd8070b94ab76acb1f7282ff4",
  );
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(rawManifestBytes),
  ) as ApprovedManifest;
  assert.deepEqual(
    manifest.entries.map((entry) => entry.fixtureId),
    fixtureIds,
  );

  const registry = createSyntheticAdmissionRegistryV1(rawManifestBytes);
  const executedSemanticOracleIds = new Set<string>();
  for (const manifestEntry of manifest.entries) {
    const rawFrame = standardBytes(manifestEntry.relativePath);
    assert.equal(rawFrame.byteLength, manifestEntry.byteLength, manifestEntry.fixtureId);
    assert.equal(sha256Bytes(rawFrame), manifestEntry.rawSha256, manifestEntry.fixtureId);
    const decoded = decodeStrictSourceFrameV1(rawFrame, {
      allowedTopLevelKeys: circuitIrTopLevelKeys,
    });
    const hBefore = sha256CanonicalAawJsonV1(decoded);
    assert.equal(hBefore, manifestEntry.payloadDigest, manifestEntry.fixtureId);
    const independentlyValidated = validateReviewedCircuitIrV1(decoded);
    const hAfter = sha256CanonicalAawJsonV1(independentlyValidated);
    assert.equal(hAfter, manifestEntry.payloadDigest, manifestEntry.fixtureId);
    assert.equal(
      new Set(manifestEntry.expectedSemanticOracleIds).size,
      manifestEntry.expectedSemanticOracleIds.length,
      `${manifestEntry.fixtureId}: duplicate semantic oracle id`,
    );
    for (const oracleId of manifestEntry.expectedSemanticOracleIds) {
      const oracle = semanticOracles[oracleId];
      assert.ok(oracle, `${manifestEntry.fixtureId}: unknown semantic oracle ${oracleId}`);
      oracle(independentlyValidated, manifestEntry);
      executedSemanticOracleIds.add(oracleId);
    }
    if (manifestEntry.limitOracle.mode === "inline-small") {
      assert.ok(
        rawFrame.byteLength < STRICT_SOURCE_FRAME_MAX_BYTES,
        `${manifestEntry.fixtureId}: inline fixture must remain below the raw limit`,
      );
    }

    const admitted = registry.admit({
      fixtureId: manifestEntry.fixtureId,
      rawFrame,
    });
    assert.equal(admitted.receipt.payloadDigest, manifestEntry.payloadDigest);
    assert.equal(admitted.receipt.fixtureManifestDigest, APPROVED_SYNTHETIC_FIXTURE_MANIFEST_SHA256);
    assert.equal(admitted.receipt.receiptId, manifestEntry.receiptId);
    assert.deepEqual(admitted.receipt.documentRef, manifestEntry.documentRef);
    assert.deepEqual(admitted.receipt.artifactRef, manifestEntry.artifactRef);
    assert.equal(admitted.providerState.dirty, false);
    assert.equal(sha256CanonicalAawJsonV1(admitted.circuitIr), hAfter);
    assert.equal(registry.admit({ fixtureId: manifestEntry.fixtureId, rawFrame }), admitted);
    assert.equal(registry.resolveByDocument(manifestEntry.documentRef), admitted);
    assert.equal(registry.resolveByArtifact(manifestEntry.artifactRef), admitted);
    assertDeepFrozen(admitted);
  }
  assert.equal(registry.size(), fixtureIds.length);
  assert.deepEqual(
    [...executedSemanticOracleIds].sort(),
    Object.keys(semanticOracles).sort(),
  );
});

test("P3-A admission rejects non-envelope fields and quarantines tamper with zero delivery", () => {
  const rawManifestBytes = standardBytes(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ApprovedManifest;
  const flat = manifest.entries.find((entry) => entry.fixtureId === "flat-basic");
  assert.ok(flat);

  const unknownRegistry = createSyntheticAdmissionRegistryV1(rawManifestBytes);
  assert.throws(
    () => unknownRegistry.admit({ fixtureId: "unknown-fixture", rawFrame: new Uint8Array() }),
    admissionError("REVISION_UNAVAILABLE"),
  );
  assert.equal(unknownRegistry.size(), 0);
  assert.throws(
    () =>
      unknownRegistry.admit({
        fixtureId: flat.fixtureId,
        rawFrame: standardBytes(flat.relativePath),
        unexpected: true,
      }),
    admissionError("INVALID_REQUEST"),
  );

  const tamperedManifest = rawManifestBytes.slice();
  const manifestTamperIndex = tamperedManifest.byteLength - 2;
  tamperedManifest[manifestTamperIndex] =
    tamperedManifest[manifestTamperIndex]! ^ 1;
  assert.throws(
    () => createSyntheticAdmissionRegistryV1(tamperedManifest),
    admissionError("INTERNAL"),
  );

  const registry = createSyntheticAdmissionRegistryV1(rawManifestBytes);
  const validFrame = standardBytes(flat.relativePath);
  const tamperedFrame = validFrame.slice();
  const frameTamperIndex = tamperedFrame.byteLength - 2;
  tamperedFrame[frameTamperIndex] = tamperedFrame[frameTamperIndex]! ^ 1;
  assert.throws(
    () => registry.admit({ fixtureId: flat.fixtureId, rawFrame: tamperedFrame }),
    admissionError("INTERNAL"),
  );
  assert.equal(registry.size(), 0);
  assert.throws(
    () => registry.resolveByDocument(flat.documentRef),
    admissionError("INTERNAL"),
  );
  assert.throws(
    () => registry.resolveByArtifact(flat.artifactRef),
    admissionError("INTERNAL"),
  );
  assert.throws(
    () => registry.admit({ fixtureId: flat.fixtureId, rawFrame: validFrame }),
    admissionError("INTERNAL"),
  );
  assert.equal(registry.size(), 0);
});

test("P3-A admission snapshots caller bytes and rejects mutation of admitted state", () => {
  const rawManifestBytes = standardBytes(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ApprovedManifest;
  const flat = manifest.entries.find((entry) => entry.fixtureId === "flat-basic");
  assert.ok(flat);
  const registry = createSyntheticAdmissionRegistryV1(rawManifestBytes);
  const callerFrame = standardBytes(flat.relativePath);
  const admitted = registry.admit({ fixtureId: flat.fixtureId, rawFrame: callerFrame });
  const admittedDigest = sha256CanonicalAawJsonV1(admitted.circuitIr);
  callerFrame.fill(0);
  assert.equal(registry.resolveByDocument(flat.documentRef), admitted);
  assert.equal(sha256CanonicalAawJsonV1(admitted.circuitIr), admittedDigest);
  assert.throws(
    () =>
      (admitted.circuitIr.definitions as unknown as unknown[]).push({
        definitionId: "forbidden",
      }),
    TypeError,
  );
  assert.equal(admitted.providerState.dirty, false);
  assert.equal(sha256CanonicalAawJsonV1(admitted.circuitIr), admittedDigest);
});
