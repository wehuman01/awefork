import { type IpcMainInvokeEvent, ipcMain, shell } from "electron";
import { readArchive, setArchived } from "../shared/archive-store.js";
import { type BackendId, isBackendId } from "../shared/backend.js";
import { readLineage } from "../shared/lineage-store.js";
import { prunePin, readPins, togglePin } from "../shared/pins-store.js";
import { addTrashEntry, readTrash, removeTrashEntry } from "../shared/trash-store.js";
import type {
  AgentInteractionResponse,
  ArchiveKind,
  ModelChoice,
  PromptAttachment,
} from "../shared/types.js";
import type { BackendRegistry } from "./backend-registry.js";
import { convertDocumentToText } from "./document-convert.js";
import { checkForUpdates, openRelease, skipUpdate } from "./update-check.js";

/**
 * IPC surface (all invoke-channels, prefixed awefork:). Every method that
 * touches an agent adapter or an awefork overlay store takes the backend as
 * its FIRST argument — the renderer always passes its active backend, main
 * routes by that argument, and a backend switch can never misroute an
 * in-flight invoke. Adapter-backed channels:
 *   ready(backend)          -> { ok, error? }       adapter status after startup
 *   sessions(backend)       -> {sessions, lineage}  sessions + lineage merged
 *   messages(backend, id)   -> ChatMessage[]        flat message list of a session
 *   models(backend)         -> ModelOption[]        models offered by the agent config
 *   messageAttachments(backend, session, message) -> PromptAttachment[] (retry prefill)
 *   createSession(backend, directory?) -> SessionSummary
 *   fork(backend, id, atMessageId | null) -> SessionSummary (turn-preserving)
 *   deleteSession(backend, id) -> string[]          delete, pruned pins back
 *   deleteMessage(backend, session, message) -> void (native DELETE)
 *   prompt(backend, id, text, model, attachments?) -> void
 *   abort(backend, id)      -> void                 abort the running turn
 *   respondInteraction(backend, requestId, response) -> void  reply to a pending
 *                                                approval/interaction request
 *   renameSession(backend, id, title) -> void
 * Overlay-store channels (per-backend files, no adapter spawn):
 *   pins / togglePin / trash / trashAdd / trashRemove / archive / archiveAdd /
 *   archiveRemove — same shapes as before, backend-routed.
 * Backend switcher:
 *   backends      -> { selected, backends: BackendInfo[] } (probe, no spawn)
 *   selectBackend -> { ok, error? }                persists; probe failure bounces back
 *   capabilities  -> { deleteMessage, attachments }
 * App-level (backend-free): openExternal, convertDocument, checkUpdates,
 * skipUpdate, openRelease.
 * Events are forwarded on channel "awefork:event" as {backend, event}.
 */
