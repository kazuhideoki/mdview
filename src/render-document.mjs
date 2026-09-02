import { escape } from "html-escaper";
import katex from "katex";
import { codeToHtml } from "shiki";
import { collectHeadings, collectInlineText, createSlugger, rangeHasChange } from "./document.mjs";
import { sanitizeRawHtml } from "./raw-html.mjs";

const SHIKI_THEME = "vitesse-dark";

export async function renderDocument(tree, { changedLines = [], diffLines = [], diffKind = null, idPrefix = "" } = {}) {
  const headings = collectHeadings(tree);
  const changedLineSet = new Set(changedLines);
  const diffLineSet = new Set(diffLines);
  const state = { headingIndex: 0, changedLineSet, diffLineSet, diffKind, idPrefix, nextSlug: createSlugger() };
  const blocks = [];
  let changeCount = 0;

  for (const node of tree.children ?? []) {
    const changed = rangeHasChange(node, changedLineSet);
    const diffChanged = rangeHasChange(node, diffLineSet);
    if (changed) changeCount += 1;
    blocks.push({
      html: await renderNode(node, state, true),
      startLine: node.position?.start.line ?? 1,
      endLine: node.position?.end.line ?? node.position?.start.line ?? 1,
      changed,
      diffChanged,
      mergedDiff: Boolean(node.data?.mdviewMergedDiff),
    });
  }

  return {
    html: blocks.map((block) => block.html).join("\n"),
    blocks,
    headings: headings.map((heading) => ({
      ...heading,
      changed: [...changedLineSet].some((line) => line >= heading.startLine && line <= heading.endLine),
    })),
    changeCount,
  };
}

async function renderNode(node, state, topLevel = false) {
  const changed = rangeHasChange(node, state.changedLineSet);
  const diffChanged = rangeHasChange(node, state.diffLineSet);
  const changeAttr = changed && !node.data?.mdviewMergedDiff ? ' data-change="modified"' : "";
  const diffAttr = topLevel && !node.data?.mdviewMergedDiff && state.diffKind && rangeHasChange(node, state.diffLineSet)
    ? ` data-diff-kind="${state.diffKind}"`
    : "";
  const sourceAttrs = node.position
    ? ` data-source-start="${node.position.start.line}" data-source-end="${node.position.end.line}"`
    : "";

  switch (node.type) {
    case "heading": {
      const title = collectInlineText(node);
      const id = `${state.idPrefix}${state.nextSlug(title, state.headingIndex)}`;
      state.headingIndex += 1;
      return `<h${node.depth} id="${id}" class="mdv-heading"${changeAttr}${diffAttr}${sourceAttrs}>${await renderInlineChildren(node.children ?? [], state)}</h${node.depth}>`;
    }
    case "paragraph":
      return `<p class="mdv-block mdv-paragraph"${changeAttr}${diffAttr}${sourceAttrs}>${await renderInlineChildren(node.children ?? [], state)}</p>`;
    case "math":
      return `<div class="mdv-block mdv-math mdv-math-display"${changeAttr}${diffAttr}${sourceAttrs}>${renderMathDiff(node, true)}</div>`;
    case "blockquote":
      return `<blockquote class="mdv-block mdv-blockquote"${changeAttr}${diffAttr}${sourceAttrs}>${await renderChildren(node.children ?? [], state)}</blockquote>`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const start = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : "";
      return `<${tag} class="mdv-block mdv-list"${start}${changeAttr}${diffAttr}${sourceAttrs}>${await renderChildren(node.children ?? [], state)}</${tag}>`;
    }
    case "listItem": {
      const diffKind = node.data?.mdviewDiffKind;
      const itemDiffAttr = diffKind ? ` data-diff-kind="${diffKind}"` : "";
      const itemSourceAttrs = node.position && diffKind !== "removed"
        ? ` data-source-start="${node.position.start.line}" data-source-end="${node.position.end.line}"`
        : "";
      const valueAttr = Number.isInteger(node.data?.mdviewListValue) ? ` value="${node.data.mdviewListValue}"` : "";
      const marker = diffKind
        ? `<span class="mdv-list-diff-marker" aria-hidden="true">${diffKind === "removed" ? "−" : "+"}</span><span class="mdv-list-structural-marker${Number.isInteger(node.data?.mdviewListValue) ? " mdv-list-structural-marker-ordered" : ""}" aria-hidden="true">${Number.isInteger(node.data?.mdviewListValue) ? `${node.data.mdviewListValue}.` : "•"}</span><span class="mdv-visually-hidden">${diffKind === "removed" ? "削除項目: " : "追加項目: "}</span>`
        : "";
      return `<li${typeof node.checked === "boolean" ? ' class="mdv-task-item"' : ""}${valueAttr}${itemDiffAttr}${itemSourceAttrs}>${marker}${typeof node.checked === "boolean" ? `<input type="checkbox" disabled${node.checked ? " checked" : ""}>` : ""}${await renderChildren(node.children ?? [], state)}</li>`;
    }
    case "code": {
      if (node.lang === "mermaid" || node.lang === "d2") {
        return renderDiagram(node, changeAttr, diffAttr, sourceAttrs);
      }
      const language = normalizeLanguage(node.lang);
      let highlighted;
      try {
        highlighted = node.data?.mdviewCodeDiffLines
          ? await renderCodeLineDiff(node, language)
          : await codeToHtml(node.value, {
            lang: language,
            theme: SHIKI_THEME,
            decorations: inlineDecorations(node.data?.mdviewInlineDiffRanges),
          });
      } catch {
        highlighted = node.data?.mdviewCodeDiffLines
          ? renderPlainCodeLineDiff(node.data.mdviewCodeDiffLines)
          : `<pre class="shiki"><code>${renderInlineDiffValue(node.value, node.data?.mdviewInlineDiffRanges)}</code></pre>`;
      }
      const lines = node.value.split("\n").length;
      const collapsible = lines > 12 ? " data-collapsible=\"true\"" : "";
      return `<figure class="mdv-block mdv-code"${changeAttr}${diffAttr}${sourceAttrs}${collapsible}>
        <figcaption><span>${escape(node.lang || "text")}</span><span class="mdv-code-actions"><button type="button" data-action="toggle-code">折りたたむ</button><button type="button" data-action="copy-code">コピー</button></span></figcaption>
        ${highlighted}
      </figure>`;
    }
    case "table": {
      const [head, ...body] = node.children ?? [];
      return `<div class="mdv-block mdv-table-wrap"${changeAttr}${diffAttr}${sourceAttrs}><table class="mdv-table"><thead>${head ? await renderTableRow(head, state, true, node.align) : ""}</thead><tbody>${(await Promise.all(body.map((row) => renderTableRow(row, state, false, node.align)))).join("")}</tbody></table></div>`;
    }
    case "tableRow":
      return `<tr>${await renderChildren(node.children ?? [], state)}</tr>`;
    case "tableCell":
      return `<td>${await renderInlineChildren(node.children ?? [], state)}</td>`;
    case "thematicBreak":
      return `<hr class="mdv-separator"${diffAttr}${sourceAttrs}>`;
    case "html": {
      const sanitized = node.data?.mdviewSanitizedHtml ? node.value : await sanitizeRawHtml(node.value);
      if (!topLevel || !diffChanged || !state.diffKind) return sanitized;
      const diffSource = `<pre class="mdv-block mdv-raw-html-diff"${diffAttr}${sourceAttrs}><code>${renderInlineDiffValue(node.value, node.data?.mdviewInlineDiffRanges)}</code></pre>`;
      return state.diffKind === "removed" ? diffSource : `${diffSource}${sanitized}`;
    }
    default:
      return renderInline(node, state);
  }
}

