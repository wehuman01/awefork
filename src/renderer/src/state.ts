import { computed, reactive, readonly, ref, watch } from "vue";
import {
  type BackendCapabilities,
  type BackendEventEnvelope,
  type BackendId,
  type BackendInfo,
  backendCapabilities,
} from "../../shared/backend";
import {
  buildTurnGraph,
  chainToTip,
  type TurnGraph,
  type TurnNode,
} from "../../shared/canvas-graph";
import { selectCanvasSessions } from "../../shared/canvas-scope";
import {
  buildSessionTree,
  descendantSessionIds,
  enrichSessions,
  pickNeighborId,
  type SessionGroup,
  type SessionTreeNode,
  withoutArchived,
} from "../../shared/session-tree";
import { searchTurns, type TurnSearchHit } from "../../shared/turn-search";
import { buildTurns, type Turn, turnMessageRange } from "../../shared/turns";
import type {
  AgentEvent,
  AgentInteractionRequest,
  AgentInteractionResponse,
  ArchiveState,
  ChatMessage,
  ForkRecord,
  ModelChoice,
  ModelOption,
  PersistedComposer,
  PersistedDraft,
  PromptAttachment,
  SessionFileChanges,
  SessionSummary,
} from "../../shared/types";
import { type DraftAttachment, draftFromPrompt, toPromptAttachments } from "./attachments";

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
  /** Files staged to go out with the next send. */
  attachments: DraftAttachment[];
}

/**
 * Running state of a backend that is NOT on screen. Parking the visible maps
 * here on switch — instead of re-keying them — keeps every component read
 * (`store.running[id]`) on plain session ids while an off-screen backend's
 * runs keep streaming and settling in their own partition.
 */
interface BackendRunState {
  running: Record<string, boolean>;
  streams: Record<string, string>;
  recent: Record<string, number>;
}

interface AppState {
  connectionError: string | null;
  /**
   * True once the startup session load has settled (sessions arrived or the
   * retries ran out). Gates the canvas's "no sessions yet" empty state so a
   * cold start or an offline server never claims the project is empty.
   */
  booted: boolean;
  /** The backend driving the visible canvas; every IPC call carries it. */
  activeBackend: BackendId;
  /** Switcher data from main (installed probe + persisted selection). */
  backendList: BackendInfo[];
  /** Feature surface of the active backend; hides affordances it lacks. */
  capabilities: BackendCapabilities;
  sessions: SessionSummary[];
  /**
   * Session ids sitting in the delete grace window: hidden from every view,
   * still alive on the server until the hard delete fires (or undo cancels it).
   */
  trash: string[];
  /** The latest soft delete, driving the undo toast; null = no toast. */
  deletedToast: { sessionId: string; title: string } | null;
  lineage: Record<string, ForkRecord>;
  /** Session ids the user starred (persisted in pins.json). */
  pins: string[];
  /**
   * The user's session labels, e.g. 执行 / 实验设计 / 咨询 (persisted in
   * tags.json as sessionId → ordered tag names). Pure awefork overlay like
   * pins: the sessions themselves keep living in the agent backend.
   */
  tags: Record<string, string[]>;
  /**
   * Sessions and directories tucked away (persisted in archive.json).
   * Pure awefork overlay: the data keeps living in the agent backend.
   */
  archive: ArchiveState;
  selectedDirectory: string | null;
  selectedId: string | null;
  /**
   * Turn node id shown in the right pane. null = follow the session's latest
   * turn (used when selecting a session or while a new turn streams in).
   */
  selectedTurnId: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  /**
   * Per-session file-change index (observer sidecar), keyed by session id
   * like messagesBySession — session ids never collide across backends, so
   * the map survives switches without parking.
   */
  fileChangesBySession: Record<string, SessionFileChanges | null>;
  loadingMessages: boolean;
  messagesError: string | null;
  /** Model catalog from the agent's provider config; loaded on first draft. */
  models: ModelOption[];
  /** sessionId → true while an active-backend run is in flight. */
  running: Record<string, boolean>;
  /**
   * sessionId → epoch ms when its last run settled without error. The card
   * carries a soft "刚跑完" tint that fades to neutral over RECENT_MS — helps
   * the user spot which branches just finished when the canvas is full.
   * Failed runs keep no entry: mint reads as success, and their cards
   * already carry ⚠ + retry.
   */
  recent: Record<string, number>;
  /** Live stream of the selected session only, as the run's ordered parts. */
  streamParts: LivePart[];
  /** Card-sized tail of every running session's stream, keyed by session id. */
  streams: Record<string, string>;
  /**
   * Running state of every backend other than the active one; a switch parks
   * the visible maps into the old backend's slot and restores the target's.
   */
  backgroundRuns: Record<string, BackendRunState>;
  actionError: string | null;
  /** Pending Codex approvals/inputs, partitioned so background runs survive a switch. */
  interactions: Record<string, AgentInteractionRequest[]>;
  /** interactionKey → epoch ms when that request auto-denies (drives the countdown). */
  interactionDeadlines: Record<string, number>;
  draft: DraftState | null;
  /** True while the draft's fork+prompt round-trip is in flight. */
  draftSending: boolean;
  /** Model the pane composer will use next, per session; null = agent default. */
  paneModels: Record<string, ModelChoice | null>;
  /** Bumped to ask the canvas to center on a session's latest node. */
  focusRequest: { sessionId: string; nonce: number } | null;
  /**
   * Bumped after 新增对话 so the pane composer grabs focus — the fresh
   * session is selected and ready for its first prompt.
   */
  composerFocusRequest: number | null;
  /** Bumped to ask the canvas to fit the whole working set in view. */
  fitRequest: number | null;
  /**
   * Bumped when a selection made outside the canvas (context-chain cards)
   * should also move the view: the canvas centers on this node.
   */
  turnJumpRequest: { nodeId: string; nonce: number } | null;
  /** Installed app version, filled in by the first update check (or the last one). */
  currentVersion: string | null;
  /** Newest release on GitHub; non-null while an update is available. */
  updateLatest: string | null;
  /** True while an update check round-trip is in flight. */
  checkingUpdates: boolean;
  /** The user closed the current update banner. In-memory only, no persistence. */
  updateBannerDismissed: boolean;
  /** One-line feedback for manual update checks; auto-clears like the undo toast. */
  updateToast: string | null;
}

const state = reactive<AppState>({
  connectionError: null,
  booted: false,
  activeBackend: "opencode",
  backendList: [],
  capabilities: { deleteMessage: true, attachments: true, fileChanges: true },
  sessions: [],
  trash: [],
  deletedToast: null,
  lineage: {},
  pins: [],
  tags: {},
  archive: { sessions: [], directories: [] },
  selectedDirectory: null,
  selectedId: null,
  selectedTurnId: null,
  messagesBySession: {},
  fileChangesBySession: {},
  loadingMessages: false,
  messagesError: null,
  models: [],
  running: {},
  recent: {},
  streamParts: [],
  streams: {},
  backgroundRuns: {
    opencode: { running: {}, streams: {}, recent: {} },
    codex: { running: {}, streams: {}, recent: {} },
  },
  actionError: null,
  interactions: { opencode: [], codex: [] },
  interactionDeadlines: {},
  composerFocusRequest: null,
  draft: null,
  draftSending: false,
  paneModels: {},
  focusRequest: null,
  fitRequest: null,
  turnJumpRequest: null,
  currentVersion: null,
  updateLatest: null,
  checkingUpdates: false,
  updateBannerDismissed: false,
  updateToast: null,
});

export const store = readonly(state);

/** Readonly shape of a chat message as seen by components. */
export type ReadonlyChatMessage = (typeof store)["messagesBySession"][string][number];

/** Sessions still shown: everything outside the delete grace window and the archive. */
export const visibleSessions = computed<SessionSummary[]>(() => {
  const trashed = new Set(state.trash);
  return withoutArchived(
    state.sessions.filter((s) => !trashed.has(s.id)),
    state.archive,
  );
});

export const sessionGroups = computed<SessionGroup[]>(() =>
  buildSessionTree(visibleSessions.value, state.lineage),
);

export const directories = computed<string[]>(() => {
  const latest = new Map<string, number>();
  for (const session of visibleSessions.value) {
    latest.set(session.directory, Math.max(latest.get(session.directory) ?? 0, session.updatedAt));
  }
  return [...latest.keys()].sort((a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0));
});

/** An archived directory as the sidebar's archive section shows it. */
export interface ArchivedDirectoryView {
  path: string;
  archivedAt: number;
  /** Sessions currently hidden under the path (live server state, trash excluded). */
  hiddenCount: number;
}

/** An individually archived session as the archive section shows it. */
export interface ArchivedSessionView {
  id: string;
  archivedAt: number;
  title: string;
  directory: string;
}

export const archivedDirectoryViews = computed<ArchivedDirectoryView[]>(() =>
  state.archive.directories
    .map((entry) => ({
      ...entry,
      hiddenCount: state.sessions.filter(
        (s) => s.directory === entry.path && !state.trash.includes(s.id),
      ).length,
    }))
    .sort((a, b) => b.archivedAt - a.archivedAt),
);

export const archivedSessionViews = computed<ArchivedSessionView[]>(() =>
  state.archive.sessions
    .map((entry) => {
      const session = state.sessions.find((s) => s.id === entry.id);
      return {
        ...entry,
        title: session?.title || "(已删除)",
        directory: session?.directory ?? "",
      };
    })
    .sort((a, b) => b.archivedAt - a.archivedAt),
);

const enrichedSessions = computed<SessionSummary[]>(() =>
  enrichSessions(visibleSessions.value, state.lineage),
);

const directorySessions = computed<SessionSummary[]>(() =>
  enrichedSessions.value.filter((s) => s.directory === state.selectedDirectory),
);

/**
 * Starred sessions across every directory, most recently starred first —
 * the sidebar's favorites shelf. Purely a retrieval view: starring no
 * longer puts anything on the canvas.
 */
export const favoriteSessions = computed<SessionSummary[]>(() => {
  const byId = new Map(visibleSessions.value.map((s) => [s.id, s]));
  return [...state.pins]
    .reverse()
    .map((id) => byId.get(id))
    .filter((s): s is SessionSummary => s !== undefined);
});

/**
 * What the canvas draws: the selected session's whole story. The full
 * session list stays in the sidebar; stars live in the favorites shelf.
 */
export const canvasSessions = computed<SessionSummary[]>(() =>
  selectCanvasSessions(directorySessions.value, state.lineage, state.selectedId),
);

/**
 * Rendered card heights the canvas has measured (node id → px). Feeding them
 * back into the graph lets row bands follow real content; height depends only
 * on content + fixed card width, so measure → re-layout converges in one pass.
 */
