import { contextBridge, ipcRenderer } from "electron";

const IPC = {
  appInfo: "kripl:app-info",
  pickWorkspace: "kripl:pick-workspace"
} as const;

const api = {
  getAppInfo: () =>
    ipcRenderer.invoke(IPC.appInfo) as Promise<{
      name: string;
      version: string;
      platform: string;
      offlineFirst: boolean;
    }>,
  pickWorkspace: () => ipcRenderer.invoke(IPC.pickWorkspace) as Promise<string | null>
};

contextBridge.exposeInMainWorld("kripl", api);
