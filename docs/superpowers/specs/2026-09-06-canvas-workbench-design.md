# Canvas Workbench UI (v0.2) — Design

Date: 2026-09-06
Status: approved via interactive mockup (peach-soda preview)

## Goal

Replace the two-pane layout (session tree + linear chat) with a node-graph
workbench in the spirit of a canvas tool, but with awefork's own visual
identity ("peach soda": cream background, peach primary, butter/lavender
accents, rounded cards). No library for the canvas — hand-rolled pan/zoom +
SVG edges; the project keeps a single runtime dependency (vue).

## Layout

```
┌────────────────────────────────────────────────┐
│ topbar: brand · project pill · server status   │
├────────┬──────────────────────────┬────────────┤
│ sidebar│  infinite dot-grid canvas│  branch    │
│ project│  turn nodes + edges      │  context   │
│ search │  draft composer card     │  messages  │
│ list   │  zoom + status chrome    │  reply box │
└────────┴──────────────────────────┴────────────┘
```

- **Sidebar** — projects (directories) with their sessions nested (forks
  indented, ⎇ mark). Click project → canvas shows that directory's graph.
  Click session → select its latest turn and center it. Search filters by
  title. No "new session" button: the adapter has no create-session primitive
  and awefork stays a read+fork projection (follow-up if ever needed).
- **Canvas** — one node per **turn** (a user prompt plus its assistant
  reply). Sequential turns in a session chain left→right with solid edges;
  forks sprout as dashed edges; running sessions get a mint "running" state.
  Pan by dragging, zoom with the wheel (0.45–1.8), fit-to-view button.
- **Draft card** — the "＋" chip on a node opens a dashed composer attached
  below it. Sending forks the session at that turn AND fires the prompt on
  the new branch in one move; the canvas then shows the new branch growing
  from that node.
- **Branch context panel** — the full message chain of the selected node's
  session (user bubbles right, assistant left, tool chips, per-turn fork
  buttons) plus the reply composer that continues the selected branch.

## Data mapping

- `Turn = user ChatMessage + following assistant message(s)` (built by
  `src/shared/turns.ts`). Node shows: question title, reply preview
  (3-line clamp), tool chips, relative time.
- Graph built by `src/shared/canvas-graph.ts` (pure, unit-tested) from
  sessions of one directory + lineage + messages of every session in that
  directory. Layout: column = turn depth (fork child starts at parent
  fork-turn column + 1); row = first free slot scanning downward from the
  parent turn's row (roots stacked oldest-first). Deterministic.
- **Shared-prefix rule**: a forked session contains a copy of the parent's
  history. The graph renders only the child's turns *after* the inherited
  prefix (leading turns whose ids already exist in the parent; position
  fallback `forkTurnIndex + 1` when ids don't match). A branch with no new
  turns renders as a dashed "stub" node so it stays visible and selectable.
- Node footer uses only data the adapter actually provides (time, tools);
  no invented token/model readouts.

## State (renderer/state.ts)

Adds: `messagesBySession` cache (loaded per directory, refreshed for a
session on `session.idle`), `selectedDirectory`, `selectedTurnId`,
`draft {nodeId, text} | null`, `runningSessions` map (drives canvas running
states and the reply box), `focusRequest` (sidebar → canvas centering).
Existing actions kept: selectSession, sendPrompt, abort, forkAtMessage,
forkLatest, dismissActionError; new: selectTurn, openDraft/sendDraft,
switchDirectory.

## Components

- `top-bar.vue` (new), `side-bar.vue` (new; replaces `session-tree.vue`),
  `session-canvas.vue` (new: viewport/world/svg edges/turn cards/draft/zoom),
  `branch-context.vue` (new wrapper reusing `message-list.vue` +
  `chat-input.vue`, both restyled). `session-node.vue` deleted; `app.vue` and
  `style.css` rewritten with the peach-soda theme.

## Testing

- `tests/turns.test.ts` — turn grouping, tool collection, empty sessions.
- `tests/canvas-graph.test.ts` — sequential chains, fork edges, shared-prefix
  skipping, stub nodes, row/column collision rules, orphan forks as roots.
- `npm run typecheck && npm run lint && npm test` must pass.