export const cardHeights = reactive<Record<string, number>>({});

export const turnGraph = computed<TurnGraph>(() =>
  buildTurnGraph({
    sessions: canvasSessions.value,
    lineage: state.lineage,
    messages: state.messagesBySession,
    heights: cardHeights,
  }),
);

/**
 * The canvas story search: the query the search panel edits, and its hits
 * over every turn on the canvas — full prompt bodies, replies, tool names.
 * Living in state (not the component) lets the canvas ring every matching
 * card while the query is active.
 */
export const searchQuery = ref("");
export const storySearchHits = computed<TurnSearchHit[]>(() =>
  searchQuery.value.trim() === ""
    ? []
    : searchTurns(turnGraph.value.nodes, searchQuery.value, state.messagesBySession),
);

/**
 * The selected turn's lineage from its story's root down to the tip, root
 * first. Tip: the locked turn, else the selected session's latest node —
 * matching the pane's follow-latest behavior. The canvas highlights this
 * path and the pane renders the turns before it as context.
 */
const activeTipNode = computed<TurnNode | null>(() => {
  const graph = turnGraph.value;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const selected = state.selectedTurnId;
  let tip: TurnNode | null = selected ? (nodeById.get(selected) ?? null) : null;
  if (!tip && state.selectedId) {
    const nodes = graph.nodes.filter((n) => n.sessionId === state.selectedId);
    tip = nodes.length > 0 ? (nodes[nodes.length - 1] ?? null) : null;
  }
  return tip;
});

export const activeChain = computed<TurnNode[]>(() =>
  chainToTip(turnGraph.value, activeTipNode.value?.id ?? null),
);

/**
 * The selected turn's direct children — one generation only: the next turn
 * in the same session plus the first card of every branch forked from it.
 * The canvas tints these a notch lighter than the active path; deeper
 * generations and sibling branches keep the plain card style.
 */
export const childTurnIds = computed<Set<string>>(() => {
  const tip = activeTipNode.value;
  const ids = new Set<string>();
  if (!tip) return ids;
  for (const edge of turnGraph.value.edges) {
    if (edge.from === tip.id) ids.add(edge.to);
  }
  return ids;
});

export const selectedSession = computed<SessionSummary | null>(
  () => visibleSessions.value.find((s) => s.id === state.selectedId) ?? null,
);

/**
 * Sessions forked from the selected one — its whole subtree. No longer a
 * highlight; the ⎇ badge's 子树取景 still frames these to put the whole
 * fork tree in view.
 */
export const forkedFromSelection = computed<Set<string>>(() =>
  descendantSessionIds(canvasSessions.value, state.lineage, state.selectedId),
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

/**
 * Model+thinking the pane composer starts from: an explicit pick for this
 * session — including a deliberate 默认模型 — always wins, otherwise the
 * composer mirrors the branch itself and shows the model and variant that
 * wrote the turn the pane is on. Selecting a session therefore selects its
 * setup with it, and only a hand-picked model ever overrides that.
 */
export const paneComposerModel = computed<ModelChoice | null>(() => {
  const id = state.selectedId;
  if (!id) return null;
  if (id in state.paneModels) return state.paneModels[id] ?? null;
  return paneTurn.value?.turn.model ?? null;
});

/**
 * Messages of the pane's turn: from its user prompt up to the next one.
 * Assistant rows with neither text nor thinking are dropped — except failed
 * runs, whose error must stay visible. User rows always stay; they anchor the
 * turn, and turn boundaries are user rows, so the filter cannot shift them.
 */
export const paneMessages = computed<ChatMessage[]>(() => {
  const sessionId = state.selectedId;
  // Assistant rows that are still incomplete while their parts stream render
  // through the live part timeline instead — the poll's mid-run reload would
  // otherwise duplicate the streaming step above the live blocks.
  const streaming =
    sessionId && state.running[sessionId]
      ? new Set(state.streamParts.map((p) => p.messageId))
      : new Set<string>();
  const messages = (state.messagesBySession[sessionId ?? ""] ?? []).filter(
    (m) =>
      !(m.role === "assistant" && m.completedAt === null && streaming.has(m.id)) &&
      (m.role === "user" ||
        m.text.trim().length > 0 ||
        m.thinking.trim().length > 0 ||
        m.error !== null),
  );
  const turn = paneTurn.value?.turn;
  if (!turn) return messages;
  const range = turnMessageRange(messages, turn.messageId);
  return range ? messages.slice(range.start, range.end) : messages;
});

/**
 * One streaming part of a running session (opencode part = one step's text or
 * reasoning; codex item = the same). The run's parts are kept in arrival
 * order so the pane can show each step's thinking and reply interleaved on
 * the timeline instead of as two merged blobs.
 */
export interface LivePart {
  /** part id (opencode part / codex item); unique within the run. */
  partId: string;
  /** Assistant message (run step) the part belongs to. */
  messageId: string;
  kind: "text" | "thinking";
  text: string;
  /** Part snapshot times in ms; endedAt stays null until the part finishes. */
  startedAt: number | null;
  endedAt: number | null;
}

/**
 * Per-backend namespace for the live part buffers: both backends can stream
 * at once, and the composite key keeps an off-screen run's parts from ever
 * colliding with (or publishing into) the on-screen session.
 */
function streamKey(backend: BackendId, sessionId: string): string {
  return `${backend}:${sessionId}`;
}

const streamBuffers = new Map<string, LivePart[]>();
/** True once the assistant row for these parts has landed complete in state. */
function rowCompleted(sessionId: string, messageId: string): boolean {
  return (state.messagesBySession[sessionId] ?? []).some(
    (m) => m.id === messageId && m.role === "assistant" && m.completedAt !== null,
  );
}

/**
 * The run-state partition one backend writes to: the visible maps when it is
 * the active backend, else its parked background slot. Every running/stream/
 * recent mutation goes through this — components keep reading plain session
 * ids off the visible maps, background runs stay invisible but alive.
 */
function runSlot(backend: BackendId): BackendRunState {
  if (backend === state.activeBackend) return state;
  let entry = state.backgroundRuns[backend];
  if (!entry) {
    entry = { running: {}, streams: {}, recent: {} };
    state.backgroundRuns = { ...state.backgroundRuns, [backend]: entry };
  }
  return entry;
}

function setRunning(backend: BackendId, sessionId: string, running: boolean): void {
  const slot = runSlot(backend);
  if (running) {
    slot.running = { ...slot.running, [sessionId]: true };
    return;
  }
  const { [sessionId]: gone, ...kept } = slot.running;
  void gone;
  slot.running = kept;
}

function isRunning(backend: BackendId, sessionId: string): boolean {
  return Boolean(runSlot(backend).running[sessionId]);
}

function setStreamTail(backend: BackendId, sessionId: string, tail: string | null): void {
  const slot = runSlot(backend);
  if (tail === null) {
    const { [sessionId]: gone, ...kept } = slot.streams;
    void gone;
    slot.streams = kept;
  } else {
    slot.streams = { ...slot.streams, [sessionId]: tail };
  }
}

function setRecent(backend: BackendId, sessionId: string, at: number): void {
  const slot = runSlot(backend);
  slot.recent = { ...slot.recent, [sessionId]: at };
}

function getRecent(backend: BackendId, sessionId: string): number | undefined {
  return runSlot(backend).recent[sessionId];
}

/** Store a session's live parts and mirror what depends on them. */
function publishParts(backend: BackendId, sessionId: string, parts: LivePart[]): void {
  const key = streamKey(backend, sessionId);
  if (parts.length === 0) streamBuffers.delete(key);
  else streamBuffers.set(key, parts);
  if (backend === state.activeBackend && state.selectedId === sessionId) {
    state.streamParts = [...parts];
  }
  // Card-sized tails keep showing only final reply text; thinking belongs in
  // the pane's collapsible blocks, not in the compact canvas preview.
  const tail = [...parts].reverse().find((p) => p.kind === "text");
  setStreamTail(backend, sessionId, tail ? tail.text.slice(-400) : null);
}

/**
 * Fold one delta or full-snapshot frame into the session's live part list.
 * Deltas append to (or create) the part; snapshots REPLACE its content — the
 * frame carries the whole part, so a delta lost to an SSE gap self-heals the
 * moment the next snapshot lands, and a reasoning part's time.end flips its
 * block into the collapsed Thought summary.
 */
function applyPartFrame(
  backend: BackendId,
  sessionId: string,
  frame:
    | {
        type: "delta";
        messageId: string;
        partId: string;
        kind: "text" | "thinking";
        delta: string;
      }
    | {
        type: "snapshot";
        messageId: string;
        partId: string;
        kind: "text" | "thinking";
        text: string;
        startedAt: number | null;
        endedAt: number | null;
      },
): void {
  // A completed row renders from state; late frames for it must not
  // resurrect content the reload already took over.
  if (rowCompleted(sessionId, frame.messageId)) return;
  const parts = streamBuffers.get(streamKey(backend, sessionId)) ?? [];
  const index = parts.findIndex((p) => p.partId === frame.partId);
  const base: LivePart = parts[index] ?? {
    partId: frame.partId,
    messageId: frame.messageId,
    kind: frame.kind,
    text: "",
    startedAt: null,
    endedAt: null,
  };
  const next: LivePart =
    frame.type === "delta"
      ? { ...base, text: base.text + frame.delta }
      : { ...base, text: frame.text, startedAt: frame.startedAt, endedAt: frame.endedAt };
  publishParts(
    backend,
    sessionId,
    index >= 0 ? parts.map((p, i) => (i === index ? next : p)) : [...parts, next],
  );
}

/**
 * Drop live parts whose assistant row has landed complete: from here on the
 * row itself renders that step, and the live timeline keeps only the steps
 * still in flight.
 */
function pruneSettledParts(backend: BackendId, sessionId: string, messages: ChatMessage[]): void {
  const parts = streamBuffers.get(streamKey(backend, sessionId));
  if (!parts || parts.length === 0) return;
  const done = new Set(
    messages.filter((m) => m.role === "assistant" && m.completedAt !== null).map((m) => m.id),
  );
  if (!parts.some((p) => done.has(p.messageId))) return;
  publishParts(
    backend,
    sessionId,
    parts.filter((p) => !done.has(p.messageId)),
  );
}

/** Sessions whose messages have been requested (or are already cached). */
const attemptedMessages = new Set<string>();

/**
 * Poll-based watchdogs for prompts awefork sent, keyed by backend-scoped
 * session. Run-finish signals ride the event stream (session.idle / status
 * idle) and an event-stream gap loses them forever — so every send also polls
 * messages until the run's assistant row reports a completion time. Whichever
 * signal lands first settles the run; the other becomes a no-op.
 */
interface CompletionWatch {
  /** Backend the watch polls through (messages is backend-routed). */
  backend: BackendId;
  /** When the prompt was sent; only rows completed after this count. */
  sentAt: number;
  /** Polls since the last liveness sign (delta or observable message growth). */
  ticks: number;
  /** Last observed message-list fingerprint; a change is liveness. */
  signature: string;
}

const completionWatches = new Map<string, CompletionWatch>();
const interactionTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Mirrors main's JSON-RPC safe-reply deadline; exported for the countdown UI. */
export const INTERACTION_TIMEOUT_MS = 30_000;
const WATCH_INTERVAL_MS = 1500;
// Give up after ~4 minutes with no completion AND no liveness sign — every
// delta resets the ticks, and so does any poll that observes the message list
// still growing (some opencode builds stream no deltas at all), so only a run
// that went fully silent (or a lost connection) can reach the cap; settling is
// then the right backstop.
const WATCH_MAX_TICKS = 160;

// One interval drives every watch. Parallel branches are the app's core move,
// and an interval per session made N running sessions poll N times per tick;
// the shared clock keeps the load at one pass per interval no matter how many
// branches run.
let watchTicker: ReturnType<typeof setInterval> | null = null;

function startWatchTicker(): void {
  if (watchTicker !== null) return;
  watchTicker = setInterval(() => {
    for (const [key, watch] of [...completionWatches]) {
      watch.ticks += 1;
      void pollForCompletion(key);
    }
  }, WATCH_INTERVAL_MS);
}

function stopWatchTickerIfIdle(): void {
  if (watchTicker === null || completionWatches.size > 0) return;
  clearInterval(watchTicker);
  watchTicker = null;
}

/** Session id half of a backend-scoped watch key. */
function sessionOfKey(key: string): string {
  return key.slice(key.indexOf(":") + 1);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Pause before the silent startup update check; the server needs a moment. */
const UPDATE_CHECK_DELAY_MS = 3000;

/** Trailing debounce: one refresh per burst of session events. */
function scheduleRefresh(delay = 400): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSessions();
  }, delay);
}

