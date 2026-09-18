import type { AgentEvent, AgentInteractionResponse, BrowserState, DesktopBootstrapState, DesktopRuntimeSettings, DesktopUiState, RecentProject, TerminalEvent, TerminalSessionInfo, WorkspaceChange, WorkspaceDescriptor, WorkspaceDiff, WorkspaceEntry, WorkspaceFilePreview } from "@kripl/core";
import { contextBridge, ipcRenderer } from "electron";

const IPC = {
  appInfo: "kripl:app-info",
  pickWorkspace: "kripl:pick-workspace",
  desktopBootstrap: "kripl:desktop-bootstrap",
  openRecentProject: "kripl:open-recent-project",
  forgetRecentProject: "kripl:forget-recent-project",
  saveDesktopUi: "kripl:save-desktop-ui",
  saveRuntimeSettings: "kripl:save-runtime-settings",
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
  browserState: "kripl:browser-state",
  terminalGetState: "kripl:terminal-get-state",
  terminalStart: "kripl:terminal-start",
  terminalWrite: "kripl:terminal-write",
  terminalResize: "kripl:terminal-resize",
  terminalKill: "kripl:terminal-kill",
  terminalPanelVisible: "kripl:terminal-panel-visible",
  terminalEvent: "kripl:terminal-event"
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

  getDesktopBootstrap: () => ipcRenderer.invoke(IPC.desktopBootstrap) as Promise<DesktopBootstrapState>,

  pickWorkspace: () => ipcRenderer.invoke(IPC.pickWorkspace) as Promise<WorkspaceDescriptor | null>,

  openRecentProject: (path: string) =>
    ipcRenderer.invoke(IPC.openRecentProject, path) as Promise<WorkspaceDescriptor>,

  forgetRecentProject: (path: string) =>
    ipcRenderer.invoke(IPC.forgetRecentProject, path) as Promise<RecentProject[]>,

  saveDesktopUi: (ui: DesktopUiState) =>
    ipcRenderer.invoke(IPC.saveDesktopUi, ui) as Promise<void>,

  saveRuntimeSettings: (runtime: DesktopRuntimeSettings) =>
    ipcRenderer.invoke(IPC.saveRuntimeSettings, runtime) as Promise<DesktopRuntimeSettings>,

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

  getTerminalState: () =>
    ipcRenderer.invoke(IPC.terminalGetState) as Promise<TerminalSessionInfo | null>,

  startTerminal: (size?: { cols?: number; rows?: number }) =>
    ipcRenderer.invoke(IPC.terminalStart, size) as Promise<TerminalSessionInfo>,

  writeTerminal: (data: string) =>
    ipcRenderer.invoke(IPC.terminalWrite, data) as Promise<void>,

  resizeTerminal: (cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.terminalResize, cols, rows) as Promise<void>,

  killTerminal: () => ipcRenderer.invoke(IPC.terminalKill) as Promise<void>,

  setTerminalPanelVisible: (visible: boolean) =>
    ipcRenderer.invoke(IPC.terminalPanelVisible, visible) as Promise<void>,

  onTerminalEvent: (listener: (event: TerminalEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalEvent) => listener(payload);
    ipcRenderer.on(IPC.terminalEvent, handler);
    return () => ipcRenderer.removeListener(IPC.terminalEvent, handler);
  },

  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
    ipcRenderer.on(IPC.agentEvent, handler);
    return () => ipcRenderer.removeListener(IPC.agentEvent, handler);
  }
};

contextBridge.exposeInMainWorld("kripl", api);
