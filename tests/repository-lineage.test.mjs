import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverMergeSources, readWorkspaceLineage } from "../src/repository-lineage.mjs";
import { registerWorkspaceRevision, workspaceHistoryId } from "../src/workspace-history.mjs";

const repositoryId = "a".repeat(24);
const hash = (character) => character.repeat(64);

test("main lineage expands merged worktree sessions at the merge point without duplicating earlier imports", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const featureRoot = path.join(historyRoot, "feature");
  const options = { root: historyRoot };

  const feature1 = await revision(featureRoot, "2026-08-16T10:00:00.000Z", "feature-session-1", "turn-1", hash("b"), [], options);
  const feature2 = await revision(featureRoot, "2026-08-16T11:00:00.000Z", "feature-session-2", "turn-2", hash("c"), [], options);
  const main1 = await revision(mainRoot, "2026-08-16T09:00:00.000Z", "main-session", "turn-1", hash("a"), [], options);
  const main2 = await revision(mainRoot, "2026-08-16T12:00:00.000Z", "merge-session", "turn-2", hash("c"), [{
    workspaceId: workspaceHistoryId(featureRoot),
    throughRevisionId: feature2.revision.id,
    reason: "git-ancestry",
    sourceWorktree: "feature/docs",
    sourceBranch: "feature/docs",
    sourceHead: "bbbbbbb",
  }], options);
  const feature3 = await revision(featureRoot, "2026-08-16T13:00:00.000Z", "feature-session-3", "turn-3", hash("d"), [], options);
  const main3 = await revision(mainRoot, "2026-08-16T14:00:00.000Z", "merge-session", "turn-3", hash("d"), [{
    workspaceId: workspaceHistoryId(featureRoot),
    throughRevisionId: feature3.revision.id,
    reason: "snapshot-match",
  }], options);

  const lineage = await readWorkspaceLineage(workspaceHistoryId(mainRoot), options);
  assert.deepEqual(lineage.nodes.map(({ workspaceId, revision: item }) => [workspaceId, item.id]), [
    [workspaceHistoryId(mainRoot), main1.revision.id],
    [workspaceHistoryId(featureRoot), feature1.revision.id],
    [workspaceHistoryId(featureRoot), feature2.revision.id],
    [workspaceHistoryId(mainRoot), main2.revision.id],
    [workspaceHistoryId(featureRoot), feature3.revision.id],
    [workspaceHistoryId(mainRoot), main3.revision.id],
  ]);
  assert.deepEqual(lineage.nodes.map((node) => node.imported), [false, true, true, false, true, false]);
});

test("a stale merge reference never expands source revisions beyond its missing boundary", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-stale-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const featureRoot = path.join(historyRoot, "feature");
  const options = { root: historyRoot };
  await revision(featureRoot, "2026-08-16T10:00:00.000Z", "feature-session", "turn-1", hash("b"), [], options);
  const main = await revision(mainRoot, "2026-08-16T11:00:00.000Z", "main-session", "turn-1", hash("b"), [{
    workspaceId: workspaceHistoryId(featureRoot),
    throughRevisionId: "f".repeat(24),
    reason: "git-ancestry",
  }], options);

  const lineage = await readWorkspaceLineage(workspaceHistoryId(mainRoot), options);
  assert.deepEqual(lineage.nodes.map((node) => node.revision.id), [main.revision.id]);
});

test("snapshot provenance links a recent worktree when its Markdown delta appears in the destination", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-discovery-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const featureRoot = path.join(historyRoot, "feature");
  const options = { root: historyRoot };
  const main = await revision(mainRoot, "2026-08-16T09:00:00.000Z", "main-session", "turn-1", hash("a"), [], options);
  const feature = await revision(featureRoot, "2026-08-16T10:00:00.000Z", "feature-session", "turn-1", hash("b"), [], options);

  const sources = await discoverMergeSources({
    destination: main.manifest,
    destinationRoot: mainRoot,
    currentFiles: { "README.md": hash("b") },
    currentMeta: { repositoryId, commit: "c".repeat(40), parents: [] },
    renderedAt: "2026-08-16T11:00:00.000Z",
  }, {
    ...options,
    histories: [main.manifest, feature.manifest],
    execFile: async () => {
      const error = new Error("not an ancestor");
      error.code = 1;
      throw error;
    },
  });

  assert.deepEqual(sources, [{
    workspaceId: workspaceHistoryId(featureRoot),
    throughRevisionId: feature.revision.id,
    reason: "snapshot-match",
    sourceWorktree: "feature/docs",
    sourceBranch: "feature/docs",
    sourceHead: "bbbbbbb",
  }]);
});

