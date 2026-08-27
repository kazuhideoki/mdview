const app = document.querySelector(".mdv-app");
const headings = [...document.querySelectorAll(".mdv-heading[id]")]
  .filter((heading) => !heading.closest('[data-diff-kind="removed"]'));
const tocLinks = [...document.querySelectorAll(".mdv-toc a")];
const documentId = app?.dataset.documentId || "";
const revisionId = app?.dataset.revisionId || "";
const workspaceId = app?.dataset.workspaceId || "";
const workspaceRevisionId = app?.dataset.workspaceRevisionId || "";
const lineageWorkspaceId = /^[a-f0-9]{24}$/.test(new URLSearchParams(location.search).get("lineage") || "")
  ? new URLSearchParams(location.search).get("lineage")
  : "";
const storageKey = documentId ? `mdview:document:${documentId}` : `mdview:${location.pathname}`;
const searchOverlay = document.querySelector("[data-search-overlay]");
const searchInput = document.querySelector("#mdv-search-input");
const searchResults = document.querySelector("#mdv-search-results");
const searchStatus = document.querySelector("#mdv-search-status");
const workspacePaletteOverlay = document.querySelector("[data-workspace-palette-overlay]");
const workspacePaletteInput = document.querySelector("#mdv-workspace-palette-input");
const workspacePaletteResults = document.querySelector("#mdv-workspace-palette-results");
const workspacePaletteStatus = document.querySelector("#mdv-workspace-palette-status");
const outlinePaletteOverlay = document.querySelector("[data-outline-palette-overlay]");
const outlinePaletteInput = document.querySelector("#mdv-outline-palette-input");
const outlinePaletteResults = document.querySelector("#mdv-outline-palette-results");
const outlinePaletteStatus = document.querySelector("#mdv-outline-palette-status");
const shortcutsOverlay = document.querySelector("[data-shortcuts-overlay]");
const shortcutsDialog = document.querySelector("#mdv-shortcuts-dialog");
const workspaceFiles = document.querySelector("[data-workspace-files]");
const workspaceFilesStatus = document.querySelector("[data-workspace-files-status]");
const searchState = {
  entries: [],
  matches: [],
  activeIndex: -1,
  controller: null,
  restoreFocus: null,
};
const workspacePaletteState = {
  matches: [],
  activeIndex: -1,
  restoreFocus: null,
};
const outlinePaletteState = {
  entries: headings.map((heading, index) => ({
    id: heading.id,
    title: heading.textContent?.trim() || heading.id,
    depth: Number(heading.tagName.slice(1)) || 1,
    index,
  })),
  matches: [],
  activeIndex: -1,
  restoreFocus: null,
};
const shortcutsState = {
  restoreFocus: null,
};
const workspaceState = {
  files: [],
  workspaces: [],
  payload: null,
  loading: null,
  optionsLoaded: false,
  optionsLoading: null,
};
const historyState = {
  revisions: [],
  currentIndex: -1,
  loading: false,
};

for (const button of document.querySelectorAll("[data-view-target]")) {
  button.addEventListener("click", () => setView(button.dataset.viewTarget));
}

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => runAction(button));
}

for (const input of document.querySelectorAll("[data-setting]")) {
  input.addEventListener("input", () => applySetting(input.dataset.setting, input.value));
}

for (const button of document.querySelectorAll("[data-sidebar-target]")) {
  button.addEventListener("click", () => setSidebarPanel(button.dataset.sidebarTarget));
}

