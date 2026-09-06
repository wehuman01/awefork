import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { createOpencodeAdapter } from "../shared/opencode-adapter.js";
import type { AgentEvent } from "../shared/types.js";
import { forwardEvents, registerIpc } from "./ipc.js";
import { ensureOpencodeServer, stopManagedServer } from "./opencode-server.js";

const PORT = 4096;

const lineagePath = join(app.getPath("userData"), "lineage.json");
const pinsPath = join(app.getPath("userData"), "pins.json");

const adapterPromise = ensureOpencodeServer(PORT)
  .then(({ baseUrl }) => createOpencodeAdapter({ baseUrl, lineagePath }))
  .catch((error: unknown) => {
    // Rejecting the shared promise surfaces the failure via awefork:ready.
    throw error instanceof Error ? error : new Error(String(error));
  });

registerIpc(adapterPromise, lineagePath, pinsPath);

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    title: "awefork",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  forwardEvents(adapterPromise, (event: AgentEvent) => {
    mainWindow?.webContents.send("awefork:event", event);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopManagedServer();
});
