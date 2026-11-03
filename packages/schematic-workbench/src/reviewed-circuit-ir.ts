export const REVIEWED_CIRCUIT_IR_SCHEMA_VERSION =
  "aaw.circuit-ir.reviewed/v1alpha1" as const;
export const REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION =
  "aaw-json-c14n/v1" as const;

const MAX_DEFINITIONS = 4_096;
const MAX_ENTITIES = 50_000;
const MAX_REFERENCES = 100_000;
const MAX_HIERARCHY_DEPTH = 32;
const MAX_OCCURRENCE_PATH = 32;
const MAX_COORDINATE = 1e9;
const MAX_STRING_BYTES = 4_096;
const MAX_LABEL_CODE_POINTS = 512;

export type ReviewedCircuitIrErrorCode =
  | "INVALID_SCHEMA"
  | "UNKNOWN_FIELD"
  | "INVALID_VALUE"
  | "DUPLICATE_ID"
  | "DANGLING_REFERENCE"
  | "HIERARCHY_CYCLE"
  | "HIERARCHY_DEPTH_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "OCCURRENCE_UNAVAILABLE"
  | "NET_UNAVAILABLE"
  | "AMBIGUOUS_MAPPING";

export class ReviewedCircuitIrError extends Error {
  constructor(
    readonly code: ReviewedCircuitIrErrorCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ReviewedCircuitIrError";
  }
}

export type CircuitBoundsV1 = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

export type CircuitPointV1 = {
  readonly x: number;
  readonly y: number;
};

export type CircuitTerminalMappingV1 = {
  readonly terminalId: string;
  readonly parentNetId: string;
  readonly childPortId: string;
  readonly childNetId: string;
};

export type CircuitInstanceV1 = {
  readonly instanceId: string;
  readonly childDefinitionId?: string;
  readonly blackbox?: boolean;
  readonly bounds?: CircuitBoundsV1;
  readonly terminalMappings?: readonly CircuitTerminalMappingV1[];
};

export type CircuitPortV1 = {
  readonly portId: string;
  readonly netId?: string;
  readonly x?: number;
  readonly y?: number;
};

export type CircuitPinV1 = {
  readonly pinId: string;
  readonly instanceId: string;
  readonly terminalId: string;
  readonly netId: string;
  readonly x?: number;
  readonly y?: number;
};

export type CircuitNetV1 = {
  readonly netId: string;
  readonly memberElementIds: readonly string[];
};

export type CircuitWireV1 = {
  readonly wireId: string;
  readonly netId: string;
  readonly points?: readonly CircuitPointV1[];
};

export type CircuitLabelV1 = {
  readonly labelId: string;
  readonly text: string;
  readonly x?: number;
  readonly y?: number;
  readonly targetElementId?: string;
};

export type CircuitDefinitionV1 = {
  readonly definitionId: string;
  readonly bounds: CircuitBoundsV1;
  readonly instances: readonly CircuitInstanceV1[];
  readonly ports: readonly CircuitPortV1[];
  readonly pins?: readonly CircuitPinV1[];
  readonly nets: readonly CircuitNetV1[];
  readonly wires: readonly CircuitWireV1[];
  readonly labels: readonly CircuitLabelV1[];
  readonly renderOrder: readonly string[];
};

export type ReviewedCircuitIrV1 = {
  readonly schemaVersion: typeof REVIEWED_CIRCUIT_IR_SCHEMA_VERSION;
  readonly canonicalizationVersion: typeof REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION;
  readonly coordinateUnit: string;
  readonly bounds: CircuitBoundsV1;
  readonly rootDefinitionId: string;
  readonly definitions: readonly CircuitDefinitionV1[];
};

export type OccurrenceNetRefV1 = {
  readonly definitionId: string;
  readonly occurrencePath: readonly string[];
  readonly netId: string;
};

type UnknownRecord = Record<string, unknown>;
type ValidationCounters = { entities: number; references: number };

const textEncoder = new TextEncoder();

function fail(
  code: ReviewedCircuitIrErrorCode,
  message: string,
  path: string,
): never {
  throw new ReviewedCircuitIrError(code, message, path);
}