/**
 * Boot one backend into the visible workspace: ready handshake, overlay
 * stores, trash flush, first session load. Shared by app start and every
 * backend switch so both paths behave identically.
 */
async function bootBackend(backend: BackendId): Promise<void> {
  const ready = await window.awefork.ready(backend);
  if (!ready.ok) {
    state.connectionError = ready.error ?? `Failed to start the ${backend} server.`;
    return;
  }
  try {
    state.pins = await window.awefork.pins(backend);
  } catch {
    state.pins = [];
  }
  try {
    state.tags = await window.awefork.tags(backend);
  } catch {
    state.tags = {};
  }
  try {
    state.archive = await window.awefork.archive(backend);
  } catch {
    state.archive = { sessions: [], directories: [] };
  }
  try {
    state.trash = (await window.awefork.trash(backend)).map((entry) => entry.id);
  } catch {
    state.trash = [];
  }
  await flushTrash();
  await initialSessionLoad();
  state.booted = true;
  // Needs the session list in place; never blocks first paint. Runs after
  // every boot — startup and backend switch alike — so each backend hands
  // back its own unsent draft.
  void restoreComposer();
}

export async function init(): Promise<void> {
  let backend: BackendId = "opencode";
  try {
    const { selected, backends } = await window.awefork.backends();
    state.backendList = backends;
    // A persisted selection whose CLI went missing falls back to opencode —
    // the backend this app has always shipped with.
    backend = backends.some((b) => b.id === selected && b.installed) ? selected : "opencode";
  } catch {
    state.backendList = [
      { id: "opencode", label: "opencode", installed: true, version: null, versionWarning: null },
    ];
  }
  state.activeBackend = backend;
  try {
    state.capabilities = await window.awefork.capabilities(backend);
  } catch {
    state.capabilities = backendCapabilities(backend);
  }
  // Subscribe before the first fetch: a cold-started agent announces its
  // session scan right as it comes up, and those frames would be dropped by
  // a listener attached only after the initial load.
  window.awefork.onEvent(handleEnvelope);
  await bootBackend(backend);
  // New-version check once startup settles: the agent server has just come up,
  // so give the handshake a beat. Fire-and-forget — never blocks first paint,
  // and every failure path stays silent.
  setTimeout(() => {
    void checkForUpdates("startup").catch(() => null);
  }, UPDATE_CHECK_DELAY_MS);
}

/**
 * A cold-started agent can answer its API before its session scan finishes,
 * so the first fetch may see an empty list or a transient timeout. Retry
 * with backoff until sessions appear or the attempts run out; a genuinely
 * empty account simply settles after the last attempt.
 */
const INITIAL_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

