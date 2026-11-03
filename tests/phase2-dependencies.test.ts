import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages: Record<
    string,
    { version?: string; integrity?: string; license?: string; hasInstallScript?: boolean }
  >;
};

const approved = {
  "@codemirror/state": {
    version: "6.7.1",
    integrity:
      "sha512-9QzNDgE4EYDnAHfrTlR2lwiPciiOymLtwKK+8yHQzCc7GXhAP9xdEbEJFy2IWB1j9UGUl9BsgMmTo/ImA02T7A==",
  },
  "@codemirror/view": {
    version: "6.43.9",
    integrity:
      "sha512-sTuUzTpPMFebRhg6dawChoKKgndIwfjmJgKVxBefPElcU2NwQ6AFroupk0SFqEerQyZOGRfDNnSN8Dw/lMAsXw==",
  },
  "@codemirror/commands": {
    version: "6.11.0",
    integrity:
      "sha512-/K4Rl5BN0OtTiPWmJCdqODu38XnDMsDxKY5rgrPnCkutPTJf2wVbkoixLfealF5Kwse/s8P8M5jAiURiwSwnFA==",
  },
  "@codemirror/search": {
    version: "6.7.1",
    integrity:
      "sha512-uMe5UO6PamJtSHrXhhHOzSX3ReWtiJrva6GnPMwSOrZtiExb5X5eExhr2OUZQVvdxPsKpY3Ro2mFbQadpPWmHA==",
  },
} as const;

const approvedAddedPackages = [
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  "@marijn/find-cluster-break",
  "crelt",
  "style-mod",
  "w3c-keyname",
] as const;

test("Phase 2 direct CodeMirror packages are exact and integrity pinned", () => {
  for (const [name, expected] of Object.entries(approved)) {
    assert.equal(packageJson.dependencies[name], expected.version);
    const locked = packageLock.packages[`node_modules/${name}`];
    assert.equal(locked?.version, expected.version);
    assert.equal(locked?.integrity, expected.integrity);
  }
  assert.equal(packageJson.dependencies.codemirror, undefined);
  assert.equal(packageJson.dependencies["@uiw/react-codemirror"], undefined);
});

test("the approved Phase 2 transitive set is MIT-only and script-free", () => {
  for (const name of approvedAddedPackages) {
    const locked = packageLock.packages[`node_modules/${name}`];
    assert.ok(locked, `Missing approved lock record for ${name}`);
    assert.equal(locked.license, "MIT", `Unexpected license for ${name}`);
    assert.notEqual(
      locked.hasInstallScript,
      true,
      `Install scripts are not approved for ${name}`,
    );
  }
});
