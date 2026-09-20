/**
 * Text-based tool call detection.
 *
 * Local models that lack native function calling often "imitate" a tool call by
 * emitting plain JSON in the assistant text, e.g.:
 *
 *   {"tool":"read","path":"C:\\Users\\me\\file.txt"}
 *   or  {"name":"bash","arguments":{"command":"ls"}}
 *
 * The Kripl Pi extension (kripl-text-tools.ts) uses this same algorithm to turn
 * such text into a real tool call so the agent loop executes it. The renderer
 * uses `cleanAssistantToolText` to replace the raw JSON blob in the chat with a
 * compact marker once the matching tool execution starts.
 */

export interface TextToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Start index of the JSON object in the source text. */
  spanStart: number;
  /** End index (exclusive) of the JSON object in the source text. */
  spanEnd: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Index of the closing brace for the object opened at `start`, or undefined. */
function balancedObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
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

function lenientParse(raw: string): Record<string, unknown> | undefined {
  const attempts = [raw, raw.replace(/,\s*([}\]])/g, "$1")];
  for (const candidate of attempts) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next variant.
    }
  }
  return undefined;
}

/**
 * Find the first text-based tool call in `text` whose name is one of
 * `activeTools` (compared case-insensitively). Returns undefined when the text
 * does not contain a recognizable, executable tool call.
 */
export function findTextToolCall(
  text: string,
  activeTools: ReadonlySet<string>
): TextToolCall | undefined {
  if (!text.trim() || activeTools.size === 0) return undefined;

  const marker = /\{\s*"(?:tool|name)"\s*:/gi;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    const end = balancedObjectEnd(text, match.index);
    if (end === undefined) continue;

    const record = lenientParse(text.slice(match.index, end + 1));
    if (!record) continue;

    let name: string | undefined;
    let args: Record<string, unknown>;
    if (typeof record.tool === "string") {
      name = record.tool.trim();
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key !== "tool") copy[key] = value;
      }
      args = copy;
    } else if (typeof record.name === "string" && isRecord(record.arguments)) {
      name = record.name.trim();
      args = record.arguments as Record<string, unknown>;
    } else {
      continue;
    }

    if (!name || !activeTools.has(name.toLowerCase())) continue;
    return { name, args, spanStart: match.index, spanEnd: end + 1 };
  }
  return undefined;
}

/** Compact one-line marker such as `⚙ read(path=C:\a.txt)`. */
export function describeTextToolCall(call: TextToolCall): string {
  const parts = Object.entries(call.args)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `⚙ ${call.name}${parts.length > 0 ? `(${parts.join(" ")})` : ""}`;
}

/**
 * Replace the JSON span of a recognized tool call with a compact marker so the
 * chat does not show raw model output. Returns the input unchanged when no
 * matching call is present (e.g. the stream was still incomplete).
 */
export function cleanAssistantToolText(
  text: string,
  activeTools: ReadonlySet<string>
): string {
  const call = findTextToolCall(text, activeTools);
  if (!call) return text;

  const before = text.slice(0, call.spanStart).replace(/\s+$/, "");
  const after = text.slice(call.spanEnd).replace(/^\s+/, "");
  const marker = describeTextToolCall(call);
  const cleaned = [before, marker, after].filter(Boolean).join("\n");
  return cleaned.trim();
}
