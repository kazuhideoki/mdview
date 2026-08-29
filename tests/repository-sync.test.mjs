import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveGitRepositoryContext } from "../src/codex-context.mjs";
import { readHistorySnapshot, storeHistorySnapshot } from "../src/history.mjs";
import { readWorkspaceLineage } from "../src/repository-lineage.mjs";
import { primaryWorktreeRoot, reconcilePrimaryWorkspace, reconcileWorkspaceRoot } from "../src/repository-sync.mjs";
import { readWorkspaceHistoryForRoot, registerWorkspaceRevision } from "../src/workspace-history.mjs";

const run = promisify(execFile);
const digest = (contents) => createHash("sha256").update(contents).digest("hex");

test("repository sync dereferences tracked Markdown symlinks like live workspace scans", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mdview-repository-symlink-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyRoot = path.join(directory, "history");
  const mainRoot = path.join(directory, "repo");
  await mkdir(mainRoot);
  await git(mainRoot, ["init", "-b", "main"]);
  await git(mainRoot, ["config", "user.name", "mdview test"]);
  await git(mainRoot, ["config", "user.email", "mdview@example.test"]);

  const readme = "# Repository\n";
  await writeFile(path.join(mainRoot, "README.md"), readme);
  await git(mainRoot, ["add", "README.md"]);
  await git(mainRoot, ["commit", "-m", "base"]);
  const baseContext = await resolveGitRepositoryContext(mainRoot);
  await storeHistorySnapshot(readme, { root: historyRoot });
  await registerWorkspaceRevision({
    root: mainRoot,
    renderedAt: "2026-08-28T12:00:00.000Z",
    source: "hook",
    sessionId: "base-session",
    turnId: "base-turn",
    meta: gitMeta(mainRoot, "main", baseContext),
    files: { "README.md": digest(readme) },
    changes: [],
  }, { root: historyRoot });

  const instructions = "# Development\n\nShared instructions.\n";
  await mkdir(path.join(mainRoot, "stow-shared"));
  await mkdir(path.join(mainRoot, "stow", "claude", ".claude"), { recursive: true });
  await mkdir(path.join(mainRoot, "stow", "codex", ".codex"), { recursive: true });
  await writeFile(path.join(mainRoot, "stow-shared", "INSTRUCTIONS.md"), instructions);
  await symlink("stow-shared", path.join(mainRoot, "shared-alias"));
  await symlink("../../../stow-shared/INSTRUCTIONS.md", path.join(mainRoot, "stow", "claude", ".claude", "CLAUDE.md"));
  await symlink("../../../shared-alias/INSTRUCTIONS.md", path.join(mainRoot, "stow", "codex", ".codex", "AGENTS.md"));
  await git(mainRoot, ["add", "shared-alias", "stow-shared/INSTRUCTIONS.md", "stow/claude/.claude/CLAUDE.md", "stow/codex/.codex/AGENTS.md"]);
  await git(mainRoot, ["commit", "-m", "add shared instructions"]);

  const reconciled = await reconcileWorkspaceRoot(mainRoot, {
    historyRoot,
    now: Date.parse("2026-08-28T13:00:00.000Z"),
  });
  assert.equal(reconciled.action, "reconciled");
  assert.equal(reconciled.revision.files["stow-shared/INSTRUCTIONS.md"], digest(instructions));
  assert.equal(reconciled.revision.files["stow/claude/.claude/CLAUDE.md"], digest(instructions));
  assert.equal(reconciled.revision.files["stow/codex/.codex/AGENTS.md"], digest(instructions));
  assert.equal(await readHistorySnapshot(digest(instructions), { root: historyRoot }), instructions);
});

