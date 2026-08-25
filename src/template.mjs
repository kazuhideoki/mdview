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

export function pageTemplate({ title, contentHtml, headings, meta, assets }) {
  const workspaceScoped = Boolean(meta.workspaceId && meta.workspaceRevisionId);
  const documentSearchTrigger = workspaceScoped
    ? `<button class="mdv-search-trigger" type="button" data-action="open-search" aria-label="文書を検索" aria-haspopup="dialog" aria-controls="mdv-search-dialog" aria-expanded="false">${icon("minimalistic-magnifier-linear")}<span>検索</span><kbd>⌘K</kbd></button>`
    : "";
  const sidebar = workspaceScoped
    ? `<aside class="mdv-sidebar" aria-label="ワークツリーの文書">
      <div class="mdv-sidebar-head">
        <button type="button" data-action="toggle-toc" aria-label="サイドバーを閉じる">${icon("alt-arrow-left-linear")}</button>
        <div class="mdv-sidebar-tabs" role="tablist" aria-label="サイドバー表示">
          <button type="button" role="tab" data-sidebar-target="files" aria-selected="true">Files</button>
          <button type="button" role="tab" data-sidebar-target="outline" aria-selected="false">Outline</button>
        </div>
      </div>
      <nav class="mdv-workspace-files" data-sidebar-panel="files" aria-label="Markdownファイル">
        <p class="mdv-sidebar-loading" data-workspace-files-status>ファイルを読み込み中…</p>
        <div data-workspace-files></div>
      </nav>
      <nav class="mdv-toc" data-sidebar-panel="outline" hidden>${renderToc(headings)}</nav>
      <button class="mdv-sidebar-close" type="button" data-action="toggle-toc">${icon("alt-arrow-left-linear")}サイドバーを閉じる</button>
    </aside>`
    : `<aside class="mdv-sidebar" aria-label="目次">
      <div class="mdv-sidebar-head">
        <button type="button" data-action="toggle-toc" aria-label="目次を閉じる">${icon("alt-arrow-left-linear")}</button>
        <span>目次</span>
      </div>
      <nav class="mdv-toc">${renderToc(headings)}</nav>
      <button class="mdv-sidebar-close" type="button" data-action="toggle-toc">${icon("alt-arrow-left-linear")}目次を閉じる</button>
    </aside>`;
  const documentSearchOverlay = workspaceScoped
    ? `<div class="mdv-search-overlay" data-search-overlay hidden>
      <section class="mdv-search-dialog" id="mdv-search-dialog" role="dialog" aria-modal="true" aria-labelledby="mdv-search-title">
        <h2 class="mdv-visually-hidden" id="mdv-search-title">このワークツリーの文書を検索</h2>
        <div class="mdv-search-input-row">
          ${icon("minimalistic-magnifier-linear")}
          <input id="mdv-search-input" type="search" role="combobox" aria-label="このワークツリーのMarkdownを検索" aria-autocomplete="list" aria-controls="mdv-search-results" aria-expanded="false" autocomplete="off" spellcheck="false" placeholder="このワークツリーのMarkdownを検索">
          <kbd>Esc</kbd>
          <button type="button" data-action="close-search" aria-label="検索を閉じる">${icon("close-circle-linear")}</button>
        </div>
        <p class="mdv-search-status" id="mdv-search-status" role="status" aria-live="polite">文書を読み込んでいます…</p>
        <ul class="mdv-search-results" id="mdv-search-results" role="listbox" aria-label="文書の検索結果"></ul>
        <footer class="mdv-search-help"><span><kbd>↑</kbd><kbd>↓</kbd> 選択</span><span><kbd>Enter</kbd> 開く</span><span><kbd>Esc</kbd> 閉じる</span></footer>
      </section>
    </div>`
    : "";
  const documentSearchShortcut = workspaceScoped
    ? `<div><dt><span><kbd>⌘ K</kbd><i>または</i><kbd>/</kbd></span></dt><dd>Markdownを検索</dd></div>`
    : "";
  const shortcutsOverlay = `<div class="mdv-search-overlay mdv-shortcuts-overlay" data-shortcuts-overlay hidden>
      <section class="mdv-shortcuts-dialog" id="mdv-shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="mdv-shortcuts-title" aria-keyshortcuts="?">
        <header class="mdv-shortcuts-header">
          <div><span>Help</span><h2 id="mdv-shortcuts-title">Keyboard shortcuts</h2></div>
          <button type="button" data-action="close-shortcuts" aria-label="ショートカットヘルプを閉じる">${icon("close-circle-linear")}</button>
        </header>
        <div class="mdv-shortcuts-groups">
          <section>
            <h3>履歴を移動</h3>
            <dl>
              <div><dt><kbd>P</kbd></dt><dd>${workspaceScoped ? "前の作業へ" : "前の版へ"}</dd></div>
              <div><dt><kbd>N</kbd></dt><dd>${workspaceScoped ? "次の作業へ" : "次の版へ"}</dd></div>
            </dl>
          </section>
          <section>
            <h3>表示を切り替え</h3>
            <dl>
              <div><dt><span><kbd>R</kbd><i>または</i><kbd>1</kbd></span></dt><dd>Read</dd></div>
              <div><dt><span><kbd>C</kbd><i>または</i><kbd>2</kbd></span></dt><dd>Changes</dd></div>
            </dl>
          </section>
          <section>
            <h3>文書・ワークツリーを探す</h3>
            <dl>
              ${documentSearchShortcut}
              <div><dt><kbd>⇧ ⌘ O</kbd></dt><dd>アウトラインを表示</dd></div>
              <div><dt><kbd>⇧ ⌘ K</kbd></dt><dd>ワークツリーを選択</dd></div>
            </dl>
          </section>
          <section>
            <h3>パレットの操作</h3>
            <dl>
              <div><dt><span><kbd>↑</kbd><kbd>↓</kbd></span></dt><dd>項目を選択</dd></div>
              <div><dt><kbd>Enter</kbd></dt><dd>開く</dd></div>
              <div><dt><kbd>Esc</kbd></dt><dd>閉じる</dd></div>
            </dl>
          </section>
        </div>
        <footer class="mdv-shortcuts-footer">
          <span><kbd>?</kbd><i>または</i><kbd>Esc</kbd> ヘルプを閉じる</span>
          <small>入力欄では単キーショートカットは無効です</small>
        </footer>
      </section>
    </div>`;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri '${meta.documentBaseHref ? "self" : "none"}'; form-action 'none'">
  ${meta.documentBaseHref ? `<base href="${escape(meta.documentBaseHref)}">` : ""}
  <title>${escape(title)} · mdview</title>
  <link rel="stylesheet" href="${assets.stylesheet}">
</head>
<body>
  <svg class="mdv-icon-sprite" aria-hidden="true">${iconSprite()}</svg>
  <div class="mdv-app" data-view="read" data-document-id="${escape(meta.documentId ?? "")}" data-revision-id="${escape(meta.revisionId ?? "")}" data-workspace-id="${escape(meta.workspaceId ?? "")}" data-workspace-revision-id="${escape(meta.workspaceRevisionId ?? "")}" data-current-source="${escape(meta.sourcePath ?? meta.absolutePath ?? "")}" data-current-repo="${escape(meta.repo ?? "")}" data-current-worktree="${escape(meta.worktree ?? "")}" data-current-branch="${escape(meta.branch ?? "")}" data-current-relative-path="${escape(meta.relativePath ?? "")}">
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
      </nav>
      <div class="mdv-top-actions">
        ${documentSearchTrigger}
        <button type="button" data-action="toggle-toc" aria-label="サイドバーを切り替える">${icon("book-bookmark-linear")}</button>
        <button type="button" data-action="toggle-settings" aria-label="表示設定">${icon("settings-linear")}</button>
      </div>
    </header>
    ${sidebar}
    <button class="mdv-sidebar-scrim" type="button" data-action="toggle-toc" aria-label="サイドバーを閉じる"></button>
    <main class="mdv-main">
      <article class="mdv-document" data-render-schema="1">
        <div class="mdv-document-body">${contentHtml}</div>
      </article>
    </main>
    <footer class="mdv-reviewbar">
      <div class="mdv-history-nav" aria-label="${workspaceScoped ? "ワークツリーの作業履歴" : "同じファイルの変更履歴"}">
        <button type="button" data-action="previous-revision" disabled>${icon("arrow-left-linear")}<kbd>P</kbd><span>${workspaceScoped ? "前の作業" : "前の版"}</span></button>
        <div class="mdv-history-context">
          ${meta.sessionTitle ? `<span class="mdv-session-title" title="Codexセッションの現在名: ${escape(meta.sessionTitle)}">${icon("chat-round-dots-linear")}${escape(meta.sessionTitle)}</span>` : ""}
          <span class="mdv-history-cursor" data-history-status aria-live="polite">履歴を読み込み中…</span>
        </div>
        <button type="button" data-action="next-revision" disabled><span>${workspaceScoped ? "次の作業" : "次の版"}</span><kbd>N</kbd>${icon("arrow-right-linear")}</button>
      </div>
    </footer>
    <aside class="mdv-settings" hidden>
      <div><strong>読みやすさ</strong><button type="button" data-action="toggle-settings" aria-label="表示設定を閉じる">${icon("menu-dots-linear")}</button></div>
      <label>本文幅 <input type="range" min="64" max="88" value="76" data-setting="measure"></label>
      <label>文字サイズ <input type="range" min="15" max="20" value="17" data-setting="font-size"></label>
    </aside>
    ${documentSearchOverlay}
    <div class="mdv-search-overlay mdv-outline-palette-overlay" data-outline-palette-overlay hidden>
      <section class="mdv-search-dialog" id="mdv-outline-palette-dialog" role="dialog" aria-modal="true" aria-labelledby="mdv-outline-palette-title">
        <h2 class="mdv-visually-hidden" id="mdv-outline-palette-title">現在の文書のアウトライン</h2>
        <div class="mdv-search-input-row">
          ${icon("list-linear")}
          <input id="mdv-outline-palette-input" type="search" role="combobox" aria-label="現在の文書の見出しを検索" aria-autocomplete="list" aria-controls="mdv-outline-palette-results" aria-expanded="false" aria-keyshortcuts="Meta+Shift+O Control+Shift+O" autocomplete="off" spellcheck="false" placeholder="現在の文書の見出しを検索">
          <kbd>Esc</kbd>
          <button type="button" data-action="close-outline-palette" aria-label="アウトラインを閉じる">${icon("close-circle-linear")}</button>
        </div>
        <p class="mdv-search-status" id="mdv-outline-palette-status" role="status" aria-live="polite">見出しを読み込んでいます…</p>
        <ul class="mdv-search-results mdv-outline-results" id="mdv-outline-palette-results" role="listbox" aria-label="アウトライン"></ul>
        <footer class="mdv-search-help"><span><kbd>↑</kbd><kbd>↓</kbd> 選択</span><span><kbd>Enter</kbd> 移動</span><span><kbd>Esc</kbd> 閉じる</span></footer>
      </section>
    </div>
    <div class="mdv-search-overlay mdv-workspace-palette-overlay" data-workspace-palette-overlay hidden>
      <section class="mdv-search-dialog" id="mdv-workspace-palette-dialog" role="dialog" aria-modal="true" aria-labelledby="mdv-workspace-palette-title">
        <h2 class="mdv-visually-hidden" id="mdv-workspace-palette-title">ワークツリーを選択</h2>
        <div class="mdv-search-input-row">
          ${icon("code-square-linear")}
          <input id="mdv-workspace-palette-input" type="search" role="combobox" aria-label="ワークツリーを検索" aria-autocomplete="list" aria-controls="mdv-workspace-palette-results" aria-expanded="false" autocomplete="off" spellcheck="false" placeholder="リポジトリ、ワークツリー、ブランチを検索">
          <kbd>Esc</kbd>
          <button type="button" data-action="close-workspace-palette" aria-label="ワークツリー選択を閉じる">${icon("close-circle-linear")}</button>
        </div>
        <p class="mdv-search-status" id="mdv-workspace-palette-status" role="status" aria-live="polite">ワークツリーを読み込んでいます…</p>
        <ul class="mdv-search-results" id="mdv-workspace-palette-results" role="listbox" aria-label="ワークツリーの検索結果"></ul>
        <footer class="mdv-search-help"><span><kbd>↑</kbd><kbd>↓</kbd> 選択</span><span><kbd>Enter</kbd> 開く</span><span><kbd>Esc</kbd> 閉じる</span></footer>
      </section>
    </div>
    ${shortcutsOverlay}
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
