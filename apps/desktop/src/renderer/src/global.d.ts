import type { AgentEvent, AgentStatus, AttachedFile, AgentInteractionResponse, AgentSessionSearchHit, AgentSessionSnapshot, AgentSessionSummary, BrowserHistoryEntry, BrowserState, ContextInspectorSnapshot, DesktopBootstrapState, DesktopRuntimeSettings, DesktopUiState, MemoryItem, RecentProject, TerminalEvent, TerminalSessionInfo, WorkspaceChange, WorkspaceCommitResult, WorkspaceDescriptor, WorkspaceDiff, WorkspaceEntry, WorkspaceFilePreview, WorkspaceFileSearchResult, WorkspaceGitStatus, WorkspaceTextSearchResult } from "@kripl/core";

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.mp4" {
  const src: string;
  export default src;
}

export {};

interface ActionResult {
  ok: boolean;
  error?: string;
}

declare global {
  interface Window {
    kripl: {
      getAppInfo(): Promise<{
        name: string;
        version: string;
        platform: string;
        networkMode: "online" | "restricted" | "offline";
        modelRouting: "local-only" | "allow-remote";
      }>;
      minimizeWindow(): Promise<void>;
      toggleMaximizeWindow(): Promise<void>;
      closeWindow(): Promise<void>;
      onWindowMaximized(listener: (maximized: boolean) => void): () => void;
      getDesktopBootstrap(): Promise<DesktopBootstrapState>;
      pickWorkspace(): Promise<WorkspaceDescriptor | null>;
      openRecentProject(path: string): Promise<WorkspaceDescriptor>;
      forgetRecentProject(path: string): Promise<RecentProject[]>;
      saveDesktopUi(ui: DesktopUiState): Promise<void>;
      saveRuntimeSettings(runtime: DesktopRuntimeSettings): Promise<DesktopRuntimeSettings>;
      getContextSnapshot(): Promise<ContextInspectorSnapshot>;
      retrieveMemory(query: string): Promise<MemoryItem[]>;
      onContextSnapshot(listener: (snapshot: ContextInspectorSnapshot) => void): () => void;
      listWorkspace(path?: string): Promise<WorkspaceEntry[]>;
      readWorkspaceFile(path: string): Promise<WorkspaceFilePreview>;
      writeWorkspaceFile(path: string, content: string): Promise<WorkspaceFilePreview>;
      searchWorkspaceFiles(query: string, limit?: number): Promise<WorkspaceFileSearchResult[]>;
      searchWorkspaceText(query: string, limit?: number): Promise<WorkspaceTextSearchResult[]>;
      getWorkspaceChanges(): Promise<WorkspaceChange[]>;
      getWorkspaceDiff(path: string): Promise<WorkspaceDiff>;
      stageWorkspaceChange(path: string): Promise<void>;
      unstageWorkspaceChange(path: string): Promise<void>;
      revertWorkspaceChange(path: string): Promise<void>;
      getWorkspaceGitStatus(): Promise<WorkspaceGitStatus | null>;
      commitWorkspaceChanges(message: string): Promise<WorkspaceCommitResult>;
      probeLocalModels(endpoint: string): Promise<{
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
      }>;
      listAgentSessions(): Promise<AgentSessionSummary[]>;
      renameAgentSession(sessionPath: string, name: string): Promise<ActionResult>;
      onAgentSessionsChanged(listener: () => void): () => void;
      startAgent(request: {
        endpoint: string;
        modelId: string;
        sessionPath?: string;
      }): Promise<ActionResult & { agentId?: number }>;
      attachAgent(sessionPath: string): Promise<
        ActionResult & { agentId?: number; status?: AgentStatus }
      >;
      deleteAgentSession(sessionPath: string): Promise<ActionResult>;
      listLiveAgents(): Promise<Array<{ sessionPath?: string; running: boolean }>>;
      onAgentLiveChanged(
        listener: (live: Array<{ sessionPath?: string; running: boolean }>) => void
      ): () => void;
      getAgentSessionSnapshot(): Promise<AgentSessionSnapshot | null>;
      exportAgentSession(sessionPath: string): Promise<AgentSessionSnapshot | null>;
      searchAgentSessions(query: string): Promise<AgentSessionSearchHit[]>;
      sendAgentMessage(message: string): Promise<ActionResult>;
      pickAttachFiles(): Promise<string[]>;
      attachAgentFiles(paths: string[]): Promise<{
        ok: boolean;
        error?: string;
        files?: AttachedFile[];
      }>;
      pasteAgentFiles(items: Array<{ name?: string; dataBase64?: string }>): Promise<{
        ok: boolean;
        error?: string;
        files?: AttachedFile[];
      }>;
      readAttachPreview(path: string): Promise<{
        ok: boolean;
        error?: string;
        mime?: string;
        dataUrl?: string;
      }>;
      abortAgent(): Promise<ActionResult>;
      stopAgent(): Promise<ActionResult>;
      respondToAgentInteraction(response: AgentInteractionResponse): Promise<ActionResult>;
      getBrowserState(): Promise<BrowserState>;
      setBrowserVisible(visible: boolean): Promise<BrowserState>;
      navigateBrowser(url: string): Promise<BrowserState>;
      getBrowserHistory(): Promise<BrowserHistoryEntry[]>;
      onBrowserState(listener: (state: BrowserState) => void): () => void;
      onBrowserHistory(listener: (entries: BrowserHistoryEntry[]) => void): () => void;
      getTerminalState(): Promise<TerminalSessionInfo | null>;
      startTerminal(size?: { cols?: number; rows?: number }): Promise<TerminalSessionInfo>;
      writeTerminal(data: string): Promise<void>;
      resizeTerminal(cols: number, rows: number): Promise<void>;
      killTerminal(): Promise<void>;
      setTerminalPanelVisible(visible: boolean): Promise<void>;
      onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
      onAgentEvent(listener: (event: AgentEvent) => void): () => void;
    };
  }
}
