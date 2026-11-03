import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AGENT_SOURCE_EVENT_TYPES_V1,
  AGENT_WARNING_MESSAGES_V1,
  AgentContractError,
} from "../packages/agent-adapters/src/agent-contract";
import {
  STRICT_UTC_TIMESTAMP_PATTERN_SOURCE_V1,
  canonicalWarningAnnouncementKeysV1,
  isStrictUtcTimestampV1,
  parseCanonicalEventV1,
  parseRetryRecoveryFactsV1,
  parseSourceCanonicalMappingV1,
  parseToolTransitionV1,
  reduceRetryRecoveryV1,
  type RetryRecoveryFactsV1,
} from "../packages/agent-adapters/src/canonical-contract";
import {
  evaluateConformanceStageV1,
  parseConformanceResultReceiptV1,
  parseConformanceTraceabilityManifestV1,
} from "../packages/agent-adapters/src/conformance";
import {
  TOOL_STATES_V1,
  TOOL_TRANSITIONS_V1,
  applyToolStateTransitionV1,
  assertResolveErrorOrderV1,
  createCitationPreviewV1,
  parseArtifactRefV1,
  parseDocumentRefV1,
  parseResolveArtifactRequestV1,
  parseResolveCitationRequestV1,
  parseResolveDocumentRequestV1,
  parseResolveResultV1,
} from "../packages/agent-adapters/src/public-contract";
import {
  decodeAgentSourceEventFrameV1,
  StrictAgentFrameError,
} from "../packages/agent-adapters/src/strict-agent-frame";
import {
  canonicalizeAawJsonV1,
  sha256CanonicalAawJsonV1,
} from "../packages/schematic-workbench/src/canonical-json";

const encoder = new TextEncoder();

function sourceFrame(payload: unknown, type = "message.delta"): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      sourceSchemaVersion: "aaw.agent.source-event/v1alpha1",
      sourceCanonicalizationVersion: "aaw-json-c14n/v1",
      sourceRunId: "synthetic.run.owner-closure",
      sourceEventId: "synthetic.event.owner-closure",
      sourceSequence: 1,
      sourcePayloadDigest: sha256CanonicalAawJsonV1(payload),
      type,
      payload,
    }),
  );
}

test("P4-A closes event taxonomy and recursively rejects main-owned aliases", () => {
  assert.deepEqual(AGENT_SOURCE_EVENT_TYPES_V1, [
    "message.delta",
    "citation.declared",
    "cancel.acknowledged",
    "run.completed",
    "run.failed",
  ]);
  for (const payload of [
    { text: "safe", nested: { hostRunId: "forged" } },
    { text: "safe", nested: { resolver_token: "forged" } },
    { text: "safe", nested: { path: "forged", grant: "forged" } },
    {
      text: "safe",
      nested: { retryability: "safe_resume", recoveryAction: "resume_from_cursor" },
    },
  ]) {
    assert.throws(
      () => decodeAgentSourceEventFrameV1(sourceFrame(payload)),
      (error: unknown) =>
        error instanceof StrictAgentFrameError && error.code === "MALFORMED_EVENT",
    );
  }
  assert.throws(() =>
    decodeAgentSourceEventFrameV1(sourceFrame({ text: "safe" }, "unknown.event")),
  );
  assert.throws(() =>
    decodeAgentSourceEventFrameV1(
      sourceFrame({ text: "safe" }, `a.${"x".repeat(127)}`),
    ),
  );
});

test("P4-A public identities and resolve requests remain exact-revision and closed", () => {
  assert.deepEqual(
    parseDocumentRefV1({
      documentId: "synthetic.document.notes",
      revisionId: "rev-1",
      documentKind: "text",
    }),
    {
      documentId: "synthetic.document.notes",
      revisionId: "rev-1",
      documentKind: "text",
    },
  );
  assert.equal(
    parseArtifactRefV1({
      artifactId: "synthetic.circuit-ir.flat-basic",
      revisionId: "rev-1",
      artifactKind: "circuit_ir_reviewed",
    }).revisionId,
    "rev-1",
  );
  assert.equal(
    parseArtifactRefV1({
      artifactId: "synthetic.generic-artifact",
      revisionId: "rev-1",
      artifactKind: "generic",
    }).artifactKind,
    "generic",
  );
  assert.throws(() =>
    parseDocumentRefV1({
      documentId: "synthetic.document.notes",
      revisionId: "latest",
      documentKind: "text",
    }),
  );
  assert.throws(() =>
    parseResolveDocumentRequestV1({
      target: {
        documentId: "synthetic.document.notes",
        revisionId: "rev-1",
        documentKind: "text",
      },
      intent: "preview",
      workspaceId: "forged",
    }),
  );
  assert.doesNotThrow(() =>
    parseResolveArtifactRequestV1({
      target: {
        artifactId: "synthetic.circuit-ir.flat-basic",
        revisionId: "rev-1",
        artifactKind: "circuit_ir_reviewed",
      },
      intent: "inspect",
    }),
  );
  assert.doesNotThrow(() =>
    parseResolveCitationRequestV1({
      source: {
        sourceKind: "reviewed_schematic",
        artifactId: "synthetic.circuit-ir.flat-basic",
        revisionId: "rev-1",
      },
      locator: { locatorKind: "whole_source" },
      intent: "preview_source",
    }),
  );
  assert.throws(() =>
    parseResolveCitationRequestV1({
      source: {
        sourceKind: "artifact",
        artifactId: "synthetic.circuit-ir.flat-basic",
        revisionId: "rev-1",
      },
      locator: {
        locatorKind: "schematic_element",
        occurrencePath: [],
        definitionId: "def.root",
        elementKind: "wire",
        elementId: "wire.out",
      },
      intent: "highlight_locator",
    }),
  );
  assert.equal(
    assertResolveErrorOrderV1({
      callerAuthorized: false,
      kindIntegrity: false,
      revisionAvailable: false,
      sourceLocatorValid: false,
      intentAuthorized: false,
      resolutionAvailable: false,
    })?.error.code,
    "CAPABILITY_DENIED",
  );
  assert.equal(
    assertResolveErrorOrderV1({
      callerAuthorized: true,
      kindIntegrity: false,
      revisionAvailable: false,
      sourceLocatorValid: false,
      intentAuthorized: false,
      resolutionAvailable: false,
    })?.error.code,
    "INTERNAL",
  );
  assert.equal(
    assertResolveErrorOrderV1({
      callerAuthorized: true,
      kindIntegrity: true,
      revisionAvailable: false,
      sourceLocatorValid: false,
      intentAuthorized: false,
      resolutionAvailable: false,
    })?.error.code,
    "REVISION_UNAVAILABLE",
  );
  assert.equal(
    assertResolveErrorOrderV1({
      callerAuthorized: true,
      kindIntegrity: true,
      revisionAvailable: true,
      sourceLocatorValid: false,
      intentAuthorized: false,
      resolutionAvailable: false,
    })?.error.code,
    "INVALID_REQUEST",
  );
  assert.equal(
    assertResolveErrorOrderV1({
      callerAuthorized: true,
      kindIntegrity: true,
      revisionAvailable: true,
      sourceLocatorValid: true,
      intentAuthorized: false,
      resolutionAvailable: false,
    })?.error.code,
    "CAPABILITY_DENIED",
  );
  assert.equal(
    assertResolveErrorOrderV1({
      callerAuthorized: true,
      kindIntegrity: true,
      revisionAvailable: true,
      sourceLocatorValid: true,
      intentAuthorized: true,
      resolutionAvailable: false,
    })?.error.code,
    "REVISION_UNAVAILABLE",
  );
  assert.deepEqual(
    parseResolveResultV1({
      ok: false,
      error: {
        code: "CAPABILITY_DENIED",
        message: "Requested resource is unavailable",
        retryability: "never",
        recoveryAction: "none",
      },
    }),
    {
      ok: false,
      error: {
        code: "CAPABILITY_DENIED",
        message: "Requested resource is unavailable",
        retryability: "never",
        recoveryAction: "none",
      },
    },
  );
  assert.throws(() =>
    parseResolveResultV1({
      ok: false,
      error: {
        code: "CAPABILITY_DENIED",
        message: "Requested revision is unavailable",
        retryability: "never",
        recoveryAction: "none",
      },
    }),
  );
});

