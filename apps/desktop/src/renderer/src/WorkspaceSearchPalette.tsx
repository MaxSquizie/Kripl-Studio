import type { WorkspaceFileSearchResult, WorkspaceTextSearchResult } from "@kripl/core";
import { useEffect, useMemo, useRef, useState } from "react";

export type WorkspaceSearchMode = "files" | "text";

export function WorkspaceSearchPalette({
  mode,
  onModeChange,
  onClose,
  onOpenFile
}: {
  mode: WorkspaceSearchMode;
  onModeChange(mode: WorkspaceSearchMode): void;
  onClose(): void;
  onOpenFile(path: string): Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [fileResults, setFileResults] = useState<WorkspaceFileSearchResult[]>([]);
  const [textResults, setTextResults] = useState<WorkspaceTextSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const resultCount = mode === "files" ? fileResults.length : textResults.length;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [mode]);

  useEffect(() => {
    setSelectedIndex(0);
    setError("");
  }, [mode, query]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setFileResults([]);
      setTextResults([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const request: Promise<WorkspaceFileSearchResult[] | WorkspaceTextSearchResult[]> =
        mode === "files"
          ? window.kripl.searchWorkspaceFiles(normalized, 80)
          : window.kripl.searchWorkspaceText(normalized, 120);

      void request
        .then((results) => {
          if (cancelled) return;
          if (mode === "files") {
            setFileResults(results as WorkspaceFileSearchResult[]);
            setTextResults([]);
          } else {
            setTextResults(results as WorkspaceTextSearchResult[]);
            setFileResults([]);
          }
          setError("");
        })
        .catch((reason) => {
          if (cancelled) return;
          setError(reason instanceof Error ? reason.message : String(reason));
          setFileResults([]);
          setTextResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 140);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, query]);

  useEffect(() => {
    if (resultCount === 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((current) => Math.min(current, resultCount - 1));
  }, [resultCount]);

  const selectedPath = useMemo(() => {
    if (mode === "files") return fileResults[selectedIndex]?.path;
    return textResults[selectedIndex]?.path;
  }, [fileResults, mode, selectedIndex, textResults]);

  async function openSelected(path = selectedPath) {
    if (!path) return;
    await onOpenFile(path);
    onClose();
  }

  return (
    <div
      className="search-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="search-palette"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "files" ? "Quick open file" : "Search project text"}
      >
        <div className="search-palette-modes">
          <button
            className={mode === "files" ? "active" : ""}
            type="button"
            onClick={() => onModeChange("files")}
          >
            Quick Open <kbd>Ctrl P</kbd>
          </button>
          <button
            className={mode === "text" ? "active" : ""}
            type="button"
            onClick={() => onModeChange("text")}
          >
            Search <kbd>Ctrl Shift F</kbd>
          </button>
        </div>

        <div className="search-palette-input-row">
          <span className="search-palette-icon">{mode === "files" ? "›" : "⌕"}</span>
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            placeholder={mode === "files" ? "Type a file name or path…" : "Search text in project…"}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((current) =>
                  resultCount === 0 ? 0 : (current + 1) % resultCount
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((current) =>
                  resultCount === 0 ? 0 : (current - 1 + resultCount) % resultCount
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void openSelected();
              }
            }}
          />
          {loading && <span className="search-palette-loading">searching</span>}
        </div>

        <div className="search-palette-results">
          {!query.trim() && (
            <div className="search-palette-empty">
              {mode === "files"
                ? "Fuzzy-match a file anywhere in the workspace."
                : "Case-insensitive text search across local project files."}
            </div>
          )}
          {query.trim() && !loading && !error && resultCount === 0 && (
            <div className="search-palette-empty">No matches.</div>
          )}
          {error && <div className="search-palette-error">{error}</div>}

          {mode === "files" &&
            fileResults.map((result, index) => (
              <button
                className={"search-result file-result" + (index === selectedIndex ? " selected" : "")}
                type="button"
                key={result.path}
                title={result.path}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => void openSelected(result.path)}
              >
                <span className="search-result-badge">F</span>
                <span className="search-result-main">
                  <strong>{result.name}</strong>
                  <small>{result.path}</small>
                </span>
              </button>
            ))}

          {mode === "text" &&
            textResults.map((result, index) => (
              <button
                className={"search-result text-result" + (index === selectedIndex ? " selected" : "")}
                type="button"
                key={result.path + ":" + result.line + ":" + result.column + ":" + index}
                title={result.path}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => void openSelected(result.path)}
              >
                <span className="search-result-location">{result.line}:{result.column}</span>
                <span className="search-result-main">
                  <strong>{result.path}</strong>
                  <small>{result.preview || " "}</small>
                </span>
              </button>
            ))}
        </div>

        <footer className="search-palette-footer">
          <span>↑↓ navigate</span>
          <span>Enter open</span>
          <span>Esc close</span>
        </footer>
      </section>
    </div>
  );
}
