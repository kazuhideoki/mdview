import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import {
  cleanupHookStates,
  hookStateKey,
  hookStatePath,
  processHookEvent,
  scanMarkdownFiles,
} from "../src/hook-event.mjs";
import { readHistorySnapshot } from "../src/history.mjs";
import { readWorkspaceHistoryForRoot } from "../src/workspace-history.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mdview-hook-event-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "workspace");
  const stateDir = path.join(directory, "state");
  const historyRoot = path.join(directory, "history");
  await mkdir(cwd, { recursive: true });
  return { directory, cwd, stateDir, historyRoot };
}

function payload(cwd, eventName, overrides = {}) {
  return {
    session_id: "session-a",
    turn_id: "turn-1",
    cwd,
    hook_event_name: eventName,
    ...overrides,
  };
}

test("state is keyed by sha256(session_id + turn_id)", () => {
  const event = { session_id: "session-a", turn_id: "turn-1" };
  const expected = createHash("sha256").update("session-aturn-1").digest("hex");
  assert.equal(hookStateKey(event), expected);
});

test("UserPromptSubmit preserves its first baseline; Stop detects and advances it", async (t) => {
  const { cwd, stateDir, historyRoot } = await fixture(t);
  const docs = path.join(cwd, "docs");
  await mkdir(docs);
  await writeFile(path.join(cwd, "README.md"), "before\n");
  await writeFile(path.join(docs, "old.markdown"), "will be deleted\n");
  await mkdir(path.join(cwd, "node_modules"));
  await writeFile(path.join(cwd, "node_modules", "ignored.md"), "ignored\n");
  const start = payload(cwd, "UserPromptSubmit");

  assert.equal((await processHookEvent(start, { stateDir, historyRoot })).action, "baseline-created");
  await writeFile(path.join(cwd, "README.md"), "after first prompt\n");
  assert.equal((await processHookEvent(start, { stateDir, historyRoot })).action, "baseline-preserved");
  await writeFile(path.join(docs, "new.md"), "new\n");
  await rm(path.join(docs, "old.markdown"));

  const callbacks = [];
  const stop = await processHookEvent(payload(cwd, "Stop"), {
    stateDir,
    historyRoot,
    onChangedFiles: async (result, event) => callbacks.push({ result, event }),
  });
  assert.equal(stop.action, "compared");
  assert.deepEqual(stop.changedFiles, [path.join(docs, "new.md"), path.join(cwd, "README.md")]);
  assert.deepEqual(stop.deletedFiles, [path.join(docs, "old.markdown")]);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].event.hook_event_name, "Stop");
  const workspaceHistory = await readWorkspaceHistoryForRoot(cwd, { root: historyRoot });
  assert.equal(workspaceHistory.revisions.length, 1);
  assert.equal(workspaceHistory.revisions[0].sessionId, "session-a");
  assert.deepEqual(workspaceHistory.revisions[0].changes.map(({ path: file, kind }) => [file, kind]), [
    ["docs/new.md", "added"],
    ["docs/old.markdown", "deleted"],
    ["README.md", "modified"],
  ]);

  const repeated = await processHookEvent(payload(cwd, "Stop"), {
    stateDir,
    historyRoot,
    onChangedFiles: async () => callbacks.push("unexpected"),
  });
  assert.deepEqual(repeated.changedFiles, []);
  assert.deepEqual(repeated.deletedFiles, []);
  assert.equal(callbacks.length, 1);
});

test("a Stop without a prompt establishes a baseline without reporting every document", async (t) => {
  const { cwd, stateDir, historyRoot } = await fixture(t);
  await writeFile(path.join(cwd, "README.md"), "existing\n");
  const result = await processHookEvent(payload(cwd, "Stop"), { stateDir, historyRoot });
  assert.equal(result.action, "baseline-created");
  assert.deepEqual(result.changedFiles, []);
  const workspaceHistory = await readWorkspaceHistoryForRoot(cwd, { root: historyRoot });
  assert.equal(workspaceHistory.revisions.length, 1);
  assert.equal(await readHistorySnapshot(workspaceHistory.revisions[0].files["README.md"], { root: historyRoot }), "existing\n");
});