test("P4-A preview budgets and tool state machine are deterministic and side-effect free", () => {
  const preview = createCitationPreviewV1("😀".repeat(600));
  assert.equal(preview.truncated, true);
  assert.ok(Array.from(preview.text).length <= 512);
  assert.ok(encoder.encode(preview.text).byteLength <= 2_048);
  assert.ok(Object.isFrozen(preview));

  assert.deepEqual(TOOL_STATES_V1, [
    "idle",
    "requested",
    "denied",
    "approved",
    "dispatched",
    "succeeded",
    "failed",
  ]);
  for (const [from, to] of TOOL_TRANSITIONS_V1) {
    assert.equal(
      applyToolStateTransitionV1(from, to).toolBrokerInvocationCount,
      0,
    );
  }
  assert.throws(
    () => applyToolStateTransitionV1("idle", "dispatched"),
    (error: unknown) =>
      error instanceof AgentContractError && error.code === "INVALID_REQUEST",
  );
  assert.throws(() =>
    parseToolTransitionV1({
      from: "idle",
      to: "dispatched",
      toolBrokerInvocationCount: 0,
    }),
  );
});

test("P4-A canonical event, mapping and retry facts have closed runtime validators", () => {
  const citation = {
    citationId: "citation.synthetic.1",
    source: {
      sourceKind: "reviewed_schematic",
      artifactId: "synthetic.circuit-ir.flat-basic",
      revisionId: "rev-1",
    },
    locator: { locatorKind: "whole_source" },
    authorityStatus: "non_authoritative",
    verificationStatus: "verified",
  } as const;
  const event = {
    hostRunId: "host.synthetic.1",
    eventId: "event.synthetic.1",
    hostSequence: 1,
    acceptedAt: "2026-09-02T00:00:01Z",
    canonicalPayloadDigest: sha256CanonicalAawJsonV1(citation),
    type: "citation.declared",
    payload: citation,
  } as const;
  assert.deepEqual(parseCanonicalEventV1(event), event);
  assert.throws(() =>
    parseCanonicalEventV1({
      ...event,
      type: "run.accepted",
    }),
  );
  assert.doesNotThrow(() =>
    parseSourceCanonicalMappingV1({
      adapterInstanceId: "synthetic.adapter.instance",
      resumeEpoch: 1,
      sourceRunId: "source.synthetic.1",
      sourceEventId: "source.event.synthetic.1",
      sourceSequence: 1,
      sourceEventType: "citation.declared",
      sourcePayloadDigest: sha256CanonicalAawJsonV1(citation),
      sourceSchemaVersion: "aaw.agent.source-event/v1alpha1",
      sourceCanonicalizationVersion: "aaw-json-c14n/v1",
      hostRunId: event.hostRunId,
      eventId: event.eventId,
      hostSequence: event.hostSequence,
    }),
  );
  assert.deepEqual(parseRetryRecoveryFactsV1(recoveryFacts()), recoveryFacts());
  assert.throws(() =>
    parseRetryRecoveryFactsV1({ ...recoveryFacts(), cursorCurrentEpoch: "yes" }),
  );
});

