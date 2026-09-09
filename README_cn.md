<div align="center">
  <img src="assets/icon/icon.png" alt="awefork 图标" width="128" />
  <h1>awefork：非线性会话工作台</h1>
  <p><strong>任意一轮，随时分叉。每条分支，都留着。</strong></p>
  <p>把 AI 编程 agent 的会话变成一棵树的桌面工作台：选中任意历史轮次，从那里长出新分支，并行推进多条探索路径。</p>
  <p>
    <a href="./README.md">English</a> ·
    <strong>简体中文</strong> ·
    <a href="https://www.webioinfo.top/">Webioinfo</a>
  </p>
  <p>
    <a href="https://ko-fi.com/mugpeng"><img src="https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.1.5-7C3AED?style=flat-square" alt="Version">
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

「会话是一张图，随时分叉」这个想法源自 [PiX](https://github.com/huang-sh/PiX)——它最早把非线性会话图带进 AI agent 工作台。awefork 把这条思路适配到 opencode：只读投影、原生 fork API、不碰存储。

## 工作方式

```text
┌──────────────┬──────────────────────────────────┐
│ 会话列表      │  选中回合的问答内容                │
│ （分叉树 ⎇，  │                                  │
│  目录可折叠） │  ▸ 点画布卡片或左侧会话，          │
│              │    右侧跳到对应回合                │
│ /repo        │                                  │
│  · session A │  底部输入框继续                   │
│    · ⎇ A-1   │  这条分支                         │
└──────────────┴──────────────────────────────────┘
```

- **导航器** —— 全部 opencode 会话按项目目录分组（目录可折叠）；分叉嵌套在父会话之下；右键可重命名（走 `PATCH /session`）或归档；右键目录可归档整个项目。归档项从所有视图隐藏（搜索、命令面板、画布），在侧栏底部归档区一键恢复——目录归档后新增的会话也保持隐藏，直到目录恢复。
- **回合面板** —— 右侧只显示一个回合的提问与回复，头部带耗时与输出 token。点画布卡片或左侧会话，面板跳到对应回合；新回合运行时自动跟随；用 ‹ › 或 ←/→ 在回合间移动。
- **Fork here** —— 任意一轮都能长出新分支，新会话完整保留该轮（提问 + 回答），并直接进入新会话。
- **Checkpoint 克隆** —— 一键从当前分支最新状态克隆一份，不用先选回合。
- **模型选择** —— 可搜索的选择器（70+ 模型不犯愁）用在新分支上；主输入框旁也有按会话记忆的模型选择。
- **思考强度** —— 模型旁选择本次运行的推理档位（minimal/low/medium/high…），画布卡片以「模型 · 档位」标注每轮实际使用的配置。
- **图片附件** —— 两个输入框都支持粘贴/拖入图片（按模型能力门控），发出的消息带 📎 角标。
- **失败重跑** —— 失败回合的 ↻（卡片或面板头部）会用原文和原模型预填草稿，改完再发；中途回合重跑长成新分支，失败的原回合原样保留。
- **续聊** —— 在 awefork 里直接发消息，回复实时流式显示；选中较早回合时回复会从那一轮分叉。
- **画布** —— 选中回合后高亮从根到该回合的整条路径，其余淡化；适配视图；小地图常驻左下角，实时框出当前视口。
- **命令面板** —— ⌘K / Ctrl+K 快速切会话、执行动作；拖动分栏手柄调宽，双击折叠。
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

## 赞助与支持

如果 awefork 帮到了你，欢迎支持一下：

- ⭐ 给项目点个 Star — 让更多人看到它。
- ☕ [Ko-fi](https://ko-fi.com/mugpeng) — 请我喝杯咖啡。
- 💬 微信 — 扫描下方收款码。

<p align="center">
  <img src="assets/images/wechat-pay.jpg" alt="微信收款码" width="240">
</p>

> awefork 是免费开源的，你的支持让它持续维护下去 — 谢谢。

## 开发

```bash
npm run typecheck   # tsc + vue-tsc
npm run lint        # biome
npm test            # vitest（内置假 opencode 服务，不需要真实 agent）
```

架构与设计约束见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。

- [贡献指南](./docs/CONTRIBUTING.md)
- [更新日志](./docs/CHANGELOG.md)

## Awesome 软件生态

awefork 是一个不断壮大的 "awesome" 工具家族中的一员 — 围绕 AI 编程 agent 打造，local-first、可被 agent 直接操作。

### CLI 工具

- **[aweskill](https://aweskill.webioinfo.top/)** — CLI 优先的技能包管理器，支持 47+ AI 编程 agent。
- **[aweswitch](https://github.com/Webioinfo01/aweswitch)** — Claude Code、Codex、OpenCode 的 agent 配置切换器。
- **[awerouter](https://github.com/mugpeng/awerouter)** — 智能路由器，用结构信号把请求分给 Flash 或 Pro 模型，减少不必要的模型开销。
- **[aweshelf](https://github.com/Webioinfo01/aweshelf)** — 收藏、分类、恢复 AI 编程会话，还能搭配 aweswitch 实现保存配置，一键启动。
- **[aweshare](https://github.com/wehuman01/aweshare)** — 通过自建 Hub 共享本地 Ollama/vLLM，或国产厂商 coding plan，或已授权的 OpenAI/Anthropic 帐号订阅，实现 token 的共享经济。
- **[awewarm](https://github.com/wehuman01/awewarm)** — 订阅窗口保持器，让 AI 编程套餐的窗口持续激活，无论是本地设置，还是通过远程连接的服务器。
- **[awescholar](https://github.com/Webioinfo01/awescholar)** — AI agent 可自主执行的科学文献发现与策展，搜索、标注、筛选和报告学术论文。

### 桌面应用

- **[awefork](https://github.com/wehuman01/awefork)** — 本项目。把 AI 编程 agent 的会话变成一棵树：任意一轮，随时分叉，每条分支都留着。搭配 aweswitch 用更顺手 — 用 profile 启动会话，再回到这里浏览、分叉它的历史。
- **[awedot](https://awedot.wehuman.top/)** — 悬浮球驻留屏幕边缘，实时追踪当前 AI 会话；一键收藏、随时恢复，并可搭配 aweswitch 固定 agent 配置（比如用 GLM 模型启动）。

### Project Collections

- **[Awesome AI Meets Biology](https://github.com/Webioinfo01/Awesome-AI-Meets-Biology)** — AI 在生物学、生物信息学和生物医学研究中应用的精选综述。由 awescholar 驱动。
- **[Awesome AI Virtual Tumor](https://github.com/Webioinfo01/Awesome-AI-Virtual-Tumor)** — 面向虚拟肿瘤建模与仿真的前沿 AI 系统精选合集：静态模型、动态模型、agent、基准与综述。
