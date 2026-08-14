import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { catalogEntryId } from "./catalog.mjs";
import { historyRoot as defaultHistoryRoot } from "./paths.mjs";

const HISTORY_VERSION = 1;
const ID_PATTERN = /^[a-f0-9]{24}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function markdownContentHash(markdown) {
  return createHash("sha256").update(markdown).digest("hex");
}

export function historyRevisionId({ documentId, renderedAt, contentHash, sessionId, turnId }) {
  return createHash("sha256")
    .update(documentId)
    .update("\0")
    .update(renderedAt)
    .update("\0")
    .update(contentHash)
    .update("\0")
    .update(sessionId || "")
    .update("\0")
    .update(turnId || "")
    .digest("hex")
    .slice(0, 24);
}

export function historySnapshotPath(contentHash, options = {}) {
  validateHash(contentHash);
  return path.join(resolveRoot(options), "objects", `${contentHash}.md`);
}

export async function storeHistorySnapshot(markdown, options = {}) {
  const contentHash = options.contentHash || markdownContentHash(markdown);
  if (markdownContentHash(markdown) !== contentHash) {
    throw new TypeError("History snapshot contents do not match contentHash.");
  }
  const target = historySnapshotPath(contentHash, options);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const existing = await readFile(target, "utf8");
    if (markdownContentHash(existing) === contentHash) {
      return { contentHash, path: target, created: false, repaired: false };
    }
    await atomicWrite(target, markdown);
    return { contentHash, path: target, created: false, repaired: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temp, target);
    return { contentHash, path: target, created: true, repaired: false };
  } catch (error) {
    await unlink(temp).catch(() => {});
    if (error?.code === "EEXIST") return { contentHash, path: target, created: false };
    throw error;
  }
}

export async function readDocumentHistory(documentId, options = {}) {
  validateId(documentId);
  const filePath = manifestPath(documentId, options);
  try {
    const record = JSON.parse(await readFile(filePath, "utf8"));
    return normalizeManifest(record, documentId);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { version: HISTORY_VERSION, documentId, sourcePath: null, revisions: [] };
    }
    throw error;
  }
}

export async function readHistorySnapshot(contentHash, options = {}) {
  const contents = await readFile(historySnapshotPath(contentHash, options), "utf8");
  if (markdownContentHash(contents) !== contentHash) {
    const error = new Error(`History snapshot does not match content hash: ${contentHash}`);
    error.code = "HISTORY_SNAPSHOT_CORRUPT";
    throw error;
  }
  return contents;
}

export async function storeHistoryRawDiff(documentId, revisionId, rawDiff, options = {}) {
  validateId(documentId);
  validateId(revisionId);
  if (typeof rawDiff !== "string") throw new TypeError("History raw diff must be a string.");
  const target = rawDiffPath(documentId, revisionId, options);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, rawDiff, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { path: target, created: true };
  } catch (error) {
    if (error?.code === "EEXIST") return { path: target, created: false };
    throw error;
  }
}