test("P4-A canonical acceptedAt uses one strict Gregorian UTC contract", () => {
  for (const valid of [
    "2000-02-29T00:00:00Z",
    "2024-02-29T23:59:59.001Z",
    "2026-09-02T00:00:01Z",
  ]) {
    assert.equal(isStrictUtcTimestampV1(valid), true, valid);
  }
  for (const invalid of [
    "0000-01-01T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-13-02T00:00:00Z",
    "2026-09-02T24:00:00Z",
    "2026-09-02T00:00:60Z",
    "2026-09-02T00:00:00+00:00",
  ]) {
    assert.equal(isStrictUtcTimestampV1(invalid), false, invalid);
  }
  const canonicalSchema = JSON.parse(
    readFileSync(
      "packages/agent-adapters/schemas/agent-canonical-contract.v1alpha1.schema.json",
      "utf8",
    ),
  );
  const conformanceSchema = JSON.parse(
    readFileSync(
      "packages/agent-adapters/schemas/agent-conformance.v1alpha1.schema.json",
      "utf8",
    ),
  );
  const traceabilitySchema = JSON.parse(
    readFileSync(
      "packages/agent-adapters/schemas/agent-conformance-traceability.v1alpha1.schema.json",
      "utf8",
    ),
  );
  assert.equal(
    canonicalSchema.$defs.canonicalEventBase.properties.acceptedAt.pattern,
    STRICT_UTC_TIMESTAMP_PATTERN_SOURCE_V1,
  );
  assert.equal(
    conformanceSchema.$defs.stateExpected.properties.canonicalEvents.items.oneOf[0]
      .properties.acceptedAt.pattern,
    STRICT_UTC_TIMESTAMP_PATTERN_SOURCE_V1,
  );
  assert.equal(
    traceabilitySchema.$defs.ledgerRow.properties.acceptedAt.pattern,
    STRICT_UTC_TIMESTAMP_PATTERN_SOURCE_V1,
  );
});

test("P4-A canonical warning carrier is committed, safe and replay-deduplicable", () => {
  const payload = Object.freeze({ text: "Synthetic warning path." });
  const event = parseCanonicalEventV1({
    hostRunId: "host.synthetic.warning",
    eventId: "event.synthetic.warning.1",
    hostSequence: 1,
    acceptedAt: "2026-09-02T00:00:01Z",
    canonicalPayloadDigest: sha256CanonicalAawJsonV1(payload),
    warningCodes: ["SOURCE_TIME_INVALID"],
    type: "message.delta",
    payload,
  });
  assert.deepEqual(event.warningCodes, ["SOURCE_TIME_INVALID"]);
  assert.equal(
    AGENT_WARNING_MESSAGES_V1.SOURCE_TIME_INVALID,
    "Source timestamp was invalid and was ignored.",
  );
  assert.equal(event.eventId, "event.synthetic.warning.1");
  assert.equal(event.hostSequence, 1);
  assert.deepEqual(canonicalWarningAnnouncementKeysV1(event), [
    "host.synthetic.warning:event.synthetic.warning.1:SOURCE_TIME_INVALID",
  ]);
  assert.deepEqual(
    canonicalWarningAnnouncementKeysV1(parseCanonicalEventV1({ ...event })),
    canonicalWarningAnnouncementKeysV1(event),
  );
  assert.throws(() =>
    parseCanonicalEventV1({ ...event, warningCodes: [] }),
  );
  assert.throws(() =>
    parseCanonicalEventV1({
      ...event,
      warningCodes: ["SOURCE_TIME_INVALID", "SOURCE_TIME_INVALID"],
    }),
  );
  assert.throws(() =>
    parseCanonicalEventV1({ ...event, warningCodes: ["UNSAFE_WARNING"] }),
  );
});

function recoveryFacts(
  override: Partial<RetryRecoveryFactsV1> = {},
): RetryRecoveryFactsV1 {
  return {
    runState: "running",
    errorCode: "UPSTREAM_TIMEOUT",
    reconfigureAuthorized: false,
    policyAllowsNewRun: false,
    noPendingOrUnknownSideEffects: true,
    resumeCapabilityNegotiated: false,
    cursorCurrentEpoch: false,
    cursorLedgerVerified: false,
    canonicalProgressExists: false,
    sameRequestNotAcceptedOrIdempotent: false,
    ...override,
  };
}

test("P4-A retry/recovery reducer implements the six-rule priority table", () => {
  assert.deepEqual(
    reduceRetryRecoveryV1(recoveryFacts({ runState: "quarantined" })),
    { retryability: "never", recoveryAction: "none", rule: 1 },
  );
  assert.deepEqual(
    reduceRetryRecoveryV1(
      recoveryFacts({ errorCode: "NOT_CONFIGURED", reconfigureAuthorized: true }),
    ),
    { retryability: "never", recoveryAction: "reconfigure", rule: 2 },
  );
  assert.equal(
    reduceRetryRecoveryV1(
      recoveryFacts({
        errorCode: "EVENT_GAP",
        policyAllowsNewRun: true,
      }),
    ).rule,
    3,
  );
  assert.equal(
    reduceRetryRecoveryV1(
      recoveryFacts({
        resumeCapabilityNegotiated: true,
        cursorCurrentEpoch: true,
        cursorLedgerVerified: true,
        canonicalProgressExists: true,
        sameRequestNotAcceptedOrIdempotent: true,
      }),
    ).rule,
    4,
  );
  assert.equal(
    reduceRetryRecoveryV1(
      recoveryFacts({ sameRequestNotAcceptedOrIdempotent: true }),
    ).rule,
    5,
  );
  assert.equal(
    reduceRetryRecoveryV1(
      recoveryFacts({
        noPendingOrUnknownSideEffects: false,
        sameRequestNotAcceptedOrIdempotent: true,
      }),
    ).rule,
    6,
  );
});

