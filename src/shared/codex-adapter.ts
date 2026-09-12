import { recordFork, removeFork } from "./lineage-store.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentInteractionRequest,
  AgentInteractionResponse,
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
  setRequestHandler?: (
    handler?: (method: string, params: unknown) => unknown | Promise<unknown>,
  ) => void;
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
  /**
   * Reasoning/userMessage content. Codex 0.154 sends reasoning content as
   * plain string[]; some builds wrap it as {text}[] — both are accepted.
   */
  content?: (string | { text?: string })[];
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

interface PendingInteraction {
  method: string;
  resolve: (result: unknown) => void;
}

/**
 * Shared with main's codex-server (its startup banner uses the same line) so
 * a run-time auth failure and the connect-time banner read identically.
 */
export const CODEX_NOT_LOGGED_IN_MESSAGE = "codex 未登录或无可用账号：请先在终端运行 codex login";

/** Shown when another codex process owns the thread's writer. */
export const OWNED_ELSEWHERE_MESSAGE =
  "该会话正被另一个 codex 实例写入（例如 aweswitch 里的会话），暂时无法继续；关闭那边后再试";

const PAGE_LIMIT = 100;

export function createCodexAdapter(options: CodexAdapterOptions): AgentAdapter {
  const { client, lineagePath } = options;
  /** Set by subscribe; notification mapping and prompt failures emit through it. */
  let emitEvent: ((event: AgentEvent) => void) | null = null;
  /** threadId → its in-flight turn id (interrupt needs the pair). */
  const activeTurns = new Map<string, string>();
  /** threadId → itemId → containing turn id, rebuilt whenever turns load. */
  const turnIndex = new Map<string, Map<string, string>>();
  const pendingInteractions = new Map<string, PendingInteraction>();
  let nextInteractionId = 1;
  let forkFallbackLogged = false;

  const emit = (event: AgentEvent) => emitEvent?.(event);

  /**
   * A failed turn/start may be auth, but the RPC error text can't say which.
   * Re-read the account: only a null account counts as logged out — codex
   * 0.154 reports requiresOpenaiAuth: true alongside a valid account (it is
   * the provider's "uses OpenAI auth" config flag, not a login flag). No
   * extra reconnect probing lives here: ensureCodexServer re-probes
   * account/read on every respawn, so once the user logs in the next codex
   * call spins up a fresh child whose subscribe re-announces the (now clear)
   * banner.
   */
  const authFailureDetail = async (): Promise<string | null> => {
    try {
      const account = await client.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>(
        "account/read",
        {},
        10_000,
      );
      if (!account?.account) {
        return CODEX_NOT_LOGGED_IN_MESSAGE;
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A probe that died with the connection says nothing about login
      // state — the raw failure (and the outage toast) tells that story;
      // wrapping it as "not logged in" would send the user after codex
      // login for a crashed app-server.
      if (message.includes("connection lost") || message.includes("not connected")) return null;
      return `${CODEX_NOT_LOGGED_IN_MESSAGE}（${message}）`;
    }
  };

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

  /**
   * Walk one thread's turns pages (ascending) to the end.
   *
   * codex 0.154 keeps paginated threads' turns in a per-home sqlite store and
   * only projects a rollout into it on write operations, so a thread whose
   * rollout predates this home (a copy imported from an aweswitch account
   * home) lists zero turns until something loads it. Resuming once on the
   * empty first walk covers both browsing (messages) and fork's item lookup;
   * a refused resume (a live writer elsewhere) keeps the empty result, which
   * is what a genuinely empty new thread looks like anyway.
   *
   * A harder case stays open here: a never-loaded thread forked in the TUI
   * lists its forked-from PREFIX — reconstructed from the parent's rollout —
   * while its own post-fork turns stay invisible until the rollout loads.
   * That walk is non-empty, so the resume above never fires; turnOfItem
   * closes the gap for fork. Plain browsing keeps the truncated view rather
   * than taking the writer just to read.
   */
  async function listTurns(threadId: string): Promise<CodexTurn[]> {
    const walk = async (): Promise<CodexTurn[]> => {
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
      return turns;
    };
    let turns = await walk();
    if (turns.length === 0) {
      try {
        await resumeThread(threadId);
        turns = await walk();
      } catch {
        // Browse must stay read-only against a thread another writer owns;
        // the retry is only for this home's own cold copies.
      }
    }
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

  /**
   * The turn a user-message item id belongs to, fetching turns when cold.
   *
   * A miss is not final: on a never-loaded forked thread, turns/list serves
   * only the forked-from prefix (see listTurns), so the anchor turn is among
   * the thread's own invisible turns. Loading the rollout once via
   * thread/resume brings them up — legitimate here because every caller is a
   * write-intending operation (fork), not a browse. A refused resume keeps
   * the miss, except a writer conflict, which explains itself instead of
   * masquerading as "message not found".
   */
  async function turnOfItem(threadId: string, itemId: string): Promise<CodexTurn | null> {
    const lookup = async (): Promise<CodexTurn | null> => {
      const turns = await listTurns(threadId);
      const turnId = turnIndex.get(threadId)?.get(itemId);
      if (!turnId) return null;
      return turns.find((t) => t.id === turnId) ?? null;
    };
    const direct = await lookup();
    if (direct) return direct;
    try {
      await resumeThread(threadId);
    } catch (error) {
      if (isWriterConflict(error)) throw new Error(OWNED_ELSEWHERE_MESSAGE);
      return null;
    }
    return lookup();
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
          .map((part) => (typeof part === "string" ? part : part.text))
          .filter((text): text is string => typeof text === "string")
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
      .map(reasoningTextOf)
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

  /**
   * Read a thread's metadata WITHOUT taking its writer.
   *
   * codex 0.154 gives each thread one exclusive writer, guarded by a lock
   * file under `$CODEX_HOME/thread-writer-locks/`. `thread/resume` takes
   * that lock, so opening a session that a live codex session already owns
   * (an aweswitch per-account terminal, say) fails with "thread ... already
   * has an active writer". Browsing history must never write, so reads go
   * through `thread/read`, which returns the same thread object while
   * another writer holds the thread.
   */
  async function readThread(threadId: string): Promise<CodexThread | null> {
    if (!supportsThreadRead(options.cliVersion)) return resumeThread(threadId);
    try {
      const read = await client.request<{ thread?: CodexThread }>("thread/read", { threadId });
      return read?.thread ?? null;
    } catch {
      // An older-than-advertised CLI, or a thread/read that failed for a
      // reason resume would report better: either way resume is the shape
      // awefork used before, and it raises a real error if the thread is gone.
      return resumeThread(threadId);
    }
  }

  /** Take the thread's writer. Only for calls that append to the rollout. */
  async function resumeThread(threadId: string): Promise<CodexThread | null> {
    // Threads from thread/list come back status:notLoaded; resume loads the
    // rollout. On an already-loaded thread it is an idempotent state read.
    const resumed = await client.request<{ thread?: CodexThread }>("thread/resume", { threadId });
    return resumed?.thread ?? null;
  }

  /**
   * A refused writer is a real, actionable state: another codex process
   * (typically an aweswitch session) owns the thread. Say so rather than
   * echoing codex's wording about writers and locks.
   */
  function isWriterConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("already has an active writer");
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
      const thread = await readThread(sessionId);
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
      const params: Record<string, unknown> = {
        threadId: sessionId,
        input: [{ type: "text", text }],
      };
      if (model?.modelId) params.model = model.modelId;
      if (model?.variant) params.effort = model.variant;
      try {
        // turn/start only sees threads this server has loaded, and reading a
        // thread no longer loads it (readThread deliberately avoids the
        // writer). Taking the writer here is correct: a turn appends to the
        // rollout. Idempotent when the thread is already loaded.
        await resumeThread(sessionId);
        const response = await client.request<{ turn?: { id?: string } }>("turn/start", params);
        if (response?.turn?.id) activeTurns.set(sessionId, response.turn.id);
      } catch (error) {
        // Request-level failures (auth, unknown thread) have no notification;
        // surface them with the session id so the renderer settles the run —
        // then rethrow: the renderer arms its completion watchdog only after
        // prompt() resolves, so a swallowed error would leave a phantom run
        // polling for a turn that never started.
        const detail = error instanceof Error ? error.message : String(error);
        const authDetail = await authFailureDetail();
        emit({
          type: "server.error",
          sessionId,
          message: isWriterConflict(error)
            ? OWNED_ELSEWHERE_MESSAGE
            : (authDetail ?? `codex prompt failed: ${detail}`),
        });
        throw error instanceof Error ? error : new Error(detail);
      }
    },

    async respondInteraction(requestId, response) {
      const pending = pendingInteractions.get(requestId);
      if (!pending) return;
      pendingInteractions.delete(requestId);
      pending.resolve(interactionReply(pending.method, response));
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
      client.setRequestHandler?.((method, params) => {
        const requestId = `codex-interaction-${nextInteractionId++}`;
        const request = interactionRequest(requestId, method, params);
        if (!request) {
          // Unmappable or malformed params: refuse the request over the wire
          // AND toast it — a silent refusal would look like a hung turn.
          emit({
            type: "server.error",
            message: `codex 请求了 awefork 无法展示的交互（${method}），已拒绝`,
          });
          return Promise.reject(new Error(`awefork 无法处理 codex 请求 ${method}`));
        }
        return new Promise<unknown>((resolve) => {
          pendingInteractions.set(requestId, { method, resolve });
          emit({ type: "interaction.requested", request });
        });
      });
      if (options.authMessage) {
        emit({ type: "server.error", message: options.authMessage });
      }
      return () => {
        stopped.flag = true;
        emitEvent = null;
        pendingInteractions.clear();
        client.setNotificationHandler(() => {});
        client.setRequestHandler?.(undefined);
      };
    },

    dispose() {
      emitEvent = null;
      pendingInteractions.clear();
      client.setNotificationHandler(() => {});
      client.setRequestHandler?.(undefined);
    },
  };
}

/**
 * CLI version gate. Anything unparseable or unknown assumes the newest
 * behavior: awefork would rather try the modern call and fail loudly than
 * silently take a degraded path.
 */
function atLeastCodex(version: string | null | undefined, minor: number, patch: number): boolean {
  if (!version) return true;
  const [major = 0, minorPart = 0, patchPart = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if ([major, minorPart, patchPart].some((part) => Number.isNaN(part))) return true;
  if (major !== 0) return true;
  return minorPart > minor || (minorPart === minor && patchPart >= patch);
}

/** lastTurnId landed in codex 0.154; older CLIs take the rollback fallback. */
function supportsLastTurnFork(version: string | null | undefined): boolean {
  return atLeastCodex(version, 154, 0);
}

/**
 * `thread/read` landed in codex 0.154 — the same release that introduced the
 * per-thread writer lock, so a CLI without thread/read is a CLI whose resume
 * cannot collide.
 */
function supportsThreadRead(version: string | null | undefined): boolean {
  return atLeastCodex(version, 154, 0);
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
        const startedAt = method === "item/started" ? (p.startedAtMs ?? null) : null;
        const endedAt = method === "item/completed" ? (p.completedAtMs ?? null) : null;
        // The snapshot pair mirrors the delta pair above: raw content in the
        // item's own part, summaries in the :summary part. Folding the
        // summary into the main part's snapshot too would render it twice
        // for as long as the live stream is on screen (the idle reload
        // joins them into one thinking field).
        emit({
          type: "message.part",
          sessionId: threadId,
          messageId: p.turnId,
          partId: item.id,
          kind: "thinking",
          text: reasoningContentOf(item),
          startedAt,
          endedAt,
        });
        const summary = reasoningSummaryOf(item);
        if (summary) {
          emit({
            type: "message.part",
            sessionId: threadId,
            messageId: p.turnId,
            partId: `${item.id}:summary`,
            kind: "thinking",
            text: summary,
            startedAt,
            endedAt,
          });
        }
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

/**
 * Reasoning text helpers. Codex 0.154's `content` is string[] (older builds
 * sent {text}[] — both accepted); summaries are always string[]. The join for
 * the persisted thinking field keeps content and summary in that order.
 */
function reasoningContentOf(item: CodexItem): string {
  return (item.content ?? [])
    .map((part) => (typeof part === "string" ? part : (part.text ?? "")))
    .join("\n\n")
    .trim();
}

function reasoningSummaryOf(item: CodexItem): string {
  return (item.summary ?? []).join("\n\n").trim();
}

function reasoningTextOf(item: CodexItem): string {
  return [reasoningContentOf(item), reasoningSummaryOf(item)].filter(Boolean).join("\n\n");
}

function interactionRequest(
  requestId: string,
  method: string,
  params: unknown,
): AgentInteractionRequest | null {
  const p = (params ?? {}) as Record<string, unknown>;
  const sessionId = typeof p.threadId === "string" ? p.threadId : null;
  const reason = typeof p.reason === "string" ? p.reason : undefined;
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = typeof p.command === "string" ? p.command : "";
      if (!command) return null;
      return {
        requestId,
        sessionId,
        kind: "command-approval",
        title: "允许执行命令？",
        detail: reason ?? "Codex 请求执行一条命令。",
        command,
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        reason,
      };
    }
    case "item/fileChange/requestApproval":
      return {
        requestId,
        sessionId,
        kind: "file-approval",
        title: "允许修改文件？",
        detail: reason ?? "Codex 请求修改文件。",
        grantRoot: typeof p.grantRoot === "string" ? p.grantRoot : undefined,
        reason,
      };
    case "item/permissions/requestApproval":
      return {
        requestId,
        sessionId,
        kind: "permission-approval",
        title: "允许额外权限？",
        detail: reason ?? "Codex 请求扩大本回合权限。",
        requested: permissionSummary(p.permissions),
        reason,
      };
    case "item/tool/requestUserInput": {
      const questions = Array.isArray(p.questions)
        ? p.questions.flatMap((question) => {
            const q = question as Record<string, unknown>;
            const id = typeof q.id === "string" ? q.id : null;
            const questionText = typeof q.question === "string" ? q.question : null;
            if (!id || !questionText) return [];
            return [
              {
                id,
                header: typeof q.header === "string" ? q.header : "需要你的输入",
                question: questionText,
                options: Array.isArray(q.options)
                  ? q.options.flatMap((option) => {
                      const o = option as Record<string, unknown>;
                      return typeof o.label === "string"
                        ? [
                            {
                              label: o.label,
                              description: typeof o.description === "string" ? o.description : "",
                            },
                          ]
                        : [];
                    })
                  : undefined,
                isSecret: q.isSecret === true,
              },
            ];
          })
        : [];
      if (questions.length === 0) return null;
      return {
        requestId,
        sessionId,
        kind: "user-input",
        title: "Codex 需要你的输入",
        detail: reason ?? "",
        questions,
      };
    }
    case "mcpServer/elicitation/request":
      return {
        requestId,
        sessionId,
        kind: "mcp-elicitation",
        title: "MCP 服务请求输入",
        detail: typeof p.message === "string" ? p.message : (reason ?? ""),
        serverName: typeof p.serverName === "string" ? p.serverName : "MCP",
      };
    default:
      return null;
  }
}

function interactionReply(method: string, response: AgentInteractionResponse): unknown {
  const allowed = response.decision === "allow";
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: allowed ? "accept" : "decline" };
    case "item/permissions/requestApproval":
      return { permissions: allowed ? {} : { fileSystem: null, network: null } };
    case "item/tool/requestUserInput":
      return response.decision === "answers" ? { answers: response.answers } : { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: allowed ? "accept" : "decline" };
    default:
      return { decision: { denied: { rejection: "用户拒绝了该操作" } } };
  }
}

function permissionSummary(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["额外权限"];
  const permissions = value as Record<string, unknown>;
  const result: string[] = [];
  if (permissions.fileSystem) result.push("文件系统访问");
  if (permissions.network) result.push("网络访问");
  return result.length > 0 ? result : ["额外权限"];
}
