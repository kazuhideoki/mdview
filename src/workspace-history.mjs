import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { catalogEntryId } from "./catalog.mjs";
import { historyRoot as defaultHistoryRoot } from "./paths.mjs";

const WORKSPACE_HISTORY_VERSION = 1;
const ID_PATTERN = /^[a-f0-9]{24}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function workspaceHistoryId(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new TypeError("Workspace history requires an absolute root.");
  }
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
}

export function workspaceRevisionId({ workspaceId, renderedAt, sessionId, turnId, source, meta, files, changes, mergeSources }) {
  validateId(workspaceId);
  if (!Number.isFinite(Date.parse(renderedAt))) throw new TypeError("Workspace revision requires renderedAt.");
  return createHash("sha256")
    .update(JSON.stringify({
      workspaceId,
      source: source || "",
      sessionId: sessionId || null,
      turnId: turnId || null,
      meta: meta || null,
      files: files || {},
      changes: changes || [],
      mergeSources: mergeSources || [],
    }))
    .digest("hex")
    .slice(0, 24);
}

export function workspaceDocumentId(root, relativePath) {
  validateRelativePath(relativePath);
  return catalogEntryId(path.join(path.resolve(root), ...relativePath.split("/")));
}

export async function readWorkspaceHistory(workspaceId, options = {}) {
  validateId(workspaceId);
  try {
    const record = JSON.parse(await readFile(manifestPath(workspaceId, options), "utf8"));
    return normalizeManifest(record, workspaceId);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyManifest(workspaceId);
    if (error?.code === "WORKSPACE_MANIFEST_CORRUPT") throw error;
    const corrupt = new Error(`Workspace history manifest is corrupt: ${workspaceId}`, { cause: error });
    corrupt.code = "WORKSPACE_MANIFEST_CORRUPT";
    throw corrupt;
  }
}

export async function readWorkspaceHistoryForRoot(root, options = {}) {
  return readWorkspaceHistory(workspaceHistoryId(path.resolve(root)), options);
}

export async function readWorkspaceHistories(options = {}) {
  const directory = workspaceDirectory(options);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
  const histories = await Promise.allSettled(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && ID_PATTERN.test(path.basename(entry.name, ".json")))
    .map((entry) => readWorkspaceHistory(path.basename(entry.name, ".json"), options)));
  return histories
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((history) => history.root && history.revisions.length > 0)
    .sort((left, right) => {
      const timeOrder = Date.parse(right.revisions.at(-1).renderedAt) - Date.parse(left.revisions.at(-1).renderedAt);
      return timeOrder || left.workspaceId.localeCompare(right.workspaceId);
    });
}

export async function registerWorkspaceRevision(input, options = {}) {
  const root = path.resolve(input.root);
  const workspaceId = input.workspaceId || workspaceHistoryId(root);
  validateId(workspaceId);
  if (workspaceId !== workspaceHistoryId(root)) throw new TypeError("Workspace id does not match root.");
  const revision = normalizeRevisionInput({ ...input, root, workspaceId });

  return withWorkspaceLock(workspaceId, options, async () => {
    const current = await readWorkspaceHistory(workspaceId, options);
    if (current.root && current.root !== root) throw new TypeError("Workspace history root does not match.");
    const duplicate = current.revisions.find((candidate) => candidate.id === revision.id);
    if (duplicate) {
      if (!revisionsEquivalent(duplicate, revision)) {
        const conflict = new Error(`Workspace revision id conflicts with different contents: ${revision.id}`);
        conflict.code = "WORKSPACE_REVISION_CONFLICT";
        throw conflict;
      }
      return { manifest: current, revision: duplicate, added: false };
    }

    const revisions = [...current.revisions, revision].sort(compareRevisions);
    const manifest = {
      version: WORKSPACE_HISTORY_VERSION,
      workspaceId,
      root,
      revisions,
    };
    await atomicWriteJson(manifestPath(workspaceId, options), manifest);
    return { manifest, revision, added: true };
  });
}

export function workspaceFileAtRevision(manifest, revisionId, documentId, options = {}) {
  validateId(revisionId);
  validateId(documentId);
  const revision = manifest?.revisions?.find((candidate) => candidate.id === revisionId);
  if (!revision || !manifest.root) return null;
  const changes = options.changes ?? revision.changes;
  for (const [relativePath, contentHash] of Object.entries(revision.files)) {
    if (workspaceDocumentId(manifest.root, relativePath) !== documentId) continue;
    return {
      workspaceId: manifest.workspaceId,
      root: manifest.root,
      revision,
      relativePath,
      contentHash,
      change: changes.find((candidate) => candidate.path === relativePath) || null,
    };
  }
  for (const change of changes) {
    if (change.kind !== "deleted" || workspaceDocumentId(manifest.root, change.path) !== documentId) continue;
    return {
      workspaceId: manifest.workspaceId,
      root: manifest.root,
      revision,
      relativePath: change.path,
      contentHash: null,
      change,
    };
  }
  return null;
}

