import { contextBridge, ipcRenderer } from "electron";
import type { AweforkApi, CheckUpdatesResult } from "../shared/awefork-api.js";
import type {
  BackendCapabilities,
  BackendEventEnvelope,
  BackendId,
  BackendsResult,
} from "../shared/backend.js";
import type { LineDiffResult } from "../shared/diff.js";
import type {
  AgentInteractionResponse,
  ArchiveKind,
  ArchiveState,
  ChatMessage,
  ModelChoice,
  ModelOption,
  PersistedComposer,
  PromptAttachment,
  SessionFileChanges,
  SessionSummary,
  TrashEntry,
} from "../shared/types.js";

// Mechanical bridge only: every method forwards its args to the matching
// awefork:* channel (backend first where the API takes one) and hands the
// result straight back. onEvent delivers {backend, event} envelopes.
const api: AweforkApi = {
  ready: (backend: BackendId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("awefork:ready", backend),
  sessions: (
    backend: BackendId,
  ): Promise<{
    sessions: SessionSummary[];
    lineage: Record<string, { parentId: string; atMessageId: string | null; createdAt: number }>;
  }> => ipcRenderer.invoke("awefork:sessions", backend),
  messages: (backend: BackendId, sessionId: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke("awefork:messages", backend, sessionId),
  models: (backend: BackendId): Promise<ModelOption[]> =>
    ipcRenderer.invoke("awefork:models", backend),
  messageAttachments: (
    backend: BackendId,
    sessionId: string,
    messageId: string,
  ): Promise<PromptAttachment[]> =>
    ipcRenderer.invoke("awefork:messageAttachments", backend, sessionId, messageId),
  createSession: (backend: BackendId, directory?: string): Promise<SessionSummary> =>
    ipcRenderer.invoke("awefork:createSession", backend, directory),
  fork: (
    backend: BackendId,
    sessionId: string,
    atMessageId: string | null,
  ): Promise<SessionSummary> => ipcRenderer.invoke("awefork:fork", backend, sessionId, atMessageId),
  deleteSession: (backend: BackendId, sessionId: string): Promise<string[]> =>
    ipcRenderer.invoke("awefork:deleteSession", backend, sessionId),
  deleteMessage: (backend: BackendId, sessionId: string, messageId: string): Promise<void> =>
    ipcRenderer.invoke("awefork:deleteMessage", backend, sessionId, messageId),
  prompt: (
    backend: BackendId,
    sessionId: string,
    text: string,
    model: ModelChoice | null,
    attachments?: PromptAttachment[],
  ): Promise<void> =>
    ipcRenderer.invoke("awefork:prompt", backend, sessionId, text, model, attachments),
  abort: (backend: BackendId, sessionId: string): Promise<void> =>
    ipcRenderer.invoke("awefork:abort", backend, sessionId),
  respondInteraction: (
    backend: BackendId,
    requestId: string,
    response: AgentInteractionResponse,
  ): Promise<void> =>
    ipcRenderer.invoke("awefork:respondInteraction", backend, requestId, response),
  renameSession: (backend: BackendId, sessionId: string, title: string): Promise<void> =>
    ipcRenderer.invoke("awefork:renameSession", backend, sessionId, title),
  openSessionTerminal: (
    backend: BackendId,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("awefork:openSessionTerminal", backend, sessionId),
  pins: (backend: BackendId): Promise<string[]> => ipcRenderer.invoke("awefork:pins", backend),
  togglePin: (backend: BackendId, sessionId: string): Promise<string[]> =>
    ipcRenderer.invoke("awefork:togglePin", backend, sessionId),
  trash: (backend: BackendId): Promise<TrashEntry[]> =>
    ipcRenderer.invoke("awefork:trash", backend),
  trashAdd: (backend: BackendId, sessionId: string, title: string): Promise<TrashEntry[]> =>
    ipcRenderer.invoke("awefork:trashAdd", backend, sessionId, title),
  trashRemove: (backend: BackendId, sessionId: string): Promise<TrashEntry[]> =>
    ipcRenderer.invoke("awefork:trashRemove", backend, sessionId),
  archive: (backend: BackendId): Promise<ArchiveState> =>
    ipcRenderer.invoke("awefork:archive", backend),
  archiveAdd: (backend: BackendId, kind: ArchiveKind, key: string): Promise<ArchiveState> =>
    ipcRenderer.invoke("awefork:archiveAdd", backend, kind, key),
  archiveRemove: (backend: BackendId, kind: ArchiveKind, key: string): Promise<ArchiveState> =>
    ipcRenderer.invoke("awefork:archiveRemove", backend, kind, key),
  composer: (backend: BackendId): Promise<PersistedComposer | null> =>
    ipcRenderer.invoke("awefork:composer", backend),
  saveComposer: (backend: BackendId, value: PersistedComposer | null): Promise<void> =>
    ipcRenderer.invoke("awefork:saveComposer", backend, value),
  fileChanges: (backend: BackendId, sessionId: string): Promise<SessionFileChanges | null> =>
    ipcRenderer.invoke("awefork:fileChanges", backend, sessionId),
  fileChangeDiff: (
    backend: BackendId,
    sessionId: string,
    messageId: string,
    path: string,
  ): Promise<LineDiffResult | null> =>
    ipcRenderer.invoke("awefork:fileChangeDiff", backend, sessionId, messageId, path),
  backends: (): Promise<BackendsResult> => ipcRenderer.invoke("awefork:backends"),
  selectBackend: (backend: BackendId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("awefork:selectBackend", backend),
  capabilities: (backend: BackendId): Promise<BackendCapabilities> =>
    ipcRenderer.invoke("awefork:capabilities", backend),
  openPath: (target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("awefork:openPath", target),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("awefork:openExternal", url),
  convertDocument: (filename: string, bytes: Uint8Array): Promise<string> =>
    ipcRenderer.invoke("awefork:convertDocument", filename, bytes),
  checkUpdates: (respectSkip: boolean): Promise<CheckUpdatesResult> =>
    ipcRenderer.invoke("awefork:check-updates", respectSkip),
  skipUpdate: (version: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("awefork:skip-update", version),
  openRelease: (version: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("awefork:open-release", version),
  onEvent: (handler: (envelope: BackendEventEnvelope) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) =>
      handler(payload as BackendEventEnvelope);
    ipcRenderer.on("awefork:event", listener);
    return () => ipcRenderer.removeListener("awefork:event", listener);
  },
};

contextBridge.exposeInMainWorld("awefork", api);
