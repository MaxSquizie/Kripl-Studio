import type { MemoryHealth, MemoryItem } from "./memory-runtime.js";
import type { RuntimeEventEnvelope } from "./events.js";

export type ContextSourceKind =
  | "instruction"
  | "workspace"
  | "conversation"
  | "tool"
  | "memory"
  | "runtime";

export interface ContextContribution {
  id: string;
  source: ContextSourceKind;
  title: string;
  content: string;
  priority: number;
  estimatedTokens?: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface ContextBuildRequest {
  userText: string;
  workspacePath?: string;
  tokenBudget?: number;
}

export interface ContextBuildResult {
  createdAt: number;
  contributions: ContextContribution[];
  memoryItems: MemoryItem[];
  estimatedTokens?: number;
}

export interface ContextInspectorSnapshot {
  updatedAt: number;
  memoryRuntimeId: string;
  memoryHealth: MemoryHealth;
  retrievedMemory: MemoryItem[];
  recentEvents: RuntimeEventEnvelope[];
}

export type ContextInspectorListener = (snapshot: ContextInspectorSnapshot) => void;

export interface ContextRuntime {
  readonly id: string;

  initialize(): Promise<void>;
  record(event: RuntimeEventEnvelope["event"]): Promise<RuntimeEventEnvelope>;
  retrieveMemory(query: string, workspacePath?: string, limit?: number): Promise<MemoryItem[]>;
  snapshot(): ContextInspectorSnapshot;
  subscribe(listener: ContextInspectorListener): () => void;
  dispose(): Promise<void>;
}
