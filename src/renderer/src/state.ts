import { computed, reactive, readonly } from "vue";
import { buildTurnGraph, type TurnGraph, type TurnNode } from "../../shared/canvas-graph";
import { selectCanvasSessions } from "../../shared/canvas-scope";
import { buildSessionTree, enrichSessions, type SessionGroup } from "../../shared/session-tree";
import { buildTurns, type Turn } from "../../shared/turns";
import type {
  AgentEvent,
  ChatMessage,
  ForkRecord,
  ModelChoice,
  ModelOption,
  SessionSummary,
} from "../../shared/types";

interface DraftState {
  /** Canvas node the composer is attached to. */
  nodeId: string;
  /** Session to fork (or continue, for stub nodes). */
  sessionId: string;
  /** User message to fork after; null = continue the session as-is. */
  atMessageId: string | null;
  text: string;
  /** Model to run the prompt with; null = the agent's configured default. */
  model: ModelChoice | null;
}

interface AppState {
  connectionError: string | null;
  sessions: SessionSummary[];
  lineage: Record<string, ForkRecord>;
  /** Session ids the user saved to the canvas (persisted in pins.json). */
  pins: string[];
  selectedDirectory: string | null;
  selectedId: string | null;
  /**
   * Turn node id shown in the right pane. null = follow the session's latest
   * turn (used when selecting a session or while a new turn streams in).
   */
  selectedTurnId: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  loadingMessages: boolean;
  messagesError: string | null;
  /** Model catalog from the agent's provider config; loaded on first draft. */
  models: ModelOption[];
  /** sessionId → true while an agent run is in flight. */
  running: Record<string, boolean>;
  /** Live stream text of the selected session only. */
  streamText: string;
  actionError: string | null;
  draft: DraftState | null;
  /** True while the draft's fork+prompt round-trip is in flight. */
  draftSending: boolean;
  /** Model the pane composer will use next, per session; null = agent default. */
  paneModels: Record<string, ModelChoice | null>;
  /** Bumped to ask the canvas to center on a session's latest node. */
  focusRequest: { sessionId: string; nonce: number } | null;
  /** Bumped to ask the canvas to fit the whole working set in view. */
  fitRequest: number | null;
}

const state = reactive<AppState>({
  connectionError: null,
  sessions: [],
  lineage: {},
  pins: [],
  selectedDirectory: null,
  selectedId: null,
  selectedTurnId: null,
  messagesBySession: {},
  loadingMessages: false,
  messagesError: null,
  models: [],
  running: {},
  streamText: "",
  actionError: null,
  draft: null,
  draftSending: false,
  paneModels: {},
  focusRequest: null,
  fitRequest: null,
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

const directorySessionIds = computed<Set<string>>(
  () => new Set(directorySessions.value.map((s) => s.id)),
);

/** Pinned sessions of the current project — the canvas's standing residents. */
export const pinnedSessions = computed<SessionSummary[]>(() =>
  directorySessions.value.filter((s) => state.pins.includes(s.id)),
);

/**
 * What the canvas draws: pinned branch stories plus the selected session's
 * neighborhood. The full session list stays in the sidebar.
 */
const canvasSessions = computed<SessionSummary[]>(() =>
  selectCanvasSessions(
    directorySessions.value,
    state.lineage,
    state.pins.filter((id) => directorySessionIds.value.has(id)),
    state.selectedId,
  ),
);

export const turnGraph = computed<TurnGraph>(() =>
  buildTurnGraph({
    sessions: canvasSessions.value,
    lineage: state.lineage,
    messages: state.messagesBySession,
  }),
);

export const selectedSession = computed<SessionSummary | null>(
  () => state.sessions.find((s) => s.id === state.selectedId) ?? null,
);

const selectedTurns = computed<Turn[]>(() =>
  state.selectedId
    ? buildTurns(state.selectedId, state.messagesBySession[state.selectedId] ?? [])
    : [],
);

/** The turn the right pane is locked to; falls back to the session's latest. */
export const paneTurn = computed<{ turn: Turn; index: number; total: number } | null>(() => {
  const turns = selectedTurns.value;
  if (turns.length === 0) return null;
  if (state.selectedTurnId) {
    const messageId = state.selectedTurnId.slice(state.selectedTurnId.indexOf(":") + 1);
    const index = turns.findIndex((t) => t.messageId === messageId);
    const turn = index >= 0 ? turns[index] : undefined;
    if (turn) return { turn, index, total: turns.length };
  }
  const last = turns[turns.length - 1];
  return last ? { turn: last, index: turns.length - 1, total: turns.length } : null;
});

/** Messages of the pane's turn: from its user prompt up to the next one. */
export const paneMessages = computed<ChatMessage[]>(() => {
  const messages = state.messagesBySession[state.selectedId ?? ""] ?? [];
  const turn = paneTurn.value?.turn;
  if (!turn) return messages;
  const start = messages.findIndex((m) => m.id === turn.messageId);
  if (start === -1) return messages;
  let end = messages.length;
  for (let i = start + 1; i < messages.length; i += 1) {
    if (messages[i]?.role === "user") {
      end = i;
      break;
    }
  }
  return messages.slice(start, end);
});

const activeStreamSessions = new Set<string>();
const streamBuffers = new Map<string, string>();
/** Sessions whose messages have been requested (or are already cached). */
const attemptedMessages = new Set<string>();

/**
 * Poll-based watchdogs for prompts awefork sent, keyed by session. Run-finish
 * signals ride the SSE stream (session.idle / session.status idle) and an
 * event-stream gap loses them forever — so every send also polls messages
 * until the run's assistant row reports a completion time. Whichever signal
 * lands first settles the run; the other becomes a no-op.
 */
const completionWatches = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; sentAt: number; ticks: number }
>();
const WATCH_INTERVAL_MS = 1500;
const WATCH_MAX_TICKS = 160; // give up after ~4 minutes; SSE busy frames re-set running anyway

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Trailing debounce: one refresh per burst of session events. */
function scheduleRefresh(delay = 400): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSessions();
  }, delay);
}

