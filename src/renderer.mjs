import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { visit } from "unist-util-visit";
import { ensureAssets } from "./assets.mjs";
import { catalogEntryForSource, catalogEntryId, registerCatalogEntry } from "./catalog.mjs";
import { changedLinesFromPatch, documentMeta, lineChangesFromPatch, parseMarkdown, rawDiffBetweenFiles, rawDiffForFile } from "./document.mjs";
import {
  historyRevisionId,
  historySnapshotPath,
  markdownContentHash,
  readDocumentHistory,
  registerHistoryRevision,
  storeHistoryCacheArtifacts,
  storeHistoryRenderedHtml,
  storeHistorySnapshot,
} from "./history.mjs";
import { cacheRoot, catalogRoot, documentOutputPath, documentUrl } from "./paths.mjs";
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
  const documentId = catalogEntryId(absolutePath);
  const contentHash = markdownContentHash(markdown);
  const historyOptions = options.historyRoot ? { root: options.historyRoot } : {};
  await storeHistorySnapshot(markdown, { ...historyOptions, contentHash });
  const history = await readDocumentHistory(documentId, historyOptions);
  const latestRevision = history.revisions.at(-1);
  const hasTurnBaseline = Object.hasOwn(options, "beforeContentHash");
  const beforeContentHash = hasTurnBaseline
    ? options.beforeContentHash
    : latestRevision?.contentHash ?? null;
  const beforePath = beforeContentHash ? historySnapshotPath(beforeContentHash, historyOptions) : null;
  let revisionDiff = options.rawDiff;
  let changedLines = options.changedLines;
  if (revisionDiff === undefined && (hasTurnBaseline || latestRevision)) {
    const afterPath = options.sourceContents === undefined ? absolutePath : historySnapshotPath(contentHash, historyOptions);
    revisionDiff = await rawDiffBetweenFiles(beforePath, afterPath, meta.relativePath);
  }
  if (changedLines === undefined) {
    changedLines = revisionDiff === undefined ? meta.changedLines : changedLinesFromPatch(revisionDiff);
  }
  const revisionId = latestRevision?.contentHash === contentHash
    ? latestRevision.id
    : historyRevisionId({
      documentId,
      renderedAt: catalogContext.renderedAt,
      contentHash,
      sessionId: catalogContext.sessionId,
      turnId: catalogContext.turnId,
    });
  meta.documentId = documentId;
  meta.revisionId = revisionId;
  const documentPath = documentOutputPath(meta);
  const outputDir = path.dirname(documentPath);
  const tree = parseMarkdown(markdown);
  rewriteLocalMarkdownLinks(tree, absolutePath);
  const rawDiff = revisionDiff ?? await rawDiffForFile(absolutePath, meta.repoRoot);
  const lineChanges = lineChangesFromPatch(rawDiff);
  let beforeTree = null;
  if (beforePath && lineChanges.removedLines.length > 0) {
    beforeTree = parseMarkdown(await readFile(beforePath, "utf8"));
    rewriteLocalMarkdownLinks(beforeTree, absolutePath);
  }
  const preparedTrees = beforeTree ? [tree, beforeTree] : [tree];
  await Promise.all(preparedTrees.flatMap((candidate) => [
    prepareLocalImages(candidate, absolutePath, meta, outputDir),
    prepareD2Diagrams(candidate, outputDir),
  ]));
  const rendered = await renderDocument(tree, {
    changedLines,
    diffLines: structuralDiffLines(tree, lineChanges.addedLines, lineChanges.hunks, "new"),
    diffKind: "added",
  });
  if (beforeTree) {
    const beforeRendered = await renderDocument(beforeTree, {
      changedLines: lineChanges.removedLines,
      diffLines: structuralDiffLines(beforeTree, lineChanges.removedLines, lineChanges.hunks, "old"),
      diffKind: "removed",
      idPrefix: "removed-",
    });
    rendered.html = interleaveRevisionBlocks(rendered.blocks, beforeRendered.blocks, lineChanges.hunks);
  }
  meta.changeCount = rendered.changeCount;
  meta.updatedLabel = options.updatedLabel || "Updated by Codex · just now";
  const assets = await ensureAssets();
  await mkdir(outputDir, { recursive: true });

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
  const outputPath = documentPath.replace(/[.]html$/i, `.${revisionId}.html`);
  await storeHistoryRenderedHtml(documentId, revisionId, html, historyOptions);
  const artifactPaths = [...Object.values(assets)];
  for (const directory of [path.join(outputDir, "_assets"), path.join(outputDir, "_diagrams")]) {
    if (await directoryExists(directory)) artifactPaths.push(directory);
  }
  await storeHistoryCacheArtifacts(artifactPaths, { ...historyOptions, cacheRoot: cacheRoot() });
  const commit = async () => {
    const incomingRenderedAt = catalogContext.renderedAt;
    const current = await catalogEntryForSource(absolutePath);
    const currentOutputPath = current ? outputPathForCatalogEntry(current) : null;
    const currentIsAvailable = currentOutputPath ? await isFile(currentOutputPath) : false;
    const currentHistory = await readDocumentHistory(documentId, historyOptions);
    if (current && currentIsAvailable && currentHistory.revisions.at(-1)?.contentHash === contentHash) {
      return {
        catalogEntry: current,
        historyRevision: currentHistory.revisions.at(-1),
        outputPath: currentOutputPath,
      };
    }
    await atomicWrite(outputPath, html);
    const historyResult = await registerHistoryRevision({
      id: revisionId,
      documentId,
      sourcePath: absolutePath,
      href: new URL(documentUrl(outputPath)).pathname,
      renderedAt: catalogContext.renderedAt,
      source: catalogContext.source || "manual",
      sessionId: catalogContext.sessionId ?? null,
      turnId: catalogContext.turnId ?? null,
      beforeContentHash,
      contentHash,
    }, historyOptions);
    let catalogEntry;
    const currentIsNewer = current
      && currentIsAvailable
      && Date.parse(current.renderedAt) >= Date.parse(incomingRenderedAt);
    if (currentIsNewer) {
      return { catalogEntry: current, historyRevision: historyResult.revision, outputPath };
    }
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
      throw error;
    }
    return { catalogEntry, historyRevision: historyResult.revision, outputPath };
  };
  const published = await withDocumentLock(catalogEntryId(absolutePath), commit);

  return {
    outputPath: published.outputPath,
    url: documentUrl(published.outputPath),
    catalogEntry: published.catalogEntry,
    historyRevision: published.historyRevision,
    meta,
    ...rendered,
  };
}