searchInput?.addEventListener("input", updateSearchResults);
searchOverlay?.addEventListener("click", (event) => {
  if (event.target === searchOverlay) closeSearch();
});
searchResults?.addEventListener("mousemove", (event) => {
  const option = event.target.closest("[role='option']");
  if (option) setActiveSearchResult(Number(option.dataset.resultIndex), false);
});
searchResults?.addEventListener("mousedown", (event) => {
  if (event.target.closest("[role='option']")) event.preventDefault();
});
searchResults?.addEventListener("click", (event) => {
  const option = event.target.closest("[role='option']");
  if (!option) return;
  setActiveSearchResult(Number(option.dataset.resultIndex), false);
  openSelectedSearchResult();
});
workspacePaletteInput?.addEventListener("input", updateWorkspacePaletteResults);
workspacePaletteOverlay?.addEventListener("click", (event) => {
  if (event.target === workspacePaletteOverlay) closeWorkspacePalette();
});
workspacePaletteResults?.addEventListener("mousemove", (event) => {
  const option = event.target.closest("[role='option']");
  if (option) setActiveWorkspaceResult(Number(option.dataset.resultIndex), false);
});
workspacePaletteResults?.addEventListener("mousedown", (event) => {
  if (event.target.closest("[role='option']")) event.preventDefault();
});
workspacePaletteResults?.addEventListener("click", (event) => {
  const option = event.target.closest("[role='option']");
  if (!option) return;
  setActiveWorkspaceResult(Number(option.dataset.resultIndex), false);
  openSelectedWorkspace();
});
outlinePaletteInput?.addEventListener("input", updateOutlinePaletteResults);
outlinePaletteOverlay?.addEventListener("click", (event) => {
  if (event.target === outlinePaletteOverlay) closeOutlinePalette();
});
outlinePaletteResults?.addEventListener("mousemove", (event) => {
  const option = event.target.closest("[role='option']");
  if (option) setActiveOutlineResult(Number(option.dataset.resultIndex), false);
});
outlinePaletteResults?.addEventListener("mousedown", (event) => {
  if (event.target.closest("[role='option']")) event.preventDefault();
});
outlinePaletteResults?.addEventListener("click", (event) => {
  const option = event.target.closest("[role='option']");
  if (!option) return;
  setActiveOutlineResult(Number(option.dataset.resultIndex), false);
  openSelectedOutlineResult();
});
shortcutsOverlay?.addEventListener("click", (event) => {
  if (event.target === shortcutsOverlay) closeShortcuts();
});
document.addEventListener("click", (event) => {
  if (!lineageWorkspaceId || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const anchor = event.target.closest?.("a[href]");
  if (!anchor) return;
  const destination = new URL(anchor.href, location.origin);
  if (destination.origin !== location.origin || (
    !destination.pathname.startsWith("/__mdview/follow/")
    && !destination.pathname.startsWith("/__mdview/workspaces/")
  )) return;
  event.preventDefault();
  destination.searchParams.set("lineage", lineageWorkspaceId);
  location.assign(`${destination.pathname}${destination.search}${destination.hash}`);
});

if (matchMedia("(max-width: 760px)").matches) app?.classList.add("toc-hidden");
syncTocState();
restorePreferences();
restoreRevisionNavigation();
restoreRequestedView();
observeHeadings();
renderDiagrams();
if (workspaceId && workspaceRevisionId) loadWorkspaceContext();
else loadHistory();

function setView(view) {
  app.dataset.view = view;
  for (const button of document.querySelectorAll("[data-view-target]")) {
    button.setAttribute("aria-pressed", String(button.dataset.viewTarget === view));
  }
}

function setSidebarPanel(panel) {
  if (!["files", "outline"].includes(panel)) return;
  for (const button of document.querySelectorAll("[data-sidebar-target]")) {
    button.setAttribute("aria-selected", String(button.dataset.sidebarTarget === panel));
  }
  for (const target of document.querySelectorAll("[data-sidebar-panel]")) {
    target.hidden = target.dataset.sidebarPanel !== panel;
  }
}

async function runAction(button) {
  switch (button.dataset.action) {
    case "toggle-toc":
      app.classList.toggle("toc-hidden");
      syncTocState();
      break;
    case "toggle-settings": {
      const panel = document.querySelector(".mdv-settings");
      panel.hidden = !panel.hidden;
      break;
    }
    case "open-search":
      openSearch();
      break;
    case "close-search":
      closeSearch();
      break;
    case "close-workspace-palette":
      closeWorkspacePalette();
      break;
    case "close-outline-palette":
      closeOutlinePalette();
      break;
    case "close-shortcuts":
      closeShortcuts();
      break;
    case "previous-revision":
      navigateRevision(-1);
      break;
    case "next-revision":
      navigateRevision(1);
      break;
    case "toggle-code": {
      const figure = button.closest(".mdv-code");
      figure.classList.toggle("collapsed");
      button.textContent = figure.classList.contains("collapsed") ? "展開する" : "折りたたむ";
      break;
    }
    case "copy-code": {
      const figure = button.closest(".mdv-code");
      const diffLines = [...(figure?.querySelectorAll(".mdv-code-line-diff .line") ?? [])];
      const code = diffLines.length > 0
        ? diffLines.filter((line) => line.dataset.diffKind !== "removed").map(codeLineText).join("\n")
        : figure?.querySelector("pre code")?.textContent ?? "";
      await navigator.clipboard.writeText(code);
      showToast("コードをコピーしました");
      break;
    }
    case "toggle-diagram-source": {
      const source = button.closest(".mdv-diagram")?.querySelector(".mdv-diagram-source");
      source.hidden = !source.hidden;
      button.textContent = source.hidden ? "ソースを表示" : "ソースを隠す";
      break;
    }
  }
}

function codeLineText(line) {
  const copy = line.cloneNode(true);
  for (const marker of copy.querySelectorAll(".mdv-code-diff-marker, .mdv-visually-hidden")) marker.remove();
  return copy.textContent ?? "";
}

document.addEventListener("keydown", (event) => {
  const commandShiftO = (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "o";
  if (commandShiftO) {
    event.preventDefault();
    closeShortcuts();
    if (isOutlinePaletteOpen()) closeOutlinePalette();
    else {
      closeSearch();
      closeWorkspacePalette();
      openOutlinePalette();
    }
    return;
  }
  const commandK = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k";
  if (commandK && event.shiftKey) {
    event.preventDefault();
    closeShortcuts();
    if (isWorkspacePaletteOpen()) closeWorkspacePalette();
    else {
      closeSearch();
      closeOutlinePalette();
      openWorkspacePalette();
    }
    return;
  }
  if (commandK) {
    event.preventDefault();
    closeShortcuts();
    if (isSearchOpen()) closeSearch();
    else {
      closeWorkspacePalette();
      closeOutlinePalette();
      openSearch();
    }
    return;
  }

  if (isShortcutsOpen()) {
    if (event.key === "?" && event.repeat) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" || event.key === "?") {
      event.preventDefault();
      closeShortcuts();
      return;
    }
    if (event.key === "Tab") trapPaletteFocus(shortcutsOverlay, event);
    return;
  }

  if (isWorkspacePaletteOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeWorkspacePalette();
      return;
    }
    const selectionDirection = paletteSelectionDirection(event);
    if (selectionDirection) {
      event.preventDefault();
      moveWorkspaceSelection(selectionDirection);
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      if (event.target.closest?.('[data-action="close-workspace-palette"]')) {
        event.preventDefault();
        closeWorkspacePalette();
        return;
      }
      if (event.target === workspacePaletteInput) {
        event.preventDefault();
        openSelectedWorkspace();
        return;
      }
    }
    if (event.key === "Tab") trapPaletteFocus(workspacePaletteOverlay, event);
    return;
  }

  if (isOutlinePaletteOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeOutlinePalette();
      return;
    }
    const selectionDirection = paletteSelectionDirection(event);
    if (selectionDirection) {
      event.preventDefault();
      moveOutlineSelection(selectionDirection);
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      if (event.target.closest?.('[data-action="close-outline-palette"]')) {
        event.preventDefault();
        closeOutlinePalette();
        return;
      }
      if (event.target === outlinePaletteInput) {
        event.preventDefault();
        openSelectedOutlineResult();
        return;
      }
    }
    if (event.key === "Tab") trapPaletteFocus(outlinePaletteOverlay, event);
    return;
  }

  if (isSearchOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }
    const selectionDirection = paletteSelectionDirection(event);
    if (selectionDirection) {
      event.preventDefault();
      moveSearchSelection(selectionDirection);
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      if (event.target.closest?.('[data-action="close-search"]')) {
        event.preventDefault();
        closeSearch();
        return;
      }
      if (event.target === searchInput) {
        event.preventDefault();
        openSelectedSearchResult();
        return;
      }
    }
    if (event.key === "Tab") trapPaletteFocus(searchOverlay, event);
    return;
  }

  if (event.key === "?" && !event.repeat && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
    event.preventDefault();
    closeSearch();
    closeWorkspacePalette();
    openShortcuts();
    return;
  }

  const viewButton = event.target.closest?.("[data-view-target]");
  if (viewButton && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    const buttons = [...document.querySelectorAll("[data-view-target]")];
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextButton = buttons[(buttons.indexOf(viewButton) + direction + buttons.length) % buttons.length];
    setView(nextButton.dataset.viewTarget);
    nextButton.focus();
    return;
  }

  const viewShortcuts = {
    r: "read",
    "1": "read",
    c: "changes",
    "2": "changes",
  };
  const view = viewShortcuts[event.key.toLowerCase()];
  if (view && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !isEditableTarget(event.target)) {
    event.preventDefault();
    setView(view);
    return;
  }

  if (event.key === "/" && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
    event.preventDefault();
    openSearch();
    return;
  }

  const historyDirection = event.key.toLowerCase() === "n"
    ? 1
    : event.key.toLowerCase() === "p"
      ? -1
      : 0;
  if (historyDirection && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
    event.preventDefault();
    navigateRevision(historyDirection);
    return;
  }

  if (event.key !== "Escape") return;
  app.classList.add("toc-hidden");
  syncTocState();
  const panel = document.querySelector(".mdv-settings");
  if (panel) panel.hidden = true;
});

