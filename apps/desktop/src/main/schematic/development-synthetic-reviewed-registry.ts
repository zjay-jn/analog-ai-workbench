import {
  SyntheticAdmissionError,
  createSyntheticAdmissionRegistryV1,
} from "../../../../../packages/schematic-workbench/src/synthetic-admission";
import {
  StrictSourceFrameError,
  snapshotStrictSourceFrameV1,
} from "../../../../../packages/schematic-workbench/src/strict-source-frame";
import {
  ReviewedArtifactRegistryError,
  createDevelopmentReviewedArtifactSnapshotRegistryV1,
  type ReviewedArtifactRegistryV1,
} from "./reviewed-artifact-registry";
import { types as nodeTypes } from "node:util";

type DevelopmentSyntheticRegistryInputV1 = Readonly<{
  manifestRawFrame: Uint8Array;
  loadFixtureRawFrame: (fixtureId: string) => Uint8Array;
}>;

type ExactInputSnapshot = Readonly<{
  manifestRawFrame: unknown;
  loadFixtureRawFrame: unknown;
}>;

function invalidRequest(): never {
  throw new ReviewedArtifactRegistryError(
    "INVALID_REQUEST",
    "The development synthetic registry request is invalid.",
  );
}

function internal(): never {
  throw new ReviewedArtifactRegistryError(
    "INTERNAL",
    "The development synthetic registry is unavailable.",
  );
}

function exactInput(value: unknown): ExactInputSnapshot {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return invalidRequest();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.getOwnPropertyNames(descriptors).sort();
    const expected = ["loadFixtureRawFrame", "manifestRawFrame"];
    if (
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])
    ) {
      return invalidRequest();
    }
    const manifestDescriptor = descriptors.manifestRawFrame;
    const loaderDescriptor = descriptors.loadFixtureRawFrame;
    if (
      manifestDescriptor === undefined ||
      loaderDescriptor === undefined ||
      !("value" in manifestDescriptor) ||
      !("value" in loaderDescriptor) ||
      manifestDescriptor.enumerable !== true ||
      loaderDescriptor.enumerable !== true
    ) {
      return invalidRequest();
    }
    return Object.freeze({
      manifestRawFrame: manifestDescriptor.value,
      loadFixtureRawFrame: loaderDescriptor.value,
    });
  } catch (error: unknown) {
    if (error instanceof ReviewedArtifactRegistryError) throw error;
    return invalidRequest();
  }
}

export function createDevelopmentSyntheticReviewedRegistryV1(
  value: unknown,
): ReviewedArtifactRegistryV1 {
  const input = exactInput(value);
  if (typeof input.loadFixtureRawFrame !== "function") return invalidRequest();

  let manifestRawFrame: Uint8Array;
  try {
    manifestRawFrame = snapshotStrictSourceFrameV1(input.manifestRawFrame);
  } catch (error: unknown) {
    if (error instanceof StrictSourceFrameError) return invalidRequest();
    return invalidRequest();
  }

  let admissionRegistry: ReturnType<typeof createSyntheticAdmissionRegistryV1>;
  try {
    admissionRegistry = createSyntheticAdmissionRegistryV1(manifestRawFrame);
  } catch (error: unknown) {
    if (error instanceof SyntheticAdmissionError) return internal();
    return internal();
  }

  let fixtureRawFrameValue: unknown;
  try {
    fixtureRawFrameValue = (
      input.loadFixtureRawFrame as DevelopmentSyntheticRegistryInputV1["loadFixtureRawFrame"]
    )("flat-basic");
  } catch {
    return internal();
  }

  let fixtureRawFrame: Uint8Array;
  try {
    fixtureRawFrame = snapshotStrictSourceFrameV1(fixtureRawFrameValue);
  } catch {
    return internal();
  }

  let entry;
  try {
    entry = admissionRegistry.admit({
      fixtureId: "flat-basic",
      rawFrame: fixtureRawFrame,
    });
  } catch {
    return internal();
  }

  return createDevelopmentReviewedArtifactSnapshotRegistryV1({
    fixtureId: "flat-basic",
    admissionRegistry,
    entry,
  });
}
