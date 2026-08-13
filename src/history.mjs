import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
    await stat(target);
    return { contentHash, path: target, created: false };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temp, target);
    return { contentHash, path: target, created: true };
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
  return readFile(historySnapshotPath(contentHash, options), "utf8");
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
}

function validateId(value) {
  if (!ID_PATTERN.test(value)) throw new TypeError("Invalid history id.");
}

function validateHash(value) {
  if (!HASH_PATTERN.test(value)) throw new TypeError("Invalid history content hash.");
}