function paletteSelectionDirection(event) {
  if (event.key === "ArrowDown") return 1;
  if (event.key === "ArrowUp") return -1;
  if (event.isComposing || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return 0;
  if (event.key.toLowerCase() === "n") return 1;
  if (event.key.toLowerCase() === "p") return -1;
  return 0;
}

function syncTocState() {
  const expanded = !app.classList.contains("toc-hidden");
  for (const button of document.querySelectorAll('[data-action="toggle-toc"]')) {
    button.setAttribute("aria-expanded", String(expanded));
  }
}

async function openSearch() {
  if (!searchOverlay || !searchInput || !searchResults || !searchStatus || isSearchOpen()) return;
  searchState.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  searchOverlay.hidden = false;
  setPaletteBackgroundInert(searchOverlay, true);
  document.body.classList.add("mdv-search-open");
  searchInput.setAttribute("aria-expanded", "true");
  syncSearchTriggerState(true);
  searchInput.value = "";
  searchState.entries = [];
  searchState.matches = [];
  searchState.activeIndex = -1;
  searchResults.replaceChildren();
  setSearchStatus("このワークツリーの文書を読み込んでいます…", "loading");
  requestAnimationFrame(() => searchInput.focus());

  searchState.controller?.abort();
  const controller = new AbortController();
  searchState.controller = controller;
  try {
    await ensureWorkspaceDetails(controller.signal);
    if (controller !== searchState.controller || !isSearchOpen()) return;
    searchState.entries = workspaceState.files.filter((entry) => entry.changeKind !== "deleted" || app.dataset.view === "changes");
    updateSearchResults();
  } catch (error) {
    if (error.name === "AbortError" || controller !== searchState.controller) return;
    searchState.entries = [];
    searchState.matches = [];
    searchState.activeIndex = -1;
    searchResults.replaceChildren();
    setSearchStatus("文書一覧を読み込めませんでした。検索を閉じて、もう一度お試しください。", "error");
    console.error("mdview: workspace files fetch failed", error);
  }
}

function closeSearch() {
  if (!searchOverlay || searchOverlay.hidden) return;
  searchState.controller?.abort();
  searchState.controller = null;
  searchOverlay.hidden = true;
  setPaletteBackgroundInert(searchOverlay, false);
  document.body.classList.remove("mdv-search-open");
  searchInput?.setAttribute("aria-expanded", "false");
  syncSearchTriggerState(false);
  searchInput?.removeAttribute("aria-activedescendant");
  const restoreTarget = searchState.restoreFocus?.isConnected
    ? searchState.restoreFocus
    : document.querySelector('[data-action="open-search"]');
  searchState.restoreFocus = null;
  restoreTarget?.focus();
}

function isSearchOpen() {
  return Boolean(searchOverlay && !searchOverlay.hidden);
}

function syncSearchTriggerState(expanded) {
  for (const trigger of document.querySelectorAll('[data-action="open-search"]')) {
    trigger.setAttribute("aria-expanded", String(expanded));
  }
}

function setPaletteBackgroundInert(overlay, inert) {
  if (!app || !overlay) return;
  for (const child of app.children) {
    if (child !== overlay) child.inert = inert;
  }
}

function updateSearchResults() {
  if (!searchResults || !searchInput || !searchStatus) return;
  const query = searchInput.value.trim();
  searchState.matches = rankCatalog(searchState.entries, query).slice(0, 80);
  searchResults.replaceChildren();

  for (const [index, entry] of searchState.matches.entries()) {
    const option = document.createElement("li");
    option.id = `mdv-search-option-${index}`;
    option.className = "mdv-search-option";
    option.dataset.resultIndex = String(index);
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    if (entry.current) {
      option.classList.add("is-current");
      option.setAttribute("aria-current", "page");
    }

    const main = document.createElement("span");
    main.className = "mdv-search-option-main";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const path = document.createElement("span");
    path.textContent = entry.relativePath;
    main.append(title, path);

    const context = document.createElement("span");
    context.className = "mdv-search-option-context";
    const directory = document.createElement("span");
    directory.textContent = entry.directory || "Markdown";
    context.append(directory);
    if (entry.current) {
      const current = document.createElement("span");
      current.className = "mdv-search-current";
      current.textContent = "現在";
      context.append(current);
    }
    if (entry.changeKind) {
      const status = document.createElement("span");
      status.className = "mdv-search-change-status";
      status.dataset.changeKind = entry.changeKind;
      status.textContent = changeKindLabel(entry.changeKind);
      context.append(status);
    }
    option.append(main, context);
    searchResults.append(option);
  }

  if (!searchState.matches.length && !searchState.entries.length) {
    searchState.activeIndex = -1;
    searchInput.removeAttribute("aria-activedescendant");
    setSearchStatus("閲覧できる文書はまだありません。", "empty");
  } else if (!searchState.matches.length) {
    searchState.activeIndex = -1;
    searchInput.removeAttribute("aria-activedescendant");
    setSearchStatus(`「${query}」に一致する文書はありません。`, "empty");
  } else {
    setActiveSearchResult(0, false);
    setSearchStatus(`${searchState.matches.length} 件の文書`, "ready");
  }
}

function setSearchStatus(message, state) {
  searchStatus.textContent = message;
  searchStatus.dataset.state = state;
}

function setActiveSearchResult(index, scroll = true) {
  if (!searchInput || !searchResults || !searchState.matches.length || !Number.isFinite(index)) return;
  searchState.activeIndex = (index + searchState.matches.length) % searchState.matches.length;
  for (const [optionIndex, option] of [...searchResults.children].entries()) {
    const selected = optionIndex === searchState.activeIndex;
    option.classList.toggle("is-active", selected);
    option.setAttribute("aria-selected", String(selected));
    if (selected && scroll) option.scrollIntoView({ block: "nearest" });
  }
  searchInput.setAttribute("aria-activedescendant", `mdv-search-option-${searchState.activeIndex}`);
}

function moveSearchSelection(direction) {
  if (!searchState.matches.length) return;
  setActiveSearchResult(searchState.activeIndex + direction);
}

async function openSelectedSearchResult() {
  const entry = searchState.matches[searchState.activeIndex];
  if (entry?.href) navigateToReaderHref(entry.href);
}

async function openWorkspacePalette() {
  if (!workspacePaletteOverlay || !workspacePaletteInput || !workspacePaletteResults || !workspacePaletteStatus || isWorkspacePaletteOpen()) return;
  workspacePaletteState.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  workspacePaletteOverlay.hidden = false;
  setPaletteBackgroundInert(workspacePaletteOverlay, true);
  document.body.classList.add("mdv-search-open");
  workspacePaletteInput.setAttribute("aria-expanded", "true");
  workspacePaletteInput.value = "";
  workspacePaletteState.matches = [];
  workspacePaletteState.activeIndex = -1;
  workspacePaletteResults.replaceChildren();
  setWorkspacePaletteStatus("ワークツリーを読み込んでいます…", "loading");
  requestAnimationFrame(() => workspacePaletteInput.focus());

  try {
    await ensureWorkspaceOptions();
    if (!isWorkspacePaletteOpen()) return;
    updateWorkspacePaletteResults();
  } catch (error) {
    workspacePaletteState.matches = [];
    workspacePaletteState.activeIndex = -1;
    workspacePaletteResults.replaceChildren();
    setWorkspacePaletteStatus("ワークツリーを読み込めませんでした。閉じて、もう一度お試しください。", "error");
    console.error("mdview: worktree palette fetch failed", error);
  }
}

function closeWorkspacePalette() {
  if (!workspacePaletteOverlay || workspacePaletteOverlay.hidden) return;
  workspacePaletteOverlay.hidden = true;
  setPaletteBackgroundInert(workspacePaletteOverlay, false);
  document.body.classList.remove("mdv-search-open");
  workspacePaletteInput?.setAttribute("aria-expanded", "false");
  workspacePaletteInput?.removeAttribute("aria-activedescendant");
  const restoreTarget = workspacePaletteState.restoreFocus?.isConnected
    ? workspacePaletteState.restoreFocus
    : null;
  workspacePaletteState.restoreFocus = null;
  restoreTarget?.focus();
}

function isWorkspacePaletteOpen() {
  return Boolean(workspacePaletteOverlay && !workspacePaletteOverlay.hidden);
}

function openOutlinePalette() {
  if (!outlinePaletteOverlay || !outlinePaletteInput || !outlinePaletteResults || !outlinePaletteStatus || isOutlinePaletteOpen()) return;
  outlinePaletteState.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  outlinePaletteOverlay.hidden = false;
  setPaletteBackgroundInert(outlinePaletteOverlay, true);
  document.body.classList.add("mdv-search-open");
  outlinePaletteInput.setAttribute("aria-expanded", "true");
  outlinePaletteInput.value = "";
  outlinePaletteState.matches = [];
  outlinePaletteState.activeIndex = -1;
  updateOutlinePaletteResults();
  requestAnimationFrame(() => outlinePaletteInput.focus());
}

function closeOutlinePalette({ restoreFocus = true } = {}) {
  if (!outlinePaletteOverlay || outlinePaletteOverlay.hidden) return;
  outlinePaletteOverlay.hidden = true;
  setPaletteBackgroundInert(outlinePaletteOverlay, false);
  document.body.classList.remove("mdv-search-open");
  outlinePaletteInput?.setAttribute("aria-expanded", "false");
  outlinePaletteInput?.removeAttribute("aria-activedescendant");
  const restoreTarget = restoreFocus && outlinePaletteState.restoreFocus?.isConnected
    ? outlinePaletteState.restoreFocus
    : null;
  outlinePaletteState.restoreFocus = null;
  restoreTarget?.focus();
}

function isOutlinePaletteOpen() {
  return Boolean(outlinePaletteOverlay && !outlinePaletteOverlay.hidden);
}

function updateOutlinePaletteResults() {
  if (!outlinePaletteResults || !outlinePaletteInput || !outlinePaletteStatus) return;
  const query = outlinePaletteInput.value.trim();
  outlinePaletteState.matches = rankOutline(outlinePaletteState.entries, query);
  outlinePaletteResults.replaceChildren();

  for (const [index, entry] of outlinePaletteState.matches.entries()) {
    const option = document.createElement("li");
    option.id = `mdv-outline-option-${index}`;
    option.className = `mdv-search-option mdv-outline-option depth-${entry.depth}`;
    option.dataset.resultIndex = String(index);
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");

    const marker = document.createElement("span");
    marker.className = "mdv-outline-marker";
    marker.textContent = "#".repeat(entry.depth);
    marker.setAttribute("aria-hidden", "true");
    const title = document.createElement("strong");
    title.textContent = entry.title;
    option.append(marker, title);
    outlinePaletteResults.append(option);
  }

  if (!outlinePaletteState.entries.length) {
    outlinePaletteState.activeIndex = -1;
    outlinePaletteInput.removeAttribute("aria-activedescendant");
    setOutlinePaletteStatus("この文書には見出しがありません。", "empty");
  } else if (!outlinePaletteState.matches.length) {
    outlinePaletteState.activeIndex = -1;
    outlinePaletteInput.removeAttribute("aria-activedescendant");
    setOutlinePaletteStatus(`「${query}」に一致する見出しはありません。`, "empty");
  } else {
    setActiveOutlineResult(0, false);
    setOutlinePaletteStatus(`${outlinePaletteState.matches.length} 件の見出し`, "ready");
  }
}

function setOutlinePaletteStatus(message, state) {
  outlinePaletteStatus.textContent = message;
  outlinePaletteStatus.dataset.state = state;
}

function setActiveOutlineResult(index, scroll = true) {
  if (!outlinePaletteInput || !outlinePaletteResults || !outlinePaletteState.matches.length || !Number.isFinite(index)) return;
  outlinePaletteState.activeIndex = (index + outlinePaletteState.matches.length) % outlinePaletteState.matches.length;
  for (const [optionIndex, option] of [...outlinePaletteResults.children].entries()) {
    const selected = optionIndex === outlinePaletteState.activeIndex;
    option.classList.toggle("is-active", selected);
    option.setAttribute("aria-selected", String(selected));
    if (selected && scroll) option.scrollIntoView({ block: "nearest" });
  }
  outlinePaletteInput.setAttribute("aria-activedescendant", `mdv-outline-option-${outlinePaletteState.activeIndex}`);
}

function moveOutlineSelection(direction) {
  if (!outlinePaletteState.matches.length) return;
  setActiveOutlineResult(outlinePaletteState.activeIndex + direction);
}

function openSelectedOutlineResult() {
  const entry = outlinePaletteState.matches[outlinePaletteState.activeIndex];
  if (!entry) return;
  const heading = document.getElementById(entry.id);
  if (!heading) return;
  closeOutlinePalette({ restoreFocus: false });
  history.pushState(null, "", `#${encodeURIComponent(entry.id)}`);
  requestAnimationFrame(() => {
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    heading.scrollIntoView({ block: "start", behavior });
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  });
}

function rankOutline(entries, query) {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [...entries];
  return entries.map((entry) => {
    let score = 0;
    for (const term of terms) {
      const fieldScore = fuzzyFieldScore(entry.title, term, 80);
      if (!Number.isFinite(fieldScore)) return { entry, score: Number.NEGATIVE_INFINITY };
      score += fieldScore;
    }
    return { entry, score };
  }).filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score || left.entry.index - right.entry.index)
    .map(({ entry }) => entry);
}