export async function readHistoryRawDiff(documentId, revisionId, options = {}) {
  validateId(documentId);
  validateId(revisionId);
  try {
    return await readFile(rawDiffPath(documentId, revisionId, options), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

export async function findHistoryRevisionByHref(href, options = {}) {
  let pathname;
  try {
    const url = new URL(href, "http://mdview.local");
    if (url.origin !== "http://mdview.local" || url.search || url.hash) return null;
    pathname = url.pathname;
  } catch {
    return null;
  }
  const directory = path.join(resolveRoot(options), "documents");
  let files;
  try {
    files = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const documentId = path.basename(file.name, ".json");
    if (!ID_PATTERN.test(documentId)) continue;
    const manifest = await readDocumentHistory(documentId, options);
    const revision = manifest.revisions.find((candidate) => {
      try {
        return new URL(candidate.href, "http://mdview.local").pathname === pathname;
      } catch {
        return false;
      }
    });
    if (revision) return { manifest, revision };
  }
  return null;
}

export async function storeHistoryRenderedHtml(documentId, revisionId, html, options = {}) {
  validateId(documentId);
  validateId(revisionId);
  const target = renderedHtmlPath(documentId, revisionId, options);
  await atomicWrite(target, html);
  return target;
}

export async function restoreHistoryRenderedHtml(revision, options = {}) {
  validateRevision(revision);
  const source = renderedHtmlPath(options.documentId, revision.id, options);
  const cache = path.resolve(options.cacheRoot);
  const url = new URL(revision.href, "http://mdview.local");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const target = path.resolve(cache, ...segments);
  const documents = path.join(cache, "documents");
  if (target === documents || !target.startsWith(`${documents}${path.sep}`)) {
    throw new TypeError("History revision points outside the document cache.");
  }
  try {
    if ((await stat(target)).isFile()) return target;
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  await atomicWrite(target, await readFile(source, "utf8"));
  return target;
}

export async function storeHistoryCacheArtifacts(paths, options = {}) {
  const cache = path.resolve(options.cacheRoot);
  for (const inputPath of paths) {
    await mirrorCacheEntry(inputPath, cache, path.join(resolveRoot(options), "cache-artifacts"));
  }
}

export async function restoreHistoryCacheArtifacts(options = {}) {
  const stored = path.join(resolveRoot(options), "cache-artifacts");
  try {
    await mirrorTree(stored, stored, path.resolve(options.cacheRoot));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function restoreHistoryCacheArtifact(inputPath, options = {}) {
  const cache = path.resolve(options.cacheRoot);
  const absolute = path.resolve(inputPath);
  const relative = path.relative(cache, absolute);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new TypeError("History cache artifact target is outside the cache root.");
  }
  try {
    if ((await stat(absolute)).isFile()) return absolute;
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  const stored = path.join(resolveRoot(options), "cache-artifacts", relative);
  const canonicalStored = await realpath(stored);
  const storedRoot = await realpath(path.join(resolveRoot(options), "cache-artifacts"));
  if (!canonicalStored.startsWith(`${storedRoot}${path.sep}`) || !(await stat(canonicalStored)).isFile()) {
    throw new TypeError("History cache artifact source is invalid.");
  }
  await copyIfMissing(canonicalStored, absolute);
  return absolute;
}

export async function readHistoryForSource(sourcePath, options = {}) {
  return readDocumentHistory(catalogEntryId(sourcePath), options);
}

export async function registerHistoryRevision(input, options = {}) {
  const documentId = input.documentId || catalogEntryId(input.sourcePath);
  validateRevisionInput({ ...input, documentId });
  const current = await readDocumentHistory(documentId, options);
  const revision = {
    id: input.id || historyRevisionId({ ...input, documentId }),
    href: input.href,
    renderedAt: input.renderedAt,
    source: input.source,
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
    beforeContentHash: input.beforeContentHash ?? null,
    contentHash: input.contentHash,
    meta: normalizeRevisionMeta(input.meta),
  };
  validateRevision(revision);
  const duplicate = current.revisions.find((candidate) => candidate.id === revision.id);
  if (duplicate) return { manifest: current, revision: duplicate, added: false };
  const revisions = [...current.revisions, revision].sort(compareRevisions);
  const revisionIndex = revisions.findIndex((candidate) => candidate.id === revision.id);
  const previous = revisions[revisionIndex - 1];
  if (previous?.contentHash === revision.contentHash) {
    return { manifest: current, revision: previous, added: false };
  }
  const manifest = {
    version: HISTORY_VERSION,
    documentId,
    sourcePath: path.resolve(input.sourcePath),
    revisions,
  };
  await atomicWriteJson(manifestPath(documentId, options), manifest);
  return { manifest, revision, added: true };
}

function compareRevisions(left, right) {
  const timeOrder = Date.parse(left.renderedAt) - Date.parse(right.renderedAt);
  if (timeOrder !== 0) return timeOrder;
  return left.id.localeCompare(right.id);
}

function resolveRoot(options) {
  return path.resolve(options.root || defaultHistoryRoot());
}

function manifestPath(documentId, options) {
  return path.join(resolveRoot(options), "documents", `${documentId}.json`);
}

function renderedHtmlPath(documentId, revisionId, options) {
  validateId(documentId);
  return path.join(resolveRoot(options), "rendered", documentId, `${revisionId}.html`);
}

function rawDiffPath(documentId, revisionId, options) {
  return path.join(resolveRoot(options), "diffs", documentId, `${revisionId}.patch`);
}

async function mirrorCacheEntry(inputPath, cacheRoot, targetRoot) {
  const absolute = path.resolve(inputPath);
  const relative = path.relative(cacheRoot, absolute);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new TypeError("History cache artifact is outside the cache root.");
  }
  const info = await stat(absolute);
  if (info.isDirectory()) return mirrorTree(absolute, absolute, path.join(targetRoot, relative));
  if (info.isFile()) return copyIfMissing(absolute, path.join(targetRoot, relative));
}

async function mirrorTree(directory, sourceRoot, targetRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(directory, entry.name);
    const target = path.join(targetRoot, path.relative(sourceRoot, source));
    if (entry.isDirectory()) await mirrorTree(source, sourceRoot, targetRoot);
    else if (entry.isFile()) await copyIfMissing(source, target);
  }
}

async function copyIfMissing(source, target) {
  try {
    if ((await stat(target)).isFile()) return;
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  await atomicWrite(target, await readFile(source));
}

async function atomicWriteJson(filePath, value) {
  return atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWrite(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temp, filePath);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function normalizeManifest(record, documentId) {
  if (!record || record.version !== HISTORY_VERSION || record.documentId !== documentId) {
    return { version: HISTORY_VERSION, documentId, sourcePath: null, revisions: [] };
  }
  const sourcePath = typeof record.sourcePath === "string" && path.isAbsolute(record.sourcePath)
    ? record.sourcePath
    : null;
  const revisions = Array.isArray(record.revisions)
    ? record.revisions.filter((revision) => {
      try {
        validateRevision(revision);
        return true;
      } catch {
        return false;
      }
    })
    : [];
  return { version: HISTORY_VERSION, documentId, sourcePath, revisions };
}

function validateRevisionInput(input) {
  validateId(input.documentId);
  if (typeof input.sourcePath !== "string" || !path.isAbsolute(input.sourcePath)) {
    throw new TypeError("History revision requires an absolute sourcePath.");
  }
  for (const field of ["href", "renderedAt", "source", "contentHash"]) {
    if (typeof input[field] !== "string" || !input[field]) throw new TypeError(`History revision requires ${field}.`);
  }
  validateHash(input.contentHash);
  if (input.beforeContentHash !== null && input.beforeContentHash !== undefined) validateHash(input.beforeContentHash);
}

function validateRevision(revision) {
  validateId(revision.id);
  validateHash(revision.contentHash);
  if (revision.beforeContentHash !== null) validateHash(revision.beforeContentHash);
  if (typeof revision.href !== "string" || !revision.href.startsWith("/documents/") || revision.href.includes("?") || revision.href.includes("#")) {
    throw new TypeError("History revision requires a document href.");
  }
  if (!Number.isFinite(Date.parse(revision.renderedAt))) throw new TypeError("History revision requires renderedAt.");
  if (typeof revision.source !== "string" || !revision.source) throw new TypeError("History revision requires source.");
  for (const field of ["sessionId", "turnId"]) {
    if (revision[field] !== null && (typeof revision[field] !== "string" || !revision[field])) {
      throw new TypeError(`History revision ${field} must be a non-empty string or null.`);
    }
  }
  if (revision.meta !== null && revision.meta !== undefined) validateRevisionMeta(revision.meta);
}

function normalizeRevisionMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const normalized = {
    repo: meta.repo,
    branch: meta.branch,
    head: meta.head || null,
    worktree: meta.worktree || null,
    relativePath: meta.relativePath,
    repoRoot: meta.repoRoot || null,
    localAssets: normalizeLocalAssets(meta.localAssets),
  };
  try {
    validateRevisionMeta(normalized);
    return normalized;
  } catch {
    return null;
  }
}

function validateRevisionMeta(meta) {
  for (const field of ["repo", "branch", "relativePath"]) {
    if (typeof meta[field] !== "string" || !meta[field]) throw new TypeError(`History revision meta requires ${field}.`);
  }
  if (meta.repoRoot !== null && (typeof meta.repoRoot !== "string" || !path.isAbsolute(meta.repoRoot))) {
    throw new TypeError("History revision meta repoRoot must be an absolute path or null.");
  }
  if (meta.head != null && (typeof meta.head !== "string" || !/^[a-f0-9]+$/i.test(meta.head))) {
    throw new TypeError("History revision meta head must be a hexadecimal string or null.");
  }
  if (meta.worktree != null && (typeof meta.worktree !== "string" || !meta.worktree)) {
    throw new TypeError("History revision meta worktree must be a non-empty string or null.");
  }
  if (meta.localAssets !== null) validateLocalAssets(meta.localAssets);
}

function normalizeLocalAssets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = Object.fromEntries(Object.entries(value).filter(([source, target]) => (
    typeof source === "string"
      && source.length > 0
      && typeof target === "string"
      && /^[.]\/_assets\/[a-f0-9]{20}[.][a-z0-9]+$/i.test(target)
  )));
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function validateLocalAssets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("History localAssets must be an object.");
  for (const [source, target] of Object.entries(value)) {
    if (!source || typeof target !== "string" || !/^[.]\/_assets\/[a-f0-9]{20}[.][a-z0-9]+$/i.test(target)) {
      throw new TypeError("History localAssets contains an invalid mapping.");
    }
  }
}

function validateId(value) {
  if (!ID_PATTERN.test(value)) throw new TypeError("Invalid history id.");
}

function validateHash(value) {
  if (!HASH_PATTERN.test(value)) throw new TypeError("Invalid history content hash.");
}
