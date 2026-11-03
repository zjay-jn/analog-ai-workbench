import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";

const schema = JSON.parse(
  readFileSync("tests/contracts/quality-gate-report.schema.json", "utf8"),
) as object;
const ajv = new Ajv2020({
  strict: true,
  formats: { "date-time": true },
});
const validate = ajv.compile(schema);
const digest = `sha256:${"0".repeat(64)}`;

function validReport() {
  return {
    schemaVersion: "aaw.quality-gate-report/v1alpha1",
    gateId: "phase1-exit",
    phase: "phase1",
    status: "PASS",
    source: {
      baselineManifestSha256: digest,
      changedFilesManifestSha256: digest,
      reversePatchSha256: digest,
    },
    environment: {
      platform: "win32",
      architecture: "x64",
      node: "24.20.0",
      npm: "11.19.0",
      electron: "43.4.0",
    },
    startedAt: "2026-08-31T00:00:00+08:00",
    endedAt: "2026-08-31T00:01:00+08:00",
    commands: [{ name: "typecheck", exitCode: 0 }],
    tests: { total: 10, failed: 0 },
    artifacts: [{ relativePath: "sbom.cdx.json", sha256: digest }],
    knownIssues: [],
    waivers: [],
  };
}

test("quality gate schema accepts a complete relative evidence report", () => {
  assert.equal(validate(validReport()), true, JSON.stringify(validate.errors));
});

test("quality gate schema rejects absolute artifact paths and unknown fields", () => {
  const absolutePath = validReport();
  absolutePath.artifacts[0] = {
    relativePath: "C:\\private\\evidence.json",
    sha256: digest,
  };
  assert.equal(validate(absolutePath), false);

  const unknownField = { ...validReport(), hidden: true };
  assert.equal(validate(unknownField), false);
});
