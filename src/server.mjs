import { constants, createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { appBuildId } from "./app-build.mjs";
import { readCatalog } from "./catalog.mjs";
import { findHistoryRevisionByHref, readDocumentHistory, restoreHistoryCacheArtifacts, restoreHistoryRenderedHtml } from "./history.mjs";
import { documentMeta } from "./document.mjs";
import { cacheRoot, logPath, runtimeRoot, serverPort } from "./paths.mjs";
import { renderHistoryRevision, renderMarkdownFile, renderWorkspaceRevision } from "./renderer.mjs";
import { resolveCodexSessionTitle } from "./codex-context.mjs";
import {
  readWorkspaceHistories,
  readWorkspaceHistory,
  workspaceDocumentId,
  workspaceFileAtRevision,
} from "./workspace-history.mjs";

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
const PROTOCOL_VERSION = 8;
const followRenders = new Map();
const execFileAsync = promisify(execFile);

export async function startServer(options = {}) {
  const root = cacheRoot();
  const port = options.port ?? serverPort();
  await mkdir(root, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      if (typeof request.headers.host !== "string") return respond(response, 400, "Bad Request");
      const requestUrl = new URL(request.url, `http://${request.headers.host}`);
      if (!isLoopbackAuthority(request, requestUrl)) return respond(response, 421, "Misdirected Request");
      const pathname = requestUrl.pathname;
      if (pathname === "/__mdview/open") {
        if (request.method !== "POST") return respond(response, 405, "Method Not Allowed");
        if (!isTrustedMutationRequest(request, requestUrl)) return respond(response, 403, "Forbidden");
        return openMarkdownPath(request, response);
      }
      if (!["GET", "HEAD"].includes(request.method)) return respond(response, 405, "Method Not Allowed");
      if (pathname === "/__mdview_health") {
        return respond(response, 200, `mdview/${PROTOCOL_VERSION} ${(await appBuildId())}\n`, { "content-type": "text/plain; charset=utf-8" });
      }
      if (pathname === "/__mdview/catalog") {
        const entries = (await readCatalog()).map(projectCatalogEntry);
        const body = `${JSON.stringify(entries)}\n`;
        return respond(response, 200, request.method === "HEAD" ? "" : body, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
        });
      }
      if (pathname === "/__mdview/workspaces") {
        const histories = await readWorkspaceHistories();
        const body = `${JSON.stringify(histories.map(projectWorkspaceSummary))}\n`;
        return respond(response, 200, request.method === "HEAD" ? "" : body, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
        });
      }
      if (pathname.startsWith("/__mdview/workspaces/")) {
        const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
        const workspaceId = segments[2];
        if (!/^[a-f0-9]{24}$/.test(workspaceId || "")) return respond(response, 404, "Not Found");
        if (segments.length === 3) {
          return workspaceDetails(request, response, requestUrl, workspaceId, options);
        }
        if (
          segments.length === 7
          && segments[3] === "revisions"
          && segments[5] === "files"
          && /^[a-f0-9]{24}$/.test(segments[4])
          && /^[a-f0-9]{24}$/.test(segments[6])
        ) {
          let html;
          try {
            const rendered = await renderWorkspaceRevision(workspaceId, segments[4], segments[6], {
              resolveSessionTitle: options.resolveSessionTitle,
            });
            if (!rendered) return respond(response, 404, "Not Found");
            html = rendered.html;
          } catch (error) {
            try {
              html = await readFile(workspaceRenderedHtmlPath(root, workspaceId, segments[4], segments[6]), "utf8");
            } catch (fallbackError) {
              if (fallbackError?.code === "ENOENT" || fallbackError?.code === "ENOTDIR") {
                if (error?.code === "ENOENT" || error?.code === "HISTORY_SNAPSHOT_CORRUPT" || error?.code === "WORKSPACE_MANIFEST_CORRUPT") {
                  return respond(response, 409, "Workspace revision is unavailable");
                }
                throw error;
              }
              throw fallbackError;
            }
          }
          const requestedView = requestUrl.searchParams.get("view");
          const body = isReaderView(requestedView)
            ? applyInitialView(html, requestedView)
            : html;
          return respond(response, 200, request.method === "HEAD" ? "" : body, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(body),
            "x-content-type-options": "nosniff",
          });
        }
        return respond(response, 404, "Not Found");
      }
      if (pathname.startsWith("/__mdview/history/")) {
        const documentId = decodeURIComponent(pathname.slice("/__mdview/history/".length));
        if (!/^[a-f0-9]{24}$/.test(documentId)) return respond(response, 404, "Not Found");
        const requestedRevisionId = requestUrl.searchParams.get("revision");
        if (requestedRevisionId !== null && !/^[a-f0-9]{24}$/.test(requestedRevisionId)) {
          return respond(response, 400, "Bad Request");
        }
        const history = await readDocumentHistory(documentId);
        const requestedRevision = requestedRevisionId
          ? history.revisions.find((revision) => revision.id === requestedRevisionId)
          : null;
        const resolveSessionTitle = options.resolveSessionTitle || resolveCodexSessionTitle;
        const sessionTitle = requestedRevision?.sessionId
          ? await resolveSessionTitle(requestedRevision.sessionId)
          : null;
        await restoreHistoryCacheArtifacts({ cacheRoot: root });
        await Promise.all(history.revisions.map((revision) => restoreHistoryRenderedHtml(revision, {
          documentId,
          cacheRoot: root,
        })));
        const body = `${JSON.stringify({
          documentId,
          revisions: history.revisions.map((revision) => projectHistoryRevision(revision, {
            includeSessionTitle: requestedRevisionId !== null && revision.id === requestedRevisionId,
            sessionTitle,
          })),
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
      const requestedView = requestUrl.searchParams.get("view");
      if (route === "documents" && pathname.toLowerCase().endsWith(".html")) {
        const saved = await findHistoryRevisionByHref(pathname);
        if (saved) {
          let renderError = null;
          try {
            const rendered = await renderHistoryRevision(saved.manifest.documentId, saved.revision.id);
            if (rendered) {
              const body = isReaderView(requestedView)
                ? applyInitialView(rendered.html, requestedView)
                : rendered.html;
              return respond(response, 200, request.method === "HEAD" ? "" : body, {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "content-length": Buffer.byteLength(body),
                "x-content-type-options": "nosniff",
              });
            }
          } catch (error) {
            renderError = error;
            try {
              await restoreHistoryCacheArtifacts({ cacheRoot: root });
              await restoreHistoryRenderedHtml(saved.revision, {
                documentId: saved.manifest.documentId,
                cacheRoot: root,
              });
            } catch (restoreError) {
              if (restoreError?.code !== "ENOENT" && restoreError?.code !== "ENOTDIR") throw restoreError;
              throw renderError;
            }
          }
        }
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
      const extension = path.extname(canonical).toLowerCase();
      const headers = {
        "content-type": CONTENT_TYPES.get(extension) || "application/octet-stream",
        "cache-control": canonical.endsWith("mermaid.min.js")
          ? "public, max-age=86400"
          : "no-cache",
        "x-content-type-options": "nosniff",
      };
      if (route === "documents" && extension === ".html" && isReaderView(requestedView)) {
        const body = applyInitialView(await readFile(canonical, "utf8"), requestedView);
        response.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) });
        return response.end(request.method === "HEAD" ? "" : body);
      }
      response.writeHead(200, headers);
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

function isReaderView(view) {
  return view === "read" || view === "changes" || view === "raw";
}

function applyInitialView(html, view) {
  let foundApp = false;
  const transformed = html.replace(/<(?:div|button|section)\b[^>]*>/g, (tag) => {
    if (tag.startsWith("<div") && hasClass(tag, "mdv-app")) {
      foundApp = true;
      return setHtmlAttribute(tag, "data-view", view);
    }
    if (tag.startsWith("<button")) {
      const target = htmlAttribute(tag, "data-view-target");
      if (isReaderView(target)) return setHtmlAttribute(tag, "aria-pressed", String(target === view));
    }
    if (tag.startsWith("<section") && hasClass(tag, "mdv-raw-diff")) {
      return view === "raw" ? removeHtmlAttribute(tag, "hidden") : setHtmlAttribute(tag, "hidden", "");
    }
    return tag;
  });
  if (!foundApp) throw new Error("mdview document is missing its app root.");
  return transformed;
}

function hasClass(tag, className) {
  return htmlAttribute(tag, "class")?.split(/\s+/).includes(className) || false;
}

function htmlAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

function setHtmlAttribute(tag, name, value) {
  const encoded = value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const pattern = new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`, "i");
  if (pattern.test(tag)) return tag.replace(pattern, `$1"${encoded}"`);
  return tag.replace(/>$/, ` ${name}="${encoded}">`);
}

