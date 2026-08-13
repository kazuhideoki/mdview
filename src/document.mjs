import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";

const execFileAsync = promisify(execFile);
const parser = unified().use(remarkParse).use(remarkGfm);

async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return stdout.trim();
  } catch {
    return "";
  }
}

export function parseMarkdown(markdown) {
  return parser.parse(markdown);
}

export function collectHeadings(tree) {
  const headings = [];
  const nextSlug = createSlugger();
  visit(tree, "heading", (node) => {
    const text = collectInlineText(node);
    headings.push({
      depth: node.depth,
      id: nextSlug(text, headings.length),
      text,
      startLine: node.position?.start.line ?? 1,
      endLine: node.position?.end.line ?? node.position?.start.line ?? 1,
    });
  });
  return headings;
}

export function collectInlineText(node) {
  const values = [];
  visit(node, (child) => {
    if (["text", "inlineCode"].includes(child.type) && typeof child.value === "string") {
      values.push(child.value);
    }
  });
  return values.join("");
}

export function slugify(value, fallbackIndex = 0) {
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[\s/]+/g, "-")
    .replace(/[^\p{Letter}\p{Number}_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return slug || `section-${fallbackIndex + 1}`;
}

export function createSlugger() {
  const counts = new Map();
  return (value, fallbackIndex = 0) => {
    const base = slugify(value, fallbackIndex);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };
}

export async function changedLinesForFile(filePath, repoRoot) {
  if (!repoRoot) return [];
  const relativePath = path.relative(repoRoot, filePath);
  const tracked = await git(["ls-files", "--error-unmatch", "--", relativePath], repoRoot);
  if (!tracked) {
    const lineCount = (await import("node:fs/promises")).readFile(filePath, "utf8")
      .then((contents) => Math.max(contents.split("\n").length, 1))
      .catch(() => 0);
    return Array.from({ length: await lineCount }, (_, index) => index + 1);
  }
  let patch = await git(["diff", "HEAD", "--unified=0", "--", relativePath], repoRoot);
  if (!patch) {
    const staged = await git(["diff", "--cached", "--unified=0", "--", relativePath], repoRoot);
    const unstaged = await git(["diff", "--unified=0", "--", relativePath], repoRoot);
    patch = [staged, unstaged].filter(Boolean).join("\n");
  }
  const lines = new Set();
  for (const line of patch.split("\n")) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = Number(match[2] ?? "1");
    for (let current = start; current < start + Math.max(count, 1); current += 1) {
      lines.add(current);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

export async function rawDiffForFile(filePath, repoRoot) {
  if (!repoRoot) return "";
  const relativePath = path.relative(repoRoot, filePath);
  const tracked = await git(["ls-files", "--error-unmatch", "--", relativePath], repoRoot);
  if (!tracked) {
    try {
      const { readFile } = await import("node:fs/promises");
      const contents = await readFile(filePath, "utf8");
      return [`diff --git a/${relativePath} b/${relativePath}`, "new file", ...contents.split("\n").map((line) => `+${line}`)].join("\n");
    } catch {
      return "";
    }
  }
  const againstHead = await git(["diff", "HEAD", "--", relativePath], repoRoot);
  if (againstHead) return againstHead;
  const staged = await git(["diff", "--cached", "--", relativePath], repoRoot);
  const unstaged = await git(["diff", "--", relativePath], repoRoot);
  return [staged, unstaged].filter(Boolean).join("\n");
}

export async function documentMeta(filePath) {
  const absolutePath = path.resolve(filePath);
  const fileDir = path.dirname(absolutePath);
  const repoRoot = await git(["rev-parse", "--show-toplevel"], fileDir);
  const branch = repoRoot ? await git(["branch", "--show-current"], repoRoot) : "";
  const relativePath = repoRoot ? path.relative(repoRoot, absolutePath) : path.basename(absolutePath);
  const repo = repoRoot ? path.basename(repoRoot) : path.basename(fileDir);
  const changedLines = await changedLinesForFile(absolutePath, repoRoot);
  return {
    absolutePath,
    repoRoot,
    repo,
    branch: branch || "detached",
    relativePath,
    displayPath: `${repo} / ${branch || "detached"} / ${relativePath}`,
    changedLines,
    changeCount: changedLines.length,
  };
}

export function rangeHasChange(node, changedLineSet) {
  if (!node.position || changedLineSet.size === 0) return false;
  const start = node.position.start.line;
  const end = node.position.end.line;
  for (let line = start; line <= end; line += 1) {
    if (changedLineSet.has(line)) return true;
  }
  return false;
}
