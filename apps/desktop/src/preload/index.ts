import type { AgentEvent, AgentInteractionResponse, AgentSessionSnapshot, AgentSessionSummary, BrowserState, ContextInspectorSnapshot, DesktopBootstrapState, DesktopRuntimeSettings, DesktopUiState, MemoryItem, RecentProject, TerminalEvent, TerminalSessionInfo, WorkspaceChange, WorkspaceCommitResult, WorkspaceDescriptor, WorkspaceDiff, WorkspaceEntry, WorkspaceFilePreview, WorkspaceFileSearchResult, WorkspaceGitStatus, WorkspaceTextSearchResult } from "@kripl/core";
import { contextBridge, ipcRenderer } from "electron";

const IPC = {
  appInfo: "kripl:app-info",
  pickWorkspace: "kripl:pick-workspace",
  desktopBootstrap: "kripl:desktop-bootstrap",
  openRecentProject: "kripl:open-recent-project",
  forgetRecentProject: "kripl:forget-recent-project",
  saveDesktopUi: "kripl:save-desktop-ui",
  saveRuntimeSettings: "kripl:save-runtime-settings",
  contextGetSnapshot: "kripl:context-get-snapshot",
  contextRetrieveMemory: "kripl:context-retrieve-memory",
  contextSnapshot: "kripl:context-snapshot",
  workspaceList: "kripl:workspace-list",
  workspaceReadFile: "kripl:workspace-read-file",
  workspaceWriteFile: "kripl:workspace-write-file",
  workspaceSearchFiles: "kripl:workspace-search-files",
  workspaceSearchText: "kripl:workspace-search-text",
  workspaceChanges: "kripl:workspace-changes",
  workspaceDiff: "kripl:workspace-diff",
  workspaceStage: "kripl:workspace-stage",
  workspaceUnstage: "kripl:workspace-unstage",
  workspaceRevert: "kripl:workspace-revert",
  workspaceGitStatus: "kripl:workspace-git-status",
  workspaceCommit: "kripl:workspace-commit",
  probeLocalModels: "kripl:probe-local-models",
  agentSessions: "kripl:agent-sessions",
  agentStart: "kripl:agent-start",
  agentSessionSnapshot: "kripl:agent-session-snapshot",
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

  getContextSnapshot: () =>
    ipcRenderer.invoke(IPC.contextGetSnapshot) as Promise<ContextInspectorSnapshot>,

  retrieveMemory: (query: string) =>
    ipcRenderer.invoke(IPC.contextRetrieveMemory, query) as Promise<MemoryItem[]>,

  onContextSnapshot: (listener: (snapshot: ContextInspectorSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ContextInspectorSnapshot) =>
      listener(payload);
    ipcRenderer.on(IPC.contextSnapshot, handler);
    return () => ipcRenderer.removeListener(IPC.contextSnapshot, handler);
  },

  listWorkspace: (path = "") => ipcRenderer.invoke(IPC.workspaceList, path) as Promise<WorkspaceEntry[]>,

  readWorkspaceFile: (path: string) =>
    ipcRenderer.invoke(IPC.workspaceReadFile, path) as Promise<WorkspaceFilePreview>,

  writeWorkspaceFile: (path: string, content: string) =>
    ipcRenderer.invoke(IPC.workspaceWriteFile, path, content) as Promise<WorkspaceFilePreview>,

  searchWorkspaceFiles: (query: string, limit = 80) =>
    ipcRenderer.invoke(IPC.workspaceSearchFiles, query, limit) as Promise<WorkspaceFileSearchResult[]>,

  searchWorkspaceText: (query: string, limit = 120) =>
    ipcRenderer.invoke(IPC.workspaceSearchText, query, limit) as Promise<WorkspaceTextSearchResult[]>,

  getWorkspaceChanges: () => ipcRenderer.invoke(IPC.workspaceChanges) as Promise<WorkspaceChange[]>,

  getWorkspaceDiff: (path: string) =>
    ipcRenderer.invoke(IPC.workspaceDiff, path) as Promise<WorkspaceDiff>,

  stageWorkspaceChange: (path: string) =>
    ipcRenderer.invoke(IPC.workspaceStage, path) as Promise<void>,

  unstageWorkspaceChange: (path: string) =>
    ipcRenderer.invoke(IPC.workspaceUnstage, path) as Promise<void>,

  revertWorkspaceChange: (path: string) =>
    ipcRenderer.invoke(IPC.workspaceRevert, path) as Promise<void>,

  getWorkspaceGitStatus: () =>
    ipcRenderer.invoke(IPC.workspaceGitStatus) as Promise<WorkspaceGitStatus | null>,

  commitWorkspaceChanges: (message: string) =>
    ipcRenderer.invoke(IPC.workspaceCommit, message) as Promise<WorkspaceCommitResult>,

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

  listAgentSessions: () =>
    ipcRenderer.invoke(IPC.agentSessions) as Promise<AgentSessionSummary[]>,

  startAgent: (request: { endpoint: string; modelId: string; sessionPath?: string }) =>
    ipcRenderer.invoke(IPC.agentStart, request) as Promise<ActionResult>,

  getAgentSessionSnapshot: () =>
    ipcRenderer.invoke(IPC.agentSessionSnapshot) as Promise<AgentSessionSnapshot | null>,

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
