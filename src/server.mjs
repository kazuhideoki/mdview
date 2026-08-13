import { createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { readCatalog } from "./catalog.mjs";
import { readDocumentHistory, restoreHistoryRenderedHtml } from "./history.mjs";
import { cacheRoot, logPath, runtimeRoot, serverPort } from "./paths.mjs";

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

export async function startServer(options = {}) {
  const root = cacheRoot();
  const port = options.port ?? serverPort();
  await mkdir(root, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) return respond(response, 405, "Method Not Allowed");
      const pathname = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`).pathname;
      if (pathname === "/__mdview_health") return respond(response, 200, "mdview/1\n", { "content-type": "text/plain; charset=utf-8" });
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
  if (await isMdviewServer(port)) return { port, started: false };
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
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__mdview_health`, { signal: AbortSignal.timeout(300) });
    return response.ok && (await response.text()) === "mdview/1\n";
  } catch {
    return false;
  }
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
