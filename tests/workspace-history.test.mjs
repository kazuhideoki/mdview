import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readerWorkspaceChanges,
  readWorkspaceHistories,
  readWorkspaceHistory,
  registerWorkspaceRevision,
  workspaceDocumentId,
  workspaceFileAtRevision,
  workspaceHistoryId,
} from "../src/workspace-history.mjs";

test("reader changes span repository sync revisions hidden between work turns", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-workspace-reader-changes-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const root = path.join(historyRoot, "repo");
  const withHarlequin = "a".repeat(64);
  const withoutHarlequin = "b".repeat(64);
  const notes = "c".repeat(64);

  const first = await registerWorkspaceRevision({
    root,
    renderedAt: "2026-08-28T13:05:20.700Z",
    source: "hook",
    sessionId: "session-1",
    turnId: "turn-1",
    files: { "README.md": withHarlequin },
    changes: [{ path: "README.md", beforeContentHash: null, contentHash: withHarlequin }],
  }, { root: historyRoot });
  await registerWorkspaceRevision({
    root,
    renderedAt: "2026-08-29T04:18:37.237Z",
    source: "repository-sync",
    files: { "README.md": withoutHarlequin },
    changes: [{ path: "README.md", beforeContentHash: withHarlequin, contentHash: withoutHarlequin }],
  }, { root: historyRoot });
  const current = await registerWorkspaceRevision({
    root,
    renderedAt: "2026-08-29T04:27:46.950Z",
    source: "hook",
    sessionId: "session-2",
    turnId: "turn-2",
    files: { "NOTES.md": notes, "README.md": withoutHarlequin },
    changes: [{ path: "NOTES.md", beforeContentHash: null, contentHash: notes }],
  }, { root: historyRoot });

  assert.deepEqual(readerWorkspaceChanges(current.manifest, current.revision.id), [
    { path: "NOTES.md", kind: "added", beforeContentHash: null, contentHash: notes },
    { path: "README.md", kind: "modified", beforeContentHash: withHarlequin, contentHash: withoutHarlequin },
  ]);
  assert.deepEqual(readerWorkspaceChanges(current.manifest, first.revision.id), first.revision.changes);
});

test("workspace history stores complete Markdown snapshots and turn changes", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-workspace-history-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const root = path.join(historyRoot, "repo");
  const workspaceId = workspaceHistoryId(root);
  const before = "a".repeat(64);
  const after = "b".repeat(64);
  const unchanged = "c".repeat(64);

  const stored = await registerWorkspaceRevision({
    root,
    renderedAt: "2026-08-15T10:00:00.000Z",
    source: "hook",
    sessionId: "session-1",
    turnId: "turn-1",
    meta: { repo: "repo", worktree: "feature/docs", branch: "feature/docs", head: "abc1234" },
    files: { "README.md": after, "doc/unchanged.md": unchanged },
    changes: [{ path: "README.md", beforeContentHash: before, contentHash: after }],
  }, { root: historyRoot });

  assert.equal(stored.added, true);
  assert.equal(stored.manifest.workspaceId, workspaceId);
  assert.deepEqual(stored.revision.changes, [{
    path: "README.md",
    kind: "modified",
    beforeContentHash: before,
    contentHash: after,
  }]);
  const manifest = await readWorkspaceHistory(workspaceId, { root: historyRoot });
  assert.equal(manifest.root, root);
  assert.deepEqual(Object.keys(manifest.revisions[0].files), ["doc/unchanged.md", "README.md"]);

  const documentId = workspaceDocumentId(root, "README.md");
  assert.deepEqual(workspaceFileAtRevision(manifest, stored.revision.id, documentId), {
    workspaceId,
    root,
    revision: manifest.revisions[0],
    relativePath: "README.md",
    contentHash: after,
    change: manifest.revisions[0].changes[0],
  });
  assert.equal((await readWorkspaceHistories({ root: historyRoot }))[0].workspaceId, workspaceId);
});

test("workspace history preserves identical snapshots from distinct turns and deduplicates retries", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-workspace-deduplicate-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const root = path.join(historyRoot, "repo");
  const files = { "README.md": "d".repeat(64) };
  const first = await registerWorkspaceRevision({
    root,
    renderedAt: "2026-08-15T10:00:00.000Z",
    source: "hook",
    sessionId: "session-1",
    turnId: "turn-1",
    files,
    changes: [],
  }, { root: historyRoot });
  const second = await registerWorkspaceRevision({
    root,
    renderedAt: "2026-08-15T11:00:00.000Z",
    source: "hook",
    sessionId: "session-2",
    turnId: "turn-2",
    files,
    changes: [],
  }, { root: historyRoot });
  const retry = await registerWorkspaceRevision({
    root,
    renderedAt: "2026-08-15T12:00:00.000Z",
    source: "hook",
    sessionId: "session-2",
    turnId: "turn-2",
    files,
    changes: [],
  }, { root: historyRoot });

  assert.equal(first.added, true);
  assert.equal(second.added, true);
  assert.notEqual(second.revision.id, first.revision.id);
  assert.equal(retry.added, false);
  assert.equal(retry.revision.id, second.revision.id);
  assert.equal(retry.revision.renderedAt, second.revision.renderedAt);
  assert.equal((await readWorkspaceHistory(workspaceHistoryId(root), { root: historyRoot })).revisions.length, 2);
});

test("a corrupt workspace manifest is rejected and never overwritten", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-workspace-corrupt-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const root = path.join(historyRoot, "repo");
  const workspaceId = workspaceHistoryId(root);
  await registerWorkspaceRevision({
    root,
    renderedAt: "2026-08-15T10:00:00.000Z",
    source: "manual",
    files: { "README.md": "a".repeat(64) },
    changes: [],
  }, { root: historyRoot });
  const manifestPath = path.join(historyRoot, "workspaces", `${workspaceId}.json`);
  await writeFile(manifestPath, "{broken");

  await assert.rejects(readWorkspaceHistory(workspaceId, { root: historyRoot }), { code: "WORKSPACE_MANIFEST_CORRUPT" });
  await assert.rejects(registerWorkspaceRevision({
    root,
    renderedAt: "2026-08-15T11:00:00.000Z",
    source: "manual",
    files: { "README.md": "b".repeat(64) },
    changes: [],
  }, { root: historyRoot }), { code: "WORKSPACE_MANIFEST_CORRUPT" });
  assert.equal(await readFile(manifestPath, "utf8"), "{broken");
});

test("workspace history records added and deleted Markdown paths", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-workspace-changes-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const root = path.join(historyRoot, "repo");
  const added = "e".repeat(64);
  const deleted = "f".repeat(64);
  const result = await registerWorkspaceRevision({
    root,
    renderedAt: "2026-08-15T10:00:00.000Z",
    source: "hook",
    sessionId: "session-1",
    turnId: "turn-1",
    files: { "added.md": added },
    changes: [
      { path: "added.md", beforeContentHash: null, contentHash: added },
      { path: "deleted.md", beforeContentHash: deleted, contentHash: null },
    ],
  }, { root: historyRoot });
  assert.deepEqual(result.revision.changes.map(({ path: file, kind }) => [file, kind]), [
    ["added.md", "added"],
    ["deleted.md", "deleted"],
  ]);
});
