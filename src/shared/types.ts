/**
 * Domain types and the AgentAdapter protocol.
 *
 * Core rule: every agent backend is a tree of sessions. awefork only *reads*
 * session data through each agent's native API and calls its native fork
 * primitive. It never writes to agent storage directly and never invents a
 * session format.
 */

/** How a session relates to its parent. */
export type SessionOrigin =
  /** A session started by a human. */
  | "root"
  /** A session spawned by the agent itself (e.g. a Task-tool subagent). */
  | "subagent"
  /** A session created by forking, tracked in awefork's lineage store. */
  | "fork";

export interface SessionSummary {
  id: string;
  title: string;
  /** Working directory the session belongs to, used for grouping. */
  directory: string;
  /** Parent session id from awefork lineage (forks) or the agent (subagents). */
  parentSessionId: string | null;
  origin: SessionOrigin;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Concatenated text parts of the message. */
  text: string;
  /** Concatenated reasoning parts, kept separate from the final reply text. */
  thinking: string;
  /** Distinct tool names invoked in this message, in first-seen order. */
  toolNames: string[];
  /** Model that produced this message (e.g. "glm/glm-5.3-flash"); user messages carry the model the run was configured with, null when the backend reports none. */
  modelId: string | null;
  /** Provider that served the model (e.g. "oc-awerouter"); null alongside modelId. */
  providerId: string | null;
  /** Reasoning-effort variant the run used (e.g. "high"); null when none was reported. */
  variant: string | null;
  /** Names of files attached to this message, in send order. */
  attachmentNames: string[];
  createdAt: number;
  /** When the backend finished the message; null while unreported or still running. */
  completedAt: number | null;
  /** Output tokens of this assistant message; null on user rows or when unreported. */
  outputTokens: number | null;
  /** Why the run failed (provider/API error reported by the backend); null when it didn't. */
  error: string | null;
}

/** A model the agent backend offers, flattened from its provider config. */
export interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** Reasoning-effort variants the model offers (e.g. low/medium/high), intensity-ordered. */
  variants: readonly string[];
  /** Whether the model accepts file/image attachments. */
  attachment: boolean;
}

/** The model to run a prompt with; null = the backend's configured default. */
export interface ModelChoice {
  providerId: string;
  modelId: string;
  /** Reasoning-effort variant for the run (e.g. "high"); null/absent = the model's default. */
  variant?: string | null;
}

/** An attachment sent with a prompt; `dataUrl` carries the bytes inline. */
export interface PromptAttachment {
  mime: string;
  filename: string;
  dataUrl: string;
}

/** Fork lineage recorded by awefork when it forks a session. */
export interface ForkRecord {
  /** Session that was forked from. */
  parentId: string;
  /** User message id the branch starts after; null = forked at latest turn. */
  atMessageId: string | null;
  createdAt: number;
}

/** Lineage store content. Key = forked session id. */
export type LineageMap = Record<string, ForkRecord>;

/**
 * A session awaiting its hard delete (trash store). Kept here rather than in
 * trash-store.ts so the renderer's type surface stays free of node built-ins.
 */
export interface TrashEntry {
  id: string;
  /** Session title at delete time, for a human scanning the file. */
  title: string;
  deletedAt: number;
}

/** Which archive list an entry belongs to; sessions key on id, directories on path. */
export type ArchiveKind = "session" | "directory";

/** A session individually hidden from the sidebar (archive.json). */
export interface ArchivedSessionEntry {
  id: string;
  archivedAt: number;
}

/**
 * A project directory hidden as a whole: every session under the path —
 * including ones created after archiving — stays hidden until the directory
 * is restored.
 */
export interface ArchivedDirectoryEntry {
  path: string;
  archivedAt: number;
}

/** Archive store content (archive.json). Awefork-side overlay; the agent never sees it. */
export interface ArchiveState {
  sessions: ArchivedSessionEntry[];
  directories: ArchivedDirectoryEntry[];
}

/**
 * Normalized event feed forwarded to the renderer.
 * Kept intentionally small: the UI only needs to know what changed.
 */
export type AgentEvent =
  | { type: "session.updated"; sessionId: string }
  | { type: "message.started"; sessionId: string; messageId: string }
  | {
      type: "message.delta";
      sessionId: string;
      messageId: string;
      /** opencode labels both text and reasoning deltas as `text`; the adapter resolves the part. */
      kind?: "text" | "thinking";
      delta: string;
    }
  | { type: "session.idle"; sessionId: string }
  /**
   * `sessionId` is set when the failure concerns one session (a failed prompt
   * request, a session.error frame) so the renderer can settle that session's
   * run right away; connection-level failures carry none.
   */
  | { type: "server.error"; message: string; sessionId?: string | null };

/**
 * The protocol every agent backend implements.
 *
 * Fork semantics: `fork(sessionId, atMessageId)` branches off AFTER the turn
 * that starts with user message `atMessageId` — the new session contains that
 * full turn. `atMessageId === null` forks at the latest state. Adapters are
 * responsible for translating this to backend-specific cut points.
 */
export interface AgentAdapter {
  readonly kind: string;
  listSessions(): Promise<SessionSummary[]>;
  messages(sessionId: string): Promise<ChatMessage[]>;
  /**
   * One message's file parts as sendable attachments — the data retry
   * prefills the composer with. Backends that don't keep file bytes return
   * an empty list.
   */
  messageAttachments(sessionId: string, messageId: string): Promise<PromptAttachment[]>;
  /** Models the backend offers (from its provider config). */
  listModels(): Promise<ModelOption[]>;
  fork(sessionId: string, atMessageId: string | null): Promise<SessionSummary>;
  /** Permanently remove a session (and awefork's lineage record for it). */
  deleteSession(sessionId: string): Promise<void>;
  /** Remove a single message row through the backend's native API. */
  deleteMessage(sessionId: string, messageId: string): Promise<void>;
  /** Rename a session through the backend's native API. */
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Fire an agent run; progress arrives through `subscribe`. */
  prompt(
    sessionId: string,
    text: string,
    model?: ModelChoice | null,
    attachments?: PromptAttachment[],
  ): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** Subscribe to the normalized event feed. Returns an unsubscribe function. */
  subscribe(handler: (event: AgentEvent) => void): Promise<() => void>;
  dispose(): void;
}
