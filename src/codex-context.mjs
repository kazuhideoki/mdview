import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function worktreeLabel(repoRoot) {
  if (typeof repoRoot !== "string" || !repoRoot) return null;
  const segments = path.resolve(repoRoot).split(path.sep).filter(Boolean);
  const managedRoots = [
    [".codex", "worktrees"],
    [".worktree-deck", "worktrees"],
  ];
  for (const managedRoot of managedRoots) {
    for (let index = 0; index <= segments.length - managedRoot.length; index += 1) {
      if (!managedRoot.every((segment, offset) => segments[index + offset] === segment)) continue;
      const relative = segments.slice(index + managedRoot.length);
      if (relative.length > 0) return relative.join("/");
    }
  }
  return path.basename(path.resolve(repoRoot));
}

export function branchDisplay(branch, head) {
  if (typeof branch === "string" && branch && branch !== "detached") return branch;
  return typeof head === "string" && head ? `detached@${head}` : "detached";
}

export async function resolveGitRepositoryContext(repoRoot, options = {}) {
  if (typeof repoRoot !== "string" || !repoRoot) return null;
  const root = path.resolve(repoRoot);
  const run = options.execFile || execFileAsync;
  try {
    const [{ stdout: commonDirOutput }, { stdout: commitOutput }, { stdout: parentsOutput }] = await Promise.all([
      run("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }),
      run("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
      run("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: root, encoding: "utf8" }),
    ]);
    const unresolvedCommonDir = commonDirOutput.trim();
    const commonDir = await realpath(path.resolve(root, unresolvedCommonDir));
    const commit = commitOutput.trim();
    const commitLine = parentsOutput.trim().split(/\s+/).filter(Boolean);
    if (!/^[a-f0-9]{40}$/i.test(commit) || commitLine[0] !== commit) return null;
    return {
      repositoryId: createHash("sha256").update(commonDir).digest("hex").slice(0, 24),
      commonDir,
      commit,
      parents: commitLine.slice(1).filter((value) => /^[a-f0-9]{40}$/i.test(value)),
    };
  } catch {
    return null;
  }
}

export async function resolveCodexSessionTitle(sessionId, options = {}) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const indexedTitle = await resolveSessionIndexTitle(sessionId, options);
  if (indexedTitle) return indexedTitle;
  const databasePath = path.resolve(options.databasePath || path.join(defaultCodexRoot(), "state_5.sqlite"));
  const run = options.execFile || execFileAsync;
  const escapedId = escapeSqlString(sessionId);
  const queries = [
    `SELECT COALESCE(NULLIF(name, ''), title) AS title FROM threads WHERE id = '${escapedId}' LIMIT 1`,
    `SELECT title FROM threads WHERE id = '${escapedId}' LIMIT 1`,
    `SELECT name AS title FROM threads WHERE id = '${escapedId}' LIMIT 1`,
  ];
  for (const query of queries) {
    try {
      const { stdout } = await run("sqlite3", ["-readonly", "-json", databasePath, query], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 64 * 1024,
      });
      const rows = JSON.parse(stdout || "[]");
      const title = rows?.[0]?.title;
      if (typeof title === "string" && title.trim()) return title.trim();
    } catch {
      // Try the next compatible schema shape.
    }
  }
  return null;
}

async function resolveSessionIndexTitle(sessionId, options) {
  const indexPath = path.resolve(options.sessionIndexPath || path.join(defaultCodexRoot(), "session_index.jsonl"));
  const read = options.readFile || readFile;
  let contents;
  try {
    contents = await read(indexPath, "utf8");
  } catch {
    return null;
  }
  let latest = null;
  for (const [lineIndex, line] of contents.split("\n").entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.id !== sessionId || typeof record.thread_name !== "string" || !record.thread_name.trim()) continue;
    const updatedAt = Date.parse(record.updated_at);
    const candidate = {
      title: record.thread_name.trim(),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Number.NEGATIVE_INFINITY,
      lineIndex,
    };
    if (!latest || candidate.updatedAt > latest.updatedAt || (
      candidate.updatedAt === latest.updatedAt && candidate.lineIndex > latest.lineIndex
    )) latest = candidate;
  }
  return latest?.title || null;
}

function defaultCodexRoot() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''");
}
