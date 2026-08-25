import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveGitRepositoryContext } from "../src/codex-context.mjs";
import { storeHistorySnapshot } from "../src/history.mjs";
import { readWorkspaceLineage } from "../src/repository-lineage.mjs";
import { primaryWorktreeRoot, reconcilePrimaryWorkspace, reconcileWorkspaceRoot } from "../src/repository-sync.mjs";
import { readWorkspaceHistoryForRoot, registerWorkspaceRevision } from "../src/workspace-history.mjs";

const run = promisify(execFile);
const digest = (contents) => createHash("sha256").update(contents).digest("hex");

test("repository sync appends merged worktree lineage to the primary workspace", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mdview-repository-sync-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyRoot = path.join(directory, "history");
  const mainRoot = path.join(directory, "repo");
  const featureRoot = path.join(directory, "feature");
  await mkdir(mainRoot);
  await git(mainRoot, ["init", "-b", "main"]);
  await git(mainRoot, ["config", "user.name", "mdview test"]);
  await git(mainRoot, ["config", "user.email", "mdview@example.test"]);

  const base = "# Before\n";
  const feature1 = "# Feature one\n";
  const feature2 = "# Feature two\n";
  await writeFile(path.join(mainRoot, "README.md"), base);
  await git(mainRoot, ["add", "README.md"]);
  await git(mainRoot, ["commit", "-m", "base"]);
  const baseContext = await resolveGitRepositoryContext(mainRoot);
  await storeHistorySnapshot(base, { root: historyRoot });
  await registerWorkspaceRevision({
    root: mainRoot,
    renderedAt: "2026-08-25T09:00:00.000Z",
    source: "hook",
    sessionId: "main-session",
    turnId: "main-turn",
    meta: gitMeta(mainRoot, "main", baseContext),
    files: { "README.md": digest(base) },
    changes: [],
  }, { root: historyRoot });

  await git(mainRoot, ["worktree", "add", "-b", "feature/docs", featureRoot]);
  await writeFile(path.join(featureRoot, "README.md"), feature1);
  await git(featureRoot, ["add", "README.md"]);
  await git(featureRoot, ["commit", "-m", "feature one"]);
  const feature1Context = await resolveGitRepositoryContext(featureRoot);
  await storeHistorySnapshot(feature1, { root: historyRoot });
  await registerWorkspaceRevision({
    root: featureRoot,
    renderedAt: "2026-08-25T10:00:00.000Z",
    source: "hook",
    sessionId: "feature-session-1",
    turnId: "feature-turn-1",
    meta: gitMeta(featureRoot, "feature/docs", feature1Context),
    files: { "README.md": digest(feature1) },
    changes: [{ path: "README.md", beforeContentHash: digest(base), contentHash: digest(feature1) }],
  }, { root: historyRoot });

  await writeFile(path.join(featureRoot, "README.md"), feature2);
  await git(featureRoot, ["add", "README.md"]);
  await git(featureRoot, ["commit", "-m", "feature two"]);
  const feature2Context = await resolveGitRepositoryContext(featureRoot);
  await storeHistorySnapshot(feature2, { root: historyRoot });
  const featureHistory = await registerWorkspaceRevision({
    root: featureRoot,
    renderedAt: "2026-08-25T11:00:00.000Z",
    source: "hook",
    sessionId: "feature-session-2",
    turnId: "feature-turn-2",
    meta: gitMeta(featureRoot, "feature/docs", feature2Context),
    files: { "README.md": digest(feature2) },
    changes: [{ path: "README.md", beforeContentHash: digest(feature1), contentHash: digest(feature2) }],
  }, { root: historyRoot });

  await git(mainRoot, ["merge", "--no-ff", "feature/docs", "-m", "merge feature"]);
  assert.equal(await primaryWorktreeRoot(featureRoot), await realpath(mainRoot));
  const reconciled = await reconcilePrimaryWorkspace(featureRoot, {
    historyRoot,
    now: Date.parse("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(reconciled.action, "reconciled");
  assert.equal(reconciled.revision.source, "repository-sync");
  assert.deepEqual(reconciled.revision.mergeSources.map(({ workspaceId, throughRevisionId, reason }) => ({
    workspaceId,
    throughRevisionId,
    reason,
  })), [{
    workspaceId: featureHistory.manifest.workspaceId,
    throughRevisionId: featureHistory.revision.id,
    reason: "git-ancestry",
  }]);

  const mainHistory = await readWorkspaceHistoryForRoot(mainRoot, { root: historyRoot });
  const lineage = await readWorkspaceLineage(mainHistory.workspaceId, { root: historyRoot });
  assert.deepEqual(lineage.nodes.map((node) => node.revision.sessionId), [
    "main-session",
    "feature-session-1",
    "feature-session-2",
    null,
  ]);
  assert.deepEqual(lineage.nodes.map((node) => node.imported), [false, true, true, false]);

  const dirty = "# Uncommitted main edit\n";
  await writeFile(path.join(mainRoot, "README.md"), dirty);
  await storeHistorySnapshot(dirty, { root: historyRoot });
  const mergeContext = await resolveGitRepositoryContext(mainRoot);
  const dirtyRevision = await registerWorkspaceRevision({
    root: mainRoot,
    renderedAt: "2026-08-25T12:30:00.000Z",
    source: "hook",
    sessionId: "main-dirty-session",
    turnId: "main-dirty-turn",
    meta: gitMeta(mainRoot, "main", mergeContext),
    files: { "README.md": digest(dirty) },
    changes: [{ path: "README.md", beforeContentHash: digest(feature2), contentHash: digest(dirty) }],
  }, { root: historyRoot });
  const repeated = await reconcileWorkspaceRoot(mainRoot, {
    historyRoot,
    now: Date.parse("2026-08-25T13:00:00.000Z"),
  });
  assert.equal(repeated.action, "unchanged");
  assert.equal(repeated.revision.id, dirtyRevision.revision.id);
  const preserved = await readWorkspaceHistoryForRoot(mainRoot, { root: historyRoot });
  assert.equal(preserved.revisions.length, 3);
  assert.equal(preserved.revisions.at(-1).files["README.md"], digest(dirty));
});

test("repository sync can attach a source history that appears after the primary HEAD was recorded", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mdview-repository-late-source-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyRoot = path.join(directory, "history");
  const mainRoot = path.join(directory, "main");
  const featureRoot = path.join(directory, "feature");
  const commonDir = path.join(directory, "git-common");
  await mkdir(mainRoot);
  await mkdir(featureRoot);
  await mkdir(commonDir);
  const repositoryId = createHash("sha256").update(commonDir).digest("hex").slice(0, 24);
  const firstParent = "a".repeat(40);
  const mergedCommit = "b".repeat(40);
  const mergeCommit = "d".repeat(40);
  const contents = "# Merged\n";
  const files = { "README.md": digest(contents) };
  await storeHistorySnapshot(contents, { root: historyRoot });
  const main = await registerWorkspaceRevision({
    root: mainRoot,
    renderedAt: "2026-08-25T11:00:00.000Z",
    source: "repository-sync",
    sessionId: null,
    turnId: null,
    meta: {
      repo: "repo",
      worktree: "repo",
      branch: "main",
      head: mergeCommit.slice(0, 7),
      repositoryId,
      commit: mergeCommit,
      parents: [firstParent, mergedCommit],
    },
    files,
    changes: [],
  }, { root: historyRoot });
  const feature = await registerWorkspaceRevision({
    root: featureRoot,
    renderedAt: "2026-08-25T10:00:00.000Z",
    source: "hook",
    sessionId: "late-feature-session",
    turnId: "late-feature-turn",
    meta: {
      repo: "repo",
      worktree: "feature/docs",
      branch: "feature/docs",
      head: mergedCommit.slice(0, 7),
      repositoryId,
      commit: mergedCommit,
      parents: [firstParent],
    },
    files,
    changes: [],
  }, { root: historyRoot });
  const gitCalls = [];
  const execFile = async (_command, args) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { stdout: `${commonDir}\n` };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${mergeCommit}\n` };
    if (args[0] === "rev-list") return { stdout: `${mergeCommit} ${firstParent} ${mergedCommit}\n` };
    if (args[0] === "branch") return { stdout: "main\n" };
    if (args[0] === "ls-tree" && args.at(-1) === mergedCommit) return { stdout: "README.md\0" };
    if (args[0] === "cat-file" && args.at(-1) === `${mergedCommit}:README.md`) return { stdout: contents };
    if (args[0] === "merge-base" && args.at(-2) === mergedCommit && args.at(-1) === mergedCommit) return { stdout: "" };
    throw new Error("not an ancestor");
  };

  const reconciled = await reconcileWorkspaceRoot(mainRoot, {
    historyRoot,
    now: Date.parse("2026-08-25T12:00:00.000Z"),
    execFile,
  });
  assert.equal(reconciled.action, "reconciled");
  assert.deepEqual(reconciled.revision.files, files);
  assert.deepEqual(reconciled.revision.changes, []);
  assert.equal(reconciled.revision.mergeSources[0].workspaceId, feature.manifest.workspaceId);
  assert.equal(reconciled.revision.mergeSources[0].throughRevisionId, feature.revision.id);
  assert.ok(!gitCalls.some((args) => args[0] === "ls-tree" && args.at(-1) === mergeCommit));
  assert.equal((await readWorkspaceHistoryForRoot(mainRoot, { root: historyRoot })).revisions.length, main.manifest.revisions.length + 1);
});

function gitMeta(root, branch, context) {
  return {
    repo: path.basename(root),
    worktree: path.basename(root),
    branch,
    head: context.commit.slice(0, 7),
    repositoryId: context.repositoryId,
    commit: context.commit,
    parents: context.parents,
  };
}

async function git(cwd, args) {
  return run("git", args, { cwd, encoding: "utf8" });
}
