import type {
  AgentEvent,
  ArchiveKind,
  ArchiveState,
  ChatMessage,
  ForkRecord,
  ModelChoice,
  ModelOption,
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
 */
export interface AweforkApi {
  ready(): Promise<{ ok: boolean; error?: string }>;
  sessions(): Promise<{ sessions: SessionSummary[]; lineage: Record<string, ForkRecord> }>;
  messages(sessionId: string): Promise<ChatMessage[]>;
  models(): Promise<ModelOption[]>;
  messageAttachments(sessionId: string, messageId: string): Promise<PromptAttachment[]>;
  fork(sessionId: string, atMessageId: string | null): Promise<SessionSummary>;
  deleteSession(sessionId: string): Promise<string[]>;
  deleteMessage(sessionId: string, messageId: string): Promise<void>;
  prompt(
    sessionId: string,
    text: string,
    model: ModelChoice | null,
    attachments?: PromptAttachment[],
  ): Promise<void>;
  abort(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  pins(): Promise<string[]>;
  togglePin(sessionId: string): Promise<string[]>;
  trash(): Promise<TrashEntry[]>;
  trashAdd(sessionId: string, title: string): Promise<TrashEntry[]>;
  trashRemove(sessionId: string): Promise<TrashEntry[]>;
  archive(): Promise<ArchiveState>;
  archiveAdd(kind: ArchiveKind, key: string): Promise<ArchiveState>;
  archiveRemove(kind: ArchiveKind, key: string): Promise<ArchiveState>;
  openExternal(url: string): Promise<void>;
  convertDocument(filename: string, bytes: Uint8Array): Promise<string>;
  checkUpdates(respectSkip: boolean): Promise<CheckUpdatesResult>;
  skipUpdate(version: string): Promise<{ ok: boolean; error?: string }>;
  openRelease(version: string): Promise<{ ok: boolean; error?: string }>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
}
