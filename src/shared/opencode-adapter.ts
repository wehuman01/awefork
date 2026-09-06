import { recordFork } from "./lineage-store.js";
import { createOpencodeClient, type OpencodeClient } from "./opencode-client.js";
import { createSseParser } from "./sse.js";
import type { AgentAdapter, AgentEvent, ChatMessage, SessionSummary } from "./types.js";

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
    raw.map((m) => ({
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
      createdAt: m.info.time.created,
    }));

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
      return (await client.listSessions()).map(mapSession);
    },

    async messages(sessionId) {
      return mapMessages(await client.messages(sessionId));
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

    async prompt(sessionId, text) {
      await client.promptAsync(sessionId, text);
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
      const info = props.info as { id?: unknown; sessionID?: unknown } | undefined;
      const sessionId = sessionIdOf(props.sessionID ?? info?.sessionID);
      const messageId = messageIdOf(info?.id ?? props.messageID);
      if (sessionId && messageId) {
        emit({ type: "message.started", sessionId, messageId });
      }
      break;
    }
    case "message.part.updated": {
      const part = props.part as { sessionID?: string; messageID?: string } | undefined;
      const sessionId = sessionIdOf(props.sessionID ?? part?.sessionID);
      const messageId = messageIdOf(props.messageID ?? part?.messageID);
      if (sessionId && messageId) {
        emit({
          type: "message.delta",
          sessionId,
          messageId,
          delta: typeof props.delta === "string" ? props.delta : "",
        });
      }
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