function inlineDecorations(ranges = [], offset = 0) {
  return ranges.map((range) => ({
    start: offset + range.start,
    end: offset + range.end,
    properties: { class: "mdv-inline-diff" },
    alwaysWrap: true,
  }));
}

async function renderCodeLineDiff(node, language) {
  const lines = node.data.mdviewCodeDiffLines;
  const sources = {
    current: node.value.split("\n"),
    previous: node.data.mdviewCodePreviousValue.split("\n"),
  };
  const highlighted = {};
  for (const source of ["current", "previous"]) {
    const sourceLines = sources[source];
    let offset = 0;
    const decorations = [];
    for (const [index, value] of sourceLines.entries()) {
      const diffLine = lines.find((line) => line.source === source && line.sourceIndex === index);
      decorations.push(...inlineDecorations(diffLine?.inlineRanges, offset));
      offset += value.length + 1;
    }
    const html = await codeToHtml(sourceLines.join("\n"), { lang: language, theme: SHIKI_THEME, decorations });
    highlighted[source] = shikiLineHtml(html);
  }
  const renderedLines = lines.map((line) => renderDiffCodeLine(highlighted[line.source]?.[line.sourceIndex] ?? escape(line.value), line));
  return `<pre class="shiki mdv-code-line-diff"><code>${renderedLines.join("\n")}</code></pre>`;
}

function shikiLineHtml(html) {
  return [...html.matchAll(/<span class="line">([\s\S]*?)<\/span>(?=\n|<\/code>)/g)].map((match) => match[1]);
}

function renderDiffCodeLine(content, line) {
  const diffAttr = line.diffKind ? ` data-diff-kind="${line.diffKind}"` : "";
  const marker = line.diffKind ? `<span class="mdv-code-diff-marker" aria-hidden="true">${line.diffKind === "removed" ? "−" : "+"}</span>` : "";
  const label = line.diffKind ? `<span class="mdv-visually-hidden">${line.diffKind === "removed" ? "削除行: " : "追加行: "}</span>` : "";
  return `<span class="line" data-line-number="${line.sourceIndex + 1}"${diffAttr}>${marker}${label}${content}</span>`;
}

function renderPlainCodeLineDiff(lines) {
  return `<pre class="shiki mdv-code-line-diff"><code>${lines.map((line) => renderDiffCodeLine(renderInlineDiffValue(line.value, line.inlineRanges), line)).join("\n")}</code></pre>`;
}

async function renderChildren(children, state) {
  return (await Promise.all(children.map((child) => renderNode(child, state)))).join("");
}