test("snapshot provenance compares a legacy candidate through its resolved projection", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-projected-candidate-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const featureRoot = path.join(historyRoot, "feature");
  const options = { root: historyRoot };
  const main = await revision(mainRoot, "2026-08-16T09:00:00.000Z", "main-session", "turn-1", hash("a"), [], options);
  const feature = await revision(featureRoot, "2026-08-16T10:00:00.000Z", "feature-session", "turn-1", hash("d"), [], options);

  const sources = await discoverMergeSources({
    destination: main.manifest,
    destinationRoot: mainRoot,
    currentFiles: { "README.md": hash("b") },
    currentMeta: { repositoryId, commit: "c".repeat(40), parents: [] },
    renderedAt: "2026-08-16T11:00:00.000Z",
  }, {
    ...options,
    histories: [main.manifest, feature.manifest],
    resolveCandidateFiles: async (candidate) => (
      candidate.id === feature.revision.id ? { "README.md": hash("b") } : candidate.files
    ),
    execFile: async () => {
      const error = new Error("not an ancestor");
      error.code = 1;
      throw error;
    },
  });

  assert.equal(sources[0].throughRevisionId, feature.revision.id);
  assert.equal(sources[0].reason, "snapshot-match");
});

test("Git ancestry never imports a candidate whose Markdown snapshot is absent from the destination", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-ancestry-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const featureRoot = path.join(historyRoot, "feature");
  const options = { root: historyRoot };
  const main = await revision(mainRoot, "2026-08-16T09:00:00.000Z", "main-session", "turn-1", hash("a"), [], options);
  const feature = await revision(featureRoot, "2026-08-16T10:00:00.000Z", "feature-session", "turn-1", hash("b"), [], options);
  const featureCommit = "c".repeat(40);
  feature.manifest.revisions[0].meta.commit = featureCommit;
  const firstParent = "a".repeat(40);
  const secondParent = "c".repeat(40);

  const sources = await discoverMergeSources({
    destination: main.manifest,
    destinationRoot: mainRoot,
    currentFiles: { "README.md": hash("d") },
    currentMeta: { repositoryId, commit: "d".repeat(40), parents: [firstParent, secondParent] },
    renderedAt: "2026-08-16T11:00:00.000Z",
  }, {
    ...options,
    histories: [main.manifest, feature.manifest],
    execFile: async (_command, args) => {
      if (args.at(-1) === secondParent) return { stdout: "" };
      const error = new Error("not an ancestor");
      error.code = 1;
      throw error;
    },
  });

  assert.deepEqual(sources, []);
});

test("Git ancestry records provenance when the merged Markdown snapshot is already unchanged", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-ancestry-same-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const featureRoot = path.join(historyRoot, "feature");
  const options = { root: historyRoot };
  const main = await revision(mainRoot, "2026-08-16T09:00:00.000Z", "main-session", "turn-1", hash("b"), [], options);
  const feature = await revision(featureRoot, "2026-08-16T10:00:00.000Z", "feature-session", "turn-1", hash("b"), [], options);
  const featureCommit = "b".repeat(40);
  feature.manifest.revisions[0].meta.commit = featureCommit;

  const sources = await discoverMergeSources({
    destination: main.manifest,
    destinationRoot: mainRoot,
    currentFiles: { "README.md": hash("b") },
    currentMeta: { repositoryId, commit: "d".repeat(40), parents: ["a".repeat(40), featureCommit] },
    renderedAt: "2026-08-16T11:00:00.000Z",
  }, {
    ...options,
    histories: [main.manifest, feature.manifest],
    execFile: async (_command, args) => {
      if (args.at(-1) === featureCommit) return { stdout: "" };
      const error = new Error("not an ancestor");
      error.code = 1;
      throw error;
    },
  });

  assert.equal(sources.length, 1);
  assert.equal(sources[0].reason, "git-ancestry");
  assert.equal(sources[0].throughRevisionId, feature.revision.id);
});

