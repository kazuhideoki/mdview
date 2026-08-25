import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveGitRepositoryContext, worktreeLabel } from "./codex-context.mjs";
import { storeHistorySnapshot } from "./history.mjs";
import { discoverMergeSources } from "./repository-lineage.mjs";
import {
  readWorkspaceHistory,
  readWorkspaceHistoryForRoot,
  registerWorkspaceRevision,
  workspaceFilesEqual,
} from "./workspace-history.mjs";

const execFileAsync = promisify(execFile);

export async function reconcileWorkspaceHistory(workspaceId, options = {}) {
  const workspace = await readWorkspaceHistory(workspaceId, historyOptions(options));
  if (!workspace.root) return { manifest: workspace, revision: null, added: false, action: "missing" };
  const primaryRoot = await primaryWorktreeRoot(workspace.root, options);
  if (!primaryRoot || path.resolve(primaryRoot) !== path.resolve(workspace.root)) {
    return { manifest: workspace, revision: workspace.revisions.at(-1) || null, added: false, action: "not-primary" };
  }
  return reconcileWorkspaceRoot(workspace.root, options);
}

export async function reconcilePrimaryWorkspace(sourceRoot, options = {}) {
  const primaryRoot = await primaryWorktreeRoot(sourceRoot, options);
  if (!primaryRoot) return { action: "not-git", added: false, revision: null };
  return reconcileWorkspaceRoot(primaryRoot, options);
}

export async function reconcileWorkspaceRoot(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const stored = historyOptions(options);
  const workspace = await readWorkspaceHistoryForRoot(absoluteRoot, stored);
  const previous = workspace.revisions.at(-1) || null;
  const gitContext = await resolveGitRepositoryContext(absoluteRoot, options);
  if (!gitContext) return { action: "not-git", added: false, revision: null };

  const previousCommit = previous?.meta?.commit || null;
  const sameCommit = previousCommit === gitContext.commit;
  if (previous && sameCommit && gitContext.parents.length <= 1) {
    return { action: "unchanged", manifest: workspace, revision: previous, added: false };
  }

  const branch = await gitText(absoluteRoot, ["branch", "--show-current"], options);
  const mergeBoundaries = sameCommit
    ? [{ firstParent: gitContext.parents[0], mergedParents: gitContext.parents.slice(1) }]
    : await repositoryMergeBoundaries(absoluteRoot, gitContext.commit, previousCommit, options);
  const meta = {
    repo: path.basename(absoluteRoot),
    worktree: worktreeLabel(absoluteRoot) || path.basename(absoluteRoot),
    branch: branch?.trim() || "detached",
    head: gitContext.commit.slice(0, 7),
    repositoryId: gitContext.repositoryId,
    commit: gitContext.commit,
    parents: gitContext.parents,
    mergeBoundaries,
  };
  const renderedAt = new Date(options.now ?? Date.now()).toISOString();
  const committedFiles = new Map();
  let comparisonFiles = previous?.files || {};
  let files;
  if (previous && sameCommit) {
    files = previous.files;
  } else {
    const snapshot = await committedMarkdownSnapshot(absoluteRoot, gitContext.commit, options);
    files = snapshot.files;
    committedFiles.set(gitContext.commit, files);
    await storeCommittedMarkdownSnapshot(snapshot, stored);
  }
  const needsLegacyMergeBaseline = previous?.source === "legacy-migration"
    && !previousCommit
    && gitContext.parents.length > 1;
  if (needsLegacyMergeBaseline) {
    const firstParentSnapshot = await committedMarkdownSnapshot(absoluteRoot, gitContext.parents[0], options);
    comparisonFiles = firstParentSnapshot.files;
    committedFiles.set(gitContext.parents[0], comparisonFiles);
    await storeCommittedMarkdownSnapshot(firstParentSnapshot, stored);
  }
  const filesEqual = previous && workspaceFilesEqual(previous.files, files);
  const mergeSources = previous
    ? await discoverMergeSources({
      destination: workspace,
      destinationRoot: absoluteRoot,
      currentFiles: files,
      currentMeta: meta,
      renderedAt,
    }, {
      ...options,
      ...stored,
      requireMergedParentEvidence: previousCommit === null,
      verifyCandidateSnapshot: async (revision) => {
        const commit = revision.meta?.commit;
        if (!commit) return false;
        if (!committedFiles.has(commit)) {
          try {
            committedFiles.set(commit, (await committedMarkdownSnapshot(absoluteRoot, commit, options)).files);
          } catch {
            return false;
          }
        }
        return workspaceFilesEqual(committedFiles.get(commit), revision.files);
      },
    })
    : [];

  if (filesEqual && mergeSources.length === 0) {
    return { action: "unchanged", manifest: workspace, revision: previous, added: false };
  }

  const result = await registerWorkspaceRevision({
    root: absoluteRoot,
    renderedAt,
    source: "repository-sync",
    sessionId: null,
    turnId: null,
    meta,
    files,
    changes: previous ? workspaceChanges(comparisonFiles, files) : [],
    mergeSources,
  }, stored);
  return { action: result.added ? "reconciled" : "unchanged", ...result };
}

