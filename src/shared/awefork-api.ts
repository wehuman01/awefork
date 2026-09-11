import type {
  BackendCapabilities,
  BackendEventEnvelope,
  BackendId,
  BackendsResult,
} from "./backend.js";
import type {
  AgentInteractionResponse,
  ArchiveKind,
  ArchiveState,
  ChatMessage,
  ForkRecord,
  ModelChoice,
  ModelOption,
  PersistedComposer,
  PromptAttachment,
  SessionSummary,
  TrashEntry,
} from "./types.js";

/** What awefork:check-updates resolves to. */
export interface CheckUpdatesResult {
  currentVersion: string;
  latest: string | null;
  updateAvailable: boolean;
}

/**
 * The full window.awefork surface exposed by the preload bridge. Declared once
 * so the preload implementation and the renderer's Window typing can't drift:
 * `src/renderer/src/env.d.ts` types `awefork` as this interface, and the
 * preload types its api object against it.
 *
 * Backend routing: every method that touches an agent adapter or an awefork
 * overlay store takes the backend as its FIRST argument — the renderer always
 * passes its active backend, main routes by that argument, and a switch can
 * never misroute an in-flight invoke. `onEvent` delivers envelopes tagged with
 * the emitting backend.
 */
export interface AweforkApi {
  ready(backend: BackendId): Promise<{ ok: boolean; error?: string }>;
  sessions(
    backend: BackendId,
  ): Promise<{ sessions: SessionSummary[]; lineage: Record<string, ForkRecord> }>;
  messages(backend: BackendId, sessionId: string): Promise<ChatMessage[]>;
  models(backend: BackendId): Promise<ModelOption[]>;
  messageAttachments(
    backend: BackendId,
    sessionId: string,
    messageId: string,
  ): Promise<PromptAttachment[]>;
  createSession(backend: BackendId, directory?: string): Promise<SessionSummary>;
  fork(backend: BackendId, sessionId: string, atMessageId: string | null): Promise<SessionSummary>;
  deleteSession(backend: BackendId, sessionId: string): Promise<string[]>;
  deleteMessage(backend: BackendId, sessionId: string, messageId: string): Promise<void>;
  prompt(
    backend: BackendId,
    sessionId: string,
    text: string,
    model: ModelChoice | null,
    attachments?: PromptAttachment[],
  ): Promise<void>;
  abort(backend: BackendId, sessionId: string): Promise<void>;
  /**
   * Reply to a pending interaction (approval/tool-user-input) the backend is
   * waiting on. `requestId` is the backend's id for the pending request;
   * `response` is the approved/denied decision. Backend-first like every
   * adapter method, so a backend switch can't misroute a reply.
   */
  respondInteraction(
    backend: BackendId,
    requestId: string,
    response: AgentInteractionResponse,
  ): Promise<void>;
  renameSession(backend: BackendId, sessionId: string, title: string): Promise<void>;
  pins(backend: BackendId): Promise<string[]>;
  togglePin(backend: BackendId, sessionId: string): Promise<string[]>;
  trash(backend: BackendId): Promise<TrashEntry[]>;
  trashAdd(backend: BackendId, sessionId: string, title: string): Promise<TrashEntry[]>;
  trashRemove(backend: BackendId, sessionId: string): Promise<TrashEntry[]>;
  archive(backend: BackendId): Promise<ArchiveState>;
  archiveAdd(backend: BackendId, kind: ArchiveKind, key: string): Promise<ArchiveState>;
  archiveRemove(backend: BackendId, kind: ArchiveKind, key: string): Promise<ArchiveState>;
  /** The backend's unsent draft + pane model picks (composer.json sidecar). */
  composer(backend: BackendId): Promise<PersistedComposer | null>;
  saveComposer(backend: BackendId, value: PersistedComposer | null): Promise<void>;
  /** Switcher data: installed probe (--version spawn, no server) + persisted selection. */
  backends(): Promise<BackendsResult>;
  /** Persist a selection; {ok:false,error} when the probe fails so the UI bounces back. */
  selectBackend(backend: BackendId): Promise<{ ok: boolean; error?: string }>;
  /** Feature surface of a backend; hides affordances the backend lacks. */
  capabilities(backend: BackendId): Promise<BackendCapabilities>;
  /** Open a local drive path (reply references) with the OS handler. */
  openPath(target: string): Promise<{ ok: boolean; error?: string }>;
  openExternal(url: string): Promise<void>;
  convertDocument(filename: string, bytes: Uint8Array): Promise<string>;
  checkUpdates(respectSkip: boolean): Promise<CheckUpdatesResult>;
  skipUpdate(version: string): Promise<{ ok: boolean; error?: string }>;
  openRelease(version: string): Promise<{ ok: boolean; error?: string }>;
  onEvent(handler: (envelope: BackendEventEnvelope) => void): () => void;
}
