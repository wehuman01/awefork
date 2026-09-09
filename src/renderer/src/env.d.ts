/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

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
} from "../../shared/types";

declare global {
  interface Window {
    awefork: {
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
      onEvent(handler: (event: AgentEvent) => void): () => void;
    };
  }
}
