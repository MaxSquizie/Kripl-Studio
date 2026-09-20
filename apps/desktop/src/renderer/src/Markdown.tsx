import type { ReactNode } from "react";
import { useState } from "react";

/**
 * Lightweight dependency-free markdown renderer for chat messages.
 * Supports: fenced code blocks, inline code, bold, italic, strikethrough,
 * links, headings (h1-h3), unordered/ordered lists, blockquotes and hr.
 */

const INLINE_RE =
  /(\*\*[^*\n]+\*\*)|(`+[^`\n]+`+)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function renderInline(text: string, depth = 0): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  INLINE_RE.lastIndex = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const token = match[0]!;
    const k = `i${key++}`;
    if (match[1]) {
      nodes.push(
        <strong key={k}>
          {depth < 2 ? renderInline(token.slice(2, -2), depth + 1) : token.slice(2, -2)}
        </strong>,
      );
    } else if (match[2]) {
      // Strip exactly the opening run of backticks (and the matching closing
      // run) so ``double`` and `/* comment */` spans keep their content.
      const lead = /^`+/.exec(token)?.[0].length ?? 1;
      const trail = /`+$/.exec(token)?.[0].length ?? 1;
      const strip = Math.min(lead, trail);
      nodes.push(<code key={k}>{token.slice(lead, token.length - strip)}</code>);
    } else if (match[3]) {
      nodes.push(<del key={k}>{token.slice(2, -2)}</del>);
    } else if (match[4]) {
      nodes.push(<em key={k}>{token.slice(1, -1)}</em>);
    } else if (match[5]) {
      const m = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(token);
      const label = m?.[1];
      const url = m?.[2];
      if (label && url && isSafeUrl(url)) {
        nodes.push(
          <a key={k} href={url} target="_blank" rel="noreferrer">
            {label}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Small copy-to-clipboard button with a brief “copied” confirmation. */
export function CopyIconButton({ text, title }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // clipboard unavailable (e.g. non-secure context) — stay silent
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
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
}

/** Fenced code block with a hover-revealed copy button. */
function CodeBlock({ lang, code }: { lang?: string | undefined; code: string }) {
  return (
    <div className="code-block">
      <pre>{lang ? <code className="lang">{code}</code> : <code>{code}</code>}</pre>
      <CopyIconButton text={code} title="Скопировать код" />
    </div>
  );
}

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
    /^\s*(-{3,}|\*{3,})\s*$/.test(line)
  );
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
      const content = renderInline(heading[2] ?? "");
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
              <li key={n}>{renderInline(item)}</li>
            ))}
          </ul>
        ) : (
          <ol key={`b${key++}`}>
            {items.map((item, n) => (
              <li key={n}>{renderInline(item)}</li>
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
          <p>{renderInline(quoted.join("\n"))}</p>
        </blockquote>,
      );
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Paragraph: consecutive non-blank, non-special lines.
    const para: string[] = [];
    for (;;) {
      const next = lines[i];
      if (next === undefined || next.trim() === "" || isBlockStart(next)) break;
      para.push(next);
      i += 1;
    }
    blocks.push(<p key={`b${key++}`}>{renderInline(para.join("\n"))}</p>);
  }

  return blocks;
}

export function Markdown({ text }: { text: string }) {
  if (!text.trim()) return null;
  return <div className="markdown">{renderBlocks(text)}</div>;
}
