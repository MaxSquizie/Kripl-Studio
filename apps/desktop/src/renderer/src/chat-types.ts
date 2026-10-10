export type MessageRole = "user" | "assistant" | "system";

export type ReasoningStep =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: ToolItem };

export interface ReasoningBlock {
  steps: ReasoningStep[];
  durationMs?: number;
}

export interface MessageItem {
  kind: "message";
  id: string;
  role: MessageRole;
  text: string;
  images?: string[];
  imagePaths?: string[];
  files?: { name: string; path: string }[];
  reasoning?: ReasoningBlock;
  tokps?: number;
}

export interface ToolItem {
  kind: "tool";
  callId: string;
  name: string;
  phase: "started" | "updated" | "completed" | "failed";
  /** Bounded UI preview; full tool results remain in the runtime/session. */
  preview?: string;
}

export type FeedItem = MessageItem | ToolItem;
