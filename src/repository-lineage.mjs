import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveGitRepositoryContext } from "./codex-context.mjs";
import {
  readWorkspaceHistories,
  readWorkspaceHistory,
  workspaceFilesEqual,
} from "./workspace-history.mjs";

const execFileAsync = promisify(execFile);

export async function discoverMergeSources(input, options = {}) {
  const destination = input.destination;
  const previous = destination?.revisions?.at(-1) || null;
  const repositoryId = input.currentMeta?.repositoryId;
  if (!destination || !repositoryId || !input.destinationRoot) return [];

  const histories = options.histories || await readWorkspaceHistories(options);
  const candidates = [];
  const destinationChanged = !previous || !workspaceFilesEqual(previous.files, input.currentFiles);
  const currentCommit = input.currentMeta?.commit;
  const previousCommit = previous?.meta?.commit;
  const sameCommitMergedParents = !destinationChanged && currentCommit && currentCommit === previousCommit
    ? new Set(mergeBoundaries(input.currentMeta).flatMap((boundary) => boundary.mergedParents))
    : null;
  const renderedLimit = Date.parse(input.renderedAt);
  for (const history of histories) {
    if (history.workspaceId === destination.workspaceId || history.revisions.length === 0) continue;
    let fallbackRepositoryId;
    let resolvedFallbackRepository = false;
    for (const through of [...history.revisions].reverse()) {
      if (Date.parse(through.renderedAt) > renderedLimit) continue;
      if (alreadyIncludes(destination, history, through)) break;
      const candidateCommit = through.meta?.commit || through.meta?.head;
      if (sameCommitMergedParents && !sameCommitMergedParents.has(candidateCommit)) continue;
      if (!through.meta?.repositoryId && !resolvedFallbackRepository) {
        fallbackRepositoryId = (await resolveGitRepositoryContext(history.root, options))?.repositoryId;
        resolvedFallbackRepository = true;
      }
      const candidateRepositoryId = through.meta?.repositoryId || fallbackRepositoryId;
      if (candidateRepositoryId !== repositoryId) continue;

      const ancestryEvidence = await gitAncestryEvidence({
        root: input.destinationRoot,
        currentMeta: input.currentMeta,
        previousMeta: previous?.meta,
        candidateMeta: through.meta,
      }, options);
      if (options.requireMergedParentEvidence && ancestryEvidence === "newly-reachable") continue;
      const snapshotMatch = ancestryEvidence && typeof options.verifyCandidateSnapshot === "function"
        ? await options.verifyCandidateSnapshot(through)
        : matchesSnapshot(previous?.files || null, input.currentFiles, through.files);
      if (!snapshotMatch || (!ancestryEvidence && !destinationChanged)) continue;
      if (!ancestryEvidence && previous && Date.parse(through.renderedAt) < Date.parse(previous.renderedAt)) continue;

      candidates.push({
        workspaceId: history.workspaceId,
        throughRevisionId: through.id,
        reason: ancestryEvidence ? "git-ancestry" : "snapshot-match",
        sourceWorktree: through.meta?.worktree || null,
        sourceBranch: through.meta?.branch || null,
        sourceHead: through.meta?.head || through.meta?.commit?.slice(0, 7) || null,
        renderedAt: through.renderedAt,
        files: through.files,
        ancestryEvidence,
      });
      break;
    }
  }

  const grouped = new Map();
  for (const candidate of candidates.sort(compareCandidates)) {
    const signature = JSON.stringify(candidate.files);
    const matches = grouped.get(signature) || [];
    matches.push(candidate);
    grouped.set(signature, matches);
  }
  const unambiguous = [];
  for (const matches of grouped.values()) {
    if (matches.length === 1) {
      unambiguous.push(matches[0]);
      continue;
    }
    const ancestryMatches = matches.filter((candidate) => candidate.reason === "git-ancestry");
    if (ancestryMatches.length === 1) {
      unambiguous.push(ancestryMatches[0]);
      continue;
    }
    const mergedParentMatches = ancestryMatches.filter((candidate) => candidate.ancestryEvidence === "merged-parent");
    if (mergedParentMatches.length === 1) unambiguous.push(mergedParentMatches[0]);
  }
  return unambiguous.sort(compareCandidates).map(({
    renderedAt: _renderedAt,
    files: _files,
    ancestryEvidence: _ancestryEvidence,
    ...source
  }) => source);
}