test("a Stop asks repository sync to update the primary worktree", async (t) => {
  const { cwd, stateDir, historyRoot } = await fixture(t);
  await writeFile(path.join(cwd, "README.md"), "existing\n");
  const calls = [];
  const result = await processHookEvent(payload(cwd, "Stop"), {
    stateDir,
    historyRoot,
    reconcilePrimaryWorkspace: async (sourceRoot) => {
      calls.push(sourceRoot);
      return { action: "reconciled", added: true, revision: { id: "a".repeat(24) } };
    },
  });
  assert.deepEqual(calls, [cwd]);
  assert.equal(result.repositorySync.action, "reconciled");
});

test("a new session records changes that arrived before its prompt against the prior workspace revision", async (t) => {
  const { cwd, stateDir, historyRoot } = await fixture(t);
  const markdownPath = path.join(cwd, "README.md");
  await writeFile(markdownPath, "before\n");
  await processHookEvent(payload(cwd, "UserPromptSubmit"), { stateDir, historyRoot });
  await writeFile(markdownPath, "first session\n");
  await processHookEvent(payload(cwd, "Stop"), { stateDir, historyRoot, now: Date.parse("2026-08-16T10:00:00Z") });

  await writeFile(markdownPath, "merged before next session\n");
  const nextPrompt = payload(cwd, "UserPromptSubmit", { session_id: "session-b", turn_id: "turn-2" });
  await processHookEvent(nextPrompt, { stateDir, historyRoot });
  const stop = await processHookEvent({ ...nextPrompt, hook_event_name: "Stop" }, {
    stateDir,
    historyRoot,
    now: Date.parse("2026-08-16T11:00:00Z"),
  });

  assert.deepEqual(stop.changedFiles, []);
  const workspace = await readWorkspaceHistoryForRoot(cwd, { root: historyRoot });
  assert.equal(workspace.revisions.length, 2);
  assert.equal(workspace.revisions[1].sessionId, "session-b");
  assert.deepEqual(workspace.revisions[1].changes, [{
    path: "README.md",
    kind: "modified",
    beforeContentHash: createHash("sha256").update("first session\n").digest("hex"),
    contentHash: createHash("sha256").update("merged before next session\n").digest("hex"),
  }]);
});

test("an interrupted Stop retries without losing its workspace revision or changes", async (t) => {
  const { cwd, stateDir, historyRoot } = await fixture(t);
  const markdownPath = path.join(cwd, "README.md");
  await writeFile(markdownPath, "before\n");
  await processHookEvent(payload(cwd, "UserPromptSubmit"), { stateDir, historyRoot });
  const statePath = hookStatePath(payload(cwd, "Stop"), { stateDir });
  const baseline = await readFile(statePath, "utf8");
  await writeFile(markdownPath, "after\n");

  await assert.rejects(processHookEvent(payload(cwd, "Stop"), {
    stateDir,
    historyRoot,
    now: Date.parse("2026-08-15T10:00:00.000Z"),
    beforeStateAdvance: async () => { throw new Error("interrupted"); },
  }), /interrupted/);
  assert.equal(await readFile(statePath, "utf8"), baseline);
  assert.equal((await readWorkspaceHistoryForRoot(cwd, { root: historyRoot })).revisions.length, 1);

  const retried = await processHookEvent(payload(cwd, "Stop"), {
    stateDir,
    historyRoot,
    now: Date.parse("2026-08-15T11:00:00.000Z"),
  });
  assert.deepEqual(retried.changedFiles, [markdownPath]);
  const workspace = await readWorkspaceHistoryForRoot(cwd, { root: historyRoot });
  assert.equal(workspace.revisions.length, 1);
  assert.deepEqual(workspace.revisions[0].changes.map(({ path: file, kind }) => [file, kind]), [["README.md", "modified"]]);
});

