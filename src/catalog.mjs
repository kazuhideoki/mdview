import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cacheRoot, catalogRoot, documentHref } from "./paths.mjs";

const CATALOG_VERSION = 1;
const ID_PATTERN = /^[a-f0-9]{24}$/;

export function catalogEntryId(sourcePath) {
  return createHash("sha256").update(path.resolve(sourcePath)).digest("hex").slice(0, 24);
}

export async function registerCatalogEntry(input, options = {}) {
  const root = path.resolve(options.root || cacheRoot());
  const sourcePath = path.resolve(input.sourcePath);
  const id = catalogEntryId(sourcePath);
  const context = input.catalogContext || {};
  const entry = {
    id,
    title: input.title,
    repo: input.repo,
    branch: input.branch,
    relativePath: input.relativePath,
    sourcePath,
    href: documentHref(input.outputPath, root),
    renderedAt: context.renderedAt || new Date(options.now ?? Date.now()).toISOString(),
    source: context.source || "manual",
    sessionId: context.sessionId ?? null,
    turnId: context.turnId ?? null,
  };
  validateCatalogEntry(entry);

  const directory = path.join(root, "catalog");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${id}.json`);
  const temp = path.join(directory, `.${id}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify({ version: CATALOG_VERSION, ...entry }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return entry;
}

export async function catalogEntryForSource(sourcePath, options = {}) {
  const root = path.resolve(options.root || cacheRoot());
  const id = catalogEntryId(sourcePath);
  const target = path.join(options.root ? path.join(root, "catalog") : catalogRoot(), `${id}.json`);
  try {
    const entry = catalogEntryFromRecord(JSON.parse(await readFile(target, "utf8")));
    return entry?.id === id ? entry : null;
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

export async function readCatalog(options = {}) {
  const root = path.resolve(options.root || cacheRoot());
  const directory = options.root ? path.join(root, "catalog") : catalogRoot();
  let files;
  try {
    files = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const entries = await Promise.all(files
    .filter((file) => file.isFile() && ID_PATTERN.test(path.basename(file.name, ".json")) && file.name.endsWith(".json"))
    .map(async (file) => {
      try {
        const record = JSON.parse(await readFile(path.join(directory, file.name), "utf8"));
        const entry = catalogEntryFromRecord(record);
        if (!entry || entry.id !== path.basename(file.name, ".json")) return null;
        if (!(await hasValidMarkdownSource(entry))) return null;
        if (!(await hasValidRenderedHtml(entry, root))) return null;
        return entry;
      } catch (error) {
        if (error instanceof SyntaxError || error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
        throw error;
      }
    }));

  return entries
    .filter(Boolean)
    .sort((left, right) => {
      const timeOrder = Date.parse(right.renderedAt) - Date.parse(left.renderedAt);
      if (timeOrder !== 0) return timeOrder;
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    });
}

function catalogEntryFromRecord(record) {
  if (!record || record.version !== CATALOG_VERSION) return null;
  const entry = {
    id: record.id,
    title: record.title,
    repo: record.repo,
    branch: record.branch,
    relativePath: record.relativePath,
    sourcePath: record.sourcePath,
    href: record.href,
    renderedAt: record.renderedAt,
    source: record.source,
    sessionId: record.sessionId ?? null,
    turnId: record.turnId ?? null,
  };
  try {
    validateCatalogEntry(entry);
    return entry;
  } catch {
    return null;
  }
}

function validateCatalogEntry(entry) {
  if (!ID_PATTERN.test(entry.id)) throw new TypeError("Catalog entry requires a valid id.");
  for (const field of ["title", "repo", "branch", "relativePath", "sourcePath", "href", "renderedAt", "source"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      throw new TypeError(`Catalog entry requires ${field}.`);
    }
  }
  if (!path.isAbsolute(entry.sourcePath)) throw new TypeError("Catalog sourcePath must be absolute.");
  if (!Number.isFinite(Date.parse(entry.renderedAt))) throw new TypeError("Catalog renderedAt must be a timestamp.");
  for (const field of ["sessionId", "turnId"]) {
    if (entry[field] !== null && (typeof entry[field] !== "string" || entry[field].length === 0)) {
      throw new TypeError(`Catalog ${field} must be a non-empty string or null.`);
    }
  }
}

async function hasValidRenderedHtml(entry, root) {
  let url;
  try {
    url = new URL(entry.href, "http://mdview.local");
  } catch {
    return false;
  }
  if (url.origin !== "http://mdview.local" || url.search || url.hash || !url.pathname.startsWith("/documents/")) return false;

  let segments;
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return false;
  }
  const candidate = path.resolve(root, ...segments);
  const documents = path.join(root, "documents");
  if (!candidate.toLowerCase().endsWith(".html") || !isContained(candidate, documents)) return false;
  try {
    const [canonicalDocuments, canonicalFile] = await Promise.all([realpath(documents), realpath(candidate)]);
    return isContained(canonicalFile, canonicalDocuments) && (await stat(canonicalFile)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function hasValidMarkdownSource(entry) {
  if (!/[.](?:md|markdown)$/i.test(entry.sourcePath)) return false;
  try {
    return (await stat(entry.sourcePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function isContained(candidate, root) {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}
