import type { AgentEvent } from "@kripl/core";

type RoutedEvent = AgentEvent & { agentId?: number };
type Delta = Extract<RoutedEvent, { type: "agent.stream"; phase: "delta" }>;
type ToolUpdate = Extract<RoutedEvent, { type: "agent.tool" }>;

/**
 * Adjacent token deltas become one UI update per frame. Control events flush
 * preceding text synchronously, so a final status, permission, or tool call
 * never overtakes the last tokens. No events or final content are discarded.
 * The scheduler is injected so ordering and cancellation can be tested.
 */
export function createAgentEventBuffer(
  deliver: (event: RoutedEvent) => void,
  schedule: (flush: () => void) => number,
  cancel: (handle: number) => void
) {
  let pending: Delta | ToolUpdate | null = null;
  let chunks: string[] = [];
  let scheduled: number | null = null;

  function clearSchedule(): void {
    if (scheduled !== null) cancel(scheduled);
    scheduled = null;
  }

  function flush(): void {
    clearSchedule();
    const event = pending;
    const text = chunks;
    pending = null;
    chunks = [];
    if (event) deliver(event.type === "agent.stream" ? { ...event, delta: text.join("") } : event);
  }

  return {
    push(event: RoutedEvent): void {
      // Pi tool updates contain the latest partial result, not a text delta.
      // Keep the newest preview per frame while preserving lifecycle order.
      if (event.type === "agent.tool" && event.phase === "updated") {
        if (pending && (pending.type !== "agent.tool" || pending.callId !== event.callId || pending.agentId !== event.agentId)) {
          flush();
        }
        pending = event;
        scheduled ??= schedule(flush);
        return;
      }
      if (event.type !== "agent.stream" || event.phase !== "delta") {
        flush();
        deliver(event);
        return;
      }
      if (pending && (pending.type !== "agent.stream" || pending.channel !== event.channel ||
        pending.contentIndex !== event.contentIndex || pending.agentId !== event.agentId)) {
        flush();
      }
      pending ??= event;
      chunks.push(event.delta);
      scheduled ??= schedule(flush);
    },
    flush,
    clear(): void {
      clearSchedule();
      pending = null;
      chunks = [];
    }
  };
}
