<div align="center">
  <h1>awefork: Non-linear Session Workbench</h1>
  <p><strong>Fork any turn. Keep every branch.</strong></p>
  <p>A desktop workbench that turns AI coding-agent sessions into a tree: pick any past turn, branch from it, and keep exploring in parallel.</p>
  <p>
    <strong>English</strong> ·
    <a href="./README_cn.md">简体中文</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.1.0-7C3AED?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/node-%E2%89%A522-0EA5E9?style=flat-square" alt="Node">
    <img src="https://img.shields.io/badge/license-MPL--2.0-22C55E?style=flat-square" alt="License">
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-alpha-c96a3d?style=flat-square" alt="Status">
    <img src="https://img.shields.io/badge/run-npm_dev-22C55E?style=flat-square" alt="npm run dev">
    <img src="https://img.shields.io/badge/platform-desktop-334155?style=flat-square" alt="Platform">
    <img src="https://img.shields.io/github/stars/wehuman01/awefork?style=flat-square" alt="GitHub stars">
  </p>
</div>

> Fork any turn. Keep every branch.

awefork is a non-linear workbench for local coding agents. Today it supports [opencode](https://opencode.ai) and is built around one move: **node-level forking** — pick any user message in a session, branch a new session from that exact turn, and continue in a fresh context while the original stays untouched.

It is intentionally scoped: read-only projection of your real agent sessions, fork/continue through the agent's native API, nothing invented in between. No storage hacking, no lock-in — every session it creates is a plain opencode session you can keep using anywhere.

## How It Works

```text
┌──────────────┬──────────────────────────────────┐
│ Sessions     │  message chain of active branch  │
│ (tree with   │                                  │
│  forks ⎇)    │  ▸ each user turn has            │
│              │    [⎇ fork here]                 │
│ /repo        │                                  │
│  · session A │  chat input to continue          │
│    · ⎇ A-1   │  this branch                     │
└──────────────┴──────────────────────────────────┘
```

- **Navigator** — all opencode sessions grouped by project directory; forks nest under their parent.
- **Fork here** — any user turn can seed a new branch. The new session keeps that full turn (question + answer).
- **Continue** — send messages from awefork; replies stream in live.
- **Native sessions** — forking calls `opencode serve`'s fork API; the result is a real session (open it in the TUI anytime).

## Install

Requires Node.js ≥ 22 and the `opencode` CLI on PATH.

```bash
git clone https://github.com/wehuman01/awefork.git
cd awefork
npm install
```

awefork reuses a running `opencode serve` on port 4096, or starts one for you when the app launches.

## Quick Start

```bash
npm run dev
```

1. Pick a session from the left tree.
2. Find the turn you want to branch from → click **⎇ fork here**.
3. The new branch opens; type in the input to continue it.
4. Original session untouched — switch back anytime.

## Config

No config file. Two facts drive everything:

| Fact | Value |
|---|---|
| opencode server | `http://127.0.0.1:4096` (reused if running, else spawned) |
| fork lineage | `<userData>/lineage.json` (records which session forked from which) |

Lineage is stored by awefork because opencode's fork API copies messages without recording a parent link. Delete the file and you only lose fork nesting in the tree — sessions keep working.

## Multi-Agent Roadmap

The core is the `AgentAdapter` protocol (`src/shared/types.ts`): listSessions / messages / fork / prompt / abort / subscribe. opencode is the first implementation. Planned next: pi (JSONL with `parentId`), Claude Code (JSONL with `parentUuid` + `--resume`), Codex.

## Development

```bash
npm run typecheck   # tsc + vue-tsc
npm run lint        # biome
npm test            # vitest (fake opencode server, no real agent needed)
```

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for architecture and design constraints.
