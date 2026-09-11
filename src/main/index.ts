import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage } from "electron";
import { createBackendRegistry } from "./backend-registry.js";
import { registerIpc } from "./ipc.js";
import { readBackendSelection } from "./settings-store.js";

const registry = createBackendRegistry(app.getPath("userData"));
registerIpc(registry);

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
      // Load-bearing, not an oversight: the preload is built as ESM
      // (package.json has "type": "module"), and Electron only loads ESM
      // preload scripts with the sandbox disabled. The renderer still gets
      // no Node access — contextIsolation on, nodeIntegration off, and the
      // preload does nothing but bridge ipcRenderer.invoke channels.
      sandbox: false,
    },
  });
  // macOS keeps the app alive after the window closes; a stale reference
  // would throw "Object has been destroyed" on the next forwarded event.
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// Subscribed exactly once, outside createWindow: a macOS Dock re-open runs
// createWindow again, and a second subscribe would leave the first reconnect
// loop alive — every event would then arrive twice and double the streams.
// Every spawned backend's events arrive here as {backend, event} envelopes.
registry.forward((envelope) => {
  mainWindow?.webContents.send("awefork:event", envelope);
});

app.whenReady().then(() => {
  // Packaged builds take the Dock icon from the bundle; dev would show the
  // stock Electron one otherwise. Electron can't decode .icns, so hand it the
  // PNG master — a missing or bad icon must never block startup.
  if (!app.isPackaged && process.platform === "darwin" && app.dock) {
    try {
      const iconPath = join(app.getAppPath(), "assets/icon/icon.png");
      const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
      if (image && !image.isEmpty()) app.dock.setIcon(image);
    } catch {
      // cosmetic in dev; ignore
    }
  }
  // Spawn only the persisted selection at launch; the other backend stays
  // cold until the user first switches to it (registry.get spawns lazily).
  void readBackendSelection(join(app.getPath("userData"), "settings.json"))
    .then((backend) => registry.get(backend))
    .catch(() => {
      // Startup failures surface through awefork:ready; nothing to do here.
    });
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  registry.dispose();
});
