# Per-turn file changes (observer-side snapshots)

awefork 是会话的只读投影 + 分叉器。它回答两个问题："这条分支上发生了什么"和"换个做法呢"。分叉图回答了后者；前者目前只有聊天文本——agent 改了哪些文件看不见。对 coding agent，diff 才是本回合的本体。本设计从 SSE 观察席捕获 edit/write 工具事件，写时落快照，回合面板展示文件卡。

学自 PiX v0.0.13 的 file-changes（其设计见 PiX/docs/file-changes.md），但处境不同：PiX 拥有运行时（SDK tool_call/tool_result 钩子在执行现场），awefork 只有观察席（opencode SSE 的 message.part.updated 帧）。观察席能做八成：帧到达时立刻快照，历史 diff 不被后续编辑改写；做不到的两成诚实标注。

## 原则

1. **写时记录，不事后重建**。快照在工具事件到达那一刻落盘；之后文件再怎么改，历史 diff 不变。
2. **诚实降级**。没看到的（app 没开、分叉继承的回合、二进制、超大、首见即终态）标"未记录/未知"，不编数字。
3. **旁车数据跟着会话走**。sidecar 目录按 backend+session 键控，随会话删除而删除；不碰 agent 自己的存储。
4. **事实进描述符**。工具名、state 字段路径、终态值是版本可能改名的后端事实，进 agents/opencode.json 的封闭词汇表；行为留代码。

## 数据流

```
opencode SSE ──message.part.updated(type=tool)──▶ adapter 钩子
   │  descriptor: fileChanges.tools / stateKeyPath / filePathPaths / doneStates
   ▼
file-change-recorder（每 session 一个，内存态）
   │  首见路径 → 读盘快照 before；终态 → 快照 after + diff
   ▼
<userData>/file-changes/<backend>/<sessionId>/
   index.json   { version, messages: { [messageId]: FileChangeEntry[] } }
   <messageId>/<n>.before|.after   内容快照（一次性写入，不重写）
```

渲染层：`fileChanges(backend, sessionId)` 拉索引 → 回合面板按回合消息 id 取条目 → 文件卡（状态 + 行数）→ 展开时 `fileChangeDiff(backend, sessionId, messageId, path)` 读两份 blob 算 diff 渲染 → "打开文件"走现有 openPath。

## 状态机（recorder）

对每个 (messageId, filePath) 维护一个 entry：

- **首见**（该路径在本消息内第一次出现于任何工具部件）：立刻异步读文件 → before 快照。ENOENT 记 null（文件原本不存在）；>2MiB、含 NUL、读失败 → 状态 unknown 不存内容。
- **终态**（stateKey ∈ doneStates）：再读一次 → after 快照，计算 diff（见下），写 index + blob。
- **首见即终态**（app 中途连接、SSE 断线重连）：before 不可信 → 状态 unknown，note 说明，仅存 after。
- **同消息内重复编辑同文件**：before 只记第一次，after 覆盖为最后一次（净语义：回到原内容 → 条目从卡上消失，状态改 unchanged 并落盘时丢弃）。
- **项目外路径**：会话目录解析后判定，不在 session.directory 之下的直接丢弃。

竞态承认：首见帧到达 ≠ 工具尚未执行，SSE 有缓冲。before 快照尽最大努力，偶尔等于 after，diff 显示比真实少——接受，不谎报多。

## diff（shared/diff.ts，纯函数）

- 内容相等 → 不变（丢弃条目）。
- 公共前后缀裁剪后对中段做 LCS，生成 hunks 与 +N/−M。
- 中段超过 800 行任一侧 → totals/hunks 置 null（unknown），不硬算。
- 主进程记录时算 totals 落 index；渲染层展开时主进程算 hunks。同一模块两个消费点。

## 描述符扩展（可选段，缺省即关闭）

```json
"fileChanges": {
  "tools": ["edit", "write"],
  "stateKeyPath": "state.key",
  "filePathPaths": ["state.input.filePath", "filePath"],
  "doneStates": ["output-available", "error"]
}
```

parseOpenCodeDescriptor 对该段严格校验（closed vocabulary，未知键报错）；段缺省 → 该后端无文件变更能力。BackendCapabilities 增加 `fileChanges: boolean`（opencode = 描述符有该段；codex = false），渲染层据此隐藏文件卡。

## IPC（backend-first，遵循现有约定）

- `fileChanges(backend, sessionId)` → SessionFileChanges | null
- `fileChangeDiff(backend, sessionId, messageId, path)` → { added, removed, hunks } | null
- `deleteSession` 成功后 best-effort `rm -rf` 该会话的 file-changes 目录。

## 渲染层

- state.ts：`fileChangesBySession: Record<string, SessionFileChanges>`，随 loadSessionMessages 非阻塞加载，run settle 后刷新；按会话 id 全局键控（与 messagesBySession 同法，切后端天然隔离）。
- 新组件 `file-changes-card.vue`，挂在 branch-context 的 MessageList 与 ChatInput 之间：每条目一行（文件名、状态 chip 修改/新增/删除、+N −M），行展开显示 diff（+绿 −红），"打开文件"按钮。
- 回合内有 tracked 工具名（entry 的 tools 来自描述符，随索引返回）但无记录 → 显示一行"文件改动未记录（分叉继承或离线期间的回合）"。这是诚实降级的 UI 面。

## 范围与非目标

- 仅 opencode。codex 的 applyPatch 事件流形状不同，后续单独做。
- 不记录 shell/其他工具的改动；不做 git 回填；不做 undo。
- 快照不进模型上下文（awefork 本来就不写 agent 存储）。

## 测试

- diff：相等/新增/删除/多 hunk/前缀后缀裁剪/超限 unknown。
- 存储：读写往返、blob 落盘、清除、读时 sanitize。
- recorder：修改/新建/删除/首见即终态/项目外丢弃/同消息重复编辑净语义/二进制与超大 unknown。
- adapter：假服务器回放 tool 帧驱动 recorder 落盘（描述符可选段缺省时不挂钩）。
- renderer：脚本化 fake window.awefork，验证索引加载与回合条目暴露。
- 收口 `npm run verify` 全绿。
