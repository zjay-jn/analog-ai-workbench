import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import ts from "typescript";
import { createReviewedIdentityRegistryV1 } from "../packages/document-contract/src/reviewed-identity";
import {
  resolveOccurrenceNetV1,
  ReviewedCircuitIrError,
  validateReviewedCircuitIrV1,
  type ReviewedCircuitIrErrorCode,
} from "../packages/schematic-workbench/src/reviewed-circuit-ir";
import {
  decodeStrictSourceFrameV1,
  StrictSourceFrameError,
  type StrictSourceFrameErrorCode,
} from "../packages/schematic-workbench/src/strict-source-frame";
import { createSyntheticAdmissionRegistryV1 } from "../packages/schematic-workbench/src/synthetic-admission";

const manifestPath =
  "packages/schematic-workbench/fixtures/approved-synthetic-fixtures.manifest.json";

type MutableTerminalMapping = {
  terminalId: string;
  parentNetId: string;
  childPortId: string;
  childNetId: string;
};
type MutableInstance = {
  instanceId: string;
  childDefinitionId?: string;
  blackbox?: boolean;
  bounds?: Record<string, number>;
  terminalMappings?: MutableTerminalMapping[];
};
type MutablePort = {
  portId: string;
  netId?: string;
  x?: number;
  y?: number;
};
type MutablePin = {
  pinId: string;
  instanceId: string;
  terminalId: string;
  netId: string;
  x?: number;
  y?: number;
};
type MutableNet = { netId: string; memberElementIds: string[] };
type MutableLabel = {
  labelId: string;
  text: string;
  x?: number;
  y?: number;
  targetElementId?: string;
};
type MutableDefinition = {
  definitionId: string;
  bounds: Record<string, number>;
  instances: MutableInstance[];
  ports: MutablePort[];
  pins?: MutablePin[];
  nets: MutableNet[];
  wires: Array<Record<string, unknown>>;
  labels: MutableLabel[];
  renderOrder: string[];
};
type MutableCircuitIr = {
  schemaVersion: string;
  canonicalizationVersion: string;
  coordinateUnit: string;
  bounds: Record<string, number>;
  rootDefinitionId: string;
  definitions: MutableDefinition[];
  [key: string]: unknown;
};

function standardBytes(relativePath: string): Uint8Array {
  return Uint8Array.from(readFileSync(relativePath));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readFixture(fixtureId: string): MutableCircuitIr {
  return JSON.parse(
    readFileSync(
      `packages/schematic-workbench/fixtures/${fixtureId}.json`,
      "utf8",
    ),
  ) as MutableCircuitIr;
}

function emptyDefinition(definitionId: string): MutableDefinition {
  return {
    definitionId,
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    instances: [],
    ports: [],
    nets: [],
    wires: [],
    labels: [],
    renderOrder: [],
  };
}

function circuitWithDefinitions(
  definitions: MutableDefinition[],
): MutableCircuitIr {
  return {
    schemaVersion: "aaw.circuit-ir.reviewed/v1alpha1",
    canonicalizationVersion: "aaw-json-c14n/v1",
    coordinateUnit: "synthetic_grid_unit",
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    rootDefinitionId: definitions[0]!.definitionId,
    definitions,
  };
}

function assertPureJsonData(value: unknown, seen = new Set<object>()): void {
  if (value === null) return;
  assert.notEqual(typeof value, "function");
  assert.notEqual(typeof value, "symbol");
  assert.notEqual(typeof value, "bigint");
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  assert.ok(
    prototype === Object.prototype ||
      prototype === null ||
      prototype === Array.prototype,
  );
  for (const key of Reflect.ownKeys(value)) {
    assert.equal(typeof key, "string");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor !== undefined && "value" in descriptor);
    assertPureJsonData(descriptor.value, seen);
  }
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

function strictFrameError(
  code: StrictSourceFrameErrorCode,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof StrictSourceFrameError);
    assert.equal(error.code, code);
    return true;
  };
}

function codeAcceptsIdentity(value: unknown): boolean {
  try {
    createReviewedIdentityRegistryV1().admitBinding(value);
    return true;
  } catch {
    return false;
  }
}

function codeAcceptsIr(value: unknown): boolean {
  try {
    validateReviewedCircuitIrV1(value);
    return true;
  } catch {
    return false;
  }
}

function codeAcceptsManifest(rawFrame: Uint8Array): boolean {
  try {
    createSyntheticAdmissionRegistryV1(rawFrame);
    return true;
  } catch {
    return false;
  }
}

