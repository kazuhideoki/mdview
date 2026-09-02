import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetRoot } from "./paths.mjs";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SOURCE_ROOT, "..");

export async function ensureAssets() {
  const target = assetRoot();
  const [stylesheet, katexAssets, viewerScript, mermaidScript] = await Promise.all([
    publishAsset(path.join(SOURCE_ROOT, "viewer.css"), "viewer.css", target),
    publishKaTeXAssets(target),
    publishAsset(path.join(SOURCE_ROOT, "viewer-entry.js"), "viewer.js", target),
    publishAsset(path.join(PROJECT_ROOT, "node_modules", "mermaid", "dist", "mermaid.min.js"), "mermaid.min.js", target),
  ]);
  return {
    stylesheet,
    katexStylesheet: katexAssets.stylesheet,
    viewerScript,
    mermaidScript,
    artifactPaths: katexAssets.fonts,
  };
}

export async function publishAsset(source, logicalName, targetRoot = assetRoot()) {
  const sourceContents = await readFile(source);
  return publishContents(sourceContents, logicalName, targetRoot);
}

async function publishKaTeXAssets(targetRoot) {
  const katexRoot = path.join(PROJECT_ROOT, "node_modules", "katex", "dist");
  let stylesheet = await readFile(path.join(katexRoot, "katex.min.css"), "utf8");
  const fontNames = [...new Set([...stylesheet.matchAll(/url\(fonts\/([^)]+)\)/g)].map((match) => match[1]))];
  const publishedFonts = await Promise.all(fontNames.map(async (fontName) => ({
    fontName,
    published: await publishAsset(path.join(katexRoot, "fonts", fontName), path.join("fonts", fontName), targetRoot),
  })));
  for (const { fontName, published } of publishedFonts) {
    stylesheet = stylesheet.replaceAll(`url(fonts/${fontName})`, `url(fonts/${path.basename(published)})`);
  }
  return {
    stylesheet: await publishContents(stylesheet, "katex.css", targetRoot),
    fonts: publishedFonts.map(({ published }) => published),
  };
}

async function publishContents(sourceContents, logicalName, targetRoot) {
  const contents = Buffer.isBuffer(sourceContents) ? sourceContents : Buffer.from(sourceContents);
  const extension = path.extname(logicalName);
  const stem = logicalName.slice(0, -extension.length);
  const digest = createHash("sha256").update(contents).digest("hex");
  const target = path.join(targetRoot, `${stem}.${digest}${extension}`);
  await mkdir(path.dirname(target), { recursive: true });
  let current;
  try {
    current = await readFile(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    current = null;
  }
  if (current) {
    if (current.equals(contents)) return target;
    throw new Error(`Content-addressed asset mismatch: ${target}`);
  }
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { mode: 0o644 });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return target;
}