test("P4-A traceability resolves every seed and records every vector result", () => {
  const manifest = parseConformanceTraceabilityManifestV1(
    JSON.parse(
      readFileSync(
        "packages/agent-adapters/fixtures/n01-n30.traceability.json",
        "utf8",
      ),
    ),
  );
  const receipt = parseConformanceResultReceiptV1(
    manifest,
    JSON.parse(
      readFileSync(
        "packages/agent-adapters/fixtures/p4a-conformance-results.json",
        "utf8",
      ),
    ),
  );
  assert.equal(receipt.results.length, manifest.vectors.length);
  assert.ok(manifest.vectors.some((vector) => vector.harness === "electron_boundary"));
  assert.ok(
    receipt.results
      .filter((result) => result.requiredStage !== "P4-A")
      .every((result) => result.status === "NOT_RUN"),
  );
  assert.deepEqual(evaluateConformanceStageV1("P4-A", manifest, receipt), {
    status: "PASS",
    blockers: [],
  });
  const n25Fixtures = manifest.stateFixtures.filter((fixture) =>
    [
      "synthetic-authorized-caller",
      "synthetic-wrong-caller",
      "synthetic-kind-corruption",
      "synthetic-historical-revision",
    ].includes(
      fixture.fixtureId,
    ),
  );
  assert.equal(n25Fixtures.length, 4);
  assert.deepEqual(
    new Set(n25Fixtures.map((fixture) => fixture.binding.callerScope)),
    new Set(["authorized", "unauthorized"]),
  );
  assert.equal(
    n25Fixtures.find((fixture) => fixture.fixtureId === "synthetic-historical-revision")
      ?.binding.revisionFreshness,
    "historical",
  );
  const kindCorruptionFixture = n25Fixtures.find(
    (fixture) => fixture.fixtureId === "synthetic-kind-corruption",
  );
  assert.equal(kindCorruptionFixture?.binding.callerScope, "authorized");
  assert.equal(kindCorruptionFixture?.binding.revisionAvailable, false);
  assert.equal(kindCorruptionFixture?.binding.artifactRevisionId, "rev-unavailable");
  const n25Desktop = manifest.vectors.filter(
    (vector) => vector.oracleId === "N25" && vector.harness === "desktop_boundary",
  );
  assert.equal(n25Desktop.length, 6);
  assert.equal(
    n25Desktop.find((vector) => vector.id === "N25-authorized-kind-corruption")
      ?.expected.errorCode,
    "INTERNAL",
  );
  assert.ok(
    n25Desktop.every((vector) => {
      const step = vector.steps?.[0] as Record<string, unknown> | undefined;
      return (
        ["resolveArtifact", "resolveCitation"].includes(String(step?.api)) &&
        typeof step?.request === "object"
      );
    }),
  );
  const invalidLocatorFixture = manifest.stateFixtures.find(
    (fixture) =>
      fixture.fixtureId === "synthetic-invalid-locator-and-denied-intent",
  );
  const deniedIntentFixture = manifest.stateFixtures.find(
    (fixture) => fixture.fixtureId === "synthetic-valid-locator-denied-intent",
  );
  assert.equal(invalidLocatorFixture?.binding.sourceLocatorValid, false);
  assert.equal(invalidLocatorFixture?.binding.intentAuthorized, false);
  assert.equal(deniedIntentFixture?.binding.sourceLocatorValid, true);
  assert.equal(deniedIntentFixture?.binding.intentAuthorized, false);
  const invalidTimeVector = manifest.vectors.find(
    (vector) => vector.id === "N17-invalid-semantic-time-warning",
  );
  assert.ok(invalidTimeVector);
  const invalidTimeExpected = invalidTimeVector.expected as unknown as {
    readonly warningCodes: readonly string[];
    readonly canonicalEvents: readonly { readonly canonicalUtf8Hex: string }[];
    readonly ledgerDelta: number;
    readonly rendererEmissions: number;
  };
  const approvedFixtureManifest = JSON.parse(
    readFileSync(
      "packages/agent-adapters/fixtures/approved-synthetic-agent-fixtures.manifest.json",
      "utf8",
    ),
  ) as {
    readonly entries: readonly {
      readonly fixtureId: string;
      readonly scenarioKind: string;
      readonly path: string;
      readonly sourceRunId: string;
      readonly sourceEventId: string;
      readonly sourceSequence: number;
      readonly canonicalPayloadSha256: string;
    }[];
  };
  const approvedInvalidTimeEntries = approvedFixtureManifest.entries.filter(
    (entry) => entry.scenarioKind === "invalid_source_time_warning",
  );
  assert.equal(approvedInvalidTimeEntries.length, 1);
  const approvedInvalidTimeEntry = approvedInvalidTimeEntries[0];
  assert.ok(approvedInvalidTimeEntry);
  const admittedInvalidTime = decodeAgentSourceEventFrameV1(
    Uint8Array.from(readFileSync(approvedInvalidTimeEntry.path)),
  ).event;
  const invalidTimeStep = invalidTimeVector.steps?.[0] as
    | { readonly sourceSequence?: number; readonly sourceEventId?: string }
    | undefined;
  assert.ok(invalidTimeStep);
  const invalidTimeFixture = manifest.stateFixtures.find(
    (fixture) => fixture.fixtureId === "synthetic-invalid-time",
  );
  assert.ok(invalidTimeFixture);
  assert.deepEqual(invalidTimeExpected.warningCodes, [
    "SOURCE_TIME_INVALID",
  ]);
  assert.equal(invalidTimeExpected.canonicalEvents.length, 1);
  const invalidTimeOracle = invalidTimeExpected.canonicalEvents[0];
  assert.ok(invalidTimeOracle);
  const invalidTimeEvent = parseCanonicalEventV1(
    JSON.parse(
      Buffer.from(invalidTimeOracle.canonicalUtf8Hex, "hex").toString("utf8"),
    ),
  );
  assert.deepEqual(invalidTimeEvent.warningCodes, ["SOURCE_TIME_INVALID"]);
  assert.equal(invalidTimeFixture?.binding.sourceRunId, approvedInvalidTimeEntry.sourceRunId);
  assert.equal(invalidTimeStep.sourceEventId, approvedInvalidTimeEntry.sourceEventId);
  assert.equal(invalidTimeStep.sourceSequence, approvedInvalidTimeEntry.sourceSequence);
  assert.equal(admittedInvalidTime.sourceRunId, approvedInvalidTimeEntry.sourceRunId);
  assert.equal(admittedInvalidTime.sourceEventId, approvedInvalidTimeEntry.sourceEventId);
  assert.equal(admittedInvalidTime.sourceSequence, approvedInvalidTimeEntry.sourceSequence);
  assert.deepEqual(invalidTimeEvent.payload, admittedInvalidTime.payload);
  assert.equal(
    invalidTimeEvent.canonicalPayloadDigest,
    approvedInvalidTimeEntry.canonicalPayloadSha256,
  );
  assert.equal(invalidTimeEvent.canonicalPayloadDigest, admittedInvalidTime.sourcePayloadDigest);
  assert.equal(
    Buffer.from(invalidTimeOracle.canonicalUtf8Hex, "hex")
      .toString("utf8")
      .includes("not-a-time"),
    false,
  );
  assert.deepEqual(canonicalWarningAnnouncementKeysV1(invalidTimeEvent), [
    `${invalidTimeEvent.hostRunId}:${invalidTimeEvent.eventId}:SOURCE_TIME_INVALID`,
  ]);
  assert.equal(invalidTimeExpected.ledgerDelta, 1);
  assert.equal(invalidTimeExpected.rendererEmissions, 1);
  assert.equal(
    invalidTimeFixture?.ledger.filter((row) => row.eventId === invalidTimeEvent.eventId)
      .length,
    0,
  );
  const budgetVectors = manifest.vectors.filter((vector) =>
    vector.id.startsWith("N30-budget-"),
  );
  assert.equal(budgetVectors.length, 13 * 3);

  const tampered = JSON.parse(
    readFileSync(
      "packages/agent-adapters/fixtures/n01-n30.traceability.json",
      "utf8",
    ),
  ) as {
    stateFixtures: { ledger: { eventId: string }[] }[];
  };
  const ledgerFixture = tampered.stateFixtures.find(
    (fixture) => fixture.ledger.length > 0,
  );
  assert.ok(ledgerFixture);
  ledgerFixture.ledger[0]!.eventId = "event.tampered";
  assert.throws(() => parseConformanceTraceabilityManifestV1(tampered));

  for (const mutation of ["type-payload", "accepted-at"] as const) {
    const closedParserTamper = JSON.parse(
      readFileSync(
        "packages/agent-adapters/fixtures/n01-n30.traceability.json",
        "utf8",
      ),
    ) as {
      stateFixtures: {
        ledger: {
          type: string;
          acceptedAt: string;
          canonicalUtf8Hex: string;
        }[];
      }[];
    };
    const fixture = closedParserTamper.stateFixtures.find(
      (entry) => entry.ledger.length > 0,
    );
    assert.ok(fixture);
    const row = fixture.ledger[0]!;
    const event = JSON.parse(
      Buffer.from(row.canonicalUtf8Hex, "hex").toString("utf8"),
    ) as Record<string, unknown>;
    if (mutation === "type-payload") {
      row.type = "run.completed";
      event.type = "run.completed";
    } else {
      row.acceptedAt = "2026-13-02T00:00:00Z";
      event.acceptedAt = row.acceptedAt;
    }
    row.canonicalUtf8Hex = Buffer.from(
      canonicalizeAawJsonV1(event),
      "utf8",
    ).toString("hex");
    assert.throws(
      () => parseConformanceTraceabilityManifestV1(closedParserTamper),
      mutation,
    );
  }
});

