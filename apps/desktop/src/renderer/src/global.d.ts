import type { AgentEvent, AgentInteractionResponse, BrowserState, TerminalEvent, TerminalSessionInfo, WorkspaceChange, WorkspaceDescriptor, WorkspaceDiff, WorkspaceEntry, WorkspaceFilePreview } from "@kripl/core";

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
      pickWorkspace(): Promise<WorkspaceDescriptor | null>;
      listWorkspace(path?: string): Promise<WorkspaceEntry[]>;
      readWorkspaceFile(path: string): Promise<WorkspaceFilePreview>;
      getWorkspaceChanges(): Promise<WorkspaceChange[]>;
      getWorkspaceDiff(path: string): Promise<WorkspaceDiff>;
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
      startAgent(request: {
        endpoint: string;
        modelId: string;
      }): Promise<ActionResult>;
      sendAgentMessage(message: string): Promise<ActionResult>;
      abortAgent(): Promise<ActionResult>;
      stopAgent(): Promise<ActionResult>;
      respondToAgentInteraction(response: AgentInteractionResponse): Promise<ActionResult>;
      getBrowserState(): Promise<BrowserState>;
      setBrowserVisible(visible: boolean): Promise<BrowserState>;
      onBrowserState(listener: (state: BrowserState) => void): () => void;
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