async function repositoryMergeBoundaries(root, currentCommit, previousCommit, options) {
  const output = await gitText(root, ["rev-list", "--first-parent", "--parents", currentCommit], options);
  if (output === null) return [];
  const boundaries = [];
  for (const line of output.trim().split("\n")) {
    const [commit, firstParent, ...mergedParents] = line.trim().split(/\s+/);
    if (!commit) continue;
    if (commit === previousCommit && commit !== currentCommit) break;
    if (firstParent && mergedParents.length > 0) boundaries.push({ firstParent, mergedParents });
    if (commit === previousCommit) break;
  }
  return boundaries;
}

export async function primaryWorktreeRoot(root, options = {}) {
  const output = await gitText(root, ["worktree", "list", "--porcelain", "-z"], options);
  if (!output) return null;
  const entry = output.split("\0").find((value) => value.startsWith("worktree "));
  return entry ? path.resolve(entry.slice("worktree ".length)) : null;
}

async function committedMarkdownSnapshot(root, commit, options) {
  const output = await gitText(root, ["ls-tree", "-r", "-z", "--name-only", commit], options);
  if (output === null) throw new Error(`Unable to read committed files for ${root}.`);
  const relativePaths = output
    .split("\0")
    .filter((relativePath) => /[.](?:md|markdown)$/i.test(relativePath))
    .sort((left, right) => left.localeCompare(right));
  const files = {};
  const contents = {};
  for (const relativePath of relativePaths) {
    const markdown = await gitText(root, ["cat-file", "blob", `${commit}:${relativePath}`], options);
    if (markdown === null) throw new Error(`Unable to read committed Markdown: ${relativePath}`);
    contents[relativePath] = markdown;
    files[relativePath] = createHash("sha256").update(markdown).digest("hex");
  }
  return { files, contents };
}

async function storeCommittedMarkdownSnapshot(snapshot, options) {
  for (const [relativePath, contents] of Object.entries(snapshot.contents)) {
    await storeHistorySnapshot(contents, { ...options, contentHash: snapshot.files[relativePath] });
  }
}

function workspaceChanges(previous, current) {
  const paths = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...paths]
    .filter((relativePath) => previous[relativePath] !== current[relativePath])
    .map((relativePath) => ({
      path: relativePath,
      beforeContentHash: previous[relativePath] ?? null,
      contentHash: current[relativePath] ?? null,
    }));
}

async function gitText(root, args, options) {
  const run = options.execFile || execFileAsync;
  try {
    const { stdout } = await run("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5000,
    });
    return stdout;
  } catch {
    return null;
  }
}

function historyOptions(options) {
  return options.historyRoot ? { root: options.historyRoot } : options.root ? { root: options.root } : {};
}