test("P4-A addendum freezes the required P4-B cancel, recovery and replay vectors", () => {
  const rawManifest = JSON.parse(
    readFileSync(
      "packages/agent-adapters/fixtures/n01-n30.traceability.json",
      "utf8",
    ),
  );
  const manifest = parseConformanceTraceabilityManifestV1(rawManifest);
  const receipt = parseConformanceResultReceiptV1(
    manifest,
    JSON.parse(
      readFileSync(
        "packages/agent-adapters/fixtures/p4a-conformance-results.json",
        "utf8",
      ),
    ),
  );
  const required = [
    "N18-host-replay-after-zero",
    "N18-host-replay-omitted-after-zero",
    "N18-host-replay-head-nonterminal-wait",
    "N18-host-replay-head-terminal-end",
    "N18-host-replay-future-after-invalid",
    "N18-host-replay-retention-gap-start-new-run",
    "N18-host-replay-retention-gap-recovery-unsupported",
    "N18-host-replay-quarantined-zero",
    "N18-host-replay-snapshot-tail-exactly-once",
    "N19-cancel-before-commit-restart",
    "N20-cancel-after-commit-before-ack-restart",
    "N21-mapping-only-corruption-quarantine",
    "N21-event-only-corruption-quarantine",
    "N21-checkpoint-only-corruption-quarantine",
    "N21-ack-before-commit-corruption-quarantine",
    "N28-cancel-before-stream",
    "N28-cancel-during-delta",
    "N28-cancel-repeated-idempotent",
    "N28-cancel-ack-terminal-once",
    "N28-cancel-after-terminal-noop",
    "N28-cancel-timeout-late-event-isolated",
    "N28-monotonic-deadline-metamorphic",
  ] as const;
  const byId = new Map(manifest.vectors.map((vector) => [vector.id, vector]));
  const resultById = new Map(
    receipt.results.map((result) => [result.vectorId, result]),
  );
  for (const id of required) {
    const vector = byId.get(id);
    assert.ok(vector, `${id} must be frozen before P4-B entry`);
    assert.equal(vector.requiredStage, "P4-B", id);
    assert.equal(
      vector.harness,
      /^N(?:19|20|21)-/u.test(id) ? "ledger_recovery" : "reducer",
      id,
    );
    assert.equal(resultById.get(id)?.status, "NOT_RUN", id);
  }

  const explicitZero = byId.get("N18-host-replay-after-zero")!;
  const omittedZero = byId.get("N18-host-replay-omitted-after-zero")!;
  const rawById = new Map(
    (rawManifest.vectors as Record<string, unknown>[]).map((vector) => [
      String(vector.id),
      vector,
    ]),
  );
  assert.deepEqual(omittedZero.preState, explicitZero.preState);
  assert.deepEqual(omittedZero.expected, explicitZero.expected);
  assert.deepEqual(
    rawById.get("N18-host-replay-omitted-after-zero")?.steps,
    [{ action: "subscribe-replay" }],
  );
  assert.deepEqual(omittedZero.steps, explicitZero.steps);
  assert.deepEqual(explicitZero.steps, [
    { action: "subscribe-replay", afterHostSequence: 0 },
  ]);

  for (const vector of manifest.vectors) {
    for (const step of vector.steps ?? []) {
      assert.ok(
        typeof step === "object" && step !== null && !Array.isArray(step),
        `${vector.id}: step must be a non-null object`,
      );
      const stepRecord = step as Readonly<Record<string, unknown>>;
      assert.equal(
        typeof stepRecord.action,
        "string",
        `${vector.id}: step action must be a string`,
      );
      const requiresMonotonicMs = [
        "request-cancel",
        "advance-monotonic-clock",
        "fire-cancel-timeout",
      ].includes(stepRecord.action as string);
      assert.equal(
        "monotonicMs" in stepRecord,
        requiresMonotonicMs,
        `${vector.id}/${String(stepRecord.action)} monotonicMs discriminator`,
      );
      if (requiresMonotonicMs) {
        assert.ok(
          typeof stepRecord.monotonicMs === "number" &&
            Number.isSafeInteger(stepRecord.monotonicMs) &&
            stepRecord.monotonicMs >= 0,
          `${vector.id}/${String(stepRecord.action)} monotonicMs`,
        );
      }
    }
  }

  const cancelActions = new Set([
    "request-cancel",
    "advance-monotonic-clock",
    "fire-cancel-timeout",
    "submit-cancel-ack",
    "submit-late-after-cancel",
  ]);
  for (const vector of manifest.vectors) {
    const actions = new Set(
      (vector.steps ?? []).map((step) =>
        typeof step === "object" && step !== null && "action" in step
          ? String(step.action)
          : "",
      ),
    );
    const expected = vector.expected as Readonly<Record<string, unknown>>;
    const cancelFamily = [...actions].some((action) => cancelActions.has(action));
    assert.equal(
      "cancelDispatchDelta" in expected,
      cancelFamily,
      `${vector.id}: cancelDispatchDelta family closure`,
    );
    assert.equal(
      "postRunLifecycle" in expected,
      cancelFamily,
      `${vector.id}: postRunLifecycle family closure`,
    );

    const checkpointFamily =
      vector.harness === "ledger_recovery" ||
      actions.has("commit-live-tail") ||
      actions.has("submit-cancel-ack");
    for (const field of [
      "checkpointDelta",
      "ackPersistDelta",
      "checkpointRows",
      "ackRows",
    ]) {
      assert.equal(
        field in expected,
        checkpointFamily,
        `${vector.id}: ${field} family closure`,
      );
    }
    if (checkpointFamily) {
      const checkpointDelta = expected.checkpointDelta;
      const ackPersistDelta = expected.ackPersistDelta;
      const checkpointRows = expected.checkpointRows;
      const ackRows = expected.ackRows;
      assert.ok(
        typeof checkpointDelta === "number" &&
          Number.isSafeInteger(checkpointDelta) &&
          checkpointDelta >= 0,
        `${vector.id}: checkpointDelta`,
      );
      assert.ok(
        typeof ackPersistDelta === "number" &&
          Number.isSafeInteger(ackPersistDelta) &&
          ackPersistDelta >= 0,
        `${vector.id}: ackPersistDelta`,
      );
      assert.ok(Array.isArray(checkpointRows), `${vector.id}: checkpointRows`);
      assert.ok(Array.isArray(ackRows), `${vector.id}: ackRows`);
      assert.equal(
        checkpointRows.length,
        checkpointDelta,
        `${vector.id}: checkpointRows exact delta including zero`,
      );
      assert.equal(
        ackRows.length,
        ackPersistDelta,
        `${vector.id}: ackRows exact delta including zero`,
      );
    }

    if (actions.has("request-cancel") && expected.cancelDispatchDelta === 1) {
      assert.deepEqual(
        {
          postCancelCommandId: expected.postCancelCommandId,
          postCancelDeadlineMonotonicMs:
            expected.postCancelDeadlineMonotonicMs,
          postCancelDispatchState: expected.postCancelDispatchState,
        },
        {
          postCancelCommandId: "cancel.synthetic.command.1",
          postCancelDeadlineMonotonicMs: 2000,
          postCancelDispatchState: "dispatched",
        },
        `${vector.id}: first cancel dispatch exact post-state`,
      );
    } else {
      for (const field of [
        "postCancelCommandId",
        "postCancelDeadlineMonotonicMs",
        "postCancelDispatchState",
      ]) {
        assert.equal(
          field in expected,
          false,
          `${vector.id}: ${field} forbidden without first dispatch`,
        );
      }
    }
  }

  const monotonicDeadline = byId.get("N28-monotonic-deadline-metamorphic")!;
  assert.deepEqual(monotonicDeadline.preState, {
    fixtureId: "synthetic-cancel-pending",
    hostSequence: 2,
    terminal: false,
    quarantined: false,
  });
  assert.deepEqual(monotonicDeadline.steps, [
    { action: "permute-wall-clock", sourceSequence: 1 },
    { action: "advance-monotonic-clock", monotonicMs: 2001 },
  ]);
  assert.equal(monotonicDeadline.expected.cancelDispatchDelta, 0);
  assert.equal(monotonicDeadline.expected.postRunLifecycle, "quarantined");

  for (const id of required.filter((value) => value.startsWith("N18-"))) {
    const vector = byId.get(id)!;
    const expected = vector.expected as unknown as {
      readonly deliveryHostSequences: readonly number[];
      readonly subscriptionDisposition: "wait" | "end" | "reject" | "closed";
      readonly canonicalEvents: readonly Record<string, unknown>[];
      readonly checkpointDelta: number;
      readonly ackPersistDelta: number;
      readonly checkpointRows: readonly Record<string, unknown>[];
      readonly ackRows: readonly Record<string, unknown>[];
    };
    assert.ok(Array.isArray(expected.deliveryHostSequences), id);
    assert.ok(
      ["wait", "end", "reject", "closed"].includes(
        expected.subscriptionDisposition,
      ),
      id,
    );
    const fixture = manifest.stateFixtures.find(
      (entry) => entry.fixtureId === vector.preState?.fixtureId,
    ) as unknown as
      | {
          readonly run: {
            readonly committedHead: number;
            readonly retentionFloor: number;
            readonly snapshotHead?: number;
            readonly tailRegisteredAfter?: number;
          };
        }
      | undefined;
    assert.ok(fixture, id);
    assert.ok(Number.isSafeInteger(fixture.run.committedHead), id);
    assert.ok(Number.isSafeInteger(fixture.run.retentionFloor), id);
    if (id === "N18-host-replay-snapshot-tail-exactly-once") {
      assert.ok(Number.isSafeInteger(fixture.run.snapshotHead), id);
      assert.equal(fixture.run.tailRegisteredAfter, fixture.run.snapshotHead, id);
      assert.equal(
        new Set(expected.deliveryHostSequences).size,
        expected.deliveryHostSequences.length,
        id,
      );
      assert.deepEqual(expected.canonicalEvents, [
        {
          type: "message.delta",
          hostRunId: "host.synthetic-cancel-deadline",
          eventId: "event.synthetic-cancel-deadline.3",
          hostSequence: 3,
          acceptedAt: "2026-09-02T00:00:03Z",
          canonicalPayloadDigest:
            "sha256:6b044e18996fb5a05f8ea92f5f83ad1e543ec3742075b51bca438744a69696df",
          canonicalUtf8Hex:
            "7b2261636365707465644174223a22323032362d30392d30325430303a30303a30335a222c2263616e6f6e6963616c5061796c6f6164446967657374223a227368613235363a36623034346531383939366662356130356638656139326635663833616431653534336563333734323037356235316263613433383734346136393639366466222c226576656e744964223a226576656e742e73796e7468657469632d63616e63656c2d646561646c696e652e33222c22686f737452756e4964223a22686f73742e73796e7468657469632d63616e63656c2d646561646c696e65222c22686f737453657175656e6365223a332c227061796c6f6164223a7b2274657874223a2253796e746865746963206c697665207461696c206576656e7420332e227d2c2274797065223a226d6573736167652e64656c7461227d",
        },
      ]);
      const committedRow = {
        hostRunId: "host.synthetic-cancel-deadline",
        eventId: "event.synthetic-cancel-deadline.3",
        hostSequence: 3,
        resumeEpoch: 1,
      };
      assert.equal(expected.checkpointDelta, 1);
      assert.equal(expected.ackPersistDelta, 1);
      assert.deepEqual(expected.checkpointRows, [committedRow]);
      assert.deepEqual(expected.ackRows, [committedRow]);
    }
  }

  for (const id of required.filter((value) => value.startsWith("N28-"))) {
    const expected = byId.get(id)!.expected as unknown as {
      readonly cancelDispatchDelta: number;
    };
    assert.ok(Number.isSafeInteger(expected.cancelDispatchDelta), id);
  }
  assert.equal(
    (byId.get("N28-cancel-repeated-idempotent")!.expected as unknown as {
      cancelDispatchDelta: number;
    }).cancelDispatchDelta,
    0,
  );
  const cancelAckExpected = byId.get("N28-cancel-ack-terminal-once")!
    .expected as unknown as {
    readonly canonicalEvents: readonly Record<string, unknown>[];
    readonly checkpointDelta: number;
    readonly ackPersistDelta: number;
    readonly checkpointRows: readonly Record<string, unknown>[];
    readonly ackRows: readonly Record<string, unknown>[];
  };
  assert.deepEqual(cancelAckExpected.canonicalEvents, [
    {
      type: "run.cancelled",
      hostRunId: "host.synthetic-cancel-deadline",
      eventId: "event.synthetic-cancel-deadline.3",
      hostSequence: 3,
      acceptedAt: "2026-09-02T00:00:05Z",
      canonicalPayloadDigest:
        "sha256:dbaffd47b1f45ab096b8d43930741d72b3002f4dbdcd53365259939252956f9a",
      canonicalUtf8Hex:
        "7b2261636365707465644174223a22323032362d30392d30325430303a30303a30355a222c2263616e6f6e6963616c5061796c6f6164446967657374223a227368613235363a64626166666434376231663435616230393662386434333933303734316437326233303032663464626463643533333635323539393339323532393536663961222c226576656e744964223a226576656e742e73796e7468657469632d63616e63656c2d646561646c696e652e33222c22686f737452756e4964223a22686f73742e73796e7468657469632d63616e63656c2d646561646c696e65222c22686f737453657175656e6365223a332c227061796c6f6164223a7b22726561736f6e223a2263616e63656c6c6564227d2c2274797065223a2272756e2e63616e63656c6c6564227d",
    },
  ]);
  const cancelCommittedRow = {
    hostRunId: "host.synthetic-cancel-deadline",
    eventId: "event.synthetic-cancel-deadline.3",
    hostSequence: 3,
    resumeEpoch: 1,
  };
  assert.equal(cancelAckExpected.checkpointDelta, 1);
  assert.equal(cancelAckExpected.ackPersistDelta, 1);
  assert.deepEqual(cancelAckExpected.checkpointRows, [cancelCommittedRow]);
  assert.deepEqual(cancelAckExpected.ackRows, [cancelCommittedRow]);

  for (const id of [
    "N19-cancel-before-commit-restart",
    "N20-cancel-after-commit-before-ack-restart",
  ] as const) {
    const expected = byId.get(id)!.expected as unknown as {
      readonly checkpointDelta: number;
      readonly ackPersistDelta: number;
    };
    assert.ok(Number.isSafeInteger(expected.checkpointDelta), id);
    assert.ok(Number.isSafeInteger(expected.ackPersistDelta), id);
  }
  const n20Expected = byId.get("N20-cancel-after-commit-before-ack-restart")!
    .expected as unknown as {
    readonly checkpointRows: readonly Record<string, unknown>[];
    readonly ackRows: readonly Record<string, unknown>[];
    readonly checkpointDelta: number;
    readonly ackPersistDelta: number;
  };
  assert.equal(n20Expected.checkpointDelta, 1);
  assert.equal(n20Expected.ackPersistDelta, 0);
  assert.deepEqual(n20Expected.checkpointRows, [
    {
      hostRunId: "host.synthetic-cancel-deadline",
      eventId: "event.synthetic-cancel-deadline.2",
      hostSequence: 2,
      resumeEpoch: 1,
    },
  ]);
  assert.deepEqual(n20Expected.ackRows, []);

  type RecoveryFixture = {
    readonly fixtureId: string;
    readonly binding: Readonly<Record<string, unknown>>;
    readonly run: Readonly<Record<string, unknown>> & {
      readonly ledgerIntegrity: "valid" | "corrupt";
    };
    readonly mappings: readonly (Readonly<Record<string, unknown>> & {
      readonly eventId: string;
    })[];
    readonly ledger: readonly (Readonly<Record<string, unknown>> & {
      readonly eventId: string;
      readonly type: string;
    })[];
    readonly checkpoints: readonly (Readonly<Record<string, unknown>> & {
      readonly eventId: string;
    })[];
    readonly acks: readonly (Readonly<Record<string, unknown>> & {
      readonly eventId: string;
    })[];
  };
  const fixtures = manifest.stateFixtures as unknown as readonly RecoveryFixture[];
  const validBase = fixtures.find(
    (fixture) => fixture.fixtureId === "synthetic-corruption-valid-base",
  );
  assert.ok(validBase, "N21 corruption rows require one frozen common valid base");
  assert.equal(validBase.run.ledgerIntegrity, "valid");
  const corruptionAxis = new Map<string, "mappings" | "ledger" | "checkpoints" | "acks">([
    ["N21-mapping-only-corruption-quarantine", "mappings"],
    ["N21-event-only-corruption-quarantine", "ledger"],
    ["N21-checkpoint-only-corruption-quarantine", "checkpoints"],
    ["N21-ack-before-commit-corruption-quarantine", "acks"],
  ]);
  for (const id of required.filter((value) => value.startsWith("N21-"))) {
    const vector = byId.get(id)!;
    const fixture = fixtures.find(
      (entry) => entry.fixtureId === vector.preState?.fixtureId,
    );
    assert.ok(fixture, id);
    assert.equal(fixture.run.ledgerIntegrity, "corrupt", id);
    assert.ok(Array.isArray(fixture.checkpoints), id);
    assert.ok(Array.isArray(fixture.acks), id);
    assert.equal(vector.expected.quarantineState, "active", id);
    assert.equal(vector.expected.rendererEmissions, 0, id);

    const axis = corruptionAxis.get(id);
    assert.ok(axis, id);
    assert.notDeepEqual(fixture[axis], validBase[axis], `${id}: one corrupt array`);
    const repaired = structuredClone(fixture) as {
      fixtureId: string;
      run: Record<string, unknown>;
      mappings: unknown;
      ledger: unknown;
      checkpoints: unknown;
      acks: unknown;
    };
    repaired.fixtureId = validBase.fixtureId;
    repaired.run.ledgerIntegrity = "valid";
    repaired[axis] = structuredClone(validBase[axis]);
    assert.deepEqual(
      repaired,
      validBase,
      `${id}: fixture must differ from the common valid base on exactly one array plus integrity flag`,
    );

    const mapped = new Set(fixture.mappings.map((row) => row.eventId));
    const committed = new Set(
      fixture.ledger
        .filter((row) => row.type !== "run.accepted")
        .map((row) => row.eventId),
    );
    if (id === "N21-mapping-only-corruption-quarantine") {
      assert.ok([...mapped].some((eventId) => !committed.has(eventId)), id);
    } else if (id === "N21-event-only-corruption-quarantine") {
      assert.ok([...committed].some((eventId) => !mapped.has(eventId)), id);
    } else if (id === "N21-checkpoint-only-corruption-quarantine") {
      assert.ok(
        fixture.checkpoints.some((row) => !committed.has(row.eventId)),
        id,
      );
    } else {
      assert.ok(
        fixture.acks.some(
          (row) =>
            !committed.has(row.eventId) ||
            !fixture.checkpoints.some(
              (checkpoint) => checkpoint.eventId === row.eventId,
            ),
        ),
        id,
      );
    }
  }

  const flagOnlyCorrupt = structuredClone(rawManifest) as {
    stateFixtures: { fixtureId: string; run: { ledgerIntegrity: string } }[];
  };
  const consistent = flagOnlyCorrupt.stateFixtures.find(
    (fixture) => fixture.fixtureId === "synthetic-corruption-valid-base",
  );
  assert.ok(consistent);
  consistent.run.ledgerIntegrity = "corrupt";
  assert.throws(
    () => parseConformanceTraceabilityManifestV1(flagOnlyCorrupt),
    "a flag-only corrupt marker over consistent rows must not manufacture corruption",
  );
});
