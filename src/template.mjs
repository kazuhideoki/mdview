import { escape } from "html-escaper";
import icons from "@iconify-json/solar/icons.json" with { type: "json" };

const ICON_NAMES = [
  "folder-open-linear",
  "branching-paths-down-linear",
  "code-square-linear",
  "chat-round-dots-linear",
  "document-text-linear",
  "book-bookmark-linear",
  "settings-linear",
  "alt-arrow-left-linear",
  "copy-linear",
  "code-linear",
  "check-read-linear",
  "arrow-left-linear",
  "arrow-right-linear",
  "menu-dots-linear",
  "list-linear",
  "minimalistic-magnifier-linear",
  "close-circle-linear",
];

function iconSprite() {
  return ICON_NAMES.map((name) => {
    const icon = icons.icons[name];
    if (!icon) return "";
    return `<symbol id="icon-${name}" viewBox="0 0 ${icon.width ?? icons.width ?? 24} ${icon.height ?? icons.height ?? 24}">${icon.body}</symbol>`;
  }).join("");
}

export function icon(name, label = "") {
  const aria = label ? ` role="img" aria-label="${escape(label)}"` : ' aria-hidden="true"';
  return `<svg class="mdv-icon"${aria}><use href="#icon-${name}"></use></svg>`;
}

export function pageTemplate({ title, contentHtml, headings, meta, assets, rawDiff = "" }) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${escape(title)} · mdview</title>
  <link rel="stylesheet" href="${assets.stylesheet}">
