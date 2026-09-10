# Contributing to awefork

## Setup

```bash
npm install
npm run dev        # launches Electron + Vite against a real/child opencode serve
npm run typecheck
npm run lint
npm test
```

Requirements: Node.js ≥ 22, `opencode` CLI on PATH.

## Engineering Taste

We follow these principles verbatim. Apply them unless there is an explicit conflicting convention.

- **Simple**: make the smallest change that solves the real problem.
- **Clear**: optimize for the next reader, not for cleverness.
- **Decoupled**: keep boundaries clean, but do not add abstractions without a real need.
- **Honest**: make complexity, state, side effects, assumptions, and failure modes visible; do not hide complexity or create extra complexity.
- **Focused**: preserve boundaries between modules, and keep top-level convenience commands minimal.
- **Durable**: choose behavior that is easy to maintain, test, and extend.
- **First principles**: identify the real problem, hard constraints, and known facts before reaching for patterns, abstractions, or prior solutions.

## Project Structure

```
src/
  main/            # Electron main: bootstrap, window, opencode serve lifecycle, IPC wiring
  preload/         # contextBridge surface (window.awefork)
  shared/          # pure logic + agent adapters — no Electron imports, fully testable
    types.ts       # AgentAdapter protocol + domain types
    opencode-client.ts   # thin typed fetch client for opencode's HTTP API
    opencode-adapter.ts  # AgentAdapter implementation (first backend)
    lineage-store.ts     # fork lineage sidecar (JSON)
    session-tree.ts      # pure projection: sessions + lineage -> display tree
    sse.ts               # SSE frame parser for /event
  renderer/        # Vue 3 app (no state library; plain reactive state in state.ts)
tests/             # one test file per shared module; fake opencode server via node:http
docs/              # CONTRIBUTING.md, CHANGELOG.md
```

Separation rule: `shared/` never imports Electron; `main/` wires processes; `renderer/` renders and calls the preload bridge. Naming: kebab-case files, `run`+PascalCase only for commands, verb-first camelCase utilities, `is/has/should` booleans, PascalCase types.

## Architecture

### The one idea

Agent sessions are trees. Every supported agent already has a native fork/history primitive; awefork is a projection and control layer on top:

```
renderer ── window.awefork (preload) ── ipc ── AgentAdapter ── agent's native API
```

### Hard constraints (facts + rules)

1. **Read-only projection.** Session data is fetched through the agent's API. awefork never writes to agent storage, never mutates session files, never invents a session format.
2. **Fork through native primitives.** opencode: `POST /session/{id}/fork` with an **exclusive cut point** — the new session keeps messages strictly *before* `messageID`. The adapter's protocol-level promise is different: `fork(sessionId, atMessageId)` KEEPS the turn starting at that user message, so the adapter translates by passing the *next user message* as the cut, or omitting the cut at the last turn. Any new backend must honor this same promise.
3. **Lineage is ours.** opencode's fork copies messages without recording a parent link, so awefork maintains `<userData>/lineage.json` (single writer assumed). Subagent relationships (`parentID` in the agent's own data) are a separate `origin` and are hidden from the tree by default.
4. **Events are normalized.** Backend SSE streams are mapped to the small `AgentEvent` union (`session.updated`, `message.started`, `message.delta`, `session.idle`, `server.error`) before crossing IPC. The renderer never sees backend-specific payloads.
5. **Server lifecycle.** Port 4096 is probed at startup; a running `opencode serve` is reused, otherwise one is spawned as a child and killed on quit. Never kill a server you didn't spawn.
6. **Known limitation:** the message list is flat. Sessions where the user reverted and re-asked inside the same session show every attempt in order; dead-branch filtering is future work.

### Adding an agent backend

Implement `AgentAdapter` in `src/shared/`, add an entry in main-process wiring for its lifecycle, and extend the fake server in tests. The protocol doc-comment in `types.ts` is the contract; do not fork the protocol per backend.

## Testing

- One test file per shared module under `tests/`.
- Real I/O: temp dirs on disk (`mkdtemp`), real HTTP via a fake opencode server (`node:http`) that mirrors verified endpoint semantics. No module-level mocks.
- Adapter semantics worth re-verifying against a real opencode release when upgrading: exclusive-cut fork, `prompt_async` fire-and-forget, SSE frame shape on `/event`.
- Renderer has no dedicated tests yet; keep logic that matters in `shared/`.

## Release

Versioning from `package.json`. `docs/CHANGELOG.md` gets a `## vX.Y.Z` section per release. Tag `v*` triggers `.github/workflows/release.yml` (tests → changelog extraction → GitHub Release).

Installers are built locally with `npm run dist` (mac) / `npm run dist:win` (Windows) into `dist/`. Before each build, `scripts/archive-dist.mjs` moves installers of older versions into `dist/archive/<version>/`, so `dist/` root only ever holds the current build.
