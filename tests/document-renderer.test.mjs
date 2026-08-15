import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changedLinesFromPatch, lineChangesFromPatch } from "../src/document.mjs";

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
  assert.deepEqual(lineChangesFromPatch(patch), {
    addedLines: [3],
    removedLines: [3],
    hunks: [{ oldStart: 1, oldCount: 5, newStart: 1, newCount: 5, addedLines: [3], addedAt: [{ oldLine: 4, newLine: 3 }], removedLines: [3], removedAt: [{ oldLine: 3, newLine: 3 }] }],
  });
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
    const { renderHistoryRevision, renderMarkdownFile } = await import(`../src/renderer.mjs?test=${Date.now()}`);
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      changedLines: [1, 5],
      resolveSessionTitle: async (sessionId) => sessionId === "session-render" ? "Markdown reader context" : null,
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
    assert.match(html, /data-view-target="read"[^>]+aria-keyshortcuts="R 1"[^>]+title="Read \(R \/ 1\)"/);
    assert.match(html, /data-view-target="changes"[^>]+aria-keyshortcuts="C 2"[^>]+title="Changes \(C \/ 2\)"/);
    assert.match(html, /data-view-target="raw"[^>]+aria-keyshortcuts="D 3"[^>]+title="Raw diff \(D \/ 3\)"/);
    assert.match(html, /id="mdv-workspace-palette-dialog"[^>]+aria-labelledby="mdv-workspace-palette-title"/);
    assert.match(html, /aria-label="ワークツリーを検索"/);
    assert.doesNotMatch(html, /data-workspace-files|id="mdv-search-dialog"|data-action="open-search"/);
    assert.match(html, /aria-label="目次"/);
    assert.match(html, /同じファイルの変更履歴/);
    assert.match(html, /href="(?:[.][.]\/)+assets\/viewer[.][a-f0-9]{64}[.]css"/);
    assert.match(html, /src="(?:[.][.]\/)+assets\/viewer[.][a-f0-9]{64}[.]js"/);
    assert.match(html, /src="(?:[.][.]\/)+assets\/mermaid[.]min[.][a-f0-9]{64}[.]js"/);
    assert.match(html, /class="mdv-session-title"[^>]*>.*Markdown reader context<\/span>/);
    const topbarHtml = html.slice(html.indexOf('<header class="mdv-topbar">'), html.indexOf("</header>"));
    assert.doesNotMatch(topbarHtml, /Markdown reader context|mdv-session-title/);
    assert.ok(html.indexOf("Markdown reader context") > html.indexOf('class="mdv-reviewbar"'));
    assert.match(html, /data-current-worktree="[^"]+"/);
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
    const copiedAsset = path.join(path.dirname(result.outputPath), "_assets", copied[0]);
    await unlink(copiedAsset);
    await unlink(path.join(docs, "pixel.png"));
    await unlink(markdownPath);
    const rerendered = await renderHistoryRevision(result.catalogEntry.id, result.historyRevision.id, {
      historyRoot,
      resolveSessionTitle: async () => "Renamed Codex session",
    });
    assert.match(rerendered.html, new RegExp(`src="[.]\/_assets\/${copied[0]}"`));
    assert.match(rerendered.html, /Renamed Codex session/);
    assert.doesNotMatch(rerendered.html, /Markdown reader context/);
    assert.deepEqual(await readFile(copiedAsset), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("rewrites only relative Markdown links through the mdview follow route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-links-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "index.md");
  await writeFile(markdownPath, [
    "# Links",
    "",
    "[Guide](./guide.md#usage)",
    "[Anchor](#links)",
    "[Web](https://example.com/remote.md)",
    "[Mail](mailto:docs@example.com)",
    "[Text](./notes.txt)",
    "[Encoded slash](./a%2Fb.md)",
    "",
  ].join("\n"));

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { catalogEntryId } = await import(`../src/catalog.mjs?links=${Date.now()}`);
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?links=${Date.now()}`);
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "links", branch: "main", relativePath: "index.md", repoRoot: root },
      catalogContext: { source: "manual" },
    });
    const html = await readFile(result.outputPath, "utf8");
    assert.doesNotMatch(html, /mdv-session-title/);
    const sourceId = catalogEntryId(markdownPath);
    assert.match(html, new RegExp(`href="/__mdview/follow/${sourceId}[?]target=[.]%2Fguide[.]md&amp;fragment=usage&amp;workspace=[a-f0-9]{24}&amp;revision=[a-f0-9]{24}"`));
    assert.match(html, /href="#links"/);
    assert.match(html, /href="https:\/\/example[.]com\/remote[.]md"/);
    assert.match(html, /href="mailto:docs@example[.]com"/);
    assert.match(html, /href="[.]\/notes[.]txt"/);
    assert.match(html, /href="[.]\/a%2Fb[.]md"/);
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
  await writeFile(markdownPath, "# Title\n\nBefore.\n\nSame.\n");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?history=${Date.now()}`);
    const first = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "history", branch: "main", relativePath: "history.md", repoRoot: root },
      catalogContext: { source: "hook", sessionId: "session", turnId: "turn-1", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# Title\n\nAfter.\n\nSame.\n");
    const second = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "history", branch: "main", relativePath: "history.md", repoRoot: root },
      catalogContext: { source: "hook", sessionId: "session", turnId: "turn-2", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    await access(first.outputPath);
    await access(second.outputPath);
    assert.notEqual(first.outputPath, second.outputPath);
    const secondHtml = await readFile(second.outputPath, "utf8");
    assert.match(secondHtml, /-Before[.]/);
    assert.match(secondHtml, /\+After[.]/);
    assert.match(secondHtml, /<p class="mdv-block mdv-paragraph"[^>]*data-diff-kind="removed"[^>]*>Before[.]<\/p>/);
    assert.match(secondHtml, /<p class="mdv-block mdv-paragraph"[^>]*data-diff-kind="added"[^>]*>After[.]<\/p>/);
    assert.ok(secondHtml.indexOf('id="title"') < secondHtml.indexOf('data-diff-kind="removed"'));
    assert.ok(secondHtml.indexOf('data-diff-kind="removed"') < secondHtml.indexOf('data-diff-kind="added"'));
    assert.match(secondHtml, /<p class="mdv-block mdv-paragraph"[^>]*>Same[.]<\/p>/);
    assert.doesNotMatch(secondHtml, /<h1[^>]*data-change="modified"/);
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

test("shows structural paragraph changes when only the separating blank line changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-structural-diff-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "structural.md");
  await writeFile(markdownPath, "# Title\n\nAlpha.\n\nBeta.\n");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?structural=${Date.now()}`);
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "structural", branch: "main", relativePath: "structural.md", repoRoot: root },
      catalogContext: { source: "hook", sessionId: "session", turnId: "turn-1", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# Title\n\nAlpha.\nBeta.\n");
    const second = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "structural", branch: "main", relativePath: "structural.md", repoRoot: root },
      catalogContext: { source: "hook", sessionId: "session", turnId: "turn-2", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(second.outputPath, "utf8");
    assert.match(html, /data-diff-kind="removed"[^>]*>Alpha[.]<\/p>/);
    assert.match(html, /data-diff-kind="removed"[^>]*>Beta[.]<\/p>/);
    assert.match(html, /data-diff-kind="added"[^>]*>Alpha[.]\nBeta[.]<\/p>/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("renders a changed Markdown table as row-level changes in one table", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-table-diff-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "tables.md");
  const header = "| Boundary | Process | Transport |\n| --- | --- | --- |\n";
  await writeFile(markdownPath, `${header}| auth | Authentication | HTTP/JSON |\n| user | Users | HTTP/JSON |\n| billing | Billing | Queue |\n`);
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?table-diff=${Date.now()}`);
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "tables", branch: "main", relativePath: "tables.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, `${header}| auth | Authentication | HTTP/JSON |\n| user | Users | HTTP/JSON |\n| billing | Billing | Queue (async) |\n`);
    const second = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "tables", branch: "main", relativePath: "tables.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(second.outputPath, "utf8");
    assert.equal((html.match(/<table class="mdv-table">/g) ?? []).length, 1);
    assert.match(html, /<tr[^>]*data-diff-kind="removed"[^>]*>.*削除行: <\/span>billing<\/td><td>Billing<\/td><td>Queue<\/td><\/tr>/);
    assert.match(html, /<tr[^>]*data-diff-kind="added"[^>]*>.*追加行: <\/span>billing<\/td><td>Billing<\/td><td>Queue \(async\)<\/td><\/tr>/);
    assert.equal((html.match(/<td>auth<\/td>/g) ?? []).length, 1);
    assert.equal((html.match(/<td>user<\/td>/g) ?? []).length, 1);
    assert.doesNotMatch(html, /mdv-table-wrap"[^>]*data-diff-kind/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("renders inserted and deleted Markdown table rows inside the current table", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-table-row-set-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "table-rows.md");
  const header = "| ID | Value |\n| --- | --- |\n";
  const base = `${header}| alpha | A |\n| gamma | C |\n`;
  const inserted = `${header}| alpha | A |\n| beta | B |\n| gamma | C |\n`;
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?table-row-set=${Date.now()}`);
    await writeFile(markdownPath, base);
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "table-rows", branch: "main", relativePath: "table-rows.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, inserted);
    const addition = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "table-rows", branch: "main", relativePath: "table-rows.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const additionHtml = await readFile(addition.outputPath, "utf8");
    assert.equal((additionHtml.match(/<table class="mdv-table">/g) ?? []).length, 1);
    assert.match(additionHtml, /data-diff-kind="added"[^>]*>.*追加行: <\/span>beta<\/td><td>B<\/td>/);
    assert.doesNotMatch(additionHtml, /data-diff-kind="removed"/);

    await writeFile(markdownPath, base);
    const deletion = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "table-rows", branch: "main", relativePath: "table-rows.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T12:00:00.000Z" },
    });
    const deletionHtml = await readFile(deletion.outputPath, "utf8");
    assert.equal((deletionHtml.match(/<table class="mdv-table">/g) ?? []).length, 1);
    assert.match(deletionHtml, /data-diff-kind="removed"[^>]*>.*削除行: <\/span>beta<\/td><td>B<\/td>/);
    assert.doesNotMatch(deletionHtml, /data-diff-kind="removed"[^>]*data-source-start/);
    assert.doesNotMatch(deletionHtml, /data-diff-kind="added"/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("detects inline Markdown-only table row changes and pairs adjacent replacements", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-table-inline-diff-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "inline-table.md");
  const header = "| ID | Reference |\n| --- | --- |\n";
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?table-inline=${Date.now()}`);
    await writeFile(markdownPath, `${header}| alpha | [Docs](old-alpha.md) |\n| beta | **Stable text** |\n`);
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline-table", branch: "main", relativePath: "inline-table.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, `${header}| alpha | [Docs](new-alpha.md) |\n| beta | *Stable text* |\n`);
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline-table", branch: "main", relativePath: "inline-table.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(result.outputPath, "utf8");
    assert.equal((html.match(/<table class="mdv-table">/g) ?? []).length, 1);
    const rowKinds = [...html.matchAll(/<tr data-diff-kind="(removed|added)"/g)].map((match) => match[1]);
    assert.deepEqual(rowKinds, ["removed", "added", "removed", "added"]);
    assert.match(html, /target=old-alpha[.]md/);
    assert.match(html, /target=new-alpha[.]md/);
    assert.match(html, /<strong>Stable text<\/strong>/);
    assert.match(html, /<em>Stable text<\/em>/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("falls back to whole-table changes when row or table matching is ambiguous", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-table-ambiguous-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "ambiguous.md");
  const duplicateTable = (value) => `| ID | Value |\n| --- | --- |\n| same | ${value} |\n| same | ${value} |\n`;
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?table-ambiguous=${Date.now()}`);
    await writeFile(markdownPath, duplicateTable("before"));
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "ambiguous", branch: "main", relativePath: "ambiguous.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, duplicateTable("after"));
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "ambiguous", branch: "main", relativePath: "ambiguous.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(result.outputPath, "utf8");
    assert.equal((html.match(/<table class="mdv-table">/g) ?? []).length, 2);
    assert.match(html, /mdv-table-wrap"[^>]*data-diff-kind="removed"/);
    assert.match(html, /mdv-table-wrap"[^>]*data-diff-kind="added"/);
    assert.doesNotMatch(html, /<tr data-diff-kind/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("pairs a shortened paragraph without marking the following block", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-deletion-diff-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "deletion.md");
  await writeFile(markdownPath, "# Title\n\nAlpha.\nBeta.\n\nSame.\n");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?deletion=${Date.now()}`);
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "deletion", branch: "main", relativePath: "deletion.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# Title\n\nAlpha.\n\nSame.\n");
    const second = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "deletion", branch: "main", relativePath: "deletion.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(second.outputPath, "utf8");
    const removedIndex = html.indexOf('data-diff-kind="removed"');
    const addedIndex = html.indexOf('data-diff-kind="added"');
    assert.ok(removedIndex >= 0 && removedIndex < addedIndex);
    assert.match(html, /data-diff-kind="removed"[^>]*>Alpha[.]\nBeta[.]<\/p>/);
    assert.match(html, /data-diff-kind="added"[^>]*>Alpha[.]<\/p>/);
    assert.match(html, /<p class="mdv-block mdv-paragraph"[^>]*>Same[.]<\/p>/);
    assert.doesNotMatch(html, /<p class="mdv-block mdv-paragraph"[^>]*data-diff-kind[^>]*>Same[.]<\/p>/);
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