function openShortcuts() {
  if (!shortcutsOverlay || !shortcutsDialog || isShortcutsOpen()) return;
  shortcutsState.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  shortcutsOverlay.hidden = false;
  setPaletteBackgroundInert(shortcutsOverlay, true);
  document.body.classList.add("mdv-search-open");
  requestAnimationFrame(() => shortcutsDialog.querySelector("button")?.focus());
}

function closeShortcuts() {
  if (!shortcutsOverlay || shortcutsOverlay.hidden) return;
  shortcutsOverlay.hidden = true;
  setPaletteBackgroundInert(shortcutsOverlay, false);
  document.body.classList.remove("mdv-search-open");
  const restoreTarget = shortcutsState.restoreFocus?.isConnected ? shortcutsState.restoreFocus : null;
  shortcutsState.restoreFocus = null;
  restoreTarget?.focus();
}

function isShortcutsOpen() {
  return Boolean(shortcutsOverlay && !shortcutsOverlay.hidden);
}

function updateWorkspacePaletteResults() {
  if (!workspacePaletteResults || !workspacePaletteInput || !workspacePaletteStatus) return;
  const query = workspacePaletteInput.value.trim();
  workspacePaletteState.matches = rankWorkspaces(workspaceState.workspaces, query).slice(0, 80);
  workspacePaletteResults.replaceChildren();

  for (const [index, entry] of workspacePaletteState.matches.entries()) {
    const option = document.createElement("li");
    option.id = `mdv-workspace-option-${index}`;
    option.className = "mdv-search-option";
    option.dataset.resultIndex = String(index);
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    if (entry.current) {
      option.classList.add("is-current");
      option.setAttribute("aria-current", "page");
    }

    const main = document.createElement("span");
    main.className = "mdv-search-option-main";
    const title = document.createElement("strong");
    title.textContent = entry.worktree;
    const repo = document.createElement("span");
    repo.textContent = entry.repo;
    main.append(title, repo);

    const context = document.createElement("span");
    context.className = "mdv-search-option-context";
    const branch = document.createElement("span");
    branch.textContent = entry.branch || "detached";
    context.append(branch);
    if (entry.current) {
      const current = document.createElement("span");
      current.className = "mdv-search-current";
      current.textContent = "現在";
      context.append(current);
    }
    option.append(main, context);
    workspacePaletteResults.append(option);
  }

  if (!workspacePaletteState.matches.length && !workspaceState.workspaces.length) {
    workspacePaletteState.activeIndex = -1;
    workspacePaletteInput.removeAttribute("aria-activedescendant");
    setWorkspacePaletteStatus("選択できるワークツリーはまだありません。", "empty");
  } else if (!workspacePaletteState.matches.length) {
    workspacePaletteState.activeIndex = -1;
    workspacePaletteInput.removeAttribute("aria-activedescendant");
    setWorkspacePaletteStatus(`「${query}」に一致するワークツリーはありません。`, "empty");
  } else {
    setActiveWorkspaceResult(0, false);
    setWorkspacePaletteStatus(`${workspacePaletteState.matches.length} 件のワークツリー`, "ready");
  }
}

