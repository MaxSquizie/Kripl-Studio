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
  /** Optional: rename the live session (e.g. Pi's set_session_name). */
  setSessionName?(name: string): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: AgentEventListener): Unsubscribe;
}