test("P3-A AJV and code agree only on codec-admitted, schema-expressible vectors", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const identitySchema = JSON.parse(
    readFileSync(
      "packages/document-contract/schemas/reviewed-identity.v1.schema.json",
      "utf8",
    ),
  ) as object;
  const irSchema = JSON.parse(
    readFileSync(
      "packages/schematic-workbench/schemas/reviewed-circuit-ir.v1.schema.json",
      "utf8",
    ),
  ) as object;
  const manifestSchema = JSON.parse(
    readFileSync(
      "packages/schematic-workbench/schemas/synthetic-fixture-manifest.v1.schema.json",
      "utf8",
    ),
  ) as object;
  const validateIdentitySchema = ajv.compile(identitySchema);
  const validateIrSchema = ajv.compile(irSchema);
  const validateManifestSchema = ajv.compile(manifestSchema);

  const validBinding = {
    documentRef: {
      documentId: "synthetic.schematic.parity",
      revisionId: "rev-1",
      documentKind: "schematic_reviewed",
    },
    artifactRef: {
      artifactId: "synthetic.circuit-ir.parity",
      revisionId: "rev-1",
      artifactKind: "circuit_ir_reviewed",
    },
    freshness: "current",
  };
  const identityCases: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ["valid", validBinding, true],
    [
      "reserved latest",
      {
        ...cloneJson(validBinding),
        documentRef: { ...validBinding.documentRef, revisionId: "latest" },
      },
      false,
    ],
    [
      "wrong artifact kind",
      {
        ...cloneJson(validBinding),
        artifactRef: { ...validBinding.artifactRef, artifactKind: "candidate" },
      },
      false,
    ],
    ["unknown binding field", { ...cloneJson(validBinding), extra: true }, false],
    ["invalid freshness", { ...cloneJson(validBinding), freshness: "stale" }, false],
  ];
  for (const [label, value, expected] of identityCases) {
    assert.equal(Boolean(validateIdentitySchema(value)), expected, `${label}: schema`);
    assert.equal(codeAcceptsIdentity(value), expected, `${label}: code`);
  }

  const validEmpty = readFixture("empty-minimum");
  const unknownIrField = { ...cloneJson(validEmpty), unexpected: true };
  const wrongIrVersion = {
    ...cloneJson(validEmpty),
    schemaVersion: "aaw.circuit-ir.reviewed/v0",
  };
  const outOfRange = cloneJson(validEmpty);
  outOfRange.bounds.maxX = 1_000_000_001;
  const invalidBlackbox = readFixture("blackbox-child");
  invalidBlackbox.definitions[0]!.instances[0]!.childDefinitionId =
    "definition.forbidden";
  const irCases: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ["valid", validEmpty, true],
    ["unknown field", unknownIrField, false],
    ["wrong version", wrongIrVersion, false],
    ["coordinate above bound", outOfRange, false],
    ["blackbox plus child", invalidBlackbox, false],
  ];
  for (const [label, value, expected] of irCases) {
    assert.equal(Boolean(validateIrSchema(value)), expected, `${label}: schema`);
    assert.equal(codeAcceptsIr(value), expected, `${label}: code`);
  }

  const rawManifest = standardBytes(manifestPath);
  const validManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  const manifestWithUnknown = { ...cloneJson(validManifest), extra: true };
  const manifestWithWrongLicense = cloneJson(validManifest);
  manifestWithWrongLicense.entries[0]!.license = "MIT";
  const manifestWithShortEntries = cloneJson(validManifest);
  manifestWithShortEntries.entries.pop();
  const manifestCases = [
    { label: "valid", value: validManifest, rawFrame: rawManifest, expected: true },
    {
      label: "unknown field",
      value: manifestWithUnknown,
      rawFrame: new TextEncoder().encode(JSON.stringify(manifestWithUnknown)),
      expected: false,
    },
    {
      label: "wrong license",
      value: manifestWithWrongLicense,
      rawFrame: new TextEncoder().encode(JSON.stringify(manifestWithWrongLicense)),
      expected: false,
    },
    {
      label: "wrong entry count",
      value: manifestWithShortEntries,
      rawFrame: new TextEncoder().encode(JSON.stringify(manifestWithShortEntries)),
      expected: false,
    },
  ] as const;
  for (const { label, value, rawFrame, expected } of manifestCases) {
    assert.equal(Boolean(validateManifestSchema(value)), expected, `${label}: schema`);
    assert.equal(codeAcceptsManifest(rawFrame), expected, `${label}: code`);
  }
});

