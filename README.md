<div align="center">
  <img src="assets/icon/icon.png" alt="awefork icon" width="128" />
  <h1>awefork: Non-linear Session Workbench</h1>
  <p><strong>Fork any turn. Keep every branch.</strong></p>
  <p>A desktop workbench that turns AI coding-agent sessions into a tree: pick any past turn, branch from it, and keep exploring in parallel.</p>
  <p>
    <strong>English</strong> ·
    <a href="./README_cn.md">简体中文</a> ·
    <a href="https://www.webioinfo.top/">Webioinfo</a>
  </p>
  <p>
    <a href="https://ko-fi.com/mugpeng"><img src="https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.1.6-7C3AED?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/node-%E2%89%A522-0EA5E9?style=flat-square" alt="Node">
    <img src="https://img.shields.io/badge/license-MPL--2.0-22C55E?style=flat-square" alt="License">
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-alpha-c96a3d?style=flat-square" alt="Status">
    <img src="https://img.shields.io/badge/install-download_dmg-22C55E?style=flat-square" alt="Download dmg from Releases">
    <img src="https://img.shields.io/badge/platform-desktop-334155?style=flat-square" alt="Platform">
    <img src="https://img.shields.io/github/stars/wehuman01/awefork?style=flat-square" alt="GitHub stars">
  </p>
</div>

> Fork any turn. Keep every branch.