test("identical snapshot candidates are not guessed without unique Git ancestry", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-ambiguous-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const featureRoot = path.join(historyRoot, "feature");
  const otherRoot = path.join(historyRoot, "other");
  const options = { root: historyRoot };
  const main = await revision(mainRoot, "2026-08-16T09:00:00.000Z", "main", "turn-1", hash("a"), [], options);
  const feature = await revision(featureRoot, "2026-08-16T10:00:00.000Z", "feature", "turn-1", hash("b"), [], options);
  const other = await revision(otherRoot, "2026-08-16T10:30:00.000Z", "other", "turn-1", hash("b"), [], options);

  const sources = await discoverMergeSources({
    destination: main.manifest,
    destinationRoot: mainRoot,
    currentFiles: { "README.md": hash("b") },
    currentMeta: { repositoryId, commit: "d".repeat(40), parents: [] },
    renderedAt: "2026-08-16T11:00:00.000Z",
  }, {
    ...options,
    histories: [main.manifest, feature.manifest, other.manifest],
    execFile: async () => { throw new Error("not an ancestor"); },
  });

  assert.deepEqual(sources, []);
});

test("a unique merged-parent candidate disambiguates identical ancestor snapshots", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-richest-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const featureRoot = path.join(historyRoot, "feature");
  const integrationRoot = path.join(historyRoot, "integration");
  const duplicateRoot = path.join(historyRoot, "duplicate");
  const options = { root: historyRoot };
  const main = await revision(mainRoot, "2026-08-16T09:00:00.000Z", "main", "turn-1", hash("a"), [], options);
  const feature = await revision(featureRoot, "2026-08-16T10:00:00.000Z", "feature", "turn-1", hash("b"), [], options);
  const integration = await revision(integrationRoot, "2026-08-16T10:30:00.000Z", "integration", "turn-1", hash("b"), [{
    workspaceId: feature.manifest.workspaceId,
    throughRevisionId: feature.revision.id,
    reason: "git-ancestry",
  }], options);
  const duplicate = await revision(duplicateRoot, "2026-08-16T10:45:00.000Z", "duplicate", "turn-1", hash("b"), [], options);
  integration.manifest.revisions[0].meta.commit = "b".repeat(40);
  duplicate.manifest.revisions[0].meta.commit = "e".repeat(40);

  const secondParent = "b".repeat(40);
  const sources = await discoverMergeSources({
    destination: main.manifest,
    destinationRoot: mainRoot,
    currentFiles: { "README.md": hash("b") },
    currentMeta: { repositoryId, commit: "d".repeat(40), parents: ["a".repeat(40), secondParent] },
    renderedAt: "2026-08-16T11:00:00.000Z",
  }, {
    ...options,
    histories: [main.manifest, integration.manifest, duplicate.manifest],
    execFile: async (_command, args) => {
      const ancestor = args.at(-2);
      const descendant = args.at(-1);
      if (ancestor === "b".repeat(40) && descendant === secondParent) return { stdout: "" };
      if (ancestor === "e".repeat(40) && descendant === "d".repeat(40)) return { stdout: "" };
      throw new Error("not an ancestor");
    },
  });

  assert.equal(sources.length, 1);
  assert.equal(sources[0].workspaceId, integration.manifest.workspaceId);
  assert.equal(sources[0].throughRevisionId, integration.revision.id);
});

test("identical merged-parent candidates remain ambiguous", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-parent-ambiguous-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const leftRoot = path.join(historyRoot, "left");
  const rightRoot = path.join(historyRoot, "right");
  const options = { root: historyRoot };
  const main = await revision(mainRoot, "2026-08-16T09:00:00.000Z", "main", "turn-1", hash("a"), [], options);
  const left = await revision(leftRoot, "2026-08-16T10:00:00.000Z", "left", "turn-1", hash("b"), [], options);
  const right = await revision(rightRoot, "2026-08-16T10:30:00.000Z", "right", "turn-1", hash("b"), [], options);
  left.manifest.revisions[0].meta.commit = "b".repeat(40);
  right.manifest.revisions[0].meta.commit = "b".repeat(40);

  const secondParent = "b".repeat(40);
  const sources = await discoverMergeSources({
    destination: main.manifest,
    destinationRoot: mainRoot,
    currentFiles: { "README.md": hash("b") },
    currentMeta: { repositoryId, commit: "d".repeat(40), parents: ["a".repeat(40), secondParent] },
    renderedAt: "2026-08-16T11:00:00.000Z",
  }, {
    ...options,
    histories: [main.manifest, left.manifest, right.manifest],
    execFile: async (_command, args) => {
      if (args.at(-2) === secondParent && args.at(-1) === secondParent) return { stdout: "" };
      throw new Error("not an ancestor");
    },
  });

  assert.deepEqual(sources, []);
});

