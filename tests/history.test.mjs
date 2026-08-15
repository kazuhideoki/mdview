import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findHistoryRevisionByHref,
  markdownContentHash,
  readDocumentHistory,
  readHistoryRawDiff,
  readHistorySnapshot,
  registerHistoryRevision,
  storeHistoryRawDiff,
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
  await writeFile(beforeSnapshot.path, "corrupt snapshot\n");
  await assert.rejects(readHistorySnapshot(beforeSnapshot.contentHash, { root }), { code: "HISTORY_SNAPSHOT_CORRUPT" });
  const repairedSnapshot = await storeHistorySnapshot(before, { root });
  assert.equal(repairedSnapshot.repaired, true);
  assert.equal(await readHistorySnapshot(beforeSnapshot.contentHash, { root }), before);

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
    meta: { repo: "docs", branch: "main", relativePath: "guide.md", repoRoot: root },
  }, { root });
  await storeHistoryRawDiff(documentId, first.revision.id, "-# Before\n+# After", { root });
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
  assert.deepEqual(history.revisions[0].meta, {
    repo: "docs",
    branch: "main",
    head: null,
    worktree: null,
    relativePath: "guide.md",
    repoRoot: root,
    workspaceId: null,
    workspaceRevisionId: null,
    localAssets: null,
  });
  assert.equal(await readHistoryRawDiff(documentId, first.revision.id, { root }), "-# Before\n+# After");
  assert.equal((await findHistoryRevisionByHref("/documents/guide.first.html", { root }))?.revision.id, first.revision.id);
  assert.equal(await findHistoryRevisionByHref("/documents/missing.html", { root }), null);
});

test("history accepts revision metadata written before worktree fields existed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-history-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documentId = "fedcba9876543210fedcba98";
  const documents = path.join(root, "documents");
  await mkdir(documents, { recursive: true });
  await writeFile(path.join(documents, `${documentId}.json`), `${JSON.stringify({
    version: 1,
    documentId,
    sourcePath: path.join(root, "legacy.md"),
    revisions: [{
      id: "0123456789abcdef01234567",
      href: "/documents/legacy.html",
      renderedAt: "2026-08-13T10:00:00.000Z",
      source: "hook",
      sessionId: "legacy-session",
      turnId: "legacy-turn",
      beforeContentHash: null,
      contentHash: "a".repeat(64),
      meta: {
        repo: "legacy",
        branch: "detached",
        relativePath: "legacy.md",
        repoRoot: root,
        localAssets: null,
      },
    }],
  }, null, 2)}\n`);
  const history = await readDocumentHistory(documentId, { root });
  assert.equal(history.revisions.length, 1);
  assert.equal(history.revisions[0].meta.head, undefined);
  assert.equal(history.revisions[0].meta.worktree, undefined);
});