test("P3-A raw resource carriers fail closed while hostile labels remain inert plain text", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validateIrSchema = ajv.compile(
    JSON.parse(
      readFileSync(
        "packages/schematic-workbench/schemas/reviewed-circuit-ir.v1.schema.json",
        "utf8",
      ),
    ) as object,
  );
  const allowedTopLevelKeys = [
    "schemaVersion",
    "canonicalizationVersion",
    "coordinateUnit",
    "bounds",
    "rootDefinitionId",
    "definitions",
  ] as const;
  const rawCarrierCases: ReadonlyArray<readonly [string, string]> = [
    ["rawHtml", '<img src="file:///secret" onerror="fetch(1)">'],
    ["rawSvg", '<svg><foreignObject>unsafe</foreignObject></svg>'],
    ["rawXml", '<?xml version="1.0"?><entity href="file:///secret"/>'],
    ["rawCss", '@import url("https://invalid.example/");'],
    ["uri", "file:///synthetic/forbidden"],
    ["script", "globalThis.fetch('https://invalid.example/')"],
    ["foreignObject", "<body onload=runSimulation()>unsafe</body>"],
    ["command", "spectre synthetic.scs"],
  ];
  for (const [field, controlledText] of rawCarrierCases) {
    const candidate = {
      ...cloneJson(readFixture("empty-minimum")),
      [field]: controlledText,
    };
    const rawFrame = new TextEncoder().encode(JSON.stringify(candidate));
    assert.throws(
      () =>
        decodeStrictSourceFrameV1(rawFrame, {
          allowedTopLevelKeys,
        }),
      strictFrameError("UNKNOWN_TOP_LEVEL_KEY"),
      `${field}: codec`,
    );
    assert.equal(Boolean(validateIrSchema(candidate)), false, `${field}: schema`);
    assert.throws(
      () => validateReviewedCircuitIrV1(candidate),
      circuitError("UNKNOWN_FIELD"),
      `${field}: semantic validator`,
    );
  }

  const hostileLabelText =
    '<script>fetch("https://invalid.example/")</script>' +
    '<svg><foreignObject style="background:url(file:///secret)">' +
    "runSimulation spectre command" +
    "</foreignObject></svg>";
  const hostileLabelIr = readFixture("empty-minimum");
  hostileLabelIr.definitions[0]!.labels.push({
    labelId: "label.hostile-plain-text",
    text: hostileLabelText,
    x: 0,
    y: 0,
  });
  hostileLabelIr.definitions[0]!.renderOrder.push("label.hostile-plain-text");
  assert.equal(Boolean(validateIrSchema(hostileLabelIr)), true);
  const validated = validateReviewedCircuitIrV1(hostileLabelIr);
  assert.equal(validated.definitions[0]!.labels[0]!.text, hostileLabelText);
  assert.equal(Object.isFrozen(validated), true);
  assertPureJsonData(validated);

  const materializedKeys = new Set<string>();
  const collectKeys = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      materializedKeys.add(key);
      collectKeys(child);
    }
  };
  collectKeys(validated);
  for (const forbiddenKey of [
    ...rawCarrierCases.map(([field]) => field),
    "resource",
    "capability",
    "href",
    "src",
  ]) {
    assert.equal(
      materializedKeys.has(forbiddenKey),
      false,
      `label text must not materialize ${forbiddenKey} capability state`,
    );
  }
});