test("merge discovery walks back past a newer unmerged source revision", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-walk-back-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const featureRoot = path.join(historyRoot, "feature");
  const options = { root: historyRoot };
  const main = await revision(mainRoot, "2026-08-16T09:00:00.000Z", "main", "turn-1", hash("a"), [], options);
  const merged = await revision(featureRoot, "2026-08-16T10:00:00.000Z", "feature", "turn-1", hash("b"), [], options);
  const unmerged = await revision(featureRoot, "2026-08-16T10:30:00.000Z", "feature", "turn-2", hash("c"), [], options);
  merged.manifest.revisions[0].meta.commit = "b".repeat(40);
  unmerged.manifest.revisions[0].meta.commit = "b".repeat(40);
  unmerged.manifest.revisions[1].meta.commit = "c".repeat(40);

  const secondParent = "b".repeat(40);
  const sources = await discoverMergeSources({
    destination: main.manifest,
    destinationRoot: mainRoot,
    currentFiles: { "README.md": hash("b") },
    currentMeta: { repositoryId, commit: "d".repeat(40), parents: ["a".repeat(40), secondParent] },
    renderedAt: "2026-08-16T11:00:00.000Z",
  }, {
    ...options,
    histories: [main.manifest, unmerged.manifest],
    execFile: async (_command, args) => {
      if (args.at(-2) === secondParent && args.at(-1) === secondParent) return { stdout: "" };
      throw new Error("not an ancestor");
    },
  });

  assert.equal(sources.length, 1);
  assert.equal(sources[0].throughRevisionId, merged.revision.id);
});

test("lineage skips corrupt and cross-repository source manifests with warnings", async (t) => {
  const historyRoot = await mkdtemp(path.join(os.tmpdir(), "mdview-lineage-warnings-"));
  t.after(() => rm(historyRoot, { recursive: true, force: true }));
  const mainRoot = path.join(historyRoot, "main");
  const featureRoot = path.join(historyRoot, "feature");
  const otherRoot = path.join(historyRoot, "other");
  const options = { root: historyRoot };
  const feature = await revision(featureRoot, "2026-08-16T10:00:00.000Z", "feature", "turn-1", hash("b"), [], options);
  const other = await revision(otherRoot, "2026-08-16T10:30:00.000Z", "other", "turn-1", hash("c"), [], options);
  other.manifest.revisions[0].meta.repositoryId = "c".repeat(24);
  await writeFile(path.join(historyRoot, "workspaces", `${other.manifest.workspaceId}.json`), `${JSON.stringify(other.manifest)}\n`);
  const main = await revision(mainRoot, "2026-08-16T11:00:00.000Z", "main", "turn-1", hash("c"), [
    { workspaceId: feature.manifest.workspaceId, throughRevisionId: feature.revision.id, reason: "git-ancestry" },
    { workspaceId: other.manifest.workspaceId, throughRevisionId: other.revision.id, reason: "git-ancestry" },
  ], options);
  await writeFile(path.join(historyRoot, "workspaces", `${feature.manifest.workspaceId}.json`), "{broken");

  const lineage = await readWorkspaceLineage(main.manifest.workspaceId, options);
  assert.deepEqual(lineage.nodes.map((node) => node.revision.id), [main.revision.id]);
  assert.deepEqual(lineage.warnings.toSorted((left, right) => left.code.localeCompare(right.code)), [
    { workspaceId: feature.manifest.workspaceId, code: "manifest-corrupt" },
    { workspaceId: other.manifest.workspaceId, code: "repository-mismatch" },
  ].toSorted((left, right) => left.code.localeCompare(right.code)));
});

async function revision(root, renderedAt, sessionId, turnId, contentHash, mergeSources, options) {
  return registerWorkspaceRevision({
    root,
    renderedAt,
    source: "hook",
    sessionId,
    turnId,
    meta: {
      repo: "repo",
      worktree: root.endsWith("feature") ? "feature/docs" : "repo",
      branch: root.endsWith("feature") ? "feature/docs" : "main",
      head: root.endsWith("feature") ? "bbbbbbb" : "aaaaaaa",
      repositoryId,
    },
    files: { "README.md": contentHash },
    changes: [],
    mergeSources,
  }, options);
}
