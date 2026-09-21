import type { AgentEvent, AgentStatus, AttachedFile, AgentInteractionResponse, AgentSessionSearchHit, AgentSessionSnapshot, AgentSessionSummary, BrowserHistoryEntry, BrowserState, ContextInspectorSnapshot, DesktopBootstrapState, DesktopRuntimeSettings, DesktopUiState, MemoryItem, RecentProject, TerminalEvent, TerminalSessionInfo, WorkspaceChange, WorkspaceCommitResult, WorkspaceDescriptor, WorkspaceDiff, WorkspaceEntry, WorkspaceFilePreview, WorkspaceFileSearchResult, WorkspaceGitStatus, WorkspaceTextSearchResult } from "@kripl/core";
import { contextBridge, ipcRenderer } from "electron";

const IPC = {
  appInfo: "kripl:app-info",
  windowMinimize: "kripl:window-minimize",
  windowToggleMaximize: "kripl:window-toggle-maximize",
  windowClose: "kripl:window-close",
  windowMaximized: "kripl:window-maximized",
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
  agentRenameSession: "kripl:agent-rename-session",
  agentSessionsChanged: "kripl:agent-sessions-changed",
  agentStart: "kripl:agent-start",
  agentAttach: "kripl:agent-attach",
  agentDeleteSession: "kripl:agent-delete-session",
  agentLiveSessions: "kripl:agent-live-sessions",
  agentLiveChanged: "kripl:agent-live-changed",
  agentSessionSnapshot: "kripl:agent-session-snapshot",
  agentExportSession: "kripl:agent-export-session",
  agentSearchSessions: "kripl:agent-search-sessions",
  agentSend: "kripl:agent-send",
  pickAttachFiles: "kripl:pick-attach-files",
  agentAttachFiles: "kripl:agent-attach-files",
  pasteAgentFiles: "kripl:paste-agent-files",
  attachPreview: "kripl:attach-preview",
  agentAbort: "kripl:agent-abort",
  agentStop: "kripl:agent-stop",
  agentRespondInteraction: "kripl:agent-respond-interaction",
  agentEvent: "kripl:agent-event",
  browserGetState: "kripl:browser-get-state",
  browserGetHistory: "kripl:browser-get-history",
  browserNavigate: "kripl:browser-navigate",
  browserHistory: "kripl:browser-history",
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

  renameAgentSession: (sessionPath: string, name: string) =>
    ipcRenderer.invoke(IPC.agentRenameSession, { sessionPath, name }) as Promise<ActionResult>,

  onAgentSessionsChanged: (callback: () => void) => {
    const listener = (_event: Electron.IpcRendererEvent): void => callback();
    ipcRenderer.on(IPC.agentSessionsChanged, listener);
    return () => ipcRenderer.removeListener(IPC.agentSessionsChanged, listener);
  },

  minimizeWindow: () => ipcRenderer.invoke(IPC.windowMinimize) as Promise<void>,

  toggleMaximizeWindow: () => ipcRenderer.invoke(IPC.windowToggleMaximize) as Promise<void>,

  closeWindow: () => ipcRenderer.invoke(IPC.windowClose) as Promise<void>,

  onWindowMaximized: (callback: (maximized: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void =>
      callback(Boolean(maximized));
    ipcRenderer.on(IPC.windowMaximized, listener);
    return () => ipcRenderer.removeListener(IPC.windowMaximized, listener);
  },

  getBrowserHistory: () =>
    ipcRenderer.invoke(IPC.browserGetHistory) as Promise<BrowserHistoryEntry[]>,

  onBrowserHistory: (callback: (entries: BrowserHistoryEntry[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entries: BrowserHistoryEntry[]): void =>
      callback(entries);
    ipcRenderer.on(IPC.browserHistory, listener);
    return () => ipcRenderer.removeListener(IPC.browserHistory, listener);
  },

  startAgent: (request: { endpoint: string; modelId: string; sessionPath?: string }) =>
    ipcRenderer.invoke(
      IPC.agentStart,
      request
    ) as Promise<ActionResult & { agentId?: number }>,

  attachAgent: (sessionPath: string) =>
    ipcRenderer.invoke(IPC.agentAttach, sessionPath) as Promise<
      ActionResult & { agentId?: number; status?: AgentStatus }
    >,

  deleteAgentSession: (sessionPath: string) =>
    ipcRenderer.invoke(IPC.agentDeleteSession, sessionPath) as Promise<ActionResult>,

  listLiveAgents: () =>
    ipcRenderer.invoke(
      IPC.agentLiveSessions
    ) as Promise<Array<{ sessionPath?: string; running: boolean }>>,

  onAgentLiveChanged: (listener: (live: Array<{ sessionPath?: string; running: boolean }>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, live: unknown): void =>
      listener(live as Array<{ sessionPath?: string; running: boolean }>);
    ipcRenderer.on(IPC.agentLiveChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC.agentLiveChanged, handler);
    };
  },

  getAgentSessionSnapshot: () =>
    ipcRenderer.invoke(IPC.agentSessionSnapshot) as Promise<AgentSessionSnapshot | null>,

  exportAgentSession: (sessionPath: string) =>
    ipcRenderer.invoke(
      IPC.agentExportSession,
      sessionPath
    ) as Promise<AgentSessionSnapshot | null>,

  searchAgentSessions: (query: string) =>
    ipcRenderer.invoke(IPC.agentSearchSessions, query) as Promise<AgentSessionSearchHit[]>,

  sendAgentMessage: (message: string) =>
    ipcRenderer.invoke(IPC.agentSend, message) as Promise<ActionResult>,

  pickAttachFiles: () => ipcRenderer.invoke(IPC.pickAttachFiles) as Promise<string[]>,

  attachAgentFiles: (paths: string[]) =>
    ipcRenderer.invoke(IPC.agentAttachFiles, paths) as Promise<{
      ok: boolean;
      error?: string;
      files?: AttachedFile[];
    }>,

  pasteAgentFiles: (items: Array<{ name?: string; dataBase64?: string }>) =>
    ipcRenderer.invoke(IPC.pasteAgentFiles, items) as Promise<{
      ok: boolean;
      error?: string;
      files?: AttachedFile[];
    }>,

  readAttachPreview: (path: string) =>
    ipcRenderer.invoke(IPC.attachPreview, path) as Promise<{
      ok: boolean;
      error?: string;
      mime?: string;
      dataUrl?: string;
    }>,

  abortAgent: () => ipcRenderer.invoke(IPC.agentAbort) as Promise<ActionResult>,

  stopAgent: () => ipcRenderer.invoke(IPC.agentStop) as Promise<ActionResult>,

  respondToAgentInteraction: (response: AgentInteractionResponse) =>
    ipcRenderer.invoke(IPC.agentRespondInteraction, response) as Promise<ActionResult>,

  getBrowserState: () => ipcRenderer.invoke(IPC.browserGetState) as Promise<BrowserState>,

  setBrowserVisible: (visible: boolean) =>
    ipcRenderer.invoke(IPC.browserSetVisible, visible) as Promise<BrowserState>,

  navigateBrowser: (url: string) =>
    ipcRenderer.invoke(IPC.browserNavigate, url).then(
      (state: BrowserState) => state,
      (error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      }
    ) as Promise<BrowserState>,

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
