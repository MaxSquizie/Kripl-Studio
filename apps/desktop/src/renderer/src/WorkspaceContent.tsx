import type { WorkspaceDiff, WorkspaceFilePreview } from "@kripl/core";
import { useEffect, useState } from "react";

export type WorkspaceView =
  | { type: "agent" }
  | { type: "file"; file: WorkspaceFilePreview }
  | { type: "diff"; diff: WorkspaceDiff };

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
  onSave
}: {
  file: WorkspaceFilePreview;
  onSave(path: string, content: string): Promise<void>;
}) {
  const [draft, setDraft] = useState(file.content ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(file.content ?? "");
    setError("");
  }, [file.path, file.content]);

  const editable = !file.binary && !file.truncated;
  const dirty = editable && draft !== (file.content ?? "");

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
          className="code-editor"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save();
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
  onBackToAgent,
  onSaveFile,
  onStage,
  onUnstage,
  onRevert
}: {
  view: Exclude<WorkspaceView, { type: "agent" }>;
  onBackToAgent(): void;
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
        <button className="secondary-button" type="button" onClick={onBackToAgent}>
          Agent
        </button>
      </div>

      <div className="workspace-content">
        {view.type === "file" ? (
          <FileEditor file={view.file} onSave={onSaveFile} />
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