awefork is a non-linear workbench for local coding agents. Today it supports [opencode](https://opencode.ai) and is built around one move: **node-level forking** — pick any user message in a session, branch a new session from that exact turn, and continue in a fresh context while the original stays untouched.

It is intentionally scoped: read-only projection of your real agent sessions, fork/continue through the agent's native API, nothing invented in between. No storage hacking, no lock-in — every session it creates is a plain opencode session you can keep using anywhere.

The idea of treating sessions as a branching graph originates from [PiX](https://github.com/huang-sh/PiX), which first explored this non-linear interaction model for AI agent workbenches. awefork adapts it for opencode: read-only projection, native fork API, zero storage lock-in.

## How It Works

```text
┌──────────────┬──────────────────────────────────┐
│ Sessions     │  the selected turn's exchange    │
│ (tree with   │                                  │
│  forks ⎇,    │  ▸ click any card or session —   │
│  foldable    │    the pane jumps to that turn   │
│  folders)    │                                  │
│ /repo        │  chat input to continue          │
│  · session A │  this branch                     │
│    · ⎇ A-1   │                                  │
└──────────────┴──────────────────────────────────┘
```

- **Navigator** — all opencode sessions grouped by project directory (folders fold); forks nest under their parent. Right-click a row to rename (`PATCH /session`) or archive it; right-click a directory to archive the whole project. Archived items hide from every view (search, palette, canvas included) and restore from the archive section at the sidebar's bottom — sessions created under an archived directory stay hidden until the directory comes back.
- **Turn pane** — the right panel shows one turn: its prompt and reply, with run duration and output tokens in the header. Click a canvas card or a sidebar session and the pane jumps there; while a new turn runs, it follows along. Walk turns with ‹ › or ←/→.
- **Fork here** — any user turn can seed a new branch. The new session keeps that full turn (question + answer), and awefork lands you in it.
- **Checkpoint clone** — fork the selected branch's latest state in one click, no turn picking needed.
- **Model choice** — a searchable picker (70+ models is fine) when starting a branch, plus a per-session picker beside the composer.
- **Thinking effort** — pick the run's reasoning variant (minimal/low/medium/high…) next to the model; canvas cards show `model · variant` for what each turn actually used.
- **Image attachments** — paste or drop images into either composer (capability-gated per model); sent rows carry 📎 chips.
- **Retry failed turns** — the ↻ on a failed turn (card or pane header) reopens its prompt prefilled with the original text and model; edit and resend — mid-story turns retry as a fresh fork, the failed original stays untouched.
- **Continue** — send messages from awefork; replies stream in live. Replying while an older turn is selected branches from that turn.
- **Canvas** — selecting a turn highlights its full path from the root and dims the rest; fit view, and an always-on minimap with a live viewport rectangle.
- **Command palette** — ⌘K / Ctrl+K to jump between sessions and fire actions; drag the column handles to resize, double-click to fold.
- **Native sessions** — forking calls `opencode serve`'s fork API; the result is a real session (open it in the TUI anytime).

## Install

**Download** — grab `awefork-<version>-arm64.dmg` (macOS, Apple Silicon) from the [latest release](https://github.com/wehuman01/awefork/releases/latest) and drag it into Applications. The build is unsigned: on first launch, right-click the app and choose Open (or clear the quarantine flag with `xattr -d com.apple.quarantine /Applications/awefork.app`).

**Windows** — build it from source with `npm run dist:win` (NSIS installer). The `opencode` CLI must be on PATH; npm-style installs (`.cmd` shims) are picked up automatically.

**From source** — requires Node.js ≥ 22 and the `opencode` CLI on PATH.

```bash
git clone https://github.com/wehuman01/awefork.git
cd awefork
npm install
```

awefork reuses a running `opencode serve` on port 4096, or starts one for you when the app launches.

## Quick Start (from source)

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

## Support

If awefork helps you, consider supporting its development:

- ⭐ Star the repo — it helps others find it.
- ☕ [Ko-fi](https://ko-fi.com/mugpeng) — buy me a coffee.
- 💬 WeChat — scan the QR code below.

<p align="center">
  <img src="assets/images/wechat-pay.jpg" alt="WeChat Pay" width="240">
</p>

> awefork is free and open source. Sponsors keep it maintained — thank you.

## Development

```bash
npm run typecheck   # tsc + vue-tsc
npm run lint        # biome
npm test            # vitest (fake opencode server, no real agent needed)
```

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for architecture and design constraints.

- [Contributing](./docs/CONTRIBUTING.md)
- [Changelog](./docs/CHANGELOG.md)

## Awesome Ecosystem

awefork is part of a growing family of "awesome" tools — CLI-first, local-first, and operable by AI agents.

### CLI Tools

- **[aweskill](https://aweskill.webioinfo.top/)** — CLI-first skill package manager supporting 47+ AI coding agents.
- **[aweswitch](https://github.com/Webioinfo01/aweswitch)** — Agent profile switcher for Claude Code, Codex, and OpenCode.
- **[awerouter](https://github.com/mugpeng/awerouter)** — Smart router that splits requests between Flash and Pro models using structural signals, cutting unnecessary model spend.
- **[aweshelf](https://github.com/Webioinfo01/aweshelf)** — Bookmark, categorize, and restore AI coding sessions; pairs with aweswitch to save profiles and launch with one command.
- **[aweshare](https://github.com/wehuman01/aweshare)** — Share local Ollama/vLLM backends, domestic coding plans, or authorized OpenAI/Anthropic subscriptions through a self-hosted hub — a sharing economy for tokens.
- **[awewarm](https://github.com/wehuman01/awewarm)** — Subscription window warmer that keeps AI coding-plan windows active, for local setups and through a remote hub server.
- **[awescholar](https://github.com/Webioinfo01/awescholar)** — AI-agent-operable scientific literature discovery and curation.

### Desktop Apps

- **[awefork](https://github.com/wehuman01/awefork)** — this project. Turns AI coding-agent sessions into a tree: fork any turn, keep every branch. Pairs with aweswitch — launch a session with a profile, then explore and fork its history here.
- **[awedot](https://awedot.wehuman.top/)** — A floating orb at your screen edge keeps track of the current AI session: bookmark it in one click, resume anytime, and pair with aweswitch to pin the agent's config (e.g., relaunch with the GLM model).

### Project Collections

- **[Awesome AI Meets Biology](https://github.com/Webioinfo01/Awesome-AI-Meets-Biology)** — A curated survey of AI applications in biology, bioinformatics, and biomedical research. Powered by awescholar.
- **[Awesome AI Virtual Tumor](https://github.com/Webioinfo01/Awesome-AI-Virtual-Tumor)** — A curated collection of state-of-the-art AI systems for virtual tumor modeling and simulation: static models, dynamic models, agents, benchmarks, and reviews.
