import type { AgentEvent } from "@kripl/core";

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
        offlineFirst: boolean;
      }>;
      pickWorkspace(): Promise<string | null>;
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
        workspacePath: string;
        endpoint: string;
        modelId: string;
      }): Promise<ActionResult>;
      sendAgentMessage(message: string): Promise<ActionResult>;
      abortAgent(): Promise<ActionResult>;
      stopAgent(): Promise<ActionResult>;
      onAgentEvent(listener: (event: AgentEvent) => void): () => void;
    };
  }
}
