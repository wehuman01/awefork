# Changelog

## v0.1.9

v0.1.6 taught `archive.json` to survive racing clicks; this release gives every sidecar the same spine — and the dist folder learns to tidy up after itself.

### Highlights

- **Race-free sidecar writes, everywhere** — every read-modify-write on a sidecar file (pins, lineage, trash, archive) now flows through a per-file write queue, so concurrent updates line up and commit in order instead of interleaving and silently dropping the earlier change. The stores expose intent-named operations (`togglePin`, `addTrashEntry`, `removeTrashEntry`, …) and the IPC handlers call them straight through — no more read, mutate, and hope.
- **Adapter sleeps let go** — an aborted sleep in the opencode adapter now detaches its abort listener when the timer wins, instead of leaving it hanging off the signal.
- **Release builds sweep the floor** — `npm run dist` / `npm run dist:win` first move older installers out of `dist/` into `dist/archive/<version>/`, so the dist root only ever holds the current release while previous dmgs, exes, and blockmaps stay inspectable.

### Install

Download the unsigned arm64 dmg or the Windows x64 setup.exe straight from the [v0.1.9 release](https://github.com/wehuman01/awefork/releases/tag/v0.1.9). On first launch on macOS, right-click the app and choose Open (or clear the quarantine flag with `xattr -d com.apple.quarantine /Applications/awefork.app`).

## v0.1.8

awefork crosses to Windows, and the canvas learns to stay where you left it.

### Highlights

- **Windows, alongside macOS** — a win/nsis x64 build target (`npm run dist:win`), a Windows runner in CI, and the bundled opencode server that finds the binary wherever Windows hides it: `%APPDATA%\npm`, winget links, `~/.opencode/bin`, and scoop shims — spawned through the shell so npm `.cmd` shims resolve, with the PATH split on the platform's own delimiter.
- **Document attachments everywhere** — .docx (mammoth), .rtf (built-in reader), and legacy .doc (word-extractor) all convert in-process on every platform, replacing the macOS-only textutil detour; corrupt files fail with a readable message instead of a shrug.
- **The canvas keeps your place** — sending from a canvas draft no longer yanks the view: the composer floats in the branch's next free cell (exactly where the sent turn's card will land, joined by a dashed connector), so the new card materializes where you were already looking. Selecting a turn from the context chain now centers it on the canvas, while canvas clicks still leave the view untouched — and a jump aimed at a still-loading branch applies once its cards arrive.
- **Runs finish when they finish** — the backend's finish reason is tracked per assistant row, and the completion watchdog now watches the message list's shape for liveness and ignores tool-call pauses, so a run that pauses to call a tool no longer reads as done (or as stuck).

### Install

Download the unsigned arm64 dmg straight from the [v0.1.8 release](https://github.com/wehuman01/awefork/releases/tag/v0.1.8). On first launch, right-click the app and choose Open (or clear the quarantine flag with `xattr -d com.apple.quarantine /Applications/awefork.app`). Windows isn't attached this time — build the NSIS installer yourself with `npm run dist:win`.

## v0.1.7

Reasoning streams into the conversation, and awefork can start one itself: a release about seeing and starting the whole thought.

### Highlights

- **Streaming Thought blocks** — a run's reasoning now streams into a collapsible Thought block while you wait: open while the model thinks, auto-collapsed once the answer starts. Persisted replies keep their Thought in the final message, and canvas card previews stay reply-only. opencode 1.18 labels text and reasoning deltas alike, so the adapter resolves each part's real type before routing the stream.
- **New conversations in-app** — the sidebar's ＋ 新对话 (or the palette's 新增对话) starts a brand-new session in the open project through opencode's native API, lands you in it, and puts the caret in the composer for the first prompt. Demo mode keeps parity.
- **Startup & reconnect hardening** — the bundled opencode server now probes the login shell for its binary, waits for the SSE event endpoint (not just REST) before declaring ready, and retries the first session fetch until the cold-start scan finishes. A dropped event stream reports one outage toast, then refreshes everything on recovery.
- **In-app update checks** — a silent check a few seconds after startup plus a manual one from the topbar; a new release raises a banner with Release Notes, Skip this version, and dismiss.

### Install

This release ships notes only — no dmg attached. Build it yourself with `npm run dist` (unsigned arm64); on first launch, right-click the app and choose Open (or clear the quarantine flag with `xattr -d com.apple.quarantine /Applications/awefork.app`).

## v0.1.6

Retry gets its attachments back, and the archive sidecar learns to survive racing clicks.

### Highlights

- **Retry restores attachments** — retrying a turn (the ↻ on a card or pane header) now reopens the prompt with its original file parts pulled back from the backend and dropped into the composer as chips, alongside the text and model it already restored. The draft opens immediately; chips arrive once the fetch lands, and a failed fetch only costs the chips — the retried prompt still goes out.
- **Race-free archive writes** — rapid archive and restore clicks used to run overlapping read-modify-write cycles on `archive.json`, where the later write could read stale state and silently drop the earlier entry. Writes now serialize per sidecar file, and the shared empty sentinel is frozen so no caller can mutate it for everyone else.
- **Clean exit from an emptied project** — deleting or archiving the last visible session of the open directory now falls back to the fresh-install empty state instead of stranding the view on a project with nothing to show; the session refresh re-picks a directory as soon as one becomes visible again (e.g. after a restore).

### Fixes

- **Copy button on streaming code blocks** — a code block swapped out mid-stream no longer fires its stale copy-reset timer after unmount.

### Install

Download the unsigned arm64 dmg straight from the [v0.1.6 release](https://github.com/wehuman01/awefork/releases/tag/v0.1.6) (or build it yourself with `npm run dist`). On first launch, right-click the app and choose Open (or clear the quarantine flag with `xattr -d com.apple.quarantine /Applications/awefork.app`).

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
