# mdview Design QA

## Evidence

- Source visual truth: `/Users/kazuhideoki/.codex/generated_images/019ff97d-dd43-7220-8bf8-6e9e8dba0fb5/exec-53754f4c-36db-41fb-8a9d-dd1c5c365b53.png`
- Browser-rendered implementation: `implementation-desktop-1487x1058.png`
- Full-view comparison: `design-comparison-final.png` (source on the left, implementation on the right)
- Search-palette implementation: `implementation-search-palette-1487x1058.png`
- Search-palette comparison: `design-comparison-search-palette.png` (the selected Editorial Focus source on the left, the extended search state on the right)
- Mobile evidence: `implementation-mobile.png`
- Mobile search-palette evidence: `implementation-search-palette-mobile.png` at 390 x 844 CSS px and 1x density
- Preview route: `http://127.0.0.1:43193/documents/f0d65e5a6e021ceb/doc/coding-guidelines.md.html`
- State: dark theme, Read tab, document search palette open, current document selected
- Viewport: source and normalized implementation are both 1487 x 1058 CSS px
- Pixels and density: source 1487 x 1058 pixels at 1x; Brave initially captured 2784 x 1588 pixels at a 2784 x 1588 CSS viewport; the final implementation was captured through a 1487 x 1058 iframe and cropped to an equal 1487 x 1058 pixel comparison target.

## Findings

No actionable P0, P1, or P2 findings remain.

- Fonts and typography: the implementation uses the same macOS Japanese sans-serif character and warm near-white hierarchy. Heading weight, paragraph leading, code monospace, and numbered code lines retain the mock's editorial density. The exact rasterized glyph shapes vary slightly because the source is an ImageGen mock.
- Spacing and layout rhythm: fixed 294 px TOC, sticky 60 px context bar, persistent review footer, left reading rail, prose measure, and expanded code/table blocks reproduce the source's structure. Section rhythm was tightened after the first comparison so the code and table remain above the footer at the target viewport.
- Search extension: the 720 px command palette preserves the source's flat graphite surfaces, one-pixel borders, compact control density, cyan selection rail, and square-leaning radii. Its centered overlay is an intentional new interaction state rather than a recreation target present in the original mock, and the underlying Editorial Focus composition remains visible for context.
- Colors and visual tokens: graphite background, subtle one-pixel dividers, cyan active state, amber modified state, muted green update status, and restrained gray text match the source. No gradients are used.
- Image quality and asset fidelity: the source contains no photographic or illustrative assets. Icons come from the Solar icon library rather than custom SVG or CSS drawings. Mermaid and D2 remain vector output.
- Copy and content: the reference repository, branch, document path, Japanese architecture content, labels, code sample, and table values are preserved. The implementation additionally exposes real Raw diff, Mermaid, and review states without changing the source screen's hierarchy.
- Accessibility and responsive behavior: semantic headings/table headers, labeled controls, focus styles, reduced-motion handling, mobile TOC reopen control, scrim dismissal, and disabled empty-change navigation are present. The mobile 390 x 844 check confirmed a closed initial TOC, visible reopen control, and working scrim close.
- Search interaction and accessibility: `Cmd+K` and `/` open the palette; `/` remains text input inside editable controls; Arrow Up/Down wrap selection; Enter opens the selected document in the same tab; Escape and backdrop close it; focus returns to the trigger. Dialog, combobox, listbox, option selection, expanded state, background inertness, empty/loading/error states, and the 390 x 844 layout were verified. The final browser console contained zero errors.

No focused region comparison was needed beyond the equal-size full-view comparison because typography, controls, code line numbering, and table borders are legible at 1487 x 1058 in `design-comparison-final.png`. The mobile state was captured separately because it has no source visual counterpart and was evaluated for layout resilience rather than source fidelity.

## Comparison History

1. First pass — blocked
   - P1: the article was too narrow and shifted right relative to the selected mock.
   - P1: the mobile TOC could not be reopened after it was closed.
   - P1: the Vite entry was blank and the real browser route was not runnable.
   - P2: CSS gradients, incorrect Iconify viewBox fallback, table `td` headers, duplicate heading IDs, and line-count/navigation-count drift.
   - Fixes: aligned the article near the sidebar while letting code/tables expand; kept the mobile TOC button visible; completed renderer/server/client routes; removed gradients; corrected Iconify sizing; rendered `th scope="col"`; deduplicated slugs; derived the footer from navigable changed blocks.

2. Second pass — blocked
   - P2: heading and content vertical rhythm left less of the table above the fixed footer than the source.
   - P2: code blocks lacked the mock's line numbers.
   - P2: TOC scroll following relied on an unsupported IntersectionObserver in the connected Brave surface.
   - Fixes: tightened heading and intro margins; added CSS line numbering to Shiki output; replaced the observer with requestAnimationFrame-throttled scroll tracking and decoded Japanese anchors.

3. Final pass — passed
   - `design-comparison-final.png` confirms the same major composition, hierarchy, tokens, code/table treatment, and persistent controls.
   - Browser checks confirmed Read / Changes / Raw diff, TOC following, next change, mark read, settings, code collapse, Mermaid rendering, mobile TOC/scrim, and zero console errors.

4. Search-reference pass — passed
   - Added the cross-document command palette without changing the selected Editorial Focus layout or visual tokens.
   - `design-comparison-search-palette.png` confirms that the new overlay retains the established typography, color, border, radius, density, and icon language.
   - Browser checks confirmed automatic `?palette=1` opening, query removal, three live catalog results, Japanese multi-term fuzzy search, current-document marking, keyboard and mouse navigation, same-tab opening, focus restoration, mobile fit without horizontal overflow, and zero console errors.

## Follow-up Polish

- P3: a future auto-reload channel could update an already-open tab instead of opening the same document again after a later Codex turn.

final result: passed
