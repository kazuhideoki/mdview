#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readCatalog } from "./catalog.mjs";
import { appendHookLog, runHookFromStdin } from "./hook-event.mjs";
import { installHooks, hooksStatus, uninstallHooks } from "./hook-manager.mjs";
import { renderMarkdownFile, renderMarkdownFiles } from "./renderer.mjs";
import { ensureServer, startServer } from "./server.mjs";
import { SAMPLE_META } from "./sample-document.mjs";
import { logPath, runtimeRoot, serverPort } from "./paths.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--hook") return runAsHook();
  if (argv[0] === "--hook-worker") return runHookWorker(argv[1]);

  const [command, ...args] = argv;
  switch (command) {
    case "open":
      return openCommand(args);
    case "list":
      return listCommand(args);
    case "render":
      return renderCommand(args);
    case "demo":
      return demoCommand();
    case "serve":
      return serveCommand(args);
    case "hook":
      return hookCommand(args);
    case "-h":
    case "--help":
      printHelp();
      return 0;
    case undefined:
      return defaultCommand();
    default:
      if (/^.+[.](?:md|markdown)$/i.test(command)) return openCommand([command, ...args]);
      throw new Error(`Unknown command: ${command}`);
  }
}

async function renderCommand(args) {
  if (args.length !== 1) throw new Error("Usage: mdview render <file.md>");
  const result = await renderMarkdownFile(args[0], {
    catalogContext: { source: "manual" },
  });
  process.stdout.write(`${result.outputPath}\n${result.url}\n`);
  return 0;
}

async function openCommand(args) {
  if (args.length !== 1) throw new Error("Usage: mdview open <file.md|number>");
  if (/^[1-9][0-9]*$/.test(args[0])) return openCatalogNumber(Number(args[0]));
  const result = await renderMarkdownFile(args[0], {
    catalogContext: { source: "manual" },
  });
  await ensureServerForBrowser();
  await openUrl(result.url);
  process.stdout.write(`${result.url}\n`);
  return 0;
}

async function defaultCommand() {
  return openCatalogNumber(1);
}

async function listCommand(args) {
  if (args.length !== 0) throw new Error("Usage: mdview list");
  const entries = await catalogEntries();
  if (entries.length === 0) throw emptyCatalogError();
  for (const [index, entry] of entries.entries()) {
    const location = entry.repo
      ? `${entry.repo}${entry.branch ? `@${entry.branch}` : ""} · ${entry.relativePath || entry.sourcePath}`
      : entry.sourcePath;
    process.stdout.write(`${index + 1}. ${entry.title || path.basename(entry.sourcePath)}\n   ${location}\n`);
  }
  return 0;
}

async function openCatalogNumber(number) {
  const entries = await catalogEntries();
  if (entries.length === 0) throw emptyCatalogError();
  const entry = entries[number - 1];
  if (!entry) {
    throw new Error(`Catalog entry ${number} does not exist. Run \`mdview list\` to see entries 1-${entries.length}.`);
  }
  await ensureServerForBrowser();
  await openUrl(entry.href);
  process.stdout.write(`${entry.href}\n`);
  return 0;
}

async function catalogEntries() {
  const catalog = await readCatalog();
  const entries = Array.isArray(catalog) ? catalog : catalog?.entries;
  if (!Array.isArray(entries)) throw new Error("Invalid mdview catalog.");
  const origin = `http://127.0.0.1:${serverPort()}`;
  return entries.map((entry) => ({ ...entry, href: new URL(entry.href, origin).href }));
}

function emptyCatalogError() {
  return new Error("No rendered Markdown documents yet. Run `mdview open <file.md>` first.");
}

async function demoCommand() {
  const source = path.join(PROJECT_ROOT, "examples", "editorial-focus.md");
  const result = await renderMarkdownFile(source, {
    changedLines: SAMPLE_META.changedLines,
    meta: SAMPLE_META,
    rawDiff: `@@ -4,3 +4,6 @@\n+## 境界の定義\n+\n+実行プロセスの境界を明確化しました。`,
    catalogContext: { source: "manual" },
  });
  await ensureServerForBrowser();
  await openUrl(result.url);
  process.stdout.write(`${result.url}\n`);
  return 0;
}

async function serveCommand() {
  const server = await startServer();
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await new Promise(() => {});
}

async function ensureServerForBrowser() {
  if (process.env.MDVIEW_BROWSER === "none") return { started: false };
  return ensureServer();
}

