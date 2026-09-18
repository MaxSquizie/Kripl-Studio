import type {
  AgentEvent,
  AgentInteractionResponse,
  Unsubscribe
} from "./events.js";
import type { AgentSessionSnapshot } from "./agent-session.js";

export interface AgentStartOptions {
  workspacePath: string;
  sessionPath?: string;
}

export interface AgentInput {
  text: string;
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentRuntime {
  readonly id: string;

  start(options: AgentStartOptions): Promise<void>;
  send(input: AgentInput): Promise<void>;
  stop(): Promise<void>;
  respondToInteraction(response: AgentInteractionResponse): Promise<void>;
  getSessionSnapshot(): Promise<AgentSessionSnapshot>;
  dispose(): Promise<void>;
  subscribe(listener: AgentEventListener): Unsubscribe;
}
