import { contextBridge, ipcRenderer } from "electron";

const IPC = {
  appInfo: "kripl:app-info",
  pickWorkspace: "kripl:pick-workspace",
  probeLocalModels: "kripl:probe-local-models"
} as const;

const api = {
  getAppInfo: () =>
    ipcRenderer.invoke(IPC.appInfo) as Promise<{
      name: string;
      version: string;
      platform: string;
      offlineFirst: boolean;
    }>,
  pickWorkspace: () => ipcRenderer.invoke(IPC.pickWorkspace) as Promise<string | null>,
  probeLocalModels: (endpoint: string) =>
    ipcRenderer.invoke(IPC.probeLocalModels, endpoint) as Promise<{
      ok: boolean;
      endpoint: string;
      models: Array<{
        provider: string;
        id: string;
        name: string;
        local: boolean;
        contextWindow?: number;
        input?: Array<"text" | "image">;
      }>;
      error?: string;
    }>
};

contextBridge.exposeInMainWorld("kripl", api);
