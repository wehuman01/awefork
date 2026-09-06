import { computed, reactive, readonly } from "vue";
import { buildSessionTree, type SessionGroup } from "../../shared/session-tree";
import type { AgentEvent, ChatMessage, ForkRecord, SessionSummary } from "../../shared/types";

interface AppState {
  connectionError: string | null;
  sessions: SessionSummary[];
  lineage: Record<string, ForkRecord>;
  selectedId: string | null;
  messages: ChatMessage[];
  messagesError: string | null;
  running: boolean;
  streamText: string;
  actionError: string | null;
}

const state = reactive<AppState>({
  connectionError: null,
  sessions: [],
  lineage: {},
  selectedId: null,
  messages: [],
  messagesError: null,
  running: false,
  streamText: "",
  actionError: null,
});

export const store = readonly(state);

/** Readonly shape of a chat message as seen by components. */
export type ReadonlyChatMessage = (typeof store)["messages"][number];

export const sessionGroups = computed<SessionGroup[]>(() =>
  buildSessionTree(state.sessions, state.lineage),
);

export const selectedSession = computed<SessionSummary | null>(
  () => state.sessions.find((s) => s.id === state.selectedId) ?? null,
);

const activeStreamSessions = new Set<string>();
const streamBuffers = new Map<string, string>();

export async function init(): Promise<void> {
  const ready = await window.awefork.ready();
  if (!ready.ok) {
    state.connectionError = ready.error ?? "Failed to start opencode server.";
    return;
  }
  await refreshSessions();
  window.awefork.onEvent(handleEvent);
}

async function refreshSessions(): Promise<void> {
  try {
    const { sessions, lineage } = await window.awefork.sessions();
    state.sessions = sessions;
    state.lineage = lineage;
    if (!state.selectedId && sessions.length > 0) {
      const roots = sessions.filter((s) => !lineage[s.id] && !s.parentSessionId);
      const pickable = roots.length > 0 ? roots : sessions;
      state.selectedId = pickable.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)).id;
      await loadMessages(state.selectedId);
    }
  } catch (error) {
    state.connectionError = error instanceof Error ? error.message : String(error);
  }
}

export async function selectSession(sessionId: string): Promise<void> {
  if (state.selectedId === sessionId) return;
  state.selectedId = sessionId;
  state.running = activeStreamSessions.has(sessionId);
  await loadMessages(sessionId);
}

async function loadMessages(sessionId: string): Promise<void> {
  state.messages = [];
  state.messagesError = null;
  state.streamText = streamBuffers.get(sessionId) ?? "";
  try {
    state.messages = await window.awefork.messages(sessionId);
  } catch (error) {
    state.messagesError = error instanceof Error ? error.message : String(error);
  }
}

function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case "session.updated": {
      void refreshSessions();
      break;
    }
    case "message.started": {
      if (event.sessionId === state.selectedId) {
        state.running = true;
        activeStreamSessions.add(event.sessionId);
      }
      break;
    }
    case "message.delta": {
      if (event.sessionId !== state.selectedId) break;
      const current = streamBuffers.get(event.sessionId) ?? "";
      streamBuffers.set(event.sessionId, current + event.delta);
      state.streamText = streamBuffers.get(event.sessionId) ?? "";
      break;
    }
    case "session.idle": {
      activeStreamSessions.delete(event.sessionId);
      streamBuffers.delete(event.sessionId);
      if (event.sessionId === state.selectedId) {
        state.running = false;
        state.streamText = "";
        void loadMessages(event.sessionId);
      }
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
    await selectSession(forked.id);
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

export async function forkLatest(): Promise<void> {
  if (!state.selectedId) return;
  state.actionError = null;
  try {
    const forked = await window.awefork.fork(state.selectedId, null);
    await refreshSessions();
    await selectSession(forked.id);
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

export async function sendPrompt(text: string): Promise<void> {
  if (!state.selectedId || !text.trim()) return;
  state.actionError = null;
  state.running = true;
  activeStreamSessions.add(state.selectedId);
  state.messages.push({
    id: `local_${Date.now()}`,
    role: "user",
    text,
    toolNames: [],
    createdAt: Date.now(),
  });
  try {
    await window.awefork.prompt(state.selectedId, text);
  } catch (error) {
    state.running = false;
    activeStreamSessions.delete(state.selectedId);
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
