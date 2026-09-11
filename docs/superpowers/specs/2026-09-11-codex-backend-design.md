# Codex Backend Support — Design

Date: 2026-09-11
Status: draft (awaiting review)
Verification: protocol facts below were checked against the local
`codex-cli 0.154.0` via `codex app-server generate-json-schema` and a live
stdio probe (`initialize` + `thread/list` against real `~/.codex` history).

## Goal

Add the Codex CLI as a second agent backend beside opencode, selectable at
runtime from the top bar. Switching backends is one click, does not disturb
runs in flight, and both backends can stream concurrently in the background.
The user's mental model: "same app, same canvas, different engine."

Non-goals (explicitly out of scope for v1): image/file attachments on codex
prompts, `turn/steer`, thread sections, review threads, MCP status UI, and
mixed-backend canvases (a codex session and an opencode session in one
project view). The id-namespacing chosen below must not block that future.

## Why this is cheap

`AgentAdapter` (`src/shared/types.ts`) is already backend-agnostic and the
renderer only knows `AweforkApi`. The single hardcoded point is
`src/main/index.ts` boot: `ensureOpencodeServer(PORT)` →
`createOpencodeAdapter` → one singleton promise feeding all IPC. Adding
codex means: one adapter implementation, one child-process manager, and a
"which backend" routing concept. No protocol changes to the adapter surface
beyond capability reporting.

## Codex integration surface (verified)

`codex app-server` is the official embedding protocol (the ChatGPT desktop
app itself runs one). It is newline-delimited JSON-RPC 2.0 over stdio — no
HTTP port, no Content-Length framing; responses may omit the `jsonrpc`
field, so the reader must key on `id`/`method`. Handshake is
`initialize {clientInfo {name, title, version}}`.

Method map:

| AgentAdapter | codex method | Notes |
|---|---|---|
| `listSessions` | `thread/list` | paginated (`nextCursor`); returns cwd, `name` (nullable), `preview`, `forkedFromId`, `source`, `status`, `model`, `reasoningEffort`, `gitInfo` |
| `messages` | `thread/resume` + `thread/items/list` | threads come back `status: notLoaded`; resume loads the rollout, items list is paginated ascending |
| `createSession` | `thread/start {cwd}` | materialized on disk (`ephemeral: false`) |
| `fork` | `thread/fork {threadId, lastTurnId}` | **`lastTurnId` is exactly awefork's "keep through this turn" semantics** — the adapter maps `atMessageId` (a user-message item id) to its containing turn id |
| `deleteSession` | `thread/delete` | native |
| `renameSession` | `thread/setName` | native |
| `prompt` | `turn/start {threadId, input, model?, effort?}` | `effort` maps 1:1 to `ModelChoice.variant` |
| `abort` | `turn/interrupt` | |
| `listModels` | `model/list` | flatten to `ModelOption`; `variants` from the model's reported reasoning efforts, defaulting to `["low","medium","high"]` when the response omits effort metadata (response shape not yet probed — verify on first wire-up) |
| `messageAttachments` | — | returns `[]` (v1; codex does not round-trip sent bytes) |
| `subscribe` | notifications | mapping table below |

Notification map (`{method, params, emittedAtMs}` frames):

