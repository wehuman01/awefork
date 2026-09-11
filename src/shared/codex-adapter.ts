import { recordFork, removeFork } from "./lineage-store.js";
import type {
  AgentAdapter,
  AgentEvent,
  ChatMessage,
  ModelOption,
  PromptAttachment,
  SessionSummary,
} from "./types.js";

/**
 * codex implementation of AgentAdapter, talking to a `codex app-server`
 * child over newline JSON-RPC (the client lives in main; this structural
 * interface keeps shared/ free of node imports).
 *
 * Units: codex reports thread/turn timestamps in Unix SECONDS and item
 * lifecycle notifications in MILLISECONDS; awefork is ms everywhere, so the
 * second-based fields are converted at each read.
 *
 * Fork semantics: `thread/fork {lastTurnId}` keeps everything through that
 * turn, inclusive — exactly awefork's "keep through the turn that starts with
 * user message atMessageId". The adapter translates item id → turn id via an
 * index built from `thread/turns/list`.
 */
export interface CodexRpc {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  setNotificationHandler(handler: (method: string, params: unknown) => void): void;
}

export interface CodexAdapterOptions {
  client: CodexRpc;
  /** Path to the lineage sidecar file (per-backend). */
  lineagePath: string;
  /** CLI version from the initialize handshake; gates the fork fallback. */
  cliVersion?: string | null;
  /** One-time auth banner (codex installed but not logged in). */
  authMessage?: string | null;
}