test("P3-A Circuit IR accepts flat and hierarchy fixtures and fails graph ambiguity closed", () => {
  const flat = validateReviewedCircuitIrV1(readFixture("flat-basic"));
  assert.deepEqual(resolveOccurrenceNetV1(flat, [], "net.flat"), {
    definitionId: "definition.flat",
    occurrencePath: [],
    netId: "net.flat",
  });

  const repeated = validateReviewedCircuitIrV1(readFixture("repeated-hierarchy"));
  const left = resolveOccurrenceNetV1(repeated, ["instance.left"], "net.reused");
  const right = resolveOccurrenceNetV1(repeated, ["instance.right"], "net.reused");
  assert.deepEqual(left, {
    definitionId: "definition.child",
    occurrencePath: ["instance.left"],
    netId: "net.reused",
  });
  assert.deepEqual(right, {
    definitionId: "definition.child",
    occurrencePath: ["instance.right"],
    netId: "net.reused",
  });
  assert.notDeepEqual(left.occurrencePath, right.occurrencePath);
  assert.throws(
    () => resolveOccurrenceNetV1(repeated, ["instance.left"], "net.parent"),
    circuitError("NET_UNAVAILABLE"),
  );

  const duplicate = readFixture("flat-basic");
  duplicate.definitions.push(cloneJson(duplicate.definitions[0]!));

  const dangling = readFixture("flat-basic");
  dangling.rootDefinitionId = "definition.missing";

  const cycle = readFixture("repeated-hierarchy");
  const cycleChild = cycle.definitions.find(
    (definition) => definition.definitionId === "definition.child",
  );
  assert.ok(cycleChild);
  cycleChild.instances.push({
    instanceId: "instance.back-to-root",
    childDefinitionId: "definition.root",
  });
  cycleChild.renderOrder.push("instance.back-to-root");

  const phantomTerminal = readFixture("explicit-port-mapping");
  phantomTerminal.definitions[0]!.instances[0]!.terminalMappings![0]!.terminalId =
    "terminal.phantom";

  const missingTerminalMapping = readFixture("explicit-port-mapping");
  missingTerminalMapping.definitions[0]!.instances[0]!.terminalMappings = [];

  const duplicateTerminalMapping = readFixture("explicit-port-mapping");
  duplicateTerminalMapping.definitions[0]!.instances[0]!.terminalMappings!.push(
    cloneJson(
      duplicateTerminalMapping.definitions[0]!.instances[0]!
        .terminalMappings![0]!,
    ),
  );

  const extraParentPinWithoutMapping = readFixture("explicit-port-mapping");
  extraParentPinWithoutMapping.definitions[0]!.pins!.push({
    pinId: "pin.parent-unmapped",
    instanceId: "instance.child",
    terminalId: "terminal.unmapped",
    netId: "net.parent",
    x: 5,
    y: 7,
  });
  extraParentPinWithoutMapping.definitions[0]!.nets[0]!.memberElementIds.push(
    "pin.parent-unmapped",
  );
  extraParentPinWithoutMapping.definitions[0]!.renderOrder.push(
    "pin.parent-unmapped",
  );

  const extraChildPortWithoutMapping = readFixture("explicit-port-mapping");
  extraChildPortWithoutMapping.definitions[1]!.ports.push({
    portId: "port.unmapped",
    netId: "net.child",
    x: 0,
    y: 6,
  });
  extraChildPortWithoutMapping.definitions[1]!.nets[0]!.memberElementIds.push(
    "port.unmapped",
  );
  extraChildPortWithoutMapping.definitions[1]!.renderOrder.push("port.unmapped");

  const wrongChildPort = readFixture("explicit-port-mapping");
  wrongChildPort.definitions[0]!.instances[0]!.terminalMappings![0]!.childPortId =
    "port.missing";

  const wrongChildNet = readFixture("explicit-port-mapping");
  wrongChildNet.definitions[0]!.instances[0]!.terminalMappings![0]!.childNetId =
    "net.missing";

  const wrongParentNet = readFixture("explicit-port-mapping");
  wrongParentNet.definitions[0]!.nets.push({
    netId: "net.other",
    memberElementIds: [],
  });
  wrongParentNet.definitions[0]!.instances[0]!.terminalMappings![0]!.parentNetId =
    "net.other";

  const missingNetMembership = readFixture("same-label-different-net");
  const missingMembershipNet = missingNetMembership.definitions[0]!.nets.find(
    (net) => net.netId === "net.left",
  );
  assert.ok(missingMembershipNet);
  missingMembershipNet.memberElementIds = [];

  const mismatchedNetMembership = readFixture("same-label-different-net");
  const mismatchedMembershipWire =
    mismatchedNetMembership.definitions[0]!.wires.find(
      (wire) => wire.wireId === "wire.left",
    );
  assert.ok(mismatchedMembershipWire);
  mismatchedMembershipWire.netId = "net.right";

  const duplicateNetMembership = readFixture("same-label-different-net");
  const secondMembershipNet = duplicateNetMembership.definitions[0]!.nets.find(
    (net) => net.netId === "net.right",
  );
  assert.ok(secondMembershipNet);
  secondMembershipNet.memberElementIds.push("wire.left");

  const invalidBlackbox = readFixture("blackbox-child");
  invalidBlackbox.definitions[0]!.instances[0]!.childDefinitionId =
    "definition.fake";

  const overBudget = readFixture("unicode-labels");
  overBudget.definitions[0]!.labels[0]!.text = "x".repeat(513);

  const failures: ReadonlyArray<
    readonly [string, MutableCircuitIr, ReviewedCircuitIrErrorCode]
  > = [
    ["duplicate definition", duplicate, "DUPLICATE_ID"],
    ["dangling root", dangling, "DANGLING_REFERENCE"],
    ["hierarchy cycle", cycle, "HIERARCHY_CYCLE"],
    ["missing terminal mapping", missingTerminalMapping, "AMBIGUOUS_MAPPING"],
    ["duplicate terminal mapping", duplicateTerminalMapping, "DUPLICATE_ID"],
    [
      "extra parent pin without mapping",
      extraParentPinWithoutMapping,
      "AMBIGUOUS_MAPPING",
    ],
    [
      "extra child port without mapping",
      extraChildPortWithoutMapping,
      "AMBIGUOUS_MAPPING",
    ],
    ["phantom terminal", phantomTerminal, "DANGLING_REFERENCE"],
    ["wrong parent net", wrongParentNet, "DANGLING_REFERENCE"],
    ["wrong child port", wrongChildPort, "DANGLING_REFERENCE"],
    ["wrong child net", wrongChildNet, "DANGLING_REFERENCE"],
    [
      "net-bearing element missing from matching membership list",
      missingNetMembership,
      "DANGLING_REFERENCE",
    ],
    [
      "declared netId differs from membership net",
      mismatchedNetMembership,
      "AMBIGUOUS_MAPPING",
    ],
    [
      "same element appears in two net membership lists",
      duplicateNetMembership,
      "AMBIGUOUS_MAPPING",
    ],
    ["invalid blackbox child", invalidBlackbox, "INVALID_VALUE"],
    ["label budget", overBudget, "BUDGET_EXCEEDED"],
  ];
  for (const [label, value, code] of failures) {
    assert.throws(
      () => validateReviewedCircuitIrV1(value),
      circuitError(code),
      label,
    );
  }

  const blackbox = validateReviewedCircuitIrV1(readFixture("blackbox-child"));
  assert.throws(
    () => resolveOccurrenceNetV1(blackbox, ["instance.unavailable"], "net.any"),
    circuitError("OCCURRENCE_UNAVAILABLE"),
  );
});