export async function init(): Promise<void> {
  const ready = await window.awefork.ready();
  if (!ready.ok) {
    state.connectionError = ready.error ?? "Failed to start opencode server.";
    return;
  }
  try {
    state.pins = await window.awefork.pins();
  } catch {
    state.pins = [];
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
    // node are ready the moment the working set finishes loading.
    if (
      state.selectedDirectory &&
      (!state.selectedId || !directorySessions.value.some((s) => s.id === state.selectedId))
    ) {
      await selectSession(latestSessionId(directorySessions.value));
    }
    await ensureCanvasMessages();
  } catch (error) {
    state.connectionError = error instanceof Error ? error.message : String(error);
  }
}

export async function switchDirectory(directory: string): Promise<void> {
  if (state.selectedDirectory === directory) return;
  state.selectedDirectory = directory;
  state.messagesError = null;
  await selectSession(latestSessionId(directorySessions.value), { focus: true });
  await ensureCanvasMessages();
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
  // The pane's model picker needs the catalog; load it once, lazily.
  void ensureModels();
  // Reload unconditionally: clicking a card is also the user's healing path
  // for a stale card (e.g. a lost SSE finish signal).
  await loadSessionMessages(sessionId);
  await ensureCanvasMessages();
}

/** Select a canvas node: switches branch if needed, remembers the turn. */
export async function selectTurn(node: TurnNode): Promise<void> {
  if (node.sessionId !== state.selectedId) {
    await selectSession(node.sessionId);
  }
  state.selectedTurnId = node.id;
}

/** Move the pane to a neighboring turn of the selected session (±1). */
export function stepTurn(delta: number): void {
  const pane = paneTurn.value;
  if (!pane) return;
  const target = selectedTurns.value[pane.index + delta];
  if (!target) return;
  state.selectedTurnId = `${target.sessionId}:${target.messageId}`;
}

/** Load messages for every session currently on the canvas that lacks them. */
async function ensureCanvasMessages(): Promise<void> {
  const pending = canvasSessions.value.filter((s) => !attemptedMessages.has(s.id)).map((s) => s.id);
  if (pending.length === 0) return;
  state.loadingMessages = true;
  await Promise.allSettled(pending.map((id) => loadSessionMessages(id)));
  state.loadingMessages = false;
}

async function loadSessionMessages(
  sessionId: string,
  reportError = true,
): Promise<ChatMessage[] | null> {
  attemptedMessages.add(sessionId);
  try {
    // Await first, THEN merge: spreading before the await would snapshot the
    // pre-await state, and concurrent loads would overwrite each other.
    const messages = await window.awefork.messages(sessionId);
    state.messagesBySession = { ...state.messagesBySession, [sessionId]: messages };
    return messages;
  } catch (error) {
    if (reportError && state.selectedId === sessionId) {
      state.messagesError = error instanceof Error ? error.message : String(error);
    }
    return null;
  }
}