function setWorkspacePaletteStatus(message, state) {
  workspacePaletteStatus.textContent = message;
  workspacePaletteStatus.dataset.state = state;
}

function setActiveWorkspaceResult(index, scroll = true) {
  if (!workspacePaletteInput || !workspacePaletteResults || !workspacePaletteState.matches.length || !Number.isFinite(index)) return;
  workspacePaletteState.activeIndex = (index + workspacePaletteState.matches.length) % workspacePaletteState.matches.length;
  for (const [optionIndex, option] of [...workspacePaletteResults.children].entries()) {
    const selected = optionIndex === workspacePaletteState.activeIndex;
    option.classList.toggle("is-active", selected);
    option.setAttribute("aria-selected", String(selected));
    if (selected && scroll) option.scrollIntoView({ block: "nearest" });
  }
  workspacePaletteInput.setAttribute("aria-activedescendant", `mdv-workspace-option-${workspacePaletteState.activeIndex}`);
}

function moveWorkspaceSelection(direction) {
  if (!workspacePaletteState.matches.length) return;
  setActiveWorkspaceResult(workspacePaletteState.activeIndex + direction);
}

function openSelectedWorkspace() {
  const entry = workspacePaletteState.matches[workspacePaletteState.activeIndex];
  if (entry?.href) navigateToReaderHref(entry.href);
}

