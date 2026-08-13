import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { visit } from "unist-util-visit";
import { ensureAssets } from "./assets.mjs";
import { catalogEntryForSource, catalogEntryId, registerCatalogEntry } from "./catalog.mjs";
import { documentMeta, parseMarkdown, rawDiffForFile } from "./document.mjs";
import { catalogRoot, documentOutputPath, documentUrl } from "./paths.mjs";
import { renderDocument } from "./render-document.mjs";
import { pageTemplate } from "./template.mjs";

const execFileAsync = promisify(execFile);

export async function renderMarkdownFile(inputPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), inputPath);
  const catalogContext = {
    ...(options.catalogContext || {}),
    renderedAt: options.catalogContext?.renderedAt || new Date().toISOString(),
  };
  const fileStat = options.sourceStat || await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error(`Not a file: ${absolutePath}`);
  if (!/[.](?:md|markdown)$/i.test(absolutePath)) throw new Error(`Markdown file required: ${absolutePath}`);

  const [markdown, detectedMeta] = await Promise.all([
    options.sourceContents ?? readFile(absolutePath, "utf8"),
    documentMeta(absolutePath),
  ]);
  const meta = { ...detectedMeta, ...options.meta };
  const changedLines = options.changedLines ?? meta.changedLines;
  const documentPath = documentOutputPath(meta);
  const outputDir = path.dirname(documentPath);
  const tree = parseMarkdown(markdown);
  rewriteLocalMarkdownLinks(tree, absolutePath);
  await Promise.all([
    prepareLocalImages(tree, absolutePath, meta, outputDir),
    prepareD2Diagrams(tree, outputDir),
  ]);
  const rendered = await renderDocument(tree, { changedLines });
  meta.changeCount = rendered.changeCount;
  meta.updatedLabel = options.updatedLabel || "Updated by Codex · just now";
  const assets = await ensureAssets();
  await mkdir(outputDir, { recursive: true });

  const rawDiff = options.rawDiff ?? await rawDiffForFile(absolutePath, meta.repoRoot);
  const title = rendered.headings[0]?.text || path.basename(absolutePath);
  const html = pageTemplate({
    title,
    contentHtml: rendered.html,
    headings: rendered.headings,
    meta,
    rawDiff,
    assets: Object.fromEntries(
      Object.entries(assets).map(([name, filePath]) => [name, relativeWebPath(outputDir, filePath)]),
    ),
  });
  const revision = createHash("sha256")
    .update(`${catalogContext.renderedAt}\0${html}`)
    .digest("hex")
    .slice(0, 16);
  const outputPath = documentPath.replace(/[.]html$/i, `.${revision}.html`);
  const commit = async () => {
    const incomingRenderedAt = catalogContext.renderedAt;
    const current = await catalogEntryForSource(absolutePath);
    if (incomingRenderedAt) {
      if (current && Date.parse(current.renderedAt) >= Date.parse(incomingRenderedAt)) {
        return { catalogEntry: current, outputPath: outputPathForCatalogEntry(current) };
      }
    }
    await atomicWrite(outputPath, html);
    let catalogEntry;
    try {
      catalogEntry = await (options.registerCatalogEntry || registerCatalogEntry)({
        title,
        repo: meta.repo,
        branch: meta.branch,
        relativePath: meta.relativePath,
        sourcePath: absolutePath,
        outputPath,
        catalogContext,
      });
    } catch (error) {
      await unlink(outputPath).catch(() => {});
      throw error;
    }
    if (current && current.href !== catalogEntry.href) {
      await unlink(outputPathForCatalogEntry(current)).catch(() => {});
    }
    return { catalogEntry, outputPath };
  };
  const published = await withDocumentLock(catalogEntryId(absolutePath), commit);

  return {
    outputPath: published.outputPath,
    url: documentUrl(published.outputPath),
    catalogEntry: published.catalogEntry,
    meta,
    ...rendered,
  };
}

export function rewriteLocalMarkdownLinks(tree, sourcePath) {
  const sourceId = catalogEntryId(sourcePath);
  visit(tree, "link", (node) => {
    const target = localMarkdownTarget(node.url);
    if (!target) return;
    const params = new URLSearchParams({ target: target.path });
    if (target.fragment) params.set("fragment", target.fragment);
    node.url = `/__mdview/follow/${sourceId}?${params}`;
  });
}