interface CodexThread {
  id: string;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
  name?: string | null;
  preview?: string | null;
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  reasoningEffort?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

interface CodexTurn {
  id: string;
  items?: CodexItem[];
  status?: string | null;
  error?: { message?: string } | null;
  startedAt?: number;
  completedAt?: number | null;
}

interface CodexItem {
  type: string;
  id: string;
  text?: string;
  content?: { text?: string }[];
  summary?: string[];
  command?: string;
  server?: string;
  tool?: string;
}

interface CodexModel {
  id: string;
  displayName?: string | null;
  hidden?: boolean | null;
  supportedReasoningEfforts?: { reasoningEffort: string }[] | null;
  inputModalities?: string[] | null;
}

interface Paginated<T> {
  data?: T[] | null;
  nextCursor?: string | null;
}

const PAGE_LIMIT = 100;

export function createCodexAdapter(options: CodexAdapterOptions): AgentAdapter {
  const { client, lineagePath } = options;
  /** Set by subscribe; notification mapping and prompt failures emit through it. */
  let emitEvent: ((event: AgentEvent) => void) | null = null;
  /** threadId → its in-flight turn id (interrupt needs the pair). */
  const activeTurns = new Map<string, string>();
  /** threadId → itemId → containing turn id, rebuilt whenever turns load. */
  const turnIndex = new Map<string, Map<string, string>>();
  let forkFallbackLogged = false;

  const emit = (event: AgentEvent) => emitEvent?.(event);

  const secToMs = (seconds: number | null | undefined): number | null =>
    typeof seconds === "number" ? seconds * 1000 : null;

  const mapThread = (thread: CodexThread): SessionSummary => ({
    id: thread.id,
    title: thread.name || thread.preview || "(未命名会话)",
    directory: thread.cwd ?? "",
    parentSessionId: thread.forkedFromId ?? thread.parentThreadId ?? null,
    origin: thread.forkedFromId ? "fork" : thread.parentThreadId ? "subagent" : "root",
    createdAt: secToMs(thread.createdAt) ?? Date.now(),
    updatedAt: secToMs(thread.updatedAt) ?? Date.now(),
  });

  /** Walk one thread's turns pages (ascending) to the end. */
  async function listTurns(threadId: string): Promise<CodexTurn[]> {
    const turns: CodexTurn[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await client.request<Paginated<CodexTurn>>("thread/turns/list", {
        threadId,
        cursor: cursor ?? null,
        limit: PAGE_LIMIT,
        // turns/list defaults to descending; awefork's message list is oldest-first.
        sortDirection: "asc",
        itemsView: "full",
      });
      turns.push(...(page.data ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    indexTurnItems(threadId, turns);
    return turns;
  }

  function indexTurnItems(threadId: string, turns: CodexTurn[]): void {
    const index = new Map<string, string>();
    for (const turn of turns) {
      for (const item of turn.items ?? []) index.set(item.id, turn.id);
    }
    turnIndex.set(threadId, index);
  }

  /** The turn a user-message item id belongs to, fetching turns when cold. */
  async function turnOfItem(threadId: string, itemId: string): Promise<CodexTurn | null> {
    const turns = await listTurns(threadId);
    const turnId = turnIndex.get(threadId)?.get(itemId);
    if (!turnId) return null;
    return turns.find((t) => t.id === turnId) ?? null;
  }

  function reasoningText(item: CodexItem): string {
    return [...(item.content ?? []).map((part) => part.text ?? ""), ...(item.summary ?? [])]
      .join("\n\n")
      .trim();
  }

  function mapTurn(turn: CodexTurn, thread: CodexThread | null): ChatMessage[] {
    const items = turn.items ?? [];
    const startedAt = secToMs(turn.startedAt) ?? Date.now();
    const modelId = thread?.model ?? null;
    const variant = thread?.reasoningEffort ?? null;
    const rows: ChatMessage[] = [];

    const userItem = items.find((i) => i.type === "userMessage");
    if (userItem) {
      rows.push({
        id: userItem.id,
        role: "user",
        text: (userItem.content ?? [])
          .filter((c) => typeof c.text === "string")
          .map((c) => c.text)
          .join("\n")
          .trim(),
        thinking: "",
        toolNames: [],
        modelId,
        providerId: "codex",
        variant,
        attachmentNames: [],
        createdAt: startedAt,
        completedAt: null,
        finish: null,
        outputTokens: null,
        error: null,
      });
    }

    const text = items
      .filter((i) => i.type === "agentMessage" && typeof i.text === "string")
      .map((i) => i.text)
      .join("\n\n")
      .trim();
    const thinking = items
      .filter((i) => i.type === "reasoning")
      .map(reasoningText)
      .join("\n\n")
      .trim();
    const toolNames = [
      ...new Set(items.map(toolNameOfItem).filter((name): name is string => name !== null)),
    ];
    const error = turn.error?.message ?? null;
    // A turn whose assistant side produced nothing visible (yet) yields no
    // assistant row — empty rows would flicker above the live stream.
    if (text || thinking || toolNames.length > 0 || error) {
      rows.push({
        id: turn.id,
        role: "assistant",
        text,
        thinking,
        toolNames,
        modelId,
        providerId: "codex",
        variant,
        attachmentNames: [],
        createdAt: startedAt,
        completedAt: secToMs(turn.completedAt),
        finish: turn.status === "completed" ? "stop" : null,
        outputTokens: null,
        error,
      });
    }
    return rows;
  }

  /** Tool chip names for ChatMessage.toolNames, first-seen order. */
  function toolNameOfItem(item: CodexItem): string | null {
    switch (item.type) {
      case "commandExecution":
        return "shell";
      case "fileChange":
        return "patch";
      case "mcpToolCall":
        return item.server && item.tool ? `${item.server}/${item.tool}` : (item.tool ?? "mcp");
      case "dynamicToolCall":
      case "collabAgentToolCall":
        return "tool";
      case "webSearch":
        return "web";
      case "subAgentActivity":
        return "subagent";
      case "imageGeneration":
        return "image";
      default:
        return null;
    }
  }

  async function loadThread(threadId: string): Promise<CodexThread | null> {
    // Threads from thread/list come back status:notLoaded; resume loads the
    // rollout. On an already-loaded thread it is an idempotent state read.
    const resumed = await client.request<{ thread?: CodexThread }>("thread/resume", { threadId });
    return resumed?.thread ?? null;
  }

  return {
    kind: "codex",

    async listSessions() {
      const threads: CodexThread[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await client.request<Paginated<CodexThread>>("thread/list", {
          cursor: cursor ?? null,
          limit: PAGE_LIMIT,
        });
        threads.push(...(page.data ?? []));
        cursor = page.nextCursor ?? null;
      } while (cursor);
      return threads.map(mapThread).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async messages(sessionId) {
      const thread = await loadThread(sessionId);
      const turns = await listTurns(sessionId);
      return turns.flatMap((turn) => mapTurn(turn, thread));
    },

    // codex does not round-trip sent bytes; retry prefill is text-only.
    async messageAttachments() {
      return [] as PromptAttachment[];
    },

    async listModels() {
      const models: CodexModel[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await client.request<Paginated<CodexModel>>("model/list", {
          cursor: cursor ?? null,
          limit: PAGE_LIMIT,
        });
        models.push(...(page.data ?? []));
        cursor = page.nextCursor ?? null;
      } while (cursor);
      return models
        .filter((m) => !m.hidden)
        .map((m) => ({
          providerId: "codex",
          providerName: "Codex",
          modelId: m.id,
          modelName: m.displayName || m.id,
          variants: m.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [
            "low",
            "medium",
            "high",
          ],
          attachment: m.inputModalities?.includes("image") ?? false,
        }));
    },

    async createSession(directory) {
      const response = await client.request<{ thread?: CodexThread }>("thread/start", {
        cwd: directory ?? null,
      });
      const thread = response?.thread;
      if (!thread) throw new Error("codex thread/start returned no thread");
      return mapThread(thread);
    },

    async fork(sessionId, atMessageId) {
      let lastTurnId: string | null = null;
      const rollbackTurns = 0;
      if (atMessageId) {
        const turn = await turnOfItem(sessionId, atMessageId);
        if (!turn) {
          throw new Error(
            `Message ${atMessageId} not found in session ${sessionId}. Refresh the session and try again.`,
          );
        }
        lastTurnId = turn.id;
      }
      const params: Record<string, unknown> = { threadId: sessionId };
      if (lastTurnId && supportsLastTurnFork(options.cliVersion)) {
        params.lastTurnId = lastTurnId;
      }
      const response = await client.request<{ thread?: CodexThread }>("thread/fork", params);
      const thread = response?.thread;
      if (!thread) throw new Error("codex thread/fork returned no thread");
      // Version drift: the fork ran uncut; roll the copy back to the
      // requested turn count with the (deprecated but present) rollback API.
      if (lastTurnId && !supportsLastTurnFork(options.cliVersion)) {
        const turns = await listTurns(thread.id);
        const keepThrough = turns.findIndex((t) => t.id === lastTurnId);
        const drop = keepThrough >= 0 ? turns.length - (keepThrough + 1) : 0;
        if (drop > 0)
          await client.request("thread/rollback", { threadId: thread.id, numTurns: drop });
        if (!forkFallbackLogged) {
          forkFallbackLogged = true;
          console.warn(
            `codex ${options.cliVersion ?? "unknown"} lacks thread/fork.lastTurnId; degraded to fork + rollback`,
          );
        }
      }
      const summary = mapThread(thread);
      await recordFork(lineagePath, summary.id, {
        parentId: sessionId,
        atMessageId,
        createdAt: summary.createdAt,
      });
      return { ...summary, origin: "fork", parentSessionId: sessionId };
    },

    async deleteSession(sessionId) {
      await client.request("thread/delete", { threadId: sessionId });
      await removeFork(lineagePath, sessionId);
    },

    // codex has no single-message delete; the renderer hides the affordance
    // (capabilities.deleteMessage === false) and this throws if ever reached.
    async deleteMessage() {
      throw new Error("codex does not support deleting a single message");
    },

    async renameSession(sessionId, title) {
      await client.request("thread/name/set", { threadId: sessionId, name: title });
    },

    async prompt(sessionId, text, model) {
      try {
        const params: Record<string, unknown> = {
          threadId: sessionId,
          input: [{ type: "text", text }],
        };
        if (model?.modelId) params.model = model.modelId;
        if (model?.variant) params.effort = model.variant;
        const response = await client.request<{ turn?: { id?: string } }>("turn/start", params);
        if (response?.turn?.id) activeTurns.set(sessionId, response.turn.id);
      } catch (error) {
        // Request-level failures (auth, unknown thread) have no notification;
        // surface them with the session id so the renderer settles the run.
        const detail = error instanceof Error ? error.message : String(error);
        emit({
          type: "server.error",
          sessionId,
          message: `codex prompt failed: ${detail}`,
        });
      }
    },

    async abort(sessionId) {
      const turnId = activeTurns.get(sessionId);
      if (!turnId) throw new Error("该会话当前没有正在运行的回合");
      await client.request("turn/interrupt", { threadId: sessionId, turnId });
    },

    async subscribe(handler) {
      const stopped = { flag: false };
      emitEvent = (event) => {
        if (!stopped.flag) handler(event);
      };
      client.setNotificationHandler((method, params) => {
        emitCodexNotification(method, params, emit, activeTurns);
      });
      if (options.authMessage) {
        emit({ type: "server.error", message: options.authMessage });
      }
      return () => {
        stopped.flag = true;
        emitEvent = null;
        client.setNotificationHandler(() => {});
      };
    },

    dispose() {
      emitEvent = null;
      client.setNotificationHandler(() => {});
    },
  };
}

/** lastTurnId landed in codex 0.154; older CLIs take the rollback fallback. */
function supportsLastTurnFork(version: string | null | undefined): boolean {
  if (!version) return true;
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if ([major, minor, patch].some((part) => Number.isNaN(part))) return true;
  return major > 0 || minor > 154 || (minor === 154 && patch >= 0);
}

function emitCodexNotification(
  method: string,
  params: unknown,
  emit: (event: AgentEvent) => void,
  activeTurns: Map<string, string>,
): void {
  const p = (params ?? {}) as {
    threadId?: string;
    turnId?: string;
    itemId?: string;
    delta?: string;
    turn?: { id?: string; error?: { message?: string } | null };
    item?: CodexItem;
    startedAtMs?: number;
    completedAtMs?: number;
    willRetry?: boolean;
    error?: { message?: string };
    status?: { type?: string };
  };
  const threadId = typeof p.threadId === "string" ? p.threadId : null;
  switch (method) {
    case "error": {
      if (p.willRetry) break;
      const message = p.error?.message ?? "unknown codex error";
      emit({ type: "server.error", sessionId: threadId, message: `codex: ${message}` });
      break;
    }
    case "turn/started": {
      const turnId = p.turn?.id ?? null;
      if (!threadId || !turnId) break;
      activeTurns.set(threadId, turnId);
      emit({ type: "message.started", sessionId: threadId, messageId: turnId });
      break;
    }
    case "turn/completed": {
      if (!threadId) break;
      activeTurns.delete(threadId);
      if (p.turn?.error?.message) {
        emit({
          type: "server.error",
          sessionId: threadId,
          message: `codex: ${p.turn.error.message}`,
        });
      }
      emit({ type: "session.idle", sessionId: threadId });
      break;
    }
    case "thread/status/changed": {
      // The idle twin of turn/completed: handling both means a dropped frame
      // of either kind still finishes the run in UI.
      if (!threadId) break;
      if (p.status?.type === "active") {
        emit({ type: "message.started", sessionId: threadId, messageId: "" });
      } else if (p.status?.type === "idle") {
        emit({ type: "session.idle", sessionId: threadId });
      }
      break;
    }
    case "item/agentMessage/delta": {
      if (!threadId || !p.turnId || !p.itemId || typeof p.delta !== "string") break;
      emit({
        type: "message.delta",
        sessionId: threadId,
        messageId: p.turnId,
        partId: p.itemId,
        kind: "text",
        delta: p.delta,
      });
      break;
    }
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta": {
      if (!threadId || !p.turnId || !p.itemId || typeof p.delta !== "string") break;
      emit({
        type: "message.delta",
        sessionId: threadId,
        messageId: p.turnId,
        // Summary deltas are a separate part so they never splice into the
        // raw reasoning stream mid-sentence.
        partId: method === "item/reasoning/summaryTextDelta" ? `${p.itemId}:summary` : p.itemId,
        kind: "thinking",
        delta: p.delta,
      });
      break;
    }
    case "item/started":
    case "item/completed": {
      const item = p.item;
      if (!threadId || !p.turnId || !item) break;
      // Full snapshots self-heal a dropped delta; other item kinds surface
      // through the idle message reload (tool rows live on the assistant row).
      if (item.type === "agentMessage") {
        emit({
          type: "message.part",
          sessionId: threadId,
          messageId: p.turnId,
          partId: item.id,
          kind: "text",
          text: typeof item.text === "string" ? item.text : "",
          startedAt: method === "item/started" ? (p.startedAtMs ?? null) : null,
          endedAt: method === "item/completed" ? (p.completedAtMs ?? null) : null,
        });
      } else if (item.type === "reasoning") {
        emit({
          type: "message.part",
          sessionId: threadId,
          messageId: p.turnId,
          partId: item.id,
          kind: "thinking",
          text: reasoningTextOf(item),
          startedAt: method === "item/started" ? (p.startedAtMs ?? null) : null,
          endedAt: method === "item/completed" ? (p.completedAtMs ?? null) : null,
        });
      }
      break;
    }
    case "thread/started":
    case "thread/name/updated":
    case "thread/deleted":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/reverted":
    case "thread/queue/changed":
    case "thread/compacted": {
      if (threadId) emit({ type: "session.updated", sessionId: threadId });
      break;
    }
    default:
      break;
  }
}

function reasoningTextOf(item: CodexItem): string {
  return [...(item.content ?? []).map((part) => part.text ?? ""), ...(item.summary ?? [])]
    .join("\n\n")
    .trim();
}