async function hookCommand(args) {
  const action = args[0];
  if (!action || args.length !== 1 || !["install", "uninstall", "status"].includes(action)) {
    throw new Error("Usage: mdview hook <install|uninstall|status>");
  }
  if (action === "install") {
    const result = await installHooks();
    process.stdout.write(`${result.changed ? "Installed" : "Already installed"} mdview hooks in ${result.hooksPath}.\nTrust both entries from /hooks before using them.\n`);
    return 0;
  }
  if (action === "uninstall") {
    const result = await uninstallHooks();
    process.stdout.write(`${result.changed ? "Removed" : "No installed"} mdview hooks in ${result.hooksPath}.\n`);
    return 0;
  }
  const result = await hooksStatus();
  process.stdout.write(`mdview hooks are ${result.installed ? "installed" : "not fully installed"} in ${result.hooksPath}.\n`);
  return result.installed ? 0 : 1;
}

async function runAsHook() {
  await runHookFromStdin({
    onChangedFiles: async ({ changedFiles }, payload) => launchHookWorker(changedFiles, payload),
  });
  return 0;
}

async function launchHookWorker(changedFiles, payload) {
  const jobsDir = path.join(runtimeRoot(), "jobs");
  const log = logPath();
  await mkdir(jobsDir, { recursive: true });
  await mkdir(path.dirname(log), { recursive: true });
  const jobPath = path.join(jobsDir, `${randomUUID()}.json`);
  await writeFile(jobPath, `${JSON.stringify({
    version: 2,
    changedFiles,
    sessionId: payload?.session_id,
    turnId: payload?.turn_id,
    renderedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600, flag: "wx" });
  const handle = await open(log, "a", 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--hook-worker", jobPath], {
      detached: true,
      stdio: ["ignore", handle.fd, handle.fd],
      env: process.env,
    });
    child.unref();
  } catch (error) {
    await unlink(jobPath).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

async function runHookWorker(jobPath) {
  const jobsDir = path.resolve(runtimeRoot(), "jobs");
  const absoluteJobPath = path.resolve(jobPath || "");
  if (!absoluteJobPath.startsWith(`${jobsDir}${path.sep}`)) throw new Error("Invalid mdview hook worker job path.");
  const job = JSON.parse(await readFile(absoluteJobPath, "utf8"));
  if (
    job?.version !== 2 ||
    !Array.isArray(job.changedFiles) ||
    !job.changedFiles.every((file) => typeof file === "string") ||
    typeof job.sessionId !== "string" ||
    !job.sessionId ||
    typeof job.turnId !== "string" ||
    !job.turnId ||
    typeof job.renderedAt !== "string" ||
    !Number.isFinite(Date.parse(job.renderedAt))
  ) {
    throw new Error("Invalid mdview hook worker job.");
  }
  const rendered = await renderMarkdownFiles(job.changedFiles, {
    updatedLabel: "Updated by Codex · just now",
    catalogContext: {
      source: "hook",
      sessionId: job.sessionId,
      turnId: job.turnId,
      renderedAt: job.renderedAt,
    },
  });
  if (rendered.length) {
    await appendHookLog(`Rendered ${rendered.length} Markdown file(s); available from mdview`);
  }
  await unlink(absoluteJobPath);
  return 0;
}

export async function openUrl(url, options = {}) {
  if ((options.browser || process.env.MDVIEW_BROWSER) === "none") return;
  const runner = options.execFile || execFile;
  await new Promise((resolve, reject) => {
    runner("open", ["-b", options.browser || process.env.MDVIEW_BROWSER || "com.brave.Browser", url], (error) => error ? reject(error) : resolve());
  });
}

function printHelp() {
  process.stdout.write(`mdview — Codex-edited Markdown reader\n\nUsage:\n  mdview                     Open the latest rendered document\n  mdview list                List rendered documents, newest first\n  mdview open <number>       Open an entry shown by mdview list\n  mdview open <file.md>      Render and open a Markdown file\n  mdview <file.md>           Shortcut for mdview open <file.md>\n  mdview render <file.md>    Render without opening a browser\n  mdview demo\n  mdview serve\n  mdview hook <install|status|uninstall>\n\nReader shortcuts:\n  Cmd+K or /                 Search all documents shown by mdview list\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    if (Number.isInteger(code)) process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`mdview: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { main };