function rankWorkspaces(entries, query) {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  return entries.map((entry, index) => {
    if (!terms.length) return { entry, score: 0, index };
    let score = 0;
    for (const term of terms) {
      const fieldScore = Math.max(
        fuzzyFieldScore(entry.worktree, term, 100),
        fuzzyFieldScore(entry.repo, term, 80),
        fuzzyFieldScore(entry.branch, term, 60),
      );
      if (!Number.isFinite(fieldScore)) return { entry, score: Number.NEGATIVE_INFINITY };
      score += fieldScore;
    }
    if (entry.current) score += 4;
    return { entry, score, index };
  }).filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => compareUpdatedAt(left.entry, right.entry) || right.score - left.score || left.index - right.index)
    .map(({ entry }) => entry);
}

function normalizeWorkspaceFiles(payload) {
  const values = Array.isArray(payload?.files) ? payload.files : [];
  return values.map((value, index) => normalizeWorkspaceFile(value, index)).filter(Boolean);
}

function normalizeWorkspaceFile(value, index) {
  if (!value || typeof value !== "object" || typeof value.href !== "string" || !value.href) return null;
  const href = safeReaderHref(value.href);
  if (!href) return null;
  const relativePath = stringValue(value.relativePath);
  const slashIndex = relativePath.lastIndexOf("/");
  const entry = {
    title: stringValue(value.title) || filenameTitle(relativePath) || `Document ${index + 1}`,
    relativePath,
    directory: slashIndex >= 0 ? relativePath.slice(0, slashIndex) : "",
    documentId: stringValue(value.documentId),
    changeKind: ["added", "modified", "deleted"].includes(value.changeKind) ? value.changeKind : null,
    updatedAt: timestampValue(value.updatedAt),
    href,
    index,
  };
  entry.current = entry.documentId === documentId;
  return entry;
}

function rankCatalog(entries, query) {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  return entries.map((entry) => {
    if (!terms.length) return { entry, score: 0 };
    let score = 0;
    for (const term of terms) {
      const fieldScore = Math.max(
        fuzzyFieldScore(entry.title, term, 80),
        fuzzyFieldScore(entry.relativePath, term, 60),
        fuzzyFieldScore(entry.directory, term, 45),
      );
      if (!Number.isFinite(fieldScore)) return { entry, score: Number.NEGATIVE_INFINITY };
      score += fieldScore;
    }
    if (entry.current) score += 4;
    return { entry, score };
  }).filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => compareUpdatedAt(left.entry, right.entry) || right.score - left.score || left.entry.index - right.entry.index)
    .map(({ entry }) => entry);
}

function compareUpdatedAt(left, right) {
  return (right.updatedAt || Number.NEGATIVE_INFINITY) - (left.updatedAt || Number.NEGATIVE_INFINITY);
}

function fuzzyFieldScore(value, term, weight) {
  const field = normalizeSearchText(value);
  if (!field) return Number.NEGATIVE_INFINITY;
  if (field === term) return weight + 120;
  if (field.startsWith(term)) return weight + 92 - Math.min(field.length - term.length, 24) * 0.15;
  const substringIndex = field.indexOf(term);
  if (substringIndex >= 0) return weight + 70 - Math.min(substringIndex, 40) * 0.4;

  let fieldIndex = 0;
  let previousMatch = -2;
  let score = weight + 26;
  for (const character of term) {
    const match = field.indexOf(character, fieldIndex);
    if (match < 0) return Number.NEGATIVE_INFINITY;
    score += match === previousMatch + 1 ? 4 : -Math.min(match - fieldIndex, 6);
    previousMatch = match;
    fieldIndex = match + 1;
  }
  return score - Math.min(field.length - term.length, 60) * 0.12;
}