/** Start (or restart) the poll watchdog for a prompt awefork just sent. */
function watchCompletion(sessionId: string, sentAt: number): void {
  stopWatch(sessionId);
  const timer = setInterval(() => {
    const watch = completionWatches.get(sessionId);
    if (!watch) return;
    watch.ticks += 1;
    void pollForCompletion(sessionId, watch);
  }, WATCH_INTERVAL_MS);
  completionWatches.set(sessionId, { timer, sentAt, ticks: 0 });
}

function stopWatch(sessionId: string): void {
  const watch = completionWatches.get(sessionId);
  if (watch) {
    clearInterval(watch.timer);
    completionWatches.delete(sessionId);
  }
}

async function pollForCompletion(
  sessionId: string,
  watch: { sentAt: number; ticks: number },
): Promise<void> {
  const messages = await loadSessionMessages(sessionId, false);
  // idle may have stopped the watch while the fetch was in flight.
  if (!completionWatches.has(sessionId)) return;
  const done = messages?.some(
    (m) => m.role === "assistant" && m.completedAt !== null && m.completedAt >= watch.sentAt,
  );
  if (done || watch.ticks >= WATCH_MAX_TICKS) {
    stopWatch(sessionId);
    settleRun(sessionId);
  }
}

/** Shared run-finished cleanup, driven by SSE idle or the poll watchdog. */
function settleRun(sessionId: string): void {
  activeStreamSessions.delete(sessionId);
  streamBuffers.delete(sessionId);
  const { [sessionId]: finished, ...stillRunning } = state.running;
  void finished;
  state.running = stillRunning;
  if (state.selectedId === sessionId) state.streamText = "";
}

