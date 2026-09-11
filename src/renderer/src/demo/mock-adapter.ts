/**
 * Browser-only demo adapter: the real preload bridge (window.awefork → IPC →
 * opencode) does not exist outside Electron, so `npm run demo` installs this
 * in-memory stand-in. The dataset is one hand-written fork story — enough
 * turns, branches, tools and searchable keywords to exercise the canvas,
 * story search, and branch digests without any backend running.
 *
 * The demo speaks only "opencode": backend arguments are accepted and
 * ignored, events ship as opencode-tagged envelopes, and backends() lists a
 * single entry so the top-bar switcher stays hidden outside Electron.
 *
 * Never loaded in Electron dev (preload defines window.awefork first) or in
 * production builds (import.meta.env.DEV is false).
 */

import type { BackendEventEnvelope } from "../../../shared/backend.js";
import type {
  AgentEvent,
  ArchiveState,
  ChatMessage,
  ForkRecord,
  ModelChoice,
  ModelOption,
  PromptAttachment,
  SessionSummary,
  TrashEntry,
} from "../../../shared/types.js";

interface TurnDef {
  /** User message id; assistant rows append "-r". Inherited copies keep ids. */
  id: string;
  prompt: string;
  reply: string;
  tools?: string[];
  tokens?: number;
  /** Minutes before "now" this turn ran; keeps relative times realistic. */
  minutesAgo: number;
  /** Defaults to flash; pro turns pass "glm-5.3". */
  model?: string;
  /** Reasoning-effort variant the turn ran with, when one was picked. */
  variant?: string;
  /** A file the prompt carried, shown as an attachment chip. */
  attachment?: string;
}

interface SessionDef {
  id: string;
  title: string;
  origin: "root" | "fork";
  parent: string | null;
  /** Fork keeps the parent's turns through this one (awefork semantics). */
  atMessageId: string | null;
  turns: TurnDef[];
  minutesAgo: number;
  /** Project directory; defaults to DIRECTORY so old defs stay one-liners. */
  directory?: string;
}

const DIRECTORY = "/demo/shop-api";
/** A second project — exercises cross-directory jumps (favorites shelf). */
const DIRECTORY_2 = "/demo/web-app";

