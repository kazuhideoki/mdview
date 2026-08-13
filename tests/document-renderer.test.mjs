import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("renders unique heading ids, GFM, highlighted code, and relative images outside the repo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-"));
  const cache = path.join(root, "cache");
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
    assert.match(html, /data-view-target="read"[^>]+aria-keyshortcuts="R"[^>]+title="Read \(R\)"/);
    assert.match(html, /data-view-target="changes"[^>]+aria-keyshortcuts="C"[^>]+title="Changes \(C\)"/);
    assert.match(html, /data-view-target="raw"[^>]+aria-keyshortcuts="D"[^>]+title="Raw diff \(D\)"/);
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
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("an older hook render cannot replace a newer document snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-order-"));
  const cache = path.join(root, "cache");
  const markdownPath = path.join(root, "ordered.md");
  await writeFile(markdownPath, "# Current source\n");

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?order=${Date.now()}`);
    const newer = await renderMarkdownFile(markdownPath, {
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
  const markdownPath = path.join(root, "published.md");
  await writeFile(markdownPath, "# Published first\n");

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?publish=${Date.now()}`);
    const first = await renderMarkdownFile(markdownPath, {
      meta: { repo: "publish", branch: "main", relativePath: "published.md", repoRoot: root },
      catalogContext: { source: "manual", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    const firstHtml = await readFile(first.outputPath, "utf8");
    await writeFile(markdownPath, "# Unpublished second\n");

    await assert.rejects(() => renderMarkdownFile(markdownPath, {
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
    assert.deepEqual(publishedHtml, [path.basename(first.outputPath)]);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});
