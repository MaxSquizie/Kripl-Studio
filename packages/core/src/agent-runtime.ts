import type { AgentEvent, Unsubscribe } from "./events.js";

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
  dispose(): Promise<void>;
  subscribe(listener: AgentEventListener): Unsubscribe;
}
