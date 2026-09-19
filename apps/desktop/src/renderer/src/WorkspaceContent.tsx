import type { WorkspaceDiff, WorkspaceFilePreview } from "@kripl/core";
import { useEffect, useRef, useState } from "react";

export type WorkspaceView =
  | { type: "agent" }
  | { type: "file"; file: WorkspaceFilePreview }
  | { type: "diff"; diff: WorkspaceDiff };

export type WorkspaceDocumentView = Exclude<WorkspaceView, { type: "agent" }>;

export interface WorkspaceEditorRevealTarget {
  path: string;
  line: number;
  column: number;
  length: number;
  requestId: string;
}

export function activeWorkspacePath(view: WorkspaceView): string | undefined {
  if (view.type === "file") return view.file.path;
  if (view.type === "diff") return view.diff.path;
  return undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function offsetForLineColumn(text: string, line: number, column: number): number {
  const targetLine = Math.max(1, Math.trunc(line));
  const targetColumn = Math.max(1, Math.trunc(column));
  let currentLine = 1;
  let lineStart = 0;

  while (currentLine < targetLine && lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    if (newline < 0) return text.length;
    lineStart = newline + 1;
    currentLine += 1;
  }

  const newline = text.indexOf("\n", lineStart);
  let lineEnd = newline < 0 ? text.length : newline;
  if (lineEnd > lineStart && text[lineEnd - 1] === "\r") lineEnd -= 1;

  return Math.min(lineEnd, lineStart + targetColumn - 1);
}

function lineColumnForOffset(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(text.length, offset));
  let line = 1;
  let lineStart = 0;

  for (let index = 0; index < clamped; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }

  return { line, column: clamped - lineStart + 1 };
}

function lineCount(text: string): number {
  if (!text) return 1;
  let lines = 1;
  for (const character of text) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

function selectedLineRange(text: string, start: number, end: number): { start: number; end: number } {
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd < 0) lineEnd = text.length;
  if (end > start && end > 0 && text[end - 1] === "\n") {
    lineEnd = end - 1;
  }
  return { start: lineStart, end: lineEnd };
}

