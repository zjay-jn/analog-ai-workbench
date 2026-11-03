import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256CanonicalAawJsonV1 } from "../packages/schematic-workbench/src/canonical-json";
import {
  ReviewedArtifactRegistryError,
  createProductionReviewedArtifactRegistryV1,
} from "../apps/desktop/src/main/schematic/reviewed-artifact-registry";
import { createDevelopmentSyntheticReviewedRegistryV1 } from "../apps/desktop/src/main/schematic/development-synthetic-reviewed-registry";

type ManifestEntry = Readonly<{
  fixtureId: string;
  relativePath: string;
  documentRef: Readonly<{
    documentId: string;
    revisionId: string;
    documentKind: "schematic_reviewed";
  }>;
  artifactRef: Readonly<{
    artifactId: string;
    revisionId: string;
    artifactKind: "circuit_ir_reviewed";
  }>;
}>;

const manifestPath =
  "packages/schematic-workbench/fixtures/approved-synthetic-fixtures.manifest.json";

function flatBasicManifestEntry(): ManifestEntry {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    entries: ManifestEntry[];
  };
  const entry = manifest.entries.find(
    (candidate) => candidate.fixtureId === "flat-basic",
  );
  assert.ok(entry);
  return entry;
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test("P3-C development main registry defaults to one raw-only flat-basic snapshot", () => {
  const manifestRawFrame = Uint8Array.from(readFileSync(manifestPath));
  const flat = flatBasicManifestEntry();
  const fixtureRawFrame = Uint8Array.from(readFileSync(flat.relativePath));
  const loaderCalls: string[] = [];
  const registry = createDevelopmentSyntheticReviewedRegistryV1({
    manifestRawFrame,
    loadFixtureRawFrame: (fixtureId: string): Uint8Array => {
      loaderCalls.push(fixtureId);
      assert.equal(fixtureId, "flat-basic");
      return fixtureRawFrame;
    },
  });

  assert.equal(registry.mode, "development");
  assert.deepEqual(registry.fixtureIds(), ["flat-basic"]);
  assert.deepEqual(loaderCalls, ["flat-basic"]);
  assert.equal(registry.size(), 1);
  const admitted = registry.resolveExact({
    documentRef: flat.documentRef,
    artifactRef: flat.artifactRef,
  });
  const digestBefore = sha256CanonicalAawJsonV1(admitted.circuitIr);
  manifestRawFrame.fill(0);
  fixtureRawFrame.fill(0);
  assert.equal(
    sha256CanonicalAawJsonV1(
      registry.resolveExact({
        documentRef: flat.documentRef,
        artifactRef: flat.artifactRef,
      }).circuitIr,
    ),
    digestBefore,
  );
  assert.equal(admitted.providerState.dirty, false);
  assert.deepEqual(admitted.receipt.documentRef, flat.documentRef);
  assert.deepEqual(admitted.receipt.artifactRef, flat.artifactRef);
  assertDeepFrozen(admitted);
});

test("P3-C development registry rejects materialized fixture injection", () => {
  const materializedCases: ReadonlyArray<readonly [string, unknown]> = [
    [
      "manifest object",
      {
        manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
        loadFixtureRawFrame: (_fixtureId: string): Uint8Array => new Uint8Array(),
      },
    ],
    [
      "materialized circuit IR",
      {
        manifestRawFrame: Uint8Array.from(readFileSync(manifestPath)),
        fixture: JSON.parse(
          readFileSync(
            "packages/schematic-workbench/fixtures/flat-basic.json",
            "utf8",
          ),
        ) as unknown,
      },
    ],
  ];
  for (const [label, candidate] of materializedCases) {
    assert.throws(
      () => createDevelopmentSyntheticReviewedRegistryV1(candidate),
      (error: unknown) => {
        assert.ok(error instanceof ReviewedArtifactRegistryError);
        assert.equal(error.code, "INVALID_REQUEST");
        return true;
      },
      label,
    );
  }
});

test("P3-C development registry rejects accessor and proxy configuration without reads", () => {
  let getterReads = 0;
  let proxyReads = 0;
  const accessor = {
    loadFixtureRawFrame: (_fixtureId: string): Uint8Array => new Uint8Array(),
  } as Record<string, unknown>;
  Object.defineProperty(accessor, "manifestRawFrame", {
    enumerable: true,
    get: () => {
      getterReads += 1;
      return Uint8Array.from(readFileSync(manifestPath));
    },
  });
  const proxy = new Proxy(
    {
      manifestRawFrame: Uint8Array.from(readFileSync(manifestPath)),
      loadFixtureRawFrame: (_fixtureId: string): Uint8Array => new Uint8Array(),
    },
    {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  for (const candidate of [accessor, proxy]) {
    assert.throws(
      () => createDevelopmentSyntheticReviewedRegistryV1(candidate),
      (error: unknown) => {
        assert.ok(error instanceof ReviewedArtifactRegistryError);
        assert.equal(error.code, "INVALID_REQUEST");
        return true;
      },
    );
  }
  assert.equal(getterReads, 0);
  assert.equal(proxyReads, 0);
});

test("P3-C production registry is immutable, empty and cannot resolve synthetic identity", () => {
  const flat = flatBasicManifestEntry();
  const registry = createProductionReviewedArtifactRegistryV1();
  assert.equal(registry.mode, "production");
  assert.equal(registry.size(), 0);
  assert.deepEqual(registry.fixtureIds(), []);
  assertDeepFrozen(registry.snapshot());
  assert.throws(
    () =>
      registry.resolveExact({
        documentRef: flat.documentRef,
        artifactRef: flat.artifactRef,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewedArtifactRegistryError);
      assert.equal(error.code, "REVISION_UNAVAILABLE");
      assert.equal(error.retryability, "never");
      assert.equal(error.recoveryAction, "none");
      return true;
    },
  );
  assert.equal(registry.size(), 0);
});
