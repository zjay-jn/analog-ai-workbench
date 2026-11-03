import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedFrameUrl,
  isTrustedIpcCaller,
} from "../apps/desktop/src/main/security/ipc-caller";

const allowed = ["file:///C:/work/analog_ai_workbench/dist/renderer/index.html"];

test("approved top-frame caller is accepted", () => {
  assert.equal(
    isTrustedIpcCaller({
      senderId: 4,
      expectedSenderId: 4,
      isTopFrame: true,
      frameUrl: `${allowed[0]}#start`,
      allowedFrameUrls: allowed,
    }),
    true,
  );
});

test("wrong sender, subframe and wrong origin are rejected", () => {
  const baseline = {
    senderId: 4,
    expectedSenderId: 4,
    isTopFrame: true,
    frameUrl: allowed[0] ?? "",
    allowedFrameUrls: allowed,
  };
  assert.equal(isTrustedIpcCaller({ ...baseline, senderId: 9 }), false);
  assert.equal(isTrustedIpcCaller({ ...baseline, isTopFrame: false }), false);
  assert.equal(
    isTrustedIpcCaller({ ...baseline, frameUrl: "https://example.com/" }),
    false,
  );
});

test("frame URL comparison is exact except for hash and search", () => {
  assert.equal(isAllowedFrameUrl(`${allowed[0]}?a=1#b`, allowed), true);
  assert.equal(
    isAllowedFrameUrl(
      "file:///C:/work/analog_ai_workbench/dist/renderer/other.html",
      allowed,
    ),
    false,
  );
});