test("repository sync migrates stored symlink payloads without reporting a document change", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mdview-repository-symlink-migration-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyRoot = path.join(directory, "history");
  const mainRoot = path.join(directory, "repo");
  await mkdir(mainRoot);
  await git(mainRoot, ["init", "-b", "main"]);
  await git(mainRoot, ["config", "user.name", "mdview test"]);
  await git(mainRoot, ["config", "user.email", "mdview@example.test"]);

  const before = "# Before\n";
  const after = "# After\n";
  const instructions = "# Shared\n";
  const linkTarget = "../shared/INSTRUCTIONS.md";
  await mkdir(path.join(mainRoot, "config"));
  await mkdir(path.join(mainRoot, "shared"));
  await writeFile(path.join(mainRoot, "README.md"), before);
  await writeFile(path.join(mainRoot, "shared", "INSTRUCTIONS.md"), instructions);
  await symlink(linkTarget, path.join(mainRoot, "config", "AGENTS.md"));
  await git(mainRoot, ["add", "README.md", "shared/INSTRUCTIONS.md", "config/AGENTS.md"]);
  await git(mainRoot, ["commit", "-m", "base"]);
  const baseContext = await resolveGitRepositoryContext(mainRoot);
  for (const contents of [before, instructions, linkTarget]) {
    await storeHistorySnapshot(contents, { root: historyRoot });
  }
  await registerWorkspaceRevision({
    root: mainRoot,
    renderedAt: "2026-08-28T12:00:00.000Z",
    source: "repository-sync",
    sessionId: null,
    turnId: null,
    meta: gitMeta(mainRoot, "main", baseContext),
    files: {
      "README.md": digest(before),
      "config/AGENTS.md": digest(linkTarget),
      "shared/INSTRUCTIONS.md": digest(instructions),
    },
    changes: [],
  }, { root: historyRoot });

  await writeFile(path.join(mainRoot, "README.md"), after);
  await git(mainRoot, ["add", "README.md"]);
  await git(mainRoot, ["commit", "-m", "edit readme"]);
  const reconciled = await reconcileWorkspaceRoot(mainRoot, {
    historyRoot,
    now: Date.parse("2026-08-28T13:00:00.000Z"),
  });

  assert.deepEqual(reconciled.revision.changes, [{
    path: "README.md",
    kind: "modified",
    beforeContentHash: digest(before),
    contentHash: digest(after),
  }]);
  assert.equal(reconciled.revision.files["config/AGENTS.md"], digest(instructions));
});

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

test("repository sync compares a legacy primary history with the merge first parent", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mdview-repository-legacy-baseline-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyRoot = path.join(directory, "history");
  const mainRoot = path.join(directory, "repo");
  const featureRoot = path.join(directory, "feature");
  await mkdir(mainRoot);
  await git(mainRoot, ["init", "-b", "main"]);
  await git(mainRoot, ["config", "user.name", "mdview test"]);
  await git(mainRoot, ["config", "user.email", "mdview@example.test"]);

  const readmeBefore = "# Before\n";
  const readmeAfter = "# After\n";
  const agents = "# Agents\n";
  const editorial = "# Editorial\n";
  await writeFile(path.join(mainRoot, "README.md"), readmeBefore);
  await writeFile(path.join(mainRoot, "AGENTS.md"), agents);
  await writeFile(path.join(mainRoot, "editorial.md"), editorial);
  await git(mainRoot, ["add", "README.md", "AGENTS.md", "editorial.md"]);
  await git(mainRoot, ["commit", "-m", "base"]);

  await storeHistorySnapshot(editorial, { root: historyRoot });
  await registerWorkspaceRevision({
    root: mainRoot,
    renderedAt: "2026-08-25T09:00:00.000Z",
    source: "legacy-migration",
    sessionId: "legacy-session",
    turnId: "legacy-turn",
    meta: { repo: "repo", worktree: "repo", branch: "unknown", head: null },
    files: { "editorial.md": digest(editorial) },
    changes: [{ path: "editorial.md", beforeContentHash: null, contentHash: digest(editorial) }],
  }, { root: historyRoot });

  await git(mainRoot, ["worktree", "add", "-b", "feature/docs", featureRoot]);
  await writeFile(path.join(featureRoot, "README.md"), readmeAfter);
  await git(featureRoot, ["add", "README.md"]);
  await git(featureRoot, ["commit", "-m", "edit readme"]);
  const featureContext = await resolveGitRepositoryContext(featureRoot);
  for (const contents of [readmeAfter, agents, editorial]) await storeHistorySnapshot(contents, { root: historyRoot });
  await registerWorkspaceRevision({
    root: featureRoot,
    renderedAt: "2026-08-25T10:00:00.000Z",
    source: "hook",
    sessionId: "feature-session",
    turnId: "feature-turn",
    meta: gitMeta(featureRoot, "feature/docs", featureContext),
    files: {
      "AGENTS.md": digest(agents),
      "README.md": digest(readmeAfter),
      "editorial.md": digest(editorial),
    },
    changes: [{ path: "README.md", beforeContentHash: digest(readmeBefore), contentHash: digest(readmeAfter) }],
  }, { root: historyRoot });

  await git(mainRoot, ["merge", "--no-ff", "feature/docs", "-m", "merge feature"]);
  const reconciled = await reconcileWorkspaceRoot(mainRoot, {
    historyRoot,
    now: Date.parse("2026-08-25T11:00:00.000Z"),
  });

  assert.deepEqual(reconciled.revision.changes, [{
    path: "README.md",
    kind: "modified",
    beforeContentHash: digest(readmeBefore),
    contentHash: digest(readmeAfter),
  }]);
  assert.equal(await readHistorySnapshot(digest(readmeBefore), { root: historyRoot }), readmeBefore);
  assert.equal(reconciled.revision.mergeSources.length, 1);
});

