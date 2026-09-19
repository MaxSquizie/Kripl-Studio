import type { WorkspaceDocumentView, WorkspaceView } from "./WorkspaceContent";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export function workspaceViewKey(view: WorkspaceDocumentView): string {
  return view.type === "file" ? `file:${view.file.path}` : `diff:${view.diff.path}`;
}

export function workspaceViewPath(view: WorkspaceDocumentView): string {
  return view.type === "file" ? view.file.path : view.diff.path;
}

export function upsertWorkspaceTab(
  tabs: WorkspaceDocumentView[],
  nextView: WorkspaceDocumentView
): WorkspaceDocumentView[] {
  const key = workspaceViewKey(nextView);
  const index = tabs.findIndex((tab) => workspaceViewKey(tab) === key);
  if (index < 0) return [...tabs, nextView];
  return tabs.map((tab, tabIndex) => (tabIndex === index ? nextView : tab));
}

function isActive(activeView: WorkspaceView, tab: WorkspaceDocumentView): boolean {
  return activeView.type !== "agent" && workspaceViewKey(activeView) === workspaceViewKey(tab);
}

export function WorkspaceTabs({
  tabs,
  activeView,
  dirtyFiles,
  onSelectAgent,
  onSelect,
  onClose
}: {
  tabs: WorkspaceDocumentView[];
  activeView: WorkspaceView;
  dirtyFiles: Set<string>;
  onSelectAgent(): void;
  onSelect(view: WorkspaceDocumentView): void;
  onClose(view: WorkspaceDocumentView): void;
}) {
  return (
    <div className="workspace-tabs" role="tablist" aria-label="Open workspace views">
      <button
        className={"workspace-tab agent-tab" + (activeView.type === "agent" ? " active" : "")}
        type="button"
        role="tab"
        aria-selected={activeView.type === "agent"}
        onClick={onSelectAgent}
      >
        <span className="workspace-tab-kind">K</span>
        <span className="workspace-tab-name">Agent</span>
      </button>

      {tabs.map((tab) => {
        const path = workspaceViewPath(tab);
        const dirty = tab.type === "file" && dirtyFiles.has(path);
        const active = isActive(activeView, tab);
        return (
          <div
            className={"workspace-tab document-tab" + (active ? " active" : "")}
            role="tab"
            aria-selected={active}
            key={workspaceViewKey(tab)}
          >
            <button
              className="workspace-tab-select"
              type="button"
              title={path}
              onClick={() => onSelect(tab)}
            >
              <span className="workspace-tab-kind">{tab.type === "file" ? "F" : "Δ"}</span>
              <span className="workspace-tab-name">{basename(path)}</span>
              {dirty && <span className="workspace-tab-dirty" title="Unsaved changes">●</span>}
            </button>
            <button
              className="workspace-tab-close"
              type="button"
              aria-label={`Close ${basename(path)}`}
              title={dirty ? "Close tab with unsaved changes" : "Close tab"}
              onClick={() => onClose(tab)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
