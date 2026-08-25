import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readCatalog, registerCatalogEntry } from "../src/catalog.mjs";
import { readDocumentHistory, storeHistorySnapshot } from "../src/history.mjs";

const CLI_PATH = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mdview-cli-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = path.join(directory, "cache");
  const runtime = path.join(directory, "runtime");
  const state = path.join(directory, "state");
  const workspace = path.join(directory, "workspace");
  const port = 4319;
  await mkdir(workspace, { recursive: true });
  return {
    directory,
    cache,
    runtime,
    state,
    workspace,
    port,
    environment: {
      MDVIEW_CACHE_DIR: cache,
      MDVIEW_RUNTIME_DIR: runtime,
      MDVIEW_STATE_DIR: state,
      MDVIEW_LOG: path.join(directory, "mdview.log"),
      MDVIEW_HOOK_LOG: path.join(directory, "hook.log"),
      MDVIEW_PORT: String(port),
      MDVIEW_BROWSER: "none",
    },
  };
}

async function addEntry(fixtureValue, name, renderedAt) {
  const outputPath = path.join(fixtureValue.cache, "documents", "repo-id", `${name}.md.html`);
  const sourcePath = path.join(fixtureValue.workspace, "docs", `${name}.md`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(outputPath, `<!doctype html><title>${name}</title>`);
  await writeFile(sourcePath, `# ${name}\n`);
  return registerCatalogEntry({
    title: `${name} title`,
    repo: "catalog-repo",
    branch: "feature/history",
    relativePath: `docs/${name}.md`,
    sourcePath,
    outputPath,
    catalogContext: { source: "manual", renderedAt },
  }, { root: fixtureValue.cache });
}

test("no arguments explains how to seed an empty catalog and creates no demo", async (t) => {
  const current = await fixture(t);
  const result = await runCli([], current.environment);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /No rendered Markdown documents yet/);
  assert.match(result.stderr, /mdview open <file[.]md>/);
  assert.deepEqual(await readCatalog({ root: current.cache }), []);
});

test("list numbering, open number, and the default command share newest-first order", async (t) => {
  const current = await fixture(t);
  const older = await addEntry(current, "older", "2026-08-13T09:00:00.000Z");
  const newer = await addEntry(current, "newer", "2026-08-13T10:00:00.000Z");
  const listed = await runCli(["list"], current.environment);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /^1[.] newer title\n   catalog-repo@feature\/history · docs\/newer[.]md\n2[.] older title/m);

  const numbered = await runCli(["open", "2"], current.environment);
  assert.equal(numbered.code, 0);
  assert.equal(numbered.stdout, `${absoluteHref(older.href, current.port)}\n`);

  const defaultOpen = await runCli([], current.environment);
  assert.equal(defaultOpen.code, 0);
  assert.equal(defaultOpen.stdout, `${absoluteHref(newer.href, current.port)}\n`);

  const removedRecent = await runCli(["recent"], current.environment);
  assert.equal(removedRecent.code, 1);
  assert.match(removedRecent.stderr, /Unknown command: recent/);

  const missing = await runCli(["open", "3"], current.environment);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Catalog entry 3 does not exist/);
  assert.match(missing.stderr, /mdview list/);
});

test("open file and direct Markdown path both record a manual catalog source", async (t) => {
  const current = await fixture(t);
  const explicit = path.join(current.workspace, "explicit.md");
  const direct = path.join(current.workspace, "direct.md");
  await writeFile(explicit, "# Explicit document\n\nHello.\n");
  await writeFile(direct, "# Direct document\n\nHello.\n");

  const opened = await runCli(["open", explicit], current.environment);
  assert.equal(opened.code, 0, opened.stderr);
  const shortcut = await runCli([direct], current.environment);
  assert.equal(shortcut.code, 0, shortcut.stderr);
  const entries = await readCatalog({ root: current.cache });
  assert.equal(entries.length, 2);
  assert.deepEqual(new Set(entries.map((entry) => entry.sourcePath)), new Set([explicit, direct]));
  for (const entry of entries) {
    assert.equal(entry.source, "manual");
    assert.equal(entry.sessionId, null);
    assert.equal(entry.turnId, null);
  }
});

