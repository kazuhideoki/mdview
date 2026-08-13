import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changedLinesFromPatch } from "../src/document.mjs";

test("changed line parsing excludes unchanged diff context", () => {
  const patch = [
    "@@ -1,5 +1,5 @@",
    " # Same heading",
    " ",
    "-Before",
    "+After",
    " ",
    " Unchanged",
  ].join("\n");
  assert.deepEqual(changedLinesFromPatch(patch), [3]);
});

test("renders unique heading ids, GFM, highlighted code, and relative images outside the repo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const repo = path.join(root, "repo");
  const docs = path.join(repo, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const markdownPath = path.join(docs, "guide.markdown");
  await writeFile(markdownPath, `# Same\n\n- [x] done\n\n## Same\n\n![pixel](./pixel.png)\n\n\`\`\`js\nconst answer = 42\n\`\`\`\n`);

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?test=${Date.now()}`);
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      changedLines: [1, 5],
      catalogContext: {
        renderedAt: "2026-08-13T10:00:00.000Z",
        source: "codex-hook",
        sessionId: "session-render",
        turnId: "turn-render",
      },
    });
    const html = await readFile(result.outputPath, "utf8");
    assert.match(html, /id="same"/);
    assert.match(html, /id="same-2"/);
    assert.match(html, /type="checkbox" disabled checked/);
    assert.match(html, /class="shiki/);
    assert.match(html, /src="[.]\/_assets\/[a-f0-9]+[.]png"/);
    assert.ok(result.outputPath.startsWith(cache));
    const copied = await readdir(path.join(path.dirname(result.outputPath), "_assets"));
    assert.equal(copied.length, 1);
    assert.deepEqual(result.catalogEntry, {
      id: result.catalogEntry.id,
      title: "Same",
      repo: result.meta.repo,
      branch: result.meta.branch,
      relativePath: result.meta.relativePath,
      sourcePath: markdownPath,
      href: result.url.replace(/^http:\/\/127[.]0[.]0[.]1:\d+/, ""),
      renderedAt: "2026-08-13T10:00:00.000Z",
      source: "codex-hook",
      sessionId: "session-render",
      turnId: "turn-render",
    });
    assert.equal((await readdir(path.join(cache, "catalog"))).length, 1);
    assert.match(html, new RegExp(`data-document-id="${result.catalogEntry.id}"`));
    assert.equal(result.historyRevision.contentHash.length, 64);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("an older hook render cannot replace a newer document snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-order-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "ordered.md");
  await writeFile(markdownPath, "# Current source\n");

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?order=${Date.now()}`);
    const newer = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "order", branch: "main", relativePath: "ordered.md", repoRoot: root },
      catalogContext: {
        source: "hook",
        sessionId: "new-session",
        turnId: "new-turn",
        renderedAt: "2026-08-13T10:00:00.000Z",
      },
    });
    const newerHtml = await readFile(newer.outputPath, "utf8");

    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "order", branch: "main", relativePath: "ordered.md", repoRoot: root },
      catalogContext: {
        source: "hook",
        sessionId: "old-session",
        turnId: "old-turn",
        renderedAt: "2026-08-13T09:00:00.000Z",
      },
    });

    assert.equal(await readFile(newer.outputPath, "utf8"), newerHtml);
    const { readCatalog } = await import(`../src/catalog.mjs?order=${Date.now()}`);
    const [entry] = await readCatalog({ root: cache });
    assert.equal(entry.renderedAt, "2026-08-13T10:00:00.000Z");
    assert.equal(entry.sessionId, "new-session");
    assert.equal(entry.turnId, "new-turn");
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("a catalog publication failure leaves the previously published snapshot intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-publish-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "published.md");
  await writeFile(markdownPath, "# Published first\n");

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?publish=${Date.now()}`);
    const first = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "publish", branch: "main", relativePath: "published.md", repoRoot: root },
      catalogContext: { source: "manual", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    const firstHtml = await readFile(first.outputPath, "utf8");
    await writeFile(markdownPath, "# Unpublished second\n");

    await assert.rejects(() => renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "publish", branch: "main", relativePath: "published.md", repoRoot: root },
      catalogContext: { source: "manual", renderedAt: "2026-08-13T11:00:00.000Z" },
      registerCatalogEntry: async () => { throw new Error("injected catalog failure"); },
    }), /injected catalog failure/);

    const { readCatalog } = await import(`../src/catalog.mjs?publish=${Date.now()}`);
    const [entry] = await readCatalog({ root: cache });
    assert.equal(entry.href, first.catalogEntry.href);
    assert.equal(entry.renderedAt, "2026-08-13T10:00:00.000Z");
    assert.equal(await readFile(first.outputPath, "utf8"), firstHtml);
    await access(first.outputPath);
    const publishedHtml = (await readdir(path.dirname(first.outputPath))).filter((name) => name.endsWith(".html"));
    assert.equal(publishedHtml.length, 2);
    assert.ok(publishedHtml.includes(path.basename(first.outputPath)));
    const { readDocumentHistory } = await import(`../src/history.mjs?publish=${Date.now()}`);
    assert.equal((await readDocumentHistory(first.catalogEntry.id, { root: historyRoot })).revisions.length, 2);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("keeps prior HTML and renders revision changes against the previous snapshot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-history-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "history.md");
  await writeFile(markdownPath, "# Before\n\nSame.\n");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?history=${Date.now()}`);
    const first = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "history", branch: "main", relativePath: "history.md", repoRoot: root },
      catalogContext: { source: "hook", sessionId: "session", turnId: "turn-1", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# After\n\nSame.\n");
    const second = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "history", branch: "main", relativePath: "history.md", repoRoot: root },
      catalogContext: { source: "hook", sessionId: "session", turnId: "turn-2", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    await access(first.outputPath);
    await access(second.outputPath);
    assert.notEqual(first.outputPath, second.outputPath);
    const secondHtml = await readFile(second.outputPath, "utf8");
    assert.match(secondHtml, /-# Before/);
    assert.match(secondHtml, /\+# After/);
    assert.match(secondHtml, /<h1[^>]*data-change="modified"/);
    assert.match(secondHtml, /data-action="previous-revision"/);
    assert.doesNotMatch(secondHtml, /previous-change/);
    const { readDocumentHistory } = await import(`../src/history.mjs?history=${Date.now()}`);
    const history = await readDocumentHistory(first.catalogEntry.id, { root: historyRoot });
    assert.equal(history.revisions.length, 2);
    assert.equal(history.revisions[1].beforeContentHash, history.revisions[0].contentHash);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("recreates a missing latest HTML cache without adding a duplicate revision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-rehydrate-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "rehydrate.md");
  await writeFile(markdownPath, "# Rehydrate\n");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?rehydrate=${Date.now()}`);
    const first = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "rehydrate", branch: "main", relativePath: "rehydrate.md", repoRoot: root },
      catalogContext: { source: "manual", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await unlink(first.outputPath);
    const second = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "rehydrate", branch: "main", relativePath: "rehydrate.md", repoRoot: root },
      catalogContext: { source: "manual", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    assert.equal(second.outputPath, first.outputPath);
    await access(second.outputPath);
    const { readDocumentHistory } = await import(`../src/history.mjs?rehydrate=${Date.now()}`);
    assert.equal((await readDocumentHistory(first.catalogEntry.id, { root: historyRoot })).revisions.length, 1);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});