test("concurrent Stops serialize state advancement and store one turn revision", async (t) => {
  const { cwd, stateDir, historyRoot } = await fixture(t);
  const markdownPath = path.join(cwd, "README.md");
  await writeFile(markdownPath, "before\n");
  await processHookEvent(payload(cwd, "UserPromptSubmit"), { stateDir, historyRoot });
  await writeFile(markdownPath, "after\n");

  const results = await Promise.all([
    processHookEvent(payload(cwd, "Stop"), { stateDir, historyRoot }),
    processHookEvent(payload(cwd, "Stop"), { stateDir, historyRoot }),
  ]);
  assert.deepEqual(results.map((result) => result.changedFiles.length).sort(), [0, 1]);
  assert.equal((await readWorkspaceHistoryForRoot(cwd, { root: historyRoot })).revisions.length, 1);
});

test("nullable payload fields and Japanese paths do not affect snapshotting", async (t) => {
  const { directory, stateDir, historyRoot } = await fixture(t);
  const cwd = path.join(directory, "日本 語 workspace");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "設計 メモ.md"), "# 境界\n");
  const event = payload(cwd, "UserPromptSubmit", {
    transcript_path: null,
    model: "gpt-5",
  });
  const result = await processHookEvent(event, { stateDir, historyRoot });
  assert.equal(result.action, "baseline-created");
  assert.equal(Object.keys(JSON.parse(await readFile(result.statePath, "utf8")).files)[0], "設計 メモ.md");
});

test("subagent UserPromptSubmit events are ignored before state is created", async (t) => {
  const { cwd, stateDir, historyRoot } = await fixture(t);
  await writeFile(path.join(cwd, "README.md"), "hello\n");
  const event = payload(cwd, "UserPromptSubmit", { agent_id: "agent-2" });
  const result = await processHookEvent(event, { stateDir, historyRoot });
  assert.deepEqual(result, {
    action: "ignored",
    reason: "subagent",
    changedFiles: [],
    deletedFiles: [],
  });
  await assert.rejects(access(hookStatePath(event, { stateDir })));
});

test("scanner ignores dependency and build directories outside git", async (t) => {
  const { cwd } = await fixture(t);
  await writeFile(path.join(cwd, "visible.MD"), "yes\n");
  for (const name of ["node_modules", "dist", ".git"]) {
    await mkdir(path.join(cwd, name));
    await writeFile(path.join(cwd, name, "hidden.md"), "no\n");
  }
  const snapshot = await scanMarkdownFiles(cwd);
  assert.deepEqual(Object.keys(snapshot.files), ["visible.MD"]);
});

test("TTL cleanup removes only stale JSON states", async (t) => {
  const { stateDir } = await fixture(t);
  await mkdir(stateDir);
  const now = Date.parse("2026-08-13T10:00:00Z");
  const stale = path.join(stateDir, "stale.json");
  const fresh = path.join(stateDir, "fresh.json");
  const unrelated = path.join(stateDir, "keep.txt");
  await writeFile(stale, JSON.stringify({ updatedAt: "2026-08-01T00:00:00Z" }));
  await writeFile(fresh, JSON.stringify({ updatedAt: "2026-08-13T09:59:00Z" }));
  await writeFile(unrelated, "keep\n");

  assert.deepEqual(await cleanupHookStates({ stateDir, now, ttlMs: 60 * 60 * 1000 }), [stale]);
  await assert.rejects(access(stale));
  await access(fresh);
  await access(unrelated);
});

test("stdin runner accepts JSON without a trailing newline and writes nothing to stdout", async (t) => {
  const { directory, cwd, stateDir, historyRoot } = await fixture(t);
  await writeFile(path.join(cwd, "README.md"), "hello\n");
  const moduleUrl = new URL("../src/hook-event.mjs", import.meta.url).href;
  const logPath = path.join(directory, "hook.log");
  const code = [
    `import { runHookFromStdin } from ${JSON.stringify(moduleUrl)};`,
    "await runHookFromStdin({ stateDir: process.env.MDVIEW_TEST_STATE, historyRoot: process.env.MDVIEW_TEST_HISTORY, logPath: process.env.MDVIEW_TEST_LOG });",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
    env: { ...process.env, MDVIEW_TEST_STATE: stateDir, MDVIEW_TEST_HISTORY: historyRoot, MDVIEW_TEST_LOG: logPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(payload(cwd, "UserPromptSubmit")));
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  assert.equal(exitCode, 0);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  assert.equal(JSON.parse(await readFile(hookStatePath(payload(cwd, "Stop"), { stateDir }), "utf8")).version, 1);
});
