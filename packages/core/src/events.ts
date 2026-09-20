export type Unsubscribe = () => void;

export type AgentStatus = "idle" | "starting" | "ready" | "running" | "stopping" | "stopped" | "error";

export interface AttachedFile {
  name: string;
  path: string;
  sizeBytes: number;
  kind: "image" | "archive" | "text" | "binary";
  preview?: string;
  error?: string;
}

export type AgentInteractionKind = "confirm" | "select" | "input" | "editor";

export interface AgentInteractionRequest {
  id: string;
  kind: AgentInteractionKind;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeoutMs?: number;
}

export interface AgentInteractionResponse {
  id: string;
  confirmed?: boolean;
  value?: string;
  cancelled?: boolean;
}

export type AgentEvent =
  | {
      type: "agent.status";
      status: AgentStatus;
      message?: string;
    }
  | {
      type: "agent.message";
      role: "user" | "assistant" | "system";
      text: string;
    }
  | {
      type: "agent.turn";
      phase: "started" | "completed";
    }
  | {
      type: "agent.stream";
      channel: "text" | "thinking";
      phase: "started";
      contentIndex: number;
    }
  | {
      type: "agent.stream";
      channel: "text" | "thinking";
      phase: "delta";
      contentIndex: number;
      delta: string;
    }
  | {
      type: "agent.stream";
      channel: "text" | "thinking";
      phase: "completed";
      contentIndex: number;
      content: string;
    }
  | {
      type: "agent.tool";
      phase: "started" | "updated" | "completed" | "failed";
      callId: string;
      name: string;
      payload?: unknown;
    }
  | {
      type: "agent.interaction";
      request: AgentInteractionRequest;
    }
  | {
      type: "agent.usage";
      input?: number;
      output?: number;
      cacheRead?: number;
      totalTokens?: number;
    }
  | {
      type: "agent.notification";
      level: "info" | "warning" | "error";
      message: string;
    }
  | {
      type: "agent.raw";
      source: string;
      payload: unknown;
    };

export type RuntimeEvent =
  | AgentEvent
  | {
      type: "user.message";
      text: string;
      workspacePath?: string;
    }
  | {
      type: "workspace.opened";
      path: string;
      name: string;
      gitRepository: boolean;
    }
  | {
      type: "workspace.file.opened";
      path: string;
      sizeBytes: number;
      binary: boolean;
    }
  | {
      type: "workspace.diff.opened";
      path: string;
    }
  | {
      type: "browser.state";
      visible: boolean;
      loading: boolean;
      url: string;
      title: string;
    }
  | {
      type: "terminal.session";
      status: "idle" | "starting" | "running" | "exited";
      cwd?: string;
      shell?: string;
      exitCode?: number;
    }
  | {
      type: "memory.query";
      text: string;
      workspacePath?: string;
    }
  | {
      type: "memory.retrieved";
      query: string;
      itemIds: string[];
    }
  | {
      type: "memory.status";
      runtimeId: string;
      status: "disabled" | "ready" | "degraded" | "error";
      message?: string;
    };

export interface RuntimeEventEnvelope<TEvent extends RuntimeEvent = RuntimeEvent> {
  id: string;
  timestamp: number;
  event: TEvent;
}