test("renders any Markdown file at a worktree-wide revision without adding document history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const repo = path.join(root, "repo");
  const firstPath = path.join(repo, "first.md");
  const secondPath = path.join(repo, "second.md");
  await mkdir(repo);
  await writeFile(firstPath, "# First\n\nStable.\n");
  await writeFile(secondPath, "# Second\n\nBefore.\n");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile, renderWorkspaceRevision } = await import(`../src/renderer.mjs?workspace=${Date.now()}`);
    await renderMarkdownFile(firstPath, {
      historyRoot,
      meta: { repo: "repo", worktree: "feature/docs", branch: "feature/docs", relativePath: "first.md", repoRoot: repo },
      catalogContext: { source: "manual", renderedAt: "2026-08-15T10:00:00.000Z" },
    });
    await writeFile(secondPath, "# Second\n\nAfter.\n");
    await renderMarkdownFile(secondPath, {
      historyRoot,
      meta: { repo: "repo", worktree: "feature/docs", branch: "feature/docs", relativePath: "second.md", repoRoot: repo },
      catalogContext: { source: "manual", renderedAt: "2026-08-15T11:00:00.000Z" },
    });
    const { readWorkspaceHistoryForRoot, workspaceDocumentId } = await import(`../src/workspace-history.mjs?workspace=${Date.now()}`);
    const workspace = await readWorkspaceHistoryForRoot(repo, { root: historyRoot });
    assert.equal(workspace.revisions.length, 2);
    const revision = workspace.revisions[1];
    const stable = await renderWorkspaceRevision(workspace.workspaceId, revision.id, workspaceDocumentId(repo, "first.md"), { historyRoot });
    assert.match(stable.html, /data-workspace-id="[a-f0-9]{24}"/);
    assert.match(stable.html, /data-workspace-revision-id="[a-f0-9]{24}"/);
    assert.match(stable.html, /<base href="\/documents\/workspaces\//);
    assert.match(stable.html, /Stable[.]/);

    const changed = await renderWorkspaceRevision(workspace.workspaceId, revision.id, workspaceDocumentId(repo, "second.md"), { historyRoot });
    assert.match(changed.html, /data-diff-kind="removed"[^>]*>Before[.]<\/p>/);
    assert.match(changed.html, /data-diff-kind="added"[^>]*>After[.]<\/p>/);

    await rm(firstPath);
    await renderMarkdownFile(secondPath, {
      historyRoot,
      meta: { repo: "repo", worktree: "feature/docs", branch: "feature/docs", relativePath: "second.md", repoRoot: repo },
      catalogContext: { source: "manual", renderedAt: "2026-08-15T12:00:00.000Z" },
    });
    const deletedWorkspace = await readWorkspaceHistoryForRoot(repo, { root: historyRoot });
    const deletedRevision = deletedWorkspace.revisions.at(-1);
    const deleted = await renderWorkspaceRevision(workspace.workspaceId, deletedRevision.id, workspaceDocumentId(repo, "first.md"), { historyRoot });
    assert.equal(deleted.deleted, true);
    assert.match(deleted.html, /data-diff-kind="removed"[^>]*>Stable[.]<\/p>/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});
