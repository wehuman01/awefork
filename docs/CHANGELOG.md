# Changelog

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
