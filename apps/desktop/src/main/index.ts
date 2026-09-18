import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { LocalOpenAIProvider } from "@kripl/local-openai-provider";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

const IPC = {
  appInfo: "kripl:app-info",
  pickWorkspace: "kripl:pick-workspace",
  probeLocalModels: "kripl:probe-local-models"
} as const;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#0d1014",
    title: "Kripl Studio",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDir, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(currentDir, "../renderer/index.html"));
  }

  return window;
}

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    offlineFirst: true
  }));

  ipcMain.handle(IPC.pickWorkspace, async () => {
    const result = await dialog.showOpenDialog({
      title: "Open project",
      properties: ["openDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.probeLocalModels, async (_event, endpoint: unknown) => {
    if (typeof endpoint !== "string" || endpoint.length > 2048) {
      return { ok: false, endpoint: "", models: [], error: "Invalid local model endpoint." };
    }

    try {
      const provider = new LocalOpenAIProvider({ baseUrl: endpoint, requestTimeoutMs: 2_500 });
      const models = await provider.listModels();
      return { ok: true, endpoint: provider.baseUrl, models };
    } catch (error) {
      return {
        ok: false,
        endpoint,
        models: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

void app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
