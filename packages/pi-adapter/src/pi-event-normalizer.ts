import type { AgentEvent } from "@kripl/core";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contentIndex(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizePiEvent(event: JsonRecord): AgentEvent[] {
  const type = typeof event.type === "string" ? event.type : "";

  switch (type) {
    case "agent_start":
      return [{ type: "agent.status", status: "running" }];

    case "agent_settled":
      return [{ type: "agent.status", status: "ready" }];

    case "turn_start":
      return [{ type: "agent.turn", phase: "started" }];

    case "turn_end":
      return [{ type: "agent.turn", phase: "completed" }];

    case "message_update": {
      if (!isRecord(event.assistantMessageEvent)) return [];
      const update = event.assistantMessageEvent;
      const updateType = typeof update.type === "string" ? update.type : "";
      const index = contentIndex(update.contentIndex);

      if (updateType === "text_start") {
        return [{ type: "agent.stream", channel: "text", phase: "started", contentIndex: index }];
      }
      if (updateType === "text_delta" && typeof update.delta === "string") {
        return [
          {
            type: "agent.stream",
            channel: "text",
            phase: "delta",
            contentIndex: index,
            delta: update.delta
          }
        ];
      }
      if (updateType === "text_end" && typeof update.content === "string") {
        return [
          {
            type: "agent.stream",
            channel: "text",
            phase: "completed",
            contentIndex: index,
            content: update.content
          }
        ];
      }
      if (updateType === "thinking_start") {
        return [{ type: "agent.stream", channel: "thinking", phase: "started", contentIndex: index }];
      }
      if (updateType === "thinking_delta" && typeof update.delta === "string") {
        return [
          {
            type: "agent.stream",
            channel: "thinking",
            phase: "delta",
            contentIndex: index,
            delta: update.delta
          }
        ];
      }
      if (updateType === "thinking_end" && typeof update.content === "string") {
        return [
          {
            type: "agent.stream",
            channel: "thinking",
            phase: "completed",
            contentIndex: index,
            content: update.content
          }
        ];
      }

      return [];
    }

    case "tool_execution_start":
      if (
        typeof event.toolCallId === "string" &&
        typeof event.toolName === "string"
      ) {
        return [
          {
            type: "agent.tool",
            phase: "started",
            callId: event.toolCallId,
            name: event.toolName,
            payload: event.args
          }
        ];
      }
      return [];

    case "tool_execution_update":
      if (
        typeof event.toolCallId === "string" &&
        typeof event.toolName === "string"
      ) {
        return [
          {
            type: "agent.tool",
            phase: "updated",
            callId: event.toolCallId,
            name: event.toolName,
            payload: event.partialResult
          }
        ];
      }
      return [];

    case "tool_execution_end":
      if (
        typeof event.toolCallId === "string" &&
        typeof event.toolName === "string"
      ) {
        return [
          {
            type: "agent.tool",
            phase: event.isError === true ? "failed" : "completed",
            callId: event.toolCallId,
            name: event.toolName,
            payload: event.result
          }
        ];
      }
      return [];

    default:
      return [];
  }
}
