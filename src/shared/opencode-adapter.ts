import { recordFork, removeFork } from "./lineage-store.js";
import { createOpencodeClient, type OpencodeClient } from "./opencode-client.js";
import { createSseParser } from "./sse.js";
import type {
  AgentAdapter,
  AgentEvent,
  ChatMessage,
  PromptAttachment,
  SessionSummary,
} from "./types.js";

export interface OpenCodeAdapterOptions {
  baseUrl: string;
  /** Path to the lineage sidecar file. */
  lineagePath: string;
}

/**
 * opencode implementation of AgentAdapter.
 *
 * Fork translation: the protocol promises the new branch KEEPS the turn that
 * starts at user message `atMessageId`. opencode's fork API takes an
 * exclusive cut point (keeps messages strictly before it), so we pass the
 * NEXT user message as the cut. At the last turn we omit the cut entirely.
 */
export function createOpencodeAdapter(options: OpenCodeAdapterOptions): AgentAdapter {
  const client: OpencodeClient = createOpencodeClient(options.baseUrl);

  let abortController: AbortController | null = null;
  /** Set by subscribe; lets detached prompts report request-level failures. */
  let emitEvent: ((event: AgentEvent) => void) | null = null;

  const mapSession = (s: {
    id: string;
    title: string;
    directory: string;
    parentID?: string;
    time: { created: number; updated: number };
  }): SessionSummary => ({
    id: s.id,
    title: s.title,
    directory: s.directory,
    parentSessionId: s.parentID ?? null,
    origin: s.parentID ? "subagent" : "root",
    createdAt: s.time.created,
    updatedAt: s.time.updated,
  });

  const mapMessages = (raw: Awaited<ReturnType<OpencodeClient["messages"]>>): ChatMessage[] =>
    raw.map((m) => {
      // Assistant rows report the model top-level; the user row that opened
      // the run carries it nested under `model`. Reading both keeps the model
      // visible even when a run dies before its assistant row reports back.
      // The reasoning variant rides the same two slots.
      const nested = m.info.model;
      const modelId =
        m.info.modelID ?? (typeof nested?.modelID === "string" ? nested.modelID : null);
      const providerId =
        m.info.providerID ?? (typeof nested?.providerID === "string" ? nested.providerID : null);
      const variant =
        typeof m.info.variant === "string"
          ? m.info.variant
          : typeof nested?.variant === "string"
            ? nested.variant
            : null;
      return {
        id: m.info.id,
        role: m.info.role,
        text: m.parts
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n")
          .trim(),
        toolNames: [
          ...new Set(
            m.parts
              .filter((p) => p.type === "tool")
              .map((p) => (typeof p.tool === "string" ? p.tool : "tool"))
              .filter(Boolean),
          ),
        ],
        modelId,
        providerId,
        variant,
        attachmentNames: m.parts
          .filter((p) => p.type === "file")
          .map((p) => (typeof p.filename === "string" && p.filename ? p.filename : "附件")),
        createdAt: m.info.time.created,
        completedAt: typeof m.info.time.completed === "number" ? m.info.time.completed : null,
        outputTokens: typeof m.info.tokens?.output === "number" ? m.info.tokens.output : null,
        error: m.info.error?.data?.message ?? m.info.error?.name ?? null,
      };
    });

  async function findCutMessageId(sessionId: string, atMessageId: string): Promise<string | null> {
    const messages = await client.messages(sessionId);
    const index = messages.findIndex((m) => m.info.id === atMessageId);
    if (index === -1) {
      throw new Error(
        `Message ${atMessageId} not found in session ${sessionId}. Refresh the session and try again.`,
      );
    }
    const cut = messages
      .slice(index + 1)
      .find((m) => m.info.role === "user" && m.info.id !== atMessageId);
    return cut?.info.id ?? null;
  }

  return {
    kind: "opencode",

    async listSessions() {
      const [current, projects] = await Promise.all([client.listSessions(), client.listProjects()]);
      const byId = new Map(current.map((s) => [s.id, s]));
      const otherWorktrees = projects.filter((p) => p.id !== "global" && p.worktree);
      // One request per worktree, in parallel — the serial loop made every
      // debounced refresh pay the sum of all worktree round-trips. Array
      // order preserves the later-wins overwrite of duplicate ids.
      const perWorktree = await Promise.all(
        otherWorktrees.map((project) => client.listSessions(project.worktree)),
      );
      for (const sessions of perWorktree) {
        for (const session of sessions) byId.set(session.id, session);
      }
      return [...byId.values()].map(mapSession).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async messages(sessionId) {
      return mapMessages(await client.messages(sessionId));
    },

    async messageAttachments(sessionId, messageId) {
      const raw = await client.messages(sessionId);
      const target = raw.find((m) => m.info.id === messageId);
      if (!target) return [];
      // The stored file part keeps the url it was sent with (a data URL here),
      // so the parts round-trip as attachments again; parts that lost their
      // url are dropped rather than resent as empty files.
      return target.parts
        .filter((p) => p.type === "file" && typeof p.url === "string" && p.url)
        .map((p) => ({
          mime: typeof p.mime === "string" ? p.mime : "application/octet-stream",
          filename: typeof p.filename === "string" && p.filename ? p.filename : "附件",
          dataUrl: p.url as string,
        }));
    },

    listModels() {
      return client.listModels();
    },

    async fork(sessionId, atMessageId) {
      const cut = atMessageId ? await findCutMessageId(sessionId, atMessageId) : null;
      const forked = await client.fork(sessionId, cut);
      await recordFork(options.lineagePath, forked.id, {
        parentId: sessionId,
        atMessageId,
        createdAt: forked.time.created,
      });
      return { ...mapSession(forked), origin: "fork", parentSessionId: sessionId };
    },

    async prompt(sessionId, text, model, attachments) {
      // Detached on purpose: /message only resolves when the whole run
      // finishes, while progress reaches this adapter through the /event
      // stream. Request-level failures (server gone, unknown session) have no
      // event, so they surface here as server.error — with the session id, so
      // the renderer can settle that run instead of waiting out the watchdog.
      client.prompt(sessionId, text, model, attachments).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        emitEvent?.({
          type: "server.error",
          sessionId,
          message: `Prompt failed for ${sessionId}: ${detail}`,
        });
      });
    },

    async deleteSession(sessionId) {
      await client.deleteSession(sessionId);
      await removeFork(options.lineagePath, sessionId);
    },

    async deleteMessage(sessionId, messageId) {
      await client.deleteMessage(sessionId, messageId);
    },

    async renameSession(sessionId, title) {
      await client.renameSession(sessionId, title);
    },

    async abort(sessionId) {
      await client.abort(sessionId);
    },

    async subscribe(handler) {
      abortController = new AbortController();
      const { signal } = abortController;
      const parse = createSseParser();
      let stopped = false;

      const emit = (event: AgentEvent) => {
        if (!stopped) handler(event);
      };
      emitEvent = emit;

      const connect = async () => {
        while (!stopped && !signal.aborted) {
          try {
            const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/event`, {
              signal,
            });
            if (!response.ok || !response.body) {
              throw new Error(`event stream returned ${response.status}`);
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const event of parse(decoder.decode(value, { stream: true }))) {
                emitToAgentEvent(event, emit);
              }
            }
          } catch (error) {
            if (signal.aborted || stopped) break;
            emit({
              type: "server.error",
              message: `Event stream lost, reconnecting: ${String(error)}`,
            });
            await sleep(1000, signal);
          }
        }
      };

      void connect();
      return () => {
        stopped = true;
        if (emitEvent === emit) emitEvent = null;
        abortController?.abort();
      };
    },

    dispose() {
      abortController?.abort();
    },
  };
}

function emitToAgentEvent(
  event: { type: string; properties: Record<string, unknown> },
  emit: (event: AgentEvent) => void,
): void {
  const props = event.properties;
  switch (event.type) {
    case "session.updated":
    case "session.created":
    case "session.deleted": {
      const nested = props.session as { sessionID?: unknown; id?: unknown } | undefined;
      const sessionId = sessionIdOf(props.sessionID ?? nested?.sessionID ?? nested?.id);
      if (sessionId) emit({ type: "session.updated", sessionId });
      break;
    }
    case "message.updated": {
      // Fork creation replays message.updated for every copied message, so
      // this event can NOT mean "a run started" — running state is driven by
      // session.status instead. Nothing else needs it: idle refreshes messages.
      break;
    }
    case "message.part.updated": {
      // Snapshot frames carry no delta on opencode 1.18; older builds put the
      // text delta here. Skip frames without one.
      if (typeof props.delta !== "string" || props.delta === "") break;
      const part = props.part as { sessionID?: string; messageID?: string } | undefined;
      const sessionId = sessionIdOf(props.sessionID ?? part?.sessionID);
      const messageId = messageIdOf(props.messageID ?? part?.messageID);
      if (sessionId && messageId) {
        emit({
          type: "message.delta",
          sessionId,
          messageId,
          delta: props.delta as string,
        });
      }
      break;
    }
    case "message.part.delta": {
      // opencode 1.18 streams text growth through this dedicated event.
      if (props.field !== "text") break;
      if (typeof props.delta !== "string" || props.delta === "") break;
      const sessionId = sessionIdOf(props.sessionID);
      const messageId = messageIdOf(props.messageID);
      if (sessionId && messageId) {
        emit({
          type: "message.delta",
          sessionId,
          messageId,
          delta: props.delta as string,
        });
      }
      break;
    }
    case "session.status": {
      const sessionId = sessionIdOf(props.sessionID);
      if (!sessionId) break;
      const status = props.status as { type?: unknown } | undefined;
      if (status?.type === "busy") {
        emit({ type: "message.started", sessionId, messageId: "" });
      } else if (status?.type === "idle") {
        // The twin of session.idle, emitted just before it. Handling both
        // means a dropped frame of either kind still finishes the run in UI.
        emit({ type: "session.idle", sessionId });
      }
      break;
    }
    case "session.error": {
      const sessionId = sessionIdOf(props.sessionID);
      const error = props.error as { message?: unknown; data?: { message?: unknown } } | undefined;
      const detail = error?.message ?? error?.data?.message;
      const message =
        typeof detail === "string" ? detail : JSON.stringify(props.error ?? "unknown error");
      emit({
        type: "server.error",
        sessionId,
        message: sessionId ? `${sessionId}: ${message}` : message,
      });
      break;
    }
    case "session.idle": {
      const sessionId = sessionIdOf(props.sessionID);
      if (sessionId) emit({ type: "session.idle", sessionId });
      break;
    }
  }
}

function sessionIdOf(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function messageIdOf(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
