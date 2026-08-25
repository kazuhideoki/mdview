import { escape } from "html-escaper";
import { codeToHtml } from "shiki";
import { collectHeadings, collectInlineText, createSlugger, rangeHasChange } from "./document.mjs";

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
        highlighted = await codeToHtml(node.value, { lang: language, theme: SHIKI_THEME });
      } catch {
        highlighted = `<pre class="shiki"><code>${escape(node.value)}</code></pre>`;
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
    case "html":
      return `<pre class="mdv-block mdv-raw-html"${diffAttr}${sourceAttrs}><code>${escape(node.value)}</code></pre>`;
    default:
      return renderInline(node, state);
  }
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
    case "link":
      return `<a href="${safeHref(node.url)}" rel="noreferrer">${await renderInlineChildren(node.children ?? [], state)}</a>`;
    case "image":
      return `<img src="${safeHref(node.url)}" alt="${escape(node.alt ?? "")}" loading="lazy">`;
    case "break":
      return "<br>";
    default:
      if (node.children) return renderInlineChildren(node.children, state);
      return typeof node.value === "string" ? escape(node.value) : "";
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
