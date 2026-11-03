import {
  parseReviewedArtifactRefV1,
  parseReviewedDocumentRefV1,
  type ReviewedArtifactRefV1,
  type ReviewedDocumentRefV1,
} from "../../../../../packages/document-contract/src/reviewed-identity";
import {
  validateReviewedCircuitIrV1,
  type ReviewedCircuitIrV1,
} from "../../../../../packages/schematic-workbench/src/reviewed-circuit-ir";
import type {
  ResolveReviewedArtifactRequestV1,
  ResolveReviewedArtifactResultV1,
} from "../../shared/schematic/reviewed-artifact-resolve";

const CONTRACT_VERSION =
  "workbench.schematic.resolveReviewedArtifact.v1" as const;

export type RendererReviewedArtifactDeliveryErrorCode = "INVALID_DELIVERY";

export class RendererReviewedArtifactDeliveryError extends Error {
  readonly code = "INVALID_DELIVERY" as const;
  readonly retryability = "never" as const;
  readonly recoveryAction = "none" as const;

  constructor(message: string) {
    super(message);
    this.name = "RendererReviewedArtifactDeliveryError";
  }
}

export type RendererReviewedArtifactDeliveryV1 = Readonly<{
  contractVersion: typeof CONTRACT_VERSION;
  documentRef: ReviewedDocumentRefV1;
  artifactRef: ReviewedArtifactRefV1;
  freshness: "current" | "historical";
  reviewedCircuitIr: ReviewedCircuitIrV1;
}>;

export type ReviewedArtifactHostSafeCodeV1 =
  | "INVALID_REQUEST"
  | "CAPABILITY_DENIED"
  | "REVISION_UNAVAILABLE"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL"
  | "INVALID_DELIVERY";

type HostStateBaseV1 = Readonly<{
  request: ResolveReviewedArtifactRequestV1;
}>;

export type ReviewedArtifactHostStateV1 =
  | (HostStateBaseV1 & Readonly<{ status: "idle" }>)
  | (HostStateBaseV1 & Readonly<{ status: "loading" }>)
  | (HostStateBaseV1 &
      Readonly<{
        status: "ready";
        delivery: RendererReviewedArtifactDeliveryV1;
      }>)
  | (HostStateBaseV1 &
      Readonly<{
        status: "error";
        safeCode: ReviewedArtifactHostSafeCodeV1;
      }>);

export type ReviewedArtifactHostControllerV1 = Readonly<{
  mount(request: ResolveReviewedArtifactRequestV1): Promise<void>;
  unmount(): void;
  getState(): ReviewedArtifactHostStateV1;
}>;

type ExactSnapshot = Readonly<Record<string, unknown>>;

function invalidDelivery(message: string): never {
  throw new RendererReviewedArtifactDeliveryError(message);
}