async function renderInlineChildren(children, state) {
  return (await Promise.all(children.map((child) => renderInline(child, state)))).join("");
}

async function renderTableRow(row, state, header, alignments = []) {
  const cellTag = header ? "th" : "td";
  const diffKind = row.data?.mdviewDiffKind;
  const diffAttr = diffKind ? ` data-diff-kind="${diffKind}"` : "";
  const sourceAttrs = row.position && diffKind !== "removed"
    ? ` data-source-start="${row.position.start.line}" data-source-end="${row.position.end.line}"`
    : "";
  const cells = await Promise.all((row.children ?? []).map(async (cell, index) => {
    const marker = index === 0 && diffKind
      ? `<span class="mdv-table-diff-marker" aria-hidden="true">${diffKind === "removed" ? "−" : "+"}</span><span class="mdv-table-diff-label mdv-visually-hidden">${diffKind === "removed" ? "削除行: " : "追加行: "}</span>`
      : "";
    return `<${cellTag}${header ? ' scope="col"' : ""}${alignments[index] ? ` class="align-${alignments[index]}"` : ""}>${marker}${await renderInlineChildren(cell.children ?? [], state)}</${cellTag}>`;
  }));
  return `<tr${diffAttr}${sourceAttrs}>${cells.join("")}</tr>`;
}

async function renderInline(node, state) {
  switch (node.type) {
    case "text":
      return renderInlineDiffValue(node.value, node.data?.mdviewInlineDiffRanges);
    case "strong":
      return `<strong>${await renderInlineChildren(node.children ?? [], state)}</strong>`;
    case "emphasis":
      return `<em>${await renderInlineChildren(node.children ?? [], state)}</em>`;
    case "delete":
      return `<del>${await renderInlineChildren(node.children ?? [], state)}</del>`;
    case "inlineCode":
      return `<code class="mdv-inline-code">${renderInlineDiffValue(node.value, node.data?.mdviewInlineDiffRanges)}</code>`;
    case "inlineMath":
      return `<span class="mdv-math mdv-math-inline">${renderMathDiff(node, false)}</span>`;
    case "link":
      return `<a href="${safeHref(node.url)}" rel="noreferrer">${await renderInlineChildren(node.children ?? [], state)}</a>`;
    case "image":
      return `<img src="${safeHref(node.url)}" alt="${escape(node.alt ?? "")}" loading="lazy">`;
    case "break":
      return "<br>";
    case "html":
      return node.data?.mdviewSanitizedHtml ? node.value : sanitizeRawHtml(node.value);
    default:
      if (node.children) return renderInlineChildren(node.children, state);
      return typeof node.value === "string" ? escape(node.value) : "";
  }
}

function renderMathDiff(node, displayMode) {
  const rendered = renderMath(node.value, displayMode);
  if (!node.data?.mdviewInlineDiffRanges?.length) return rendered;
  const tag = displayMode ? "div" : "span";
  return `<${tag} class="mdv-inline-diff">${rendered}</${tag}>`;
}

function renderMath(value, displayMode) {
  try {
    return katex.renderToString(value, {
      displayMode,
      output: "htmlAndMathml",
      strict: "warn",
      throwOnError: false,
      trust: false,
    });
  } catch {
    return `<code class="mdv-math-error">${escape(value)}</code>`;
  }
}

function renderInlineDiffValue(value, ranges = []) {
  if (ranges.length === 0) return escape(value);
  const html = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) html.push(escape(value.slice(cursor, range.start)));
    html.push(`<span class="mdv-inline-diff">${escape(value.slice(range.start, range.end))}</span>`);
    cursor = range.end;
  }
  if (cursor < value.length) html.push(escape(value.slice(cursor)));
  return html.join("");
}

function renderDiagram(node, changeAttr, diffAttr, sourceAttrs) {
  const source = escape(node.value);
  const engine = escape(node.lang);
  const stage = node.lang === "d2"
    ? node.data?.mdviewDiagramUrl
      ? `<img src="${escape(node.data.mdviewDiagramUrl)}" alt="D2 diagram">`
      : '<p class="mdv-diagram-error">D2 を描画できませんでした。ソースを確認してください。</p>'
    : '<div class="mdv-diagram-loading">図を描画中…</div>';
  return `<figure class="mdv-block mdv-diagram" data-engine="${engine}"${changeAttr}${diffAttr}${sourceAttrs}>
    <figcaption><span>${engine}</span><button type="button" data-action="toggle-diagram-source">ソースを表示</button></figcaption>
    <div class="mdv-diagram-stage" data-diagram-source="${Buffer.from(node.value).toString("base64")}">${stage}</div>
    <pre class="mdv-diagram-source" hidden><code>${source}</code></pre>
  </figure>`;
}

function safeHref(value = "") {
  if (/^(?:javascript|data):/i.test(value)) return "#";
  return escape(value);
}

function normalizeLanguage(language) {
  const aliases = { shell: "bash", sh: "bash", zsh: "bash", ts: "typescript", js: "javascript", yml: "yaml" };
  return aliases[language] ?? language ?? "text";
}
