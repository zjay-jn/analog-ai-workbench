import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { startDesktopAppV1 } from "./bootstrap";
import { createDevelopmentSyntheticReviewedRegistryV1 } from "./schematic/development-synthetic-reviewed-registry";
import { createDevelopmentSyntheticAgentBackendV1 } from "./agent/development-synthetic-agent-backend";

const MAX_RAW_BYTES = 8 * 1024 * 1024;
const MANIFEST_RELATIVE_PATH =
  "packages/schematic-workbench/fixtures/approved-synthetic-fixtures.manifest.json";
const FLAT_BASIC_RELATIVE_PATH =
  "packages/schematic-workbench/fixtures/flat-basic.json";
const AGENT_MANIFEST_RELATIVE_PATH =
  "packages/agent-adapters/fixtures/approved-synthetic-agent-fixtures.manifest.json";
const AGENT_MANIFEST_SHA256 =
  "c71c984e1ae1b8500a55a6ddba67788d5c05e4cce51a7ec4670aa01325a88e8c";
const AGENT_SOURCE_PATHS = Object.freeze([
  "packages/agent-adapters/fixtures/source-events/message-delta.json",
  "packages/agent-adapters/fixtures/source-events/run-completed.json",
  "packages/agent-adapters/fixtures/source-events/citation-text.json",
  "packages/agent-adapters/fixtures/source-events/citation-schematic.json",
  "packages/agent-adapters/fixtures/source-events/citation-rag.json",
  "packages/agent-adapters/fixtures/source-events/invalid-source-time.json",
  "packages/agent-adapters/fixtures/source-events/cancel-acknowledged.json",
  "packages/agent-adapters/fixtures/source-events/run-failed.json",
] as const);
const FIXED_RAW_PATHS: readonly string[] = Object.freeze([
  MANIFEST_RELATIVE_PATH,
  FLAT_BASIC_RELATIVE_PATH,
  AGENT_MANIFEST_RELATIVE_PATH,
  ...AGENT_SOURCE_PATHS,
]);

function readFixedRawAsset(
  applicationRoot: string,
  relativePath: string,
): Uint8Array {
  const resolvedRoot = path.resolve(applicationRoot);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !FIXED_RAW_PATHS.includes(relativePath)
  ) {
    throw new Error("The fixed synthetic fixture asset is unavailable.");
  }
  const size = statSync(resolvedPath).size;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RAW_BYTES) {
    throw new Error("The fixed synthetic fixture asset is outside the approved limit.");
  }
  return Uint8Array.from(readFileSync(resolvedPath));
}

function loadApprovedAgentRawFrames(applicationRoot: string): readonly Uint8Array[] {
  const manifestRaw = readFixedRawAsset(applicationRoot, AGENT_MANIFEST_RELATIVE_PATH);
  const manifestDigest = createHash("sha256").update(manifestRaw).digest("hex");
  if (manifestDigest !== AGENT_MANIFEST_SHA256) throw new Error("The approved synthetic Agent manifest is unavailable.");
  const parsed = JSON.parse(Buffer.from(manifestRaw).toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The approved synthetic Agent manifest is invalid.");
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length !== 9) throw new Error("The approved synthetic Agent manifest is invalid.");
  return Object.freeze(entries.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("The approved synthetic Agent manifest is invalid.");
    const row = entry as { path?: unknown; rawSha256?: unknown; byteLength?: unknown };
    if (typeof row.path !== "string" || !AGENT_SOURCE_PATHS.includes(row.path as typeof AGENT_SOURCE_PATHS[number]) || typeof row.rawSha256 !== "string" || !Number.isSafeInteger(row.byteLength)) throw new Error("The approved synthetic Agent fixture binding is invalid.");
    const frame = readFixedRawAsset(applicationRoot, row.path);
    const digest = `sha256:${createHash("sha256").update(frame).digest("hex")}`;
    if (frame.byteLength !== row.byteLength || digest !== row.rawSha256) throw new Error("The approved synthetic Agent raw bytes do not match their binding.");
    return frame;
  }));
}

startDesktopAppV1({
  buildProfile: "development",
  createReviewedRegistry: (applicationRoot) =>
    createDevelopmentSyntheticReviewedRegistryV1({
      manifestRawFrame: readFixedRawAsset(
        applicationRoot,
        MANIFEST_RELATIVE_PATH,
      ),
      loadFixtureRawFrame: (fixtureId: string) => {
        if (fixtureId !== "flat-basic") {
          throw new Error("The synthetic fixture identity is unavailable.");
        }
        return readFixedRawAsset(applicationRoot, FLAT_BASIC_RELATIVE_PATH);
      },
    }),
  createAgentBackend: (applicationRoot) =>
    createDevelopmentSyntheticAgentBackendV1({
      sourceFrames: loadApprovedAgentRawFrames(applicationRoot),
    }),
  smokeMode: process.argv.includes("--aaw-smoke"),
  ...(process.env.AAW_RENDERER_URL === undefined
    ? {}
    : { developmentUrl: process.env.AAW_RENDERER_URL }),
});
