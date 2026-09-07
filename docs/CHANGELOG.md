# Changelog

## Unreleased

Canvas readability and daily-driver ergonomics on top of v0.1.0.

### Highlights

- **Active path highlight** — selecting a turn lights up the whole lineage from the story's root to that card (edges included); everything else dims. Branch-heavy canvases now answer "which line am I on".
- **Turn navigation** — ‹ › buttons in the right pane (or ←/→ keys) walk between turns without returning to the canvas; typing in an input never triggers them.
- **Turn stats** — cards and the pane header show each turn's wall time and output tokens, mapped from opencode's per-message `tokens` usage (no extra requests).
- **Smarter empty-prompt titles** — "(empty prompt)" cards fall back to the turn's first tool name, else the reply's first line.
- **Clone current branch** — one click forks the selected session at its latest state (a checkpoint), landing you in the copy.
- **Rename sessions** — right-click a sidebar row to rename; calls opencode's native `PATCH /session/{id}` through the adapter protocol.
- **Searchable model picker** — the native select became a combobox with search (70+ models); the right-pane composer also gained a per-session model picker that rides along with prompts.
- **Resizable shell** — drag the handles between columns to resize the sidebar and pane; double-click a handle to fold/unfold. Widths persist in localStorage.
- **Canvas minimap** — working sets beyond the overview threshold get a minimap with a live viewport rectangle; click or drag it to pan.
- **Command palette** — ⌘K / Ctrl+K (or the topbar button) to jump between sessions and fire actions (fit view, clone, refresh, fold panels).

## v0.1.0

First release. Non-linear session workbench for opencode with node-level forking.

### Highlights

- **Fork any turn** — every user message has a "fork here" action; the new session keeps that full turn (question + answer), original untouched. Backed by opencode's native fork API (`POST /session/{id}/fork`), translated from its exclusive-cut semantics.
- **Session tree** — navigator groups all opencode sessions by project directory; forks nest under their parent via awefork's lineage sidecar; agent-spawned subagent sessions are hidden by default. Sessions are aggregated across every opencode project (`GET /project` + per-directory `GET /session?directory=`), not just the server's cwd, and fetched past the API's default 100-session page.
- **Continue in place** — send messages to the active session from awefork with live streaming (SSE `/event` normalized to a small event union), plus abort.
- **Server lifecycle** — reuses a running `opencode serve` on 127.0.0.1:4096 or spawns one as a child process, killed on quit. Spawned from the packaged app, PATH is extended with the user-level bin dirs (deskclaw, homebrew, ~/.local/bin, bun, ~/.opencode) so `opencode` resolves, and the child runs from the home directory.
- **AgentAdapter protocol** — `src/shared/types.ts` defines the multi-agent contract (listSessions / messages / fork / prompt / abort / subscribe); opencode is the first implementation, pi / Claude Code / Codex are planned.
- **Tested against a fake opencode server** — endpoint semantics (exclusive-cut fork, prompt_async, SSE) verified against a real opencode 1.18 instance and mirrored in `node:http` fakes.
- **macOS packaging** — `npm run dist` builds an unsigned arm64 dmg via electron-builder.
