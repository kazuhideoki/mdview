import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { historyRevisionId, registerHistoryRevision, storeHistoryRenderedHtml } from "../src/history.mjs";

test("loopback server serves only cache files and rejects writes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdview-server-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  await mkdir(path.join(cache, "documents"), { recursive: true });
  await mkdir(path.join(root, "repo"), { recursive: true });
  await writeFile(path.join(cache, "documents", "page.html"), "<!doctype html><title>ok</title>");
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
  const { startServer } = await import(`../src/server.mjs?test=${Date.now()}`);
  const server = await startServer({ port: 0 });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  try {
    const port = server.address().port;
    const health = await fetch(`http://127.0.0.1:${port}/__mdview_health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "mdview/1\n");

    const page = await fetch(`http://127.0.0.1:${port}/documents/page.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>ok/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");

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
    const recoveredHistory = await fetch(`http://127.0.0.1:${port}/__mdview/history/${registered.id}`);
    assert.equal(recoveredHistory.status, 200);
    const restoredPage = await fetch(`http://127.0.0.1:${port}/documents/page.html`);
    assert.equal(restoredPage.status, 200);
    assert.match(await restoredPage.text(), /<title>restored/);

    const invalidHistory = await fetch(`http://127.0.0.1:${port}/__mdview/history/not-an-id`);
    assert.equal(invalidHistory.status, 404);

    const catalogHead = await fetch(`http://127.0.0.1:${port}/__mdview/catalog`, { method: "HEAD" });
    assert.equal(catalogHead.status, 200);
    assert.equal(catalogHead.headers.get("cache-control"), "no-store");
    assert.equal(await catalogHead.text(), "");
  } finally {
    if (previousCache === undefined) delete process.env.MDVIEW_CACHE_DIR;
    else process.env.MDVIEW_CACHE_DIR = previousCache;
    if (previousRuntime === undefined) delete process.env.MDVIEW_RUNTIME_DIR;
    else process.env.MDVIEW_RUNTIME_DIR = previousRuntime;
  }
});

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