function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case "session.updated": {
      // A single run emits several of these; coalesce into one refresh.
      scheduleRefresh();
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
      stopWatch(event.sessionId);
      settleRun(event.sessionId);
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

/** Pin or unpin a session: pinned branch stories stay on the canvas. */
export async function togglePin(sessionId: string): Promise<void> {
  try {
    state.pins = await window.awefork.togglePin(sessionId);
    await ensureCanvasMessages();
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Delete a session and its awefork sidecar records. The whole branch story
 * (every turn card of that session) disappears; child forks survive and
 * re-root themselves. Refused while the session has a run in flight.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  if (state.running[sessionId]) {
    state.actionError = "会话正在运行，先停止再删除。";
    return;
  }
  state.actionError = null;
  try {
    state.pins = await window.awefork.deleteSession(sessionId);
    stopWatch(sessionId);
    const { [sessionId]: goneMessages, ...keptMessages } = state.messagesBySession;
    void goneMessages;
    state.messagesBySession = keptMessages;
    attemptedMessages.delete(sessionId);
    activeStreamSessions.delete(sessionId);
    const { [sessionId]: goneRunning, ...keptRunning } = state.running;
    void goneRunning;
    state.running = keptRunning;
    const { [sessionId]: goneLineage, ...keptLineage } = state.lineage;
    void goneLineage;
    state.lineage = keptLineage;
    state.sessions = state.sessions.filter((s) => s.id !== sessionId);
    if (state.draft?.sessionId === sessionId) state.draft = null;
    if (state.selectedId === sessionId) {
      state.selectedId = null;
      state.selectedTurnId = null;
      await selectSession(latestSessionId(directorySessions.value));
    }
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Fork the selected session at its latest state — a checkpoint branch holding
 * the full story with nothing prompted yet. Lands you in the clone.
 */
export async function cloneSelectedSession(): Promise<void> {
  const sessionId = state.selectedId;
  if (!sessionId || state.running[sessionId]) return;
  state.actionError = null;
  try {
    const forked = await window.awefork.fork(sessionId, null);
    await refreshSessions();
    await selectSession(forked.id, { focus: true });
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/** Rename a session through the agent's native API and update local state. */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  try {
    await window.awefork.renameSession(sessionId, trimmed);
    state.sessions = state.sessions.map((s) => (s.id === sessionId ? { ...s, title: trimmed } : s));
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

export function openDraft(node: TurnNode): void {
  void ensureModels();
  state.draft = {
    nodeId: node.id,
    sessionId: node.sessionId,
    atMessageId: node.messageId,
    text: "",
    // Preselect the model that wrote the turn being forked from, when known.
    model: node.kind === "turn" ? node.model : null,
  };
}

export function setDraftText(text: string): void {
  if (state.draft) state.draft.text = text;
}

export function setDraftModel(model: ModelChoice | null): void {
  if (state.draft) state.draft.model = model;
}

export function dismissDraft(): void {
  state.draft = null;
}

let modelsRequested = false;

async function ensureModels(): Promise<void> {
  if (modelsRequested) return;
  modelsRequested = true;
  try {
    state.models = await window.awefork.models();
  } catch (error) {
    // Allow a later draft to retry — the catalog may load once the agent settles.
    modelsRequested = false;
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Copy a ModelChoice into a plain object. Draft state lives inside a Vue
 * reactive proxy, and ipcRenderer.invoke structured-clones its arguments —
 * a Proxy throws "An object could not be cloned", which used to swallow the
 * prompt after the fork had already been created.
 */
function plainModel(model: ModelChoice | null): ModelChoice | null {
  return model ? { providerId: model.providerId, modelId: model.modelId } : null;
}

/**
 * Send the draft: on a turn node this forks the session at that turn AND
 * fires the prompt on the new branch; on a stub node it simply continues the
 * (so far turn-less) branch. Either way the app lands IN the target session
 * with the pane following its newest turn.
 */
export async function sendDraft(): Promise<void> {
  const draft = state.draft;
  if (!draft?.text.trim() || state.draftSending) return;
  const text = draft.text.trim();
  state.actionError = null;
  state.draftSending = true;
  try {
    const model = plainModel(draft.model);
    const sentAt = Date.now();
    if (draft.atMessageId) {
      const forked = await window.awefork.fork(draft.sessionId, draft.atMessageId);
      await refreshSessions();
      await selectSession(forked.id, { focus: true });
      await window.awefork.prompt(forked.id, text, model);
      watchCompletion(forked.id, sentAt);
      // Surface the carried-over prompt as the branch's first own turn right
      // away; the idle refresh swaps it for the server's row.
      appendLocalMessage(forked.id, text, model);
    } else {
      await selectSession(draft.sessionId, { focus: true });
      await window.awefork.prompt(draft.sessionId, text, model);
      watchCompletion(draft.sessionId, sentAt);
      appendLocalMessage(draft.sessionId, text, model);
    }
    state.draft = null;
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  } finally {
    state.draftSending = false;
  }
}

/**
 * Show a sent prompt immediately; the next server refresh replaces it with
 * the real message row. `model` seeds the canvas card's model chip so the
 * chosen model shows before the server rows arrive.
 */
function appendLocalMessage(
  sessionId: string,
  text: string,
  model: ModelChoice | null = null,
): void {
  state.messagesBySession = {
    ...state.messagesBySession,
    [sessionId]: [
      ...(state.messagesBySession[sessionId] ?? []),
      {
        id: `local_${Date.now()}`,
        role: "user",
        text,
        toolNames: [],
        modelId: model?.modelId ?? null,
        providerId: model?.providerId ?? null,
        createdAt: Date.now(),
        completedAt: null,
        outputTokens: null,
      },
    ],
  };
}

/**
 * Send from the right-pane composer. Forks live on the canvas only, so this
 * always continues the branch at its end; the pane follows the newest turn
 * so the reply streams into view.
 */
export async function sendPanePrompt(text: string): Promise<void> {
  if (!state.selectedId || !text.trim()) return;
  state.selectedTurnId = null;
  await sendPrompt(text, state.paneModels[state.selectedId] ?? null);
}

export async function sendPrompt(text: string, model: ModelChoice | null = null): Promise<void> {
  if (!state.selectedId || !text.trim()) return;
  state.actionError = null;
  activeStreamSessions.add(state.selectedId);
  state.running = { ...state.running, [state.selectedId]: true };
  const sessionId = state.selectedId;
  const sentAt = Date.now();
  appendLocalMessage(sessionId, text, model);
  try {
    await window.awefork.prompt(sessionId, text, plainModel(model));
    watchCompletion(sessionId, sentAt);
  } catch (error) {
    activeStreamSessions.delete(sessionId);
    const { [sessionId]: stopped, ...rest } = state.running;
    void stopped;
    state.running = rest;
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/** Remember the model the pane composer should use for this session's next run. */
export function setPaneModel(sessionId: string, model: ModelChoice | null): void {
  state.paneModels = { ...state.paneModels, [sessionId]: model };
}

/** Ask the canvas to fit the whole working set in view (command palette). */
export function requestCanvasFit(): void {
  state.fitRequest = Date.now();
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