</head>
<body>
  <svg class="mdv-icon-sprite" aria-hidden="true">${iconSprite()}</svg>
  <div class="mdv-app" data-view="read" data-document-id="${escape(meta.documentId ?? "")}" data-revision-id="${escape(meta.revisionId ?? "")}" data-current-source="${escape(meta.sourcePath ?? meta.absolutePath ?? "")}" data-current-repo="${escape(meta.repo ?? "")}" data-current-worktree="${escape(meta.worktree ?? "")}" data-current-branch="${escape(meta.branch ?? "")}" data-current-relative-path="${escape(meta.relativePath ?? "")}">
    <header class="mdv-topbar">
      <div class="mdv-context" title="${escape(meta.absolutePath ?? "")}">
        <div class="mdv-source-context">
          <span>${icon("folder-open-linear")}${escape(meta.repo)}</span><b>/</b>
          <span>${icon("code-square-linear")}${escape(meta.worktree ?? meta.repo)}</span><b>/</b>
          <span>${icon("branching-paths-down-linear")}${escape(meta.branchDisplay ?? meta.branch)}</span><b>/</b>
          <span>${icon("document-text-linear")}${escape(meta.relativePath)}</span>
        </div>
      </div>
      <nav class="mdv-view-switch" aria-label="表示モード">
        <button type="button" data-view-target="read" aria-pressed="true" aria-keyshortcuts="R 1" title="Read (R / 1)">Read</button>
        <button type="button" data-view-target="changes" aria-pressed="false" aria-keyshortcuts="C 2" title="Changes (C / 2)">Changes</button>
        <button type="button" data-view-target="raw" aria-pressed="false" aria-keyshortcuts="D 3" title="Raw diff (D / 3)">Raw diff</button>
      </nav>
      <div class="mdv-top-actions">
        <button class="mdv-search-trigger" type="button" data-action="open-search" aria-label="文書を検索" aria-haspopup="dialog" aria-controls="mdv-search-dialog" aria-expanded="false">${icon("minimalistic-magnifier-linear")}<span>検索</span><kbd>⌘K</kbd></button>
        <button type="button" data-action="toggle-toc" aria-label="目次を切り替える">${icon("book-bookmark-linear")}</button>
        <button type="button" data-action="toggle-settings" aria-label="表示設定">${icon("settings-linear")}</button>
      </div>
    </header>
    <aside class="mdv-sidebar" aria-label="目次">
      <div class="mdv-sidebar-head">
        <button type="button" data-action="toggle-toc" aria-label="目次を閉じる">${icon("alt-arrow-left-linear")}</button>
        <span>目次</span>
      </div>
      <nav class="mdv-toc">${renderToc(headings)}</nav>
      <button class="mdv-sidebar-close" type="button" data-action="toggle-toc">${icon("alt-arrow-left-linear")}目次を閉じる</button>
    </aside>
    <button class="mdv-sidebar-scrim" type="button" data-action="toggle-toc" aria-label="目次を閉じる"></button>
    <main class="mdv-main">
      <article class="mdv-document" data-render-schema="1">
        <div class="mdv-document-body">${contentHtml}</div>
      </article>
      <section class="mdv-raw-diff" aria-label="Raw diff" hidden><pre><code>${escape(rawDiff || "この文書には未コミットの差分がありません。")}</code></pre></section>
    </main>
    <footer class="mdv-reviewbar">
      <div class="mdv-history-nav" aria-label="同じファイルの変更履歴">
        <button type="button" data-action="previous-revision" disabled>${icon("arrow-left-linear")}<kbd>P</kbd><span>前の版</span></button>
        <div class="mdv-history-context">
          ${meta.sessionTitle ? `<span class="mdv-session-title" title="Codexセッションの現在名: ${escape(meta.sessionTitle)}">${icon("chat-round-dots-linear")}${escape(meta.sessionTitle)}</span>` : ""}
          <span class="mdv-history-cursor" data-history-status aria-live="polite">履歴を読み込み中…</span>
        </div>
        <button type="button" data-action="next-revision" disabled><span>次の版</span><kbd>N</kbd>${icon("arrow-right-linear")}</button>
      </div>
      <button class="mdv-mark-read" type="button" data-action="mark-read">${icon("check-read-linear")}既読にする</button>
    </footer>
    <aside class="mdv-settings" hidden>
      <div><strong>読みやすさ</strong><button type="button" data-action="toggle-settings" aria-label="表示設定を閉じる">${icon("menu-dots-linear")}</button></div>
      <label>本文幅 <input type="range" min="64" max="88" value="76" data-setting="measure"></label>
      <label>文字サイズ <input type="range" min="15" max="20" value="17" data-setting="font-size"></label>
    </aside>
    <div class="mdv-search-overlay" data-search-overlay hidden>
      <section class="mdv-search-dialog" id="mdv-search-dialog" role="dialog" aria-modal="true" aria-labelledby="mdv-search-title">
        <h2 class="mdv-visually-hidden" id="mdv-search-title">文書を検索</h2>
        <div class="mdv-search-input-row">
          ${icon("minimalistic-magnifier-linear")}
          <input id="mdv-search-input" type="search" role="combobox" aria-label="文書を検索、またはMarkdownファイルを開く" aria-autocomplete="list" aria-controls="mdv-search-results" aria-expanded="false" autocomplete="off" spellcheck="false" placeholder="文書を検索、またはMarkdownファイルの絶対パスを入力">
          <kbd>Esc</kbd>
          <button type="button" data-action="close-search" aria-label="検索を閉じる">${icon("close-circle-linear")}</button>
        </div>
        <p class="mdv-search-status" id="mdv-search-status" role="status" aria-live="polite">文書を読み込んでいます…</p>
        <ul class="mdv-search-results" id="mdv-search-results" role="listbox" aria-label="文書の検索結果"></ul>
        <footer class="mdv-search-help"><span><kbd>↑</kbd><kbd>↓</kbd> 選択</span><span><kbd>Enter</kbd> 開く</span><span><kbd>Esc</kbd> 閉じる</span></footer>
      </section>
    </div>
    <div class="mdv-toast" role="status" aria-live="polite"></div>
  </div>
  <script src="${assets.mermaidScript}"></script>
  <script src="${assets.viewerScript}"></script>
</body>
</html>`;
}

function renderToc(headings) {
  let section = 0;
  let subsection = 0;
  return headings.map((heading) => {
    let number = "";
    if (heading.depth === 2) {
      section += 1;
      subsection = 0;
      number = `${section}. `;
    } else if (heading.depth === 3) {
      subsection += 1;
      number = `${section}.${subsection}. `;
    }
    return `<a href="#${heading.id}" class="depth-${heading.depth}"${heading.changed ? ' data-change="modified"' : ""}>${number}${escape(heading.text)}</a>`;
  }).join("\n");
}
