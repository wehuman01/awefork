import { computed, reactive, readonly } from "vue";
import { buildTurnGraph, type TurnGraph, type TurnNode } from "../../shared/canvas-graph";
import { buildSessionTree, enrichSessions, type SessionGroup } from "../../shared/session-tree";
import type { AgentEvent, ChatMessage, ForkRecord, SessionSummary } from "../../shared/types";

interface DraftState {
  /** Canvas node the composer is attached to. */
  nodeId: string;
  /** Session to fork (or continue, for stub nodes). */
  sessionId: string;
  /** User message to fork after; null = continue the session as-is. */
  atMessageId: string | null;
  text: string;
}

interface AppState {
  connectionError: string | null;
  sessions: SessionSummary[];
  lineage: Record<string, ForkRecord>;
  selectedDirectory: string | null;
  selectedId: string | null;
  selectedTurnId: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  loadingMessages: boolean;
  messagesError: string | null;
  /** sessionId → true while an agent run is in flight. */
  running: Record<string, boolean>;
  /** Live stream text of the selected session only. */
  streamText: string;
  actionError: string | null;
  draft: DraftState | null;
  /** Bumped to ask the canvas to center on a session's latest node. */
  focusRequest: { sessionId: string; nonce: number } | null;
}

const state = reactive<AppState>({
  connectionError: null,
  sessions: [],
  lineage: {},
  selectedDirectory: null,
  selectedId: null,
  selectedTurnId: null,
  messagesBySession: {},
  loadingMessages: false,
  messagesError: null,
  running: {},
  streamText: "",
  actionError: null,
  draft: null,
  focusRequest: null,
});

export const store = readonly(state);

/** Readonly shape of a chat message as seen by components. */
export type ReadonlyChatMessage = (typeof store)["messagesBySession"][string][number];

export const sessionGroups = computed<SessionGroup[]>(() =>
  buildSessionTree(state.sessions, state.lineage),
);

export const directories = computed<string[]>(() => {
  const latest = new Map<string, number>();
  for (const session of state.sessions) {
    latest.set(session.directory, Math.max(latest.get(session.directory) ?? 0, session.updatedAt));
  }
  return [...latest.keys()].sort((a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0));
});

const enrichedSessions = computed<SessionSummary[]>(() =>
  enrichSessions(state.sessions, state.lineage),
);

const directorySessions = computed<SessionSummary[]>(() =>
  enrichedSessions.value.filter((s) => s.directory === state.selectedDirectory),
);

export const turnGraph = computed<TurnGraph>(() =>
  buildTurnGraph({
    sessions: directorySessions.value,
    lineage: state.lineage,
    messages: state.messagesBySession,
  }),
);

export const selectedSession = computed<SessionSummary | null>(
  () => state.sessions.find((s) => s.id === state.selectedId) ?? null,
);

export const selectedMessages = computed<ChatMessage[]>(
  () => state.messagesBySession[state.selectedId ?? ""] ?? [],
);

const activeStreamSessions = new Set<string>();
const streamBuffers = new Map<string, string>();
/** Sessions whose messages have been requested (or are already cached). */
const attemptedMessages = new Set<string>();

export async function init(): Promise<void> {
  const ready = await window.awefork.ready();
  if (!ready.ok) {
    state.connectionError = ready.error ?? "Failed to start opencode server.";
    return;
  }
  await refreshSessions();
  window.awefork.onEvent(handleEvent);
}

export async function refreshSessions(): Promise<void> {
  try {
    const { sessions, lineage } = await window.awefork.sessions();
    state.sessions = sessions;
    state.lineage = lineage;

    if (!state.selectedDirectory && sessions.length > 0) {
      state.selectedDirectory = sessions.reduce((a, b) =>
        a.updatedAt > b.updatedAt ? a : b,
      ).directory;
    }
    // Select before the batch load so the initial session's panel and canvas
    // node are ready the moment the directory finishes loading.
    if (
      state.selectedDirectory &&
      (!state.selectedId || !directorySessions.value.some((s) => s.id === state.selectedId))
    ) {
      await selectSession(latestSessionId(directorySessions.value));
    }
    if (state.selectedDirectory) {
      await ensureDirectoryMessages(state.selectedDirectory);
    }
  } catch (error) {
    state.connectionError = error instanceof Error ? error.message : String(error);
  }
}

export async function switchDirectory(directory: string): Promise<void> {
  if (state.selectedDirectory === directory) return;
  state.selectedDirectory = directory;
  state.messagesError = null;
  await ensureDirectoryMessages(directory);
  await selectSession(latestSessionId(directorySessions.value), { focus: true });
}

export async function selectSession(
  sessionId: string | null,
  options: { focus?: boolean } = {},
): Promise<void> {
  if (!sessionId) return;
  state.selectedId = sessionId;
  state.selectedTurnId = null;
  state.streamText = streamBuffers.get(sessionId) ?? "";
  state.messagesError = null;
  if (options.focus) {
    state.focusRequest = { sessionId, nonce: Date.now() };
  }
  if (!attemptedMessages.has(sessionId)) {
    await loadSessionMessages(sessionId);
  }
}

