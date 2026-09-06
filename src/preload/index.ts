import { contextBridge, ipcRenderer } from "electron";
import type { ChatMessage, SessionSummary } from "../shared/types.js";

const api = {
  ready: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("awefork:ready"),
  sessions: (): Promise<{
    sessions: SessionSummary[];
    lineage: Record<string, { parentId: string; atMessageId: string | null; createdAt: number }>;
  }> => ipcRenderer.invoke("awefork:sessions"),
  messages: (sessionId: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke("awefork:messages", sessionId),
  fork: (sessionId: string, atMessageId: string | null): Promise<SessionSummary> =>
    ipcRenderer.invoke("awefork:fork", sessionId, atMessageId),
  prompt: (sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke("awefork:prompt", sessionId, text),
  abort: (sessionId: string): Promise<void> => ipcRenderer.invoke("awefork:abort", sessionId),
  onEvent: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on("awefork:event", listener);
    return () => ipcRenderer.removeListener("awefork:event", listener);
  },
};

contextBridge.exposeInMainWorld("awefork", api);
