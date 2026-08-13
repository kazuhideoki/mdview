const app = document.querySelector(".mdv-app");
const rawDiff = document.querySelector(".mdv-raw-diff");
const headings = [...document.querySelectorAll('.mdv-heading[id]:not([data-diff-kind="removed"])')];
const tocLinks = [...document.querySelectorAll(".mdv-toc a")];
const documentId = app?.dataset.documentId || "";
const revisionId = app?.dataset.revisionId || "";
const storageKey = documentId ? `mdview:document:${documentId}` : `mdview:${location.pathname}`;
const searchOverlay = document.querySelector("[data-search-overlay]");
const searchInput = document.querySelector("#mdv-search-input");
const searchResults = document.querySelector("#mdv-search-results");
const searchStatus = document.querySelector("#mdv-search-status");
const searchState = {
  entries: [],
  matches: [],
  activeIndex: -1,
  controller: null,
  restoreFocus: null,
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

if (matchMedia("(max-width: 760px)").matches) app?.classList.add("toc-hidden");
syncTocState();
restorePreferences();
restoreRevisionNavigation();
restoreRequestedView();
observeHeadings();
renderDiagrams();
loadHistory();

function setView(view) {
  app.dataset.view = view;
  rawDiff.hidden = view !== "raw";
  for (const button of document.querySelectorAll("[data-view-target]")) {
    button.setAttribute("aria-pressed", String(button.dataset.viewTarget === view));
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
    case "previous-revision":
      navigateRevision(-1);
      break;
    case "next-revision":
      navigateRevision(1);
      break;
    case "mark-read":
      app.classList.toggle("is-read");
      localStorage.setItem(`${storageKey}:read`, String(app.classList.contains("is-read")));
      showToast(app.classList.contains("is-read") ? "変更を既読にしました" : "未読に戻しました");
      break;
    case "toggle-code": {
      const figure = button.closest(".mdv-code");
      figure.classList.toggle("collapsed");
      button.textContent = figure.classList.contains("collapsed") ? "展開する" : "折りたたむ";
      break;
    }
    case "copy-code": {
      const code = button.closest(".mdv-code")?.querySelector("pre code")?.textContent ?? "";
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

document.addEventListener("keydown", (event) => {
  const commandSearch = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k";
  if (commandSearch) {
    event.preventDefault();
    if (isSearchOpen()) closeSearch();
    else openSearch();
    return;
  }

  if (isSearchOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSearchSelection(event.key === "ArrowDown" ? 1 : -1);
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
    if (event.key === "Tab") trapSearchFocus(event);
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

  const viewShortcuts = { r: "read", c: "changes", d: "raw" };
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
  setSearchBackgroundInert(true);
  document.body.classList.add("mdv-search-open");
  searchInput.setAttribute("aria-expanded", "true");
  syncSearchTriggerState(true);
  searchInput.value = "";
  searchState.entries = [];
  searchState.matches = [];
  searchState.activeIndex = -1;
  searchResults.replaceChildren();
  setSearchStatus("文書を読み込んでいます…", "loading");
  requestAnimationFrame(() => searchInput.focus());

  searchState.controller?.abort();
  const controller = new AbortController();
  searchState.controller = controller;
  try {
    const response = await fetch("/__mdview/catalog", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`catalog returned ${response.status}`);
    const payload = await response.json();
    if (controller !== searchState.controller || !isSearchOpen()) return;
    searchState.entries = normalizeCatalog(payload);
    updateSearchResults();
  } catch (error) {
    if (error.name === "AbortError" || controller !== searchState.controller) return;
    searchState.entries = [];
    searchState.matches = [];
    searchState.activeIndex = -1;
    searchResults.replaceChildren();
    setSearchStatus("文書一覧を読み込めませんでした。検索を閉じて、もう一度お試しください。", "error");
    console.error("mdview: catalog fetch failed", error);
  }
}

function closeSearch() {
  if (!searchOverlay || searchOverlay.hidden) return;
  searchState.controller?.abort();
  searchState.controller = null;
  searchOverlay.hidden = true;
  setSearchBackgroundInert(false);
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

function setSearchBackgroundInert(inert) {
  if (!app || !searchOverlay) return;
  for (const child of app.children) {
    if (child !== searchOverlay) child.inert = inert;
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
    const repository = document.createElement("span");
    repository.textContent = entry.repo;
    const branch = document.createElement("span");
    branch.textContent = entry.branch;
    context.append(repository, branch);
    if (entry.renderedAt) {
      const renderedAt = document.createElement("time");
      renderedAt.dateTime = entry.renderedAt;
      renderedAt.textContent = formatRenderedAt(entry.renderedAt);
      context.append(renderedAt);
    }
    if (entry.current) {
      const current = document.createElement("span");
      current.className = "mdv-search-current";
      current.textContent = "現在";
      context.append(current);
    }
    option.append(main, context);
    searchResults.append(option);
  }

  if (!searchState.entries.length) {
    searchState.activeIndex = -1;
    searchInput.removeAttribute("aria-activedescendant");
    setSearchStatus("閲覧できる文書はまだありません。", "empty");
  } else if (!searchState.matches.length) {
    searchState.activeIndex = -1;
    searchInput.removeAttribute("aria-activedescendant");
    setSearchStatus(`「${query}」に一致する文書はありません。`, "empty");
  } else {
    const currentIndex = query ? 0 : searchState.matches.findIndex((entry) => entry.current);
    setActiveSearchResult(currentIndex >= 0 ? currentIndex : 0, false);
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

function openSelectedSearchResult() {
  const entry = searchState.matches[searchState.activeIndex];
  if (entry?.href) location.assign(entry.href);
}

function normalizeCatalog(payload) {
  const values = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.entries)
      ? payload.entries
      : Array.isArray(payload?.documents)
        ? payload.documents
        : [];
  return values.map((value, index) => normalizeCatalogEntry(value, index)).filter(Boolean);
}

function normalizeCatalogEntry(value, index) {
  if (!value || typeof value !== "object" || typeof value.href !== "string" || !value.href) return null;
  const href = safeCatalogHref(value.href);
  if (!href) return null;
  const relativePath = stringValue(value.relativePath ?? value.path);
  const entry = {
    title: stringValue(value.title) || filenameTitle(relativePath) || `Document ${index + 1}`,
    repo: stringValue(value.repo),
    branch: stringValue(value.branch),
    relativePath,
    sourcePath: stringValue(value.sourcePath ?? value.absolutePath),
    source: stringValue(value.source),
    renderedAt: stringValue(value.renderedAt),
    href,
    index,
  };
  entry.current = isCurrentCatalogEntry(entry);
  return entry;
}

function rankCatalog(entries, query) {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  return entries.map((entry) => {
    if (!terms.length) return { entry, score: entry.current ? 1_000 : -entry.index };
    let score = 0;
    for (const term of terms) {
      const fieldScore = Math.max(
        fuzzyFieldScore(entry.title, term, 80),
        fuzzyFieldScore(entry.relativePath, term, 60),
        fuzzyFieldScore(entry.repo, term, 45),
        fuzzyFieldScore(entry.branch, term, 35),
      );
      if (!Number.isFinite(fieldScore)) return { entry, score: Number.NEGATIVE_INFINITY };
      score += fieldScore;
    }
    if (entry.current) score += 4;
    return { entry, score };
  }).filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score || left.entry.index - right.entry.index)
    .map(({ entry }) => entry);
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

function isCurrentCatalogEntry(entry) {
  const currentSource = normalizePath(app?.dataset.currentSource);
  if (currentSource && normalizePath(entry.sourcePath) === currentSource) return true;
  const sameContext = entry.repo === stringValue(app?.dataset.currentRepo)
    && entry.branch === stringValue(app?.dataset.currentBranch)
    && normalizePath(entry.relativePath) === normalizePath(app?.dataset.currentRelativePath);
  if (sameContext) return true;
  try {
    return new URL(entry.href, location.href).pathname === location.pathname;
  } catch {
    return false;
  }
}

function normalizeSearchText(value) {
  return stringValue(value).normalize("NFKC").toLocaleLowerCase("ja");
}

function normalizePath(value) {
  let path = stringValue(value);
  try { path = decodeURIComponent(path); } catch { /* Keep the encoded value. */ }
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function filenameTitle(relativePath) {
  const name = relativePath.split("/").pop() ?? "";
  return name.replace(/\.(?:md|markdown)$/i, "");
}

function formatRenderedAt(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}分前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}時間前`;
  return new Intl.DateTimeFormat("ja-JP", {
    month: "short",
    day: "numeric",
    ...(new Date(timestamp).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  }).format(timestamp);
}

function safeCatalogHref(value) {
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || url.search || url.hash || !url.pathname.startsWith("/documents/")) return "";
    return url.pathname;
  } catch {
    return "";
  }
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

function trapSearchFocus(event) {
  const focusable = [...searchOverlay.querySelectorAll("input, button:not([disabled])")].filter((element) => !element.hidden);
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

async function loadHistory() {
  const status = document.querySelector("[data-history-status]");
  if (!documentId || !revisionId || historyState.loading) {
    if (status) status.textContent = "履歴はありません";
    return;
  }
  historyState.loading = true;
  try {
    const response = await fetch(`/__mdview/history/${encodeURIComponent(documentId)}`, {
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
    if (status) status.textContent = "履歴を読み込めませんでした";
    console.error("mdview: history fetch failed", error);
  } finally {
    historyState.loading = false;
  }
}

function normalizeHistory(payload) {
  if (!Array.isArray(payload?.revisions)) return [];
  return payload.revisions.map((value) => {
    if (!value || typeof value !== "object" || !/^[a-f0-9]{24}$/.test(value.id)) return null;
    const href = safeCatalogHref(value.href);
    if (!href || !Number.isFinite(Date.parse(value.renderedAt))) return null;
    return {
      id: value.id,
      href,
      renderedAt: value.renderedAt,
      source: stringValue(value.source),
      sessionId: stringValue(value.sessionId),
      turnId: stringValue(value.turnId),
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
    return;
  }
  const source = current.source === "hook" || current.source === "codex-hook" ? "Codex" : "手動";
  status.replaceChildren();
  const position = document.createElement("strong");
  position.textContent = `${historyState.currentIndex + 1} / ${historyState.revisions.length}`;
  const detail = document.createElement("span");
  detail.className = "mdv-history-detail";
  const time = document.createElement("time");
  time.dateTime = current.renderedAt;
  time.textContent = formatHistoryTimestamp(current.renderedAt);
  detail.append(document.createTextNode(" · "), time, document.createTextNode(` · ${source}`));
  status.append(position, detail);
}

function navigateRevision(direction) {
  const target = historyState.revisions[historyState.currentIndex + direction];
  if (!target) {
    showToast(historyState.loading ? "履歴を読み込んでいます" : direction < 0 ? "これが最初の版です" : "これが最新の版です");
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
  if (["read", "changes", "raw"].includes(saved.view)) setView(saved.view);
  if (!location.hash && Number.isFinite(saved.scrollRatio)) {
    requestAnimationFrame(() => {
      const scrollRange = Math.max(document.documentElement.scrollHeight - innerHeight, 0);
      scrollTo({ top: scrollRange * Math.min(Math.max(saved.scrollRatio, 0), 1) });
    });
  }
}

function restoreRequestedView() {
  const requested = new URLSearchParams(location.search).get("view");
  if (["read", "changes", "raw"].includes(requested)) setView(requested);
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
  app.classList.toggle("is-read", localStorage.getItem(`${storageKey}:read`) === "true");
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
