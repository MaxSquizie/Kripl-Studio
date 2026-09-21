export interface AgentSessionSummary {
  path: string;
  id: string;
  workspacePath: string;
  name?: string;
  parentSessionPath?: string;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  firstMessage: string;
}

/** One full-text match inside a saved chat (session search). */
export interface AgentSessionSearchHit {
  sessionPath: string;
  sessionName?: string;
  role: "user" | "assistant" | "tool" | "system";
  snippet: string;
}

export interface AgentSessionMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  timestamp?: number;
  toolName?: string;
  isError?: boolean;
}

export interface AgentSessionSnapshot {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
  messages: AgentSessionMessage[];
}

export interface AgentSessionCatalog {
  list(workspacePath: string): Promise<AgentSessionSummary[]>;
}