function exactSnapshot(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): ExactSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidDelivery(`${label} must be an object.`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return invalidDelivery(`${label} must be a plain structured clone.`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return invalidDelivery(`${label} contains unsupported properties.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.getOwnPropertyNames(descriptors).sort();
  const requiredKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== requiredKeys.length ||
    actualKeys.some((key, index) => key !== requiredKeys[index])
  ) {
    return invalidDelivery(`${label} has an invalid property set.`);
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of requiredKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return invalidDelivery(`${label}.${key} must be an enumerable data property.`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

export function admitReviewedArtifactDeliveryV1(
  value: unknown,
): RendererReviewedArtifactDeliveryV1 {
  let cloned: unknown;
  try {
    cloned = structuredClone(value);
  } catch {
    return invalidDelivery("Reviewed artifact delivery is not structured-cloneable.");
  }

  try {
    const input = exactSnapshot(
      cloned,
      [
        "contractVersion",
        "documentRef",
        "artifactRef",
        "freshness",
        "reviewedCircuitIr",
      ],
      "delivery",
    );
    if (input.contractVersion !== CONTRACT_VERSION) {
      return invalidDelivery("Reviewed artifact delivery version is invalid.");
    }
    if (input.freshness !== "current" && input.freshness !== "historical") {
      return invalidDelivery("Reviewed artifact delivery freshness is invalid.");
    }
    const documentRef = parseReviewedDocumentRefV1(input.documentRef);
    const artifactRef = parseReviewedArtifactRefV1(input.artifactRef);
    const reviewedCircuitIr = validateReviewedCircuitIrV1(
      input.reviewedCircuitIr,
    );
    return deepFreeze({
      contractVersion: CONTRACT_VERSION,
      documentRef,
      artifactRef,
      freshness: input.freshness,
      reviewedCircuitIr,
    });
  } catch (error: unknown) {
    if (error instanceof RendererReviewedArtifactDeliveryError) throw error;
    return invalidDelivery("Reviewed artifact delivery failed closed validation.");
  }
}

function sameDocumentRef(
  left: ReviewedDocumentRefV1,
  right: ReviewedDocumentRefV1,
): boolean {
  return (
    left.documentId === right.documentId &&
    left.revisionId === right.revisionId &&
    left.documentKind === right.documentKind
  );
}

function sameArtifactRef(
  left: ReviewedArtifactRefV1,
  right: ReviewedArtifactRefV1,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.revisionId === right.revisionId &&
    left.artifactKind === right.artifactKind
  );
}

function canonicalRequest(
  request: ResolveReviewedArtifactRequestV1,
): ResolveReviewedArtifactRequestV1 {
  if (
    request.contractVersion !== CONTRACT_VERSION ||
    request.intent !== "render"
  ) {
    return invalidDelivery("Reviewed artifact request is invalid.");
  }
  return deepFreeze({
    contractVersion: CONTRACT_VERSION,
    documentRef: parseReviewedDocumentRefV1(request.documentRef),
    artifactRef: parseReviewedArtifactRefV1(request.artifactRef),
    intent: "render" as const,
  });
}

function safeResultCode(result: ResolveReviewedArtifactResultV1): ReviewedArtifactHostSafeCodeV1 {
  if (result.ok) return "INTERNAL";
  switch (result.error.code) {
    case "INVALID_REQUEST":
    case "CAPABILITY_DENIED":
    case "REVISION_UNAVAILABLE":
    case "PAYLOAD_TOO_LARGE":
    case "INTERNAL":
      return result.error.code;
    default:
      return "INTERNAL";
  }
}

export function createReviewedArtifactHostControllerV1(input: Readonly<{
  resolveReviewedArtifact(
    request: ResolveReviewedArtifactRequestV1,
  ): Promise<ResolveReviewedArtifactResultV1>;
}>): ReviewedArtifactHostControllerV1 {
  let generation = 0;
  let mounted = false;
  let state: ReviewedArtifactHostStateV1 | null = null;

  const mount = async (
    requestValue: ResolveReviewedArtifactRequestV1,
  ): Promise<void> => {
    const request = canonicalRequest(requestValue);
    const currentGeneration = ++generation;
    mounted = true;
    state = deepFreeze({ status: "loading" as const, request });
    try {
      const result = await input.resolveReviewedArtifact(request);
      if (!mounted || currentGeneration !== generation) return;
      if (!result.ok) {
        state = deepFreeze({
          status: "error" as const,
          request,
          safeCode: safeResultCode(result),
        });
        return;
      }
      const delivery = admitReviewedArtifactDeliveryV1(result.value);
      if (
        !sameDocumentRef(delivery.documentRef, request.documentRef) ||
        !sameArtifactRef(delivery.artifactRef, request.artifactRef)
      ) {
        return invalidDelivery("Reviewed artifact delivery does not match the request.");
      }
      if (!mounted || currentGeneration !== generation) return;
      state = deepFreeze({
        status: "ready" as const,
        request,
        delivery,
      });
    } catch (error: unknown) {
      if (!mounted || currentGeneration !== generation) return;
      state = deepFreeze({
        status: "error" as const,
        request,
        safeCode:
          error instanceof RendererReviewedArtifactDeliveryError
            ? "INVALID_DELIVERY"
            : "INTERNAL",
      });
    }
  };

  return Object.freeze({
    mount,
    unmount: (): void => {
      generation += 1;
      mounted = false;
      if (state !== null) {
        state = deepFreeze({ status: "idle" as const, request: state.request });
      }
    },
    getState: (): ReviewedArtifactHostStateV1 => {
      if (state === null) {
        throw new RendererReviewedArtifactDeliveryError(
          "Reviewed artifact host has not been mounted.",
        );
      }
      return state;
    },
  });
}
