/** A display preview, never a replacement for the tool result kept by Pi. */
export function toolPayloadPreview(payload: unknown, limit = 1800): string {
  if (payload === undefined) return "";
  const budget = Number.isFinite(limit) ? Math.max(0, Math.min(20_000, Math.floor(limit))) : 1800;
  const parts: string[] = [];
  const ancestors = new WeakSet<object>();
  let length = 0;
  let truncated = false;
  let visited = 0;

  function append(text: string): void {
    if (truncated) return;
    const remaining = budget - length;
    if (text.length <= remaining) {
      parts.push(text);
      length += text.length;
    } else {
      if (remaining > 0) parts.push(text.slice(0, remaining));
      length = budget;
      truncated = true;
    }
  }

  // Escape only the prefix that can be displayed, not a multi-megabyte string.
  function quote(text: string): void {
    append('"');
    for (let index = 0; index < text.length && !truncated; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 34) append('\\"');
      else if (code === 92) append("\\\\");
      else if (code === 8) append("\\b");
      else if (code === 9) append("\\t");
      else if (code === 10) append("\\n");
      else if (code === 12) append("\\f");
      else if (code === 13) append("\\r");
      else if (code >= 0xd800 && code <= 0xdbff &&
        text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        append(text.slice(index, index + 2));
        index += 1;
      } else if (code < 32 || (code >= 0xd800 && code <= 0xdfff)) {
        append("\\u" + code.toString(16).padStart(4, "0"));
      } else append(text[index]!);
    }
    append('"');
  }

  function omitted(value: unknown): boolean {
    return value === undefined || typeof value === "function" || typeof value === "symbol";
  }

  function property(object: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return undefined;
    // IPC tool results are plain data; inspecting an arbitrary object must
    // not execute its getters or custom toJSON methods.
    return "value" in descriptor ? descriptor.value : "[Getter]";
  }

  function nextProperty(): boolean {
    // Also bound objects containing thousands of omitted/undefined fields.
    if (++visited <= Math.max(64, budget * 2)) return true;
    truncated = true;
    return false;
  }

  function write(value: unknown, depth: number): void {
    if (truncated) return;
    if (value === null) { append("null"); return; }
    switch (typeof value) {
      case "string": quote(value); return;
      case "number": append(Number.isFinite(value) ? String(value) : "null"); return;
      case "boolean": append(String(value)); return;
      case "undefined": append("null"); return;
      case "bigint": quote("[BigInt]"); return;
      case "function": quote("[Function]"); return;
      case "symbol": quote("[Symbol]"); return;
    }

    if (value instanceof Date) {
      const time = Date.prototype.getTime.call(value);
      if (Number.isFinite(time)) quote(Date.prototype.toISOString.call(value));
      else append("null");
      return;
    }
    if (ancestors.has(value)) { quote("[Circular]"); return; }
    ancestors.add(value);
    const indent = "  ".repeat(depth + 1);
    let count = 0;

    if (Array.isArray(value)) {
      append("[");
      for (let index = 0; index < value.length && !truncated; index += 1) {
        if (!nextProperty()) break;
        append((count++ ? ",\n" : "\n") + indent);
        if (!truncated) {
          const item = property(value, String(index));
          write(omitted(item) ? null : item, depth + 1);
        }
      }
      if (count) append("\n" + "  ".repeat(depth));
      append("]");
    } else {
      append("{");
      for (const key in value) {
        if (truncated) break;
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (!nextProperty()) break;
        const item = property(value, key);
        if (omitted(item)) continue;
        append((count++ ? ",\n" : "\n") + indent);
        quote(key);
        append(": ");
        write(item, depth + 1);
        if (truncated) break;
      }
      if (count) append("\n" + "  ".repeat(depth));
      append("}");
    }
    ancestors.delete(value);
  }

  try {
    write(payload, 0);
  } catch {
    // Proxies and other non-JSON values may refuse property inspection.
    append("[Unavailable]");
  }
  return parts.join("") + (truncated ? "\n…" : "");
}
