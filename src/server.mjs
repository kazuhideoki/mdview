import { constants, createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readCatalog } from "./catalog.mjs";
import { readDocumentHistory, restoreHistoryCacheArtifacts, restoreHistoryRenderedHtml } from "./history.mjs";
import { documentMeta } from "./document.mjs";
import { cacheRoot, logPath, runtimeRoot, serverPort } from "./paths.mjs";
import { renderMarkdownFile } from "./renderer.mjs";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);
const PROTOCOL_VERSION = 2;
const followRenders = new Map();
const execFileAsync = promisify(execFile);

export async function startServer(options = {}) {
  const root = cacheRoot();
  const port = options.port ?? serverPort();
  await mkdir(root, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) return respond(response, 405, "Method Not Allowed");
      const requestUrl = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      const pathname = requestUrl.pathname;
      if (pathname === "/__mdview_health") return respond(response, 200, `mdview/${PROTOCOL_VERSION}\n`, { "content-type": "text/plain; charset=utf-8" });
      if (pathname === "/__mdview/catalog") {
        const entries = (await readCatalog()).map(projectCatalogEntry);
        const body = `${JSON.stringify(entries)}\n`;
        return respond(response, 200, request.method === "HEAD" ? "" : body, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
        });
      }
      if (pathname.startsWith("/__mdview/history/")) {
        const documentId = decodeURIComponent(pathname.slice("/__mdview/history/".length));
        if (!/^[a-f0-9]{24}$/.test(documentId)) return respond(response, 404, "Not Found");
        const history = await readDocumentHistory(documentId);
        await restoreHistoryCacheArtifacts({ cacheRoot: root });
        await Promise.all(history.revisions.map((revision) => restoreHistoryRenderedHtml(revision, {
          documentId,
          cacheRoot: root,
        })));
        const body = `${JSON.stringify({
          documentId,
          revisions: history.revisions.map(projectHistoryRevision),
        })}\n`;
        return respond(response, 200, request.method === "HEAD" ? "" : body, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
        });
      }
      if (pathname.startsWith("/__mdview/follow/")) {
        if (request.method !== "GET") return respond(response, 405, "Method Not Allowed");
        if (!isTrustedFollowRequest(request, requestUrl)) return respond(response, 403, "Forbidden");
        return followMarkdownLink(requestUrl, response);
      }
      const route = pathname.startsWith("/documents/")
        ? "documents"
        : pathname.startsWith("/assets/")
          ? "assets"
          : null;
      if (!route) {
        return respond(response, 404, "Not Found");
      }
      const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const candidate = path.resolve(root, ...segments);
      const allowedRoot = path.join(root, route);
      if (!candidate.startsWith(`${allowedRoot}${path.sep}`)) return respond(response, 404, "Not Found");
      let canonical;
      try {
        canonical = await realpath(candidate);
      } catch {
        return respond(response, 404, "Not Found");
      }
      if (!canonical.startsWith(`${await realpath(allowedRoot)}${path.sep}`) || !(await stat(canonical)).isFile()) return respond(response, 404, "Not Found");
      response.writeHead(200, {
        "content-type": CONTENT_TYPES.get(path.extname(canonical).toLowerCase()) || "application/octet-stream",
        "cache-control": canonical.endsWith("mermaid.min.js")
          ? "public, max-age=86400"
          : "no-cache",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") return response.end();
      createReadStream(canonical).pipe(response);
    } catch (error) {
      respond(response, 500, "Internal Server Error");
      console.error(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function followMarkdownLink(requestUrl, response) {
  const sourceId = requestUrl.pathname.slice("/__mdview/follow/".length);
  if (!/^[a-f0-9]{24}$/.test(sourceId) || sourceId.includes("/")) {
    return respond(response, 404, "Not Found");
  }
  const target = requestUrl.searchParams.get("target");
  const fragment = requestUrl.searchParams.get("fragment") || "";
  const source = (await readCatalog()).find((entry) => entry.id === sourceId);
  if (!source || !target) return respond(response, 404, "Not Found");

  const targetPath = await resolveMarkdownTarget(source.sourcePath, target);
  if (!targetPath) return respond(response, 404, "Not Found");

  const rendered = await coalescedLinkedRender(targetPath);
  const destination = new URL(rendered.catalogEntry.href, "http://mdview.local");
  if (fragment) destination.hash = fragment;
  response.writeHead(302, {
    location: `${destination.pathname}${destination.hash}`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end();
}

function isTrustedFollowRequest(request, requestUrl) {
  const origin = request.headers.origin;
  if (origin && origin !== requestUrl.origin) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

async function coalescedLinkedRender(targetPath) {
  if (followRenders.has(targetPath)) return followRenders.get(targetPath);
  const operation = renderOpenedMarkdown(targetPath).finally(() => followRenders.delete(targetPath));
  followRenders.set(targetPath, operation);
  return operation;
}

async function renderOpenedMarkdown(targetPath) {
  const handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const sourceStat = await handle.stat();
    if (!sourceStat.isFile()) throw new Error("Markdown link target is not a file.");
    const sourceContents = await handle.readFile("utf8");
    return renderMarkdownFile(targetPath, {
      sourceContents,
      sourceStat,
      updatedLabel: "Opened from Markdown link · just now",
      catalogContext: { source: "link" },
    });
  } finally {
    await handle.close();
  }
}

async function resolveMarkdownTarget(sourcePath, target) {
  let decodedTarget;
  try {
    decodedTarget = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (
    !decodedTarget ||
    decodedTarget.includes("\0") ||
    path.isAbsolute(decodedTarget) ||
    decodedTarget.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(decodedTarget) ||
    !/[.](?:md|markdown)$/i.test(decodedTarget)
  ) return null;

  if (/%(?:2f|5c)/i.test(target)) return null;
  const meta = await documentMeta(sourcePath);
  const allowedRoot = await realpath(meta.repoRoot || path.dirname(sourcePath));
  let canonical;
  try {
    canonical = await realpath(path.resolve(path.dirname(sourcePath), decodedTarget));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  if (canonical !== allowedRoot && !canonical.startsWith(`${allowedRoot}${path.sep}`)) return null;
  return (await stat(canonical)).isFile() ? canonical : null;
}

function projectCatalogEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    repo: entry.repo,
    branch: entry.branch,
    relativePath: entry.relativePath,
    href: entry.href,
    renderedAt: entry.renderedAt,
    source: entry.source,
  };
}

function projectHistoryRevision(revision) {
  return {
    id: revision.id,
    href: revision.href,
    renderedAt: revision.renderedAt,
    source: revision.source,
    sessionId: revision.sessionId,
    turnId: revision.turnId,
  };
}

export async function ensureServer(options = {}) {
  const port = options.port || serverPort();
  const runningVersion = await mdviewServerVersion(port);
  if (runningVersion === PROTOCOL_VERSION) return { port, started: false };
  if (runningVersion !== null) await stopLegacyMdviewServer(port, options);
  if (await isPortInUse(port)) throw new Error(`Port ${port} is already used by another process. Set MDVIEW_PORT to another port.`);
  const runtime = runtimeRoot();
  const log = logPath();
  await mkdir(runtime, { recursive: true });
  await mkdir(path.dirname(log), { recursive: true });
  const handle = await open(log, "a", 0o600);
  const cliPath = new URL("./cli.mjs", import.meta.url);
  const child = spawn(process.execPath, [cliPath.pathname, "serve", "--daemon"], {
    detached: true,
    stdio: ["ignore", handle.fd, handle.fd],
    env: process.env,
  });
  child.unref();
  await handle.close();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await isMdviewServer(port)) return { port, started: true };
  }
  throw new Error(`mdview server did not start on 127.0.0.1:${port}`);
}

export async function isMdviewServer(port = serverPort()) {
  return (await mdviewServerVersion(port)) === PROTOCOL_VERSION;
}

async function mdviewServerVersion(port = serverPort()) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__mdview_health`, { signal: AbortSignal.timeout(300) });
    if (!response.ok) return null;
    const match = (await response.text()).match(/^mdview\/(\d+)\n$/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function stopLegacyMdviewServer(port, options = {}) {
  const findPids = options.findListenerPids || listenerPids;
  const readCommand = options.readProcessCommand || processCommand;
  const killProcess = options.killProcess || process.kill;
  const pids = await findPids(port);
  for (const pid of pids) {
    const command = await readCommand(pid);
    if (!isMdviewDaemonCommand(command)) continue;
    killProcess(pid, "SIGTERM");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!(await isPortInUse(port))) return;
    }
    throw new Error(`Timed out stopping the old mdview server on port ${port}.`);
  }
  throw new Error(`An old mdview server is using port ${port}, but its process could not be verified for a safe restart.`);
}

export function isMdviewDaemonCommand(command) {
  return typeof command === "string" && /(?:^|\s)\S*node(?:\s|$)/.test(command)
    && /(?:^|\s)\S*[/\\]mdview[/\\]src[/\\]cli[.]mjs\s+serve\s+--daemon(?:\s|$)/.test(command);
}

async function listenerPids(port) {
  const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
}

async function processCommand(pid) {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return stdout.trim();
}

async function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = http.request({ hostname: "127.0.0.1", port, method: "HEAD", path: "/", timeout: 300 });
    socket.on("response", () => resolve(true));
    socket.on("error", (error) => resolve(error.code !== "ECONNREFUSED"));
    socket.on("timeout", () => { socket.destroy(); resolve(true); });
    socket.end();
  });
}

function respond(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...headers });
  response.end(body);
}
