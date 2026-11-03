import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AGENT_CANONICALIZATION_VERSION_V1,
  AGENT_CONTRACT_VERSION_V1,
  AGENT_ERROR_CODES_V1,
  AGENT_WARNING_CODES_V1,
  AgentContractError,
  LEGAL_RETRY_RECOVERY_PAIRS_V1,
  parseCitationLocatorV1,
  parseCitationSourceV1,
  type AgentContractErrorCodeV1,
} from "../packages/agent-adapters/src/agent-contract";
import {
  decodeAgentSourceEventFrameV1,
  StrictAgentFrameError,
  type StrictAgentFrameErrorCodeV1,
} from "../packages/agent-adapters/src/strict-agent-frame";

const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function payloadDigest(payload: unknown): string {
  return sha256(encoder.encode(JSON.stringify(payload)));
}

function validSourceEvent(): Record<string, unknown> {
  const payload = { text: "synthetic hello" };
  return {
    sourceSchemaVersion: "aaw.agent.source-event/v1alpha1",
    sourceCanonicalizationVersion: "aaw-json-c14n/v1",
    sourceRunId: "synthetic.run.1",
    sourceEventId: "synthetic.event.1",
    sourceSequence: 1,
    sourcePayloadDigest: payloadDigest(payload),
    sourceOccurredAt: "2026-09-02T00:00:00Z",
    type: "message.delta",
    payload,
  };
}

function contractError(
  code: AgentContractErrorCodeV1,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AgentContractError);
    assert.equal(error.code, code);
    return true;
  };
}

function frameError(
  code: StrictAgentFrameErrorCodeV1,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof StrictAgentFrameError);
    assert.equal(error.code, code);
    return true;
  };
}

test("P4-A freezes the public error, warning and retry/recovery surface", () => {
  assert.equal(AGENT_CONTRACT_VERSION_V1, "aaw.agent/v1alpha1");
  assert.equal(AGENT_CANONICALIZATION_VERSION_V1, "aaw-json-c14n/v1");
  assert.deepEqual(AGENT_ERROR_CODES_V1, [
    "INVALID_REQUEST",
    "PROTOCOL_MISMATCH",
    "CAPABILITY_DENIED",
    "NOT_CONFIGURED",
    "ADAPTER_UNAVAILABLE",
    "UPSTREAM_TIMEOUT",
    "RATE_LIMITED",
    "STREAM_INTERRUPTED",
    "EVENT_GAP",
    "MALFORMED_EVENT",
    "CANCELLATION_TIMEOUT",
    "TOOL_DENIED",
    "TOOL_FAILED",
    "RECOVERY_UNSUPPORTED",
    "REVISION_UNAVAILABLE",
    "INTERNAL",
  ]);
  assert.deepEqual(AGENT_WARNING_CODES_V1, ["SOURCE_TIME_INVALID"]);
  assert.deepEqual(LEGAL_RETRY_RECOVERY_PAIRS_V1, [
    ["never", "none"],
    ["never", "reconfigure"],
    ["never", "start_new_run"],
    ["safe_resume", "resume_from_cursor"],
    ["safe_same_request", "retry_same_request"],
  ]);
});

test("P4-A SourceEvent has one exact closed top-level shape", () => {
  const parsed = decodeAgentSourceEventFrameV1(
    encoder.encode(JSON.stringify(validSourceEvent())),
  ).event;
  assert.equal(parsed.sourceRunId, "synthetic.run.1");
  assert.equal(parsed.sourceEventId, "synthetic.event.1");
  assert.equal(parsed.sourceSequence, 1);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.payload));

  for (const forbidden of [
    "hostRunId",
    "eventId",
    "hostSequence",
    "acceptedAt",
    "canonicalPayloadDigest",
    "adapterInstanceId",
    "resumeEpoch",
    "retryability",
    "recoveryAction",
    "workspaceId",
    "resolverToken",
    "path",
  ]) {
    assert.throws(
      () =>
        decodeAgentSourceEventFrameV1(
          encoder.encode(
            JSON.stringify({ ...validSourceEvent(), [forbidden]: "x" }),
          ),
        ),
      frameError("MALFORMED_EVENT"),
      forbidden,
    );
  }
});

test("P4-A strict source ingress accepts bytes and rejects duplicate/BOM/negative-zero evidence", () => {
  const validBytes = encoder.encode(JSON.stringify(validSourceEvent()));
  const accepted = decodeAgentSourceEventFrameV1(validBytes);
  assert.equal(accepted.event.sourceEventId, "synthetic.event.1");
  assert.equal(
    accepted.recomputedSourcePayloadDigest,
    validSourceEvent().sourcePayloadDigest,
  );
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.event));

  assert.throws(
    () =>
      decodeAgentSourceEventFrameV1(
        Uint8Array.from([0xef, 0xbb, 0xbf, ...validBytes]),
      ),
    frameError("MALFORMED_EVENT"),
  );

  const duplicate = encoder.encode(
    '{"sourceSchemaVersion":"a","sourceSchemaVersion":"b"}',
  );
  assert.throws(
    () => decodeAgentSourceEventFrameV1(duplicate),
    frameError("MALFORMED_EVENT"),
  );

  const negativeZero = encoder.encode(
    JSON.stringify(validSourceEvent()).replace('"sourceSequence":1', '"sourceSequence":-0'),
  );
  assert.throws(
    () => decodeAgentSourceEventFrameV1(negativeZero),
    frameError("MALFORMED_EVENT"),
  );
});

test("P4-A citation source and locator unions remain closed and revision exact", () => {
  const source = parseCitationSourceV1({
    sourceKind: "rag_source",
    corpusId: "synthetic.corpus",
    sourceId: "synthetic.source",
    sourceRevisionId: "rev-1",
  });
  const locator = parseCitationLocatorV1(source, {
    locatorKind: "rag_chunk",
    chunkId: "chunk-1",
    span: {
      coordinateSystem: "unicode_code_point",
      start: 0,
      end: 4,
    },
  });
  assert.ok(Object.isFrozen(source));
  assert.ok(Object.isFrozen(locator));

  assert.throws(
    () =>
      parseCitationLocatorV1(
        {
          sourceKind: "artifact",
          artifactId: "artifact-1",
          revisionId: "rev-1",
        },
        { locatorKind: "schematic_element" },
      ),
    contractError("INVALID_REQUEST"),
  );
});