async function initialSessionLoad(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await refreshSessions();
    if (state.connectionError === null && state.sessions.length > 0) return;
    const delay = INITIAL_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Execute the hard deletes a previous run left pending (app quit inside the
 * grace window, or a flush that failed). Entries that fail to delete are
 * dropped from the trash anyway — the session simply stays alive server-side,
 * same as a failed in-session hard delete.
 */
async function flushTrash(): Promise<void> {
  const backend = state.activeBackend;
  for (const sessionId of [...state.trash]) {
    try {
      await window.awefork.deleteSession(backend, sessionId);
    } catch {
      // Already gone server-side — nothing left to delete.
    }
    try {
      state.trash = (await window.awefork.trashRemove(backend, sessionId)).map((entry) => entry.id);
    } catch {
      // A leftover entry just flushes again next startup.
    }
  }
}

export async function refreshSessions(): Promise<void> {
  const backend = state.activeBackend;
  try {
    const { sessions, lineage } = await window.awefork.sessions(backend);
    state.sessions = sessions;
    state.lineage = lineage;
    // The fetch is the connection test; success revives a UI that an earlier
    // failure (or a cold-start timeout) had flagged as offline.
    state.connectionError = null;

    // Prune archive entries whose session no longer exists server-side (e.g.
    // deleted in the agent's own TUI); directory entries match by path and
    // never go stale. A failed prune retries on the next refresh.
    const alive = new Set(sessions.map((s) => s.id));
    for (const entry of state.archive.sessions) {
      if (alive.has(entry.id)) continue;
      try {
        state.archive = await window.awefork.archiveRemove(backend, "session", entry.id);
      } catch {
        // Left for the next refresh.
      }
    }

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

/**
 * The open project's last visible session went away (deleted or archived):
 * move to the busiest remaining directory, or drop to the empty state when
 * none is left — the same view a fresh install shows. refreshSessions re-picks
 * a directory as soon as one becomes visible again (e.g. after a restore).
 */
async function leaveEmptiedDirectory(): Promise<void> {
  const next = directories.value.find((d) => d !== state.selectedDirectory);
  if (next) await switchDirectory(next);
  else state.selectedDirectory = null;
}

export async function selectSession(
  sessionId: string | null,
  options: { focus?: boolean } = {},
): Promise<void> {
  if (!sessionId) return;
  const session = visibleSessions.value.find((item) => item.id === sessionId);
  if (!session) return;
  state.selectedDirectory = session.directory;
  state.selectedId = session.id;
  state.selectedTurnId = null;
  state.streamParts = [...(streamBuffers.get(streamKey(state.activeBackend, sessionId)) ?? [])];
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

/**
 * Select a canvas node: switches branch if needed, remembers the turn.
 * `focusCanvas` additionally asks the canvas to center on the node — for
 * selections made outside the canvas (chain cards); canvas clicks skip it
 * so the view never shifts under the user's cursor.
 */
export async function selectTurn(
  node: TurnNode,
  options: { focusCanvas?: boolean } = {},
): Promise<void> {
  if (node.sessionId !== state.selectedId) {
    await selectSession(node.sessionId);
  }
  state.selectedTurnId = node.id;
  if (options.focusCanvas) {
    state.turnJumpRequest = { nodeId: node.id, nonce: Date.now() };
  }
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
  backend: BackendId = state.activeBackend,
): Promise<ChatMessage[] | null> {
  // First load only: the watchdog polls this function every interval while a
  // run streams, and the index refresh rides the run-settle path instead.
  const firstLoad = !attemptedMessages.has(sessionId);
  attemptedMessages.add(sessionId);
  try {
    // Await first, THEN merge: spreading before the await would snapshot the
    // pre-await state, and concurrent loads would overwrite each other.
    const messages = await window.awefork.messages(backend, sessionId);
    state.messagesBySession = { ...state.messagesBySession, [sessionId]: messages };
    pruneSettledParts(backend, sessionId, messages);
    if (firstLoad) refreshFileChanges(sessionId, backend);
    return messages;
  } catch (error) {
    if (reportError && backend === state.activeBackend && state.selectedId === sessionId) {
      state.messagesError = error instanceof Error ? error.message : String(error);
    }
    return null;
  }
}

/**
 * Refresh a session's file-change index. Never blocks the message load —
 * the card is an overlay on data that is already rendered. Skipped for
 * backends without recording (the invoke would only come back empty).
 */
function refreshFileChanges(sessionId: string, backend: BackendId): void {
  if (!backendCapabilities(backend).fileChanges) return;
  void window.awefork
    .fileChanges(backend, sessionId)
    .then((changes) => {
      state.fileChangesBySession = { ...state.fileChangesBySession, [sessionId]: changes };
    })
    .catch(() => {
      // A missing sidecar is the common case (sessions edited offline); the
      // pane shows the not-recorded hint instead.
    });
}

/** Start (or restart) the poll watchdog for a prompt awefork just sent. */
function watchCompletion(backend: BackendId, sessionId: string, sentAt: number): void {
  stopWatch(backend, sessionId);
  completionWatches.set(streamKey(backend, sessionId), {
    backend,
    sentAt,
    ticks: 0,
    signature: "",
  });
  startWatchTicker();
}

function stopWatch(backend: BackendId, sessionId: string): void {
  if (completionWatches.delete(streamKey(backend, sessionId))) stopWatchTickerIfIdle();
}

async function pollForCompletion(key: string): Promise<void> {
  const watch = completionWatches.get(key);
  if (!watch) return;
  const sessionId = sessionOfKey(key);
  const messages = await loadSessionMessages(sessionId, false, watch.backend);
  // Re-read the live entry: idle may have stopped the watch while the fetch
  // was in flight, and a quick resend may have replaced it — judging by the
  // entry captured before the await would settle the new run against the old
  // prompt's completion rows.
  const live = completionWatches.get(key);
  if (!live) return;
  // Message rows still appearing is liveness too — on opencode builds that
  // stream no deltas, this is the only progress signal the watchdog sees.
  const last = messages?.[messages.length - 1];
  const signature = `${messages?.length ?? 0}:${last?.id ?? ""}:${last?.completedAt ?? ""}`;
  if (signature !== live.signature) {
    live.ticks = 0;
    live.signature = signature;
  }
  // A multi-step run completes one assistant row per step; a step that ended
  // in "tool-calls" is mid-run, not done. Treating it as finished settled the
  // run early and froze the turn at "(工具调用，无文本回复)" while the
  // follow-up step was still thinking — with no idle event ever coming on
  // this opencode build, nothing reloaded the final text.
  const done = messages?.some(
    (m) =>
      m.role === "assistant" &&
      m.completedAt !== null &&
      m.completedAt >= live.sentAt &&
      m.finish !== "tool-calls",
  );
  if (done || live.ticks >= WATCH_MAX_TICKS) {
    stopWatch(live.backend, sessionId);
    settleRun(live.backend, sessionId);
  }
}

/** How long a settled session keeps its "刚跑完" tint, and the fade granularity. */
const RECENT_MS = 5 * 60_000;
const RECENT_TICK_MS = 30_000;

const recentNow = ref(Date.now());
let recentTicker: ReturnType<typeof setInterval> | null = null;

function startRecentTicker(): void {
  if (recentTicker !== null) return;
  recentTicker = setInterval(() => {
    recentNow.value = Date.now();
  }, RECENT_TICK_MS);
}

function stopRecentTicker(): void {
  if (recentTicker === null) return;
  clearInterval(recentTicker);
  recentTicker = null;
}

function clearRecent(backend: BackendId, sessionId: string): void {
  const slot = runSlot(backend);
  if (!(sessionId in slot.recent)) return;
  const { [sessionId]: gone, ...kept } = slot.recent;
  void gone;
  slot.recent = kept;
  if (backend === state.activeBackend && Object.keys(state.recent).length === 0) {
    stopRecentTicker();
  }
}

/** Shared run-finished cleanup, driven by event-stream idle, the poll
 * watchdog, or a failed run (transport/prompt error). */
function settleRun(backend: BackendId, sessionId: string, failed = false): void {
  stopWatch(backend, sessionId);
  streamBuffers.delete(streamKey(backend, sessionId));
  setStreamTail(backend, sessionId, null);
  setRunning(backend, sessionId, false);
  // A failed run carries no tint — mint reads as success, and its card already
  // shows ⚠ + retry. A prior run's tint goes with it, so a visible tint always
  // means "the last run completed".
  if (failed) {
    clearRecent(backend, sessionId);
  } else {
    const settledAt = Date.now();
    setRecent(backend, sessionId, settledAt);
    startRecentTicker();
    setTimeout(() => {
      // A newer settle overwrote the entry; the older timer must not clear it.
      if (getRecent(backend, sessionId) === settledAt) clearRecent(backend, sessionId);
    }, RECENT_MS);
  }
  if (backend === state.activeBackend && state.selectedId === sessionId) {
    state.streamParts = [];
  }
}

/**
 * 0..1 freshness of a session's last settled run — 1 right after settle,
 * 0 once RECENT_MS has passed (or while a new run is in flight). Reading
 * recentNow keeps this reactive, so tints re-evaluate on each tick.
 */
export function recentAlphaFor(sessionId: string): number {
  if (state.running[sessionId]) return 0;
  const at = state.recent[sessionId];
  if (at === undefined) return 0;
  const age = recentNow.value - at;
  if (age >= RECENT_MS) return 0;
  return 1 - age / RECENT_MS;
}

async function finishRun(backend: BackendId, sessionId: string): Promise<void> {
  // Replace the live bubble only after its persisted counterpart is in state.
  // Both mutations occur before Vue renders, avoiding an empty or duplicated
  // assistant slot at the end of a streamed response.
  const messages = await loadSessionMessages(sessionId, false, backend);
  // The run's file changes settle with it; the card appears without the user
  // reselecting anything.
  refreshFileChanges(sessionId, backend);
  // The last assistant row says how the run ended; an errored one settles
  // without the tint (its card carries ⚠ + retry instead).
  const assistants = (messages ?? []).filter((m) => m.role === "assistant");
  const lastRun = assistants[assistants.length - 1];
  settleRun(backend, sessionId, Boolean(lastRun?.error));
  if (backend === state.activeBackend) void refreshSessions();
}

function interactionKey(backend: BackendId, requestId: string): string {
  return `${backend}:${requestId}`;
}

/** Remove one queued request (and its auto-deny timer) without replying. */
function dropInteraction(backend: BackendId, requestId: string): void {
  const key = interactionKey(backend, requestId);
  const timer = interactionTimers.get(key);
  if (timer) clearTimeout(timer);
  interactionTimers.delete(key);
  delete state.interactionDeadlines[key];
  state.interactions[backend] = (state.interactions[backend] ?? []).filter(
    (item) => item.requestId !== requestId,
  );
}

/**
 * A settled session (idle or failed run) or a dead server makes its queued
 * requests moot — the JSON-RPC layer already safe-replied them (30s guard) or
 * the connection is gone. Drop them so no dialog outlives its turn; the
 * adapter side resolves orphans as no-ops, so no stray reply is needed here.
 */
function dropSessionInteractions(backend: BackendId, sessionId?: string): void {
  for (const item of state.interactions[backend] ?? []) {
    if (!sessionId || item.sessionId === sessionId) dropInteraction(backend, item.requestId);
  }
}

export function respondInteraction(
  // Only the id travels back over IPC; the request object itself stays
  // renderer-local (deep-readonly straight out of the store).
  request: { readonly requestId: string },
  response: AgentInteractionResponse,
): void {
  const backend = state.activeBackend;
  dropInteraction(backend, request.requestId);
  void window.awefork.respondInteraction(backend, request.requestId, response).catch((error) => {
    state.actionError = error instanceof Error ? error.message : String(error);
  });
}

function queueInteraction(backend: BackendId, request: AgentInteractionRequest): void {
  const key = interactionKey(backend, request.requestId);
  const existing = state.interactions[backend] ?? [];
  if (existing.some((item) => item.requestId === request.requestId)) return;
  state.interactions[backend] = [...existing, request];
  state.interactionDeadlines[key] = Date.now() + INTERACTION_TIMEOUT_MS;
  interactionTimers.set(
    key,
    setTimeout(() => {
      // An explicit reply or cleanup already removed it; this timer is stale.
      if (
        !(state.interactions[backend] ?? []).some((item) => item.requestId === request.requestId)
      ) {
        return;
      }
      dropInteraction(backend, request.requestId);
      void window.awefork.respondInteraction(backend, request.requestId, { decision: "deny" });
    }, INTERACTION_TIMEOUT_MS),
  );
}

/**
 * Route one envelope to its backend's partition. Events from the off-screen
 * backend keep its parked run state and watchdogs moving (so a switch back
 * resumes exactly where the run is); only the active backend re-renders the
 * visible workspace.
 */
function handleEnvelope(envelope: BackendEventEnvelope): void {
  handleEvent(envelope.backend, envelope.event);
}

function handleEvent(backend: BackendId, event: AgentEvent): void {
  switch (event.type) {
    case "interaction.requested": {
      queueInteraction(backend, event.request);
      break;
    }
    case "session.updated": {
      // A single run emits several of these; coalesce into one refresh.
      if (backend === state.activeBackend) scheduleRefresh();
      break;
    }
    case "message.started": {
      setRunning(backend, event.sessionId, true);
      // Runs started outside awefork (the agent's own TUI) need the poll
      // backstop too: on builds that stream no deltas, this busy frame is
      // the only signal the renderer ever receives — without a watch, a
      // dropped idle leaves the session "running" (and undeletable) forever.
      // Existing watches keep their sentAt; a prompt awefork just sent armed
      // one already, and restarting it here would lose the pre-prompt stamp.
      if (!completionWatches.has(streamKey(backend, event.sessionId))) {
        watchCompletion(backend, event.sessionId, Date.now());
      }
      break;
    }
    case "message.delta": {
      // A delta is proof the run is alive. It re-lights a session whose busy
      // frame never arrived (or that a silent stretch let the watchdog settle)
      // and resets the watchdog so streaming runs cannot time out mid-flight.
      if (!isRunning(backend, event.sessionId)) {
        setRunning(backend, event.sessionId, true);
      }
      const watch = completionWatches.get(streamKey(backend, event.sessionId));
      if (watch) watch.ticks = 0;
      else watchCompletion(backend, event.sessionId, Date.now());
      applyPartFrame(backend, event.sessionId, {
        type: "delta",
        messageId: event.messageId,
        partId: event.partId,
        kind: event.kind,
        delta: event.delta,
      });
      break;
    }
    case "message.part": {
      // Snapshots carry no liveness of their own (fork creation replays them
      // for every copied message), so they only fold into an already-running
      // stream — never start one.
      if (
        isRunning(backend, event.sessionId) ||
        streamBuffers.has(streamKey(backend, event.sessionId))
      ) {
        applyPartFrame(backend, event.sessionId, {
          type: "snapshot",
          messageId: event.messageId,
          partId: event.partId,
          kind: event.kind,
          text: event.text,
          startedAt: event.startedAt,
          endedAt: event.endedAt,
        });
      }
      break;
    }
    case "session.idle": {
      stopWatch(backend, event.sessionId);
      // The turn finished, so any queued approval/input it blocked on is gone
      // (codex only ends a turn after its server requests resolve or time out).
      dropSessionInteractions(backend, event.sessionId);
      void finishRun(backend, event.sessionId);
      break;
    }
    case "server.reconnected": {
      if (backend !== state.activeBackend) break;
      // The stream is back after an outage: drop the outage toast and rebuild
      // the list — every event fired while disconnected was missed.
      state.actionError = null;
      void refreshSessions();
      break;
    }
    case "server.error": {
      // Toast regardless of which backend failed — a background run dying is
      // exactly what the user needs to hear about.
      state.actionError = event.message;
      // A failed prompt (or a server-side run error) never produces a
      // completion signal, so the watchdog would otherwise keep the session
      // "running" for its whole timeout. Settle the named session up front;
      // connection-level errors carry no sessionId and only toast.
      if (event.sessionId) {
        stopWatch(backend, event.sessionId);
        settleRun(backend, event.sessionId, true);
        dropSessionInteractions(backend, event.sessionId);
        if (backend === state.activeBackend) {
          // Reload so the optimistic local prompt row disappears if the
          // request never reached the server, and a mid-flight failure's ⚠
          // row shows now instead of waiting out the watchdog.
          void loadSessionMessages(event.sessionId);
          void refreshSessions();
        }
      } else {
        // Connection-level failure: this backend's queued requests can no
        // longer be answered meaningfully — take their dialogs down too.
        dropSessionInteractions(backend);
      }
      break;
    }
  }
}

/** Pin or unpin a session: pinned branch stories stay on the canvas. */
export async function togglePin(sessionId: string): Promise<void> {
  const backend = state.activeBackend;
  // Pinning is a new operation: older pending deletes become final.
  await flushPendingDeletes();
  try {
    state.pins = await window.awefork.togglePin(backend, sessionId);
    await ensureCanvasMessages();
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

// ── session tags (执行 / 实验设计 / 咨询 …) ────────────────────────────

/** One session's tags, in the order they were set; empty when untagged. */
export function tagsOf(sessionId: string): string[] {
  return state.tags[sessionId] ?? [];
}

/** Every tag in use, most-used first (ties alphabetical) — the filter shelf. */
export const allTags = computed<string[]>(() => {
  const counts = new Map<string, number>();
  for (const tags of Object.values(state.tags)) {
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
});

/** Deterministic hue for a tag name — same label, same color, every view. */
function tagHue(tag: string): number {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  return hash % 360;
}

/** Solid chip text color for a tag. */
export function tagColor(tag: string): string {
  return `hsl(${tagHue(tag)} 55% 42%)`;
}

/** Matching 12%-alpha chip background for a tag. */
export function tagBg(tag: string): string {
  return `hsl(${tagHue(tag)} 65% 50% / 0.13)`;
}

/** Replace one session's tags; trims, drops empties and duplicates. */
export async function setSessionTags(sessionId: string, tags: string[]): Promise<void> {
  const next = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  try {
    state.tags = await window.awefork.setSessionTags(state.activeBackend, sessionId, next);
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Soft-delete a session: it vanishes from every view at once and stays
 * undoable (the toast's 撤销 button or Ctrl+Z) until the user starts a new
 * operation, which flushes pending deletes for real. The toast text fades on
 * its own short schedule — fading never finalizes the delete. Flushing prunes
 * pins, drops caches; child forks survive and re-root themselves. Refused
 * while the session has a run in flight.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const backend = state.activeBackend;
  if (state.running[sessionId]) {
    state.actionError = "会话正在运行，先停止再删除。";
    return;
  }
  if (state.trash.includes(sessionId)) return;
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  state.actionError = null;
  // Deleting is itself a new operation: older pending deletes become final.
  await flushPendingDeletes();

  // Neighbor comes from the pre-delete sidebar order: whatever row now sits
  // where the deleted one was, so the selection doesn't jump across the list.
  const neighbor = pickNeighborId(flatDirectorySessionIds(), sessionId);
  // Same-story landing (fork parent, else oldest child), computed before the
  // trash push hides the deleted session from the directory pool.
  const landing = landingAfterHide(sessionId);

  state.trash = [...state.trash, sessionId];
  if (state.draft?.sessionId === sessionId) state.draft = null;
  try {
    state.trash = (await window.awefork.trashAdd(backend, sessionId, session.title)).map(
      (entry) => entry.id,
    );
  } catch (error) {
    // Could not persist the pending delete — show the session again rather
    // than risk hiding it with no way to complete or undo the deletion.
    state.trash = state.trash.filter((id) => id !== sessionId);
    state.actionError = error instanceof Error ? error.message : String(error);
    return;
  }

  // Toast + pending entry first: the undo window must be armed even if the
  // neighbor-selection round-trip below fails. The window stays open until
  // the next operation flushes it — even after the toast text has faded.
  showDeleteToast(sessionId, session.title);
  pendingDeletes.push({ sessionId, backend });

  if (state.selectedId === sessionId) {
    state.selectedId = null;
    state.selectedTurnId = null;
    const target = landing ?? neighbor ?? latestSessionId(directorySessions.value);
    if (target) await selectSession(target);
    else await leaveEmptiedDirectory();
  }
}

/**
 * Where to land after the open session disappears from the pool (delete or
 * archive) so the view stays inside the same story: the branch it forked
 * from, else its oldest child (which re-roots in place). Both keep the canvas
 * showing the tree the user was looking at; falls through to null → the
 * caller's sidebar neighbor order.
 */
function landingAfterHide(deletedId: string): string | null {
  const pool = directorySessions.value.filter((s) => s.origin !== "subagent");
  const parent = pool.find((s) => s.id === deletedId)?.parentSessionId ?? null;
  if (parent && pool.some((s) => s.id === parent)) return parent;
  const children = pool
    .filter((s) => s.parentSessionId === deletedId)
    .sort((a, b) => a.createdAt - b.createdAt);
  return children[0]?.id ?? null;
}

/**
 * Tuck a single session into the archive: hidden from every view at once,
 * fully recoverable from the sidebar's archive section. Child forks stay
 * visible and re-root themselves. Pure awefork-side overlay — the session
 * keeps living in the agent backend, so runs in flight are left alone.
 */
export async function archiveSession(sessionId: string): Promise<void> {
  const backend = state.activeBackend;
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session || state.archive.sessions.some((e) => e.id === sessionId)) return;
  state.actionError = null;
  // Archiving is a new operation: older pending deletes become final.
  await flushPendingDeletes();

  // Same landing rule as delete: same-story branch first, else the sidebar
  // neighbor — both computed while the session is still in the pool.
  const neighbor = pickNeighborId(flatDirectorySessionIds(), sessionId);
  const landing = landingAfterHide(sessionId);

  try {
    state.archive = await window.awefork.archiveAdd(backend, "session", sessionId);
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
    return;
  }
  if (state.draft?.sessionId === sessionId) state.draft = null;
  if (state.selectedId === sessionId) {
    state.selectedId = null;
    state.selectedTurnId = null;
    const target = landing ?? neighbor ?? latestSessionId(directorySessions.value);
    if (target) await selectSession(target);
    else await leaveEmptiedDirectory();
  }
}

/**
 * Tuck a whole project directory into the archive: every session under the
 * path hides — including sessions created there later — until the directory
 * is restored. Sessions under it that were archived individually stay
 * archived after a restore (the two lists combine independently).
 */
export async function archiveDirectory(directory: string): Promise<void> {
  const backend = state.activeBackend;
  if (state.archive.directories.some((e) => e.path === directory)) return;
  state.actionError = null;
  await flushPendingDeletes();

  const selectedHere =
    state.selectedDirectory === directory ||
    state.sessions.some((s) => s.id === state.selectedId && s.directory === directory);
  const draftedHere = state.sessions.some(
    (s) => s.id === state.draft?.sessionId && s.directory === directory,
  );

  try {
    state.archive = await window.awefork.archiveAdd(backend, "directory", directory);
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
    return;
  }
  if (draftedHere) state.draft = null;
  if (!selectedHere) return;
  state.selectedId = null;
  state.selectedTurnId = null;
  if (state.selectedDirectory === directory) {
    // The open project went away — move to the busiest remaining directory,
    // or the empty state when it was the last one.
    await leaveEmptiedDirectory();
  } else {
    // Only the selected session lived under the archived path; stay in the
    // current project and land on its latest session.
    const target = latestSessionId(directorySessions.value);
    if (target) await selectSession(target);
  }
}

/** Restore one archived session: back in the sidebar; the data never moved. */
export async function restoreSession(sessionId: string): Promise<void> {
  try {
    state.archive = await window.awefork.archiveRemove(state.activeBackend, "session", sessionId);
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/** Restore an archived directory: everything hidden under the path reappears. */
export async function restoreDirectory(directory: string): Promise<void> {
  try {
    state.archive = await window.awefork.archiveRemove(state.activeBackend, "directory", directory);
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/**
 * True when the card's 🗑 should remove just this one turn: it ends the
 * session (the tip) and earlier rows survive the removal. A mid-story turn
 * anchors the forks hanging off it, so it keeps the whole-session delete; a
 * session whose FIRST row is this turn would be hollowed out by a turn
 * delete, so it too deletes the session. Stubs have no rows to remove.
 * Backends without message-level delete always get whole-session semantics.
 */
export function isTurnDelete(node: TurnNode): boolean {
  if (!state.capabilities.deleteMessage) return false;
  if (node.kind !== "turn" || !isSessionTip(node)) return false;
  const messages = state.messagesBySession[node.sessionId] ?? [];
  const start = messages.findIndex((m) => m.id === node.messageId);
  return start > 0;
}

/**
 * Delete exactly one turn — the tip card's 🗑 when isTurnDelete holds: the
 * opening user row plus every assistant/tool row it produced, through the
 * backend's native message delete. Not undoable; refused while a run is in
 * flight. A partial failure keeps whatever the server actually removed.
 */
export async function deleteTurn(node: TurnNode): Promise<void> {
  const backend = state.activeBackend;
  const sessionId = node.sessionId;
  if (state.running[sessionId]) {
    state.actionError = "会话正在运行，先停止再删除。";
    return;
  }
  const messages = state.messagesBySession[sessionId] ?? [];
  if (!node.messageId) return;
  const range = turnMessageRange(messages, node.messageId);
  if (!range) return;
  const ids = messages.slice(range.start, range.end).map((m) => m.id);
  state.actionError = null;
  try {
    for (const id of ids) {
      await window.awefork.deleteMessage(backend, sessionId, id);
    }
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
  if (state.selectedTurnId === node.id) state.selectedTurnId = null;
  // Show what the server actually has now, whether the delete fully landed
  // or stopped halfway; the session's updatedAt changed either way.
  await loadSessionMessages(sessionId);
  void refreshSessions();
}

/** Current directory's sessions flattened in sidebar display order. */
function flatDirectorySessionIds(): string[] {
  const group = sessionGroups.value.find((g) => g.directory === state.selectedDirectory);
  if (!group) return [];
  const ids: string[] = [];
  const walk = (nodes: SessionTreeNode[]): void => {
    for (const node of nodes) {
      ids.push(node.session.id);
      walk(node.children);
    }
  };
  walk(group.roots);
  return ids;
}

/** Undo a pending delete: drop it from the queue, put the session back. */
export async function undoDelete(sessionId: string): Promise<void> {
  // The trash record lives on the backend the delete was queued on — not
  // necessarily the one on screen now.
  const backend =
    pendingDeletes.find((p) => p.sessionId === sessionId)?.backend ?? state.activeBackend;
  if (state.deletedToast?.sessionId === sessionId) state.deletedToast = null;
  try {
    state.trash = (await window.awefork.trashRemove(backend, sessionId)).map((entry) => entry.id);
  } catch (error) {
    // The record survived, so the delete is still pending — leave it
    // queued and a later Ctrl+Z can retry the undo.
    state.actionError = error instanceof Error ? error.message : String(error);
    return;
  }
  removePendingDelete(sessionId);
  // The session was never server-deleted; walk straight back into it.
  if (state.sessions.some((s) => s.id === sessionId)) {
    await selectSession(sessionId, { focus: true });
  }
}

const TOAST_MS = 6000;
/** Sessions soft-deleted and still undoable, oldest first; Ctrl+Z pops LIFO. */
interface PendingDelete {
  sessionId: string;
  backend: BackendId;
}
const pendingDeletes: PendingDelete[] = [];

/**
 * Most recent soft delete still undoable; null once flushed (or undone).
 * Ctrl+Z walks these LIFO — one press per delete.
 */
export function latestPendingDeleteId(): string | null {
  for (let i = pendingDeletes.length - 1; i >= 0; i -= 1) {
    const entry = pendingDeletes[i];
    if (entry !== undefined && state.trash.includes(entry.sessionId)) return entry.sessionId;
  }
  return null;
}

function removePendingDelete(sessionId: string): void {
  const index = pendingDeletes.findIndex((p) => p.sessionId === sessionId);
  if (index >= 0) pendingDeletes.splice(index, 1);
}

/**
 * Finalize the pending soft deletes: the user just started a new operation,
 * which closes the undo window for the older ones. Best effort per session —
 * a failed server delete involuntarily restores that one (hardDeleteSession),
 * the rest still flush. Each entry carries the backend its trash store lives
 * in, so a flush during a backend switch still routes correctly.
 */
async function flushPendingDeletes(): Promise<void> {
  for (const entry of [...pendingDeletes]) {
    await hardDeleteSession(entry.backend, entry.sessionId);
  }
}

/** The toast is pure UI: fading it must never finalize the delete beneath. */
function showDeleteToast(sessionId: string, title: string): void {
  state.deletedToast = { sessionId, title };
  setTimeout(() => {
    if (state.deletedToast?.sessionId === sessionId) state.deletedToast = null;
  }, TOAST_MS);
}

/**
 * One-line update-channel toast (manual check progress/result). Auto-clears on
 * the same timer as the undo toast; a newer message simply replaces the text.
 */
function showUpdateToast(text: string): void {
  state.updateToast = text;
  setTimeout(() => {
    if (state.updateToast === text) state.updateToast = null;
  }, TOAST_MS);
}

async function hardDeleteSession(backend: BackendId, sessionId: string): Promise<void> {
  // Leaves the pending queue only when the outcome is decided: restored,
  // deleted, or (below) still pending after a double failure.
  if (state.deletedToast?.sessionId === sessionId) state.deletedToast = null;
  try {
    state.pins = await window.awefork.deleteSession(backend, sessionId);
  } catch (error) {
    // The server delete failed. An involuntary undo beats a session stuck
    // invisible — but the pending-delete record must be cleared first, or
    // the next startup flush would destroy the session we just restored.
    const reason = error instanceof Error ? error.message : String(error);
    try {
      state.trash = (await window.awefork.trashRemove(backend, sessionId)).map((entry) => entry.id);
      removePendingDelete(sessionId);
      state.actionError = `删除失败，已把会话放回：${reason}`;
    } catch {
      // Record could not be cleared either: stay hidden and stay queued,
      // so Ctrl+Z can still undo and the next flush can still retry.
      state.actionError = `删除失败：${reason}（记录无法清除，会话暂时保持隐藏，可 Ctrl+Z 撤销）`;
    }
    return;
  }
  removePendingDelete(sessionId);
  stopWatch(backend, sessionId);
  streamBuffers.delete(streamKey(backend, sessionId));
  setStreamTail(backend, sessionId, null);
  setRunning(backend, sessionId, false);
  clearRecent(backend, sessionId);
  // Main prunes the tags sidecar with the delete; mirror it locally so the
  // filter shelf and right-click menu don't offer a dead session's labels.
  if (sessionId in state.tags) {
    const { [sessionId]: goneTags, ...keptTags } = state.tags;
    void goneTags;
    state.tags = keptTags;
  }
  const { [sessionId]: goneMessages, ...keptMessages } = state.messagesBySession;
  void goneMessages;
  state.messagesBySession = keptMessages;
  attemptedMessages.delete(sessionId);
  const { [sessionId]: goneLineage, ...keptLineage } = state.lineage;
  void goneLineage;
  state.lineage = keptLineage;
  state.sessions = state.sessions.filter((s) => s.id !== sessionId);
  try {
    state.trash = (await window.awefork.trashRemove(backend, sessionId)).map((entry) => entry.id);
  } catch {
    // Left in the persisted trash; the next startup flush retries the cleanup.
  }
}

/**
 * Start a brand-new, empty session in the open project and land in it: the
 * sidebar gains a tracked row whose first prompt — typed straight into the
 * freshly focused pane composer — turns it into a conversation. Without an
 * open project the backend picks the directory (its server cwd).
 */
export async function createSession(): Promise<void> {
  const backend = state.activeBackend;
  state.actionError = null;
  // Creating is a new operation: older pending deletes become final.
  await flushPendingDeletes();
  try {
    const created = await window.awefork.createSession(
      backend,
      state.selectedDirectory ?? undefined,
    );
    await refreshSessions();
    await selectSession(created.id, { focus: true });
    state.composerFocusRequest = Date.now();
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Fork the selected session at its latest state — a checkpoint branch holding
 * the full story with nothing prompted yet. Lands you in the clone.
 */
export async function cloneSelectedSession(): Promise<void> {
  const backend = state.activeBackend;
  const sessionId = state.selectedId;
  if (!sessionId || state.running[sessionId]) return;
  state.actionError = null;
  // Cloning is a new operation: older pending deletes become final.
  await flushPendingDeletes();
  try {
    const forked = await window.awefork.fork(backend, sessionId, null);
    await refreshSessions();
    await selectSession(forked.id, { focus: true });
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/** Rename a session through the agent's native API and update local state. */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  const backend = state.activeBackend;
  const trimmed = title.trim();
  if (!trimmed) return;
  // Renaming is a new operation: older pending deletes become final.
  await flushPendingDeletes();
  try {
    await window.awefork.renameSession(backend, sessionId, trimmed);
    state.sessions = state.sessions.map((s) => (s.id === sessionId ? { ...s, title: trimmed } : s));
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Jump out of awefork into the session's native TUI: a system terminal opens
 * with `opencode -s` / `codex resume` in the session's working directory.
 * The terminal lives outside the app, so failure only toasts here.
 */
export async function openSessionTerminal(sessionId: string): Promise<void> {
  state.actionError = null;
  const result = await window.awefork
    .openSessionTerminal(state.activeBackend, sessionId)
    .catch((error: unknown) => ({ ok: false as const, error: String(error) }));
  if (!result.ok) state.actionError = result.error ?? "无法在终端中打开会话";
}

/**
 * True when the node sits at the tip of its session (stubs always do): the ＋
 * composer then continues that session in place instead of forking it.
 */
export function isSessionTip(node: TurnNode): boolean {
  if (node.kind !== "turn") return true;
  const turns = buildTurns(node.sessionId, state.messagesBySession[node.sessionId] ?? []);
  const last = turns[turns.length - 1];
  return last != null && last.messageId === node.messageId;
}

/** Shared seed of a draft composer: openDraft and the retry paths fill it. */
function openDraftAt(draft: DraftState): void {
  void ensureModels();
  state.draft = draft;
}

export function openDraft(node: TurnNode): void {
  openDraftAt({
    nodeId: node.id,
    sessionId: node.sessionId,
    // Session tip: keep talking in place; a mid-story turn grows a fork.
    atMessageId: isSessionTip(node) ? null : node.messageId,
    text: "",
    // Preselect the model that wrote the turn being forked from, when known.
    model: node.kind === "turn" ? node.model : null,
    attachments: [],
  });
}

/**
 * Reopen a failed turn's prompt as a draft (pane entry): the composer opens
 * with the original text and model prefilled, so the user can adjust and
 * resend — a mid-story turn grows the retry as a new fork, a session-tip
 * turn resends in place. The failed turn itself is never touched.
 */
export function retryTurn(turn: Turn): void {
  const messages = state.messagesBySession[turn.sessionId] ?? [];
  const text = messages.find((m) => m.id === turn.messageId)?.text ?? "";
  if (!text.trim()) return;
  const turns = buildTurns(turn.sessionId, messages);
  const last = turns[turns.length - 1];
  const nodeId = `${turn.sessionId}:${turn.messageId}`;
  openDraftAt({
    nodeId,
    sessionId: turn.sessionId,
    atMessageId: last != null && last.messageId === turn.messageId ? null : turn.messageId,
    text,
    model: turn.model,
    attachments: [],
  });
  void restoreDraftAttachments(nodeId, turn.sessionId, turn.messageId);
}

/** Canvas entry for the same move, from a card node. */
export function retryNode(node: TurnNode): void {
  if (node.kind !== "turn" || !node.messageId) return;
  const text =
    (state.messagesBySession[node.sessionId] ?? []).find((m) => m.id === node.messageId)?.text ??
    "";
  if (!text.trim()) return;
  openDraftAt({
    nodeId: node.id,
    sessionId: node.sessionId,
    atMessageId: isSessionTip(node) ? null : node.messageId,
    text,
    model: node.model,
    attachments: [],
  });
  void restoreDraftAttachments(node.id, node.sessionId, node.messageId);
}

/**
 * Retry keeps the original attachments: the backend still holds the sent file
 * parts, so pull them back and drop them into the just-opened draft as chips.
 * The draft opens immediately (the fetch may take a moment); a failed fetch
 * only costs the prefilled chips, the retried text goes out either way.
 * Backends that don't keep file bytes (codex) answer [] — text-only prefill.
 */
async function restoreDraftAttachments(
  nodeId: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  try {
    const attachments = await window.awefork.messageAttachments(
      state.activeBackend,
      sessionId,
      messageId,
    );
    if (attachments.length === 0) return;
    const draft = state.draft;
    if (draft?.nodeId !== nodeId) return;
    draft.attachments = attachments.map(draftFromPrompt);
  } catch {
    // Server hiccups shouldn't block the retry; the composer just starts empty.
  }
}

export function setDraftText(text: string): void {
  if (state.draft) state.draft.text = text;
}

export function setDraftModel(model: ModelChoice | null): void {
  if (state.draft) state.draft.model = model;
}

/** Swap the draft's reasoning-effort variant, keeping its model. */
export function setDraftVariant(variant: string | null): void {
  if (state.draft?.model) state.draft.model = { ...state.draft.model, variant };
}

export function setDraftAttachments(attachments: readonly DraftAttachment[]): void {
  if (state.draft) state.draft.attachments = [...attachments];
}

export function dismissDraft(): void {
  state.draft = null;
}

// ── composer persistence ──────────────────────────────────────────────
// The canvas draft is user input with no server-side home until it is
// sent. Flush it (plus the pane's model picks) to the active backend's
// composer.json on a trailing debounce, and bring it back after each boot
// — a crash mid-compose hands the text back instead of eating it. The
// store is backend-scoped because the draft anchors to a session and
// sessions belong to their backend.

const PERSIST_DEBOUNCE_MS = 600;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let restoringComposer = false;

/** The reactive draft copied into plain objects the IPC layer can clone. */
function plainPersistedDraft(): PersistedDraft | null {
  const draft = state.draft;
  if (!draft) return null;
  return {
    sessionId: draft.sessionId,
    atMessageId: draft.atMessageId,
    text: draft.text,
    model: plainModel(draft.model),
    attachments: draft.attachments.map((a) => ({
      id: a.id,
      name: a.name,
      mime: a.mime,
      dataUrl: a.dataUrl,
    })),
  };
}

/** The current state as a persistable composer value; null = nothing to keep. */
function composerSnapshot(): PersistedComposer | null {
  // Picks for sessions that no longer exist would pile up forever.
  const paneModels: Record<string, ModelChoice> = {};
  for (const [id, model] of Object.entries(state.paneModels)) {
    if (model && state.sessions.some((s) => s.id === id)) paneModels[id] = model;
  }
  const draft = plainPersistedDraft();
  return draft === null && Object.keys(paneModels).length === 0 ? null : { draft, paneModels };
}

function scheduleComposerPersist(): void {
  // Mid-switch the workspace is being reset for the next backend; flushing
  // here would clobber the outgoing backend's draft with empty state.
  // switchBackend flushes it explicitly before parking instead.
  if (restoringComposer || switchingBackend) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const backend = state.activeBackend;
    void window.awefork.saveComposer(backend, composerSnapshot()).catch(() => {
      // A failed sidecar write only costs crash-recovery of unsent input.
    });
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Write the current composer state to one backend's file right now.
 * The switch path calls this for the outgoing backend before the workspace
 * resets, so the debounced flush can't fire afterwards with cleared state.
 */
async function flushComposer(backend: BackendId): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (restoringComposer) return;
  const value = composerSnapshot();
  try {
    await window.awefork.saveComposer(backend, value);
  } catch {
    // Same contract as the debounced flush: losing the write only costs
    // crash-recovery of unsent input.
  }
}

watch(
  () => state.draft,
  () => scheduleComposerPersist(),
  { deep: true },
);
watch(
  () => state.paneModels,
  () => scheduleComposerPersist(),
  { deep: true },
);

/**
 * Bring back the unsent draft and pane model picks of the active backend
 * after a boot. The draft's canvas anchor is recomputed from live data: a
 * vanished fork point degrades it to a tip draft of its session, and a
 * vanished session drops it entirely.
 */
async function restoreComposer(): Promise<void> {
  let persisted: PersistedComposer | null = null;
  try {
    persisted = await window.awefork.composer(state.activeBackend);
  } catch {
    return;
  }
  restoringComposer = true;
  try {
    // Same existence filter as the write path: picks for sessions that
    // vanished while the app was away don't resurrect in memory.
    const paneModels: Record<string, ModelChoice> = {};
    for (const [id, model] of Object.entries(persisted?.paneModels ?? {})) {
      if (state.sessions.some((s) => s.id === id)) paneModels[id] = model;
    }
    state.paneModels = paneModels;
    const draft = persisted?.draft ?? null;
    // An empty draft is nothing to hand back; a fresh openDraft is better.
    if (draft && draft.text.trim() !== "") {
      if (state.sessions.some((s) => s.id === draft.sessionId)) {
        const anchor = await draftAnchor(draft.sessionId, draft.atMessageId);
        if (anchor) {
          state.draft = {
            nodeId: anchor.nodeId,
            sessionId: draft.sessionId,
            atMessageId: anchor.atMessageId,
            text: draft.text,
            model: draft.model,
            attachments: draft.attachments.map((a) => ({ ...a })),
          };
          void ensureModels();
        }
      }
    }
  } finally {
    restoringComposer = false;
  }
  // Normalize the file: stale sessions and dropped drafts get pruned.
  scheduleComposerPersist();
}

/** Where a restored draft should sit on today's canvas. */
async function draftAnchor(
  sessionId: string,
  atMessageId: string | null,
): Promise<{ nodeId: string; atMessageId: string | null } | null> {
  let messages: ChatMessage[] = [];
  try {
    messages = await window.awefork.messages(state.activeBackend, sessionId);
  } catch {
    return null;
  }
  const turns = buildTurns(sessionId, messages);
  if (atMessageId && turns.some((t) => t.messageId === atMessageId)) {
    return { nodeId: `${sessionId}:${atMessageId}`, atMessageId };
  }
  // Tip draft: continue the session wherever it now ends (or its stub).
  const last = turns[turns.length - 1];
  return {
    nodeId: last ? `${sessionId}:${last.messageId}` : `${sessionId}::stub`,
    atMessageId: null,
  };
}

let modelsRequested = false;

async function ensureModels(): Promise<void> {
  if (modelsRequested) return;
  modelsRequested = true;
  try {
    state.models = await window.awefork.models(state.activeBackend);
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
  return model
    ? { providerId: model.providerId, modelId: model.modelId, variant: model.variant ?? null }
    : null;
}

/**
 * Send the draft: a mid-story turn forks the session at that turn and prompts
 * the new branch; a session tip (or a stub) simply continues that session in
 * place. Either way the app lands IN the target session with the pane
 * following its newest turn, while the canvas keeps its current view — the
 * new card materializes in the draft's cell, already in sight.
 */
export async function sendDraft(): Promise<void> {
  const draft = state.draft;
  if (!draft?.text.trim() || state.draftSending) return;
  const backend = state.activeBackend;
  const generation = workspaceGeneration;
  // True once a backend switch reset the workspace under this send.
  const stale = () => generation !== workspaceGeneration;
  const text = draft.text.trim();
  state.actionError = null;
  state.draftSending = true;
  let targetId: string | null = null;
  try {
    // Sending is a new operation: older pending deletes become final.
    await flushPendingDeletes();
    // The draft was already persisted to the outgoing backend's store by the
    // switch, so dropping the send here hands it back on the next visit
    // instead of firing an invisible run and writing over the new backend.
    if (stale()) return;
    const model = plainModel(draft.model);
    const sentAt = Date.now();
    if (draft.atMessageId) {
      const forked = await window.awefork.fork(backend, draft.sessionId, draft.atMessageId);
      if (stale()) return;
      await refreshSessions();
      // No focus request: the canvas stays parked where the user was looking.
      // The composer floated in the branch's next cell, and that's exactly
      // where the new card appears — re-centering would only yank the view.
      await selectSession(forked.id);
      targetId = forked.id;
    } else {
      await selectSession(draft.sessionId);
      targetId = draft.sessionId;
    }
    if (stale()) return;
    // Mark the target running before the request goes out, like sendPrompt
    // does — continuing and forking must share the same waiting UI, and the
    // canvas card and delete guard must not wait on the first SSE busy frame.
    setRunning(backend, targetId, true);
    // Surface the prompt as the target's newest own turn right away; the
    // idle refresh swaps it for the server's row.
    const attachments = toPromptAttachments(draft.attachments);
    appendLocalMessage(targetId, text, model, attachments);
    await window.awefork.prompt(backend, targetId, text, model, attachments);
    watchCompletion(backend, targetId, sentAt);
    if (!stale()) {
      state.draft = null;
      // The sent draft must leave the sidecar now, not on the next debounce
      // — a crash inside that window would resurrect it as unsent.
      void flushComposer(backend);
    } else {
      // The switch landed after the prompt went out: the run is real (it
      // streams through the parked runtime), so the outgoing backend's
      // persisted draft is stale and must not come back.
      void window.awefork.saveComposer(backend, null).catch(() => {});
    }
  } catch (error) {
    // The prompt never reached a run; settle as failed so no success tint
    // lands on a turn that never happened.
    if (targetId) settleRun(backend, targetId, true);
    state.actionError = error instanceof Error ? error.message : String(error);
  } finally {
    state.draftSending = false;
  }
}

/**
 * Show a sent prompt immediately; the next server refresh replaces it with
 * the real message row. `model` seeds the canvas card's model chip so the
 * chosen model shows before the server rows arrive; attachment names render
 * as chips on the user row.
 */
function appendLocalMessage(
  sessionId: string,
  text: string,
  model: ModelChoice | null = null,
  attachments: PromptAttachment[] = [],
): void {
  state.messagesBySession = {
    ...state.messagesBySession,
    [sessionId]: [
      ...(state.messagesBySession[sessionId] ?? []),
      {
        id: `local_${Date.now()}`,
        role: "user",
        text,
        thinking: "",
        toolNames: [],
        modelId: model?.modelId ?? null,
        providerId: model?.providerId ?? null,
        variant: model?.variant ?? null,
        attachmentNames: attachments.map((a) => a.filename),
        createdAt: Date.now(),
        completedAt: null,
        finish: null,
        outputTokens: null,
        error: null,
      },
    ],
  };
}

/**
 * Send from the right-pane composer. Forks live on the canvas only, so this
 * always continues the branch at its end; the pane follows the newest turn
 * so the reply streams into view.
 */
export async function sendPanePrompt(
  text: string,
  attachments: PromptAttachment[] = [],
): Promise<void> {
  if (!state.selectedId || !text.trim()) return;
  // Read before unlocking the pane: the model the composer shows is the one
  // that goes out, even when the pane was locked on an earlier turn.
  const model = paneComposerModel.value;
  state.selectedTurnId = null;
  await sendPrompt(text, model, attachments);
}

export async function sendPrompt(
  text: string,
  model: ModelChoice | null = null,
  attachments: PromptAttachment[] = [],
): Promise<void> {
  const backend = state.activeBackend;
  const sessionId = state.selectedId;
  const generation = workspaceGeneration;
  if (!sessionId || !text.trim()) return;
  state.actionError = null;
  // Sending is a new operation: older pending deletes become final. The
  // session is captured before the flush because the flush awaits IPC —
  // the prompt must reach the session the composer was typing into, even
  // if the user switches selection mid-flush. A backend switch is the one
  // mid-flush change that aborts: the target session left the screen, and
  // firing the run anyway would start something the user cannot see.
  await flushPendingDeletes();
  if (generation !== workspaceGeneration) return;
  setRunning(backend, sessionId, true);
  const sentAt = Date.now();
  appendLocalMessage(sessionId, text, model, attachments);
  try {
    await window.awefork.prompt(backend, sessionId, text, plainModel(model), attachments);
    watchCompletion(backend, sessionId, sentAt);
  } catch (error) {
    setRunning(backend, sessionId, false);
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
  const sessionId = state.selectedId;
  if (!sessionId) return;
  try {
    await window.awefork.abort(state.activeBackend, sessionId);
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  }
}

export function dismissActionError(): void {
  state.actionError = null;
}

/** Surface a failure toast from outside this module (e.g. markdown-view). */
export function reportActionError(message: string): void {
  state.actionError = message;
}

/**
 * Check for a new release. `startup` respects the user's previous skip choice
 * and stays silent no matter the outcome; `manual` narrates the round-trip as
 * toasts. Every failure path is swallowed here so callers can fire-and-forget.
 */
export async function checkForUpdates(source: "startup" | "manual"): Promise<void> {
  state.checkingUpdates = true;
  if (source === "manual") showUpdateToast("Checking for updates…");
  try {
    const result = await window.awefork.checkUpdates(source === "startup");
    state.currentVersion = result.currentVersion;
    if (result.updateAvailable && result.latest) {
      state.updateLatest = result.latest;
      // A fresh check re-opens the banner even if the user closed it before.
      state.updateBannerDismissed = false;
    } else if (source === "manual") {
      showUpdateToast(`awefork is up to date (v${result.currentVersion})`);
    }
  } catch {
    if (source === "manual") showUpdateToast("Couldn't check for updates");
  } finally {
    state.checkingUpdates = false;
  }
}

/** Collapse the update-available banner; a later check may bring it back. */
export function dismissUpdateBanner(): void {
  state.updateBannerDismissed = true;
}

/** Record the pending release as skipped; the banner leaves on server agreement. */
export async function skipUpdateVersion(): Promise<void> {
  const version = state.updateLatest;
  if (!version) return;
  try {
    const result = await window.awefork.skipUpdate(version);
    if (result.ok) state.updateLatest = null;
  } catch {
    // The skip wasn't recorded server-side — keep the banner so it can retry.
  }
}

/** Open the release-notes page for the pending update. */
export async function openReleaseNotes(): Promise<void> {
  const version = state.updateLatest;
  if (!version) return;
  try {
    const result = await window.awefork.openRelease(version);
    if (!result.ok) showUpdateToast("Couldn't open release page");
  } catch {
    showUpdateToast("Couldn't open release page");
  }
}

function latestSessionId(sessions: SessionSummary[]): string | null {
  if (sessions.length === 0) return null;
  return sessions.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)).id;
}

// ── backend switch ──────────────────────────────────────────────────────

/** Fold the visible run maps into the backend's parked slot. */
function parkRuntime(backend: BackendId): void {
  const entry = state.backgroundRuns[backend] ?? { running: {}, streams: {}, recent: {} };
  state.backgroundRuns[backend] = {
    running: { ...entry.running, ...state.running },
    streams: { ...entry.streams, ...state.streams },
    recent: { ...entry.recent, ...state.recent },
  };
  state.running = {};
  state.streams = {};
  state.recent = {};
  state.streamParts = [];
  stopRecentTicker();
}

/** Move the target backend's parked run maps back into the visible state. */
function restoreRuntime(backend: BackendId): void {
  const entry = state.backgroundRuns[backend] ?? { running: {}, streams: {}, recent: {} };
  state.running = { ...entry.running };
  state.streams = { ...entry.streams };
  state.recent = { ...entry.recent };
  // Drop the parked copy: while this backend is active its runtime lives in
  // the visible maps only, and a stale parked copy would otherwise resurrect
  // "running" flags that settled on screen the next time it parks again.
  const { [backend]: _parked, ...restParked } = state.backgroundRuns;
  void _parked;
  state.backgroundRuns = restParked;
  if (Object.keys(state.recent).length > 0) startRecentTicker();
}

/**
 * The workspace of a backend the user switched away from. `messagesBySession`
 * and `attemptedMessages` are NOT part of it: they are keyed by session id,
 * the two backends' id spaces never collide, and the graph only renders the
 * active backend's sessions — so they live as app-lifetime caches instead of
 * being parked and unparked.
 */
interface WorkspaceSnapshot {
  sessions: SessionSummary[];
  lineage: Record<string, ForkRecord>;
  pins: string[];
  tags: Record<string, string[]>;
  trash: string[];
  archive: ArchiveState;
  selectedDirectory: string | null;
  selectedId: string | null;
  selectedTurnId: string | null;
  models: ModelOption[];
  modelsRequested: boolean;
  /** Measured card heights, so the restored canvas keeps its exact layout. */
  cardHeights: Record<string, number>;
}

const workspaceCache = new Map<BackendId, WorkspaceSnapshot>();

/** Snapshot the visible workspace into the outgoing backend's slot. */
function parkWorkspace(backend: BackendId): void {
  workspaceCache.set(backend, {
    sessions: [...state.sessions],
    lineage: { ...state.lineage },
    pins: [...state.pins],
    tags: { ...state.tags },
    trash: [...state.trash],
    archive: {
      sessions: [...state.archive.sessions],
      directories: [...state.archive.directories],
    },
    selectedDirectory: state.selectedDirectory,
    selectedId: state.selectedId,
    selectedTurnId: state.selectedTurnId,
    models: [...state.models],
    modelsRequested,
    cardHeights: { ...cardHeights },
  });
}

/**
 * Put a parked workspace back on screen. `booted` flips true here, so the
 * canvas paints from the snapshot at once — no handshake, no session refetch
 * before first paint. What changed while parked catches up afterwards: runs
 * that finished already wrote their messages through the event stream, and
 * revalidateBackend sweeps the rest.
 */
function restoreWorkspace(snapshot: WorkspaceSnapshot): void {
  workspaceGeneration += 1;
  state.booted = true;
  state.connectionError = null;
  state.sessions = snapshot.sessions;
  state.lineage = snapshot.lineage;
  state.pins = snapshot.pins;
  state.tags = snapshot.tags;
  state.trash = snapshot.trash;
  state.archive = snapshot.archive;
  state.selectedDirectory = snapshot.selectedDirectory;
  state.selectedId = snapshot.selectedId;
  state.selectedTurnId = snapshot.selectedTurnId;
  state.models = snapshot.models;
  modelsRequested = snapshot.modelsRequested;
  state.messagesError = null;
  state.loadingMessages = false;
  state.deletedToast = null;
  state.draft = null;
  state.focusRequest = null;
  state.composerFocusRequest = null;
  state.fitRequest = null;
  state.turnJumpRequest = null;
  searchQuery.value = "";
  for (const key of Object.keys(cardHeights)) delete cardHeights[key];
  Object.assign(cardHeights, snapshot.cardHeights);
  const selected = state.selectedId;
  state.streamParts = selected
    ? [...(streamBuffers.get(streamKey(state.activeBackend, selected)) ?? [])]
    : [];
}

/**
 * Background catch-up after a cached restore: handshake the server and
 * refresh the session list (new TUI sessions, deletes, renames). A dead
 * server only marks connectionError — the cached view stays readable, and
 * the registry re-spawns the backend on the next call anyway.
 */
async function revalidateBackend(backend: BackendId): Promise<void> {
  const ready = await window.awefork.ready(backend);
  if (!ready.ok) {
    state.connectionError = ready.error ?? `Failed to start the ${backend} server.`;
    return;
  }
  await refreshSessions();
  void restoreComposer();
}

/** Bumped on every workspace reset for a backend switch; async flows capture
 * it to notice that the world under them moved to another backend. */
let workspaceGeneration = 0;

/** Clear the visible workspace before booting a backend into it for the
 *  first time this run. Session-keyed caches (`messagesBySession`,
 *  `attemptedMessages`, `paneModels`) survive: the other backend's ids never
 *  render here, and keeping them is what makes a switch back instant. */
function resetWorkspace(): void {
  workspaceGeneration += 1;
  state.booted = false;
  state.connectionError = null;
  state.sessions = [];
  state.lineage = {};
  state.pins = [];
  state.tags = {};
  state.trash = [];
  state.deletedToast = null;
  state.archive = { sessions: [], directories: [] };
  state.selectedDirectory = null;
  state.selectedId = null;
  state.selectedTurnId = null;
  state.messagesError = null;
  state.loadingMessages = false;
  state.models = [];
  modelsRequested = false;
  state.draft = null;
  state.focusRequest = null;
  state.composerFocusRequest = null;
  state.fitRequest = null;
  state.turnJumpRequest = null;
  searchQuery.value = "";
  for (const key of Object.keys(cardHeights)) delete cardHeights[key];
}

let switchingBackend = false;

/**
 * Switch the whole workspace to another agent backend. Pending deletes flush
 * FIRST (each entry's trash store is bound to its backend), then the choice
 * is persisted — a failed probe bounces back with the current view intact.
 * The switch itself never touches runs in flight: the old backend's runtime
 * parks in its slot and keeps streaming there, the target's restores, and a
 * backend visited before repaints from its parked workspace at once (with a
 * background refresh catching up) while a first visit boots from scratch.
 */
export async function switchBackend(backend: BackendId): Promise<void> {
  if (backend === state.activeBackend || switchingBackend) return;
  switchingBackend = true;
  try {
    state.actionError = null;
    await flushPendingDeletes();
    // The unsent draft belongs to the outgoing backend's store; write it
    // before the workspace resets, or the debounced flush would fire with
    // cleared state and eat it.
    await flushComposer(state.activeBackend);
    const result = await window.awefork.selectBackend(backend);
    if (!result.ok) {
      state.actionError = result.error ?? `无法切换到 ${backend}。`;
      return;
    }
    // Flip the active flag BEFORE restoring: events landing in this window
    // route through runSlot, and the target's runtime must already be the
    // visible one or its early frames write into the parked copy and vanish.
    parkWorkspace(state.activeBackend);
    parkRuntime(state.activeBackend);
    state.activeBackend = backend;
    restoreRuntime(backend);
    const parked = workspaceCache.get(backend);
    if (parked) {
      // Pure value of the descriptor-backed flag; the IPC hop would buy
      // nothing on a path whose whole point is painting without waiting.
      state.capabilities = backendCapabilities(backend);
      restoreWorkspace(parked);
      void revalidateBackend(backend);
    } else {
      resetWorkspace();
      try {
        state.capabilities = await window.awefork.capabilities(backend);
      } catch {
        state.capabilities = backendCapabilities(backend);
      }
      await bootBackend(backend);
    }
  } finally {
    switchingBackend = false;
  }
}