| codex notification | AgentEvent |
|---|---|
| `agentMessage/delta` | `message.delta` kind `text`, partId = itemId |
| `reasoning/*.delta` (text + summary) | `message.delta` kind `thinking` |
| `itemStarted` / `itemCompleted` (assistantMessage, reasoning) | `message.part` snapshot (self-heal; endedAt from turn/item timestamps) |
| `turnStarted` | `message.started` |
| `turnCompleted` | `session.idle` |
| `threadStatusChanged` (`active`⇄`idle`) | `message.started` / `session.idle` (twin-signal redundancy, same as opencode's `session.status`) |
| `threadNameUpdated`, `threadDeleted`, `threadArchived`, … | `session.updated` |
| `error` (`ErrorNotification`) | `server.error` with sessionId = threadId; skipped when `willRetry` is true |

Units: codex timestamps are Unix **seconds**; awefork uses ms — the adapter
multiplies by 1000 at every boundary.

Tool names for `ChatMessage.toolNames` come from item types on refresh
(`commandExecution` → "shell", `fileChange` → "patch", `mcpToolCall` →
server/tool name, `webSearch` → "web"). Live tool chips during a run are
nice-to-have; `session.idle` refresh already populates them.

## Architecture: registry + router, renderer owns the selection

```
renderer (Vue)
  │  every call carries backend: "opencode" | "codex"
  ▼
preload (AweforkApi, methods gain a leading `backend` param)
  ▼
ipc.ts ── routes each invoke to registry.get(backend).<method>
  ▼
backend-registry (main)                 events from every spawned backend,
  ├─ opencode: ensureOpencodeServer →   tagged and broadcast together:
  │   createOpencodeAdapter (existing)  awefork:event → {backend, event}
  └─ codex: ensureCodexServer →
      createCodexAdapter (new)
```

Key decisions:

- **Backend is a per-call argument, not a main-process mode.** The renderer
  always passes its active backend; main routes by that argument. A switch
  cannot misroute an in-flight invoke, and main stays stateless about
  "current" beyond startup defaults.
- **Lazy spawn.** A backend's server/adapter is created on first use.
  Launch spawns only the persisted selection. The other backend stays cold
  until the user first switches to it.
- **Dual subscription.** Every spawned backend's adapter subscribes and its
  events are forwarded on one channel as envelopes `{backend, event}`. The
  renderer filters view updates by active backend but maintains running
  state for both — switch away and back and background runs are still
  streaming.
- **Selection persists** in `userData/settings.json`
  (`{ "backend": "codex" }`, default `"opencode"`), read at boot.

### New/changed files

- `src/main/codex-server.ts` — spawn `codex app-server` as a child in its
  own process group (the npm `codex` shim spawns the real binary; killing
  the shim alone orphans it — kill the group, mirroring the Windows
  `taskkill /T` note in `opencode-server.ts`). Reuses `buildSpawnEnv` /
  `resolveSpawnEnv` for PATH discovery. Readiness = successful
  `initialize` handshake (no port to probe). Child exit ⇒ emit
  connection-level `server.error`; the registry re-spawns lazily on the
  next call for that backend and emits `server.reconnected` after the
  handshake succeeds, so the renderer can refresh what the outage missed.
- `src/main/codex-jsonrpc.ts` — minimal JSON-RPC client over the child's
  stdio: newline framing, id correlation, per-request timeout (30 s),
  notification fan-out, tolerant of missing `jsonrpc` field.
- `src/shared/codex-adapter.ts` — `AgentAdapter` implementation, mapping
  tables above. Holds the item→turn index per loaded thread (built from
  `thread/items/list`) to translate `fork`'s `atMessageId`.
- `src/main/backend-registry.ts` — `get(backend): Promise<AgentAdapter>`
  with cache + lazy spawn; cleanup on quit for both children.
- `src/main/settings-store.ts` — small read/write for the persisted
  selection (pins-store pattern).
- `src/main/ipc.ts` — handlers take the backend argument; new channels:
  - `awefork:backends` → `[{id, label, installed}]` for the switcher
    (`installed` probed via `--version` spawn, no server started);
  - `awefork:selectBackend(backend)` → persists; errors (probe fail) as
    `{ok: false, error}` so the switcher can bounce back.
- `src/shared/awefork-api.ts` / preload — methods gain the leading
  `backend` param; `onEvent` handler receives the envelope; new
  `capabilities(backend)` → `{ deleteMessage: boolean, attachments:
  boolean }` (opencode: both true; codex: both false in v1; mock: true).
- Renderer (`state.ts`, `top-bar.vue`, composer, model picker) — see below.

## Overlay stores: per-backend files with legacy fallback

`lineage.json`, `pins.json`, `trash.json`, `archive.json` become
per-backend (`lineage-codex.json`, …). A pin on a codex session is
meaningless in the opencode view, so the split is semantic, not just
collision-avoidance. Migration without moves: when the opencode-suffixed
path does not exist but the legacy bare path does, opencode reads/writes
the legacy path. Codex starts fresh. `ForkRecord`s for codex also get
corroborated by the native `forkedFromId` on `thread/list`: a fork record
missing from lineage still renders as a fork via the backend's own data.

`SessionSummary.origin` mapping for codex: `source.subAgent` →
`"subagent"`; `forkedFromId` present → `"fork"`; else `"root"`.

## Renderer interaction

- **Switcher** — segmented control in the top bar next to the brand:
  `opencode | codex`. Uninstalled backends render disabled with a tooltip
  ("codex CLI not found on PATH"). The control doubles as a health
  indicator: active backend shows the existing connection status dot.
- **Switch action** — persist selection (`awefork:selectBackend`), set
  `state.activeBackend`, then replay the boot sequence for that backend
  only (`ready → sessions+lineage → models → capabilities`). The canvas
  re-scopes to the backend's working set; the previous backend's view
  state (pins, archive, trash) is already namespaced in the stores.
- **Running state survives switches** — `state.running` keys become
  `backend:sessionId`. Events from the inactive backend keep updating its
  running map and stream tails; only the *view* filters by active backend.
  In-flight runs are never interrupted by a switch (they live in the
  agent's own process).
- **Capability-driven UI** — the composer hides the attach button and the
  message context menu hides "delete message" when
  `capabilities(backend)` says no, rather than surfacing an error on
  click. Retry-with-attachments on codex falls back to text-only prefill
  (`messageAttachments` returns `[]`).
- **Demo mode** — the mock bridge tags its events with backend
  `"opencode"` and the switcher is hidden (single-backend demo, unchanged
  dataset).

## Error handling

- Codex CLI missing: `awefork:selectBackend` fails with an actionable
  message (mirror `opencode-server.ts` wording: install hint + manual
  start not applicable since there is no port). Switcher stays on the
  current backend.
- Not authenticated (`codex login` never run): `turn/start` returns an
  auth error → `ErrorNotification` → `server.error` toast naming the
  session. `ensureCodexServer` additionally calls `account/get` after the
  handshake; on missing auth it emits a one-time banner event so the UI
  can say "run codex login" before the first prompt instead of after.
- Child crash mid-run: connection-level `server.error`, running map for
  codex sessions settles via the existing poll watchdog; lazy re-spawn on
  next codex call, then `server.reconnected`.
- Version drift: `initialize` returns the CLI version; if it predates
  `thread/fork.lastTurnId`, the adapter degrades fork to
  `thread/fork` + `thread/rollback {numTurns}` on the fresh copy (both
  native, both verified present), and logs once.

## Testing

- Unit: JSON-RPC framing (newline split across chunk boundaries, missing
  `jsonrpc` field), notification→AgentEvent mapping table, item/turn
  grouping into `ChatMessage` (fixtures from the live probe), s→ms
  conversion, `atMessageId`→turn translation, registry routing with fake
  adapters, store legacy-fallback resolution, envelope tagging.
- Renderer: switch flow replays boot without losing the other backend's
  running map; capability gating hides the right affordances.
- Manual smoke against the local codex install (real history exists on
  this machine, including sessions whose cwd is this repo): switch →
  list → open → prompt → fork at turn → interrupt → delete → switch back
  while a codex run is streaming.
- Existing opencode tests must pass unchanged.

## Rollout order

1. Registry + settings + IPC routing with backend args; opencode behavior
   byte-identical (event envelopes tagged, renderer unwraps).
2. `codex-server.ts` + `codex-jsonrpc.ts` (child lifecycle, handshake,
   crash/re-spawn).
3. `codex-adapter.ts` (read paths first: list/messages/models/subscribe;
   then write paths: prompt/fork/abort/rename/delete).
4. Renderer: switcher, boot replay, namespaced running map, capability
   gating; overlay store fallback.
5. Polish: auth banner, version-drift fork fallback, error copy.
