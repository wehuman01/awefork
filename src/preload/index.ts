import { contextBridge, ipcRenderer } from "electron";
import type {
  ArchiveKind,
  ArchiveState,
  ChatMessage,
  ModelChoice,
  ModelOption,
  PromptAttachment,
  SessionSummary,
  TrashEntry,
} from "../shared/types.js";

const api = {
  ready: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("awefork:ready"),
  sessions: (): Promise<{
    sessions: SessionSummary[];
    lineage: Record<string, { parentId: string; atMessageId: string | null; createdAt: number }>;
  }> => ipcRenderer.invoke("awefork:sessions"),
  messages: (sessionId: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke("awefork:messages", sessionId),
  models: (): Promise<ModelOption[]> => ipcRenderer.invoke("awefork:models"),
  fork: (sessionId: string, atMessageId: string | null): Promise<SessionSummary> =>
    ipcRenderer.invoke("awefork:fork", sessionId, atMessageId),
  deleteSession: (sessionId: string): Promise<string[]> =>
    ipcRenderer.invoke("awefork:deleteSession", sessionId),
  deleteMessage: (sessionId: string, messageId: string): Promise<void> =>
    ipcRenderer.invoke("awefork:deleteMessage", sessionId, messageId),
  prompt: (
    sessionId: string,
    text: string,
    model: ModelChoice | null,
    attachments?: PromptAttachment[],
  ): Promise<void> => ipcRenderer.invoke("awefork:prompt", sessionId, text, model, attachments),
  abort: (sessionId: string): Promise<void> => ipcRenderer.invoke("awefork:abort", sessionId),
  renameSession: (sessionId: string, title: string): Promise<void> =>
    ipcRenderer.invoke("awefork:renameSession", sessionId, title),
  pins: (): Promise<string[]> => ipcRenderer.invoke("awefork:pins"),
  togglePin: (sessionId: string): Promise<string[]> =>
    ipcRenderer.invoke("awefork:togglePin", sessionId),
  trash: (): Promise<TrashEntry[]> => ipcRenderer.invoke("awefork:trash"),
  trashAdd: (sessionId: string, title: string): Promise<TrashEntry[]> =>
    ipcRenderer.invoke("awefork:trashAdd", sessionId, title),
  trashRemove: (sessionId: string): Promise<TrashEntry[]> =>
    ipcRenderer.invoke("awefork:trashRemove", sessionId),
  archive: (): Promise<ArchiveState> => ipcRenderer.invoke("awefork:archive"),
  archiveAdd: (kind: ArchiveKind, key: string): Promise<ArchiveState> =>
    ipcRenderer.invoke("awefork:archiveAdd", kind, key),
  archiveRemove: (kind: ArchiveKind, key: string): Promise<ArchiveState> =>
    ipcRenderer.invoke("awefork:archiveRemove", kind, key),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("awefork:openExternal", url),
  convertDocument: (filename: string, bytes: Uint8Array): Promise<string> =>
    ipcRenderer.invoke("awefork:convertDocument", filename, bytes),
  onEvent: (handler: (event: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on("awefork:event", listener);
    return () => ipcRenderer.removeListener("awefork:event", listener);
  },
};

contextBridge.exposeInMainWorld("awefork", api);
