import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveGitRepositoryContext, worktreeLabel } from "./codex-context.mjs";
import { discoverMergeSources } from "./repository-lineage.mjs";
import { reconcilePrimaryWorkspace } from "./repository-sync.mjs";
import { storeHistorySnapshot } from "./history.mjs";
import {
  readWorkspaceHistoryForRoot,
  registerWorkspaceRevision,
  workspaceFilesEqual,
} from "./workspace-history.mjs";

const execFileAsync = promisify(execFile);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".venv",
  "build",
  "dist",
  "node_modules",
  "vendor",
]);

export const HOOK_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function defaultStateDir() {
  return (
    process.env.MDVIEW_STATE_DIR ||
    path.join(os.homedir(), "Library", "Application Support", "mdview", "hooks")
  );
}

function defaultLogPath() {
  return (
    process.env.MDVIEW_HOOK_LOG ||
    path.join(os.homedir(), "Library", "Logs", "mdview", "hook.log")
  );
}

function isMarkdownFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

function portableRelative(filePath) {
  return filePath.split(path.sep).join("/");
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function gitRoot(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitValue(root, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function workspaceMeta(root) {
  const [branch, gitContext] = await Promise.all([
    gitValue(root, ["branch", "--show-current"]),
    resolveGitRepositoryContext(root),
  ]);
  return {
    repo: path.basename(root),
    worktree: worktreeLabel(root) || path.basename(root),
    branch: branch || "detached",
    head: gitContext?.commit?.slice(0, 7) || null,
    repositoryId: gitContext?.repositoryId || null,
    commit: gitContext?.commit || null,
    parents: gitContext?.parents || [],
  };
}

async function gitMarkdownPaths(root) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout
      .split("\0")
      .filter(Boolean)
      .filter(isMarkdownFile)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return null;
  }
}

async function walkMarkdownPaths(root) {
  const paths = [];
  async function walk(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await walk(path.join(directory, entry.name), relativePath);
        }
      } else if (entry.isFile() && isMarkdownFile(entry.name)) {
        paths.push(portableRelative(relativePath));
      }
    }
  }
  await walk(root);
  return paths;
}

