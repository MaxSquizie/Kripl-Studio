import type { RuntimeEventEnvelope } from "./events.js";

export interface MemoryQuery {
  text: string;
  workspacePath?: string;
  limit?: number;
}

export interface MemoryItem {
  id: string;
  content: string;
  kind: "episodic" | "semantic" | "procedural" | "other";
  relevance: number;
  confidence?: number;
  source?: string;
  createdAt?: number;
}

export interface MemoryHealth {
  status: "disabled" | "ready" | "degraded" | "error";
  message?: string;
}

export interface MemoryRuntime {
  readonly id: string;

  health(): Promise<MemoryHealth>;
  retrieve(query: MemoryQuery): Promise<MemoryItem[]>;
  observe(event: RuntimeEventEnvelope): Promise<void>;
  dispose(): Promise<void>;
}

export class NoopMemoryRuntime implements MemoryRuntime {
  readonly id = "memory:none";

  async health(): Promise<MemoryHealth> {
    return { status: "disabled", message: "Memory runtime is not configured." };
  }

  async retrieve(_query: MemoryQuery): Promise<MemoryItem[]> {
    return [];
  }

  async observe(_event: RuntimeEventEnvelope): Promise<void> {
    // Intentionally disabled.
  }

  async dispose(): Promise<void> {
    // Nothing to dispose.
  }
}
