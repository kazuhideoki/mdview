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
      <button type="button" data-view-target="raw" aria-pressed="false">Raw diff</button>
      <section hidden="hidden" class="panel mdv-raw-diff">diff</section>
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
    sessionId: null,
    turnId: null,
    beforeContentHash: null,
    contentHash: "a".repeat(64),
  });
  const revisionId = historyRevisionId({
    documentId: registered.id,
    renderedAt: "2026-08-13T10:00:00.000Z",
    contentHash: "a".repeat(64),
    sessionId: null,
    turnId: null,
  });
  await storeHistoryRenderedHtml(registered.id, revisionId, "<!doctype html><title>restored</title>");
  const durableAsset = path.join(cache, "assets", "viewer.test.js");
  await mkdir(path.dirname(durableAsset), { recursive: true });
  await writeFile(durableAsset, "window.mdviewRestored = true;\n");
  await storeHistoryCacheArtifacts([durableAsset], { cacheRoot: cache });
  const { startServer } = await import(`../src/server.mjs?test=${Date.now()}`);
  const server = await startServer({ port: 0 });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  try {
    const port = server.address().port;
    const health = await fetch(`http://127.0.0.1:${port}/__mdview_health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "mdview/6\n");

    const page = await fetch(`http://127.0.0.1:${port}/documents/page.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>ok/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");

    const changesPage = await fetch(`http://127.0.0.1:${port}/documents/page.html?view=changes`);
    const changesHtml = await changesPage.text();
    assert.match(changesHtml, /data-view="changes" class="shell mdv-app"/);
    assert.match(changesHtml, /data-view-target="read" aria-pressed="false"/);
    assert.match(changesHtml, /data-view-target="changes" aria-pressed="true"/);
    assert.match(changesHtml, /hidden="" class="panel mdv-raw-diff"/);

    const rawPage = await fetch(`http://127.0.0.1:${port}/documents/page.html?view=raw`);
    const rawHtml = await rawPage.text();
    assert.match(rawHtml, /data-view="raw" class="shell mdv-app"/);
    assert.match(rawHtml, /data-view-target="raw" aria-pressed="true"/);
    assert.doesNotMatch(rawHtml, /<section[^>]*\shidden(?:\s|=|>)/);

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
        sessionId: null,
        turnId: null,
      }],
    });

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
    assert.match((await opened.json()).href, /^\/documents\/.+[.]html$/);
    const openedCatalog = await fetch(`http://127.0.0.1:${port}/__mdview/catalog`).then((response) => response.json());
    assert.equal(openedCatalog[0].title, "Opened from palette");
    assert.equal(openedCatalog[0].source, "manual");

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

test("following a relative Markdown link renders, registers, and redirects within mdview", async (context) => {
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
    assert.match(followed.headers.get("location"), /^\/documents\/.+[.]html#%E5%88%A9%E7%94%A8%E6%96%B9%E6%B3%95$/);

    const catalog = await fetch(`${origin}/__mdview/catalog`).then((response) => response.json());
    assert.equal(catalog.length, 2);
    const linked = catalog.find((entry) => entry.source === "link");
    assert.equal(linked?.source, "link");
    assert.equal(linked?.title, "Guide");
    assert.equal(linked?.relativePath, "設計 guide.md");
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

test("only a verified mdview daemon command is eligible for protocol upgrade restart", async () => {
  const { isMdviewDaemonCommand } = await import(`../src/server.mjs?daemon=${Date.now()}`);
  assert.equal(isMdviewDaemonCommand("/opt/homebrew/bin/node /repo/mdview/src/cli.mjs serve --daemon"), true);
  assert.equal(isMdviewDaemonCommand("node /repo/other/src/cli.mjs serve --daemon"), false);
  assert.equal(isMdviewDaemonCommand("python /repo/mdview/src/cli.mjs serve --daemon"), false);
  assert.equal(isMdviewDaemonCommand("node /repo/mdview/src/cli.mjs render README.md"), false);
  assert.equal(isMdviewDaemonCommand("node malicious.mjs serve --daemon"), false);
});