export async function scanMarkdownFiles(cwd) {
  const absoluteCwd = path.resolve(cwd);
  const root = (await gitRoot(absoluteCwd)) || absoluteCwd;
  const candidates = (await gitMarkdownPaths(root)) || (await walkMarkdownPaths(root));
  const files = {};
  for (const relativePath of candidates) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    if (!(await fileExists(absolutePath))) continue;
    try {
      files[relativePath] = await hashFile(absolutePath);
    } catch (error) {
      // A file can disappear while Codex is ending the turn. Treat it as deleted.
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { root, files };
}

export function hookStateKey(payload) {
  const sessionId = payload?.session_id;
  const turnId = payload?.turn_id;
  if (typeof sessionId !== "string" || !sessionId || typeof turnId !== "string" || !turnId) {
    throw new TypeError("Codex hook payload requires session_id and turn_id.");
  }
  return createHash("sha256").update(sessionId).update(turnId).digest("hex");
}

export function hookStatePath(payload, options = {}) {
  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  return path.join(stateDir, `${hookStateKey(payload)}.json`);
}

async function atomicWriteJson(filePath, value, { createOnly = false } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (createOnly) {
    try {
      await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  }

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}`,
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
  return true;
}

async function readState(filePath) {
  try {
    const source = await readFile(filePath, "utf8");
    const state = JSON.parse(source);
    if (!state || typeof state !== "object" || !state.files || typeof state.files !== "object") {
      return null;
    }
    return state;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function stateRecord(snapshot, now, previous = null) {
  return {
    version: 1,
    createdAt: previous?.createdAt || new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    root: snapshot.root,
    files: snapshot.files,
  };
}

function compareSnapshots(previousFiles, currentFiles) {
  const changed = [];
  const deleted = [];
  for (const [relativePath, digest] of Object.entries(currentFiles)) {
    if (previousFiles[relativePath] !== digest) changed.push(relativePath);
  }
  for (const relativePath of Object.keys(previousFiles)) {
    if (!(relativePath in currentFiles)) deleted.push(relativePath);
  }
  changed.sort((left, right) => left.localeCompare(right));
  deleted.sort((left, right) => left.localeCompare(right));
  return { changed, deleted };
}

export async function cleanupHookStates(options = {}) {
  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? HOOK_STATE_TTL_MS;
  let entries;
  try {
    entries = await readdir(stateDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(stateDir, entry.name);
    let updatedAt;
    try {
      const state = JSON.parse(await readFile(filePath, "utf8"));
      updatedAt = Date.parse(state.updatedAt || state.createdAt || "");
    } catch {
      updatedAt = Number.NaN;
    }
    if (!Number.isFinite(updatedAt)) {
      try {
        updatedAt = (await lstat(filePath)).mtimeMs;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
    if (now - updatedAt <= ttlMs) continue;
    try {
      await unlink(filePath);
      removed.push(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

export async function processHookEvent(payload, options = {}) {
  const eventName = payload?.hook_event_name;
  if (eventName !== "UserPromptSubmit" && eventName !== "Stop") {
    return { action: "ignored", reason: "unsupported-event", changedFiles: [], deletedFiles: [] };
  }
  if (eventName === "UserPromptSubmit" && payload.agent_id != null) {
    return { action: "ignored", reason: "subagent", changedFiles: [], deletedFiles: [] };
  }
  hookStateKey(payload);
  if (typeof payload.cwd !== "string" || !payload.cwd) {
    throw new TypeError("Codex hook payload requires cwd.");
  }

  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  const now = options.now ?? Date.now();
  await cleanupHookStates({ stateDir, now, ttlMs: options.ttlMs });
  const filePath = hookStatePath(payload, { stateDir });
  const historyOptions = options.historyRoot ? { root: options.historyRoot } : {};
  return withHookStateLock(filePath, async () => {
    const snapshot = await scanMarkdownFiles(payload.cwd);

    if (eventName === "UserPromptSubmit") {
      const existing = await readState(filePath);
      if (!existing) await persistSnapshotFiles(snapshot, Object.keys(snapshot.files), historyOptions);
      const created = await atomicWriteJson(filePath, stateRecord(snapshot, now), { createOnly: true });
      return {
        action: created ? "baseline-created" : "baseline-preserved",
        root: snapshot.root,
        statePath: filePath,
        changedFiles: [],
        deletedFiles: [],
      };
    }

    const previous = await readState(filePath);
    const differences = previous
      ? compareSnapshots(previous.files, snapshot.files)
      : { changed: [], deleted: [] };
    await persistSnapshotFiles(snapshot, previous ? differences.changed : Object.keys(snapshot.files), historyOptions);

    const changedFiles = differences.changed.map((relativePath) => path.join(snapshot.root, relativePath));
    const deletedFiles = differences.deleted.map((relativePath) =>
      path.join(previous?.root || snapshot.root, relativePath),
    );
    const renderedAt = new Date(now).toISOString();
    const turnChanges = [
      ...differences.changed.map((relativePath) => ({
        path: portableRelative(relativePath),
        beforeContentHash: previous?.files?.[relativePath] ?? null,
        contentHash: snapshot.files[relativePath],
      })),
      ...differences.deleted.map((relativePath) => ({
        path: portableRelative(relativePath),
        beforeContentHash: previous?.files?.[relativePath] ?? null,
        contentHash: null,
      })),
    ];
    const existingWorkspace = await readWorkspaceHistoryForRoot(snapshot.root, historyOptions);
    const existingRevision = existingWorkspace?.revisions.at(-1);
    const meta = await workspaceMeta(snapshot.root);
    const filesEqual = existingRevision && workspaceFilesEqual(existingRevision.files, snapshot.files);
    const gitChanged = existingRevision && gitRevisionChanged(existingRevision.meta, meta);
    let mergeSources = [];
    if (!filesEqual || gitChanged) {
      mergeSources = await discoverMergeSources({
        destination: existingWorkspace,
        destinationRoot: snapshot.root,
        currentFiles: snapshot.files,
        currentMeta: meta,
        renderedAt,
      }, historyOptions);
    }
    const workspaceRevision = filesEqual && mergeSources.length === 0
      ? { manifest: existingWorkspace, revision: existingRevision, added: false }
      : await registerWorkspaceRevision({
        root: snapshot.root,
        renderedAt,
        source: "hook",
        sessionId: payload.session_id,
        turnId: payload.turn_id,
        meta,
        files: snapshot.files,
        changes: existingRevision ? compareWorkspaceFiles(existingRevision.files, snapshot.files) : turnChanges,
        mergeSources,
      }, historyOptions);
    if (typeof options.beforeStateAdvance === "function") await options.beforeStateAdvance(workspaceRevision, payload);
    await atomicWriteJson(filePath, stateRecord(snapshot, now, previous));
    const result = {
      action: previous ? "compared" : "baseline-created",
      root: snapshot.root,
      statePath: filePath,
      renderedAt: workspaceRevision.revision.renderedAt,
      workspaceId: workspaceRevision.manifest.workspaceId,
      workspaceRevisionId: workspaceRevision.revision.id,
      changedFiles,
      deletedFiles,
      changes: differences.changed.map((relativePath) => ({
        filePath: path.join(snapshot.root, relativePath),
        beforeContentHash: previous?.files?.[relativePath] ?? null,
        contentHash: snapshot.files[relativePath],
      })),
    };
    const syncPrimary = options.reconcilePrimaryWorkspace || reconcilePrimaryWorkspace;
    try {
      result.repositorySync = await syncPrimary(snapshot.root, { ...options, historyRoot: options.historyRoot });
    } catch (error) {
      result.repositorySync = { action: "failed", added: false, revision: null };
      await appendHookLog(`Repository workspace sync failed: ${error?.stack || String(error)}`, options).catch(() => {});
    }
    if (changedFiles.length > 0 && typeof options.onChangedFiles === "function") {
      await options.onChangedFiles(result, payload);
    }
    return result;
  });
}

function compareWorkspaceFiles(previousFiles, currentFiles) {
  const paths = new Set([...Object.keys(previousFiles), ...Object.keys(currentFiles)]);
  return [...paths]
    .filter((relativePath) => previousFiles[relativePath] !== currentFiles[relativePath])
    .map((relativePath) => ({
      path: portableRelative(relativePath),
      beforeContentHash: previousFiles[relativePath] ?? null,
      contentHash: currentFiles[relativePath] ?? null,
    }));
}

function gitRevisionChanged(previousMeta, currentMeta) {
  const previousCommit = previousMeta?.commit || previousMeta?.head || null;
  const currentCommit = currentMeta?.commit || currentMeta?.head || null;
  return Boolean(previousCommit && currentCommit && previousCommit !== currentCommit);
}

async function withHookStateLock(filePath, operation) {
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 99) throw error;
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 5 * 60 * 1000) {
          await unlink(lockPath);
          continue;
        }
      } catch (staleError) {
        if (staleError?.code !== "ENOENT") throw staleError;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await operation();
  } finally {
    await handle?.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function persistSnapshotFiles(snapshot, relativePaths, historyOptions) {
  for (const relativePath of relativePaths) {
    const contentHash = snapshot.files[relativePath];
    if (!contentHash) continue;
    const markdown = await readFile(path.join(snapshot.root, relativePath), "utf8");
    await storeHistorySnapshot(markdown, { ...historyOptions, contentHash });
  }
}

// CLI-facing name. The function deliberately performs no stdout writes.
export const handleHookPayload = processHookEvent;

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function appendHookLog(message, options = {}) {
  const logPath = path.resolve(options.logPath || defaultLogPath());
  await mkdir(path.dirname(logPath), { recursive: true });
  const line = `[${new Date(options.now ?? Date.now()).toISOString()}] ${message}\n`;
  await appendFile(logPath, line, { encoding: "utf8", mode: 0o600 });
}

export async function runHookFromStdin(options = {}) {
  try {
    const source = await readAll(options.stdin || process.stdin);
    const payload = JSON.parse(source);
    return await processHookEvent(payload, options);
  } catch (error) {
    try {
      await appendHookLog(error?.stack || String(error), options);
    } catch {
      // Hook failures must never produce stdout or block the Codex turn.
    }
    return { action: "error", error };
  }
}