export function registerIpc(registry: BackendRegistry): void {
  const withAdapter = async (backend: BackendId) => registry.get(backend);
  // Store channels take the backend from the invoke; unknown ids route to the
  // default rather than throwing so a stale renderer can't wedge the store.
  const storeBackend = (value: unknown): BackendId => (isBackendId(value) ? value : "opencode");

  ipcMain.handle("awefork:ready", async (_event: IpcMainInvokeEvent, backend: BackendId) => {
    try {
      await withAdapter(storeBackend(backend));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("awefork:sessions", async (_event: IpcMainInvokeEvent, backend: BackendId) => {
    const id = storeBackend(backend);
    const adapter = await withAdapter(id);
    const sessions = await adapter.listSessions();
    const lineage = await readLineage(registry.storePaths(id).lineage);
    return { sessions, lineage };
  });

  ipcMain.handle(
    "awefork:messages",
    async (_event: IpcMainInvokeEvent, backend: BackendId, sessionId: string) => {
      const adapter = await withAdapter(storeBackend(backend));
      return adapter.messages(sessionId);
    },
  );

  ipcMain.handle("awefork:models", async (_event: IpcMainInvokeEvent, backend: BackendId) => {
    const adapter = await withAdapter(storeBackend(backend));
    return adapter.listModels();
  });

  // Retry prefill: the composer asks for a message's original file parts so a
  // retried prompt carries the same attachments.
  ipcMain.handle(
    "awefork:messageAttachments",
    async (
      _event: IpcMainInvokeEvent,
      backend: BackendId,
      sessionId: string,
      messageId: string,
    ) => {
      const adapter = await withAdapter(storeBackend(backend));
      return adapter.messageAttachments(sessionId, messageId);
    },
  );

  ipcMain.handle(
    "awefork:createSession",
    async (_event: IpcMainInvokeEvent, backend: BackendId, directory?: string) => {
      const adapter = await withAdapter(storeBackend(backend));
      return adapter.createSession(directory);
    },
  );

  ipcMain.handle(
    "awefork:fork",
    async (
      _event: IpcMainInvokeEvent,
      backend: BackendId,
      sessionId: string,
      atMessageId: string | null,
    ) => {
      const adapter = await withAdapter(storeBackend(backend));
      return adapter.fork(sessionId, atMessageId);
    },
  );

  // Returns the pins list after pruning the deleted session, so the renderer
  // can update its canvas residents in one round-trip.
  ipcMain.handle(
    "awefork:deleteSession",
    async (_event: IpcMainInvokeEvent, backend: BackendId, sessionId: string) => {
      const id = storeBackend(backend);
      const adapter = await withAdapter(id);
      await adapter.deleteSession(sessionId);
      return prunePin(registry.storePaths(id).pins, sessionId);
    },
  );

  ipcMain.handle(
    "awefork:prompt",
    async (
      _event: IpcMainInvokeEvent,
      backend: BackendId,
      sessionId: string,
      text: string,
      model: ModelChoice | null,
      attachments?: PromptAttachment[],
    ) => {
      const adapter = await withAdapter(storeBackend(backend));
      await adapter.prompt(sessionId, text, model ?? undefined, attachments);
    },
  );

  ipcMain.handle(
    "awefork:abort",
    async (_event: IpcMainInvokeEvent, backend: BackendId, sessionId: string) => {
      const adapter = await withAdapter(storeBackend(backend));
      await adapter.abort(sessionId);
    },
  );

  // Reply to a pending backend interaction (approval/tool-user-input). The
  // adapter resolves its pending request by `requestId`, so the renderer
  // only ever sees the id the backend handed out. Replying to an unknown or
  // already-settled request is a silent no-op — the JSON-RPC layer safe-
  // replied it at its deadline, so a stale dialog click cannot double-answer.
  ipcMain.handle(
    "awefork:respondInteraction",
    async (
      _event: IpcMainInvokeEvent,
      backend: BackendId,
      requestId: string,
      response: AgentInteractionResponse,
    ) => {
      const adapter = await withAdapter(storeBackend(backend));
      await adapter.respondInteraction(requestId, response);
    },
  );

  ipcMain.handle(
    "awefork:deleteMessage",
    async (
      _event: IpcMainInvokeEvent,
      backend: BackendId,
      sessionId: string,
      messageId: string,
    ) => {
      const adapter = await withAdapter(storeBackend(backend));
      await adapter.deleteMessage(sessionId, messageId);
    },
  );

  ipcMain.handle(
    "awefork:renameSession",
    async (_event: IpcMainInvokeEvent, backend: BackendId, sessionId: string, title: string) => {
      const adapter = await withAdapter(storeBackend(backend));
      await adapter.renameSession(sessionId, title);
    },
  );

  // ── per-backend overlay stores ─────────────────────────────────────────

  ipcMain.handle("awefork:pins", async (_event: IpcMainInvokeEvent, backend: BackendId) =>
    readPins(registry.storePaths(storeBackend(backend)).pins),
  );

  ipcMain.handle(
    "awefork:togglePin",
    (_event: IpcMainInvokeEvent, backend: BackendId, sessionId: string) =>
      togglePin(registry.storePaths(storeBackend(backend)).pins, sessionId),
  );

  ipcMain.handle("awefork:trash", async (_event: IpcMainInvokeEvent, backend: BackendId) =>
    readTrash(registry.storePaths(storeBackend(backend)).trash),
  );

  ipcMain.handle(
    "awefork:trashAdd",
    (_event: IpcMainInvokeEvent, backend: BackendId, sessionId: string, title: string) =>
      addTrashEntry(registry.storePaths(storeBackend(backend)).trash, sessionId, title),
  );

  ipcMain.handle(
    "awefork:trashRemove",
    (_event: IpcMainInvokeEvent, backend: BackendId, sessionId: string) =>
      removeTrashEntry(registry.storePaths(storeBackend(backend)).trash, sessionId),
  );

  ipcMain.handle("awefork:archive", async (_event: IpcMainInvokeEvent, backend: BackendId) =>
    readArchive(registry.storePaths(storeBackend(backend)).archive),
  );

  ipcMain.handle(
    "awefork:archiveAdd",
    async (_event: IpcMainInvokeEvent, backend: BackendId, kind: ArchiveKind, key: string) =>
      setArchived(registry.storePaths(storeBackend(backend)).archive, kind, key, true),
  );

  ipcMain.handle(
    "awefork:archiveRemove",
    async (_event: IpcMainInvokeEvent, backend: BackendId, kind: ArchiveKind, key: string) =>
      setArchived(registry.storePaths(storeBackend(backend)).archive, kind, key, false),
  );

  // ── backend switcher ────────────────────────────────────────────────────

  ipcMain.handle("awefork:backends", () => registry.listBackends());

  ipcMain.handle(
    "awefork:selectBackend",
    async (_event: IpcMainInvokeEvent, backend: BackendId) => {
      if (!isBackendId(backend)) return { ok: false, error: `未知后端：${String(backend)}` };
      return registry.select(backend);
    },
  );

  ipcMain.handle("awefork:capabilities", (_event: IpcMainInvokeEvent, backend: BackendId) =>
    registry.capabilities(storeBackend(backend)),
  );

  // ── app-level ────────────────────────────────────────────────────────────

  // Word/RTF attachments are converted here in the main process; the renderer
  // stages the result as a text/plain attachment.
  ipcMain.handle(
    "awefork:convertDocument",
    (_event: IpcMainInvokeEvent, filename: string, bytes: Uint8Array) =>
      convertDocumentToText(filename, bytes),
  );

  // Markdown links in replies route through here — shell.openExternal is the
  // only sanctioned way out of the app window, and the scheme gate keeps
  // file:/javascript:-style hrefs from ever reaching it.
  ipcMain.handle("awefork:openExternal", (_event: IpcMainInvokeEvent, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:" &&
      parsed.protocol !== "mailto:"
    ) {
      return;
    }
    void shell.openExternal(parsed.href);
  });

  // Release checks are main-process-side: the renderer never talks to the
  // GitHub API and only receives a raw version number back.
  ipcMain.handle("awefork:check-updates", (_event: IpcMainInvokeEvent, respectSkip: boolean) =>
    checkForUpdates(Boolean(respectSkip)),
  );

  ipcMain.handle("awefork:skip-update", (_event: IpcMainInvokeEvent, version: string) =>
    skipUpdate(version),
  );

  // The URL is assembled here, not by the renderer — an arbitrary link never
  // reaches shell.openExternal this way.
  ipcMain.handle("awefork:open-release", (_event: IpcMainInvokeEvent, version: string) =>
    openRelease(version),
  );
}
