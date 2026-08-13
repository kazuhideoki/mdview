import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  markdownContentHash,
  readDocumentHistory,
  registerHistoryRevision,
  storeHistorySnapshot,
} from "../src/history.mjs";

test("history stores content-addressed snapshots and chronological revisions without duplicate views", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "guide.md");
  const documentId = "0123456789abcdef01234567";
  const before = "# Before\n";
  const after = "# After\n";
  const beforeSnapshot = await storeHistorySnapshot(before, { root });
  const duplicateSnapshot = await storeHistorySnapshot(before, { root });
  const afterSnapshot = await storeHistorySnapshot(after, { root });
  assert.equal(beforeSnapshot.created, true);
  assert.equal(duplicateSnapshot.created, false);
  assert.equal(await readFile(beforeSnapshot.path, "utf8"), before);

  const first = await registerHistoryRevision({
    documentId,
    sourcePath,
    href: "/documents/guide.first.html",
    renderedAt: "2026-08-13T10:00:00.000Z",
    source: "hook",
    sessionId: "session-a",
    turnId: "turn-a",
    beforeContentHash: beforeSnapshot.contentHash,
    contentHash: afterSnapshot.contentHash,
  }, { root });
  const duplicate = await registerHistoryRevision({
    documentId,
    sourcePath,
    href: "/documents/guide.duplicate.html",
    renderedAt: "2026-08-13T10:01:00.000Z",
    source: "manual",
    sessionId: null,
    turnId: null,
    beforeContentHash: beforeSnapshot.contentHash,
    contentHash: afterSnapshot.contentHash,
  }, { root });
  const reverted = await registerHistoryRevision({
    documentId,
    sourcePath,
    href: "/documents/guide.reverted.html",
    renderedAt: "2026-08-13T10:02:00.000Z",
    source: "hook",
    sessionId: "session-a",
    turnId: "turn-b",
    beforeContentHash: afterSnapshot.contentHash,
    contentHash: markdownContentHash(before),
  }, { root });

  assert.equal(first.added, true);
  assert.equal(duplicate.added, false);
  assert.equal(reverted.added, true);
  const history = await readDocumentHistory(documentId, { root });
  assert.equal(history.revisions.length, 2);
  assert.deepEqual(history.revisions.map((revision) => revision.href), [
    "/documents/guide.first.html",
    "/documents/guide.reverted.html",
  ]);
});
