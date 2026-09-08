import { type IpcMainInvokeEvent, ipcMain } from "electron";
import { readLineage } from "../shared/lineage-store.js";
import { readPins, writePins } from "../shared/pins-store.js";
import { readTrash, writeTrash } from "../shared/trash-store.js";
import type { AgentAdapter, AgentEvent, ModelChoice, TrashEntry } from "../shared/types";

/**
 * IPC surface (all invoke-channels, prefixed awefork:):
 *   ready      -> { ok, error? }          adapter status after startup
 *   sessions   -> SessionSummary[]        sessions + lineage merged
 *   messages   -> ChatMessage[]           flat message list of a session
 *   models     -> ModelOption[]           models offered by the agent config
 *   fork       -> SessionSummary          fork (turn-preserving)
 *   deleteSession -> string[]             delete a session, pruned pins back
 *   deleteMessage -> void                 remove one message row (native DELETE)
 *   prompt     -> void                    fire an agent run (optional model)
 *   abort      -> void                    abort the running turn
 *   renameSession -> void                rename a session (native PATCH)
 *   pins       -> string[]                pinned session ids
 *   togglePin  -> string[]                pin/unpin a session, new list back
 *   trash      -> TrashEntry[]            sessions awaiting their hard delete
 *   trashAdd   -> TrashEntry[]            queue a pending delete, list back
 *   trashRemove-> TrashEntry[]            un-queue (undo), list back
 * Events are forwarded on channel "awefork:event".
 */
export function registerIpc(
  adapterPromise: Promise<AgentAdapter>,
  lineagePath: string,
  pinsPath: string,
  trashPath: string,
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
    ) => {
      const adapter = await withAdapter();
      await adapter.prompt(sessionId, text, model ?? undefined);
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