function structuralDiffLines(tree, changedLines, hunks, side) {
  const lines = new Set(changedLines);
  const blocks = (tree.children ?? []).filter((node) => node.position);
  for (const hunk of hunks) {
    const direct = side === "old" ? hunk.removedAt : hunk.addedAt;
    const opposite = side === "old" ? hunk.addedAt : hunk.removedAt;
    const key = side === "old" ? "oldLine" : "newLine";
    for (const position of direct) {
      const line = position[key];
      if (blocks.some((node) => line >= node.position.start.line && line <= node.position.end.line)) continue;
      const previous = [...blocks].reverse().find((node) => node.position.end.line < line);
      const next = blocks.find((node) => node.position.start.line > line);
      if (previous) lines.add(previous.position.end.line);
      if (next) lines.add(next.position.start.line);
    }
    if (direct.length === 0) {
      for (const position of opposite) {
        const line = position[key];
        const containing = blocks.find((node) => line >= node.position.start.line && line <= node.position.end.line);
        if (containing) {
          lines.add(line);
          continue;
        }
        const previous = [...blocks].reverse().find((node) => node.position.end.line < line);
        const next = blocks.find((node) => node.position.start.line > line);
        if (previous) lines.add(previous.position.end.line);
        else if (next) lines.add(next.position.start.line);
      }
    }
  }
  return [...lines];
}

function interleaveRevisionBlocks(currentBlocks, previousBlocks, hunks) {
  const insertions = new Map();
  for (const block of previousBlocks.filter((candidate) => candidate.diffChanged)) {
    const removedPositions = hunks.flatMap((hunk) => hunk.removedAt ?? []);
    const matchingPositions = removedPositions
      .filter((position) => position.oldLine >= block.startLine && position.oldLine <= block.endLine);
    const relevantPositions = matchingPositions.length > 0
      ? matchingPositions
      : removedPositions.toSorted((left, right) => (
        distanceFromBlock(left.oldLine, block) - distanceFromBlock(right.oldLine, block)
      )).slice(0, 1);
    if (relevantPositions.length === 0) continue;
    const targetLine = Math.min(...relevantPositions.map((position) => Math.max(position.newLine, 1)));
    const changedCurrentBlocks = currentBlocks
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.diffChanged)
      .toSorted((left, right) => (
        distanceFromBlock(targetLine, left.candidate) - distanceFromBlock(targetLine, right.candidate)
      ));
    let targetIndex = changedCurrentBlocks[0]?.index
      ?? currentBlocks.findIndex((candidate) => candidate.endLine >= targetLine);
    if (targetIndex < 0) targetIndex = currentBlocks.length;
    const existing = insertions.get(targetIndex) ?? [];
    existing.push(block.html);
    insertions.set(targetIndex, existing);
  }

  const html = [];
  for (let index = 0; index <= currentBlocks.length; index += 1) {
    html.push(...(insertions.get(index) ?? []));
    if (index < currentBlocks.length) html.push(currentBlocks[index].html);
  }
  return html.join("\n");
}

function distanceFromBlock(line, block) {
  if (line < block.startLine) return block.startLine - line;
  if (line > block.endLine) return line - block.endLine;
  return 0;
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function directoryExists(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
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
    const name = `${createHash("sha256").update(await readFile(canonical)).digest("hex").slice(0, 20)}${extension}`;
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
