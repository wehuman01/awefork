# Changelog

## v0.1.5

Archive what you set aside, retry what failed, and richer turns — plus awefork's first real app icon.

### Highlights

- **Archive** — right-click a session row to archive it, or a directory to archive the whole project. Archived items hide from every view (search, palette, canvas included) and restore from the archive section at the sidebar's bottom. Sessions created under an archived directory stay hidden until the directory comes back; archived state lives in a crash-safe `archive.json` sidecar.
- **Retry failed turns** — the ↻ on a failed turn (card or pane header) reopens its prompt prefilled with the original text and model; edit and resend. Mid-story turns retry as a fresh fork, so the failed original stays untouched.
- **Image attachments** — paste or drop images into either composer (capability-gated per model); sent rows carry 📎 chips.
- **Thinking effort variants** — pick the run's reasoning variant (minimal/low/medium/high…) next to the model; canvas cards show `model · variant` for what each turn actually used.
- **Markdown replies** — assistant replies render through a safe markdown pipeline (parser → vnodes, no HTML injection): headings, lists, code blocks with copy buttons, and shell-safe external links opened through a native IPC channel.
- **App icon & branding** — a peach-soda squircle: a cream branch that forks into butter and lavender candy nodes, built from the app's own theme palette. Ships as the packaged `icon.icns`, the dev-mode Dock icon, the topbar logo, the favicon, and the README logo.

### Install

`npm run dist` builds an unsigned arm64 dmg. On first launch, right-click the app and choose Open (or clear the quarantine flag with `xattr -d com.apple.quarantine /Applications/awefork.app`).

## v0.1.1

Canvas readability and daily-driver ergonomics on top of v0.1.0.

### Highlights

- **Canvas story search** — ⌘/Ctrl+F (or the 🔍 搜节点 pill) searches every turn on the canvas: full prompt bodies (multi-line prompts included, not just the rendered first line), reply text, tool names, and failed-run errors. Every matching card gets a butter ring (minimap dots too), and the results list shows a snippet per hit; clicking one selects and centers the turn, across sessions if needed.
- **Branch digest** — the ⑂ 分支摘要 pill lists one row per branch on the canvas: where it forked from (session + turn), its own turn count, token total, last topic, and an ⚠ for failed runs. When the canvas grows past readability, read the digest first, then click through to the branch tip.
- **Browser demo mode** — `npm run demo` serves the renderer on localhost:5180 with an in-memory fork story behind a mock adapter, so the canvas, search, and digests can be exercised without Electron or an opencode backend.
- **Context chain in the pane** — the branch-context pane now lists the turns that lead into the selected one (the same path the canvas highlights), numbered, with cross-session forks marked ⎇; click a card to jump to that turn. More than 12 ancestors collapse into an "earlier turns" note.
- **Delete from the sidebar** — right-click any session row (forks included) for 删除会话; the same undo toast guards it as the canvas delete.
- **Undo delete** — deleting a session now hides it instantly with an「已删除 · 撤销」toast; the real server delete only fires when the next operation flushes the pending queue (or the toast's 撤销 / ⌘Z cancels it first). Pending deletes persist in `trash.json` and flush on the next launch, so quitting mid-window still completes the deletion.
- **Delete stays in place** — after deleting, the selection moves to whatever session now occupies the deleted row's spot in the sidebar (next, else previous) instead of jumping back to the newest conversation.
- **Model picker scrolls** — the mouse wheel inside the searchable model list scrolls the list again instead of zooming the canvas underneath.
- **Active path highlight** — selecting a turn lights up the whole lineage from the story's root to that card (edges included); everything else dims. Branch-heavy canvases now answer "which line am I on".
- **Turn navigation** — ‹ › buttons in the right pane (or ←/→ keys) walk between turns without returning to the canvas; typing in an input never triggers them.
- **Turn stats** — cards and the pane header show each turn's wall time and output tokens, mapped from opencode's per-message `tokens` usage (no extra requests).
- **Smarter empty-prompt titles** — "(empty prompt)" cards fall back to the turn's first tool name, else the reply's first line.
- **Clone current branch** — one click forks the selected session at its latest state (a checkpoint), landing you in the copy.
- **Rename sessions** — right-click a sidebar row to rename; calls opencode's native `PATCH /session/{id}` through the adapter protocol.
- **Searchable model picker** — the native select became a combobox with search (70+ models); the right-pane composer also gained a per-session model picker that rides along with prompts.
- **Resizable shell** — drag the handles between columns to resize the sidebar and pane; double-click a handle to fold/unfold. Widths persist in localStorage.
- **Canvas minimap** — the minimap is always on while the canvas has nodes (it used to wait for a large working set), with a live viewport rectangle; click or drag it to pan.
- **Command palette** — ⌘K / Ctrl+K (or the topbar button) to jump between sessions and fire actions (fit view, clone, refresh, fold panels).

### Fixes

- **IME-safe Enter** — composing with an IME (Chinese input) no longer triggers actions: Enter confirms the candidate instead of sending a half-typed prompt, picking a palette/model item, or committing a rename; arrows and Esc during composition belong to the candidate window too.
- **Long runs stay running** — streamed deltas now count as proof of life: they keep the run state lit and reset its poll watchdog, so a run can no longer be force-settled (card flipping to「无文本回复」mid-flight) while it is still streaming, and runs whose busy frame was missed heal on the first delta.
- **Fast failure without the opencode CLI** — a failed spawn (CLI not on PATH) now surfaces its error within a second instead of idling out the 30-second startup window.
- **API requests time out** — a half-dead opencode server (port open, never responding) now fails requests after 15s with a clear message instead of hanging the UI forever. The prompt endpoint deliberately stays untimed: its response only arrives when the whole run finishes.
- **No double event stream after a window reopen** — on macOS, closing the window and reopening it from the Dock used to subscribe to opencode's `/event` a second time; both loops then delivered every event, doubling streamed text and duplicate-refreshing. The subscription now happens exactly once at startup, and the closed window's reference is dropped so events can't fire into a destroyed webContents.
- **Scroll up while streaming** — the pane used to yank back to the bottom on every streamed frame; it now follows the stream only while the reader is already at the bottom (within 40px).
- **Faster session refreshes** — per-worktree session listings now run in parallel instead of serially, so a debounced refresh costs the slowest round-trip, not the sum of all of them.
- **Crash-safe sidecar writes** — `lineage.json`, `pins.json`, and `trash.json` are written via temp file + rename, so a crash mid-write can never leave a truncated file that silently resets to empty on the next read.

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