const SESSION_DEFS: SessionDef[] = [
  {
    id: "s-root",
    title: "登录接口重构",
    origin: "root",
    parent: null,
    atMessageId: null,
    minutesAgo: 1560,
    turns: [
      {
        id: "r1",
        prompt: "老登录接口有什么问题？先梳理现状",
        reply:
          "三个问题：密码用明文 MD5 存储、登录接口没有限流、每次请求都查两次数据库。先从密码哈希入手。",
        minutesAgo: 1560,
      },
      {
        id: "r2",
        prompt: "把密码哈希迁移到 argon2，写迁移脚本",
        reply:
          "迁移脚本 migration_007_argon2.sql 已写好：双写窗口一周，老用户首次登录时自动升级哈希。\n\n```sql\nALTER TABLE users ADD COLUMN argon2_hash TEXT;\n-- 双写窗口：两个哈希并存，登录验证成功后回填\nUPDATE users SET argon2_hash = argon2(mdw_password) WHERE id = ?;\n```\n\n上线分三步：\n1. 先发**双写**版本，观察一周\n2. 再切**读新写**，老哈希只兜底\n3. 最后 `DROP COLUMN` 收尾",
        tools: ["write", "bash"],
        tokens: 2100,
        minutesAgo: 1500,
      },
      {
        id: "r3",
        prompt: "JWT 和 session 两版方案对比一下",
        reply:
          "两版方案的关键差异：\n\n| 维度 | JWT | session |\n| --- | :---: | ---: |\n| 网关查库 | 不用 | 每次查 redis |\n| 吊销 | 麻烦（黑名单） | 即删键 |\n| 过期 | 15 分钟 | 滑动 30 分钟 |\n\n> 登录 QPS 高的话 JWT 省一次 redis 往返；风控要求即时登出就选 session。\n\n详见 [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519)。",
        minutesAgo: 1440,
      },
      {
        id: "r4",
        prompt: "先按 JWT 落地，access token 15 分钟过期",
        reply:
          "签发逻辑在 auth/jwt.go：HS256，secret 走环境变量。网关验签后把 user id 塞进 header。",
        tools: ["edit", "bash"],
        tokens: 3400,
        minutesAgo: 1380,
        model: "glm-5.3",
        variant: "high",
      },
      {
        id: "r5",
        prompt: "给登录接口加压测，500 并发",
        reply:
          "k6 跑完，结果分两档：\n\n- **成功路径**：P95 312ms，错误率 0.2%\n  - 其中 bcrypt 验证占 180ms（大头）\n  - redis 往返 4ms\n- **打满之后**：登录 QPS 到 2400，redis 连接池耗尽，开始排队\n\n瓶颈排序：`bcrypt` > 连接池 > 网关 CPU。",
        tools: ["bash"],
        tokens: 1800,
        minutesAgo: 900,
        attachment: "k6-login-500c.png",
      },
      {
        id: "r6",
        prompt: "修一下压测里发现的内存泄漏",
        reply:
          "泄漏点在限流器：每个 IP 一条 map 记录，永不过期。改成带 TTL 的 LRU 后，峰值内存从 1.2G 降到 90M。",
        tools: ["read", "edit"],
        tokens: 2600,
        minutesAgo: 840,
        model: "glm-5.3",
      },
      {
        id: "r7",
        prompt: "补 e2e：忘记密码流程",
        reply:
          "cypress 里加了 reset-password.spec.ts，覆盖过期 token、错误旧密码、连续失败锁定三种情况。",
        tools: ["write"],
        tokens: 1500,
        minutesAgo: 780,
      },
    ],
  },
  {
    id: "s-jwt",
    title: "JWT 路线",
    origin: "fork",
    parent: "s-root",
    atMessageId: "r3",
    minutesAgo: 1400,
    turns: [
      {
        id: "j1",
        prompt: "刷新令牌存哪里？redis 还是数据库",
        reply:
          "存数据库 refresh_token 表：user_id、token_hash、expires_at、rotated_from。redis 只放黑名单缓存，数据库是事实源，重启不丢。",
        minutesAgo: 1380,
      },
      {
        id: "j2",
        prompt: "实现刷新令牌轮换",
        reply:
          "每次刷新作废旧 token、签发新的一对；rotated_from 记录链路，检测到已轮换的 token 被复用就整链作废。",
        tools: ["edit", "bash"],
        tokens: 2900,
        minutesAgo: 1320,
        model: "glm-5.3",
      },
      {
        id: "j3",
        prompt: "刷新接口也压测一下",
        reply:
          "k6 结果：500 并发 P95 145ms，比登录快一倍（没有 bcrypt）。数据库连接池要到 3200 QPS 才紧张。",
        tools: ["bash"],
        tokens: 1700,
        minutesAgo: 1260,
      },
    ],
  },
  {
    id: "s-sso",
    title: "JWT → 接公司 SSO",
    origin: "fork",
    parent: "s-jwt",
    atMessageId: "j2",
    minutesAgo: 1300,
    turns: [
      {
        id: "o1",
        prompt: "能不能把 JWT 换成 OIDC，接公司 SSO",
        reply:
          "可以：只换签发方，业务侧仍拿 id_token 换本地会话。需要先找平台组申请 client_id，回调域名要备案。",
        minutesAgo: 1280,
      },
      {
        id: "o2",
        prompt: "SSO 沙箱环境跑通了",
        reply:
          "授权码模式跑通，本地会话 TTL 跟 access token 对齐。遗留：登出时 SSO 侧不会吊销，需要 front-channel logout。",
        tools: ["bash", "read"],
        tokens: 2200,
        minutesAgo: 1200,
        model: "glm-5.3",
      },
    ],
  },
  {
    id: "s-session",
    title: "Session 路线",
    origin: "fork",
    parent: "s-root",
    atMessageId: "r3",
    minutesAgo: 1430,
    turns: [
      {
        id: "c1",
        prompt: "session 存 redis，键怎么设计",
        reply:
          "键 sess:{sid}，值是 user id + 角色，TTL 30 分钟滑动续期。记住我 = 持久 cookie + 30 天 TTL。",
        minutesAgo: 1400,
      },
      {
        id: "c2",
        prompt: "session 方案的压测结果",
        reply:
          "500 并发 P95 268ms，redis 往返 4ms 占比很小。比 JWT 路线慢一点，但登出即时生效，风控要求能满足。",
        tools: ["bash"],
        tokens: 1600,
        minutesAgo: 1340,
        model: "glm-5.3",
      },
    ],
  },
  {
    id: "s-repro",
    title: "压测复现分支",
    origin: "fork",
    parent: "s-root",
    atMessageId: "r5",
    minutesAgo: 880,
    turns: [],
  },
  {
    id: "w-root",
    title: "官网首页改版",
    origin: "root",
    parent: null,
    atMessageId: null,
    directory: DIRECTORY_2,
    minutesAgo: 500,
    turns: [
      {
        id: "w1",
        prompt: "首页 hero 区怎么改？给三个方向",
        reply:
          "三个方向：① 全屏视频背景 + 一句话价值主张；② 交互式产品演示首屏；③ 客户 logo 墙前置 + 数据说话。推荐 ①，制作成本低、观感提升最明显。",
        minutesAgo: 500,
      },
      {
        id: "w2",
        prompt: "按方向一搭 hero 区骨架",
        reply:
          "hero 区骨架已搭好：全屏 video 标签兜底 poster 图，标题 clamp() 自适应，CTA 按钮双份（主次），滚动提示箭头带浮动动画。",
        tools: ["write"],
        tokens: 1200,
        minutesAgo: 460,
      },
    ],
  },
  {
    id: "w-copy",
    title: "首页文案分支",
    origin: "fork",
    parent: "w-root",
    atMessageId: "w1",
    directory: DIRECTORY_2,
    minutesAgo: 470,
    turns: [
      {
        id: "wc1",
        prompt: "价值主张再狠一点，突出“十分钟上线”",
        reply:
          "改好了：“十分钟，把想法变成上线的产品”作为主标题，副标题承接部署速度与零配置。附三组 A/B 备选。",
        tools: ["edit"],
        tokens: 700,
        minutesAgo: 465,
      },
    ],
  },
];