function normalizeSearchText(value) {
  return stringValue(value).normalize("NFKC").toLocaleLowerCase("ja");
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function timestampValue(value) {
  const timestamp = Date.parse(stringValue(value));
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function filenameTitle(relativePath) {
  const name = relativePath.split("/").pop() ?? "";
  return name.replace(/\.(?:md|markdown)$/i, "");
}

function safeReaderHref(value) {
  try {
    const url = new URL(value, location.origin);
    const workspaceDocument = /^\/__mdview\/workspaces\/[a-f0-9]{24}\/revisions\/[a-f0-9]{24}\/files\/[a-f0-9]{24}$/.test(url.pathname);
    const searchKeys = [...url.searchParams.keys()];
    const safeLineage = searchKeys.length === 0 || (
      searchKeys.length === 1
      && searchKeys[0] === "lineage"
      && /^[a-f0-9]{24}$/.test(url.searchParams.get("lineage") || "")
    );
    if (url.origin !== location.origin || !safeLineage || url.hash || (!url.pathname.startsWith("/documents/") && !workspaceDocument)) return "";
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

function trapPaletteFocus(overlay, event) {
  if (!overlay) return;
  const focusable = [...overlay.querySelectorAll("input, button:not([disabled])")].filter((element) => !element.hidden);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function loadWorkspaceContext() {
  try {
    await ensureWorkspaceDetails();
  } catch (error) {
    if (workspaceFilesStatus) workspaceFilesStatus.textContent = "ワークツリーのファイルを読み込めませんでした";
    console.error("mdview: workspace context fetch failed", error);
    loadHistory();
  }
}

async function ensureWorkspaceDetails(signal) {
  if (workspaceState.payload) return workspaceState.payload;
  if (!workspaceId || !workspaceRevisionId) throw new Error("This document has no workspace revision.");
  if (workspaceState.loading) return workspaceState.loading;
  const params = new URLSearchParams({ revision: workspaceRevisionId });
  if (documentId) params.set("document", documentId);
  if (lineageWorkspaceId) params.set("lineage", lineageWorkspaceId);
  const operation = fetch(`/__mdview/workspaces/${encodeURIComponent(workspaceId)}?${params}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  }).then(async (response) => {
    if (!response.ok) throw new Error(`workspace returned ${response.status}`);
    const payload = await response.json();
    workspaceState.payload = payload;
    workspaceState.files = normalizeWorkspaceFiles(payload);
    renderWorkspaceFiles();
    historyState.revisions = normalizeHistory(payload);
    historyState.currentIndex = historyState.revisions.findIndex((revision) => revision.id === workspaceRevisionId);
    refreshHistoryCursor();
    return payload;
  }).finally(() => {
    workspaceState.loading = null;
  });
  workspaceState.loading = operation;
  return operation;
}

async function ensureWorkspaceOptions() {
  if (workspaceState.optionsLoaded) return workspaceState.workspaces;
  if (workspaceState.optionsLoading) return workspaceState.optionsLoading;
  const operation = fetch("/__mdview/workspaces", {
    headers: { accept: "application/json" },
    cache: "no-store",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`workspaces returned ${response.status}`);
    const payload = await response.json();
    workspaceState.workspaces = Array.isArray(payload) ? payload.map(normalizeWorkspaceSummary).filter(Boolean) : [];
    workspaceState.optionsLoaded = true;
    return workspaceState.workspaces;
  }).finally(() => {
    workspaceState.optionsLoading = null;
  });
  workspaceState.optionsLoading = operation;
  return operation;
}

function normalizeWorkspaceSummary(value) {
  if (!value || typeof value !== "object" || !/^[a-f0-9]{24}$/.test(value.id)) return null;
  const href = safeReaderHref(value.href);
  if (!href) return null;
  return {
    id: value.id,
    repo: stringValue(value.repo),
    worktree: stringValue(value.worktree),
    branch: stringValue(value.branch),
    updatedAt: timestampValue(value.updatedAt || value.renderedAt),
    href,
    current: value.id === workspaceId,
  };
}

function renderWorkspaceFiles() {
  if (!workspaceFiles || !workspaceFilesStatus) return;
  workspaceFiles.replaceChildren();
  workspaceFilesStatus.hidden = workspaceState.files.length > 0;
  if (!workspaceState.files.length) {
    workspaceFilesStatus.textContent = "この時点にMarkdownはありません";
    return;
  }
  for (const entry of workspaceState.files) {
    const link = document.createElement("a");
    link.href = entry.href;
    link.className = "mdv-workspace-file";
    link.classList.toggle("is-current", entry.current);
    link.classList.toggle("is-deleted", entry.changeKind === "deleted");
    if (entry.current) link.setAttribute("aria-current", "page");
    if (entry.changeKind) link.dataset.changeKind = entry.changeKind;
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const path = document.createElement("span");
    path.textContent = entry.relativePath;
    link.append(title, path);
    if (entry.changeKind) {
      const status = document.createElement("em");
      status.className = "mdv-workspace-file-status";
      status.textContent = changeKindLabel(entry.changeKind);
      link.append(status);
    }
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigateToReaderHref(entry.href);
    });
    workspaceFiles.append(link);
  }
}

function changeKindLabel(changeKind) {
  return changeKind === "added" ? "追加" : changeKind === "deleted" ? "削除" : "変更";
}

function navigateToReaderHref(href) {
  const destination = new URL(href, location.origin);
  destination.searchParams.set("view", app.dataset.view);
  location.assign(`${destination.pathname}${destination.search}`);
}

async function loadHistory() {
  const status = document.querySelector("[data-history-status]");
  if (!documentId || !revisionId || historyState.loading) {
    if (status) {
      status.textContent = "履歴はありません";
      refreshSessionTitle(status, "");
    }
    return;
  }
  historyState.loading = true;
  try {
    const response = await fetch(`/__mdview/history/${encodeURIComponent(documentId)}?revision=${encodeURIComponent(revisionId)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`history returned ${response.status}`);
    const payload = await response.json();
    historyState.revisions = normalizeHistory(payload);
    historyState.currentIndex = historyState.revisions.findIndex((revision) => revision.id === revisionId);
    if (historyState.currentIndex < 0) {
      historyState.currentIndex = historyState.revisions.findIndex((revision) => revision.href === location.pathname);
    }
    refreshHistoryCursor();
  } catch (error) {
    historyState.revisions = [];
    historyState.currentIndex = -1;
    if (status) {
      status.textContent = "履歴を読み込めませんでした";
      refreshSessionTitle(status, "");
    }
    console.error("mdview: history fetch failed", error);
  } finally {
    historyState.loading = false;
  }
}

function normalizeHistory(payload) {
  if (!Array.isArray(payload?.revisions)) return [];
  return payload.revisions.map((value) => {
    if (!value || typeof value !== "object" || !/^[a-f0-9]{24}$/.test(value.id)) return null;
    const href = safeReaderHref(value.href);
    if (!href || !Number.isFinite(Date.parse(value.renderedAt))) return null;
    return {
      id: value.id,
      href,
      renderedAt: value.renderedAt,
      source: stringValue(value.source),
      sessionId: stringValue(value.sessionId),
      turnId: stringValue(value.turnId),
      sessionTitle: stringValue(value.sessionTitle),
      workspaceId: stringValue(value.workspaceId),
      worktree: stringValue(value.worktree),
      branch: stringValue(value.branch),
      imported: value.imported === true,
      lineageReason: value.lineageReason === "snapshot-match" ? "snapshot-match" : value.lineageReason === "git-ancestry" ? "git-ancestry" : "",
    };
  }).filter(Boolean);
}

function refreshHistoryCursor() {
  const previous = document.querySelector('[data-action="previous-revision"]');
  const next = document.querySelector('[data-action="next-revision"]');
  const status = document.querySelector("[data-history-status]");
  const current = historyState.revisions[historyState.currentIndex];
  previous.disabled = historyState.currentIndex <= 0;
  next.disabled = historyState.currentIndex < 0 || historyState.currentIndex >= historyState.revisions.length - 1;
  if (!status) return;
  if (!current) {
    status.textContent = "履歴はありません";
    refreshSessionTitle(status, "");
    return;
  }
  const source = current.source === "hook" || current.source === "codex-hook"
    ? "Codex"
    : current.source === "repository-sync" ? "Git" : "手動";
  status.replaceChildren();
  const position = document.createElement("strong");
  position.textContent = `${historyState.currentIndex + 1} / ${historyState.revisions.length}`;
  const detail = document.createElement("span");
  detail.className = "mdv-history-detail";
  const time = document.createElement("time");
  time.dateTime = current.renderedAt;
  time.textContent = formatHistoryTimestamp(current.renderedAt);
  detail.append(document.createTextNode(" · "), time, document.createTextNode(` · ${source}`));
  if (current.imported) {
    const provenanceLabel = current.lineageReason === "snapshot-match" ? "推定マージ元" : "マージ元";
    detail.append(document.createTextNode(` · ${provenanceLabel} ${current.worktree || "worktree"}`));
  }
  const warningCount = Array.isArray(workspaceState.payload?.lineageWarnings)
    ? workspaceState.payload.lineageWarnings.length
    : 0;
  if (warningCount > 0) detail.append(document.createTextNode(` · マージ元履歴 ${warningCount}件未読込`));
  status.append(position, detail);
  refreshSessionTitle(status, current.sessionTitle);
}

function refreshSessionTitle(status, value) {
  let context = status.closest(".mdv-history-context");
  if (!context) {
    context = document.createElement("div");
    context.className = "mdv-history-context";
    status.before(context);
    context.append(status);
  }
  let title = context.querySelector(".mdv-session-title");
  if (!value) {
    title?.remove();
    return;
  }
  if (!title) {
    title = document.createElement("span");
    title.className = "mdv-session-title";
    context.prepend(title);
  }
  title.replaceChildren(sessionTitleIcon(), document.createTextNode(value));
  title.title = `Codexセッションの現在名: ${value}`;
}

function sessionTitleIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("mdv-icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#icon-chat-round-dots-linear");
  svg.append(use);
  return svg;
}

function navigateRevision(direction) {
  const target = historyState.revisions[historyState.currentIndex + direction];
  if (!target) {
    showToast(historyState.loading ? "履歴を読み込んでいます" : direction < 0 ? "これが最初の作業です" : "これが最新の作業です");
    return;
  }
  const headingId = currentHeadingId();
  const scrollRange = Math.max(document.documentElement.scrollHeight - innerHeight, 1);
  sessionStorage.setItem(`mdview:history-navigation:${documentId}`, JSON.stringify({
    view: app.dataset.view,
    scrollRatio: scrollY / scrollRange,
    headingId,
  }));
  const destination = new URL(target.href, location.origin);
  destination.searchParams.set("view", app.dataset.view);
  if (headingId) destination.hash = headingId;
  location.assign(`${destination.pathname}${destination.search}${destination.hash}`);
}

function currentHeadingId() {
  let current = "";
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top > 130) break;
    current = heading.id;
  }
  return current;
}

function restoreRevisionNavigation() {
  if (!documentId) return;
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(`mdview:history-navigation:${documentId}`) || "null");
  } catch {
    return;
  }
  if (!saved || typeof saved !== "object") return;
  if (["read", "changes"].includes(saved.view)) setView(saved.view);
  if (!location.hash && Number.isFinite(saved.scrollRatio)) {
    requestAnimationFrame(() => {
      const scrollRange = Math.max(document.documentElement.scrollHeight - innerHeight, 0);
      scrollTo({ top: scrollRange * Math.min(Math.max(saved.scrollRatio, 0), 1) });
    });
  }
}

