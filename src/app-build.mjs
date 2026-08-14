import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const RUNTIME_SOURCES = [
  "./app-build.mjs",
  "./assets.mjs",
  "./catalog.mjs",
  "./cli.mjs",
  "./document.mjs",
  "./history.mjs",
  "./paths.mjs",
  "./render-document.mjs",
  "./renderer.mjs",
  "./server.mjs",
  "./template.mjs",
  "./viewer-entry.js",
  "./viewer.css",
  "../package-lock.json",
].map((relative) => ({ relative, url: new URL(relative, import.meta.url) }));

const buildIdPromise = computeBuildId();

export function appBuildId() {
  return buildIdPromise;
}

async function computeBuildId() {
  const hash = createHash("sha256");
  for (const source of RUNTIME_SOURCES) {
    hash.update(source.relative);
    hash.update("\0");
    hash.update(await readFile(source.url));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}