const MODELS: ModelOption[] = [
  {
    providerId: "oc-awerouter",
    providerName: "awerouter",
    modelId: "glm-5.3-flash",
    modelName: "GLM 5.3 Flash",
    variants: ["low", "medium", "high"],
    attachment: true,
  },
  {
    providerId: "oc-awerouter",
    providerName: "awerouter",
    modelId: "glm-5.3",
    modelName: "GLM 5.3",
    variants: ["minimal", "low", "medium", "high", "xhigh"],
    attachment: true,
  },
  {
    providerId: "oc-local",
    providerName: "Ollama 本地",
    modelId: "qwen3-coder",
    modelName: "Qwen3 Coder 30B",
    variants: [],
    attachment: false,
  },
];

const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000;

function turnMessages(turn: TurnDef): ChatMessage[] {
  const model = turn.model ?? "glm-5.3-flash";
  const createdAt = minutesAgo(turn.minutesAgo);
  const durationMs = 20_000 + (turn.tokens ?? 800) * 30;
  return [
    {
      id: turn.id,
      role: "user",
      text: turn.prompt,
      thinking: "",
      toolNames: [],
      modelId: model,
      providerId: "oc-awerouter",
      variant: turn.variant ?? null,
      attachmentNames: turn.attachment ? [turn.attachment] : [],
      createdAt,
      completedAt: null,
      finish: null,
      outputTokens: null,
      error: null,
    },
    {
      id: `${turn.id}-r`,
      role: "assistant",
      text: turn.reply,
      thinking: "",
      toolNames: turn.tools ?? [],
      modelId: model,
      providerId: "oc-awerouter",
      variant: turn.variant ?? null,
      attachmentNames: [],
      createdAt: createdAt + 2000,
      completedAt: createdAt + 2000 + durationMs,
      finish: "stop",
      outputTokens: turn.tokens ?? 800,
      error: null,
    },
  ];
}

