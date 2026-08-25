import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { historyRevisionId, registerHistoryRevision, storeHistoryCacheArtifacts, storeHistoryRenderedHtml } from "../src/history.mjs";

test("loopback server serves cache files and limits file opening to trusted requests", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-server-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  await mkdir(path.join(cache, "documents"), { recursive: true });
  await mkdir(path.join(root, "repo"), { recursive: true });
  await writeFile(path.join(cache, "documents", "page.html"), `<!doctype html><title>ok</title>
    <div data-view="read" class="shell mdv-app">
      <button type="button" data-view-target="read" aria-pressed="true">Read</button>
      <button type="button" data-view-target="changes" aria-pressed="false">Changes</button>
    </div>`);
  await writeFile(path.join(root, "repo", "page.md"), "# Page\n");
  await writeFile(path.join(root, "secret.txt"), "secret");

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  const previousRuntime = process.env.MDVIEW_RUNTIME_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  process.env.MDVIEW_RUNTIME_DIR = path.join(root, "runtime");
  const { registerCatalogEntry } = await import(`../src/catalog.mjs?test=${Date.now()}`);
  const registered = await registerCatalogEntry({
    title: "Page",
    repo: "repo",
    branch: "main",
    relativePath: "page.md",
    sourcePath: path.join(root, "repo", "page.md"),
    outputPath: path.join(cache, "documents", "page.html"),
    catalogContext: {
      renderedAt: "2026-08-13T10:00:00.000Z",
      source: "manual",
    },
  });
  await registerHistoryRevision({
    documentId: registered.id,
    sourcePath: path.join(root, "repo", "page.md"),
    href: "/documents/page.html",
    renderedAt: "2026-08-13T10:00:00.000Z",
    source: "manual",
    sessionId: "session-page",
    turnId: "turn-page",
    beforeContentHash: null,
    contentHash: "a".repeat(64),
  });
  const revisionId = historyRevisionId({
    documentId: registered.id,
    renderedAt: "2026-08-13T10:00:00.000Z",
    contentHash: "a".repeat(64),
    sessionId: "session-page",
    turnId: "turn-page",
  });
  await storeHistoryRenderedHtml(registered.id, revisionId, "<!doctype html><title>restored</title>");
  const corruptSnapshot = path.join(process.env.MDVIEW_RUNTIME_DIR, "history", "objects", `${"a".repeat(64)}.md`);
  await mkdir(path.dirname(corruptSnapshot), { recursive: true });
  await writeFile(corruptSnapshot, "corrupt snapshot\n");
  const durableAsset = path.join(cache, "assets", "viewer.test.js");
  await mkdir(path.dirname(durableAsset), { recursive: true });
  await writeFile(durableAsset, "window.mdviewRestored = true;\n");
  await storeHistoryCacheArtifacts([durableAsset], { cacheRoot: cache });
  const { startServer } = await import(`../src/server.mjs?test=${Date.now()}`);
  const server = await startServer({
    port: 0,
    resolveSessionTitle: async (sessionId) => sessionId === "session-page" ? "Current session name" : null,
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  try {
    const port = server.address().port;
    const health = await fetch(`http://127.0.0.1:${port}/__mdview_health`);
    assert.equal(health.status, 200);
    assert.match(await health.text(), /^mdview\/8 [a-f0-9]{24}\n$/);

    const page = await fetch(`http://127.0.0.1:${port}/documents/page.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>ok/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");

    const changesPage = await fetch(`http://127.0.0.1:${port}/documents/page.html?view=changes`);
    const changesHtml = await changesPage.text();
    assert.match(changesHtml, /data-view="changes" class="shell mdv-app"/);
    assert.match(changesHtml, /data-view-target="read" aria-pressed="false"/);
    assert.match(changesHtml, /data-view-target="changes" aria-pressed="true"/);
    const rawPage = await fetch(`http://127.0.0.1:${port}/documents/page.html?view=raw`);
    const rawHtml = await rawPage.text();
    assert.match(rawHtml, /data-view="read" class="shell mdv-app"/);
    assert.doesNotMatch(rawHtml, /data-view="raw"|data-view-target="raw"|mdv-raw-diff|Raw diff/);

    const writeAttempt = await fetch(`http://127.0.0.1:${port}/documents/page.html`, { method: "POST" });
    assert.equal(writeAttempt.status, 405);

    const traversal = await fetch(`http://127.0.0.1:${port}/%2e%2e/secret.txt`);
    assert.equal(traversal.status, 404);

    const catalog = await fetch(`http://127.0.0.1:${port}/__mdview/catalog`);
    assert.equal(catalog.status, 200);
    assert.equal(catalog.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(catalog.headers.get("cache-control"), "no-store");
    assert.deepEqual(await catalog.json(), [{
      id: registered.id,
      title: "Page",
      repo: "repo",
      branch: "main",
      relativePath: "page.md",
      href: "/documents/page.html",
      renderedAt: "2026-08-13T10:00:00.000Z",
      source: "manual",
    }]);

    const rawCatalog = await fetch(`http://127.0.0.1:${port}/catalog/${registered.id}.json`);
    assert.equal(rawCatalog.status, 404);

    const encodedCatalog = await fetch(`http://127.0.0.1:${port}/documents/%2e%2e%2fcatalog/${registered.id}.json`);
    assert.equal(encodedCatalog.status, 404);

    const history = await fetch(`http://127.0.0.1:${port}/__mdview/history/${registered.id}`);
    assert.equal(history.status, 200);
    assert.deepEqual(await history.json(), {
      documentId: registered.id,
      revisions: [{
        id: revisionId,
        href: "/documents/page.html",
        renderedAt: "2026-08-13T10:00:00.000Z",
        source: "manual",
        sessionId: "session-page",
        turnId: "turn-page",
      }],
    });

    const titledHistory = await fetch(`http://127.0.0.1:${port}/__mdview/history/${registered.id}?revision=${revisionId}`);
    assert.equal(titledHistory.status, 200);
    assert.equal((await titledHistory.json()).revisions[0].sessionTitle, "Current session name");

    const invalidRevisionQuery = await fetch(`http://127.0.0.1:${port}/__mdview/history/${registered.id}?revision=invalid`);
    assert.equal(invalidRevisionQuery.status, 400);

    await unlink(path.join(cache, "documents", "page.html"));
    await unlink(durableAsset);
    const recoveredHistory = await fetch(`http://127.0.0.1:${port}/__mdview/history/${registered.id}`);
    assert.equal(recoveredHistory.status, 200);
    const restoredPage = await fetch(`http://127.0.0.1:${port}/documents/page.html`);
    assert.equal(restoredPage.status, 200);
    assert.match(await restoredPage.text(), /<title>restored/);
    const restoredAsset = await fetch(`http://127.0.0.1:${port}/assets/viewer.test.js`);
    assert.equal(restoredAsset.status, 200);
    assert.match(await restoredAsset.text(), /mdviewRestored/);

    const invalidHistory = await fetch(`http://127.0.0.1:${port}/__mdview/history/not-an-id`);
    assert.equal(invalidHistory.status, 404);

    const catalogHead = await fetch(`http://127.0.0.1:${port}/__mdview/catalog`, { method: "HEAD" });
    assert.equal(catalogHead.status, 200);
    assert.equal(catalogHead.headers.get("cache-control"), "no-store");
    assert.equal(await catalogHead.text(), "");

    const openedPath = path.join(root, "repo", "opened from palette.md");
    await writeFile(openedPath, "# Opened from palette\n");
    const opened = await fetch(`http://127.0.0.1:${port}/__mdview/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ path: openedPath }),
    });
    assert.equal(opened.status, 200);
    const openedPayload = await opened.json();
    assert.match(openedPayload.href, /^\/documents\/.+[.]html$/);
    const openedCatalog = await fetch(`http://127.0.0.1:${port}/__mdview/catalog`).then((response) => response.json());
    assert.equal(openedCatalog[0].title, "Opened from palette");
    assert.equal(openedCatalog[0].source, "manual");
    const openedOutput = path.resolve(cache, ...new URL(openedPayload.href, "http://mdview.local").pathname.split("/").filter(Boolean).map(decodeURIComponent));
    await writeFile(openedOutput, "<!doctype html><title>obsolete viewer</title>");
    await writeFile(openedPath, "# Changed after capture\n");
    const currentAppPage = await fetch(`http://127.0.0.1:${port}${openedPayload.href}`);
    const currentAppHtml = await currentAppPage.text();
    assert.equal(currentAppPage.status, 200);
    assert.equal(currentAppPage.headers.get("cache-control"), "no-store");
    assert.match(currentAppHtml, /<title>Opened from palette · mdview<\/title>/);
    assert.match(currentAppHtml, /aria-label="このワークツリーのMarkdownを検索"/);
    assert.match(currentAppHtml, /viewer[.][a-f0-9]{64}[.]js/);
    assert.doesNotMatch(currentAppHtml, /obsolete viewer|Changed after capture/);
    await unlink(openedOutput);
    const withoutHtmlCache = await fetch(`http://127.0.0.1:${port}${openedPayload.href}`);
    assert.equal(withoutHtmlCache.status, 200);
    assert.match(await withoutHtmlCache.text(), /Opened from palette/);
    const catalogWithoutHtmlCache = await fetch(`http://127.0.0.1:${port}/__mdview/catalog`).then((response) => response.json());
    assert.ok(catalogWithoutHtmlCache.some((entry) => entry.href === openedPayload.href));
    const changed = await fetch(`http://127.0.0.1:${port}/__mdview/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ path: openedPath }),
    });
    const changedPayload = await changed.json();
    await writeFile(openedPath, "# Not captured\n");
    const changedPage = await fetch(`http://127.0.0.1:${port}${changedPayload.href}?view=changes`);
    const changedHtml = await changedPage.text();
    assert.equal(changedPage.status, 200);
    assert.match(changedHtml, /data-view="changes"/);
    assert.match(changedHtml, /data-diff-kind="removed"[^>]*>Opened from palette<\/h1>/);
    assert.match(changedHtml, /data-diff-kind="added"[^>]*>Changed after capture<\/h1>/);
    assert.doesNotMatch(changedHtml, /Not captured/);

    for (const [label, requestPath, status] of [
      ["missing", path.join(root, "repo", "missing.md"), 404],
      ["relative", "relative.md", 400],
      ["not Markdown", path.join(root, "secret.txt"), 400],
    ]) {
      const rejected = await fetch(`http://127.0.0.1:${port}/__mdview/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: requestPath }),
      });
      assert.equal(rejected.status, status, label);
    }
    const crossOriginOpen = await fetch(`http://127.0.0.1:${port}/__mdview/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ path: openedPath }),
    });
    assert.equal(crossOriginOpen.status, 403);
    const reboundOriginStatus = await rawRequestStatus(port, {
      host: `attacker.example:${port}`,
      "content-type": "application/json",
      origin: `http://attacker.example:${port}`,
      "sec-fetch-site": "same-origin",
    }, JSON.stringify({ path: openedPath }));
    assert.equal(reboundOriginStatus, 421);
    assert.equal((await fetch(`http://127.0.0.1:${port}/__mdview/open`)).status, 405);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
    if (previousRuntime === undefined) delete process.env.MDVIEW_RUNTIME_DIR;
    else process.env.MDVIEW_RUNTIME_DIR = previousRuntime;
  }
});

function rawRequestStatus(port, headers, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: "/__mdview/open", method: "POST", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("catalog endpoint exposes every document in the same newest-first order as mdview list", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-server-catalog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const repo = path.join(root, "repo");
  await mkdir(path.join(cache, "documents"), { recursive: true });
  await mkdir(repo, { recursive: true });

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  const catalogModule = await import(`../src/catalog.mjs?all=${Date.now()}`);
  for (const [name, renderedAt] of [
    ["older", "2026-08-13T09:00:00.000Z"],
    ["newer", "2026-08-13T10:00:00.000Z"],
  ]) {
    const sourcePath = path.join(repo, `${name}.md`);
    const outputPath = path.join(cache, "documents", `${name}.html`);
    await writeFile(sourcePath, `# ${name}\n`);
    await writeFile(outputPath, `<!doctype html><title>${name}</title>`);
    await catalogModule.registerCatalogEntry({
      title: name,
      repo: "repo",
      branch: "main",
      relativePath: `${name}.md`,
      sourcePath,
      outputPath,
      catalogContext: { renderedAt, source: "manual" },
    });
  }

  const { startServer } = await import(`../src/server.mjs?all=${Date.now()}`);
  const server = await startServer({ port: 0 });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  try {
    const listed = await catalogModule.readCatalog();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/__mdview/catalog`);
    assert.equal(response.status, 200);
    const searchable = await response.json();
    assert.deepEqual(searchable.map((entry) => entry.id), listed.map((entry) => entry.id));
    assert.deepEqual(searchable.map((entry) => entry.relativePath), ["newer.md", "older.md"]);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("following a relative Markdown link stays in the selected workspace revision", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-server-follow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const repo = path.join(root, "repo");
  const docs = path.join(repo, "docs");
  await mkdir(docs, { recursive: true });
  const sourcePath = path.join(docs, "index.md");
  const targetPath = path.join(docs, "設計 guide.md");
  await writeFile(sourcePath, "# Index\n\n[Guide](./%E8%A8%AD%E8%A8%88%20guide.md#利用方法)\n");
  await writeFile(targetPath, "# Guide\n\n## 利用方法\n");

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?follow=${Date.now()}`);
    const renderedSource = await renderMarkdownFile(sourcePath, {
      meta: { repo: "repo", branch: "main", relativePath: "docs/index.md", repoRoot: repo },
      catalogContext: { source: "manual" },
    });
    const html = await readFile(renderedSource.outputPath, "utf8");
    const encodedHref = html.match(/href="(\/__mdview\/follow\/[^"]+)"/)?.[1];
    assert.ok(encodedHref);
    const followHref = encodedHref.replaceAll("&amp;", "&");

    const { startServer } = await import(`../src/server.mjs?follow=${Date.now()}`);
    const server = await startServer({ port: 0 });
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const crossSite = await fetch(`${origin}${followHref}`, {
      redirect: "manual",
      headers: { origin: "https://example.com", "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSite.status, 403);
    assert.equal((await fetch(`${origin}/__mdview/catalog`).then((response) => response.json())).length, 1);

    const followed = await fetch(`${origin}${followHref}`, { redirect: "manual" });
    assert.equal(followed.status, 302);
    assert.match(followed.headers.get("location"), /^\/__mdview\/workspaces\/[a-f0-9]{24}\/revisions\/[a-f0-9]{24}\/files\/[a-f0-9]{24}#%E5%88%A9%E7%94%A8%E6%96%B9%E6%B3%95$/);

    const catalog = await fetch(`${origin}/__mdview/catalog`).then((response) => response.json());
    assert.equal(catalog.length, 1);
    const linked = await fetch(`${origin}${followed.headers.get("location")}`);
    assert.equal(linked.status, 200);
    assert.match(await linked.text(), /<title>Guide · mdview<\/title>/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("follow route rejects traversal, escaping symlinks, non-Markdown files, and HEAD side effects", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-server-follow-safety-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  const sourcePath = path.join(repo, "index.md");
  const outsidePath = path.join(root, "outside.md");
  await writeFile(sourcePath, "# Index\n");
  await writeFile(outsidePath, "# Outside\n");
  await writeFile(path.join(repo, "notes.txt"), "not Markdown\n");
  await symlink(outsidePath, path.join(repo, "escape.md"));

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?safety=${Date.now()}`);
    const renderedSource = await renderMarkdownFile(sourcePath, {
      meta: { repo: "repo", branch: "main", relativePath: "index.md", repoRoot: repo },
      catalogContext: { source: "manual" },
    });
    const sourceId = renderedSource.catalogEntry.id;
    const { startServer } = await import(`../src/server.mjs?safety=${Date.now()}`);
    const server = await startServer({ port: 0 });
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const follow = (target) => `${origin}/__mdview/follow/${sourceId}?target=${encodeURIComponent(target)}`;

    for (const target of ["../outside.md", "./escape.md", "./notes.txt", "/tmp/outside.md", "file:outside.md"]) {
      assert.equal((await fetch(follow(target), { redirect: "manual" })).status, 404, target);
    }
    assert.equal((await fetch(follow("../outside.md"), { method: "HEAD", redirect: "manual" })).status, 405);
    const catalog = await fetch(`${origin}/__mdview/catalog`).then((response) => response.json());
    assert.deepEqual(catalog.map((entry) => entry.relativePath), ["index.md"]);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("follow route preserves encoded filename characters and rejects encoded separators", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-server-follow-encoding-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const repo = path.join(root, "repo");
  await mkdir(path.join(repo, "a"), { recursive: true });
  const sourcePath = path.join(repo, "index.md");
  await Promise.all([
    writeFile(sourcePath, "# Index\n"),
    writeFile(path.join(repo, "a?b.md"), "# Question\n"),
    writeFile(path.join(repo, "a#b.md"), "# Hash\n"),
    writeFile(path.join(repo, "a", "b.md"), "# Nested\n"),
  ]);

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?encoding=${Date.now()}`);
    const renderedSource = await renderMarkdownFile(sourcePath, {
      meta: { repo: "repo", branch: "main", relativePath: "index.md", repoRoot: repo },
      catalogContext: { source: "manual" },
    });
    const { startServer } = await import(`../src/server.mjs?encoding=${Date.now()}`);
    const server = await startServer({ port: 0 });
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const follow = (target) => `${origin}/__mdview/follow/${renderedSource.catalogEntry.id}?${new URLSearchParams({ target })}`;

    for (const target of ["./a%3Fb.md", "./a%23b.md"]) {
      const response = await fetch(follow(target), { redirect: "manual" });
      assert.equal(response.status, 302, target);
    }
    assert.equal((await fetch(follow("./a%2Fb.md"), { redirect: "manual" })).status, 404);
    const catalog = await fetch(`${origin}/__mdview/catalog`).then((response) => response.json());
    assert.deepEqual(new Set(catalog.map((entry) => entry.title)), new Set(["Index", "Question", "Hash"]));
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
  }
});

test("workspace endpoints scope files and history to one worktree revision", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-server-workspace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const runtime = path.join(root, "runtime");
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  const firstPath = path.join(repo, "first.md");
  const secondPath = path.join(repo, "second.md");
  await writeFile(firstPath, "# First\n\n[Second](./second.md)\n");
  await writeFile(secondPath, "# Second\n\nBefore.\n");

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  const previousRuntime = process.env.MDVIEW_RUNTIME_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  process.env.MDVIEW_RUNTIME_DIR = runtime;
  try {
    const { renderMarkdownFile } = await import(`../src/renderer.mjs?workspace-server=${Date.now()}`);
    await renderMarkdownFile(firstPath, {
      meta: { repo: "repo", worktree: "feature/docs", branch: "feature/docs", relativePath: "first.md", repoRoot: repo },
      catalogContext: { source: "manual", renderedAt: "2026-08-15T10:00:00.000Z" },
    });
    await writeFile(secondPath, "# Second\n\nAfter.\n");
    await renderMarkdownFile(secondPath, {
      meta: { repo: "repo", worktree: "feature/docs", branch: "feature/docs", relativePath: "second.md", repoRoot: repo },
      catalogContext: { source: "manual", renderedAt: "2026-08-15T11:00:00.000Z" },
    });
    const { readWorkspaceHistoryForRoot, workspaceDocumentId } = await import(`../src/workspace-history.mjs?workspace-server=${Date.now()}`);
    const workspace = await readWorkspaceHistoryForRoot(repo);
    const currentRevision = workspace.revisions.at(-1);
    assert.deepEqual(workspace.revisions[0].changes, []);
    const secondId = workspaceDocumentId(repo, "second.md");
    const { startServer } = await import(`../src/server.mjs?workspace-server=${Date.now()}`);
    const server = await startServer({ port: 0 });
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;

    const summaries = await fetch(`${origin}/__mdview/workspaces`).then((response) => response.json());
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].worktree, "feature/docs");
    const details = await fetch(`${origin}/__mdview/workspaces/${workspace.workspaceId}?revision=${currentRevision.id}&document=${secondId}`).then((response) => response.json());
    assert.deepEqual(details.files.map((file) => file.relativePath), ["second.md", "first.md"]);
    assert.deepEqual(details.files.map((file) => file.updatedAt), [
      "2026-08-15T11:00:00.000Z",
      "2026-08-15T10:00:00.000Z",
    ]);
    assert.equal(details.revisions.length, 2);
    assert.ok(details.revisions.every((revision) => revision.href.includes(`/files/${secondId}`)));

    const documentResponse = await fetch(`${origin}${details.files.find((file) => file.documentId === secondId).href}?view=changes`);
    assert.equal(documentResponse.status, 200);
    const documentHtml = await documentResponse.text();
    assert.match(documentHtml, /data-view="changes"/);
    assert.match(documentHtml, /data-workspace-id="[a-f0-9]{24}"/);
    assert.match(documentHtml, /aria-label="このワークツリーのMarkdownを検索"/);
    assert.match(documentHtml, /data-diff-kind="removed"[^>]*>Before[.]<\/p>/);
    assert.match(documentHtml, /data-diff-kind="added"[^>]*>After[.]<\/p>/);

    await unlink(path.join(runtime, "history", "objects", `${currentRevision.files["second.md"]}.md`));
    const recoveredSnapshot = await fetch(`${origin}${details.files.find((file) => file.documentId === secondId).href}?view=changes`);
    assert.equal(recoveredSnapshot.status, 200);
    assert.match(await recoveredSnapshot.text(), /data-diff-kind="added"[^>]*>After[.]<\/p>/);

    const firstId = workspaceDocumentId(repo, "first.md");
    const firstHref = details.files.find((file) => file.documentId === firstId).href;
    const firstHtml = await fetch(`${origin}${firstHref}`).then((response) => response.text());
    const followedHref = firstHtml.match(/href="([^"]*\/__mdview\/follow\/[^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(followedHref);
    const followed = await fetch(new URL(followedHref, origin), { redirect: "manual" });
    assert.equal(followed.status, 302);
    assert.equal(followed.headers.get("location"), details.files.find((file) => file.documentId === secondId).href);

    await writeFile(path.join(runtime, "history", "workspaces", `${workspace.workspaceId}.json`), "{broken");
    const recoveredManifest = await fetch(`${origin}${details.files.find((file) => file.documentId === secondId).href}`);
    assert.equal(recoveredManifest.status, 200);
    assert.match(await recoveredManifest.text(), /After[.]/);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
    if (previousRuntime === undefined) delete process.env.MDVIEW_RUNTIME_DIR;
    else process.env.MDVIEW_RUNTIME_DIR = previousRuntime;
  }
});

test("main workspace history expands merged worktree sessions and keeps lineage while traversing", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-server-lineage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const runtime = path.join(root, "runtime");
  const mainRoot = path.join(root, "main");
  const featureRoot = path.join(root, "feature");
  await mkdir(mainRoot, { recursive: true });
  await mkdir(featureRoot, { recursive: true });

  const previousCache = process.env.MDVIEW_CACHE_DIR;
  const previousRuntime = process.env.MDVIEW_RUNTIME_DIR;
  process.env.MDVIEW_CACHE_DIR = cache;
  process.env.MDVIEW_RUNTIME_DIR = runtime;
  try {
    const { registerWorkspaceRevision, workspaceDocumentId, workspaceHistoryId } = await import(`../src/workspace-history.mjs?lineage-server=${Date.now()}`);
    const commonMeta = { repo: "repo", repositoryId: "a".repeat(24) };
    const feature1 = await registerWorkspaceRevision({
      root: featureRoot,
      renderedAt: "2026-08-16T10:00:00.000Z",
      source: "hook",
      sessionId: "feature-session-1",
      turnId: "feature-turn-1",
      meta: { ...commonMeta, worktree: "feature/docs", branch: "feature/docs", head: "bbbbbbb" },
      files: { "README.md": "b".repeat(64) },
      changes: [],
    });
    const feature2 = await registerWorkspaceRevision({
      root: featureRoot,
      renderedAt: "2026-08-16T11:00:00.000Z",
      source: "hook",
      sessionId: "feature-session-2",
      turnId: "feature-turn-2",
      meta: { ...commonMeta, worktree: "feature/docs", branch: "feature/docs", head: "ccccccc" },
      files: { "README.md": "c".repeat(64) },
      changes: [],
    });
    const main1 = await registerWorkspaceRevision({
      root: mainRoot,
      renderedAt: "2026-08-16T09:00:00.000Z",
      source: "hook",
      sessionId: "main-session",
      turnId: "main-turn-1",
      meta: { ...commonMeta, worktree: "repo", branch: "main", head: "aaaaaaa" },
      files: { "README.md": "a".repeat(64) },
      changes: [],
    });
    const main2 = await registerWorkspaceRevision({
      root: mainRoot,
      renderedAt: "2026-08-16T12:00:00.000Z",
      source: "hook",
      sessionId: "merge-session",
      turnId: "main-turn-2",
      meta: { ...commonMeta, worktree: "repo", branch: "main", head: "ddddddd" },
      files: { "README.md": "c".repeat(64) },
      changes: [],
      mergeSources: [{
        workspaceId: workspaceHistoryId(featureRoot),
        throughRevisionId: feature2.revision.id,
        reason: "git-ancestry",
      }],
    });

    const { startServer } = await import(`../src/server.mjs?lineage-server=${Date.now()}`);
    const server = await startServer({ port: 0 });
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const mainDocumentId = workspaceDocumentId(mainRoot, "README.md");
    const mainDetails = await fetch(`${origin}/__mdview/workspaces/${main2.manifest.workspaceId}?revision=${main2.revision.id}&document=${mainDocumentId}`).then((response) => response.json());
    assert.deepEqual(mainDetails.revisions.map((revision) => revision.sessionId), [
      "main-session",
      "feature-session-1",
      "feature-session-2",
      "merge-session",
    ]);
    assert.deepEqual(mainDetails.revisions.map((revision) => revision.imported), [false, true, true, false]);
    assert.deepEqual(mainDetails.revisions.map((revision) => revision.lineageReason), [null, "git-ancestry", "git-ancestry", null]);
    const importedHref = mainDetails.revisions[1].href;
    assert.match(importedHref, new RegExp(`^/__mdview/workspaces/${feature1.manifest.workspaceId}/revisions/${feature1.revision.id}/files/[a-f0-9]{24}[?]lineage=${main2.manifest.workspaceId}$`));

    const importedUrl = new URL(importedHref, origin);
    const sourceDocumentId = importedUrl.pathname.split("/").at(-1);
    const sourceDetails = await fetch(`${origin}/__mdview/workspaces/${feature1.manifest.workspaceId}?revision=${feature1.revision.id}&document=${sourceDocumentId}&lineage=${main2.manifest.workspaceId}`).then((response) => response.json());
    assert.deepEqual(sourceDetails.revisions.map((revision) => revision.sessionId), mainDetails.revisions.map((revision) => revision.sessionId));
    assert.ok(sourceDetails.files.every((file) => file.href.endsWith(`?lineage=${main2.manifest.workspaceId}`)));
    assert.equal(sourceDetails.lineageWorkspaceId, main2.manifest.workspaceId);
    assert.equal(mainDetails.revisions[0].id, main1.revision.id);
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
    if (previousRuntime === undefined) delete process.env.MDVIEW_RUNTIME_DIR;
    else process.env.MDVIEW_RUNTIME_DIR = previousRuntime;
  }
});

test("only a verified mdview daemon command is eligible for protocol upgrade restart", async () => {
  const { isMdviewDaemonCommand, parseMdviewHealth } = await import(`../src/server.mjs?daemon=${Date.now()}`);
  assert.equal(isMdviewDaemonCommand("/opt/homebrew/bin/node /repo/mdview/src/cli.mjs serve --daemon"), true);
  assert.equal(isMdviewDaemonCommand("node /repo/other/src/cli.mjs serve --daemon"), false);
  assert.equal(isMdviewDaemonCommand("python /repo/mdview/src/cli.mjs serve --daemon"), false);
  assert.equal(isMdviewDaemonCommand("node /repo/mdview/src/cli.mjs render README.md"), false);
  assert.equal(isMdviewDaemonCommand("node malicious.mjs serve --daemon"), false);
  assert.deepEqual(parseMdviewHealth(`mdview/8 ${"a".repeat(24)}\n`), { protocol: 8, buildId: "a".repeat(24) });
  assert.deepEqual(parseMdviewHealth("mdview/6\n"), { protocol: 6, buildId: null });
  assert.equal(parseMdviewHealth(`mdview/6 ${"a".repeat(24)}\nextra`), null);
});
