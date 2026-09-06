/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

import type {
  AgentEvent,
  ChatMessage,
  ForkRecord,
  ModelChoice,
  ModelOption,
  SessionSummary,
} from "../../shared/types";

declare global {
  interface Window {
    awefork: {
      ready(): Promise<{ ok: boolean; error?: string }>;
      sessions(): Promise<{ sessions: SessionSummary[]; lineage: Record<string, ForkRecord> }>;
      messages(sessionId: string): Promise<ChatMessage[]>;
      models(): Promise<ModelOption[]>;
      fork(sessionId: string, atMessageId: string | null): Promise<SessionSummary>;
      prompt(sessionId: string, text: string, model: ModelChoice | null): Promise<void>;
      abort(sessionId: string): Promise<void>;
      pins(): Promise<string[]>;
      togglePin(sessionId: string): Promise<string[]>;
      onEvent(handler: (event: AgentEvent) => void): () => void;
    };
  }
}
