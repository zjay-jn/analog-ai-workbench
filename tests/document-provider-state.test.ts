import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenedDocumentState,
  createOpeningDocumentState,
  InvalidDocumentTransitionError,
  reduceDocumentProviderState,
} from "../apps/desktop/src/shared/document/document-provider-state";

test("open and content changes deterministically move between clean and dirty", () => {
  const opening = createOpeningDocumentState();
  const clean = reduceDocumentProviderState(opening, {
    type: "OPEN_SUCCEEDED",
    revisionId: "revision-1",
    contentDigest: "sha256:baseline",
  });
  const dirty = reduceDocumentProviderState(clean, {
    type: "CONTENT_CHANGED",
    contentDigest: "sha256:changed",
  });
  const restored = reduceDocumentProviderState(dirty, {
    type: "CONTENT_CHANGED",
    contentDigest: "sha256:baseline",
  });

  assert.equal(clean.status, "clean");
  assert.equal(dirty.status, "dirty");
  assert.equal(dirty.dirty, true);
  assert.equal(restored.status, "clean");
  assert.equal(restored.dirty, false);
});

test("save failure never clears dirty and success requires the working digest", () => {
  const clean = createOpenedDocumentState({
    revisionId: "revision-1",
    contentDigest: "sha256:baseline",
  });
  const dirty = reduceDocumentProviderState(clean, {
    type: "CONTENT_CHANGED",
    contentDigest: "sha256:changed",
  });
  const saving = reduceDocumentProviderState(dirty, { type: "SAVE_STARTED" });
  const failed = reduceDocumentProviderState(saving, {
    type: "SAVE_FAILED",
    errorCode: "SAVE_FAILED",
  });

  assert.equal(failed.status, "error");
  assert.equal(failed.dirty, true);
  assert.throws(
    () =>
      reduceDocumentProviderState(saving, {
        type: "SAVE_SUCCEEDED",
        revisionId: "revision-2",
        contentDigest: "sha256:not-the-working-content",
      }),
    InvalidDocumentTransitionError,
  );

  const succeeded = reduceDocumentProviderState(saving, {
    type: "SAVE_SUCCEEDED",
    revisionId: "revision-2",
    contentDigest: "sha256:changed",
  });
  assert.equal(succeeded.status, "clean");
  assert.equal(succeeded.dirty, false);
  assert.equal(succeeded.revisionId, "revision-2");
});

test("conflict and close flows fail closed around dirty content", () => {
  const dirty = reduceDocumentProviderState(
    createOpenedDocumentState({
      revisionId: "revision-1",
      contentDigest: "sha256:baseline",
    }),
    { type: "CONTENT_CHANGED", contentDigest: "sha256:changed" },
  );
  const checking = reduceDocumentProviderState(dirty, {
    type: "CHECK_STARTED",
  });
  const conflict = reduceDocumentProviderState(checking, {
    type: "CHECK_CONFLICT",
  });
  const closePending = reduceDocumentProviderState(conflict, {
    type: "CLOSE_REQUESTED",
  });
  const cancelled = reduceDocumentProviderState(closePending, {
    type: "CLOSE_CANCELLED",
  });

  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.dirty, true);
  assert.equal(closePending.status, "close_pending");
  assert.equal(cancelled.status, "dirty");
  assert.equal(cancelled.dirty, true);
});

test("invalid transitions are rejected without a fallback state", () => {
  const clean = createOpenedDocumentState({
    revisionId: "revision-1",
    contentDigest: "sha256:baseline",
  });
  assert.throws(
    () => reduceDocumentProviderState(clean, { type: "SAVE_STARTED" }),
    (error: unknown) =>
      error instanceof InvalidDocumentTransitionError &&
      error.status === "clean" &&
      error.eventType === "SAVE_STARTED",
  );
});
