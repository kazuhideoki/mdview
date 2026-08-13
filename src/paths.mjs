import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const DEFAULT_PORT = 4320;

export function cacheRoot() {
  return path.resolve(process.env.MDVIEW_CACHE_DIR || path.join(os.homedir(), "Library", "Caches", "mdview", "v1"));
}

export function assetRoot() {
  return path.join(cacheRoot(), "assets");
}

export function documentRoot() {
  return path.join(cacheRoot(), "documents");
}

export function catalogRoot() {
  return path.join(cacheRoot(), "catalog");
}

export function runtimeRoot() {
  return path.resolve(process.env.MDVIEW_RUNTIME_DIR || path.join(os.homedir(), "Library", "Application Support", "mdview"));
}

export function logPath() {
  return path.resolve(process.env.MDVIEW_LOG || path.join(os.homedir(), "Library", "Logs", "mdview", "mdview.log"));
}

export function serverPort() {
  const value = Number(process.env.MDVIEW_PORT || DEFAULT_PORT);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`Invalid MDVIEW_PORT: ${process.env.MDVIEW_PORT}`);
  return value;
}

export function repoId(repoRoot) {
  return createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 16);
}

export function documentOutputPath(meta) {
  const root = meta.repoRoot || path.dirname(meta.absolutePath);
  const relative = safeRelativePath(meta.repoRoot ? meta.relativePath : path.basename(meta.absolutePath));
  return path.join(documentRoot(), repoId(root), `${relative}.html`);
}

export function documentUrl(filePath) {
  return `http://127.0.0.1:${serverPort()}${documentHref(filePath)}`;
}

export function documentHref(filePath, root = cacheRoot()) {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Document is outside the mdview cache: ${filePath}`);
  }
  return `/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export function safeRelativePath(relativePath) {
  const normalized = path.normalize(relativePath);
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  return normalized;
}
