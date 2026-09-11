import {
  firstNumber,
  firstString,
  type OpenCodeDescriptor,
  opencodeDescriptor,
  readPath,
} from "./agent-descriptor.js";
import { createFileChangeRecorder, type FileChangeRecorder } from "./file-change-recorder.js";
import { recordFork, removeFork } from "./lineage-store.js";
import {
  createOpencodeClient,
  type OcMessage,
  type OcPart,
  type OpencodeClient,
} from "./opencode-client.js";
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
  /** Root dir for per-session file-change sidecars; absent = no recording. */
  fileChangesDir?: string;
  /** Descriptor override for tests; defaults to the bundled agents/opencode.json. */
  descriptor?: OpenCodeDescriptor;
}

/**
 * opencode implementation of AgentAdapter — the interpreter over
 * agents/opencode.json. Names, paths, and shapes come from the descriptor;
 * what stays here is behavior: the reconnect loop, the part-kind state
 * machine, and the fork cut translation.
 *
 * Fork translation: the protocol promises the new branch KEEPS the turn that
 * starts at user message `atMessageId`. opencode's fork API takes an
 * exclusive cut point (keeps messages strictly before it), so we pass the
 * NEXT user message as the cut. At the last turn we omit the cut entirely.
 */
export function createOpencodeAdapter(options: OpenCodeAdapterOptions): AgentAdapter {
  const descriptor = options.descriptor ?? opencodeDescriptor();
  const client: OpencodeClient = createOpencodeClient(options.baseUrl, { descriptor });

  let abortController: AbortController | null = null;
  /** Set by subscribe; lets detached prompts report request-level failures. */
  let emitEvent: ((event: AgentEvent) => void) | null = null;

  /**
   * Observer-seat file-change recording: every tool-part snapshot frame rides
   * the same SSE stream as text parts, so the recorder hangs off the part
   * translation below. One recorder per session keeps message/path state
   * independent per branch.
   */
  const fileChangesFact = descriptor.fileChanges;
  const recorders = new Map<string, FileChangeRecorder>();
  const onToolPart =
    options.fileChangesDir && fileChangesFact
      ? (sessionId: string, messageId: string, part: unknown): void => {
          const tool =
            firstString(part, [descriptor.messages.parts.tool.nameField]) ??
            descriptor.messages.parts.tool.fallbackName;
          const stateKey = readPath(part, fileChangesFact.stateKeyPath);
          const partId = readPath(part, "id");
          let recorder = recorders.get(sessionId);
          if (!recorder) {
            recorder = createFileChangeRecorder({
              rootDir: options.fileChangesDir ?? "",
              fact: fileChangesFact,
              directoryOf: async (id) => {
                try {
                  const session = await client.session(id);
                  return firstString(session, descriptor.sessions.fields.directory);
                } catch {
                  // A session the server no longer names records nothing.
                  return null;
                }
              },
            });
            recorders.set(sessionId, recorder);
          }
          recorder.observe({
            sessionId,
            messageId,
            partId: typeof partId === "string" ? partId : "",
            tool,
            filePath: firstString(part, fileChangesFact.filePathPaths),
            stateKey: typeof stateKey === "string" ? stateKey : null,
          });
        }
      : undefined;

  const mapSession = (raw: unknown): SessionSummary => {
    const parentSessionId = firstString(raw, descriptor.sessions.fields.parentSessionId);
    return {
      id: firstString(raw, descriptor.sessions.fields.id) ?? "",
      title: firstString(raw, descriptor.sessions.fields.title) ?? "",
      directory: firstString(raw, descriptor.sessions.fields.directory) ?? "",
      parentSessionId,
      origin: parentSessionId ? "subagent" : "root",
      createdAt: firstNumber(raw, descriptor.sessions.fields.createdAt) ?? 0,
      updatedAt: firstNumber(raw, descriptor.sessions.fields.updatedAt) ?? 0,
    };
  };

  /** Concatenate one text-bearing part kind per the descriptor; rows join on its separator. */
  const joinParts = (
    parts: OcPart[],
    config: { type: string; field: string; join: string },
  ): string =>
    parts
      .filter((p) => p.type === config.type && typeof partField(p, config.field) === "string")
      .map((p) => partField(p, config.field) as string)
      .join(config.join)
      .trim();

  const mapMessages = (raw: OcMessage[]): ChatMessage[] =>
    raw.map((m) => {
      // modelId/providerId/variant read assistant rows top-level and the user
      // row that opened the run nested under `model` — the descriptor lists
      // both candidates so the model stays visible even when a run dies
      // before its assistant row reports back.
      const { fields, parts } = descriptor.messages;
      return {
        id: firstString(m, fields.id) ?? "",
        role: (firstString(m, fields.role) ?? "assistant") as ChatMessage["role"],
        text: joinParts(m.parts, parts.text),
        // Reasoning rows join with a blank line: a multi-step run stores one
        // part per step, and joining them bare glues the last line of one
        // step's thinking onto the first of the next.
        thinking: joinParts(m.parts, parts.thinking),
        toolNames: [
          ...new Set(
            m.parts
              .filter((p) => p.type === parts.tool.type)
              .map((p) => firstString(p, [parts.tool.nameField]) ?? parts.tool.fallbackName),
          ),
        ],
        modelId: firstString(m, fields.modelId),
        providerId: firstString(m, fields.providerId),
        variant: firstString(m, fields.variant),
        attachmentNames: m.parts
          .filter((p) => p.type === parts.file.type)
          .map((p) => firstString(p, [parts.file.nameField]) ?? parts.file.fallbackName),
        createdAt: firstNumber(m, fields.createdAt) ?? 0,
        completedAt: firstNumber(m, fields.completedAt),
        finish: firstString(m, fields.finish),
        outputTokens: firstNumber(m, fields.outputTokens),
        error: firstString(m, fields.error),
      };
    });

  async function findCutMessageId(sessionId: string, atMessageId: string): Promise<string | null> {
    const messages = await client.messages(sessionId);
    const index = messages.findIndex(
      (m) => firstString(m, descriptor.messages.fields.id) === atMessageId,
    );
    if (index === -1) {
      throw new Error(
        `Message ${atMessageId} not found in session ${sessionId}. Refresh the session and try again.`,
      );
    }
    const cut = messages
      .slice(index + 1)
      .find((m) => firstString(m, descriptor.messages.fields.role) === "user");
    return cut ? (firstString(cut, descriptor.messages.fields.id) ?? null) : null;
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
      const target = raw.find((m) => firstString(m, descriptor.messages.fields.id) === messageId);
      if (!target) return [];
      const file = descriptor.messages.parts.file;
      // The stored file part keeps the url it was sent with (a data URL here),
      // so the parts round-trip as attachments again; parts that lost their
      // url are dropped rather than resent as empty files.
      return target.parts
        .filter(
          (p) =>
            p.type === file.type &&
            typeof partField(p, file.urlField) === "string" &&
            partField(p, file.urlField),
        )
        .map((p) => ({
          mime: firstString(p, [file.mimeField]) ?? "application/octet-stream",
          filename: firstString(p, [file.nameField]) ?? file.fallbackName,
          dataUrl: partField(p, file.urlField) as string,
        }));
    },

    listModels() {
      return client.listModels();
    },

    async createSession(directory) {
      return mapSession(await client.createSession(directory ?? undefined));
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
      // finishes, while progress reaches this adapter through the event
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

    // opencode's stream is one-way (server → client notifications); nothing
    // it does waits on a reply from the host, so an interaction responder is
    // meaningless here and an attempt to use one is a programming error.
    async respondInteraction() {
      throw new Error("opencode has no server-originated interactions to answer");
    },

    async abort(sessionId) {
      await client.abort(sessionId);
    },

    async subscribe(handler) {
      abortController = new AbortController();
      const { signal } = abortController;
      const partKinds = new Map<string, "text" | "thinking">();
      let stopped = false;

      const emit = (event: AgentEvent) => {
        if (!stopped) handler(event);
      };
      emitEvent = emit;

      const connect = async () => {
        // One notice per outage, not one per 1s retry: the toast fires on the
        // streak's first failure, then a server.reconnected event on recovery
        // lets the renderer drop the toast and rebuild what the outage missed.
        let outageNotified = false;
        while (!stopped && !signal.aborted) {
          try {
            const base = options.baseUrl.replace(/\/$/, "");
            const response = await fetch(`${base}${descriptor.endpoints.events}`, {
              signal,
            });
            if (!response.ok || !response.body) {
              throw new Error(`event stream returned ${response.status}`);
            }
            if (outageNotified) {
              outageNotified = false;
              emit({ type: "server.reconnected" });
            }
            const reader = response.body.getReader();
            // Fresh parser per connection: a dropped stream can end mid-frame,
            // and the leftover half-frame would splice into the next
            // connection's first event and corrupt it.
            const parse = createSseParser();
            const decoder = new TextDecoder();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const event of parse(decoder.decode(value, { stream: true }))) {
                emitToAgentEvent(event, emit, partKinds, descriptor, onToolPart);
              }
            }
          } catch (error) {
            if (signal.aborted || stopped) break;
            if (!outageNotified) {
              outageNotified = true;
              emit({
                type: "server.error",
                message: `Event stream lost, reconnecting: ${String(error)}`,
              });
            }
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

/** One named field of a part row; the key comes from the descriptor. */
function partField(part: OcPart, field: string): unknown {
  return (part as unknown as Record<string, unknown>)[field];
}

/** A part as it rides inside an SSE frame — the REST part shape plus timing. */
interface EventPart {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  time?: { start?: unknown; end?: unknown };
}

/**
 * Frame-to-AgentEvent translation. The names and shapes come from the
 * descriptor; the part-kind bookkeeping around them is state the data cannot
 * express: a delta is only trustworthy once the part's first snapshot
 * announced its kind, so unknown-part deltas are dropped rather than guessed
 * at (rendering reasoning as reply text is the worse failure).
 */
function emitToAgentEvent(
  event: { type: string; properties: Record<string, unknown> },
  emit: (event: AgentEvent) => void,
  partKinds: Map<string, "text" | "thinking">,
  descriptor: OpenCodeDescriptor,
  onToolPart?: (sessionId: string, messageId: string, part: unknown) => void,
): void {
  const props = event.properties;
  const { events } = descriptor;
  const sessionId = () => firstString(props, events.sessionIdPaths);

  if (events.refresh.includes(event.type)) {
    const id = sessionId();
    if (id) emit({ type: "session.updated", sessionId: id });
    return;
  }
  // Fork creation replays message.updated for every copied message, so this
  // frame can NOT mean "a run started" — running state is driven by the
  // status/idle frames. Nothing else needs it: idle refreshes messages.
  if (events.ignore.includes(event.type)) return;

  if (events.idle.includes(event.type)) {
    const id = sessionId();
    if (id) emit({ type: "session.idle", sessionId: id });
    return;
  }

  if (event.type === events.error.name) {
    const detail = firstString(props, events.error.detailPaths);
    const message = detail ?? JSON.stringify(props.error ?? "unknown error");
    const id = sessionId();
    emit({
      type: "server.error",
      sessionId: id,
      message: id ? `${id}: ${message}` : message,
    });
    return;
  }

  if (event.type === events.status.name) {
    const id = sessionId();
    if (!id) return;
    const value = firstString(props, [events.status.valuePath]);
    if (value === events.status.busyValue) {
      emit({ type: "message.started", sessionId: id, messageId: "" });
    } else if (value === events.status.idleValue) {
      // The twin of the idle frame: handling both means a dropped frame of
      // either kind still finishes the run in UI.
      emit({ type: "session.idle", sessionId: id });
    }
    return;
  }

  if (event.type === events.partSnapshot.name) {
    const part = props[events.partSnapshot.partField] as EventPart | undefined;
    const partId = typeof part?.id === "string" ? part.id : null;
    // Register the part's kind from its snapshot BEFORE any delta handling —
    // older opencode builds put the text delta in this same frame.
    const kind = typeof part?.type === "string" ? events.partSnapshot.kinds[part.type] : undefined;
    if (partId && kind) partKinds.set(partId, kind);
    // Tool parts carry no text stream, but they are where file changes live:
    // hand the raw part to the recorder before anything else falls through.
    if (onToolPart && partId && !kind) {
      const id = sessionId();
      const messageId = firstString(props, events.messageIdPaths);
      if (id && messageId) onToolPart(id, messageId, part);
    }

    const id = sessionId();
    const messageId = firstString(props, events.messageIdPaths);
    // Forward the whole snapshot for text/reasoning parts: the renderer
    // reconciles its live buffer with it (self-heal after a dropped delta)
    // and reads the part's end time as the reasoning-finished signal.
    if (partId && id && messageId && kind) {
      emit({
        type: "message.part",
        sessionId: id,
        messageId,
        partId,
        kind,
        text: typeof part?.text === "string" ? part.text : "",
        startedAt: typeof part?.time?.start === "number" ? part.time.start : null,
        endedAt: typeof part?.time?.end === "number" ? part.time.end : null,
      });
    }

    // Snapshot frames carry no delta on current builds; older ones put the
    // text delta here. A delta whose part kind is unknown is dropped.
    emitPartDelta(emit, partKinds, {
      delta: props[events.partSnapshot.deltaField],
      partId,
      sessionId: id,
      messageId,
    });
    return;
  }

  if (event.type === events.partDelta.name) {
    if (props[events.partDelta.field] !== events.partDelta.textFieldValue) return;
    emitPartDelta(emit, partKinds, {
      delta: props[events.partDelta.deltaField],
      partId: firstString(props, [events.partDelta.partIdField]),
      sessionId: sessionId(),
      messageId: firstString(props, events.messageIdPaths),
    });
  }
}

/** Shared tail of both delta-bearing frames: forward only what can be routed. */
function emitPartDelta(
  emit: (event: AgentEvent) => void,
  partKinds: Map<string, "text" | "thinking">,
  frame: {
    delta: unknown;
    partId: string | null;
    sessionId: string | null;
    messageId: string | null;
  },
): void {
  if (typeof frame.delta !== "string" || frame.delta === "") return;
  // Unknown part → drop and wait for the snapshot: a delta that arrives
  // before the app saw the part's first frame is guesswork, and the snapshot
  // that follows carries the full content anyway.
  const kind = frame.partId ? partKinds.get(frame.partId) : undefined;
  if (!frame.sessionId || !frame.messageId || !frame.partId || !kind) return;
  emit({
    type: "message.delta",
    sessionId: frame.sessionId,
    messageId: frame.messageId,
    partId: frame.partId,
    kind,
    delta: frame.delta,
  });
}

/** Timed sleep, abortable; exported for tests. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    // The timer path must drop its own listener: the reconnect loop calls
    // this every second during an outage, and listeners that only fire on
    // abort would otherwise pile up without bound on the same signal.
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