test("demo renders two revisions and opens the inline Changes view", async (t) => {
  const current = await fixture(t);
  const result = await runCli(["demo"], current.environment);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /[?]view=changes\n$/);

  const [entry] = await readCatalog({ root: current.cache });
  const renderedPath = path.join(current.cache, ...new URL(entry.href, "http://mdview.local").pathname.split("/").filter(Boolean));
  const renderedHtml = await readFile(renderedPath, "utf8");
  assert.match(renderedHtml, /data-diff-kind="removed"/);
  assert.match(renderedHtml, /data-diff-kind="added"/);
  assert.match(renderedHtml, /デプロイ単位で定義します/);
  assert.match(renderedHtml, /デプロイ単位かつ障害ドメインの単位で定義します/);

  const history = await readDocumentHistory(entry.id, { root: path.join(current.runtime, "history") });
  assert.equal(history.revisions.length, 2);
  assert.equal(history.revisions[1].beforeContentHash, history.revisions[0].contentHash);
});

test("help documents history commands and reader search shortcuts", async (t) => {
  const current = await fixture(t);
  const result = await runCli(["--help"], current.environment);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /mdview list/);
  assert.doesNotMatch(result.stdout, /mdview recent/);
  assert.match(result.stdout, /mdview open <number>/);
  assert.match(result.stdout, /R \/ C[ ]+Switch to Read \/ Changes/);
  assert.match(result.stdout, /Left \/ Right[ ]+Switch views/);
  assert.match(result.stdout, /Cmd\+Shift\+K[ ]+Select a worktree/);
  assert.match(result.stdout, /Cmd\+Shift\+O[ ]+Show and search the current document outline/);
  assert.match(result.stdout, /Cmd\+K or \/[ ]+Search Markdown in the selected worktree/);
});

test("Stop hook passes session and turn identity through the private worker job", async (t) => {
  const current = await fixture(t);
  const markdown = path.join(current.workspace, "hooked.md");
  await writeFile(markdown, "# Before\n");
  const basePayload = {
    session_id: "session-catalog",
    turn_id: "turn-catalog",
    cwd: current.workspace,
    transcript_path: null,
  };

  const prompt = await runCli(["--hook"], current.environment, JSON.stringify({
    ...basePayload,
    hook_event_name: "UserPromptSubmit",
  }));
  assert.deepEqual({ code: prompt.code, stdout: prompt.stdout, stderr: prompt.stderr }, {
    code: 0,
    stdout: "",
    stderr: "",
  });
  await writeFile(markdown, "# After\n");
  const stop = await runCli(["--hook"], current.environment, JSON.stringify({
    ...basePayload,
    hook_event_name: "Stop",
  }));
  assert.deepEqual({ code: stop.code, stdout: stop.stdout, stderr: stop.stderr }, {
    code: 0,
    stdout: "",
    stderr: "",
  });

  const entry = await waitForCatalogEntry(current.cache);
  assert.equal(entry.source, "hook");
  assert.equal(entry.sessionId, "session-catalog");
  assert.equal(entry.turnId, "turn-catalog");
  assert.equal(entry.sourcePath, markdown);
  const history = await readDocumentHistory(entry.id, { root: path.join(current.runtime, "history") });
  assert.equal(history.revisions.length, 1);
  assert.equal(history.revisions[0].sessionId, "session-catalog");
  assert.equal(history.revisions[0].turnId, "turn-catalog");
  assert.match(history.revisions[0].beforeContentHash, /^[a-f0-9]{64}$/);
  const renderedPath = path.join(current.cache, ...new URL(entry.href, "http://mdview.local").pathname.split("/").filter(Boolean));
  const renderedHtml = await readFile(renderedPath, "utf8");
  assert.match(renderedHtml, /<h1[^>]*data-diff-kind="removed"[^>]*>.*Before/);
  assert.match(renderedHtml, /<h1[^>]*data-diff-kind="added"[^>]*>.*After/);
});

