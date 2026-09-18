import type {
  AgentEvent,
  ContextInspectorListener,
  ContextInspectorSnapshot,
  ContextRuntime,
  MemoryHealth,
  MemoryItem,
  MemoryRuntime,
  RuntimeEvent,
  RuntimeEventEnvelope
} from "@kripl/core";
import { NoopMemoryRuntime } from "@kripl/core";
import { randomUUID } from "node:crypto";

export interface InspectableContextRuntimeOptions {
  memory?: MemoryRuntime;
  maxEvents?: number;
}

function isAgentEvent(event: RuntimeEvent): event is AgentEvent {
  return event.type.startsWith("agent.");
}

function shouldRetainEvent(event: RuntimeEvent): boolean {
  if (event.type === "agent.raw") return false;
  if (
    event.type === "agent.stream" &&
    event.phase === "delta"
  ) {
    return false;
  }
  return true;
}

function shouldObserveMemory(event: RuntimeEvent): boolean {
  if (event.type === "user.message") return true;
  if (event.type === "workspace.opened") return true;
  if (event.type === "workspace.file.opened") return true;
  if (event.type === "workspace.diff.opened") return true;

  if (!isAgentEvent(event)) return false;

  if (event.type === "agent.message") return true;

  if (
    event.type === "agent.stream" &&
    event.channel === "text" &&
    event.phase === "completed"
  ) {
    return true;
  }

  if (
    event.type === "agent.tool" &&
    (event.phase === "completed" || event.phase === "failed")
  ) {
    return true;
  }

  return false;
}

function cloneMemoryItem(item: MemoryItem): MemoryItem {
  return { ...item };
}

function truncateText(value: string, limit = 4_000): string {
  return value.length <= limit ? value : value.slice(0, limit) + "\n…";
}

function payloadPreview(payload: unknown): string | undefined {
  if (payload === undefined) return undefined;
  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== "string") return truncateText(String(payload), 2_500);
    return truncateText(serialized, 2_500);
  } catch {
    return truncateText(String(payload), 2_500);
  }
}

function sanitizeEvent(event: RuntimeEvent): RuntimeEvent {
  if (event.type === "user.message") {
    return { ...event, text: truncateText(event.text) };
  }
  if (event.type === "agent.message") {
    return { ...event, text: truncateText(event.text) };
  }
  if (event.type === "agent.notification") {
    return { ...event, message: truncateText(event.message, 2_000) };
  }
  if (event.type === "agent.stream" && event.phase === "completed") {
    return { ...event, content: truncateText(event.content) };
  }
  if (event.type === "agent.tool") {
    const preview = payloadPreview(event.payload);
    return {
      ...event,
      ...(preview === undefined ? {} : { payload: preview })
    };
  }
  if (event.type === "memory.query") {
    return { ...event, text: truncateText(event.text, 2_000) };
  }
  return event;
}

export class InspectableContextRuntime implements ContextRuntime {
  readonly id = "context:inspector";

  private readonly memory: MemoryRuntime;
  private readonly maxEvents: number;
  private readonly listeners = new Set<ContextInspectorListener>();
  private recentEvents: RuntimeEventEnvelope[] = [];
  private retrievedMemory: MemoryItem[] = [];
  private memoryHealth: MemoryHealth = {
    status: "disabled",
    message: "Memory runtime has not been initialized."
  };
  private updatedAt = Date.now();
  private initialized = false;

  constructor(options: InspectableContextRuntimeOptions = {}) {
    this.memory = options.memory ?? new NoopMemoryRuntime();
    this.maxEvents = Math.min(500, Math.max(10, Math.floor(options.maxEvents ?? 120)));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      this.memoryHealth = await this.memory.health();
    } catch (error) {
      this.memoryHealth = {
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      };
    }

    this.updatedAt = Date.now();
    this.emit();
  }

  async record(event: RuntimeEvent): Promise<RuntimeEventEnvelope> {
    if (!this.initialized) await this.initialize();

    const envelope: RuntimeEventEnvelope = {
      id: randomUUID(),
      timestamp: Date.now(),
      event
    };

    if (shouldRetainEvent(event)) {
      this.append({
        ...envelope,
        event: sanitizeEvent(event)
      });
    }

    if (shouldObserveMemory(event)) {
      try {
        await this.memory.observe(envelope);
      } catch (error) {
        this.memoryHealth = {
          status: "degraded",
          message: error instanceof Error ? error.message : String(error)
        };
        this.updatedAt = Date.now();
        this.emit();
      }
    }

    return envelope;
  }

  async retrieveMemory(
    query: string,
    workspacePath?: string,
    limit = 8
  ): Promise<MemoryItem[]> {
    if (!this.initialized) await this.initialize();

    const text = query.trim();
    if (!text) {
      this.retrievedMemory = [];
      this.updatedAt = Date.now();
      this.emit();
      return [];
    }

    const boundedLimit = Math.min(50, Math.max(1, Math.floor(limit)));

    await this.record({
      type: "memory.query",
      text,
      ...(workspacePath ? { workspacePath } : {})
    });

    try {
      const items = await this.memory.retrieve({
        text,
        ...(workspacePath ? { workspacePath } : {}),
        limit: boundedLimit
      });

      this.retrievedMemory = items
        .slice(0, boundedLimit)
        .map(cloneMemoryItem);

      this.append({
        id: randomUUID(),
        timestamp: Date.now(),
        event: {
          type: "memory.retrieved",
          query: text,
          itemIds: this.retrievedMemory.map((item) => item.id)
        }
      });

      try {
        this.memoryHealth = await this.memory.health();
      } catch {
        // Keep the last known health state if the secondary health probe fails.
      }

      this.updatedAt = Date.now();
      this.emit();
      return this.retrievedMemory.map(cloneMemoryItem);
    } catch (error) {
      this.retrievedMemory = [];
      this.memoryHealth = {
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      };
      this.updatedAt = Date.now();
      this.emit();
      throw error;
    }
  }

  snapshot(): ContextInspectorSnapshot {
    return {
      updatedAt: this.updatedAt,
      memoryRuntimeId: this.memory.id,
      memoryHealth: { ...this.memoryHealth },
      retrievedMemory: this.retrievedMemory.map(cloneMemoryItem),
      recentEvents: this.recentEvents.map((entry) => ({
        ...entry,
        event: entry.event
      }))
    };
  }

  subscribe(listener: ContextInspectorListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    this.recentEvents = [];
    this.retrievedMemory = [];
    await this.memory.dispose();
  }

  private append(envelope: RuntimeEventEnvelope): void {
    this.recentEvents = [...this.recentEvents, envelope].slice(-this.maxEvents);
    this.updatedAt = envelope.timestamp;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
