import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Text-based tool call bridge for local models without native function calling.
 *
 * Some OpenAI-compatible local servers (e.g. LM Studio with a non-tool-tuned
 * model) ignore the `tools` parameter, and the model then "imitates" a tool
 * call by emitting plain JSON in its text:
 *
 *   {"tool":"read","path":"C:\\Users\\me\\file.txt"}
 *
 * This extension watches finalized assistant messages; when the text contains
 * such a JSON object for an active tool, it rewrites the message so the agent
 * loop executes the call natively (permission gate included). The raw JSON is
 * replaced with a compact marker in the transcript.
 *
 * NOTE: the parsing helpers below are a self-contained copy of
 * `@kripl/core` text-tool-call.ts — extensions run inside the Pi process and
 * cannot import Kripl packages. Keep both copies in sync.
 */
const EXTENSION_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function balancedObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function lenientParse(raw: string): JsonRecord | undefined {
  const attempts = [raw, raw.replace(/,\\s*([}\\]])/g, "$1")];
  for (const candidate of attempts) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {}
  }
  return undefined;
}

interface TextToolCall {
  name: string;
  args: JsonRecord;
  spanStart: number;
  spanEnd: number;
}

function findTextToolCall(text: string, activeTools: Set<string>): TextToolCall | undefined {
  if (!text.trim() || activeTools.size === 0) return undefined;
  const marker = /\\{\\s*"(?:tool|name)"\\s*:/gi;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    const end = balancedObjectEnd(text, match.index);
    if (end === undefined) continue;
    const record = lenientParse(text.slice(match.index, end + 1));
    if (!record) continue;

    let name: string | undefined;
    let args: JsonRecord;
    if (typeof record.tool === "string") {
      name = record.tool.trim();
      const copy: JsonRecord = {};
      for (const [key, value] of Object.entries(record)) {
        if (key !== "tool") copy[key] = value;
      }
      args = copy;
    } else if (typeof record.name === "string" && isRecord(record.arguments)) {
      name = record.name.trim();
      args = record.arguments as JsonRecord;
    } else {
      continue;
    }

    if (!name || !activeTools.has(name.toLowerCase())) continue;
    return { name, args, spanStart: match.index, spanEnd: end + 1 };
  }
  return undefined;
}

function describeTextToolCall(call: TextToolCall): string {
  const parts = Object.entries(call.args)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => \`\${key}=\${JSON.stringify(value)}\`);
  return \`\\u2699 \${call.name}\${parts.length > 0 ? \`(\${parts.join(" ")})\` : ""}\`;
}

export default function (pi: ExtensionAPI) {
  // Safety valve: never let a chatty model loop the bridge forever.
  let conversions = 0;
  const MAX_CONVERSIONS = 12;

  pi.on("message_end", (event) => {
    try {
      if (conversions >= MAX_CONVERSIONS) return undefined;
      const message = event.message as unknown as Record<string, any> | undefined;
      if (!message || message.role !== "assistant") return undefined;

      let content: any[];
      if (Array.isArray(message.content)) {
        content = [...message.content];
      } else if (typeof message.content === "string") {
        content = [{ type: "text", text: message.content }];
      } else {
        return undefined;
      }

      // Native tool calls already present — nothing to repair.
      if (content.some((block) => isRecord(block) && block.type === "toolCall")) return undefined;

      const fullText = content
        .filter((block) => isRecord(block) && block.type === "text")
        .map((block) => String(block.text ?? ""))
        .join("\\n");
      if (!fullText.trim()) return undefined;

      let activeTools: string[] = [];
      try {
        activeTools = pi.getActiveTools();
      } catch {}
      const active = new Set(activeTools.map((tool) => tool.toLowerCase()));
      const call = findTextToolCall(fullText, active);
      if (!call) return undefined;

      conversions++;
      const before = fullText.slice(0, call.spanStart).replace(/\\s+$/, "");
      const after = fullText.slice(call.spanEnd).replace(/^\\s+/, "");
      const cleaned = [before, describeTextToolCall(call), after].filter(Boolean).join("\\n").trim();

      const toolCallBlock = {
        type: "toolCall",
        id: \`kripl-text-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`,
        name: call.name,
        arguments: call.args
      };
      const nextContent = cleaned ? [{ type: "text", text: cleaned }, toolCallBlock] : [toolCallBlock];

      return { message: { ...message, content: nextContent } };
    } catch {
      return undefined;
    }
  });
}
`;

export async function writePiTextToolBridge(agentDir: string): Promise<void> {
  const extensionsDir = join(agentDir, "extensions");
  await mkdir(extensionsDir, { recursive: true });
  await writeFile(join(extensionsDir, "kripl-text-tools.ts"), EXTENSION_SOURCE, {
    encoding: "utf8",
    mode: 0o600
  });
}
