import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalizeAawJsonV1,
  sha256CanonicalAawJsonV1,
} from "../packages/schematic-workbench/src/canonical-json";
import {
  AGENT_CANONICAL_PAYLOAD_MAX_BYTES_V1,
  AGENT_SOURCE_FRAME_MAX_BYTES_V1,
  decodeAgentSourceEventFrameV1,
  enforceAgentCanonicalPayloadBudgetV1,
  StrictAgentFrameError,
} from "../packages/agent-adapters/src/strict-agent-frame";
import {
  decodeAndHashStrictSourceFrameV1,
  StrictSourceFrameError,
} from "../packages/schematic-workbench/src/strict-source-frame";

const encoder = new TextEncoder();

function payloadSha256(payloadText: string): string {
  return `sha256:${createHash("sha256").update(payloadText, "utf8").digest("hex")}`;
}

function sourceFrameFromCanonicalPayload(
  payloadText: string,
  sourceEventId = "synthetic.event.boundary",
): Uint8Array {
  const text =
    `{"sourceSchemaVersion":"aaw.agent.source-event/v1alpha1",` +
    `"sourceCanonicalizationVersion":"aaw-json-c14n/v1",` +
    `"sourceRunId":"synthetic.run.boundary",` +
    `"sourceEventId":"${sourceEventId}",` +
    `"sourceSequence":1,` +
    `"sourcePayloadDigest":"${payloadSha256(payloadText)}",` +
    `"type":"message.delta",` +
    `"payload":${payloadText}}`;
  return encoder.encode(text);
}

function exactAgentFrame(targetBytes: number): Uint8Array {
  const base = sourceFrameFromCanonicalPayload(
    `{"text":"${"x".repeat(4_096)}"}`,
  );
  assert.ok(base.byteLength <= targetBytes);
  const frame = new Uint8Array(targetBytes);
  frame.set(base);
  frame.fill(0x20, base.byteLength);
  return frame;
}

function nestedPayload(arrayDepth: number): string {
  let value = "0";
  for (let index = 0; index < arrayDepth; index += 1) value = `[${value}]`;
  return `{"nest":${value}}`;
}

test("P4-A Agent raw frame closes exactly at 1 MiB before any oversized destination copy", () => {
  const below = exactAgentFrame(AGENT_SOURCE_FRAME_MAX_BYTES_V1 - 1);
  assert.equal(
    decodeAgentSourceEventFrameV1(below).rawByteLength,
    AGENT_SOURCE_FRAME_MAX_BYTES_V1 - 1,
  );
  const exact = exactAgentFrame(AGENT_SOURCE_FRAME_MAX_BYTES_V1);
  const accepted = decodeAgentSourceEventFrameV1(exact);
  assert.equal(accepted.rawByteLength, AGENT_SOURCE_FRAME_MAX_BYTES_V1);

  const oversized = new Uint8Array(AGENT_SOURCE_FRAME_MAX_BYTES_V1 + 1);
  let untrustedGetterReads = 0;
  let observableCopyCalls = 0;
  Object.defineProperty(oversized, "byteLength", {
    configurable: true,
    get() {
      untrustedGetterReads += 1;
      return 1;
    },
  });
  Object.defineProperty(oversized, "buffer", {
    configurable: true,
    get() {
      untrustedGetterReads += 1;
      return new ArrayBuffer(1);
    },
  });
  for (const method of ["slice", "subarray"] as const) {
    Object.defineProperty(oversized, method, {
      configurable: true,
      value() {
        observableCopyCalls += 1;
        throw new Error("untrusted copy method must stay unreachable");
      },
    });
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "Uint8Array");
  assert.ok(original);
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
      ...original,
      value: CountingUint8Array,
    });
    assert.throws(
      () => decodeAgentSourceEventFrameV1(oversized),
      (error: unknown) => {
        assert.ok(error instanceof StrictAgentFrameError);
        assert.equal(error.code, "MALFORMED_EVENT");
        return true;
      },
    );
    assert.equal(destinationAllocations, 0);
    assert.equal(untrustedGetterReads, 0);
    assert.equal(observableCopyCalls, 0);
  } finally {
    Object.defineProperty(globalThis, "Uint8Array", original);
  }
});

