<div align="center">
  <h1>awefork：非线性会话工作台</h1>
  <p><strong>任意一轮，随时分叉。每条分支，都留着。</strong></p>
  <p>把 AI 编程 agent 的会话变成一棵树的桌面工作台：选中任意历史轮次，从那里长出新分支，并行推进多条探索路径。</p>
  <p>
    <a href="./README.md">English</a> ·
    <strong>简体中文</strong>
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

> 任意一轮，随时分叉。每条分支，都留着。

awefork 是本地编程 agent 的非线性工作台。当前支持 [opencode](https://opencode.ai)，围绕一个核心动作构建：**节点级分叉** —— 选中会话里的任意一条用户消息，从那一轮长出一个新会话，在全新的上下文里继续，原会话毫发无损。

范围刻意收窄：对你的真实 agent 会话做只读投影，分叉与续聊全部走 agent 原生 API，中间不发明任何东西。不碰存储、没有锁定 —— 它创建的每个会话都是普通的 opencode 会话，随时可以拿到任何地方继续用。

## 工作方式

```text
┌──────────────┬──────────────────────────────────┐
│ 会话列表      │  当前分支的消息链                  │
│ （分叉树 ⎇） │                                  │
│              │  ▸ 每条用户消息都有                │
│ /repo        │    [⎇ fork here] 按钮            │
│  · session A │                                  │
│    · ⎇ A-1   │  底部输入框继续                   │
└──────────────┴──────────────────────────────────┘
```

- **导航器** —— 全部 opencode 会话按项目目录分组；分叉嵌套在父会话之下。
- **Fork here** —— 任意一轮都能长出新分支，新会话完整保留该轮（提问 + 回答）。
- **续聊** —— 在 awefork 里直接发消息，回复实时流式显示。
- **原生会话** —— 分叉调用 `opencode serve` 的 fork API，产物是真实会话（随时可在 TUI 里继续）。

## 安装

需要 Node.js ≥ 22，且 `opencode` CLI 在 PATH 上。

```bash
git clone https://github.com/wehuman01/awefork.git
cd awefork
npm install
```

awefork 会复用 4096 端口上已在运行的 `opencode serve`；没有的话，应用启动时会自动拉起一个。

## 快速开始

```bash
npm run dev
```

1. 在左侧树里选一个会话。
2. 找到想分叉的那一轮 → 点 **⎇ fork here**。
3. 新分支打开，在输入框里继续对话。
4. 原会话不受影响，随时切回。

## 配置

没有配置文件。两个事实决定一切：

| 事实 | 值 |
|---|---|
| opencode 服务 | `http://127.0.0.1:4096`（在跑就复用，没跑就拉起） |
| 分叉谱系 | `<userData>/lineage.json`（记录谁从谁分叉） |

谱系由 awefork 自行记录，因为 opencode 的 fork API 只复制消息、不留父链接。删掉这个文件只会丢树形嵌套，会话本身照常可用。

## 多 Agent 路线

核心是 `AgentAdapter` 协议（`src/shared/types.ts`）：listSessions / messages / fork / prompt / abort / subscribe。opencode 是第一个实现。后续计划：pi（带 `parentId` 的 JSONL）、Claude Code（带 `parentUuid` 的 JSONL + `--resume`）、Codex。

## 开发

```bash
npm run typecheck   # tsc + vue-tsc
npm run lint        # biome
npm test            # vitest（内置假 opencode 服务，不需要真实 agent）
```

架构与设计约束见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。
