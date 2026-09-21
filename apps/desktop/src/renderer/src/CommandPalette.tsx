import { useEffect, useMemo, useRef, useState } from "react";

export interface CommandItem {
  id: string;
  label: string;
  /** Secondary text on the right (group or shortcut). */
  hint?: string | undefined;
  run(): void;
}

/**
 * Ctrl+K command palette: fuzzy-filtered actions and navigation targets.
 * Arrow keys move the selection, Enter runs it, Escape closes.
 */
export function CommandPalette({
  items,
  onClose
}: {
  items: CommandItem[];
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Subsequence match: "stopag" finds "Stop agent".
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      let qi = 0;
      for (const ch of item.label.toLowerCase()) {
        if (ch === q[qi]) qi += 1;
        if (qi >= q.length) break;
      }
      return qi >= q.length;
    });
  }, [items, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelected((current) => (current + delta + filtered.length) % filtered.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[selected];
      if (!item) return;
      onClose();
      item.run();
    }
  }

  return (
    <div className="command-palette-backdrop" role="presentation" onClick={onClose}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command…"
          spellCheck={false}
        />
        <div className="command-palette-list">
          {filtered.length === 0 && (
            <p className="sidebar-note">No matching commands.</p>
          )}
          {filtered.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={
                "command-palette-row" + (index === selected ? " selected" : "")
              }
              onMouseEnter={() => setSelected(index)}
              onClick={() => {
                onClose();
                item.run();
              }}
            >
              <span className="command-palette-label">{item.label}</span>
              {item.hint && <span className="command-palette-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
