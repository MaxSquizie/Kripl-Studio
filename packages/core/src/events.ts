export type Unsubscribe = () => void;

export type AgentStatus = "idle" | "starting" | "ready" | "running" | "stopping" | "stopped" | "error";

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
      type: "agent.tool";
      phase: "started" | "updated" | "completed" | "failed";
      callId: string;
      name: string;
      payload?: unknown;
    }
  | {
      type: "agent.raw";
      source: string;
      payload: unknown;
    };

export interface RuntimeEventEnvelope<TEvent = AgentEvent> {
  id: string;
  timestamp: number;
  event: TEvent;
}