function DiffContent({ patch }: { patch: string }) {
  return (
    <pre className="code-view diff-view">
      {patch.split("\n").map((line, index) => {
        const kind =
          line.startsWith("+") && !line.startsWith("+++")
            ? "addition"
            : line.startsWith("-") && !line.startsWith("---")
              ? "deletion"
              : line.startsWith("@@")
                ? "hunk"
                : line.startsWith("diff ") || line.startsWith("[")
                  ? "header"
                  : "";
        return (
          <span className={kind ? "diff-line " + kind : "diff-line"} key={index}>
            {line || " "}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

function FileEditor({
  file,
  draft,
  revealTarget,
  onDraftChange,
  onSave
}: {
  file: WorkspaceFilePreview;
  draft: string;
  revealTarget: WorkspaceEditorRevealTarget | undefined;
  onDraftChange(path: string, content: string): void;
  onSave(path: string, content: string): Promise<void>;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const goToLineRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState("");

  const editable = !file.binary && !file.truncated;
  const dirty = editable && draft !== (file.content ?? "");

  useEffect(() => {
    if (!editable || !revealTarget || revealTarget.path !== file.path) return;
    const editor = editorRef.current;
    if (!editor) return;

    const start = offsetForLineColumn(draft, revealTarget.line, revealTarget.column);
    const end = Math.min(draft.length, start + Math.max(0, revealTarget.length));
    editor.focus();
    editor.setSelectionRange(start, end);
    setCursor(lineColumnForOffset(draft, start));

    const approximateLineHeight = 19;
    editor.scrollTop = Math.max(
      0,
      (revealTarget.line - 1) * approximateLineHeight - editor.clientHeight / 3
    );
  }, [editable, file.path, revealTarget?.requestId]);

  useEffect(() => {
    if (!goToLineOpen) return;
    goToLineRef.current?.focus();
    goToLineRef.current?.select();
  }, [goToLineOpen]);

  function updateCursorFromEditor() {
    const editor = editorRef.current;
    if (!editor) return;
    setCursor(lineColumnForOffset(draft, editor.selectionStart));
  }

  function openGoToLine() {
    setGoToLineValue(String(cursor.line));
    setGoToLineOpen(true);
  }

  function goToLine() {
    const requested = Number.parseInt(goToLineValue, 10);
    if (!Number.isFinite(requested)) return;
    const targetLine = Math.max(1, Math.min(lineCount(draft), requested));
    const offset = offsetForLineColumn(draft, targetLine, 1);
    const editor = editorRef.current;
    if (!editor) return;

    editor.focus();
    editor.setSelectionRange(offset, offset);
    setCursor({ line: targetLine, column: 1 });
    const approximateLineHeight = 19;
    editor.scrollTop = Math.max(
      0,
      (targetLine - 1) * approximateLineHeight - editor.clientHeight / 3
    );
    setGoToLineOpen(false);
  }

  function applyIndent(shift: boolean) {
    const editor = editorRef.current;
    if (!editor) return;

    const start = editor.selectionStart;
    const end = editor.selectionEnd;

    if (start === end && !shift) {
      const next = draft.slice(0, start) + "\t" + draft.slice(end);
      onDraftChange(file.path, next);
      window.requestAnimationFrame(() => {
        editor.focus();
        editor.setSelectionRange(start + 1, start + 1);
        setCursor(lineColumnForOffset(next, start + 1));
      });
      return;
    }

    const range = selectedLineRange(draft, start, end);
    const block = draft.slice(range.start, range.end);
    const lines = block.split("\n");
    const transformed: string[] = [];
    const removed: number[] = [];

    for (const line of lines) {
      if (!shift) {
        transformed.push("\t" + line);
        removed.push(-1);
        continue;
      }
      if (line.startsWith("\t")) {
        transformed.push(line.slice(1));
        removed.push(1);
      } else {
        const spaces = Math.min(2, line.match(/^ */)?.[0].length ?? 0);
        transformed.push(line.slice(spaces));
        removed.push(spaces);
      }
    }

    const replacement = transformed.join("\n");
    const next = draft.slice(0, range.start) + replacement + draft.slice(range.end);
    const firstAdjustment = shift ? -(removed[0] ?? 0) : 1;
    const totalDelta = replacement.length - block.length;
    const nextStart = Math.max(range.start, start + firstAdjustment);
    const nextEnd = Math.max(nextStart, end + totalDelta);

    onDraftChange(file.path, next);
    window.requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(nextStart, nextEnd);
      setCursor(lineColumnForOffset(next, nextStart));
    });
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(file.path, draft);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="file-metadata">
        <span>{formatBytes(file.size)}</span>
        {file.language && <span>{file.language}</span>}
        {file.truncated && <span>preview truncated</span>}
        {file.binary && <span>binary</span>}
        {dirty && <span className="dirty-indicator">modified</span>}
        {editable && (
          <button
            className="editor-position"
            type="button"
            title="Go to line (Ctrl+G)"
            onClick={openGoToLine}
          >
            Ln {cursor.line}, Col {cursor.column}
          </button>
        )}
        {editable && (
          <button
            className="secondary-button compact"
            type="button"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>

      {error && <div className="editor-error">{error}</div>}

      {editable && goToLineOpen && (
        <div className="go-to-line-bar">
          <span>Go to line</span>
          <input
            ref={goToLineRef}
            value={goToLineValue}
            inputMode="numeric"
            aria-label="Line number"
            onChange={(event) => setGoToLineValue(event.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goToLine();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setGoToLineOpen(false);
                editorRef.current?.focus();
              }
            }}
          />
          <span>of {lineCount(draft)}</span>
        </div>
      )}

      {file.binary ? (
        <div className="binary-preview">
          Binary files are not decoded or sent into the renderer as text.
        </div>
      ) : file.truncated ? (
        <>
          <div className="binary-preview">
            This file is larger than the editor safety limit. The preview is read-only.
          </div>
          <pre className="code-view">{file.content ?? ""}</pre>
        </>
      ) : (
        <textarea
          ref={editorRef}
          className="code-editor"
          value={draft}
          spellCheck={false}
          onChange={(event) => {
            onDraftChange(file.path, event.target.value);
            const caret = event.target.selectionStart;
            setCursor(lineColumnForOffset(event.target.value, caret));
          }}
          onSelect={updateCursorFromEditor}
          onKeyUp={updateCursorFromEditor}
          onClick={updateCursorFromEditor}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save();
              return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
              event.preventDefault();
              openGoToLine();
              return;
            }
            if (event.key === "Tab") {
              event.preventDefault();
              applyIndent(event.shiftKey);
            }
          }}
        />
      )}
    </>
  );
}

function DiffReview({
  diff,
  onStage,
  onUnstage,
  onRevert
}: {
  diff: WorkspaceDiff;
  onStage(path: string): Promise<void>;
  onUnstage(path: string): Promise<void>;
  onRevert(path: string): Promise<void>;
}) {
  const [pending, setPending] = useState<"stage" | "unstage" | "revert" | null>(null);
  const [error, setError] = useState("");

  async function run(
    action: "stage" | "unstage" | "revert",
    callback: (path: string) => Promise<void>
  ) {
    if (pending) return;

    if (action === "revert") {
      const destructive =
        diff.status === "untracked"
          ? "This will permanently delete the untracked file."
          : "This will discard the selected file's Git changes.";
      if (!window.confirm(destructive + "\n\n" + diff.path)) return;
    }

    setPending(action);
    setError("");
    try {
      await callback(diff.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <div className="file-metadata diff-toolbar">
        <div className="diff-metadata">
          <span>{diff.status}</span>
          {diff.staged && <span>staged</span>}
          {diff.unstaged && <span>unstaged</span>}
          {diff.truncated && <span>diff truncated</span>}
        </div>
        <div className="review-actions">
          {diff.unstaged && (
            <button
              className="secondary-button compact"
              type="button"
              disabled={pending !== null}
              onClick={() => void run("stage", onStage)}
            >
              {pending === "stage" ? "Staging…" : "Stage"}
            </button>
          )}
          {diff.staged && (
            <button
              className="secondary-button compact"
              type="button"
              disabled={pending !== null}
              onClick={() => void run("unstage", onUnstage)}
            >
              {pending === "unstage" ? "Unstaging…" : "Unstage"}
            </button>
          )}
          <button
            className="danger-button compact"
            type="button"
            disabled={pending !== null}
            onClick={() => void run("revert", onRevert)}
          >
            {pending === "revert" ? "Reverting…" : "Revert"}
          </button>
        </div>
      </div>

      {error && <div className="editor-error">{error}</div>}
      <DiffContent patch={diff.patch} />
    </>
  );
}

export function WorkspaceContent({
  view,
  draft,
  revealTarget,
  onDraftChange,
  onSaveFile,
  onStage,
  onUnstage,
  onRevert
}: {
  view: WorkspaceDocumentView;
  draft: string | undefined;
  revealTarget: WorkspaceEditorRevealTarget | undefined;
  onDraftChange(path: string, content: string): void;
  onSaveFile(path: string, content: string): Promise<void>;
  onStage(path: string): Promise<void>;
  onUnstage(path: string): Promise<void>;
  onRevert(path: string): Promise<void>;
}) {
  const path = view.type === "file" ? view.file.path : view.diff.path;

  return (
    <>
      <div className="agent-header workspace-view-header">
        <div className="workspace-view-title">
          <span className="eyebrow">{view.type === "file" ? "Editor" : "Git diff"}</span>
          <h1>{path}</h1>
        </div>
        <span className="engine-label">{view.type === "file" ? "workspace file" : "review"}</span>
      </div>

      <div className="workspace-content">
        {view.type === "file" ? (
          <FileEditor
            file={view.file}
            draft={draft ?? view.file.content ?? ""}
            revealTarget={revealTarget}
            onDraftChange={onDraftChange}
            onSave={onSaveFile}
          />
        ) : (
          <DiffReview
            diff={view.diff}
            onStage={onStage}
            onUnstage={onUnstage}
            onRevert={onRevert}
          />
        )}
      </div>
    </>
  );
}