function localMarkdownTarget(value) {
  if (typeof value !== "string" || !value || value.startsWith("#")) return null;
  const hashIndex = value.indexOf("#");
  const targetPath = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const fragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : "";
  if (
    !targetPath ||
    targetPath.includes("?") ||
    targetPath.startsWith("/") ||
    targetPath.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(targetPath)
  ) return null;
  if (/%(?:2f|5c)/i.test(targetPath)) return null;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(targetPath);
  } catch {
    return null;
  }
  if (!/[.](?:md|markdown)$/i.test(decodedPath)) return null;
  return { path: targetPath, fragment };
}

function outputPathForCatalogEntry(entry) {
  const url = new URL(entry.href, "http://mdview.local");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const candidate = path.resolve(path.dirname(catalogRoot()), ...segments);
  const documents = path.join(path.dirname(catalogRoot()), "documents");
  if (candidate === documents || !candidate.startsWith(`${documents}${path.sep}`)) {
    throw new Error("Catalog entry points outside the mdview document cache.");
  }
  return candidate;
}

async function withDocumentLock(id, operation) {
  const lockPath = path.join(catalogRoot(), `.render-${id}.lock`);
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 99) throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 5 * 60 * 1000) {
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

export async function renderMarkdownFiles(files, options = {}) {
  const rendered = [];
  for (const file of files) rendered.push(await renderMarkdownFile(file, options));
  return rendered;
}

function relativeWebPath(from, to) {
  const relative = path.relative(from, to).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function atomicWrite(target, contents) {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, contents, { encoding: "utf8", mode: 0o644 });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function prepareLocalImages(tree, markdownPath, meta, outputDir) {
  const nodes = [];
  visit(tree, "image", (node) => nodes.push(node));
  for (const node of nodes) {
    if (!node.url || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(node.url)) continue;
    const sourcePath = path.resolve(path.dirname(markdownPath), decodeURIComponent(node.url));
    let canonical;
    try {
      canonical = await realpath(sourcePath);
    } catch {
      continue;
    }
    const allowedRoot = await realpath(meta.repoRoot || path.dirname(markdownPath));
    if (canonical !== allowedRoot && !canonical.startsWith(`${allowedRoot}${path.sep}`)) continue;
    if (!(await stat(canonical)).isFile()) continue;
    const extension = path.extname(canonical).toLowerCase().replace(/[^.a-z0-9]/g, "");
    const name = `${createHash("sha256").update(canonical).digest("hex").slice(0, 20)}${extension}`;
    const assetDir = path.join(outputDir, "_assets");
    const target = path.join(assetDir, name);
    await mkdir(assetDir, { recursive: true });
    await copyFile(canonical, target);
    node.url = `./_assets/${name}`;
  }
}

async function prepareD2Diagrams(tree, outputDir) {
  const nodes = [];
  visit(tree, "code", (node) => { if (node.lang === "d2") nodes.push(node); });
  for (const node of nodes) {
    const digest = createHash("sha256").update(node.value).digest("hex").slice(0, 20);
    const diagramDir = path.join(outputDir, "_diagrams");
    const outputPath = path.join(diagramDir, `${digest}.svg`);
    await mkdir(diagramDir, { recursive: true });
    try {
      await stat(outputPath);
    } catch {
      try {
        await renderD2(node.value, outputPath);
      } catch {
        continue;
      }
    }
    node.data ||= {};
    node.data.mdviewDiagramUrl = `./_diagrams/${digest}.svg`;
  }
}

export async function renderD2(source, outputPath) {
  const input = `${outputPath}.${process.pid}.d2`;
  const tempOutput = `${outputPath}.${process.pid}.svg`;
  try {
    await writeFile(input, source, "utf8");
    await execFileAsync("d2", ["--theme", "200", "--dark-theme", "200", "--pad", "30", input, tempOutput]);
    await rename(tempOutput, outputPath);
  } finally {
    await unlink(input).catch(() => {});
    await unlink(tempOutput).catch(() => {});
  }
}