export async function readWorkspaceLineage(workspaceId, options = {}) {
  const rootWorkspace = await readWorkspaceHistory(workspaceId, options);
  const cache = new Map([[workspaceId, rootWorkspace]]);
  const nodes = [];
  const seen = new Set();
  const warnings = [];
  const warned = new Set();
  const repositoryId = await repositoryIdForHistory(rootWorkspace, options);

  function warn(id, code) {
    const key = `${id}:${code}`;
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push({ workspaceId: id, code });
  }

  async function load(id) {
    if (!cache.has(id)) {
      let history;
      try {
        history = await readWorkspaceHistory(id, options);
      } catch (error) {
        warn(id, error?.code === "WORKSPACE_MANIFEST_CORRUPT" ? "manifest-corrupt" : "unavailable");
        cache.set(id, null);
        return null;
      }
      if (!history.root) {
        warn(id, "manifest-missing");
        cache.set(id, null);
        return null;
      }
      const candidateRepositoryId = await repositoryIdForHistory(history, options);
      if (!repositoryId || !candidateRepositoryId || candidateRepositoryId !== repositoryId) {
        warn(id, candidateRepositoryId ? "repository-mismatch" : "repository-unverified");
        cache.set(id, null);
        return null;
      }
      cache.set(id, history);
    }
    return cache.get(id);
  }

  async function appendHistory(history, throughRevisionId = null, ancestry = new Set(), provenance = null) {
    if (!history?.root || ancestry.has(history.workspaceId)) return;
    const nextAncestry = new Set(ancestry).add(history.workspaceId);
    const throughIndex = throughRevisionId
      ? history.revisions.findIndex((revision) => revision.id === throughRevisionId)
      : history.revisions.length - 1;
    if (throughIndex < 0) return;
    for (const revision of history.revisions.slice(0, throughIndex + 1)) {
      for (const source of revision.mergeSources || []) {
        const sourceHistory = await load(source.workspaceId);
        await appendHistory(sourceHistory, source.throughRevisionId, nextAncestry, source);
      }
      const key = `${history.workspaceId}:${revision.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        nodes.push({
          workspaceId: history.workspaceId,
          workspace: history,
          revision,
          imported: history.workspaceId !== workspaceId,
          lineageReason: provenance?.reason || null,
        });
      }
    }
  }

  await appendHistory(rootWorkspace);
  return { rootWorkspace, nodes, warnings };
}

function alreadyIncludes(destination, sourceHistory, through) {
  const throughIndex = sourceHistory.revisions.findIndex((revision) => revision.id === through.id);
  return destination.revisions.some((revision) => (revision.mergeSources || []).some((source) => {
    if (source.workspaceId !== sourceHistory.workspaceId) return false;
    const includedIndex = sourceHistory.revisions.findIndex((candidate) => candidate.id === source.throughRevisionId);
    return includedIndex >= throughIndex;
  }));
}

async function gitAncestryEvidence(input, options) {
  const candidate = input.candidateMeta?.commit || input.candidateMeta?.head;
  const current = input.currentMeta?.commit || input.currentMeta?.head;
  const previous = input.previousMeta?.commit || input.previousMeta?.head;
  if (!candidate || !current) return null;
  for (const boundary of mergeBoundaries(input.currentMeta)) {
    const mergedParents = Array.isArray(boundary?.mergedParents) ? boundary.mergedParents : [];
    if (!boundary?.firstParent || mergedParents.length === 0) continue;
    if (mergedParents.includes(candidate)) return "merged-parent";
  }
  if (current === previous) return null;
  const reachesCurrent = await isAncestor(input.root, candidate, current, options);
  const alreadyReached = previous ? await isAncestor(input.root, candidate, previous, options) : false;
  return reachesCurrent && !alreadyReached ? "newly-reachable" : null;
}

function mergeBoundaries(meta) {
  if (Array.isArray(meta?.mergeBoundaries)) return meta.mergeBoundaries;
  const parents = Array.isArray(meta?.parents) ? meta.parents : [];
  return parents.length > 1 ? [{ firstParent: parents[0], mergedParents: parents.slice(1) }] : [];
}

async function isAncestor(root, ancestor, descendant, options) {
  const run = options.execFile || execFileAsync;
  try {
    await run("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: root,
      encoding: "utf8",
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function matchesSnapshot(previousFiles, currentFiles, candidateFiles) {
  if (workspaceFilesEqual(currentFiles, candidateFiles)) return true;
  if (!previousFiles) return false;
  const paths = new Set([...Object.keys(previousFiles), ...Object.keys(candidateFiles)]);
  const candidateDelta = [...paths].filter((relativePath) => previousFiles[relativePath] !== candidateFiles[relativePath]);
  return candidateDelta.length > 0
    && candidateDelta.every((relativePath) => currentFiles[relativePath] === candidateFiles[relativePath]);
}

function compareCandidates(left, right) {
  const timeOrder = Date.parse(left.renderedAt) - Date.parse(right.renderedAt);
  return timeOrder || left.workspaceId.localeCompare(right.workspaceId);
}

async function repositoryIdForHistory(history, options) {
  const stored = [...(history?.revisions || [])].reverse()
    .find((revision) => revision.meta?.repositoryId)?.meta.repositoryId;
  if (stored) return stored;
  return history?.root ? (await resolveGitRepositoryContext(history.root, options))?.repositoryId || null : null;
}
