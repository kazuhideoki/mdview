import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  catalogEntryId,
  readCatalog,
  registerCatalogEntry,
} from "../src/catalog.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mdview-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "cache");
  const documents = path.join(root, "documents", "repo-id");
  const sourceDirectory = path.join(directory, "repo", "docs");
  await Promise.all([
    mkdir(documents, { recursive: true }),
    mkdir(sourceDirectory, { recursive: true }),
  ]);
  return { directory, root, documents, sourceDirectory };
}

function input(directory, outputPath, name, catalogContext, overrides = {}) {
  return {
    title: `${name} title`,
    repo: "repo",
    branch: "feature/catalog",
    relativePath: `docs/${name}.md`,
    sourcePath: path.join(directory, "repo", "docs", `${name}.md`),
    outputPath,
    catalogContext,
    ...overrides,
  };
}

test("concurrent renders create one atomic JSON per document and read newest first", async (t) => {
  const { directory, root, documents, sourceDirectory } = await fixture(t);
  const olderHtml = path.join(documents, "older.md.html");
  const newerHtml = path.join(documents, "newer.md.html");
  await Promise.all([
    writeFile(olderHtml, "<!doctype html><title>older</title>"),
    writeFile(newerHtml, "<!doctype html><title>newer</title>"),
    writeFile(path.join(sourceDirectory, "older.md"), "# Older\n"),
    writeFile(path.join(sourceDirectory, "newer.md"), "# Newer\n"),
  ]);

  const [older, newer] = await Promise.all([
    registerCatalogEntry(input(directory, olderHtml, "older", {
      renderedAt: "2026-08-13T09:00:00.000Z",
      source: "manual",
    }), { root }),
    registerCatalogEntry(input(directory, newerHtml, "newer", {
      renderedAt: "2026-08-13T10:00:00.000Z",
      source: "codex-hook",
      sessionId: "session-1",
      turnId: "turn-2",
    }), { root }),
  ]);

  assert.equal((await readdir(path.join(root, "catalog"))).length, 2);
  const entries = await readCatalog({ root });
  assert.deepEqual(entries.map((entry) => entry.id), [newer.id, older.id]);
  assert.deepEqual(entries[0], {
    id: catalogEntryId(path.join(sourceDirectory, "newer.md")),
    title: "newer title",
    repo: "repo",
    branch: "feature/catalog",
    relativePath: "docs/newer.md",
    sourcePath: path.join(sourceDirectory, "newer.md"),
    href: "/documents/repo-id/newer.md.html",
    renderedAt: "2026-08-13T10:00:00.000Z",
    source: "codex-hook",
    sessionId: "session-1",
    turnId: "turn-2",
  });

  await Promise.all(Array.from({ length: 12 }, (_, index) => registerCatalogEntry(
    input(directory, newerHtml, "newer", {
      renderedAt: `2026-08-13T10:00:${String(index).padStart(2, "0")}.000Z`,
      source: "codex-hook",
      sessionId: "session-1",
      turnId: `turn-${index}`,
    }),
    { root },
  )));
  const files = await readdir(path.join(root, "catalog"));
  assert.equal(files.length, 2);
  const currentRecord = await readFile(path.join(root, "catalog", `${newer.id}.json`), "utf8");
  assert.doesNotThrow(() => JSON.parse(currentRecord));
});

test("equal renderedAt values are sorted deterministically by id", async (t) => {
  const { directory, root, documents, sourceDirectory } = await fixture(t);
  const timestamp = "2026-08-13T10:00:00.000Z";
  const registered = [];
  for (const name of ["alpha", "beta"]) {
    const outputPath = path.join(documents, `${name}.html`);
    await Promise.all([
      writeFile(outputPath, `<!doctype html><title>${name}</title>`),
      writeFile(path.join(sourceDirectory, `${name}.md`), `# ${name}\n`),
    ]);
    registered.push(await registerCatalogEntry(input(directory, outputPath, name, {
      renderedAt: timestamp,
      source: "manual",
    }), { root }));
  }

  const expected = registered.map((entry) => entry.id).sort();
  assert.deepEqual((await readCatalog({ root })).map((entry) => entry.id), expected);
  assert.deepEqual((await readCatalog({ root })).map((entry) => entry.id), expected);
});

