import type { AgentEvent } from "@kripl/core";
import { contextBridge, ipcRenderer } from "electron";

const IPC = {
  appInfo: "kripl:app-info",
  pickWorkspace: "kripl:pick-workspace",
  probeLocalModels: "kripl:probe-local-models",
  agentStart: "kripl:agent-start",
  agentSend: "kripl:agent-send",
  agentAbort: "kripl:agent-abort",
  agentStop: "kripl:agent-stop",
  agentEvent: "kripl:agent-event"
} as const;

interface ActionResult {
  ok: boolean;
  error?: string;
}

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
    }>,

  startAgent: (request: { workspacePath: string; endpoint: string; modelId: string }) =>
    ipcRenderer.invoke(IPC.agentStart, request) as Promise<ActionResult>,

  sendAgentMessage: (message: string) =>
    ipcRenderer.invoke(IPC.agentSend, message) as Promise<ActionResult>,

  abortAgent: () => ipcRenderer.invoke(IPC.agentAbort) as Promise<ActionResult>,

  stopAgent: () => ipcRenderer.invoke(IPC.agentStop) as Promise<ActionResult>,

  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
    ipcRenderer.on(IPC.agentEvent, handler);
    return () => ipcRenderer.removeListener(IPC.agentEvent, handler);
  }
};

contextBridge.exposeInMainWorld("kripl", api);