/** Select a canvas node: switches branch if needed, remembers the turn. */
export async function selectTurn(node: TurnNode): Promise<void> {
  if (node.sessionId !== state.selectedId) {
    await selectSession(node.sessionId);
  }
  state.selectedTurnId = node.id;
}

async function ensureDirectoryMessages(directory: string): Promise<void> {
  const pending = enrichedSessions.value
    .filter((s) => s.directory === directory && !attemptedMessages.has(s.id))
    .map((s) => s.id);
  if (pending.length === 0) return;
  state.loadingMessages = true;
  await Promise.allSettled(pending.map((id) => loadSessionMessages(id)));
  state.loadingMessages = false;
}

async function loadSessionMessages(sessionId: string): Promise<void> {
  attemptedMessages.add(sessionId);
  try {
    // Await first, THEN merge: spreading before the await would snapshot the
    // pre-await state, and concurrent loads would overwrite each other.
    const messages = await window.awefork.messages(sessionId);
    state.messagesBySession = { ...state.messagesBySession, [sessionId]: messages };
  } catch (error) {
    if (state.selectedId === sessionId) {
      state.messagesError = error instanceof Error ? error.message : String(error);
    }
  }
}

function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case "session.updated": {
      void refreshSessions();
      break;
    }
    case "message.started": {
      activeStreamSessions.add(event.sessionId);
      state.running = { ...state.running, [event.sessionId]: true };
      break;
    }
    case "message.delta": {
      const current = streamBuffers.get(event.sessionId) ?? "";
      streamBuffers.set(event.sessionId, current + event.delta);
      if (event.sessionId === state.selectedId) {
        state.streamText = streamBuffers.get(event.sessionId) ?? "";
      }
      break;
    }
    case "session.idle": {
      activeStreamSessions.delete(event.sessionId);
      streamBuffers.delete(event.sessionId);
      const { [event.sessionId]: finished, ...stillRunning } = state.running;
      void finished;
      state.running = stillRunning;
      if (event.sessionId === state.selectedId) state.streamText = "";
      // Refresh the canvas card (and panel) with the finished reply.
      void loadSessionMessages(event.sessionId);
      void refreshSessions();
      break;
    }
    case "server.error": {
      state.actionError = event.message;
      break;
    }
  }
}

export async function forkAtMessage(atMessageId: string): Promise<void> {
  if (!state.selectedId) return;
  state.actionError = null;
  try {
    const forked = await window.awefork.fork(state.selectedId, atMessageId);
    await refreshSessions();
    await selectSession(forked.id, { focus: true });
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

export function openDraft(node: TurnNode): void {
  state.draft = {
    nodeId: node.id,
    sessionId: node.sessionId,
    atMessageId: node.messageId,
    text: "",
  };
}

export function setDraftText(text: string): void {
  if (state.draft) state.draft.text = text;
}

export function dismissDraft(): void {
  state.draft = null;
}

/**
 * Send the draft: on a turn node this forks the session at that turn AND
 * fires the prompt on the new branch; on a stub node it simply continues the
 * (so far turn-less) branch.
 */
export async function sendDraft(): Promise<void> {
  const draft = state.draft;
  if (!draft?.text.trim()) return;
  state.actionError = null;
  try {
    if (draft.atMessageId) {
      const forked = await window.awefork.fork(draft.sessionId, draft.atMessageId);
      await refreshSessions();
      await selectSession(forked.id, { focus: true });
      await window.awefork.prompt(forked.id, draft.text.trim());
    } else {
      await window.awefork.prompt(draft.sessionId, draft.text.trim());
      await selectSession(draft.sessionId, { focus: true });
    }
    state.draft = null;
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

export async function sendPrompt(text: string): Promise<void> {
  if (!state.selectedId || !text.trim()) return;
  state.actionError = null;
  activeStreamSessions.add(state.selectedId);
  state.running = { ...state.running, [state.selectedId]: true };
  const sessionId = state.selectedId;
  state.messagesBySession = {
    ...state.messagesBySession,
    [sessionId]: [
      ...(state.messagesBySession[sessionId] ?? []),
      {
        id: `local_${Date.now()}`,
        role: "user",
        text,
        toolNames: [],
        createdAt: Date.now(),
      },
    ],
  };
  try {
    await window.awefork.prompt(sessionId, text);
  } catch (error) {
    activeStreamSessions.delete(sessionId);
    const { [sessionId]: stopped, ...rest } = state.running;
    void stopped;
    state.running = rest;
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

export async function abortRun(): Promise<void> {
  if (!state.selectedId) return;
  try {
    await window.awefork.abort(state.selectedId);
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

export function dismissActionError(): void {
  state.actionError = null;
}

function latestSessionId(sessions: SessionSummary[]): string | null {
  if (sessions.length === 0) return null;
  return sessions.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)).id;
}
