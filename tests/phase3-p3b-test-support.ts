import { readFileSync } from "node:fs";
import { sha256CanonicalAawJsonV1 } from "../packages/schematic-workbench/src/canonical-json";
import {
  validateReviewedCircuitIrV1,
  type ReviewedCircuitIrV1,
} from "../packages/schematic-workbench/src/reviewed-circuit-ir";
import { decodeStrictSourceFrameV1 } from "../packages/schematic-workbench/src/strict-source-frame";
import { createSyntheticAdmissionRegistryV1 } from "../packages/schematic-workbench/src/synthetic-admission";

const manifestPath =
  "packages/schematic-workbench/fixtures/approved-synthetic-fixtures.manifest.json";
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
};

export function admitP3bFixtureV1(fixtureId: string) {
  const rawManifestBytes = Uint8Array.from(readFileSync(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    entries: ManifestEntry[];
  };
  const entry = manifest.entries.find((candidate) => candidate.fixtureId === fixtureId);
  if (entry === undefined) throw new Error(`Unknown synthetic fixture: ${fixtureId}`);
  return createSyntheticAdmissionRegistryV1(rawManifestBytes).admit({
    fixtureId,
    rawFrame: Uint8Array.from(readFileSync(entry.relativePath)),
  });
}

export function validateSyntheticViewerVectorThroughRawV1(
  value: unknown,
): ReviewedCircuitIrV1 {
  const rawFrame = new TextEncoder().encode(JSON.stringify(value));
  return validateReviewedCircuitIrV1(
    decodeStrictSourceFrameV1(rawFrame, {
      allowedTopLevelKeys: circuitIrTopLevelKeys,
    }),
  );
}

export function canonicalPayloadDigestV1(value: unknown): string {
  return sha256CanonicalAawJsonV1(value);
}
