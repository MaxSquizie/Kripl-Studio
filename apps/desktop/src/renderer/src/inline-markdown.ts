export type InlineToken =
  | { kind: "text" | "strong" | "em" | "del" | "code"; text: string }
  | { kind: "link"; text: string; href: string };

/**
 * The chat's deliberately small inline grammar. Scan delimiter runs instead
 * of retrying an unanchored expression at every character: a streamed, still
 * unclosed label (`[[[[...`) or backtick run otherwise takes quadratic time.
 *
 * Searches only move forwards. In particular, opening brackets share the next
 * closing bracket / URL boundary, even when the prospective link is invalid.
 * There is no global text cache: closing a session can release its messages.
 */
export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const markers = /\*+|`+|~+|\[+/g;
  const urlBoundaries = /[\s)]/g;
  let lineEnd = text.indexOf("\n");
  if (lineEnd < 0) lineEnd = text.length;
  let nextBracket = -1;
  let nextUrlBoundary = -1;
  let consumed = 0;

  for (let marker = markers.exec(text); marker; marker = markers.exec(text)) {
    const start = marker.index;
    const runEnd = markers.lastIndex;
    if (start > lineEnd) {
      lineEnd = text.indexOf("\n", start);
      if (lineEnd < 0) lineEnd = text.length;
    }

    const delimiter = marker[0][0];
    let token: InlineToken;
    let tokenStart = start;
    let tokenEnd: number;

    if (delimiter === "[") {
      const labelStart = start + 1;
      if (nextBracket < runEnd) {
        nextBracket = text.indexOf("]", runEnd);
        if (nextBracket < 0) nextBracket = text.length;
      }
      if (nextBracket <= labelStart || nextBracket >= lineEnd || text[nextBracket + 1] !== "(") continue;

      const urlStart = nextBracket + 2;
      if (nextUrlBoundary < urlStart) {
        urlBoundaries.lastIndex = urlStart;
        nextUrlBoundary = urlBoundaries.exec(text)?.index ?? text.length;
      }
      if (nextUrlBoundary === urlStart || text[nextUrlBoundary] !== ")") continue;

      tokenEnd = nextUrlBoundary + 1;
      const href = text.slice(urlStart, nextUrlBoundary);
      token = /^https?:\/\//i.test(href)
        ? { kind: "link", text: text.slice(labelStart, nextBracket), href }
        : { kind: "text", text: text.slice(start, tokenEnd) };
    } else {
      if (delimiter !== "*" && delimiter !== "`" && delimiter !== "~") continue;
      const runLength = runEnd - start;
      if (delimiter === "~" && runLength < 2) continue;
      const close = text.indexOf(delimiter, runEnd);
      if (close < 0 || close >= lineEnd) continue;

      if (delimiter === "`") {
        let closeEnd = close + 1;
        while (text[closeEnd] === "`") closeEnd += 1;
        // Keep the existing renderer's handling of unequal backtick runs.
        const strip = Math.min(runLength, closeEnd - close);
        token = { kind: "code", text: text.slice(runEnd, closeEnd - strip) };
        tokenEnd = closeEnd;
      } else {
        const width = runLength >= 2 && text[close + 1] === delimiter ? 2 : 1;
        if (delimiter === "~" && width < 2) continue;
        tokenStart = runEnd - width;
        tokenEnd = close + width;
        token = {
          kind: delimiter === "~" ? "del" : width === 2 ? "strong" : "em",
          text: text.slice(runEnd, close)
        };
      }
    }

    if (tokenStart > consumed) tokens.push({ kind: "text", text: text.slice(consumed, tokenStart) });
    tokens.push(token);
    consumed = tokenEnd;
    markers.lastIndex = tokenEnd;
  }

  if (consumed < text.length) tokens.push({ kind: "text", text: text.slice(consumed) });
  return tokens;
}
