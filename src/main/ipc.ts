import { type IpcMainInvokeEvent, ipcMain, shell } from "electron";
import { readArchive, setArchived } from "../shared/archive-store.js";
import { readLineage } from "../shared/lineage-store.js";
import { readPins, writePins } from "../shared/pins-store.js";
import { readTrash, writeTrash } from "../shared/trash-store.js";
import type {
  AgentAdapter,
  AgentEvent,
  ArchiveKind,
  ModelChoice,
  PromptAttachment,
  TrashEntry,
} from "../shared/types";
import { convertDocumentToText } from "./document-convert.js";
import { checkForUpdates, openRelease, skipUpdate } from "./update-check.js";

/**
 * IPC surface (all invoke-channels, prefixed awefork:):
 *   ready      -> { ok, error? }          adapter status after startup
 *   sessions   -> SessionSummary[]        sessions + lineage merged
 *   messages   -> ChatMessage[]           flat message list of a session
 *   models     -> ModelOption[]           models offered by the agent config
 *   messageAttachments -> PromptAttachment[]  one message's file parts (retry)
 *   fork       -> SessionSummary          fork (turn-preserving)
 *   deleteSession -> string[]             delete a session, pruned pins back
 *   deleteMessage -> void                 remove one message row (native DELETE)
 *   prompt     -> void                    fire an agent run (optional model + attachments)
 *   abort      -> void                    abort the running turn
 *   renameSession -> void                rename a session (native PATCH)
 *   pins       -> string[]                pinned session ids
 *   togglePin  -> string[]                pin/unpin a session, new list back
 *   trash      -> TrashEntry[]            sessions awaiting their hard delete
 *   trashAdd   -> TrashEntry[]            queue a pending delete, list back
 *   trashRemove-> TrashEntry[]            un-queue (undo), list back
 *   archive    -> ArchiveState            archived sessions + directories
 *   archiveAdd -> ArchiveState            archive a session/directory, state back
 *   archiveRemove -> ArchiveState         restore a session/directory, state back
 *   openExternal -> void                  open a reply link in the system browser
 *   convertDocument -> string             Word/RTF attachment → plain text (textutil)
 *   checkUpdates  -> CheckUpdatesResult   latest release vs installed version
 *   skipUpdate    -> { ok, error? }       persist a version as "don't nag again"
 *   openRelease   -> { ok, error? }       open the release tag page in the browser
 * Events are forwarded on channel "awefork:event".
 */
export function registerIpc(
  adapterPromise: Promise<AgentAdapter>,
  lineagePath: string,
  pinsPath: string,
  trashPath: string,
  archivePath: string,
): void {
  const withAdapter = async (): Promise<AgentAdapter> => adapterPromise;

  ipcMain.handle("awefork:ready", async () => {
    try {
      await adapterPromise;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("awefork:sessions", async () => {
    const adapter = await withAdapter();
    const sessions = await adapter.listSessions();
    const lineage = await readLineage(lineagePath);
    return { sessions, lineage };
  });

  ipcMain.handle("awefork:messages", async (_event: IpcMainInvokeEvent, sessionId: string) => {
    const adapter = await withAdapter();
    return adapter.messages(sessionId);
  });

  ipcMain.handle("awefork:models", async () => {
    const adapter = await withAdapter();
    return adapter.listModels();
  });

  // Retry prefill: the composer asks for a message's original file parts so a
  // retried prompt carries the same attachments.
  ipcMain.handle(
    "awefork:messageAttachments",
    async (_event: IpcMainInvokeEvent, sessionId: string, messageId: string) => {
      const adapter = await withAdapter();
      return adapter.messageAttachments(sessionId, messageId);
    },
  );

  ipcMain.handle(
    "awefork:fork",
    async (_event: IpcMainInvokeEvent, sessionId: string, atMessageId: string | null) => {
      const adapter = await withAdapter();
      return adapter.fork(sessionId, atMessageId);
    },
  );

  // Returns the pins list after pruning the deleted session, so the renderer
  // can update its canvas residents in one round-trip.
  ipcMain.handle("awefork:deleteSession", async (_event: IpcMainInvokeEvent, sessionId: string) => {
    const adapter = await withAdapter();
    await adapter.deleteSession(sessionId);
    const pins = (await readPins(pinsPath)).filter((id) => id !== sessionId);
    await writePins(pinsPath, pins);
    return pins;
  });

  ipcMain.handle(
    "awefork:prompt",
    async (
      _event: IpcMainInvokeEvent,
      sessionId: string,
      text: string,
      model: ModelChoice | null,
      attachments?: PromptAttachment[],
    ) => {
      const adapter = await withAdapter();
      await adapter.prompt(sessionId, text, model ?? undefined, attachments);
    },
  );

  ipcMain.handle("awefork:abort", async (_event: IpcMainInvokeEvent, sessionId: string) => {
    const adapter = await withAdapter();
    await adapter.abort(sessionId);
  });

  ipcMain.handle(
    "awefork:deleteMessage",
    async (_event: IpcMainInvokeEvent, sessionId: string, messageId: string) => {
      const adapter = await withAdapter();
      await adapter.deleteMessage(sessionId, messageId);
    },
  );

  ipcMain.handle(
    "awefork:renameSession",
    async (_event: IpcMainInvokeEvent, sessionId: string, title: string) => {
      const adapter = await withAdapter();
      await adapter.renameSession(sessionId, title);
    },
  );

  ipcMain.handle("awefork:pins", async () => readPins(pinsPath));

  ipcMain.handle("awefork:togglePin", async (_event: IpcMainInvokeEvent, sessionId: string) => {
    const pins = await readPins(pinsPath);
    const next = pins.includes(sessionId)
      ? pins.filter((id) => id !== sessionId)
      : [...pins, sessionId];
    await writePins(pinsPath, next);
    return next;
  });

  ipcMain.handle("awefork:trash", async () => readTrash(trashPath));

  ipcMain.handle(
    "awefork:trashAdd",
    async (_event: IpcMainInvokeEvent, sessionId: string, title: string) => {
      const entries = (await readTrash(trashPath)).filter((entry) => entry.id !== sessionId);
      entries.push({ id: sessionId, title, deletedAt: Date.now() });
      await writeTrash(trashPath, entries);
      return entries;
    },
  );

  ipcMain.handle("awefork:trashRemove", async (_event: IpcMainInvokeEvent, sessionId: string) => {
    const entries = (await readTrash(trashPath)).filter((entry) => entry.id !== sessionId);
    await writeTrash(trashPath, entries);
    return entries;
  });

  ipcMain.handle("awefork:archive", async () => readArchive(archivePath));

  ipcMain.handle(
    "awefork:archiveAdd",
    async (_event: IpcMainInvokeEvent, kind: ArchiveKind, key: string) =>
      setArchived(archivePath, kind, key, true),
  );

  ipcMain.handle(
    "awefork:archiveRemove",
    async (_event: IpcMainInvokeEvent, kind: ArchiveKind, key: string) =>
      setArchived(archivePath, kind, key, false),
  );

  // Word/RTF attachments are converted here because textutil only runs in the
  // main process; the renderer stages the result as a text/plain attachment.
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

export function forwardEvents(
  adapterPromise: Promise<AgentAdapter>,
  send: (event: AgentEvent) => void,
): void {
  adapterPromise
    .then((adapter) => {
      void adapter.subscribe(send);
    })
    .catch(() => {
      // Startup failure is reported through awefork:ready; nothing to stream.
    });
}