test("P3-A Circuit IR budgets close at limit-1/limit/limit+1", () => {
  const allDefinitions = Array.from({ length: 4_097 }, (_unused, index) =>
    emptyDefinition(`definition.${index}`),
  );
  const definitionBudgetIr = circuitWithDefinitions(allDefinitions);
  for (const count of [4_095, 4_096]) {
    definitionBudgetIr.definitions = allDefinitions.slice(0, count);
    assert.doesNotThrow(
      () => validateReviewedCircuitIrV1(definitionBudgetIr),
      `definitions=${count}`,
    );
  }
  definitionBudgetIr.definitions = allDefinitions;
  assert.throws(
    () => validateReviewedCircuitIrV1(definitionBudgetIr),
    circuitError("BUDGET_EXCEEDED"),
    "definitions=4097",
  );

  const allNets: MutableNet[] = Array.from(
    { length: 50_001 },
    (_unused, index) => ({ netId: `net.${index}`, memberElementIds: [] }),
  );
  const entityDefinition = emptyDefinition("definition.entity-budget");
  const entityBudgetIr = circuitWithDefinitions([entityDefinition]);
  for (const count of [49_999, 50_000]) {
    entityDefinition.nets = allNets.slice(0, count);
    assert.doesNotThrow(
      () => validateReviewedCircuitIrV1(entityBudgetIr),
      `entities=${count}`,
    );
  }
  entityDefinition.nets = allNets;
  assert.throws(
    () => validateReviewedCircuitIrV1(entityBudgetIr),
    circuitError("BUDGET_EXCEEDED"),
    "entities=50001",
  );

  const referenceIds = Array.from(
    { length: 33_333 },
    (_unused, index) => `wire.reference.${index}`,
  );
  const referenceDefinition = emptyDefinition("definition.reference-budget");
  referenceDefinition.nets = [
    { netId: "net.reference", memberElementIds: referenceIds },
  ];
  referenceDefinition.wires = referenceIds.map((wireId) => ({
    wireId,
    netId: "net.reference",
  }));
  referenceDefinition.renderOrder = [...referenceIds];
  const referenceBudgetIr = circuitWithDefinitions([referenceDefinition]);
  assert.doesNotThrow(
    () => validateReviewedCircuitIrV1(referenceBudgetIr),
    "references=99999",
  );
  referenceDefinition.instances.push({
    instanceId: "instance.reference-100000",
    blackbox: true,
  });
  referenceDefinition.renderOrder.push("instance.reference-100000");
  assert.doesNotThrow(
    () => validateReviewedCircuitIrV1(referenceBudgetIr),
    "references=100000",
  );
  referenceDefinition.labels.push({
    labelId: "label.reference-100001",
    text: "synthetic",
  });
  referenceDefinition.renderOrder.push("label.reference-100001");
  assert.throws(
    () => validateReviewedCircuitIrV1(referenceBudgetIr),
    circuitError("BUDGET_EXCEEDED"),
    "references=100001",
  );

  const hierarchyAtDepth = (depth: number): MutableCircuitIr => {
    const definitions = Array.from({ length: depth + 1 }, (_unused, index) => {
      const definition = emptyDefinition(`definition.depth.${index}`);
      definition.nets.push({ netId: "net.local", memberElementIds: [] });
      if (index < depth) {
        definition.instances.push({
          instanceId: `instance.depth.${index}`,
          childDefinitionId: `definition.depth.${index + 1}`,
        });
        definition.renderOrder.push(`instance.depth.${index}`);
      }
      return definition;
    });
    return circuitWithDefinitions(definitions);
  };
  for (const depth of [31, 32]) {
    assert.doesNotThrow(
      () => validateReviewedCircuitIrV1(hierarchyAtDepth(depth)),
      `hierarchy depth=${depth}`,
    );
  }
  assert.throws(
    () => validateReviewedCircuitIrV1(hierarchyAtDepth(33)),
    circuitError("HIERARCHY_DEPTH_EXCEEDED"),
    "hierarchy depth=33",
  );

  const depth32 = validateReviewedCircuitIrV1(hierarchyAtDepth(32));
  const occurrencePath = Array.from(
    { length: 32 },
    (_unused, index) => `instance.depth.${index}`,
  );
  assert.doesNotThrow(() =>
    resolveOccurrenceNetV1(depth32, occurrencePath.slice(0, 31), "net.local"),
  );
  assert.doesNotThrow(() =>
    resolveOccurrenceNetV1(depth32, occurrencePath, "net.local"),
  );
  assert.throws(
    () =>
      resolveOccurrenceNetV1(
        depth32,
        [...occurrencePath, "instance.depth.overflow"],
        "net.local",
      ),
    circuitError("OCCURRENCE_UNAVAILABLE"),
  );

  for (const coordinate of [999_999_999, 1_000_000_000]) {
    const coordinateIr = readFixture("empty-minimum");
    coordinateIr.bounds.maxX = coordinate;
    coordinateIr.definitions[0]!.bounds.maxX = coordinate;
    assert.doesNotThrow(
      () => validateReviewedCircuitIrV1(coordinateIr),
      `coordinate=${coordinate}`,
    );
  }
  const coordinateOver = readFixture("empty-minimum");
  coordinateOver.bounds.maxX = 1_000_000_001;
  coordinateOver.definitions[0]!.bounds.maxX = 1_000_000_001;
  assert.throws(
    () => validateReviewedCircuitIrV1(coordinateOver),
    circuitError("INVALID_VALUE"),
  );

  const semanticStringLimitMinusOne = "界".repeat(1_365);
  const semanticStringAtLimit = `${semanticStringLimitMinusOne}a`;
  const semanticStringOverLimit = `${semanticStringLimitMinusOne}ab`;
  assert.equal(
    new TextEncoder().encode(semanticStringLimitMinusOne).byteLength,
    4_095,
  );
  assert.equal(new TextEncoder().encode(semanticStringAtLimit).byteLength, 4_096);
  assert.ok([...semanticStringAtLimit].length < 4_096);
  for (const coordinateUnit of [
    semanticStringLimitMinusOne,
    semanticStringAtLimit,
  ]) {
    const semanticStringIr = readFixture("empty-minimum");
    semanticStringIr.coordinateUnit = coordinateUnit;
    assert.doesNotThrow(() => validateReviewedCircuitIrV1(semanticStringIr));
  }
  const semanticStringOverIr = readFixture("empty-minimum");
  semanticStringOverIr.coordinateUnit = semanticStringOverLimit;
  assert.throws(
    () => validateReviewedCircuitIrV1(semanticStringOverIr),
    circuitError("BUDGET_EXCEEDED"),
  );

  const labelAtCodePointCount = (count: number): MutableCircuitIr => {
    const value = readFixture("empty-minimum");
    value.definitions[0]!.labels.push({
      labelId: `label.${count}`,
      text: "x".repeat(count),
    });
    value.definitions[0]!.renderOrder.push(`label.${count}`);
    return value;
  };
  for (const count of [511, 512]) {
    assert.doesNotThrow(
      () => validateReviewedCircuitIrV1(labelAtCodePointCount(count)),
      `label code points=${count}`,
    );
  }
  assert.throws(
    () => validateReviewedCircuitIrV1(labelAtCodePointCount(513)),
    circuitError("BUDGET_EXCEEDED"),
  );
});

