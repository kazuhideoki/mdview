import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetRoot } from "./paths.mjs";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SOURCE_ROOT, "..");

export async function ensureAssets() {
  const target = assetRoot();
  await mkdir(target, { recursive: true });
  await Promise.all([
    atomicCopy(path.join(SOURCE_ROOT, "viewer.css"), path.join(target, "viewer.css")),
    atomicCopy(path.join(SOURCE_ROOT, "viewer-entry.js"), path.join(target, "viewer.js")),
    atomicCopy(path.join(PROJECT_ROOT, "node_modules", "mermaid", "dist", "mermaid.min.js"), path.join(target, "mermaid.min.js")),
  ]);
  return target;
}

async function atomicCopy(source, target) {
  const sourceContents = await readFile(source);
  let current;
  try {
    current = await readFile(target);
  } catch {
    current = null;
  }
  if (current?.equals(sourceContents)) return;
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, sourceContents, { mode: 0o644 });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
