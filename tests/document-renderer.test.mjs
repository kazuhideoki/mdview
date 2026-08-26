import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { changedLinesFromPatch, lineChangesFromPatch, parseMarkdown } from "../src/document.mjs";
import { normalizeHtmlFragment, sanitizeRawHtml } from "../src/raw-html.mjs";
import { renderDocument } from "../src/render-document.mjs";

const execFileAsync = promisify(execFile);

test("raw diff does not depend on the server's launch directory still existing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-diff-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const doomedCwd = path.join(root, "removed-worktree");
  const beforePath = path.join(root, "before.md");
  const afterPath = path.join(root, "after.md");
  await mkdir(doomedCwd);
  await writeFile(beforePath, "Before\n");
  await writeFile(afterPath, "After\n");

  const documentModule = new URL("../src/document.mjs", import.meta.url).href;
  const script = `
    import { rm } from "node:fs/promises";
    import { rawDiffBetweenFiles } from ${JSON.stringify(documentModule)};
    await rm(process.cwd(), { recursive: true });
    process.stdout.write(await rawDiffBetweenFiles(process.argv[1], process.argv[2], "note.md"));
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
    beforePath,
    afterPath,
  ], { cwd: doomedCwd });

  assert.match(stdout, /--- a\/note[.]md/);
  assert.match(stdout, /\+\+\+ b\/note[.]md/);
  assert.match(stdout, /-Before/);
  assert.match(stdout, /\+After/);
});

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

test("outline candidate filtering excludes headings inside removed compound blocks", async () => {
  const rendered = await renderDocument(parseMarkdown("> ## Deleted nested heading\n"), {
    diffLines: [1],
    diffKind: "removed",
  });
  assert.match(rendered.html, /<blockquote[^>]+data-diff-kind="removed"[^>]*><h2[^>]+class="mdv-heading"/);
  assert.doesNotMatch(rendered.html, /<h2[^>]+data-diff-kind="removed"/);

  const viewerSource = await readFile(new URL("../src/viewer-entry.js", import.meta.url), "utf8");
  assert.match(viewerSource, /heading[.]closest\('\[data-diff-kind="removed"\]'\)/);
});

test("renders allowlisted Markdown HTML and strips executable attributes", async () => {
  const rendered = await renderDocument(parseMarkdown([
    '<div align="center" onclick="alert(1)" style="display:none">',
    "",
    '  <h1>Rendered title</h1>',
    "",
    '  <a href="javascript:alert(1)" target="_blank">unsafe link</a>',
    "",
    '  <script>alert("unsafe")</script>',
    "",
    "</div>",
    "",
    "Press <kbd>Enter</kbd>.",
    "",
  ].join("\n")));

  assert.match(rendered.html, /<div align="center">/);
  assert.match(rendered.html, /<h1>Rendered title<\/h1>/);
  assert.match(rendered.html, /<a href="#">unsafe link<\/a>/);
  assert.match(rendered.html, /alert\(&quot;unsafe&quot;\)/);
  assert.match(rendered.html, /Press <kbd>Enter<\/kbd>[.]/);
  assert.doesNotMatch(rendered.html, /onclick=|style=|target=|<script>/);
});

test("keeps previous raw HTML inert while current split containers remain structural", async () => {
  const removed = await renderDocument(parseMarkdown('<div align="center">\n'), {
    diffLines: [1],
    diffKind: "removed",
  });
  const added = await renderDocument(parseMarkdown('<div align="right">\n'), {
    diffLines: [1],
    diffKind: "added",
  });
  assert.match(removed.html, /mdv-raw-html-diff[^>]+data-diff-kind="removed"/);
  assert.doesNotMatch(removed.html, /<div align="center">/);
  assert.match(added.html, /mdv-raw-html-diff[^>]+data-diff-kind="added"/);
  assert.match(added.html, /<div align="right">/);

  const normalized = normalizeHtmlFragment(`${removed.html}${added.html}<p>Text</p></div>`);
  assert.doesNotMatch(normalized, /<div align="center">/);
  assert.equal((normalized.match(/<div align="right">/g) ?? []).length, 1);
  assert.match(normalized, /<div align="right"><p>Text<\/p><\/div>/);
});

test("uses HTML5 tokenization for quoted delimiters and balances the final fragment", async () => {
  const sanitized = await sanitizeRawHtml('<div title="a > b"><img src="jav&#x61;script:alert(1)" alt="x > y"></div>');
  assert.equal(sanitized, '<div title="a &gt; b"><img src="#" alt="x &gt; y"></div>');
  assert.equal(normalizeHtmlFragment('</div><p>After</p>'), '<p>After</p>');
});

test("renders unique heading ids, GFM, highlighted code, and relative images outside the repo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const repo = path.join(root, "repo");
  const docs = path.join(repo, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(docs, "hidden.png"), Buffer.from([0x89, 0x50, 0x4e, 0x48]));
  const markdownPath = path.join(docs, "guide.markdown");
  await writeFile(markdownPath, `# Same\n\n- [x] done\n\n## Same\n\n<!-- <img src="./hidden.png"> -->\n\n<script><img src="./hidden.png"></script>\n\n<div align="center">\n\n  <img src="./pixel.png" width="128" alt="pixel html" />\n\n  ![pixel](./pixel.png)\n\n</div>\n\n\`\`\`js\nconst answer = 42\n\`\`\`\n`);

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
    assert.match(html, /<input[^>]+type="checkbox"[^>]+disabled=""[^>]+checked=""/);
    assert.match(html, /class="shiki/);
    assert.match(html, /src="[.]\/_assets\/[a-f0-9]+[.]png"/);
    assert.match(html, /<div align="center">/);
    assert.match(html, /<img src="[.]\/_assets\/[a-f0-9]+[.]png" width="128" alt="pixel html">/);
    assert.doesNotMatch(html, /&lt;div\b/);
    assert.match(html, /data-view-target="read"[^>]+aria-keyshortcuts="R 1"[^>]+title="Read \(R \/ 1\)"/);
    assert.match(html, /data-view-target="changes"[^>]+aria-keyshortcuts="C 2"[^>]+title="Changes \(C \/ 2\)"/);
    assert.doesNotMatch(html, /data-view-target="raw"|mdv-raw-diff|Raw diff/);
    assert.match(html, /id="mdv-workspace-palette-dialog"[^>]+aria-labelledby="mdv-workspace-palette-title"/);
    assert.match(html, /aria-label="ワークツリーを検索"/);
    assert.match(html, /id="mdv-outline-palette-dialog"[^>]+aria-labelledby="mdv-outline-palette-title"/);
    assert.match(html, /aria-label="現在の文書の見出しを検索"[^>]+aria-keyshortcuts="Meta\+Shift\+O Control\+Shift\+O"/);
    assert.match(html, /id="icon-list-linear"/);
    assert.match(html, /href="#icon-list-linear"/);
    assert.match(html, /id="mdv-shortcuts-dialog"[^>]+aria-labelledby="mdv-shortcuts-title"[^>]+aria-keyshortcuts="[?]"/);
    const shortcutsHtml = html.slice(html.indexOf('class="mdv-shortcuts-dialog"'), html.indexOf('class="mdv-toast"'));
    assert.match(shortcutsHtml, /Keyboard shortcuts/);
    assert.match(shortcutsHtml, /前の版へ|前の作業へ/);
    assert.match(shortcutsHtml, /Read/);
    assert.match(shortcutsHtml, /Changes/);
    assert.match(shortcutsHtml, /ワークツリーを選択/);
    assert.match(shortcutsHtml, /アウトラインを表示/);
    assert.doesNotMatch(shortcutsHtml, /Raw diff/);
    assert.doesNotMatch(shortcutsHtml, /表示ボタン選択中/);
    assert.doesNotMatch(html, /data-workspace-files|id="mdv-search-dialog"|data-action="open-search"/);
    assert.match(html, /aria-label="目次"/);
    assert.match(html, /同じファイルの変更履歴/);
    assert.doesNotMatch(html, /data-action="mark-read"|既読にする|icon-check-read-linear/);
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
    await unlink(path.join(docs, "hidden.png"));
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
    assert.match(secondHtml, /<p class="mdv-block mdv-paragraph"[^>]*data-diff-kind="removed"[^>]*><span class="mdv-inline-diff">Before<\/span>[.]<\/p>/);
    assert.match(secondHtml, /<p class="mdv-block mdv-paragraph"[^>]*data-diff-kind="added"[^>]*><span class="mdv-inline-diff">After<\/span>[.]<\/p>/);
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

test("highlights changed words inside paired paragraph replacements", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-inline-word-diff-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "inline.md");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?inline-word-diff=${Date.now()}`);
    await writeFile(markdownPath, "# Notes\n\nDeploy to the staging environment.\n");
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline", branch: "main", relativePath: "inline.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# Notes\n\nDeploy to the production environment.\n");
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline", branch: "main", relativePath: "inline.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(result.outputPath, "utf8");
    assert.match(html, /data-diff-kind="removed"[^>]*>Deploy to the <span class="mdv-inline-diff">staging<\/span> environment[.]<\/p>/);
    assert.match(html, /data-diff-kind="added"[^>]*>Deploy to the <span class="mdv-inline-diff">production<\/span> environment[.]<\/p>/);
    const viewerCss = await readFile(new URL("../src/viewer.css", import.meta.url), "utf8");
    assert.match(viewerCss, /data-view="changes"[^\n]+[.]mdv-inline-diff/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("pairs equal multi-block replacements by order when no content anchor remains", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-inline-ambiguous-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "ambiguous-inline.md");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?inline-ambiguous=${Date.now()}`);
    await writeFile(markdownPath, "# Notes\n\nFirst legacy sentence.\n\nSecond obsolete statement.\n");
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline", branch: "main", relativePath: "ambiguous-inline.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# Notes\n\nFresh replacement prose.\n\nDifferent modern wording.\n");
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline", branch: "main", relativePath: "ambiguous-inline.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(result.outputPath, "utf8");
    assert.match(html, /data-diff-kind="removed"/);
    assert.match(html, /data-diff-kind="added"/);
    assert.match(html, /data-diff-kind="removed"[^>]*><span class="mdv-inline-diff">First legacy sentence<\/span>[.]<\/p>/);
    assert.match(html, /data-diff-kind="added"[^>]*><span class="mdv-inline-diff">Fresh replacement prose<\/span>[.]<\/p>/);
    assert.match(html, /data-diff-kind="removed"[^>]*><span class="mdv-inline-diff">Second obsolete statement<\/span>[.]<\/p>/);
    assert.match(html, /data-diff-kind="added"[^>]*><span class="mdv-inline-diff">Different modern wording<\/span>[.]<\/p>/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("matches a replacement around an adjacent insertion by content similarity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-inline-insertion-pairing-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "mixed.md");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?inline-insertion-pairing=${Date.now()}`);
    await writeFile(markdownPath, "# Setup\n\nThe production CLI uses the legacy installation method.\n");
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline", branch: "main", relativePath: "mixed.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# Setup\n\nConfirm the executable directory is on PATH.\n\nThe production CLI uses the repository symlink.\n");
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline", branch: "main", relativePath: "mixed.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(result.outputPath, "utf8");
    assert.match(html, /data-diff-kind="removed"[^>]*>The production CLI uses the <span class="mdv-inline-diff">legacy installation method<\/span>[.]<\/p>/);
    assert.match(html, /data-diff-kind="added"[^>]*>The production CLI uses the <span class="mdv-inline-diff">repository symlink<\/span>[.]<\/p>/);
    assert.match(html, /data-diff-kind="added"[^>]*>Confirm the executable directory is on PATH[.]<\/p>/);
    assert.doesNotMatch(html, /mdv-inline-diff[^>]*>Confirm/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("highlights inline changes inside paired fenced code blocks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-inline-code-diff-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "code.md");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?inline-code-diff=${Date.now()}`);
    await writeFile(markdownPath, "# Setup\n\n```bash\nnpm install\nmdview legacy-mode\n```\n");
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline", branch: "main", relativePath: "code.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# Setup\n\n```bash\nnpm install\nmdview repository-mode\n```\n");
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline", branch: "main", relativePath: "code.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(result.outputPath, "utf8");
    const removed = html.match(/<figure class="mdv-block mdv-code"[^>]*data-diff-kind="removed"[\s\S]*?<\/figure>/)?.[0] ?? "";
    const added = html.match(/<figure class="mdv-block mdv-code"[^>]*data-diff-kind="added"[\s\S]*?<\/figure>/)?.[0] ?? "";
    assert.match(removed, /mdv-inline-diff/);
    assert.match(removed, /legacy/);
    assert.match(added, /mdv-inline-diff/);
    assert.match(added, /repository/);
    assert.doesNotMatch(html, /mdv-inline-diff[^>]*>[\s\S]*?npm install[\s\S]*?<\/span>/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("falls back to block highlighting when an inline comparison is unusually large", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-inline-large-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "large-inline.md");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?inline-large=${Date.now()}`);
    await writeFile(markdownPath, `# Notes\n\n${"before ".repeat(600)}\n`);
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline", branch: "main", relativePath: "large-inline.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, `# Notes\n\n${"after ".repeat(600)}\n`);
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "inline", branch: "main", relativePath: "large-inline.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(result.outputPath, "utf8");
    assert.match(html, /data-diff-kind="removed"/);
    assert.match(html, /data-diff-kind="added"/);
    assert.doesNotMatch(html, /mdv-inline-diff/);
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
    assert.match(html, /<tr[^>]*data-diff-kind="removed"[^>]*>.*mdv-table-diff-label mdv-visually-hidden[^>]*>削除行: <\/span>billing<\/td><td>Billing<\/td><td>Queue<\/td><\/tr>/);
    assert.match(html, /<tr[^>]*data-diff-kind="added"[^>]*>.*mdv-table-diff-label mdv-visually-hidden[^>]*>追加行: <\/span>billing<\/td><td>Billing<\/td><td>Queue <span class="mdv-inline-diff">\(async\)<\/span><\/td><\/tr>/);
    const viewerCss = await readFile(new URL("../src/viewer.css", import.meta.url), "utf8");
    assert.match(viewerCss, /[.]mdv-table-diff-marker, [.]mdv-table-diff-label \{ display: none; \}/);
    assert.match(viewerCss, /data-view="changes"[^\n]+[.]mdv-table-diff-marker[^\n]+display: block/);
    assert.equal((html.match(/<td>auth<\/td>/g) ?? []).length, 1);
    assert.equal((html.match(/<td>user<\/td>/g) ?? []).length, 1);
    assert.doesNotMatch(html, /mdv-table-wrap"[^>]*data-diff-kind/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("keeps inline table comparisons inside corresponding cells", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-table-cell-inline-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "table-cells.md");
  const header = "| ID | Left | Right |\n| --- | --- | --- |\n";
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?table-cell-inline=${Date.now()}`);
    await writeFile(markdownPath, `${header}| row | Alpha | Beta |\n`);
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "tables", branch: "main", relativePath: "table-cells.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, `${header}| row | Beta | Alpha |\n`);
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "tables", branch: "main", relativePath: "table-cells.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(result.outputPath, "utf8");
    assert.match(html, /data-diff-kind="removed"[^>]*>.*<td><span class="mdv-inline-diff">Alpha<\/span><\/td><td><span class="mdv-inline-diff">Beta<\/span><\/td>/);
    assert.match(html, /data-diff-kind="added"[^>]*>.*<td><span class="mdv-inline-diff">Beta<\/span><\/td><td><span class="mdv-inline-diff">Alpha<\/span><\/td>/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("renders a changed Markdown list as item-level changes in one list", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-list-diff-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "list.md");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?list-diff=${Date.now()}`);
    await writeFile(markdownPath, "# Notes\n\n- Alpha\n- Before\n- Omega\n");
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "lists", branch: "main", relativePath: "list.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# Notes\n\n- Alpha\n- After\n- Omega\n");
    const second = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "lists", branch: "main", relativePath: "list.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(second.outputPath, "utf8");
    assert.equal((html.match(/<ul class="mdv-block mdv-list"/g) ?? []).length, 1);
    assert.equal((html.match(/>Alpha<\/p>/g) ?? []).length, 1);
    assert.equal((html.match(/>Omega<\/p>/g) ?? []).length, 1);
    assert.match(html, /<li data-diff-kind="removed"[^>]*>.*削除項目: <\/span><p[^>]*><span class="mdv-inline-diff">Before<\/span><\/p><\/li>/);
    assert.match(html, /<li data-diff-kind="added"[^>]*>.*追加項目: <\/span><p[^>]*><span class="mdv-inline-diff">After<\/span><\/p><\/li>/);
    assert.equal((html.match(/class="mdv-list-structural-marker" aria-hidden="true">•<\/span>/g) ?? []).length, 2);
    assert.doesNotMatch(html, /<ul[^>]*data-diff-kind/);
    assert.doesNotMatch(html, /<ul[^>]*data-change/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("highlights every paired item in a multi-item list replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-list-multi-inline-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "multi-list.md");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?list-multi-inline=${Date.now()}`);
    await writeFile(markdownPath, "# Notes\n\n- Stable start\n- First legacy value\n- Second legacy value\n- Stable end\n");
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "lists", branch: "main", relativePath: "multi-list.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# Notes\n\n- Stable start\n- First current value\n- Second current value\n- Stable end\n");
    const result = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "lists", branch: "main", relativePath: "multi-list.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(result.outputPath, "utf8");
    assert.match(html, /data-diff-kind="removed"[^>]*>.*First <span class="mdv-inline-diff">legacy<\/span> value/);
    assert.match(html, /data-diff-kind="added"[^>]*>.*First <span class="mdv-inline-diff">current<\/span> value/);
    assert.match(html, /data-diff-kind="removed"[^>]*>.*Second <span class="mdv-inline-diff">legacy<\/span> value/);
    assert.match(html, /data-diff-kind="added"[^>]*>.*Second <span class="mdv-inline-diff">current<\/span> value/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("preserves ordered-list numbering for item-level changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-render-ordered-list-diff-"));
  const cache = path.join(root, "cache");
  const historyRoot = path.join(root, "history");
  const markdownPath = path.join(root, "ordered-list.md");
  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?ordered-list-diff=${Date.now()}`);
    await writeFile(markdownPath, "# Steps\n\n3. Alpha\n4. Before\n5. Omega\n");
    await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "lists", branch: "main", relativePath: "ordered-list.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T10:00:00.000Z" },
    });
    await writeFile(markdownPath, "# Steps\n\n3. Alpha\n4. After\n5. Omega\n");
    const second = await renderMarkdownFile(markdownPath, {
      historyRoot,
      meta: { repo: "lists", branch: "main", relativePath: "ordered-list.md", repoRoot: root },
      catalogContext: { source: "hook", renderedAt: "2026-08-13T11:00:00.000Z" },
    });
    const html = await readFile(second.outputPath, "utf8");
    assert.match(html, /<ol class="mdv-block mdv-list" start="3"[^>]*>/);
    assert.match(html, /<li value="4" data-diff-kind="removed"[^>]*>.*<span class="mdv-inline-diff">Before<\/span><\/p><\/li>/);
    assert.match(html, /<li value="4" data-diff-kind="added"[^>]*>.*<span class="mdv-inline-diff">After<\/span><\/p><\/li>/);
    assert.equal((html.match(/mdv-list-structural-marker-ordered" aria-hidden="true">4[.]<\/span>/g) ?? []).length, 2);
    assert.match(html, /<li value="5"[^>]*>.*Omega<\/p><\/li>/);
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
    assert.doesNotMatch(html, /mdv-inline-diff[^>]*>Stable text/);
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
    assert.match(changed.html, /data-diff-kind="removed"[^>]*><span class="mdv-inline-diff">Before<\/span>[.]<\/p>/);
    assert.match(changed.html, /data-diff-kind="added"[^>]*><span class="mdv-inline-diff">After<\/span>[.]<\/p>/);

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
