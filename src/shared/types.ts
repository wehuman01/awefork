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
  /** Distinct tool names invoked in this message, in first-seen order. */
  toolNames: string[];
  /** Model that produced this message (e.g. "glm/glm-5.3-flash"); null for user messages or when the backend reports none. */
  modelId: string | null;
  createdAt: number;
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
 * Normalized event feed forwarded to the renderer.
 * Kept intentionally small: the UI only needs to know what changed.
 */
export type AgentEvent =
  | { type: "session.updated"; sessionId: string }
  | { type: "message.started"; sessionId: string; messageId: string }
  | { type: "message.delta"; sessionId: string; messageId: string; delta: string }
  | { type: "session.idle"; sessionId: string }
  | { type: "server.error"; message: string };

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
  fork(sessionId: string, atMessageId: string | null): Promise<SessionSummary>;
  /** Fire an agent run; progress arrives through `subscribe`. */
  prompt(sessionId: string, text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** Subscribe to the normalized event feed. Returns an unsubscribe function. */
  subscribe(handler: (event: AgentEvent) => void): Promise<() => void>;
  dispose(): void;
}