test("a failed hook worker retains its job until a successful retry", async (t) => {
  const current = await fixture(t);
  const jobs = path.join(current.runtime, "jobs");
  const jobPath = path.join(jobs, "retry.json");
  await mkdir(jobs, { recursive: true });
  const job = {
    version: 2,
    changedFiles: [path.join(current.workspace, "missing.md")],
    sessionId: "retry-session",
    turnId: "retry-turn",
    renderedAt: "2026-08-13T10:00:00.000Z",
  };
  await writeFile(jobPath, `${JSON.stringify(job)}\n`);

  const failed = await runCli(["--hook-worker", jobPath], current.environment);
  assert.equal(failed.code, 1);
  await access(jobPath);

  await writeFile(jobPath, `${JSON.stringify({ ...job, changedFiles: [] })}\n`);
  const retried = await runCli(["--hook-worker", jobPath], current.environment);
  assert.equal(retried.code, 0, retried.stderr);
  await assert.rejects(access(jobPath), { code: "ENOENT" });
});

test("a hook worker renders without starting the server or opening a browser", async (t) => {
  const current = await fixture(t);
  const jobs = path.join(current.runtime, "jobs");
  const jobPath = path.join(jobs, "render-only.json");
  const markdown = path.join(current.workspace, "render-only.md");
  await mkdir(jobs, { recursive: true });
  await writeFile(markdown, "# Render only\n");
  await writeFile(jobPath, `${JSON.stringify({
    version: 2,
    changedFiles: [markdown],
    sessionId: "render-only-session",
    turnId: "render-only-turn",
    renderedAt: "2026-08-13T10:00:00.000Z",
  })}\n`);

  const result = await runCli(["--hook-worker", jobPath], {
    ...current.environment,
    MDVIEW_BROWSER: "com.example.mdview-browser-must-not-open",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal((await readCatalog({ root: current.cache }))[0].sourcePath, markdown);
  assert.match(await readFile(current.environment.MDVIEW_HOOK_LOG, "utf8"), /available from mdview/);
  await assert.rejects(access(jobPath), { code: "ENOENT" });
});

test("a delayed hook worker renders the captured snapshot instead of newer live contents", async (t) => {
  const current = await fixture(t);
  const jobs = path.join(current.runtime, "jobs");
  const jobPath = path.join(jobs, "captured.json");
  const markdown = path.join(current.workspace, "captured.md");
  const before = "# Before\n";
  const captured = "# Captured turn\n";
  await mkdir(jobs, { recursive: true });
  await writeFile(markdown, "# Newer live contents\n");
  const beforeSnapshot = await storeHistorySnapshot(before, { root: path.join(current.runtime, "history") });
  const capturedSnapshot = await storeHistorySnapshot(captured, { root: path.join(current.runtime, "history") });
  await writeFile(jobPath, `${JSON.stringify({
    version: 3,
    changes: [{
      filePath: markdown,
      beforeContentHash: beforeSnapshot.contentHash,
      contentHash: capturedSnapshot.contentHash,
    }],
    sessionId: "captured-session",
    turnId: "captured-turn",
    renderedAt: "2026-08-13T10:00:00.000Z",
  })}\n`);

  const result = await runCli(["--hook-worker", jobPath], current.environment);
  assert.equal(result.code, 0, result.stderr);
  const [entry] = await readCatalog({ root: current.cache });
  const renderedPath = path.join(current.cache, ...new URL(entry.href, "http://mdview.local").pathname.split("/").filter(Boolean));
  const renderedHtml = await readFile(renderedPath, "utf8");
  assert.match(renderedHtml, /Captured turn/);
  assert.doesNotMatch(renderedHtml, /Newer live contents/);
  const history = await readDocumentHistory(entry.id, { root: path.join(current.runtime, "history") });
  assert.equal(history.revisions[0].contentHash, capturedSnapshot.contentHash);
});

async function waitForCatalogEntry(root) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const entries = await readCatalog({ root });
    if (entries.length > 0) return entries[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the hook worker to update the catalog.");
}

function absoluteHref(href, port) {
  return new URL(href, `http://127.0.0.1:${port}`).href;
}

function runCli(args, environment, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
