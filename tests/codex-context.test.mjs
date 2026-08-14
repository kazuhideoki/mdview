import assert from "node:assert/strict";
import test from "node:test";
import {
  branchDisplay,
  resolveCodexSessionTitle,
  worktreeLabel,
} from "../src/codex-context.mjs";

test("worktree labels preserve managed-root identity without exposing the full path", () => {
  assert.equal(worktreeLabel("/Users/example/.codex/worktrees/3a2c/mdview"), "3a2c/mdview");
  assert.equal(worktreeLabel("/Users/example/.worktree-deck/worktrees/mdview/feature/header"), "mdview/feature/header");
  assert.equal(worktreeLabel("/Users/example/src/mdview"), "mdview");
  assert.equal(worktreeLabel(null), null);
});

test("branch display includes the commit only for a detached worktree", () => {
  assert.equal(branchDisplay("feature/header", "123abcd"), "feature/header");
  assert.equal(branchDisplay("detached", "123abcd"), "detached@123abcd");
  assert.equal(branchDisplay("", ""), "detached");
});

test("Codex title lookup prefers the latest exact session-index title", async () => {
  let databaseCalled = false;
  const title = await resolveCodexSessionTitle("session-a", {
    sessionIndexPath: "/tmp/session-index.jsonl",
    readFile: async (filePath, encoding) => {
      assert.equal(filePath, "/tmp/session-index.jsonl");
      assert.equal(encoding, "utf8");
      return [
        '{"id":"session-a","thread_name":"Older title","updated_at":"2026-08-13T10:00:00Z"}',
        "not json",
        '{"id":"session-b","thread_name":"Other session","updated_at":"2026-08-13T12:00:00Z"}',
        '{"id":"session-a","thread_name":"Latest title","updated_at":"2026-08-13T11:00:00Z"}',
        "",
      ].join("\n");
    },
    execFile: async () => {
      databaseCalled = true;
      return { stdout: '[{"title":"Database fallback"}]' };
    },
  });
  assert.equal(title, "Latest title");
  assert.equal(databaseCalled, false);
});

test("Codex title lookup falls back to the database with an exact escaped session id", async () => {
  let invocation;
  const title = await resolveCodexSessionTitle("session-'quoted", {
    readFile: async () => { throw new Error("index unavailable"); },
    databasePath: "/tmp/codex-state.sqlite",
    execFile: async (...args) => {
      invocation = args;
      return { stdout: '[{"title":"Renamed session"}]' };
    },
  });
  assert.equal(title, "Renamed session");
  assert.deepEqual(invocation.slice(0, 2), [
    "sqlite3",
    [
      "-readonly",
      "-json",
      "/tmp/codex-state.sqlite",
      "SELECT COALESCE(NULLIF(name, ''), title) AS title FROM threads WHERE id = 'session-''quoted' LIMIT 1",
    ],
  ]);
});

test("Codex title lookup is optional when local state is unavailable", async () => {
  assert.equal(await resolveCodexSessionTitle(null), null);
  assert.equal(await resolveCodexSessionTitle("missing", {
    readFile: async () => { throw new Error("index unavailable"); },
    execFile: async () => { throw new Error("sqlite unavailable"); },
  }), null);
});

test("Codex database lookup tolerates a missing name column", async () => {
  const queries = [];
  const title = await resolveCodexSessionTitle("legacy-session", {
    readFile: async () => { throw new Error("index unavailable"); },
    databasePath: "/tmp/legacy-state.sqlite",
    execFile: async (_command, args) => {
      queries.push(args.at(-1));
      if (queries.length === 1) throw new Error("no such column: name");
      return { stdout: '[{"title":"Legacy title"}]' };
    },
  });
  assert.equal(title, "Legacy title");
  assert.equal(queries.length, 2);
  assert.match(queries[1], /^SELECT title FROM threads/);
});
