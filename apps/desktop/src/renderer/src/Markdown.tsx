import type { ReactNode } from "react";
import { memo, useEffect, useRef, useState } from "react";
import { tokenizeInline } from "./inline-markdown";

/**
 * Lightweight dependency-free markdown renderer for chat messages.
 * Supports: fenced code blocks, inline code, bold, italic, strikethrough,
 * links, headings (h1-h3), unordered/ordered lists, blockquotes, hr and
 * GFM pipe tables.
 */

function renderInline(text: string, depth = 0): ReactNode[] {
  return tokenizeInline(text).map((token, key) => {
    switch (token.kind) {
      case "text": return token.text;
      case "strong": return <strong key={key}>{depth < 2 ? renderInline(token.text, depth + 1) : token.text}</strong>;
      case "code": return <code key={key}>{token.text}</code>;
      case "del": return <del key={key}>{token.text}</del>;
      case "em": return <em key={key}>{token.text}</em>;
      case "link": return <a key={key} href={token.href} target="_blank" rel="noreferrer">{token.text}</a>;
    }
  });
}

// A growing answer still revisits its block boundaries, but completed inline
// blocks do not need tokenizing / rebuilding on each streamed update.
const InlineMarkdown = memo(function InlineMarkdown({ text }: { text: string }) {
  return renderInline(text);
});

/** Small copy-to-clipboard button with a brief “copied” confirmation. */
export const CopyIconButton = memo(function CopyIconButton({ text, title }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timeoutRef.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // clipboard unavailable (e.g. non-secure context) — stay silent
    }
    if (!mountedRef.current) return;
    setCopied(true);
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = undefined;
      setCopied(false);
    }, 1500);
  }

  return (
    <button
      type="button"
      className={"copy-icon-button" + (copied ? " copied" : "")}
      title={copied ? "Скопировано" : (title ?? "Скопировать")}
      onClick={() => void copy()}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 6.5l2.5 2.5L9.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <rect x="3.5" y="3.5" width="6" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8.5 3V2a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1H3" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
    </button>
  );
});

/** Fenced code block with a hover-revealed copy button. */
const CodeBlock = memo(function CodeBlock({ lang, code }: { lang?: string | undefined; code: string }) {
  return (
    <div className="code-block">
      <pre>{lang ? <code className="lang">{code}</code> : <code>{code}</code>}</pre>
      <CopyIconButton text={code} title="Скопировать код" />
    </div>
  );
});

function isListMarker(line: string): "ul" | "ol" | null {
  if (/^\s*[-*]\s+/.test(line)) return "ul";
  if (/^\s*\d+[.)]\s+/.test(line)) return "ol";
  return null;
}

function isBlockStart(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,3}\s/.test(line) ||
    isListMarker(line) !== null ||
    /^\s*>\s?/.test(line) ||
    /^\s*(-{3,}|\*{3,})\s*$/.test(line) ||
    /^\s*\|/.test(line)
  );
}

function isTableRow(line: string | undefined): line is string {
  return line !== undefined && line.trim() !== "" && line.includes("|");
}

// The row under a header: | --- | :---: | ... |
function isTableSeparator(line: string | undefined): boolean {
  if (line === undefined) return false;
  const trimmed = line.trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 1 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;

    // Fenced code block (an unclosed fence at end of stream is treated as open,
    // which keeps streaming messages readable).
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      for (;;) {
        const next = lines[i];
        if (next === undefined || /^```\s*$/.test(next)) break;
        body.push(next);
        i += 1;
      }
      i += 1; // skip closing fence if present
      blocks.push(
        <CodeBlock key={`b${key++}`} lang={fence[1] || undefined} code={body.join("\n")} />
      );
      continue;
    }

    // Headings.
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const content = <InlineMarkdown text={heading[2] ?? ""} />;
      blocks.push(
        level === 1 ? (
          <h1 key={`b${key++}`}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={`b${key++}`}>{content}</h2>
        ) : (
          <h3 key={`b${key++}`}>{content}</h3>
        ),
      );
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} />);
      i += 1;
      continue;
    }

    // Lists (consecutive items of the same kind).
    const marker = isListMarker(line);
    if (marker) {
      const items: string[] = [];
      for (;;) {
        const next = lines[i];
        if (next === undefined || isListMarker(next) !== marker) break;
        items.push(next.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""));
        i += 1;
      }
      blocks.push(
        marker === "ul" ? (
          <ul key={`b${key++}`}>
            {items.map((item, n) => (
              <li key={n}><InlineMarkdown text={item} /></li>
            ))}
          </ul>
        ) : (
          <ol key={`b${key++}`}>
            {items.map((item, n) => (
              <li key={n}><InlineMarkdown text={item} /></li>
            ))}
          </ol>
        ),
      );
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      for (;;) {
        const next = lines[i];
        if (next === undefined || !/^\s*>\s?/.test(next)) break;
        quoted.push(next.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote key={`b${key++}`}>
          <p><InlineMarkdown text={quoted.join("\n")} /></p>
        </blockquote>,
      );
      continue;
    }

    // GFM pipe table: header row followed by a separator row.
    if (isTableRow(line) && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2; // skip header and separator
      const rows: string[][] = [];
      for (;;) {
        const next = lines[i];
        if (!isTableRow(next)) break;
        rows.push(splitTableRow(next));
        i += 1;
      }
      blocks.push(
        <div key={`b${key++}`} className="table-wrap">
          <table>
            <thead>
              <tr>
                {header.map((cell, n) => (
                  <th key={n}><InlineMarkdown text={cell} /></th>
                ))}
              </tr>
            </thead>
            {rows.length > 0 ? (
              <tbody>
                {rows.map((row, r) => (
                  <tr key={r}>
                    {header.map((_cell, c) => (
                      <td key={c}><InlineMarkdown text={row[c] ?? ""} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ) : null}
          </table>
        </div>
      );
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Paragraph: consecutive non-blank, non-special lines.
    // A line that looks like a block start but was not handled above (e.g. a
    // lone "|" tree-drawing line) must still be consumed here, otherwise the
    // loop would re-read it forever and hang the renderer.
    const para: string[] = [];
    for (;;) {
      const next = lines[i];
      if (next === undefined || next.trim() === "" || (para.length > 0 && isBlockStart(next))) break;
      para.push(next);
      i += 1;
    }
    blocks.push(<p key={`b${key++}`}><InlineMarkdown text={para.join("\n")} /></p>);
  }

  return blocks;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  if (!text.trim()) return null;
  return <div className="markdown">{renderBlocks(text)}</div>;
});