test("P3-A reachable package closure has no write, network, process, Electron, native or OA/EDA seam", () => {
  const packageRoots = [
    path.resolve("packages/document-contract"),
    path.resolve("packages/schematic-workbench"),
  ];
  const entryFiles = [
    path.resolve("packages/document-contract/src/reviewed-identity.ts"),
    path.resolve("packages/schematic-workbench/src/canonical-json.ts"),
    path.resolve("packages/schematic-workbench/src/reviewed-circuit-ir.ts"),
    path.resolve("packages/schematic-workbench/src/strict-source-frame.ts"),
    path.resolve("packages/schematic-workbench/src/synthetic-admission.ts"),
  ];
  const visited = new Set<string>();
  const allowedExternalImports = new Set(["node:crypto"]);
  const forbiddenExternalImports = /^(?:node:)?(?:fs|child_process|http|https|net|tls|dgram|dns|worker_threads)$|^electron$|\.node$/u;
  const forbiddenFsWriteCalls = new Set([
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "createWriteStream",
    "mkdir",
    "mkdirSync",
    "rename",
    "renameSync",
    "rm",
    "rmSync",
    "unlink",
    "unlinkSync",
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "chmod",
    "chmodSync",
    "chown",
    "chownSync",
    "truncate",
    "truncateSync",
    "symlink",
    "symlinkSync",
    "link",
    "linkSync",
  ]);
  const forbiddenGlobalCalls = new Set([
    "fetch",
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
    "runSimulation",
    "openAccess",
    "oaOpen",
    "virtuoso",
    "spectre",
  ]);
  const forbiddenChildProcessMembers = new Set([
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]);
  const forbiddenOaEdaMembers = new Set([
    "runSimulation",
    "openAccess",
    "oaOpen",
    "virtuoso",
    "spectre",
  ]);
  const forbiddenNetworkConstructors = new Set([
    "WebSocket",
    "XMLHttpRequest",
    "EventSource",
  ]);

  const literalModuleSpecifier = (
    expression: ts.Expression | undefined,
  ): string | undefined =>
    expression !== undefined && ts.isStringLiteralLike(expression)
      ? expression.text
      : undefined;
  const identifierPath = (expression: ts.Expression): string[] | undefined => {
    if (ts.isIdentifier(expression)) return [expression.text];
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    const parent = identifierPath(expression.expression);
    return parent === undefined ? undefined : [...parent, expression.name.text];
  };

  const visit = (absolutePath: string): void => {
    const normalizedPath = path.normalize(absolutePath);
    if (visited.has(normalizedPath)) return;
    visited.add(normalizedPath);
    const source = readFileSync(normalizedPath, "utf8");
    const specifiers = new Set<string>();
    const sourceFile = ts.createSourceFile(
      normalizedPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const recordDynamicModule = (
      call: ts.CallExpression,
      capability: string,
    ): void => {
      const specifier = literalModuleSpecifier(call.arguments[0]);
      assert.ok(
        specifier !== undefined,
        `${normalizedPath}: dynamic ${capability} is forbidden`,
      );
      specifiers.add(specifier);
    };
    const inspectNode = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const specifier = literalModuleSpecifier(node.moduleSpecifier);
        assert.ok(specifier !== undefined, `${normalizedPath}: invalid import`);
        specifiers.add(specifier);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        const specifier = literalModuleSpecifier(node.moduleSpecifier);
        assert.ok(specifier !== undefined, `${normalizedPath}: invalid export`);
        specifiers.add(specifier);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const specifier = literalModuleSpecifier(node.moduleReference.expression);
        assert.ok(specifier !== undefined, `${normalizedPath}: invalid import=`);
        specifiers.add(specifier);
      } else if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (expression.kind === ts.SyntaxKind.ImportKeyword) {
          recordDynamicModule(node, "import()");
        } else if (ts.isIdentifier(expression)) {
          if (expression.text === "require") {
            recordDynamicModule(node, "require()");
          }
          assert.equal(
            forbiddenGlobalCalls.has(expression.text),
            false,
            `${normalizedPath}: forbidden global call ${expression.text}`,
          );
        } else if (ts.isPropertyAccessExpression(expression)) {
          const owner = expression.expression.getText(sourceFile);
          const ownerPath = identifierPath(expression.expression);
          const member = expression.name.text;
          assert.equal(
            forbiddenFsWriteCalls.has(member),
            false,
            `${normalizedPath}: forbidden filesystem write call ${member}`,
          );
          assert.equal(
            ownerPath?.length === 1 &&
              ownerPath[0] === "process" &&
              new Set(["dlopen", "binding", "_linkedBinding"]).has(member),
            false,
            `${normalizedPath}: forbidden native capability process.${member}`,
          );
          if (
            ownerPath?.length === 1 &&
            ownerPath[0] === "process" &&
            member === "getBuiltinModule"
          ) {
            recordDynamicModule(node, "process.getBuiltinModule()");
          }
          if (member === "require") {
            recordDynamicModule(node, `${owner}.require()`);
          }
          assert.equal(
            ownerPath?.length === 1 &&
              ownerPath[0] === "navigator" &&
              member === "sendBeacon",
            false,
            `${normalizedPath}: forbidden network call navigator.sendBeacon`,
          );
          assert.equal(
            forbiddenChildProcessMembers.has(member) &&
              (ownerPath?.some((segment) =>
                /^(?:childProcess|child_process)$/iu.test(segment),
              ) ?? false),
            false,
            `${normalizedPath}: forbidden child_process capability ${owner}.${member}`,
          );
          assert.equal(
            forbiddenOaEdaMembers.has(member) ||
              (ownerPath?.some((segment) =>
                /^(?:cadence|openAccess|virtuoso|spectre|oa|eda)$/iu.test(
                  segment,
                ),
              ) ?? false),
            false,
            `${normalizedPath}: forbidden OA/EDA capability ${owner}.${member}`,
          );
        }
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression)
      ) {
        assert.equal(
          forbiddenNetworkConstructors.has(node.expression.text),
          false,
          `${normalizedPath}: forbidden network constructor ${node.expression.text}`,
        );
      }
      ts.forEachChild(node, inspectNode);
    };
    inspectNode(sourceFile);

    for (const specifier of specifiers) {
      assert.doesNotMatch(specifier, forbiddenExternalImports, normalizedPath);
      assert.doesNotMatch(specifier, /(?:cadence|openaccess|virtuoso|spectre|oa-|eda)/iu, normalizedPath);
      if (!specifier.startsWith(".")) {
        assert.equal(allowedExternalImports.has(specifier), true, `${normalizedPath}: ${specifier}`);
        continue;
      }
      let resolved = path.resolve(path.dirname(normalizedPath), specifier);
      if (path.extname(resolved) === "") resolved += ".ts";
      assert.equal(existsSync(resolved), true, `${normalizedPath}: ${specifier}`);
      assert.equal(
        packageRoots.some(
          (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
        ),
        true,
        `${normalizedPath}: ${specifier}`,
      );
      visit(resolved);
    }
  };

  for (const entryFile of entryFiles) visit(entryFile);
  assert.deepEqual(new Set(entryFiles), visited);
});

test("P3 dependency set remains pinned after the approved P3-C scripts-only delta", () => {
  const sha256File = (relativePath: string): string =>
    createHash("sha256").update(readFileSync(relativePath)).digest("hex");
  assert.equal(
    sha256File("package.json"),
    // P5 adds only cloud build/start scripts and the cloud typecheck target; dependencies remain locked below.
    "ccaa407c10c1b35563e8c00bd789cc209457212f21696cd8974aef2a3b1b2049",
  );
  assert.equal(
    sha256File("package-lock.json"),
    "56b63b1a1b9f8514937b1350f66c6131f37755f66b62e1bddedc66a26446e908",
  );
});
