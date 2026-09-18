import type { AgentSessionMessage } from "@kripl/core";

type JsonRecord = Record<string, unknown>;

const MAX_MESSAGE_TEXT = 20_000;
const MAX_MESSAGES = 500;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateText(value: string): string {
  return value.length <= MAX_MESSAGE_TEXT ? value : value.slice(0, MAX_MESSAGE_TEXT) + "\n…";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return truncateText(content);
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return truncateText(parts.join("\n"));
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizePiSessionMessages(messages: unknown): AgentSessionMessage[] {
  if (!Array.isArray(messages)) return [];

  const normalized: AgentSessionMessage[] = [];

  for (const value of messages) {
    if (!isRecord(value) || typeof value.role !== "string") continue;
    const timestamp = finiteTimestamp(value.timestamp);

    if (value.role === "user") {
      const text = textFromContent(value.content);
      if (text) {
        normalized.push({
          role: "user",
          text,
          ...(timestamp === undefined ? {} : { timestamp })
        });
      }
      continue;
    }

    if (value.role === "assistant") {
      const text = textFromContent(value.content);
      if (text) {
        normalized.push({
          role: "assistant",
          text,
          ...(timestamp === undefined ? {} : { timestamp })
        });
      }
      continue;
    }

    if (value.role === "toolResult") {
      const text = textFromContent(value.content);
      if (!text) continue;
      normalized.push({
        role: "tool",
        text,
        ...(typeof value.toolName === "string" ? { toolName: value.toolName } : {}),
        ...(value.isError === true ? { isError: true } : {}),
        ...(timestamp === undefined ? {} : { timestamp })
      });
      continue;
    }

    if (value.role === "bashExecution") {
      const command = typeof value.command === "string" ? value.command : "";
      const output = typeof value.output === "string" ? value.output : "";
      const text = [command ? "$ " + command : "", output].filter(Boolean).join("\n");
      if (!text) continue;
      normalized.push({
        role: "tool",
        text,
        toolName: "bash",
        ...(typeof value.exitCode === "number" && value.exitCode !== 0 ? { isError: true } : {}),
        ...(timestamp === undefined ? {} : { timestamp })
      });
      continue;
    }

    if (value.role === "branchSummary" || value.role === "compactionSummary") {
      const summary = typeof value.summary === "string" ? value.summary : "";
      if (!summary) continue;
      normalized.push({
        role: "system",
        text: summary,
        ...(timestamp === undefined ? {} : { timestamp })
      });
      continue;
    }

    if (value.role === "custom" && value.display === true) {
      const text = textFromContent(value.content);
      if (!text) continue;
      normalized.push({
        role: "system",
        text,
        ...(timestamp === undefined ? {} : { timestamp })
      });
    }
  }

  return normalized.slice(-MAX_MESSAGES);
}
