import { type IpcMainInvokeEvent, ipcMain } from "electron";
import { readLineage } from "../shared/lineage-store.js";
import { readPins, writePins } from "../shared/pins-store.js";
import type { AgentAdapter, AgentEvent } from "../shared/types";

/**
 * IPC surface (all invoke-channels, prefixed awefork:):
 *   ready      -> { ok, error? }          adapter status after startup
 *   sessions   -> SessionSummary[]        sessions + lineage merged
 *   messages   -> ChatMessage[]           flat message list of a session
 *   fork       -> SessionSummary          fork (turn-preserving)
 *   prompt     -> void                    fire an agent run
 *   abort      -> void                    abort the running turn
 *   pins       -> string[]                pinned session ids
 *   togglePin  -> string[]                pin/unpin a session, new list back
 * Events are forwarded on channel "awefork:event".
 */
export function registerIpc(
  adapterPromise: Promise<AgentAdapter>,
  lineagePath: string,
  pinsPath: string,
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

  ipcMain.handle(
    "awefork:fork",
    async (_event: IpcMainInvokeEvent, sessionId: string, atMessageId: string | null) => {
      const adapter = await withAdapter();
      return adapter.fork(sessionId, atMessageId);
    },
  );

  ipcMain.handle(
    "awefork:prompt",
    async (_event: IpcMainInvokeEvent, sessionId: string, text: string) => {
      const adapter = await withAdapter();
      await adapter.prompt(sessionId, text);
    },
  );

  ipcMain.handle("awefork:abort", async (_event: IpcMainInvokeEvent, sessionId: string) => {
    const adapter = await withAdapter();
    await adapter.abort(sessionId);
  });

  ipcMain.handle("awefork:pins", async () => readPins(pinsPath));

  ipcMain.handle("awefork:togglePin", async (_event: IpcMainInvokeEvent, sessionId: string) => {
    const pins = await readPins(pinsPath);
    const next = pins.includes(sessionId)
      ? pins.filter((id) => id !== sessionId)
      : [...pins, sessionId];
    await writePins(pinsPath, next);
    return next;
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