test("repository sync preserves a complete commitless hook snapshot as its baseline", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mdview-repository-commitless-hook-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyRoot = path.join(directory, "history");
  const mainRoot = path.join(directory, "repo");
  await mkdir(mainRoot);
  await git(mainRoot, ["init", "-b", "main"]);
  await git(mainRoot, ["config", "user.name", "mdview test"]);
  await git(mainRoot, ["config", "user.email", "mdview@example.test"]);

  const committedBefore = "# Committed before\n";
  const hookSnapshot = "# Complete hook snapshot\n";
  const committedAfter = "# Committed after\n";
  await writeFile(path.join(mainRoot, "README.md"), committedBefore);
  await git(mainRoot, ["add", "README.md"]);
  await git(mainRoot, ["commit", "-m", "base"]);
  await storeHistorySnapshot(hookSnapshot, { root: historyRoot });
  await registerWorkspaceRevision({
    root: mainRoot,
    renderedAt: "2026-08-25T09:00:00.000Z",
    source: "hook",
    sessionId: "hook-session",
    turnId: "hook-turn",
    meta: { repo: "repo", worktree: "repo", branch: "main", head: null },
    files: { "README.md": digest(hookSnapshot) },
    changes: [],
  }, { root: historyRoot });

  await writeFile(path.join(mainRoot, "README.md"), committedAfter);
  await git(mainRoot, ["add", "README.md"]);
  await git(mainRoot, ["commit", "-m", "change readme"]);
  const reconciled = await reconcileWorkspaceRoot(mainRoot, {
    historyRoot,
    now: Date.parse("2026-08-25T10:00:00.000Z"),
  });

  assert.deepEqual(reconciled.revision.changes, [{
    path: "README.md",
    kind: "modified",
    beforeContentHash: digest(hookSnapshot),
    contentHash: digest(committedAfter),
  }]);
});