export function isReaderWorkspaceRevision(revision) {
  if (revision.source === "repository-sync") return revision.mergeSources.length > 0;
  if (revision.source === "hook") return revision.changes.length > 0 || revision.mergeSources.length > 0;
  return true;
}

export function readerWorkspaceChanges(manifest, revisionId) {
  validateId(revisionId);
  const revisionIndex = manifest?.revisions?.findIndex((candidate) => candidate.id === revisionId) ?? -1;
  if (revisionIndex < 0) return [];
  const revision = manifest.revisions[revisionIndex];
  const previous = manifest.revisions
    .slice(0, revisionIndex)
    .reverse()
    .find(isReaderWorkspaceRevision);
  if (!previous) return revision.changes;
  return workspaceChanges(previous.files, revision.files);
}

function workspaceChanges(previous, current) {
  const paths = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...paths]
    .filter((relativePath) => previous[relativePath] !== current[relativePath])
    .map((relativePath) => {
      const beforeContentHash = previous[relativePath] ?? null;
      const contentHash = current[relativePath] ?? null;
      return {
        path: relativePath,
        kind: beforeContentHash === null ? "added" : contentHash === null ? "deleted" : "modified",
        beforeContentHash,
        contentHash,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeRevisionInput(input) {
  for (const field of ["renderedAt", "source"]) {
    if (typeof input[field] !== "string" || !input[field]) throw new TypeError(`Workspace revision requires ${field}.`);
  }
  if (!Number.isFinite(Date.parse(input.renderedAt))) throw new TypeError("Workspace revision requires renderedAt.");
  for (const field of ["sessionId", "turnId"]) {
    if (input[field] !== null && input[field] !== undefined && (typeof input[field] !== "string" || !input[field])) {
      throw new TypeError(`Workspace revision ${field} must be a non-empty string or null.`);
    }
  }
  const files = normalizeFiles(input.files);
  const changes = normalizeChanges(input.changes ?? [], files);
  const mergeSources = normalizeMergeSources(input.mergeSources ?? [], input.workspaceId);
  const meta = normalizeMeta(input.meta, input.root);
  const id = input.id || workspaceRevisionId({
    workspaceId: input.workspaceId,
    renderedAt: input.renderedAt,
    sessionId: input.sessionId,
    turnId: input.turnId,
    source: input.source,
    meta,
    files,
    changes,
    mergeSources,
  });
  validateId(id);
  return {
    id,
    renderedAt: input.renderedAt,
    source: input.source,
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
    meta,
    files,
    changes,
    mergeSources,
  };
}

function normalizeManifest(record, workspaceId) {
  if (!record || record.version !== WORKSPACE_HISTORY_VERSION || record.workspaceId !== workspaceId) {
    throw new TypeError("Workspace history manifest identity is invalid.");
  }
  const root = typeof record.root === "string" && path.isAbsolute(record.root) ? path.resolve(record.root) : null;
  if (!root || workspaceHistoryId(root) !== workspaceId) throw new TypeError("Workspace history root is invalid.");
  if (!Array.isArray(record.revisions)) throw new TypeError("Workspace history revisions are invalid.");
  const revisions = record.revisions.map((revision) => normalizeStoredRevision(revision, root)).sort(compareRevisions);
  return { version: WORKSPACE_HISTORY_VERSION, workspaceId, root, revisions };
}

function normalizeStoredRevision(revision, root) {
  validateId(revision.id);
  return {
    ...normalizeRevisionInput({
      ...revision,
      id: revision.id,
      root,
      workspaceId: workspaceHistoryId(root),
    }),
  };
}

function normalizeFiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Workspace revision files must be an object.");
  }
  const entries = Object.entries(value).map(([relativePath, contentHash]) => {
    validateRelativePath(relativePath);
    validateHash(contentHash);
    return [relativePath, contentHash];
  }).sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function normalizeChanges(value, files) {
  if (!Array.isArray(value)) throw new TypeError("Workspace revision changes must be an array.");
  return value.map((change) => {
    if (!change || typeof change !== "object") throw new TypeError("Workspace change must be an object.");
    validateRelativePath(change.path);
    const beforeContentHash = change.beforeContentHash ?? null;
    const contentHash = change.contentHash ?? null;
    if (beforeContentHash !== null) validateHash(beforeContentHash);
    if (contentHash !== null) validateHash(contentHash);
    if (contentHash !== null && files[change.path] !== contentHash) {
      throw new TypeError("Workspace change does not match the revision files.");
    }
    const kind = beforeContentHash === null ? "added" : contentHash === null ? "deleted" : "modified";
    if (change.kind && change.kind !== kind) throw new TypeError("Workspace change kind does not match its hashes.");
    return { path: change.path, kind, beforeContentHash, contentHash };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeMeta(value, root) {
  const meta = value && typeof value === "object" ? value : {};
  const normalized = {
    repo: typeof meta.repo === "string" && meta.repo ? meta.repo : path.basename(root),
    worktree: typeof meta.worktree === "string" && meta.worktree ? meta.worktree : path.basename(root),
    branch: typeof meta.branch === "string" && meta.branch ? meta.branch : "detached",
    head: typeof meta.head === "string" && /^[a-f0-9]+$/i.test(meta.head) ? meta.head : null,
  };
  if (typeof meta.repositoryId === "string" && ID_PATTERN.test(meta.repositoryId)) normalized.repositoryId = meta.repositoryId;
  if (typeof meta.commit === "string" && /^[a-f0-9]{40}$/i.test(meta.commit)) normalized.commit = meta.commit;
  if (Array.isArray(meta.parents)) {
    normalized.parents = meta.parents.filter((parent) => typeof parent === "string" && /^[a-f0-9]{40}$/i.test(parent));
  }
  if (meta.markdownSnapshot === "resolved-v1") normalized.markdownSnapshot = meta.markdownSnapshot;
  return normalized;
}

function normalizeMergeSources(value, destinationWorkspaceId) {
  if (!Array.isArray(value)) throw new TypeError("Workspace merge sources must be an array.");
  const sources = value.map((source) => {
    if (!source || typeof source !== "object") throw new TypeError("Workspace merge source must be an object.");
    validateId(source.workspaceId);
    validateId(source.throughRevisionId);
    if (source.workspaceId === destinationWorkspaceId) throw new TypeError("Workspace cannot merge its own history.");
    if (!["git-ancestry", "snapshot-match"].includes(source.reason)) {
      throw new TypeError("Workspace merge source reason is invalid.");
    }
    return {
      workspaceId: source.workspaceId,
      throughRevisionId: source.throughRevisionId,
      reason: source.reason,
      sourceWorktree: typeof source.sourceWorktree === "string" && source.sourceWorktree ? source.sourceWorktree : null,
      sourceBranch: typeof source.sourceBranch === "string" && source.sourceBranch ? source.sourceBranch : null,
      sourceHead: typeof source.sourceHead === "string" && /^[a-f0-9]+$/i.test(source.sourceHead) ? source.sourceHead : null,
    };
  });
  return sources;
}

function validateRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) {
    throw new TypeError("Workspace file requires a portable relative path.");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new TypeError("Workspace file path must stay inside the workspace.");
  }
  if (!/[.](?:md|markdown)$/i.test(normalized)) throw new TypeError("Workspace file must be Markdown.");
}

function validateId(value) {
  if (!ID_PATTERN.test(value)) throw new TypeError("Invalid workspace history id.");
}

function validateHash(value) {
  if (!HASH_PATTERN.test(value)) throw new TypeError("Invalid workspace content hash.");
}

export function workspaceFilesEqual(left, right) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([relativePath, contentHash], index) => (
      rightEntries[index]?.[0] === relativePath && rightEntries[index]?.[1] === contentHash
    ));
}

function revisionsEquivalent(left, right) {
  return left.source === right.source
    && left.sessionId === right.sessionId
    && left.turnId === right.turnId
    && JSON.stringify(left.meta) === JSON.stringify(right.meta)
    && workspaceFilesEqual(left.files, right.files)
    && JSON.stringify(left.changes) === JSON.stringify(right.changes)
    && JSON.stringify(left.mergeSources) === JSON.stringify(right.mergeSources);
}

function compareRevisions(left, right) {
  const timeOrder = Date.parse(left.renderedAt) - Date.parse(right.renderedAt);
  return timeOrder || left.id.localeCompare(right.id);
}

function emptyManifest(workspaceId) {
  return { version: WORKSPACE_HISTORY_VERSION, workspaceId, root: null, revisions: [] };
}

function resolveRoot(options) {
  return path.resolve(options.root || defaultHistoryRoot());
}

function workspaceDirectory(options) {
  return path.join(resolveRoot(options), "workspaces");
}

function manifestPath(workspaceId, options) {
  return path.join(workspaceDirectory(options), `${workspaceId}.json`);
}

async function atomicWriteJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function withWorkspaceLock(workspaceId, options, operation) {
  const lockPath = path.join(workspaceDirectory(options), `.${workspaceId}.lock`);
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 99) throw error;
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 5 * 60 * 1000) {
          await unlink(lockPath);
          continue;
        }
      } catch (staleError) {
        if (staleError?.code !== "ENOENT") throw staleError;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await operation();
  } finally {
    await handle?.close();
    await unlink(lockPath).catch(() => {});
  }
}
