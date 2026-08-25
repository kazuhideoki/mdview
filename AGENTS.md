# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

## Pull Requests

PR descriptions must explain context and intent that cannot be recovered reliably from the code or diff alone.

Include:

- the user or system problem that motivated the change
- the intended behavior and design constraints
- important alternatives considered or deliberately rejected
- non-goals and boundaries of the change
- validation performed and any remaining uncertainty

Do not merely restate the diff. Preserve durable architectural or product decisions in repository documentation and link them from the PR.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

In the reading view, preserve Markdown's structural markers such as list bullets and present the document as ordinary reading material. Do not show change-state accents, markers, labels, timeline dots, or decorative `H` badges; keep change indicators in Changes view.

Treat the selected worktree as the primary browsing scope. Select or fix the worktree before file search, and limit the sidebar and file search results to Markdown in that worktree; do not mix same-named files from other worktrees into those results.

Expose only `Read` and `Changes` as reader view modes. Do not add a user-facing raw/row diff view or shortcut.

Use `Cmd+Shift+K` for a dedicated worktree selection palette. Keep `Cmd+K` and `/` scoped to Markdown search inside the selected worktree.

In the reading view, navigate worktree-wide Codex turn revisions instead of jumping between changed blocks. Use `N` for the next worktree revision and `P` for the previous worktree revision, preserve the selected file when it exists at the destination, and use a restrained history cursor that helps readers follow Codex editing history.

When work from another worktree is merged into a destination such as the main workspace, preserve the destination's linear history while making the merged worktree's session revisions traversable at the merge point. Keep each worktree history as the source of truth and store merge provenance as references rather than copying revisions. `P` from the destination merge revision should enter the merged worktree history, and `N` should return to the destination. Require Markdown snapshot compatibility before importing history; use Git ancestry to confirm provenance or disambiguate identical candidates, and use exact Markdown snapshot-delta matching only as an unambiguous fallback. Do not silently splice unrelated worktrees or cross-repository references into the lineage. If a referenced history is missing, corrupt, or unverifiable, preserve the readable destination lineage and surface a warning.

In the reading view header, show only stable document-location context: repository, worktree, branch, and Markdown path. Show the current name of the Codex session associated with the displayed revision beside its N/P history controls; it is a session identifier, not a historical label captured when that revision was created. Resolve it by the revision's session ID rather than guessing from the worktree; prefer the latest matching `session_index.jsonl` `thread_name`, then fall back to the Codex state database. Omit it for manual renders. Reflect later Codex title changes when the revision is viewed again, including when saved HTML is used as a rendering fallback. For detached worktrees, show the short commit SHA with the detached state.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

開発時にサーバーを起動するときは既存のサーバーのポートと競合しないように確認すること。

Treat `src/cli.mjs`, exposed as the package bin `mdview`, as the production-data CLI. Repository `npm run` development commands must use a separate development cache, runtime, and port; test commands must use a fresh temporary environment for each run. Do not let a development or test command fall back to the production mdview data directories or daemon port.