test("readCatalog ignores malformed records and entries without a served HTML file", async (t) => {
  const { directory, root, documents, sourceDirectory } = await fixture(t);
  const validHtml = path.join(documents, "valid.html");
  const nonDocumentHtml = path.join(root, "assets", "not-a-document.html");
  await mkdir(path.dirname(nonDocumentHtml), { recursive: true });
  await Promise.all([
    writeFile(validHtml, "<!doctype html><title>valid</title>"),
    writeFile(nonDocumentHtml, "<!doctype html><title>asset</title>"),
    ...["valid", "missing", "outside-documents"].map((name) =>
      writeFile(path.join(sourceDirectory, `${name}.md`), `# ${name}\n`)),
  ]);
  const valid = await registerCatalogEntry(input(directory, validHtml, "valid", {
    renderedAt: "2026-08-13T10:00:00.000Z",
    source: "manual",
  }), { root });
  await registerCatalogEntry(input(directory, path.join(documents, "missing.html"), "missing", {
    renderedAt: "2026-08-13T11:00:00.000Z",
    source: "manual",
  }), { root });
  await registerCatalogEntry(input(directory, nonDocumentHtml, "outside-documents", {
    renderedAt: "2026-08-13T12:00:00.000Z",
    source: "manual",
  }), { root });
  await writeFile(path.join(root, "catalog", "aaaaaaaaaaaaaaaaaaaaaaaa.json"), "{broken");
  await writeFile(path.join(root, "catalog", ".temporary.tmp"), "partial");

  assert.deepEqual((await readCatalog({ root })).map((entry) => entry.id), [valid.id]);
  await rm(validHtml);
  assert.deepEqual(await readCatalog({ root }), []);
});

test("encoded paths round-trip while traversal, escaping symlinks, and missing sources are hidden", async (t) => {
  const { directory, root, documents, sourceDirectory } = await fixture(t);
  const specialName = "設計 #1?";
  const specialSource = path.join(sourceDirectory, `${specialName}.markdown`);
  const specialHtml = path.join(documents, `${specialName}.markdown.html`);
  await Promise.all([
    writeFile(specialSource, "# 設計\n"),
    writeFile(specialHtml, "<!doctype html><title>設計</title>"),
  ]);
  const special = await registerCatalogEntry(input(directory, specialHtml, specialName, {
    renderedAt: "2026-08-13T10:00:00.000Z",
    source: "manual",
  }, {
    relativePath: `docs/${specialName}.markdown`,
    sourcePath: specialSource,
  }), { root });

  assert.equal((await readCatalog({ root }))[0].href, "/documents/repo-id/%E8%A8%AD%E8%A8%88%20%231%3F.markdown.html");

  await assert.rejects(
    registerCatalogEntry(input(directory, path.join(root, "..", "outside.html"), "traversal", {
      source: "manual",
    }), { root }),
    /outside the mdview cache/,
  );

  const outsideHtml = path.join(directory, "outside.html");
  const symlinkHtml = path.join(documents, "escape.html");
  await Promise.all([
    writeFile(outsideHtml, "<!doctype html><title>outside</title>"),
    writeFile(path.join(sourceDirectory, "escape.md"), "# Escape\n"),
  ]);
  await symlink(outsideHtml, symlinkHtml);
  await registerCatalogEntry(input(directory, symlinkHtml, "escape", {
    renderedAt: "2026-08-13T11:00:00.000Z",
    source: "manual",
  }), { root });

  const goneSource = path.join(sourceDirectory, "gone.md");
  const goneHtml = path.join(documents, "gone.html");
  await Promise.all([
    writeFile(goneSource, "# Gone\n"),
    writeFile(goneHtml, "<!doctype html><title>gone</title>"),
  ]);
  await registerCatalogEntry(input(directory, goneHtml, "gone", {
    renderedAt: "2026-08-13T12:00:00.000Z",
    source: "manual",
  }), { root });
  await rm(goneSource);

  const forgedSource = path.join(sourceDirectory, "forged.md");
  const forgedHtml = path.join(documents, "forged.html");
  await Promise.all([
    writeFile(forgedSource, "# Forged\n"),
    writeFile(forgedHtml, "<!doctype html><title>forged</title>"),
    writeFile(path.join(root, "outside.html"), "<!doctype html><title>outside cache document root</title>"),
  ]);
  const forged = await registerCatalogEntry(input(directory, forgedHtml, "forged", {
    renderedAt: "2026-08-13T13:00:00.000Z",
    source: "manual",
  }), { root });
  const forgedPath = path.join(root, "catalog", `${forged.id}.json`);
  const forgedRecord = JSON.parse(await readFile(forgedPath, "utf8"));
  forgedRecord.href = "/documents/repo-id/%2e%2e%2f%2e%2e%2foutside.html";
  await writeFile(forgedPath, `${JSON.stringify(forgedRecord)}\n`);

  assert.deepEqual((await readCatalog({ root })).map((entry) => entry.id), [special.id]);
  await rm(specialSource);
  assert.deepEqual(await readCatalog({ root }), []);
});
