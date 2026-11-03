import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("sandbox preload exposes exactly seven methods over seven fixed channels", () => {
  const preload = readFileSync(
    "apps/desktop/src/preload/index.ts",
    "utf8",
  );
  assert.match(preload, /Object\.freeze\(\{[\s\S]*getInfo:/u);
  assert.match(preload, /resolveReviewedArtifact:/u);
  assert.match(preload, /startTurn:/u);
  assert.match(preload, /subscribeRun:/u);
  assert.match(preload, /cancelRun:/u);
  assert.match(preload, /resolveArtifact:/u);
  assert.match(preload, /resolveCitation:/u);
  assert.match(preload, /contextBridge\.exposeInMainWorld/u);
  assert.match(preload, /workbench\.app\.getInfo\.v1/u);
  assert.match(preload, /workbench\.schematic\.resolveReviewedArtifact\.v1/u);
  for (const channel of [
    "workbench.agent.startTurn.v1",
    "workbench.agent.subscribeRun.v1",
    "workbench.agent.cancelRun.v1",
    "workbench.agent.resolveArtifact.v1",
    "workbench.agent.resolveCitation.v1",
  ]) {
    assert.match(preload, new RegExp(channel.replaceAll(".", "\\."), "u"));
  }
  assert.doesNotMatch(preload, /from\s+["']\.\//u);
  assert.doesNotMatch(preload, /ipcRenderer\.(?:send|once)/u);
  assert.equal((preload.match(/ipcRenderer\.on\(/gu) ?? []).length, 1);
  assert.doesNotMatch(preload, /invoke\s*:\s*/u);
});