function removeHtmlAttribute(tag, name) {
  return tag.replace(new RegExp(`\\s${name}(?:\\s*=\\s*(?:["'][^"']*["']|[^\\s>]+))?`, "i"), "");
}

async function followMarkdownLink(requestUrl, response) {
  const sourceId = requestUrl.pathname.slice("/__mdview/follow/".length);
  if (!/^[a-f0-9]{24}$/.test(sourceId) || sourceId.includes("/")) {
    return respond(response, 404, "Not Found");
  }
  const target = requestUrl.searchParams.get("target");
  const fragment = requestUrl.searchParams.get("fragment") || "";
  const workspaceId = requestUrl.searchParams.get("workspace");
  const workspaceRevisionId = requestUrl.searchParams.get("revision");
  if (workspaceId !== null || workspaceRevisionId !== null) {
    if (!/^[a-f0-9]{24}$/.test(workspaceId || "") || !/^[a-f0-9]{24}$/.test(workspaceRevisionId || "") || !target) {
      return respond(response, 404, "Not Found");
    }
    const workspace = await readWorkspaceHistory(workspaceId);
    const destination = workspaceMarkdownDestination(workspace, workspaceRevisionId, sourceId, target);
    if (!destination) return respond(response, 404, "Not Found");
    const location = new URL(destination, "http://mdview.local");
    if (fragment) location.hash = fragment;
    response.writeHead(302, {
      location: `${location.pathname}${location.hash}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    return response.end();
  }
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

function workspaceMarkdownDestination(workspace, revisionId, sourceId, target) {
  const source = workspaceFileAtRevision(workspace, revisionId, sourceId);
  if (!source || source.change?.kind === "deleted") return null;
  let decoded;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (
    !decoded
    || decoded.includes("\0")
    || decoded.includes("\\")
    || path.posix.isAbsolute(decoded)
    || /^[a-z][a-z0-9+.-]*:/i.test(decoded)
    || !/[.](?:md|markdown)$/i.test(decoded)
    || /%(?:2f|5c)/i.test(target)
  ) return null;
  const relativePath = path.posix.normalize(path.posix.join(path.posix.dirname(source.relativePath), decoded));
  if (relativePath === ".." || relativePath.startsWith("../") || !(relativePath in source.revision.files)) return null;
  return workspaceDocumentHref(workspace.workspaceId, revisionId, workspaceDocumentId(workspace.root, relativePath));
}

function isTrustedFollowRequest(request, requestUrl) {
  const origin = request.headers.origin;
  if (origin && origin !== requestUrl.origin) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

function isLoopbackAuthority(request, requestUrl) {
  return requestUrl.hostname === "127.0.0.1"
    && requestUrl.port === String(request.socket.localPort);
}

function isTrustedMutationRequest(request, requestUrl) {
  return isTrustedFollowRequest(request, requestUrl)
    && request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function openMarkdownPath(request, response) {
  let input;
  try {
    input = await readJsonBody(request);
  } catch (error) {
    const status = error?.code === "BODY_TOO_LARGE" ? 413 : 400;
    return respondJson(response, status, { error: status === 413 ? "Request body is too large." : "Invalid JSON request." });
  }

  const requestedPath = typeof input?.path === "string" ? input.path.trim() : "";
  if (!requestedPath || requestedPath.includes("\0") || !/[.](?:md|markdown)$/i.test(requestedPath)) {
    return respondJson(response, 400, { error: "Enter an absolute .md or .markdown file path." });
  }
  const expandedPath = requestedPath.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), requestedPath.slice(2))
    : requestedPath;
  if (!path.isAbsolute(expandedPath)) {
    return respondJson(response, 400, { error: "Enter an absolute .md or .markdown file path." });
  }

  let canonical;
  try {
    canonical = await realpath(expandedPath);
    if (!(await stat(canonical)).isFile()) return respondJson(response, 404, { error: "Markdown file was not found." });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return respondJson(response, 404, { error: "Markdown file was not found." });
    }
    throw error;
  }
  if (!/[.](?:md|markdown)$/i.test(canonical)) {
    return respondJson(response, 400, { error: "Enter an absolute .md or .markdown file path." });
  }

  const rendered = await renderOpenedMarkdown(canonical, {
    updatedLabel: "Opened from command palette · just now",
    source: "manual",
  });
  return respondJson(response, 200, { href: rendered.catalogEntry.href });
}

async function readJsonBody(request, limit = 8 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body is too large.");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function coalescedLinkedRender(targetPath) {
  if (followRenders.has(targetPath)) return followRenders.get(targetPath);
  const operation = renderOpenedMarkdown(targetPath).finally(() => followRenders.delete(targetPath));
  followRenders.set(targetPath, operation);
  return operation;
}

async function renderOpenedMarkdown(targetPath, options = {}) {
  const handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const sourceStat = await handle.stat();
    if (!sourceStat.isFile()) throw new Error("Markdown link target is not a file.");
    const sourceContents = await handle.readFile("utf8");
    return renderMarkdownFile(targetPath, {
      sourceContents,
      sourceStat,
      updatedLabel: options.updatedLabel || "Opened from Markdown link · just now",
      catalogContext: { source: options.source || "link" },
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

function projectHistoryRevision(revision, options = {}) {
  const projected = {
    id: revision.id,
    href: revision.href,
    renderedAt: revision.renderedAt,
    source: revision.source,
    sessionId: revision.sessionId,
    turnId: revision.turnId,
  };
  if (options.includeSessionTitle) projected.sessionTitle = options.sessionTitle ?? null;
  return projected;
}

async function workspaceDetails(request, response, requestUrl, workspaceId, options) {
  const workspace = await readWorkspaceHistory(workspaceId);
  if (!workspace.root || workspace.revisions.length === 0) return respond(response, 404, "Not Found");
  const requestedRevisionId = requestUrl.searchParams.get("revision") || workspace.revisions.at(-1).id;
  const currentDocumentId = requestUrl.searchParams.get("document");
  if (!/^[a-f0-9]{24}$/.test(requestedRevisionId)) return respond(response, 400, "Bad Request");
  if (currentDocumentId !== null && !/^[a-f0-9]{24}$/.test(currentDocumentId)) return respond(response, 400, "Bad Request");
  const revision = workspace.revisions.find((candidate) => candidate.id === requestedRevisionId);
  if (!revision) return respond(response, 404, "Not Found");
  const resolveSessionTitle = options.resolveSessionTitle || resolveCodexSessionTitle;
  const sessionTitle = revision.sessionId ? await resolveSessionTitle(revision.sessionId) : null;
  const files = projectWorkspaceFiles(workspace, revision);
  const revisions = workspace.revisions.map((candidate) => ({
    id: candidate.id,
    renderedAt: candidate.renderedAt,
    source: candidate.source,
    sessionId: candidate.sessionId,
    turnId: candidate.turnId,
    href: workspaceRevisionHref(workspace, candidate, currentDocumentId),
    ...(candidate.id === revision.id ? { sessionTitle } : {}),
  }));
  const body = `${JSON.stringify({
    workspaceId,
    revisionId: revision.id,
    meta: revision.meta,
    files,
    revisions,
  })}\n`;
  return respond(response, 200, request.method === "HEAD" ? "" : body, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
}

function projectWorkspaceSummary(workspace) {
  const revision = workspace.revisions.at(-1);
  return {
    id: workspace.workspaceId,
    repo: revision.meta.repo,
    worktree: revision.meta.worktree,
    branch: revision.meta.branch,
    head: revision.meta.head,
    revisionId: revision.id,
    renderedAt: revision.renderedAt,
    href: workspaceRevisionHref(workspace, revision, null),
  };
}

function projectWorkspaceFiles(workspace, revision) {
  const paths = new Set(Object.keys(revision.files));
  for (const change of revision.changes) {
    if (change.kind === "deleted") paths.add(change.path);
  }
  return [...paths].sort((left, right) => left.localeCompare(right)).map((relativePath) => {
    const documentId = workspaceDocumentId(workspace.root, relativePath);
    const change = revision.changes.find((candidate) => candidate.path === relativePath) || null;
    return {
      documentId,
      title: path.basename(relativePath).replace(/\.(?:md|markdown)$/i, ""),
      relativePath,
      changeKind: change?.kind || null,
      href: workspaceDocumentHref(workspace.workspaceId, revision.id, documentId),
    };
  });
}

function workspaceRevisionHref(workspace, revision, preferredDocumentId) {
  const preferred = preferredDocumentId
    ? workspaceFileAtRevision(workspace, revision.id, preferredDocumentId)
    : null;
  if (preferred?.contentHash) {
    return workspaceDocumentHref(workspace.workspaceId, revision.id, preferredDocumentId);
  }
  const firstPath = Object.keys(revision.files).sort((left, right) => left.localeCompare(right))[0]
    || revision.changes.find((change) => change.kind === "deleted")?.path;
  if (!firstPath) return null;
  return workspaceDocumentHref(workspace.workspaceId, revision.id, workspaceDocumentId(workspace.root, firstPath));
}

function workspaceDocumentHref(workspaceId, revisionId, documentId) {
  return `/__mdview/workspaces/${workspaceId}/revisions/${revisionId}/files/${documentId}`;
}

function workspaceRenderedHtmlPath(root, workspaceId, revisionId, documentId) {
  return path.join(root, "documents", "workspaces", workspaceId, revisionId, documentId, "index.html");
}

export async function ensureServer(options = {}) {
  const port = options.port || serverPort();
  const [runningIdentity, expectedBuildId] = await Promise.all([mdviewServerIdentity(port), appBuildId()]);
  if (runningIdentity?.protocol === PROTOCOL_VERSION && runningIdentity.buildId === expectedBuildId) {
    return { port, started: false };
  }
  if (runningIdentity !== null) await stopLegacyMdviewServer(port, options);
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
  const [identity, expectedBuildId] = await Promise.all([mdviewServerIdentity(port), appBuildId()]);
  return identity?.protocol === PROTOCOL_VERSION && identity.buildId === expectedBuildId;
}

async function mdviewServerIdentity(port = serverPort()) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__mdview_health`, { signal: AbortSignal.timeout(300) });
    if (!response.ok) return null;
    return parseMdviewHealth(await response.text());
  } catch {
    return null;
  }
}

export function parseMdviewHealth(value) {
  if (typeof value !== "string") return null;
  const current = value.match(/^mdview\/(\d+) ([a-f0-9]{24})\n$/);
  if (current) return { protocol: Number(current[1]), buildId: current[2] };
  const legacy = value.match(/^mdview\/(\d+)\n$/);
  return legacy ? { protocol: Number(legacy[1]), buildId: null } : null;
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

function respondJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  respond(response, status, body, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
}
