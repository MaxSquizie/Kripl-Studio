import type { AgentEvent, AgentInteractionResponse, BrowserState, WorkspaceChange, WorkspaceDescriptor, WorkspaceDiff, WorkspaceEntry, WorkspaceFilePreview } from "@kripl/core";
import { contextBridge, ipcRenderer } from "electron";

const IPC = {
  appInfo: "kripl:app-info",
  pickWorkspace: "kripl:pick-workspace",
  workspaceList: "kripl:workspace-list",
  workspaceReadFile: "kripl:workspace-read-file",
  workspaceChanges: "kripl:workspace-changes",
  workspaceDiff: "kripl:workspace-diff",
  probeLocalModels: "kripl:probe-local-models",
  agentStart: "kripl:agent-start",
  agentSend: "kripl:agent-send",
  agentAbort: "kripl:agent-abort",
  agentStop: "kripl:agent-stop",
  agentRespondInteraction: "kripl:agent-respond-interaction",
  agentEvent: "kripl:agent-event",
  browserGetState: "kripl:browser-get-state",
  browserSetVisible: "kripl:browser-set-visible",
  browserState: "kripl:browser-state"
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
      networkMode: "online" | "restricted" | "offline";
      modelRouting: "local-only" | "allow-remote";
    }>,

  pickWorkspace: () => ipcRenderer.invoke(IPC.pickWorkspace) as Promise<WorkspaceDescriptor | null>,

  listWorkspace: (path = "") => ipcRenderer.invoke(IPC.workspaceList, path) as Promise<WorkspaceEntry[]>,

  readWorkspaceFile: (path: string) =>
    ipcRenderer.invoke(IPC.workspaceReadFile, path) as Promise<WorkspaceFilePreview>,

  getWorkspaceChanges: () => ipcRenderer.invoke(IPC.workspaceChanges) as Promise<WorkspaceChange[]>,

  getWorkspaceDiff: (path: string) =>
    ipcRenderer.invoke(IPC.workspaceDiff, path) as Promise<WorkspaceDiff>,

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

  startAgent: (request: { endpoint: string; modelId: string }) =>
    ipcRenderer.invoke(IPC.agentStart, request) as Promise<ActionResult>,

  sendAgentMessage: (message: string) =>
    ipcRenderer.invoke(IPC.agentSend, message) as Promise<ActionResult>,

  abortAgent: () => ipcRenderer.invoke(IPC.agentAbort) as Promise<ActionResult>,

  stopAgent: () => ipcRenderer.invoke(IPC.agentStop) as Promise<ActionResult>,

  respondToAgentInteraction: (response: AgentInteractionResponse) =>
    ipcRenderer.invoke(IPC.agentRespondInteraction, response) as Promise<ActionResult>,

  getBrowserState: () => ipcRenderer.invoke(IPC.browserGetState) as Promise<BrowserState>,

  setBrowserVisible: (visible: boolean) =>
    ipcRenderer.invoke(IPC.browserSetVisible, visible) as Promise<BrowserState>,

  onBrowserState: (listener: (state: BrowserState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: BrowserState) => listener(payload);
    ipcRenderer.on(IPC.browserState, handler);
    return () => ipcRenderer.removeListener(IPC.browserState, handler);
  },

  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
    ipcRenderer.on(IPC.agentEvent, handler);
    return () => ipcRenderer.removeListener(IPC.agentEvent, handler);
  }
};

contextBridge.exposeInMainWorld("kripl", api);