function asRecord(value: unknown, path: string): UnknownRecord {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail("INVALID_VALUE", "Expected an object.", path);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail("INVALID_VALUE", "Expected a plain object.", path);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return fail("UNKNOWN_FIELD", "Symbol properties are forbidden.", path);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: UnknownRecord = Object.create(null) as UnknownRecord;
    for (const key of Object.getOwnPropertyNames(descriptors)) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return fail("UNKNOWN_FIELD", "Hidden fields and accessors are forbidden.", path);
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof ReviewedCircuitIrError) throw error;
    return fail("INVALID_VALUE", "Object could not be safely snapshotted.", path);
  }
}

function exactKeys(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail("UNKNOWN_FIELD", "Object contains an unknown field.", `${path}.${key}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail("INVALID_VALUE", "Object is missing a required field.", `${path}.${key}`);
    }
  }
}

function asArray(value: unknown, path: string): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return fail("INVALID_VALUE", "Expected a standard array.", path);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return fail("UNKNOWN_FIELD", "Array symbol properties are forbidden.", path);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: unknown[] = [];
    const ownNames = Object.getOwnPropertyNames(descriptors);
    const expectedNames = [
      ...Array.from({ length: value.length }, (_unused, index) => String(index)),
      "length",
    ];
    if (
      ownNames.length !== expectedNames.length ||
      ownNames.some((name) => !expectedNames.includes(name))
    ) {
      return fail("UNKNOWN_FIELD", "Array contains holes or named properties.", path);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return fail("UNKNOWN_FIELD", "Array accessors are forbidden.", path);
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof ReviewedCircuitIrError) throw error;
    return fail("INVALID_VALUE", "Array could not be safely snapshotted.", path);
  }
}

function validUnicodeString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return fail("INVALID_VALUE", "Expected a non-empty string.", path);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return fail("INVALID_VALUE", "Unpaired surrogate is forbidden.", path);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return fail("INVALID_VALUE", "Unpaired surrogate is forbidden.", path);
    }
  }
  if (textEncoder.encode(value).byteLength > MAX_STRING_BYTES) {
    return fail("BUDGET_EXCEEDED", "String exceeds the v1 byte limit.", path);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return fail("INVALID_VALUE", "Control characters are forbidden.", path);
  }
  return value;
}

function id(value: unknown, path: string): string {
  return validUnicodeString(value, path);
}

function coordinate(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    Math.abs(value) > MAX_COORDINATE
  ) {
    return fail("INVALID_VALUE", "Coordinate is outside the finite v1 range.", path);
  }
  return value;
}

function bounds(value: unknown, path: string): void {
  const record = asRecord(value, path);
  exactKeys(record, ["minX", "minY", "maxX", "maxY"], [], path);
  const minX = coordinate(record.minX, `${path}.minX`);
  const minY = coordinate(record.minY, `${path}.minY`);
  const maxX = coordinate(record.maxX, `${path}.maxX`);
  const maxY = coordinate(record.maxY, `${path}.maxY`);
  if (minX > maxX || minY > maxY) {
    fail("INVALID_VALUE", "Bounds minimum exceeds maximum.", path);
  }
}

function optionalPoint(record: UnknownRecord, path: string): void {
  const hasX = Object.prototype.hasOwnProperty.call(record, "x");
  const hasY = Object.prototype.hasOwnProperty.call(record, "y");
  if (hasX !== hasY) {
    fail("INVALID_VALUE", "Point coordinates must appear as an x/y pair.", path);
  }
  if (hasX) {
    coordinate(record.x, `${path}.x`);
    coordinate(record.y, `${path}.y`);
  }
}

function uniqueId(
  value: unknown,
  seen: Set<string>,
  path: string,
): string {
  const parsed = id(value, path);
  if (seen.has(parsed)) {
    return fail("DUPLICATE_ID", "ID is duplicated in its declaration scope.", path);
  }
  seen.add(parsed);
  return parsed;
}

function incrementEntity(counters: ValidationCounters, path: string): void {
  counters.entities += 1;
  if (counters.entities > MAX_ENTITIES) {
    fail("BUDGET_EXCEEDED", "Circuit IR entity budget exceeded.", path);
  }
}

function incrementReferences(
  counters: ValidationCounters,
  count: number,
  path: string,
): void {
  counters.references += count;
  if (counters.references > MAX_REFERENCES) {
    fail("BUDGET_EXCEEDED", "Circuit IR reference budget exceeded.", path);
  }
}

function validateDefinitionShape(
  value: unknown,
  index: number,
  definitionIds: Set<string>,
  counters: ValidationCounters,
): void {
  const path = `definitions[${index}]`;
  const record = asRecord(value, path);
  exactKeys(
    record,
    [
      "definitionId",
      "bounds",
      "instances",
      "ports",
      "nets",
      "wires",
      "labels",
      "renderOrder",
    ],
    ["pins"],
    path,
  );
  uniqueId(record.definitionId, definitionIds, `${path}.definitionId`);
  bounds(record.bounds, `${path}.bounds`);

  const instances = asArray(record.instances, `${path}.instances`);
  const ports = asArray(record.ports, `${path}.ports`);
  const pins = record.pins === undefined ? [] : asArray(record.pins, `${path}.pins`);
  const nets = asArray(record.nets, `${path}.nets`);
  const wires = asArray(record.wires, `${path}.wires`);
  const labels = asArray(record.labels, `${path}.labels`);
  const renderOrder = asArray(record.renderOrder, `${path}.renderOrder`);

  const elementIds = new Set<string>();
  const instanceIds = new Set<string>();
  const netIds = new Set<string>();
  const renderableIds = new Set<string>();
  const declaredElementNetIds = new Map<string, string | undefined>();

  for (let itemIndex = 0; itemIndex < instances.length; itemIndex += 1) {
    const itemPath = `${path}.instances[${itemIndex}]`;
    const item = asRecord(instances[itemIndex], itemPath);
    exactKeys(
      item,
      ["instanceId"],
      ["childDefinitionId", "blackbox", "bounds", "terminalMappings"],
      itemPath,
    );
    const instanceId = uniqueId(item.instanceId, elementIds, `${itemPath}.instanceId`);
    instanceIds.add(instanceId);
    renderableIds.add(instanceId);
    declaredElementNetIds.set(instanceId, undefined);
    incrementEntity(counters, itemPath);
    if (item.blackbox !== undefined && typeof item.blackbox !== "boolean") {
      fail("INVALID_VALUE", "blackbox must be boolean.", `${itemPath}.blackbox`);
    }
    const blackbox = item.blackbox === true;
    if (blackbox && item.childDefinitionId !== undefined) {
      fail("INVALID_VALUE", "Blackbox instance cannot reference a child definition.", itemPath);
    }
    if (!blackbox && item.childDefinitionId === undefined) {
      fail("INVALID_VALUE", "Non-blackbox instance requires a child definition.", itemPath);
    }
    if (item.childDefinitionId !== undefined) {
      id(item.childDefinitionId, `${itemPath}.childDefinitionId`);
      incrementReferences(counters, 1, itemPath);
    }
    if (item.bounds !== undefined) bounds(item.bounds, `${itemPath}.bounds`);
    const mappings =
      item.terminalMappings === undefined
        ? []
        : asArray(item.terminalMappings, `${itemPath}.terminalMappings`);
    if (blackbox && mappings.length > 0) {
      fail(
        "INVALID_VALUE",
        "Blackbox instance cannot declare child terminal mappings.",
        `${itemPath}.terminalMappings`,
      );
    }
    const terminalIds = new Set<string>();
    const childPortIds = new Set<string>();
    for (let mappingIndex = 0; mappingIndex < mappings.length; mappingIndex += 1) {
      const mappingPath = `${itemPath}.terminalMappings[${mappingIndex}]`;
      const mapping = asRecord(mappings[mappingIndex], mappingPath);
      exactKeys(
        mapping,
        ["terminalId", "parentNetId", "childPortId", "childNetId"],
        [],
        mappingPath,
      );
      uniqueId(mapping.terminalId, terminalIds, `${mappingPath}.terminalId`);
      const childPortId = id(mapping.childPortId, `${mappingPath}.childPortId`);
      if (childPortIds.has(childPortId)) {
        fail("AMBIGUOUS_MAPPING", "Child port is mapped more than once.", mappingPath);
      }
      childPortIds.add(childPortId);
      id(mapping.parentNetId, `${mappingPath}.parentNetId`);
      id(mapping.childNetId, `${mappingPath}.childNetId`);
      incrementReferences(counters, 3, mappingPath);
    }
  }

  for (let itemIndex = 0; itemIndex < ports.length; itemIndex += 1) {
    const itemPath = `${path}.ports[${itemIndex}]`;
    const item = asRecord(ports[itemIndex], itemPath);
    exactKeys(item, ["portId"], ["netId", "x", "y"], itemPath);
    const portId = uniqueId(item.portId, elementIds, `${itemPath}.portId`);
    renderableIds.add(portId);
    incrementEntity(counters, itemPath);
    let portNetId: string | undefined;
    if (item.netId !== undefined) {
      portNetId = id(item.netId, `${itemPath}.netId`);
      incrementReferences(counters, 1, itemPath);
    }
    declaredElementNetIds.set(portId, portNetId);
    optionalPoint(item, itemPath);
  }

  const pinTerminalKeys = new Set<string>();
  for (let itemIndex = 0; itemIndex < pins.length; itemIndex += 1) {
    const itemPath = `${path}.pins[${itemIndex}]`;
    const item = asRecord(pins[itemIndex], itemPath);
    exactKeys(
      item,
      ["pinId", "instanceId", "terminalId", "netId"],
      ["x", "y"],
      itemPath,
    );
    const pinId = uniqueId(item.pinId, elementIds, `${itemPath}.pinId`);
    renderableIds.add(pinId);
    incrementEntity(counters, itemPath);
    const pinInstanceId = id(item.instanceId, `${itemPath}.instanceId`);
    const terminalId = id(item.terminalId, `${itemPath}.terminalId`);
    const terminalKey = `${pinInstanceId.length}:${pinInstanceId}${terminalId.length}:${terminalId}`;
    if (pinTerminalKeys.has(terminalKey)) {
      fail("DUPLICATE_ID", "Instance terminal is declared more than once.", itemPath);
    }
    pinTerminalKeys.add(terminalKey);
    const pinNetId = id(item.netId, `${itemPath}.netId`);
    declaredElementNetIds.set(pinId, pinNetId);
    incrementReferences(counters, 2, itemPath);
    optionalPoint(item, itemPath);
  }

  for (let itemIndex = 0; itemIndex < nets.length; itemIndex += 1) {
    const itemPath = `${path}.nets[${itemIndex}]`;
    const item = asRecord(nets[itemIndex], itemPath);
    exactKeys(item, ["netId", "memberElementIds"], [], itemPath);
    uniqueId(item.netId, netIds, `${itemPath}.netId`);
    incrementEntity(counters, itemPath);
    const members = asArray(item.memberElementIds, `${itemPath}.memberElementIds`);
    const seenMembers = new Set<string>();
    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      uniqueId(
        members[memberIndex],
        seenMembers,
        `${itemPath}.memberElementIds[${memberIndex}]`,
      );
    }
    incrementReferences(counters, members.length, itemPath);
  }

  for (let itemIndex = 0; itemIndex < wires.length; itemIndex += 1) {
    const itemPath = `${path}.wires[${itemIndex}]`;
    const item = asRecord(wires[itemIndex], itemPath);
    exactKeys(item, ["wireId", "netId"], ["points"], itemPath);
    const wireId = uniqueId(item.wireId, elementIds, `${itemPath}.wireId`);
    renderableIds.add(wireId);
    incrementEntity(counters, itemPath);
    const wireNetId = id(item.netId, `${itemPath}.netId`);
    declaredElementNetIds.set(wireId, wireNetId);
    incrementReferences(counters, 1, itemPath);
    if (item.points !== undefined) {
      const points = asArray(item.points, `${itemPath}.points`);
      for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
        const pointPath = `${itemPath}.points[${pointIndex}]`;
        const point = asRecord(points[pointIndex], pointPath);
        exactKeys(point, ["x", "y"], [], pointPath);
        coordinate(point.x, `${pointPath}.x`);
        coordinate(point.y, `${pointPath}.y`);
        incrementEntity(counters, pointPath);
      }
    }
  }

  for (let itemIndex = 0; itemIndex < labels.length; itemIndex += 1) {
    const itemPath = `${path}.labels[${itemIndex}]`;
    const item = asRecord(labels[itemIndex], itemPath);
    exactKeys(item, ["labelId", "text"], ["x", "y", "targetElementId"], itemPath);
    const labelId = uniqueId(item.labelId, elementIds, `${itemPath}.labelId`);
    renderableIds.add(labelId);
    declaredElementNetIds.set(labelId, undefined);
    incrementEntity(counters, itemPath);
    const text = validUnicodeString(item.text, `${itemPath}.text`);
    if ([...text].length > MAX_LABEL_CODE_POINTS) {
      fail("BUDGET_EXCEEDED", "Label exceeds the v1 code-point limit.", `${itemPath}.text`);
    }
    optionalPoint(item, itemPath);
    if (item.targetElementId !== undefined) {
      id(item.targetElementId, `${itemPath}.targetElementId`);
      incrementReferences(counters, 1, itemPath);
    }
  }

  const renderSeen = new Set<string>();
  for (let orderIndex = 0; orderIndex < renderOrder.length; orderIndex += 1) {
    uniqueId(renderOrder[orderIndex], renderSeen, `${path}.renderOrder[${orderIndex}]`);
  }
  if (
    renderSeen.size !== renderableIds.size ||
    [...renderableIds].some((renderableId) => !renderSeen.has(renderableId))
  ) {
    fail(
      "DANGLING_REFERENCE",
      "renderOrder must contain every renderable element exactly once.",
      `${path}.renderOrder`,
    );
  }
  incrementReferences(counters, renderOrder.length, `${path}.renderOrder`);

  const memberNetByElementId = new Map<string, string>();
  for (let netIndex = 0; netIndex < nets.length; netIndex += 1) {
    const netPath = `${path}.nets[${netIndex}]`;
    const net = asRecord(nets[netIndex], netPath);
    const netId = id(net.netId, `${netPath}.netId`);
    const members = asArray(net.memberElementIds, `${netPath}.memberElementIds`);
    for (const member of members) {
      const memberId = id(member, `${netPath}.memberElementIds`);
      if (!elementIds.has(memberId)) {
        fail(
          "DANGLING_REFERENCE",
          "Net member does not resolve in the current definition scope.",
          `${netPath}.memberElementIds`,
        );
      }
      const declaredNetId = declaredElementNetIds.get(memberId);
      if (declaredNetId === undefined || declaredNetId !== netId) {
        fail(
          "AMBIGUOUS_MAPPING",
          "Net member must declare the same exact netId.",
          `${netPath}.memberElementIds`,
        );
      }
      if (memberNetByElementId.has(memberId)) {
        fail(
          "AMBIGUOUS_MAPPING",
          "An element cannot belong to more than one net membership list.",
          `${netPath}.memberElementIds`,
        );
      }
      memberNetByElementId.set(memberId, netId);
    }
  }
  for (const [elementId, declaredNetId] of declaredElementNetIds) {
    if (
      declaredNetId !== undefined &&
      memberNetByElementId.get(elementId) !== declaredNetId
    ) {
      fail(
        "DANGLING_REFERENCE",
        "Every net-bearing element must appear in its exact net membership list.",
        `${path}.nets`,
      );
    }
  }
  for (const portValue of ports) {
    const port = asRecord(portValue, `${path}.ports`);
    if (port.netId !== undefined && !netIds.has(port.netId as string)) {
      fail("DANGLING_REFERENCE", "Port net does not resolve.", `${path}.ports.netId`);
    }
  }
  for (const pinValue of pins) {
    const pin = asRecord(pinValue, `${path}.pins`);
    if (!instanceIds.has(pin.instanceId as string) || !netIds.has(pin.netId as string)) {
      fail("DANGLING_REFERENCE", "Pin instance or net does not resolve.", `${path}.pins`);
    }
  }
  for (const wireValue of wires) {
    const wire = asRecord(wireValue, `${path}.wires`);
    if (!netIds.has(wire.netId as string)) {
      fail("DANGLING_REFERENCE", "Wire net does not resolve.", `${path}.wires.netId`);
    }
  }
  for (const labelValue of labels) {
    const label = asRecord(labelValue, `${path}.labels`);
    if (
      label.targetElementId !== undefined &&
      !elementIds.has(label.targetElementId as string)
    ) {
      fail("DANGLING_REFERENCE", "Label target does not resolve.", `${path}.labels`);
    }
  }
}

function validateHierarchyAndMappings(definitions: readonly unknown[]): void {
  const definitionsById = new Map<string, UnknownRecord>();
  for (const value of definitions) {
    const definition = asRecord(value, "definitions");
    definitionsById.set(definition.definitionId as string, definition);
  }

  for (const [definitionId, definition] of definitionsById) {
    const parentNets = new Set(
      asArray(definition.nets, `definitions.${definitionId}.nets`).map(
        (net) => asRecord(net, "net").netId as string,
      ),
    );
    const instances = asArray(
      definition.instances,
      `definitions.${definitionId}.instances`,
    );
    const pins = asArray(
      definition.pins ?? [],
      `definitions.${definitionId}.pins`,
    ).map((pin) => asRecord(pin, `definitions.${definitionId}.pin`));
    for (const instanceValue of instances) {
      const instance = asRecord(instanceValue, "instance");
      if (instance.childDefinitionId === undefined) continue;
      const child = definitionsById.get(instance.childDefinitionId as string);
      if (child === undefined) {
        fail(
          "DANGLING_REFERENCE",
          "Instance child definition does not resolve.",
          `definitions.${definitionId}.instances`,
        );
      }
      const childPorts = new Map<string, UnknownRecord>();
      for (const portValue of asArray(child.ports, "child.ports")) {
        const port = asRecord(portValue, "child.port");
        childPorts.set(port.portId as string, port);
      }
      const childNets = new Set(
        asArray(child.nets, "child.nets").map(
          (net) => asRecord(net, "child.net").netId as string,
        ),
      );
      const mappings =
        instance.terminalMappings === undefined
          ? []
          : asArray(instance.terminalMappings, "instance.terminalMappings");
      const parentPins = pins.filter(
        (pin) => pin.instanceId === instance.instanceId,
      );
      const mappedTerminalIds = new Set<string>();
      const mappedChildPortIds = new Set<string>();
      for (const mappingValue of mappings) {
        const mapping = asRecord(mappingValue, "terminalMapping");
        const childPort = childPorts.get(mapping.childPortId as string);
        const parentPin = pins.find(
          (pin) =>
            pin.instanceId === instance.instanceId &&
            pin.terminalId === mapping.terminalId,
        );
        if (
          !parentNets.has(mapping.parentNetId as string) ||
          parentPin === undefined ||
          parentPin.netId !== mapping.parentNetId ||
          childPort === undefined ||
          !childNets.has(mapping.childNetId as string) ||
          childPort.netId !== mapping.childNetId
        ) {
          fail(
            "DANGLING_REFERENCE",
            "Explicit terminal/port mapping does not resolve exactly.",
            `definitions.${definitionId}.instances.terminalMappings`,
          );
        }
        mappedTerminalIds.add(mapping.terminalId as string);
        mappedChildPortIds.add(mapping.childPortId as string);
      }
      if (
        mappings.length !== parentPins.length ||
        mappings.length !== childPorts.size ||
        parentPins.some(
          (pin) => !mappedTerminalIds.has(pin.terminalId as string),
        ) ||
        [...childPorts.keys()].some(
          (childPortId) => !mappedChildPortIds.has(childPortId),
        )
      ) {
        fail(
          "AMBIGUOUS_MAPPING",
          "Every parent pin terminal and child port requires one exact explicit mapping.",
          `definitions.${definitionId}.instances.terminalMappings`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const maximumDepthByDefinition = new Map<string, number>();
  const maximumDescendantDepth = (definitionId: string): number => {
    if (visiting.has(definitionId)) {
      fail("HIERARCHY_CYCLE", "Hierarchy cycle is forbidden.", definitionId);
    }
    const memoized = maximumDepthByDefinition.get(definitionId);
    if (memoized !== undefined) return memoized;
    visiting.add(definitionId);
    if (visiting.size - 1 > MAX_HIERARCHY_DEPTH) {
      fail(
        "HIERARCHY_DEPTH_EXCEEDED",
        "Hierarchy exceeds the v1 occurrence depth limit.",
        definitionId,
      );
    }
    const definition = definitionsById.get(definitionId);
    if (definition === undefined) {
      fail("DANGLING_REFERENCE", "Definition does not resolve.", definitionId);
    }
    let maximumDepth = 0;
    for (const instanceValue of asArray(definition.instances, "instances")) {
      const instance = asRecord(instanceValue, "instance");
      if (instance.childDefinitionId !== undefined) {
        maximumDepth = Math.max(
          maximumDepth,
          1 + maximumDescendantDepth(instance.childDefinitionId as string),
        );
      }
    }
    visiting.delete(definitionId);
    maximumDepthByDefinition.set(definitionId, maximumDepth);
    return maximumDepth;
  };
  for (const definitionId of definitionsById.keys()) {
    if (maximumDescendantDepth(definitionId) > MAX_HIERARCHY_DEPTH) {
      fail(
        "HIERARCHY_DEPTH_EXCEEDED",
        "Hierarchy exceeds the v1 occurrence depth limit.",
        definitionId,
      );
    }
  }
}

function deepCloneAndFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepCloneAndFreeze(entry)));
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      clone[key] = deepCloneAndFreeze(child);
    }
    return Object.freeze(clone);
  }
  return value;
}

export function validateReviewedCircuitIrV1(value: unknown): ReviewedCircuitIrV1 {
  const root = asRecord(value, "$");
  exactKeys(
    root,
    [
      "schemaVersion",
      "canonicalizationVersion",
      "coordinateUnit",
      "bounds",
      "rootDefinitionId",
      "definitions",
    ],
    [],
    "$",
  );
  if (root.schemaVersion !== REVIEWED_CIRCUIT_IR_SCHEMA_VERSION) {
    fail("INVALID_SCHEMA", "Unsupported reviewed Circuit IR schema.", "$.schemaVersion");
  }
  if (root.canonicalizationVersion !== REVIEWED_CIRCUIT_IR_CANONICALIZATION_VERSION) {
    fail(
      "INVALID_SCHEMA",
      "Unsupported canonicalization contract.",
      "$.canonicalizationVersion",
    );
  }
  validUnicodeString(root.coordinateUnit, "$.coordinateUnit");
  bounds(root.bounds, "$.bounds");
  const rootDefinitionId = id(root.rootDefinitionId, "$.rootDefinitionId");
  const definitions = asArray(root.definitions, "$.definitions");
  if (definitions.length === 0 || definitions.length > MAX_DEFINITIONS) {
    fail("BUDGET_EXCEEDED", "Definition count is outside the v1 limits.", "$.definitions");
  }
  const definitionIds = new Set<string>();
  const counters: ValidationCounters = { entities: 0, references: 0 };
  for (let index = 0; index < definitions.length; index += 1) {
    validateDefinitionShape(definitions[index], index, definitionIds, counters);
  }
  if (!definitionIds.has(rootDefinitionId)) {
    fail("DANGLING_REFERENCE", "Root definition does not resolve.", "$.rootDefinitionId");
  }
  validateHierarchyAndMappings(definitions);
  return deepCloneAndFreeze(root) as ReviewedCircuitIrV1;
}

export function resolveOccurrenceNetV1(
  circuitIr: ReviewedCircuitIrV1,
  occurrencePath: readonly string[],
  netId: string,
): OccurrenceNetRefV1 {
  if (!Array.isArray(occurrencePath) || occurrencePath.length > MAX_OCCURRENCE_PATH) {
    fail(
      "OCCURRENCE_UNAVAILABLE",
      "Occurrence path is outside the v1 limits.",
      "occurrencePath",
    );
  }
  const definitionsById = new Map(
    circuitIr.definitions.map((definition) => [definition.definitionId, definition] as const),
  );
  let definition = definitionsById.get(circuitIr.rootDefinitionId);
  if (definition === undefined) {
    fail("OCCURRENCE_UNAVAILABLE", "Root definition is unavailable.", "rootDefinitionId");
  }
  const normalizedPath: string[] = [];
  for (let index = 0; index < occurrencePath.length; index += 1) {
    const instanceId = id(occurrencePath[index], `occurrencePath[${index}]`);
    const instance = definition.instances.find((candidate) => candidate.instanceId === instanceId);
    if (
      instance === undefined ||
      instance.blackbox === true ||
      instance.childDefinitionId === undefined
    ) {
      fail(
        "OCCURRENCE_UNAVAILABLE",
        "Occurrence path does not resolve through a navigable instance.",
        `occurrencePath[${index}]`,
      );
    }
    const child = definitionsById.get(instance.childDefinitionId);
    if (child === undefined) {
      fail(
        "OCCURRENCE_UNAVAILABLE",
        "Occurrence child definition is unavailable.",
        `occurrencePath[${index}]`,
      );
    }
    normalizedPath.push(instanceId);
    definition = child;
  }
  const normalizedNetId = id(netId, "netId");
  if (!definition.nets.some((net) => net.netId === normalizedNetId)) {
    fail("NET_UNAVAILABLE", "Net is unavailable in the resolved occurrence.", "netId");
  }
  return Object.freeze({
    definitionId: definition.definitionId,
    occurrencePath: Object.freeze(normalizedPath),
    netId: normalizedNetId,
  });
}
