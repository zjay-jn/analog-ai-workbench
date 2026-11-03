import assert from "node:assert/strict";
import test from "node:test";
import {
  createGetInfoResult,
  isGetInfoRequest,
  isGetInfoResult,
} from "../apps/desktop/src/main/ipc/get-info-contract";

test("getInfo request accepts only an empty object", () => {
  assert.equal(isGetInfoRequest({}), true);
  assert.equal(isGetInfoRequest({ unexpected: true }), false);
  assert.equal(isGetInfoRequest(null), false);
  assert.equal(isGetInfoRequest(""), false);
});

test("getInfo returns the frozen Phase 1 envelope", () => {
  const result = createGetInfoResult({
    request: {},
    appVersion: "0.1.0-alpha.0",
    mode: "test",
  });
  assert.equal(result.ok, true);
  assert.equal(isGetInfoResult(result), true);
  if (result.ok) {
    assert.deepEqual(result.value, {
      contractVersion: "workbench.app.getInfo.v1",
      appName: "Analog AI Workbench",
      appVersion: "0.1.0-alpha.0",
      phase: "phase1",
      mode: "test",
      platform: "win32",
    });
  }
});

test("invalid getInfo input returns a safe error without internals", () => {
  const result = createGetInfoResult({
    request: { path: "C:\\not-allowed" },
    appVersion: "0.1.0-alpha.0",
    mode: "test",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_REQUEST");
    assert.equal("stack" in result.error, false);
    assert.equal("path" in result.error, false);
  }
});
