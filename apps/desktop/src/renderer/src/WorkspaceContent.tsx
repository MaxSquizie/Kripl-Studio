import type { WorkspaceDiff, WorkspaceFilePreview } from "@kripl/core";

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

export function WorkspaceContent({
  view,
  onBackToAgent
}: {
  view: Exclude<WorkspaceView, { type: "agent" }>;
  onBackToAgent(): void;
}) {
  const path = view.type === "file" ? view.file.path : view.diff.path;

  return (
    <>
      <div className="agent-header workspace-view-header">
        <div className="workspace-view-title">
          <span className="eyebrow">{view.type === "file" ? "File preview" : "Git diff"}</span>
          <h1>{path}</h1>
        </div>
        <button className="secondary-button" type="button" onClick={onBackToAgent}>
          Agent
        </button>
      </div>

      <div className="workspace-content">
        {view.type === "file" ? (
          <>
            <div className="file-metadata">
              <span>{formatBytes(view.file.size)}</span>
              {view.file.language && <span>{view.file.language}</span>}
              {view.file.truncated && <span>preview truncated</span>}
              {view.file.binary && <span>binary</span>}
            </div>
            {view.file.binary ? (
              <div className="binary-preview">
                Binary files are not decoded or sent into the renderer as text.
              </div>
            ) : (
              <pre className="code-view">{view.file.content ?? ""}</pre>
            )}
          </>
        ) : (
          <>
            <div className="file-metadata">
              <span>{view.diff.status}</span>
              {view.diff.staged && <span>staged</span>}
              {view.diff.unstaged && <span>unstaged</span>}
              {view.diff.truncated && <span>diff truncated</span>}
            </div>
            <DiffContent patch={view.diff.patch} />
          </>
        )}
      </div>
    </>
  );
}