test("repository sync marks a legacy snapshot without lineage discovery when a non-merge HEAD is already recorded", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mdview-repository-same-head-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyRoot = path.join(directory, "history");
  const mainRoot = path.join(directory, "main");
  const commonDir = path.join(directory, "git-common");
  await mkdir(mainRoot);
  await mkdir(commonDir);
  const repositoryId = createHash("sha256").update(commonDir).digest("hex").slice(0, 24);
  const parentCommit = "a".repeat(40);
  const currentCommit = "d".repeat(40);
  const contents = "# Current\n";
  const recorded = await registerWorkspaceRevision({
    root: mainRoot,
    renderedAt: "2026-08-25T10:00:00.000Z",
    source: "repository-sync",
    sessionId: null,
    turnId: null,
    meta: {
      repo: "repo",
      worktree: "repo",
      branch: "main",
      head: currentCommit.slice(0, 7),
      repositoryId,
      commit: currentCommit,
      parents: [parentCommit],
    },
    files: { "README.md": digest(contents) },
    changes: [],
  }, { root: historyRoot });
  const gitCalls = [];
  const execFile = async (_command, args) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { stdout: `${commonDir}\n` };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${currentCommit}\n` };
    if (args[0] === "rev-list" && args[1] === "--parents") return { stdout: `${currentCommit} ${parentCommit}\n` };
    if (args[0] === "ls-tree" && args.at(-1) === currentCommit) {
      return { stdout: `100644 blob ${"e".repeat(40)}\tREADME.md\0` };
    }
    if (args[0] === "cat-file" && args.at(-1) === `${currentCommit}:README.md`) return { stdout: contents };
    throw new Error(`Unexpected Git call: ${args.join(" ")}`);
  };

  const reconciled = await reconcileWorkspaceRoot(mainRoot, {
    historyRoot,
    now: Date.parse("2026-08-25T11:00:00.000Z"),
    execFile,
  });

  assert.equal(reconciled.action, "reconciled");
  assert.notEqual(reconciled.revision.id, recorded.revision.id);
  assert.equal(reconciled.revision.meta.markdownSnapshot, "resolved-v1");
  assert.deepEqual(reconciled.revision.changes, []);
  assert.equal(gitCalls.filter((args) => args[0] === "rev-parse" && args[1] === "--git-common-dir").length, 1);
  assert.equal(gitCalls.filter((args) => args[0] === "branch").length, 1);
  assert.equal(gitCalls.filter((args) => args[0] === "merge-base").length, 0);
  assert.equal(gitCalls.filter((args) => args[0] === "rev-list" && args[1] === "--first-parent").length, 0);
});

test("repository sync can attach a source history that appears after the primary HEAD was recorded", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mdview-repository-late-source-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const historyRoot = path.join(directory, "history");
  const mainRoot = path.join(directory, "main");
  const featureRoot = path.join(directory, "feature");
  const unrelatedRoot = path.join(directory, "unrelated");
  const commonDir = path.join(directory, "git-common");
  await mkdir(mainRoot);
  await mkdir(featureRoot);
  await mkdir(unrelatedRoot);
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
  await registerWorkspaceRevision({
    root: unrelatedRoot,
    renderedAt: "2026-08-25T10:30:00.000Z",
    source: "hook",
    sessionId: "unrelated-session",
    turnId: "unrelated-turn",
    meta: {
      repo: "repo",
      worktree: "unrelated/docs",
      branch: "unrelated/docs",
      head: "c".repeat(7),
      commit: "c".repeat(40),
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
    if (args[0] === "ls-tree" && [mergeCommit, mergedCommit].includes(args.at(-1))) {
      return { stdout: `100644 blob ${"e".repeat(40)}\tREADME.md\0` };
    }
    if (args[0] === "cat-file" && [`${mergeCommit}:README.md`, `${mergedCommit}:README.md`].includes(args.at(-1))) return { stdout: contents };
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
  assert.equal(gitCalls.filter((args) => args[0] === "ls-tree" && args.at(-1) === mergeCommit).length, 1);
  assert.equal(gitCalls.filter((args) => args[0] === "rev-parse" && args[1] === "--git-common-dir").length, 1);
  assert.equal(gitCalls.filter((args) => args[0] === "merge-base").length, 0);
  assert.equal(gitCalls.filter((args) => args[0] === "rev-list" && args[1] === "--first-parent").length, 0);
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
