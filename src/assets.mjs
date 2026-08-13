import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetRoot } from "./paths.mjs";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SOURCE_ROOT, "..");

export async function ensureAssets() {
  const target = assetRoot();
  await mkdir(target, { recursive: true });
  const [stylesheet, viewerScript, mermaidScript] = await Promise.all([
    publishAsset(path.join(SOURCE_ROOT, "viewer.css"), "viewer.css", target),
    publishAsset(path.join(SOURCE_ROOT, "viewer-entry.js"), "viewer.js", target),
    publishAsset(path.join(PROJECT_ROOT, "node_modules", "mermaid", "dist", "mermaid.min.js"), "mermaid.min.js", target),
  ]);
  return { stylesheet, viewerScript, mermaidScript };
}

export async function publishAsset(source, logicalName, targetRoot = assetRoot()) {
  const sourceContents = await readFile(source);
  const extension = path.extname(logicalName);
  const stem = logicalName.slice(0, -extension.length);
  const digest = createHash("sha256").update(sourceContents).digest("hex");
  const target = path.join(targetRoot, `${stem}.${digest}${extension}`);
  await mkdir(targetRoot, { recursive: true });
  let current;
  try {
    current = await readFile(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    current = null;
  }
  if (current) {
    if (current.equals(sourceContents)) return target;
    throw new Error(`Content-addressed asset mismatch: ${target}`);
  }
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, sourceContents, { mode: 0o644 });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return target;
}