test("P4-A Agent string and nesting budgets accept limit and reject limit plus one", () => {
  const stringBelowLimit = sourceFrameFromCanonicalPayload(
    `{"text":"${"x".repeat(4_095)}"}`,
    "synthetic.event.string-below",
  );
  assert.doesNotThrow(() => decodeAgentSourceEventFrameV1(stringBelowLimit));
  const stringAtLimit = sourceFrameFromCanonicalPayload(
    `{"text":"${"x".repeat(4_096)}"}`,
    "synthetic.event.string-limit",
  );
  assert.doesNotThrow(() => decodeAgentSourceEventFrameV1(stringAtLimit));
  const stringOverLimit = sourceFrameFromCanonicalPayload(
    `{"text":"${"x".repeat(4_097)}"}`,
    "synthetic.event.string-over",
  );
  assert.throws(() => decodeAgentSourceEventFrameV1(stringOverLimit));

  const decodeDepth = (containerDepth: number) =>
    decodeAndHashStrictSourceFrameV1(
      encoder.encode(nestedPayload(containerDepth - 1)),
      {
        allowedTopLevelKeys: ["nest"],
        maxBytes: AGENT_SOURCE_FRAME_MAX_BYTES_V1,
        maxDepth: 64,
        maxStringBytes: 4_096,
      },
    );
  assert.doesNotThrow(() => decodeDepth(63));
  assert.doesNotThrow(() => decodeDepth(64));
  assert.throws(
    () => decodeDepth(65),
    (error: unknown) => error instanceof StrictSourceFrameError,
  );

  assert.doesNotThrow(() =>
    enforceAgentCanonicalPayloadBudgetV1(
      AGENT_CANONICAL_PAYLOAD_MAX_BYTES_V1 - 1,
    ),
  );
  assert.doesNotThrow(() =>
    enforceAgentCanonicalPayloadBudgetV1(AGENT_CANONICAL_PAYLOAD_MAX_BYTES_V1),
  );
  assert.throws(() =>
    enforceAgentCanonicalPayloadBudgetV1(
      AGENT_CANONICAL_PAYLOAD_MAX_BYTES_V1 + 1,
    ),
  );
});

test("P4-A raw ambiguity corpus rejects unsafe integer, prototype key and raw control", () => {
  const rawFrames = [
    '{"n":9007199254740992}',
    '{"__proto__":{}}',
    '{"s":"\u0000"}'.replace("\\u0000", "\u0000"),
    '{"n":-0.0}',
    '{"n":-0e0}',
  ];
  for (const raw of rawFrames) {
    assert.throws(
      () => decodeAgentSourceEventFrameV1(encoder.encode(raw)),
      (error: unknown) => {
        assert.ok(error instanceof StrictAgentFrameError);
        assert.equal(error.code, "MALFORMED_EVENT");
        return true;
      },
      raw,
    );
  }
});

test("P4-A canonical bytes use UTF-16 order, preserve normalization and hash the full tail", () => {
  assert.equal(
    canonicalizeAawJsonV1({ "": 2, "😀": 1, a: 3 }),
    '{"a":3,"😀":1,"":2}',
  );
  const composed = { text: "é" };
  const decomposed = { text: "e\u0301" };
  assert.notEqual(
    canonicalizeAawJsonV1(composed),
    canonicalizeAawJsonV1(decomposed),
  );
  assert.notEqual(
    sha256CanonicalAawJsonV1({ prefix: "same", tail: "A" }),
    sha256CanonicalAawJsonV1({ prefix: "same", tail: "B" }),
  );
  assert.equal(
    sha256CanonicalAawJsonV1({ b: 2, a: 1 }),
    "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
  );
});