function restoreRequestedView() {
  const requested = new URLSearchParams(location.search).get("view");
  if (["read", "changes"].includes(requested)) setView(requested);
}

function formatHistoryTimestamp(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function applySetting(name, value, persist = true) {
  const property = name === "measure" ? "--mdv-measure" : "--mdv-font-size";
  const unit = name === "measure" ? "ch" : "px";
  document.documentElement.style.setProperty(property, `${value}${unit}`);
  if (persist) localStorage.setItem(`${storageKey}:${name}`, value);
}

function restorePreferences() {
  for (const input of document.querySelectorAll("[data-setting]")) {
    const saved = localStorage.getItem(`${storageKey}:${input.dataset.setting}`);
    if (saved) {
      input.value = saved;
      applySetting(input.dataset.setting, saved, false);
    }
  }
}

function observeHeadings() {
  if (!headings.length) return;
  let scheduled = false;
  const update = () => {
    scheduled = false;
    const marker = 110;
    const active = [...headings].reverse().find((heading) => heading.getBoundingClientRect().top <= marker) || headings[0];
    const id = active.id;
    for (const link of tocLinks) {
      const targetId = decodeURIComponent(link.hash.slice(1));
      link.classList.toggle("active", targetId === id);
    }
  };
  document.addEventListener("scroll", () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  }, { passive: true });
  update();
}

async function renderDiagrams() {
  const mermaid = window.mermaid;
  if (!mermaid) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    themeVariables: {
      background: "#171817",
      primaryColor: "#1c1d1c",
      primaryTextColor: "#e9e6df",
      primaryBorderColor: "#54d7ef",
      lineColor: "#949690",
      secondaryColor: "#262825",
      tertiaryColor: "#121312",
    },
  });

  let index = 0;
  for (const stage of document.querySelectorAll(".mdv-diagram-stage")) {
    if (stage.closest(".mdv-diagram")?.dataset.engine !== "mermaid") continue;
    try {
      const source = decodeBase64(stage.dataset.diagramSource);
      const { svg } = await mermaid.render(`mdview-diagram-${index}`, source);
      stage.innerHTML = svg;
    } catch (error) {
      stage.innerHTML = `<p class="mdv-diagram-error">図を描画できませんでした。ソースを確認してください。</p>`;
      console.error("mdview: Mermaid render failed", error);
    }
    index += 1;
  }
}

function decodeBase64(value) {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

let toastTimer;
function showToast(message) {
  const toast = document.querySelector(".mdv-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}
