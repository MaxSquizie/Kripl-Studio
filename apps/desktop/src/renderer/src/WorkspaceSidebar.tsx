import type {
  WorkspaceChange,
  WorkspaceDescriptor,
  WorkspaceEntry
} from "@kripl/core";

interface WorkspaceSidebarProps {
  workspace: WorkspaceDescriptor | null;
  entries: Record<string, WorkspaceEntry[]>;
  expanded: Set<string>;
  changes: WorkspaceChange[];
  activePath?: string;
  onOpenWorkspace(): void;
  onRefresh(): void;
  onToggleDirectory(path: string): void;
  onOpenFile(path: string): void;
  onOpenDiff(path: string): void;
}

const STATUS_LABEL: Record<WorkspaceChange["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "!"
};

function TreeLevel({
  parent,
  depth,
  entries,
  expanded,
  activePath,
  onToggleDirectory,
  onOpenFile
}: {
  parent: string;
  depth: number;
  entries: Record<string, WorkspaceEntry[]>;
  expanded: Set<string>;
  activePath?: string;
  onToggleDirectory(path: string): void;
  onOpenFile(path: string): void;
}) {
  const children = entries[parent] ?? [];

  return (
    <>
      {children.map((entry) => {
        const selected = activePath === entry.path;

        if (entry.kind === "directory") {
          const open = expanded.has(entry.path);
          return (
            <div key={entry.path}>
              <button
                className="tree-row directory"
                style={{ paddingLeft: 10 + depth * 14 }}
                type="button"
                onClick={() => onToggleDirectory(entry.path)}
                title={entry.path}
              >
                <span className="tree-chevron">{open ? "▾" : "▸"}</span>
                <span className="tree-name">{entry.name}</span>
                {entry.symlink && <span className="tree-meta">↗</span>}
              </button>
              {open && (
                <TreeLevel
                  parent={entry.path}
                  depth={depth + 1}
                  entries={entries}
                  expanded={expanded}
                  activePath={activePath}
                  onToggleDirectory={onToggleDirectory}
                  onOpenFile={onOpenFile}
                />
              )}
            </div>
          );
        }

        return (
          <button
            key={entry.path}
            className={"tree-row file" + (selected ? " selected" : "")}
            style={{ paddingLeft: 28 + depth * 14 }}
            type="button"
            onClick={() => onOpenFile(entry.path)}
            title={entry.path}
          >
            <span className="tree-name">{entry.name}</span>
            {entry.symlink && <span className="tree-meta">↗</span>}
          </button>
        );
      })}
    </>
  );
}

export function WorkspaceSidebar({
  workspace,
  entries,
  expanded,
  changes,
  activePath,
  onOpenWorkspace,
  onRefresh,
  onToggleDirectory,
  onOpenFile,
  onOpenDiff
}: WorkspaceSidebarProps) {
  return (
    <aside className="sidebar workspace-sidebar">
      <section className="explorer-section">
        <div className="panel-heading">
          <span>Explorer</span>
          <div className="panel-actions">
            {workspace && (
              <button className="icon-button" type="button" onClick={onRefresh} title="Refresh workspace">
                ↻
              </button>
            )}
            <button className="icon-button" type="button" onClick={onOpenWorkspace} title="Open project">
              +
            </button>
          </div>
        </div>

        {workspace ? (
          <div className="explorer-body">
            <div className="project-root" title={workspace.path}>
              <strong>{workspace.name}</strong>
              <span>{workspace.gitRepository ? "Git repository" : "Folder"}</span>
            </div>
            <div className="tree-scroll">
              <TreeLevel
                parent=""
                depth={0}
                entries={entries}
                expanded={expanded}
                activePath={activePath}
                onToggleDirectory={onToggleDirectory}
                onOpenFile={onOpenFile}
              />
            </div>
          </div>
        ) : (
          <div className="empty-panel">
            <p>Open a project folder to create a local coding workspace.</p>
            <button className="primary-button" type="button" onClick={onOpenWorkspace}>
              Open project
            </button>
          </div>
        )}
      </section>

      <section className="changes-section">
        <div className="panel-heading">
          <span>Changes</span>
          <span className="change-count">{changes.length}</span>
        </div>

        <div className="changes-list">
          {!workspace && <p className="sidebar-note">No workspace.</p>}
          {workspace && !workspace.gitRepository && (
            <p className="sidebar-note">This folder is not a Git repository.</p>
          )}
          {workspace?.gitRepository && changes.length === 0 && (
            <p className="sidebar-note">Working tree clean.</p>
          )}
          {changes.map((change) => (
            <button
              className={"change-row status-" + change.status}
              key={(change.oldPath ?? "") + ">" + change.path}
              type="button"
              onClick={() => onOpenDiff(change.path)}
              title={change.oldPath ? change.oldPath + " → " + change.path : change.path}
            >
              <span className="change-status">{STATUS_LABEL[change.status]}</span>
              <span className="change-path">{change.path}</span>
              <span className="change-stage">
                {change.staged && change.unstaged ? "S/U" : change.staged ? "S" : ""}
              </span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