/** Full turn list of a session: the inherited prefix (fork cut applied) plus its own. */
function sessionTurns(defs: Map<string, SessionDef>, id: string): TurnDef[] {
  const def = defs.get(id);
  if (!def) return [];
  // Always hand out a copy: the fork cut below splices the parent's list.
  const own = [...def.turns];
  if (!def.parent) return own;
  const parentTurns = sessionTurns(defs, def.parent);
  if (def.atMessageId) {
    const cut = parentTurns.findIndex((t) => t.id === def.atMessageId);
    if (cut >= 0) parentTurns.splice(cut + 1);
  }
  return [...parentTurns, ...own];
}

export function installMockAdapter(): void {
  const defs = new Map(SESSION_DEFS.map((d) => [d.id, { ...d, turns: [...d.turns] }]));
  const lineage: Record<string, ForkRecord> = {};
  for (const def of defs.values()) {
    if (def.parent) {
      lineage[def.id] = {
        parentId: def.parent,
        atMessageId: def.atMessageId,
        createdAt: minutesAgo(def.minutesAgo),
      };
    }
  }

  const messages = new Map<string, ChatMessage[]>();
  const ensureMessages = (id: string): ChatMessage[] => {
    let list = messages.get(id);
    if (!list) {
      list = sessionTurns(defs, id).flatMap(turnMessages);
      messages.set(id, list);
    }
    return list;
  };
  for (const id of defs.keys()) ensureMessages(id);

  const summaries = (): SessionSummary[] =>
    [...defs.values()].map((def) => {
      const list = ensureMessages(def.id);
      const lastAt = list.length > 0 ? (list[list.length - 1]?.createdAt ?? 0) : 0;
      return {
        id: def.id,
        title: def.title,
        directory: def.directory ?? DIRECTORY,
        parentSessionId: def.parent,
        origin: def.origin,
        createdAt: minutesAgo(def.minutesAgo),
        updatedAt: Math.max(lastAt, minutesAgo(def.minutesAgo)),
      };
    });

  let pins: string[] = [];
  let trash: TrashEntry[] = [];
  let archive: ArchiveState = { sessions: [], directories: [] };
  const handlers = new Set<(envelope: BackendEventEnvelope) => void>();
  const emit = (event: AgentEvent): void => {
    for (const handler of handlers) handler({ backend: "opencode", event });
  };
  let promptSeq = 0;
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();

  window.awefork = {
    ready: async () => ({ ok: true }),
    sessions: async () => ({ sessions: summaries(), lineage: { ...lineage } }),
    messages: async (_backend, sessionId) => ensureMessages(sessionId).map((m) => ({ ...m })),
    // The demo keeps only attachment names; hand back readable stand-ins so
    // the retry prefill path still shows chips and resends.
    messageAttachments: async (_backend, sessionId, messageId) => {
      const message = ensureMessages(sessionId).find((m) => m.id === messageId);
      return (message?.attachmentNames ?? []).map((name) => ({
        mime: "text/plain",
        filename: name,
        dataUrl: `data:text/plain;base64,${btoa(`demo:${name}`)}`,
      }));
    },
    models: async () => MODELS,
    createSession: async (_backend, directory) => {
      promptSeq += 1;
      const id = `demo-new-${promptSeq}`;
      defs.set(id, {
        id,
        title: "新对话",
        origin: "root",
        parent: null,
        atMessageId: null,
        turns: [],
        minutesAgo: 0,
        directory: directory ?? DIRECTORY,
      });
      const created = summaries().find((s) => s.id === id);
      if (!created) throw new Error(`demo session ${id} missing after creation`);
      return created;
    },
    fork: async (_backend, sessionId, atMessageId) => {
      promptSeq += 1;
      const parent = defs.get(sessionId);
      const id = `demo-fork-${promptSeq}`;
      defs.set(id, {
        id,
        title: `${parent?.title ?? "会话"} 的分支`,
        origin: "fork",
        parent: sessionId,
        atMessageId,
        turns: [],
        minutesAgo: 0,
      });
      lineage[id] = { parentId: sessionId, atMessageId, createdAt: Date.now() };
      const created = summaries().find((s) => s.id === id);
      if (!created) throw new Error(`demo fork ${id} missing after creation`);
      return created;
    },
    deleteSession: async (_backend, sessionId) => {
      defs.delete(sessionId);
      messages.delete(sessionId);
      delete lineage[sessionId];
      pins = pins.filter((id) => id !== sessionId);
      return pins;
    },
    deleteMessage: async (_backend, sessionId, messageId) => {
      const list = ensureMessages(sessionId);
      const index = list.findIndex((m) => m.id === messageId);
      if (index >= 0) list.splice(index, 1);
    },
    prompt: async (_backend, sessionId, text, model, attachments) => {
      promptSeq += 1;
      const user: ChatMessage = {
        id: `p${promptSeq}`,
        role: "user",
        text,
        thinking: "",
        toolNames: [],
        modelId: model?.modelId ?? "glm-5.3-flash",
        providerId: model?.providerId ?? "oc-awerouter",
        variant: model?.variant ?? null,
        attachmentNames: (attachments ?? []).map((a) => a.filename),
        createdAt: Date.now(),
        completedAt: null,
        finish: null,
        outputTokens: null,
        error: null,
      };
      const reply = `演示模式：这是一条模拟回复（真实环境里会走你的 opencode 后端）。你问的是「${text.slice(0, 40)}」——切到真的 npm run dev 就能拿到流式真回复。`;
      const thinking = "**组织回答**\n我先梳理用户的问题，再组织一段清晰、可执行的回答。";
      const assistant: ChatMessage = {
        id: `p${promptSeq}-r`,
        role: "assistant",
        text: reply,
        thinking,
        toolNames: [],
        modelId: model?.modelId ?? "glm-5.3-flash",
        providerId: model?.providerId ?? "oc-awerouter",
        variant: model?.variant ?? null,
        attachmentNames: [],
        createdAt: Date.now(),
        completedAt: Date.now() + 3500,
        finish: "stop",
        outputTokens: 900,
        error: null,
      };
      emit({ type: "message.started", sessionId, messageId: assistant.id });
      const pending = timers.get(sessionId) ?? [];
      const runStart = Date.now();
      const thinkingPartId = `${assistant.id}-th`;
      const textPartId = `${assistant.id}-tx`;
      const thinkingChunks = thinking.match(/.{1,14}/g) ?? [];
      const chunks = reply.match(/.{1,18}/g) ?? [];
      const textStartDelay = 600 + thinkingChunks.length * 300;
      thinkingChunks.forEach((chunk, i) => {
        pending.push(
          setTimeout(
            () => {
              emit({
                type: "message.delta",
                sessionId,
                messageId: assistant.id,
                partId: thinkingPartId,
                kind: "thinking",
                delta: chunk,
              });
            },
            300 + i * 300,
          ),
        );
      });
      // reasoning-end snapshot: flips the live block into its collapsed
      // `Thought: title · duration` summary, like a real opencode run
      pending.push(
        setTimeout(() => {
          emit({
            type: "message.part",
            sessionId,
            messageId: assistant.id,
            partId: thinkingPartId,
            kind: "thinking",
            text: thinking,
            startedAt: runStart + 300,
            endedAt: runStart + textStartDelay,
          });
        }, textStartDelay),
      );
      chunks.forEach((chunk, i) => {
        pending.push(
          setTimeout(
            () => {
              emit({
                type: "message.delta",
                sessionId,
                messageId: assistant.id,
                partId: textPartId,
                kind: "text",
                delta: chunk,
              });
            },
            textStartDelay + i * 300,
          ),
        );
      });
      pending.push(
        setTimeout(
          () => {
            timers.delete(sessionId);
            ensureMessages(sessionId).push(user, assistant);
            emit({ type: "session.updated", sessionId });
            emit({ type: "session.idle", sessionId });
          },
          textStartDelay + chunks.length * 300 + 400,
        ),
      );
      timers.set(sessionId, pending);
    },
    abort: async (_backend, sessionId) => {
      for (const timer of timers.get(sessionId) ?? []) clearTimeout(timer);
      timers.delete(sessionId);
      emit({ type: "session.idle", sessionId });
    },
    respondInteraction: async () => {
      // The in-memory demo never leaves an interaction pending, so there is
      // nothing to reply to — the API surface demands the method, and the
      // demo's no-op keeps the mock a byte-identical AweforkApi.
    },
    renameSession: async (_backend, sessionId, title) => {
      const def = defs.get(sessionId);
      if (def) def.title = title;
    },
    pins: async () => pins,
    togglePin: async (_backend, sessionId) => {
      pins = pins.includes(sessionId)
        ? pins.filter((id) => id !== sessionId)
        : [...pins, sessionId];
      return pins;
    },
    trash: async () => trash,
    trashAdd: async (_backend, sessionId, title) => {
      trash = [
        ...trash.filter((t) => t.id !== sessionId),
        { id: sessionId, title, deletedAt: Date.now() },
      ];
      return trash;
    },
    trashRemove: async (_backend, sessionId) => {
      trash = trash.filter((t) => t.id !== sessionId);
      return trash;
    },
    archive: async () => archive,
    archiveAdd: async (_backend, kind, key) => {
      archive =
        kind === "session"
          ? {
              ...archive,
              sessions: [
                ...archive.sessions.filter((e) => e.id !== key),
                { id: key, archivedAt: Date.now() },
              ],
            }
          : {
              ...archive,
              directories: [
                ...archive.directories.filter((e) => e.path !== key),
                { path: key, archivedAt: Date.now() },
              ],
            };
      return archive;
    },
    archiveRemove: async (_backend, kind, key) => {
      archive =
        kind === "session"
          ? { ...archive, sessions: archive.sessions.filter((e) => e.id !== key) }
          : { ...archive, directories: archive.directories.filter((e) => e.path !== key) };
      return archive;
    },
    // The demo speaks opencode only: one switcher entry hides the control,
    // and its capability surface is the full one.
    backends: async () => ({
      selected: "opencode",
      backends: [
        { id: "opencode", label: "opencode", installed: true, version: null, versionWarning: null },
      ],
    }),
    selectBackend: async () => ({ ok: true }),
    capabilities: async () => ({ deleteMessage: true, attachments: true }),
    openExternal: async (url) => {
      window.open(url, "_blank", "noopener");
    },
    // The demo runs in a plain browser tab; there is no sidecar to keep.
    composer: async () => null,
    saveComposer: async () => undefined,
    openPath: async (target) => ({ ok: false, error: `demo 无法打开本地路径：${target}` }),
    convertDocument: async (filename) => `（demo：${filename} 提取出的文本内容）`,
    // The demo app never has anything newer than itself: no banner, no skip.
    checkUpdates: async () => ({
      currentVersion: "0.1.6",
      latest: null,
      updateAvailable: false,
    }),
    skipUpdate: async () => ({ ok: true }),
    openRelease: async () => ({ ok: true }),
    onEvent: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
